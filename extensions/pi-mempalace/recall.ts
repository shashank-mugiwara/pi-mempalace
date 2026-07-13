/**
 * recall.ts — shared auto-recall selection pipeline.
 *
 * Extracted from extensions/pi-mempalace/index.ts's auto-recall block so the
 * live extension and bench/run-bench.mjs share exactly one code path.
 *
 * Two failure modes drove this design (see bench/results/baseline.json):
 *   (a) false positives — cross-project junk at sim 0.50-0.55 gets injected
 *       (e.g. "fix the failing test" pulled a salesappweb Flutter memory at
 *       0.5095 when the user was in a different project entirely).
 *   (b) false negatives — truly relevant memories sit just BELOW the 0.5
 *       floor (q03's correct memory at 0.467-0.490, q13's at 0.386).
 *
 * Fix: widen the candidate pool with a LOWER bi-encoder floor, then use a
 * cross-encoder reranker (reranker.ts) as the real relevance gate, with a
 * same-vs-cross-project penalty applied on top of the cross-encoder score.
 *
 * Two modes:
 *   - "legacy": today's behavior — bi-encoder similarity floor only, plus an
 *     optional cross-project penalty (0 reproduces the exact historical
 *     picks; see bench --stage legacy parity check).
 *   - "rerank": wider pool + lower floor + cross-encoder gate. Falls open to
 *     "legacy" on ANY error (model load failure, inference error, etc.) —
 *     recall must never block or break the agent loop.
 */

import { MemoryStore, type SearchResult } from "./memory_store.ts";
import { rerank } from "./reranker.ts";
import type { GateCandidateInput, GateSkillInput, GateVerdict } from "./gate.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The autoRecall* subset of MemoryConfig that selectRecall needs. */
export interface RecallConfigSubset {
  autoRecallMinSimilarity: number;
  autoRecallMaxResults: number;
  autoRecallMaxChars: number;
  autoRecallCandidates: number;
  autoRecallCandidateFloor: number;
  /** Lower bi-encoder floor for same-project candidates (see index.ts defaultConfig comment). */
  autoRecallCandidateFloorSameProject: number;
  autoRecallCrossProjectPenalty: number;
  autoRecallRerank: boolean;
  autoRecallRerankMinScore: number;
  /** Gate the reranked gray zone through an LLM before injecting (see selectRecallRerank). */
  autoRecallLlmGate: boolean;
  autoRecallGateAutoApprove: number;
  autoRecallGateMinScore: number;
  autoRecallGateMaxCandidates: number;
}

/** Input handed to the gate judge for one gray-zone batch. */
export interface GateJudgeInput {
  message: string;
  project: string | null;
  candidates: GateCandidateInput[];
  skills?: GateSkillInput[];
}

/**
 * Optional LLM relevance gate. selectRecall stays importable from plain node
 * (bench/run-bench.mjs) with zero pi-ai/pi-coding-agent imports, so the
 * caller (index.ts, or bench with a mock) supplies the judge closure —
 * recall.ts never talks to a model registry or completion API directly.
 */
export interface RecallGateOptions {
  /** Judge a batch of gray-zone candidates. Must never throw — any error should be caught and resolved as null (fail open) by the implementation, but selectRecallRerank also catches defensively. */
  judge: (input: GateJudgeInput) => Promise<GateVerdict | null>;
  /** Skills catalog to offer the gate (only forwarded when a gate call actually happens). */
  suggestSkills?: GateSkillInput[];
}

export interface RecallOptions {
  /** Current project — used for the cross-project penalty. null = no penalty ever applied. */
  project: string | null;
  /** Memory ids to skip (already recalled this session). */
  excludeIds?: Set<string>;
  config: RecallConfigSubset;
  /** LLM relevance gate — omit to disable regardless of config.autoRecallLlmGate. */
  gate?: RecallGateOptions;
}

/** One candidate with every score computed along the way, for bench reporting. */
export interface RecallCandidate {
  id: string;
  project: string;
  topic: string;
  text: string;
  timestamp: string;
  /** Bi-encoder similarity from store.search(). */
  similarity: number;
  importance: number;
  /** Cross-encoder relevance score (0-1), or null if never scored (legacy mode, or filtered by the floor/excludeIds before reranking). */
  ceScore: number | null;
  /** Cross-project penalty actually applied to this candidate (0 if same-project or project is null). */
  penalty: number;
  /** Score used for thresholding/sorting: legacy = similarity - penalty; rerank = ceScore - penalty (or -Infinity if never scored). */
  finalScore: number;
  picked: boolean;
}

/** Introspection for bench/debugging — present only when the gate partition actually ran (rerank mode, gate enabled + judge supplied). */
export interface RecallGateInfo {
  /** Gray-zone candidates identified (before the maxCandidates cap). */
  grayCount: number;
  /** Whether the judge was actually invoked (false if gray zone was empty). */
  called: boolean;
  /** True if the judge threw/timed out/returned null and selectRecallRerank fell open to the plain rerankMinScore rule over all floor-survivors. */
  failedOpen: boolean;
  /** Candidates auto-approved by score (>= autoRecallGateAutoApprove), independent of the gate call. */
  approvedAutoCount: number;
  /** Candidates the gate itself approved out of the gray-zone batch sent to it. */
  gateApprovedCount: number;
}

