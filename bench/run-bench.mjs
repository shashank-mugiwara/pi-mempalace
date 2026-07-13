#!/usr/bin/env node
/**
 * run-bench.mjs — read-only benchmark harness for the pi-mempalace auto-recall
 * pipeline.
 *
 * Loads the live MemoryStore (same import path as cli/mempalace.mjs — via
 * Node's native TS type-stripping) against the default $MEMPALACE_HOME (or
 * ~/.pi/agent/memory), runs the fixed query set in bench/queries.json through
 * selectRecall() from ../extensions/pi-mempalace/recall.ts — the exact same
 * function the live extension calls from its before_agent_start hook, so
 * bench and production share one code path.
 *
 * Read-only: only ever calls store.search() (via selectRecall/rerank). Never
 * store/save/delete.
 *
 * Usage:
 *   node bench/run-bench.mjs --stage legacy --label legacy-parity
 *   node bench/run-bench.mjs --stage v2 --label v2-rerank
 *   node bench/run-bench.mjs --stage v2 --label alt --params '{"autoRecallRerankMinScore":0.4}'
 *   node bench/run-bench.mjs --stage v3 --label v3-gate-mock-none --gate-mock none
 *   node bench/run-bench.mjs --stage v3 --label v3-gate-mock-approveall --gate-mock approve-all
 *   node bench/run-bench.mjs --stage v3 --label v3-gate-mock-rejectall --gate-mock reject-all
 *
 * --stage v3 exercises the same config as v2 (new 0.40 rerankMinScore +
 * autoRecallCandidateFloorSameProject) PLUS the gate partition logic in
 * selectRecallRerank, driven by a MOCK judge instead of a real model call —
 * this validates the partition/plumbing only, not gate quality:
 *   --gate-mock none        gate disabled entirely (autoRecallLlmGate:false,
 *                            no judge) — picks must equal the plain
 *                            rerankMinScore rule over all floor-survivors,
 *                            i.e. identical to what --stage v2 with the same
 *                            params would pick.
 *   --gate-mock approve-all judge approves every gray-zone candidate it's
 *                            handed (still respects autoRecallGateMaxCandidates
 *                            and the auto-approve/auto-reject score bounds).
 *   --gate-mock reject-all  judge approves nothing — final picks should be
 *                            exactly the score-auto-approved set.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import { MemoryStore } from "../extensions/pi-mempalace/memory_store.ts";
import { selectRecall } from "../extensions/pi-mempalace/recall.ts";
import { rerank } from "../extensions/pi-mempalace/reranker.ts";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// --- args --------------------------------------------------------------

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--label") opts.label = argv[++i];
    else if (a === "--params") opts.params = argv[++i];
    else if (a === "--stage") opts.stage = argv[++i];
    else if (a === "--gate-mock") opts.gateMock = argv[++i];
  }
  return opts;
}

const cliOpts = parseArgs(process.argv.slice(2));
if (!cliOpts.label) {
  console.error("error: --label <name> is required");
  process.exit(1);
}
const stage = cliOpts.stage || "v2";
if (stage !== "legacy" && stage !== "v2" && stage !== "v3") {
  console.error(`error: --stage must be "legacy", "v2", or "v3" (got "${stage}")`);
  process.exit(1);
}
const gateMockMode = cliOpts.gateMock || "none";
if (stage === "v3" && !["none", "approve-all", "reject-all"].includes(gateMockMode)) {
  console.error(`error: --gate-mock must be "none", "approve-all", or "reject-all" (got "${gateMockMode}")`);
  process.exit(1);
}

// legacy = today's production behavior exactly (autoRecallRerank off, old
// thresholds, zero cross-project penalty) — used for the parity check
// against bench/results/baseline.json.
// v2 = current tuned defaults from extensions/pi-mempalace/index.ts
// defaultConfig() (rerank on, 0.40 ce threshold, same-project floor 0.35),
// gate left off — isolates the rerank-only behavior.
// v3 = v2 params plus the gate partition thresholds; gate itself is driven
// by --gate-mock (a fake judge) rather than a real model call, so this stage
// validates partition/plumbing only, never talks to a network.
const STAGE_PARAMS = {
  legacy: {
    autoRecallMinSimilarity: 0.5,
    autoRecallMaxResults: 4,
    autoRecallMaxChars: 2400,
    autoRecallMinPromptChars: 15,
    autoRecallCandidates: 24,
    autoRecallCandidateFloor: 0.45,
    autoRecallCandidateFloorSameProject: 0.45,
    autoRecallCrossProjectPenalty: 0,
    autoRecallRerank: false,
    autoRecallRerankMinScore: 0.35,
    autoRecallLlmGate: false,
    autoRecallGateAutoApprove: 0.85,
    autoRecallGateMinScore: 0.15,
    autoRecallGateMaxCandidates: 10,
  },
  v2: {
    autoRecallMinSimilarity: 0.5,
    autoRecallMaxResults: 4,
    autoRecallMaxChars: 2400,
    autoRecallMinPromptChars: 30,
    autoRecallCandidates: 24,
    autoRecallCandidateFloor: 0.45,
    autoRecallCandidateFloorSameProject: 0.35,
    autoRecallCrossProjectPenalty: 0.08,
    autoRecallRerank: true,
    autoRecallRerankMinScore: 0.40,
    autoRecallLlmGate: false,
    autoRecallGateAutoApprove: 0.85,
    autoRecallGateMinScore: 0.15,
    autoRecallGateMaxCandidates: 10,
  },
};
STAGE_PARAMS.v3 = {
  ...STAGE_PARAMS.v2,
  autoRecallLlmGate: gateMockMode !== "none",
};

let params = { ...STAGE_PARAMS[stage] };
if (cliOpts.params) {
  let parsed;
  try {
    parsed = JSON.parse(cliOpts.params);
  } catch (e) {
    console.error(`error: --params is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  params = { ...params, ...parsed };
}

// --- helpers -----------------------------------------------------------

function snippet(text) {
  return text.replace(/\n/g, " ").slice(0, 220);
}

function candidateRecord(c) {
  return {
    id: c.id,
    project: c.project,
    topic: c.topic,
    similarity: c.similarity,
    importance: c.importance,
    ce_score: c.ceScore,
    penalty: c.penalty,
    final_score: c.finalScore === -Infinity ? null : Number(c.finalScore.toFixed(4)),
    picked: c.picked,
    chars: c.text.length,
    timestamp: c.timestamp,
    snippet: snippet(c.text),
  };
}

/**
 * Build a fake gate judge for --stage v3 --gate-mock <mode>. Never calls a
 * model — validates selectRecallRerank's partition/plumbing only.
 *   "none"        — no judge (autoRecallLlmGate is forced false for this
 *                    mode in STAGE_PARAMS.v3, so selectRecall never even
 *                    looks at opts.gate; returning null here is defensive).
 *   "approve-all" — approves every gray-zone candidate it's handed.
 *   "reject-all"  — approves nothing.
 */
function buildMockJudge(mode) {
  if (mode === "none") return null;
  return async (input) => {
    if (mode === "approve-all") {
      return { approve: input.candidates.map((c) => c.key), skills: [] };
    }
    if (mode === "reject-all") {
      return { approve: [], skills: [] };
    }
    throw new Error(`buildMockJudge: unknown mode "${mode}"`);
  };
}

// --- main -----------------------------------------------------------------

async function main() {
  const queriesPath = path.join(__dirname, "queries.json");
  const queries = JSON.parse(fs.readFileSync(queriesPath, "utf8"));

  const store = new MemoryStore();

  // Warmup search: absorbs first-call embedding-model load latency so it
  // doesn't pollute q01's timing. Excluded from results/aggregates.
  const warmupStart = performance.now();
  await store.search("warmup query to load the embedding model", {
    n_results: Math.max(params.autoRecallMaxResults * 2, 8),
  });
  const warmupLatencyMs = performance.now() - warmupStart;
  console.log(`# warmup search completed in ${warmupLatencyMs.toFixed(1)}ms (excluded from results)`);

  // Warm the cross-encoder reranker too (v2 stage only) — same rationale:
  // absorb model-load latency once, up front, so per-query rerank_ms
  // reflects steady-state inference cost, not the one-time model download
  // and warm-up.
  if (params.autoRecallRerank) {
    const rerankWarmupStart = performance.now();
    await rerank("warmup query", ["warmup memory text to load the cross-encoder model"]);
    const rerankWarmupMs = performance.now() - rerankWarmupStart;
    console.log(`# warmup rerank completed in ${rerankWarmupMs.toFixed(1)}ms (excluded from results)`);
  }
  console.log("");

  const mockJudge = stage === "v3" ? buildMockJudge(gateMockMode) : null;
  if (stage === "v3") {
    console.log(`# stage v3: --gate-mock ${gateMockMode} (autoRecallLlmGate=${params.autoRecallLlmGate})\n`);
  }

  const results = [];

  for (const q of queries) {
    const query = q.query.trim();
    let candidates = [];
    let picked = [];
    let latencyMs = 0;
    let searchMs = 0;
    let rerankMs = 0;
    let gateMs = 0;
    let mode = null;
    let skills = [];
    let gateInfo = null;

    if (query.length >= params.autoRecallMinPromptChars) {
      const t0 = performance.now();
      const result = await selectRecall(store, query.slice(0, 2000), {
        project: q.cwd_project ?? null,
        config: params,
        gate: mockJudge ? { judge: mockJudge } : undefined,
      });
      latencyMs = performance.now() - t0;

      candidates = result.candidates.map(candidateRecord);
      picked = result.picked.map((h) => h.id);
      searchMs = Number(result.timings.search_ms.toFixed(1));
      rerankMs = Number(result.timings.rerank_ms.toFixed(1));
      gateMs = Number(result.timings.gate_ms.toFixed(1));
      mode = result.mode;
      skills = result.skills;
      gateInfo = result.gate;
    }

    results.push({
      ...q,
      mode,
      latency_ms: Number(latencyMs.toFixed(1)),
      search_ms: searchMs,
      rerank_ms: rerankMs,
      gate_ms: gateMs,
      gate: gateInfo,
      skills,
      candidates,
      picked,
    });
  }

  // --- aggregates -----------------------------------------------------

  const byCategory = {};
  for (const r of results) {
    const cat = r.category;
    if (!byCategory[cat]) {
      byCategory[cat] = {
        num_queries: 0,
        total_picked: 0,
        total_chars_injected: 0,
        project_match_hits: 0,
        project_match_total: 0,
        queries_with_pick: 0,
      };
    }
    const agg = byCategory[cat];
    agg.num_queries += 1;

    const pickedCandidates = r.candidates.filter((c) => r.picked.includes(c.id));
    agg.total_picked += pickedCandidates.length;
    agg.total_chars_injected += pickedCandidates.reduce((s, c) => s + c.chars, 0);
    if (pickedCandidates.length > 0) agg.queries_with_pick += 1;

    if (cat === "specific" || cat === "ambiguous") {
      for (const c of pickedCandidates) {
        agg.project_match_total += 1;
        if (c.project === r.expected_project) agg.project_match_hits += 1;
      }
    }
  }

  const categoryAggregates = {};
  for (const [cat, agg] of Object.entries(byCategory)) {
    categoryAggregates[cat] = {
      num_queries: agg.num_queries,
      total_picked: agg.total_picked,
      avg_picked_per_query: Number((agg.total_picked / agg.num_queries).toFixed(2)),
      avg_chars_injected: Number((agg.total_chars_injected / agg.num_queries).toFixed(1)),
      injection_rate: Number((agg.queries_with_pick / agg.num_queries).toFixed(2)),
      project_match_rate:
        agg.project_match_total > 0
          ? Number((agg.project_match_hits / agg.project_match_total).toFixed(2))
          : null,
    };
  }

  const overallQueriesWithPick = results.filter((r) => r.picked.length > 0).length;
  const overallInjectionRate = Number((overallQueriesWithPick / results.length).toFixed(2));

  const latencies = results.map((r) => r.latency_ms).sort((a, b) => a - b);
  const p50 = latencies.length
    ? latencies[Math.floor((latencies.length - 1) * 0.5)]
    : null;
  const max = latencies.length ? latencies[latencies.length - 1] : null;

  const rerankLatencies = results.map((r) => r.rerank_ms).filter((v) => v > 0).sort((a, b) => a - b);
  const rerankP50 = rerankLatencies.length
    ? rerankLatencies[Math.floor((rerankLatencies.length - 1) * 0.5)]
    : null;
  const rerankMax = rerankLatencies.length ? rerankLatencies[rerankLatencies.length - 1] : null;

  const aggregates = {
    overall: {
      num_queries: results.length,
      injection_rate: overallInjectionRate,
      latency_ms: { p50, max },
      rerank_ms: { p50: rerankP50, max: rerankMax },
    },
    by_category: categoryAggregates,
  };

  const output = {
    label: cliOpts.label,
    stage,
    timestamp: new Date().toISOString(),
    params,
    queries: results,
    aggregates,
  };

  const resultsDir = path.join(__dirname, "results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `${cliOpts.label}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  // --- markdown summary -------------------------------------------------

  console.log(`## Bench run: ${cliOpts.label} (stage: ${stage})`);
  console.log(`timestamp: ${output.timestamp}`);
  console.log(`params: ${JSON.stringify(params)}\n`);

  console.log("### Per-query\n");
  for (const r of results) {
    const topPickId = r.picked[0];
    const topPick = topPickId
      ? r.candidates.find((c) => c.id === topPickId)
      : null;
    const topPickStr = topPick
      ? `${topPick.project}/${topPick.topic} ${(topPick.similarity * 100).toFixed(0)}%`
      : "(none)";
    const gateStr = r.gate
      ? ` gate={gray=${r.gate.grayCount},called=${r.gate.called},failedOpen=${r.gate.failedOpen},autoApprove=${r.gate.approvedAutoCount},gateApprove=${r.gate.gateApprovedCount}}`
      : "";
    console.log(
      `- ${r.id} [${r.category}] mode=${r.mode} picked=${r.picked.length} rerank_ms=${r.rerank_ms}${gateStr} top="${topPickStr}" — "${r.query}"`
    );
  }

  console.log("\n### Aggregates\n");
  console.log(JSON.stringify(aggregates, null, 2));

  console.log(`\nResults written to: ${outPath}`);
}

main().catch((e) => {
  console.error("error:", e?.stack || e?.message || String(e));
  process.exit(1);
});