export interface RecallResult {
  picked: SearchResult[];
  candidates: RecallCandidate[];
  mode: "legacy" | "rerank";
  timings: { search_ms: number; rerank_ms: number; gate_ms: number };
  /** Skill names the gate suggested (deduped, max 2) — empty if the gate wasn't used or suggested none. */
  skills: string[];
  /** null in legacy mode or when gating never engaged (disabled, or no judge supplied). */
  gate: RecallGateInfo | null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Select which memories to auto-recall for a prompt. Never throws — reranker
 * failures fail open to the legacy path so the agent loop is never blocked.
 */
export async function selectRecall(
  store: MemoryStore,
  query: string,
  opts: RecallOptions
): Promise<RecallResult> {
  if (opts.config.autoRecallRerank) {
    try {
      return await selectRecallRerank(store, query, opts);
    } catch {
      // Fail open: reranker load/inference error (model unavailable, OOM,
      // network blocked, etc.) must never break auto-recall.
    }
  }
  return selectRecallLegacy(store, query, opts);
}

// ---------------------------------------------------------------------------
// Legacy path — bi-encoder similarity floor (today's production behavior)
// ---------------------------------------------------------------------------

async function selectRecallLegacy(
  store: MemoryStore,
  query: string,
  opts: RecallOptions
): Promise<RecallResult> {
  const cfg = opts.config;
  const excludeIds = opts.excludeIds ?? new Set<string>();
  const nResults = Math.max(cfg.autoRecallMaxResults * 2, 8);

  const t0 = performance.now();
  const res = await store.search(query, { n_results: nResults });
  const search_ms = performance.now() - t0;

  const hitById = new Map(res.results.map((h) => [h.id, h]));

  const candidates: RecallCandidate[] = res.results.map((hit) => {
    const crossProject = opts.project != null && hit.project !== opts.project;
    const penalty = crossProject ? cfg.autoRecallCrossProjectPenalty : 0;
    return {
      id: hit.id,
      project: hit.project,
      topic: hit.topic,
      text: hit.text,
      timestamp: hit.timestamp,
      similarity: hit.similarity,
      importance: hit.importance,
      ceScore: null,
      penalty,
      finalScore: hit.similarity - penalty,
      picked: false,
    };
  });

  const picked: SearchResult[] = [];
  let budget = cfg.autoRecallMaxChars;
  // Preserve store.search()'s original (blended) order — exactly like the
  // original inline pipeline in index.ts did.
  for (const c of candidates) {
    if (c.finalScore < cfg.autoRecallMinSimilarity) continue;
    if (excludeIds.has(c.id)) continue;
    if (c.text.length > budget) continue;
    c.picked = true;
    budget -= c.text.length;
    picked.push(hitById.get(c.id)!);
    if (picked.length >= cfg.autoRecallMaxResults) break;
  }

  return { picked, candidates, mode: "legacy", timings: { search_ms, rerank_ms: 0, gate_ms: 0 }, skills: [], gate: null };
}

// ---------------------------------------------------------------------------
// Rerank path — wide pool + low floor + cross-encoder gate
// ---------------------------------------------------------------------------

async function selectRecallRerank(
  store: MemoryStore,
  query: string,
  opts: RecallOptions
): Promise<RecallResult> {
  const cfg = opts.config;
  const excludeIds = opts.excludeIds ?? new Set<string>();

  const t0 = performance.now();
  const res = await store.search(query, { n_results: cfg.autoRecallCandidates });
  const search_ms = performance.now() - t0;

  const hitById = new Map(res.results.map((h) => [h.id, h]));

  // Candidates eligible for cross-encoding: above the bi-encoder floor and
  // not already recalled this session. Same-project candidates get a lower
  // floor (autoRecallCandidateFloorSameProject) — bench q13 showed a
  // same-project relevant memory at sim 0.386 never reaching the
  // cross-encoder under the single 0.45 floor.
  const eligible = res.results.filter((hit) => {
    if (excludeIds.has(hit.id)) return false;
    const sameProject = opts.project != null && hit.project === opts.project;
    const floor = sameProject ? cfg.autoRecallCandidateFloorSameProject : cfg.autoRecallCandidateFloor;
    return hit.similarity >= floor;
  });

  let rerank_ms = 0;
  const ceScoreById = new Map<string, number>();
  if (eligible.length > 0) {
    const texts = eligible.map((hit) => hit.text.slice(0, 1200));
    const t1 = performance.now();
    const scores = await rerank(query, texts);
    rerank_ms = performance.now() - t1;
    eligible.forEach((hit, i) => ceScoreById.set(hit.id, scores[i]));
  }

  const candidates: RecallCandidate[] = res.results.map((hit) => {
    const crossProject = opts.project != null && hit.project !== opts.project;
    const penalty = crossProject ? cfg.autoRecallCrossProjectPenalty : 0;
    const ceScore = ceScoreById.has(hit.id) ? ceScoreById.get(hit.id)! : null;
    const finalScore = ceScore !== null ? ceScore - penalty : -Infinity;
    return {
      id: hit.id,
      project: hit.project,
      topic: hit.topic,
      text: hit.text,
      timestamp: hit.timestamp,
      similarity: hit.similarity,
      importance: hit.importance,
      ceScore,
      penalty,
      finalScore,
      picked: false,
    };
  });

  // Sort by finalScore desc (candidates without a ceScore sink to the bottom
  // via -Infinity and are never picked/gated).
  const order = [...candidates].sort((a, b) => b.finalScore - a.finalScore);
  const floorSurvivors = order.filter((c) => c.ceScore !== null);

  let gate_ms = 0;
  let skills: string[] = [];
  let gateInfo: RecallGateInfo | null = null;
  let approvedSet: RecallCandidate[];

  if (cfg.autoRecallLlmGate && opts.gate) {
    // Partition floor-survivors by finalScore. Candidates below
    // autoRecallGateMinScore are implicitly rejected — never sent to the
    // gate, never picked.
    const approvedAuto = floorSurvivors.filter((c) => c.finalScore >= cfg.autoRecallGateAutoApprove);
    const gray = floorSurvivors.filter(
      (c) => c.finalScore >= cfg.autoRecallGateMinScore && c.finalScore < cfg.autoRecallGateAutoApprove
    );

    if (gray.length === 0) {
      // Nothing ambiguous — never call the LLM. This is exactly equivalent
      // to the plain rerankMinScore rule here: gateMinScore < rerankMinScore
      // < autoApprove partitions floor-survivors into "clearly below"
      // (rejected, also < rerankMinScore) and "clearly above" (approved,
      // also >= rerankMinScore) with nothing in between.
      approvedSet = approvedAuto;
      gateInfo = {
        grayCount: 0,
        called: false,
        failedOpen: false,
        approvedAutoCount: approvedAuto.length,
        gateApprovedCount: 0,
      };
    } else {
      const grayForGate = gray.slice(0, cfg.autoRecallGateMaxCandidates);
      const keyMap = new Map<string, RecallCandidate>();
      const candidateInputs: GateCandidateInput[] = grayForGate.map((c, i) => {
        const key = `m${i + 1}`;
        keyMap.set(key, c);
        return {
          key,
          project: c.project,
          topic: c.topic,
          date: c.timestamp.slice(0, 10),
          snippet: c.text.slice(0, 300),
        };
      });

      let verdict: GateVerdict | null = null;
      const tg0 = performance.now();
      try {
        verdict = await opts.gate.judge({
          message: query,
          project: opts.project,
          candidates: candidateInputs,
          skills: opts.gate.suggestSkills,
        });
      } catch {
        verdict = null;
      }
      gate_ms = performance.now() - tg0;

      if (verdict === null) {
        // Fail open: plain rerankMinScore rule over ALL floor-survivors —
        // exactly the pre-gate (v2) behavior.
        approvedSet = floorSurvivors.filter((c) => c.finalScore >= cfg.autoRecallRerankMinScore);
        gateInfo = {
          grayCount: gray.length,
          called: true,
          failedOpen: true,
          approvedAutoCount: approvedAuto.length,
          gateApprovedCount: 0,
        };
      } else {
        const gateApprovedIds = new Set<string>();
        for (const key of verdict.approve) {
          const c = keyMap.get(key);
          if (c) gateApprovedIds.add(c.id);
        }
        const approvedAutoIds = new Set(approvedAuto.map((c) => c.id));
        // approved = auto-approved + gate-approved, finalScore ordering
        // preserved because floorSurvivors is already sorted desc.
        approvedSet = floorSurvivors.filter((c) => approvedAutoIds.has(c.id) || gateApprovedIds.has(c.id));
        skills = verdict.skills;
        gateInfo = {
          grayCount: gray.length,
          called: true,
          failedOpen: false,
          approvedAutoCount: approvedAuto.length,
          gateApprovedCount: gateApprovedIds.size,
        };
      }
    }
  } else {
    // Gate disabled or no judge supplied — the plain rerankMinScore rule
    // over all floor-survivors (unchanged v2 behavior).
    approvedSet = floorSurvivors.filter((c) => c.finalScore >= cfg.autoRecallRerankMinScore);
  }

  const picked: SearchResult[] = [];
  let budget = cfg.autoRecallMaxChars;
  for (const c of approvedSet) {
    if (c.text.length > budget) continue;
    c.picked = true;
    budget -= c.text.length;
    picked.push(hitById.get(c.id)!);
    if (picked.length >= cfg.autoRecallMaxResults) break;
  }

  return {
    picked,
    candidates,
    mode: "rerank",
    timings: { search_ms, rerank_ms, gate_ms },
    skills,
    gate: gateInfo,
  };
}
