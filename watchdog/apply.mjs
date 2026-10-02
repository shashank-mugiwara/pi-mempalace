/**
 * apply.mjs — the "additive auto, destructive queued" policy.
 *
 * Auto-applied:
 *   - new memories (importance clamped to <= 0.85, near-duplicate guarded:
 *     skipped when an existing memory matches at >= 0.92 similarity)
 *   - new KG facts
 *   - supersedes with confidence "high" whose target memory has
 *     importance < 0.85 (save replacement, then forget old)
 *   - kg invalidations with confidence "high" (invalidate + optional re-add)
 *
 * Never auto-applied: content carrying a cost figure (looksLikeCostFigure);
 * it is skipped, counted as currency_skipped and logged.
 *
 * Queued for human review (watchdog-review.json → AskUserQuestion in pi):
 *   - supersedes targeting importance >= 0.85 memories, or confidence "low"
 *   - kg invalidations with confidence "low"
 *   - every doubt
 *
 * Doubt ⇒ queue, never guess.
 *
 * Queue hygiene (2026-09-23, audit D7 — the queue had reached 158 items):
 *   - a supersede whose target memory no longer exists is dropped, not
 *     queued (findMemory() returning null used to route it to the queue);
 *   - one pending supersede per target: a newer proposal replaces the older;
 *   - every write and queued item goes through resolveProject(), which fixes
 *     casing against existing projects and refuses working-directory names.
 */

import { log, queueReview, recordDemotions } from "./state.mjs";
import { canonicalProject } from "./summarize.mjs";
import { isNonProjectName } from "../extensions/pi-mempalace/memory_store.ts";

const AUTO_IMPORTANCE_CAP = 0.85;
const DUP_SIMILARITY = 0.92;

/**
 * Cost figures (API spend, cloud bills, per-run cost) are banned from the
 * palace by the no-dollar rule. That rule lives in ~/.claude/CLAUDE.md, and the
 * curator runs with --setting-sources "", so it reaches the model only through
 * the curator prompt. This is the deterministic backstop for the writes no
 * human reviews: a match skips the write and logs it. Code spans are ignored
 * so `awk '{print $10}'` or a `$1` in a command is not mistaken for money, and
 * a bare single-digit `$5` is too ambiguous to call. Rupee amounts are left
 * alone: lakh/crore figures are product facts in this install, not spend.
 */
const COST_PATTERNS = [
  /\$\s?\d[\d,]*\.\d+/, // $0.42, $1,234.50
  /\$\s?\d{1,3}(?:,\d{3})+/, // $1,200
  /\$\s?\d+(?:\.\d+)?\s?(?:k|K|M|B|bn|million|billion)\b/, // $3k, $1.2M
  /\$\d{2,}/, // $40, $250
  /\$\s?\d+(?:\.\d+)?\s*(?:\/|per\s+)\s*(?:mo|month|day|hr|hour|week|year|yr|run|call|request|session|tick|token)\b/i,
  /\b(?:USD|US\$)\s?\d/,
  /\d\s?USD\b/,
];

export function looksLikeCostFigure(text) {
  const prose = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ");
  return COST_PATTERNS.some((re) => re.test(prose));
}

/** Log line for a skipped write; the figure itself is masked, not repeated. */
function logCostSkip(kind, project, content) {
  const gist = String(content).replace(/\s+/g, " ").slice(0, 100).replace(/\$\s?[\d.,]+\s?[kKMB]?/g, "$<n>");
  log(`currency: skipped auto-applied ${kind} for ${project} (cost figure; no-dollar rule): ${gist}`);
}

export async function applyResult(store, candidate, result, reviewItems, opts = {}) {
  const dry = !!opts.dryRun;
  const counts = { saved: 0, kg_added: 0, superseded: 0, kg_invalidated: 0, queued: 0, dup_skipped: 0, playbook_saved: 0, playbook_queued: 0, stale_dropped: 0, bad_project: 0, currency_skipped: 0 };
  const projects = safeProjects(store);
  const src = `session-watchdog:${candidate.source}`;
  const project_ = (name) => {
    const p = resolveProject(name, candidate.project, projects);
    if (!p) counts.bad_project++;
    return p;
  };

  for (const m of result.memories) {
    if (!m?.content || typeof m.content !== "string") continue;
    const project = project_(m.project);
    if (!project) continue;
    if (looksLikeCostFigure(m.content)) {
      counts.currency_skipped++;
      logCostSkip("memory", project, m.content);
      continue;
    }
    const importance = Math.min(Number(m.importance) || 0.6, AUTO_IMPORTANCE_CAP);
    if (await isNearDuplicate(store, m.content)) {
      counts.dup_skipped++;
      continue;
    }
    if (!dry) {
      await store.store({
        content: m.content.trim(),
        project,
        topic: cleanTopic(m.topic),
        source: src,
        importance,
      });
    }
    counts.saved++;
  }

  // Lessons are ALWAYS queued, never auto-applied — even at high confidence.
  // A wrong lesson teaches an agent to avoid correct behaviour, so it is more
  // damaging than a wrong fact, and the model is inferring it about its own
  // reasoning from a transcript it partly wrote. This install already killed
  // auto-capture for writing 83% noise; a new autonomous writer is not the
  // shape of the fix. The human is the gate.
  for (const l of result.lessons || []) {
    if (!l?.content || typeof l.content !== "string") continue;
    if (!l?.trigger) continue; // a lesson with no trigger is unactionable
    const lessonProject = project_(l.project);
    if (!lessonProject) continue;
    if (await isNearDuplicate(store, l.content)) {
      counts.dup_skipped++;
      continue;
    }
    queueReview(
      reviewItems,
      "lesson",
      {
        content: l.content.trim(),
        project: lessonProject,
        topic: "lessons",
        trigger: String(l.trigger).trim(),
        importance: 0.85,
        confidence: l.confidence || "low",
      },
      l.evidence || "",
      candidate.key
    );
    counts.queued++;
  }

  // Playbook (docs/design/watchdog-playbook.md, Task 2): procedural findings
  // (fast commands, file/skill locations, prompt phrasings that worked).
  // Apply policy by (kind, destination):
  //   command|location + memory + HIGH confidence -> auto-apply, supersede-on-write
  //   everything else (prompt-phrasing/other, low confidence, vault/both/unsure) -> queue
  // apply.mjs has NO filesystem access to the Obsidian vault (only ever calls
  // store.store()/addTriple()/delete() — see the file's own imports/methods),
  // so any vault-bound destination must be queued for the live agent to apply
  // with its own judgment when a human walks the review queue, never guessed
  // at here.
  for (const p of result.playbook || []) {
    if (!p?.content || typeof p.content !== "string") continue;
    if (!p?.kind || !p?.destination) continue; // both required to route correctly
    const project = project_(p.project);
    if (!project) continue;

    const needsVaultRoute = p.destination === "vault" || p.destination === "both" || p.destination === "unsure";
    const isFactual = p.kind === "command" || p.kind === "location";
    const highConfidence = p.confidence === "high";

    if (needsVaultRoute || !isFactual || !highConfidence) {
      // Vault-bound (can't apply here), behavior-shaping (same risk class as
      // lessons), or not high-confidence (Decision #3 requires HIGH confidence
      // to auto-apply a factual/memory entry — a low-confidence guess written
      // straight into the shared store is the exact unreviewed-write failure
      // mode the 0.3.0 cleanup (4,585/5,527 memories, 83% noise) already paid
      // down once).
      if (await isNearDuplicate(store, p.content)) {
        counts.dup_skipped++;
        continue;
      }
      queueReview(
        reviewItems,
        "playbook",
        {
          content: p.content.trim(),
          project,
          topic: "playbook",
          kind: p.kind,
          destination: p.destination,
          importance: 0.6,
          confidence: p.confidence || "low",
        },
        p.evidence || "",
        candidate.key
      );
      counts.playbook_queued++;
      continue;
    }

    // kind is command|location, destination is memory, confidence is high.
    if (looksLikeCostFigure(p.content)) {
      counts.currency_skipped++;
      logCostSkip("playbook", project, p.content);
      continue;
    }
    if (await isNearDuplicate(store, p.content)) {
      counts.dup_skipped++;
      continue;
    }
    if (!dry) {
      // Supersede, don't accumulate: one `playbook` memory per project, same
      // discipline as `session-resume` (PROTOCOL.md) — without this, every
      // qualifying tick adds a new row forever, refilling the store with the
      // exact noise pattern 0.3.0 already cleaned up (just differently-worded
      // restatements of the same procedural fact, which the near-dup guard's
      // 0.92 threshold doesn't catch).
      store.supersedeTopic(project, "playbook");
      await store.store({
        content: p.content.trim(),
        project,
        topic: "playbook",
        source: `session-watchdog:${candidate.source}`,
        importance: Math.min(0.7, AUTO_IMPORTANCE_CAP),
      });
    }
    counts.playbook_saved++;
  }

  for (const f of result.kg_facts) {
    if (!f?.subject || !f?.predicate || !f?.object) continue;
    const factProject = project_(f.project);
    if (!factProject) continue;
    if (!dry) {
      try {
        // skip exact-duplicate active facts
        if (store.findTriple(f.subject, f.predicate, f.object) !== null) continue;
        store.addTriple({
          subject: f.subject,
          predicate: f.predicate,
          object: f.object,
          valid_from: f.from || undefined,
          project: factProject,
        });
      } catch {
        continue;
      }
    }
    counts.kg_added++;
  }

  for (const s of result.supersedes) {
    if (!s?.forget_memory_id || !s?.replacement_content) continue;
    const target = findMemory(store, s.forget_memory_id);
    if (!target) {
      // The memory it would replace is already gone (deleted, or superseded
      // by an earlier tick): there is nothing left to decide.
      counts.stale_dropped++;
      continue;
    }
    const supProject = project_(s.project);
    if (!supProject) continue;
    const destructiveOk = s.confidence === "high" && Number(target.importance) < AUTO_IMPORTANCE_CAP;
    if (!destructiveOk) {
      // One pending supersede per target: the newer proposal carries the newer
      // evidence, so it replaces any older one still waiting for review.
      const before = reviewItems.length;
      for (let i = reviewItems.length - 1; i >= 0; i--) {
        const r = reviewItems[i];
        if (r.kind === "supersede" && sameMemoryFamily(r.payload?.forget_memory_id, s.forget_memory_id)) reviewItems.splice(i, 1);
      }
      if (reviewItems.length < before) log(`queue: supersede for ${s.forget_memory_id} replaced ${before - reviewItems.length} older pending proposal(s)`);
      queueReview(reviewItems, "supersede", { ...s, project: supProject }, s.evidence, candidate.key);
      counts.queued++;
      continue;
    }
    if (looksLikeCostFigure(s.replacement_content)) {
      // The target stays as it is; nothing is lost by not replacing it.
      counts.currency_skipped++;
      logCostSkip("supersede", supProject, s.replacement_content);
      continue;
    }
    if (!dry) {
      try {
        // Save first, delete second: a failed save used to leave the target
        // already deleted and its replacement never written.
        const res = await store.store({
          content: s.replacement_content.trim(),
          project: supProject,
          topic: cleanTopic(s.topic || target.topic),
          source: src,
          importance: Math.min(Number(s.importance) || Number(target.importance) || 0.6, AUTO_IMPORTANCE_CAP),
        });
        if (res?.status !== "stored" && res?.status !== "duplicate") continue;
        if (!sameMemoryFamily(res.id, s.forget_memory_id)) deleteIfPresent(store, s.forget_memory_id);
      } catch {
        continue;
      }
    }
    counts.superseded++;
  }

  for (const inv of result.kg_invalidations) {
    if (!inv?.subject || !inv?.predicate || !inv?.object) continue;
    let replProject;
    if (inv.replacement?.subject) {
      replProject = project_(inv.replacement.project);
      if (!replProject) continue;
    }
    if (inv.confidence !== "high") {
      const queued = inv.replacement?.subject ? { ...inv, replacement: { ...inv.replacement, project: replProject } } : inv;
      queueReview(reviewItems, "kg_invalidate", queued, inv.evidence, candidate.key);
      counts.queued++;
      continue;
    }
    if (!dry) {
      try {
        const id = store.findTriple(inv.subject, inv.predicate, inv.object);
        if (id === null) continue;
        store.invalidateTriple(id);
        if (inv.replacement?.subject) {
          store.addTriple({
            subject: inv.replacement.subject,
            predicate: inv.replacement.predicate,
            object: inv.replacement.object,
            valid_from: inv.replacement.from || undefined,
            project: replProject,
          });
        }
      } catch {
        continue;
      }
    }
    counts.kg_invalidated++;
  }

  for (const d of result.doubts) {
    if (!d?.question) continue;
    queueReview(reviewItems, "doubt", d, d.context || "", candidate.key);
    counts.queued++;
  }

  return counts;
}

/**
 * The project a write or queued item is filed under, or null to refuse it.
 *
 * canonicalProject() only fixes casing against projects already in the store,
 * which is how `shashank.j` and `Documents` kept getting through after the
 * v0.8.8 guard: that guard (isNonProjectName) was wired into the CLI and the
 * pi tools, never into this path, and both names already exist as projects,
 * so canonicalProject happily returned them. A model-supplied name that is a
 * working directory falls back to the session's own project; if that is one
 * too, the item is refused. A case variant of the session project
 * (`standardspec` in a `StandardSpec` checkout) takes the session's spelling.
 */
export function resolveProject(name, sessionProject, projects) {
  const session = sessionProject ? canonicalProject(sessionProject, projects) : null;
  const sessionOk = session && !isNonProjectName(session) ? session : null;
  if (!name) return sessionOk;
  if (sessionOk && String(name).toLowerCase() === sessionOk.toLowerCase()) return sessionOk;
  const canon = canonicalProject(String(name).trim(), projects);
  if (!isNonProjectName(canon)) return canon;
  return sessionOk;
}

export function sameMemoryFamily(a, b) {
  if (!a || !b) return false;
  return String(a).replace(/_c\d+$/, "") === String(b).replace(/_c\d+$/, "");
}

/**
 * Whether any row of `id`'s family exists: true, false, or null when the
 * lookup itself failed. Callers treat null as present, so a store error never
 * silently drops a proposal.
 */
export function memoryFamilyExists(store, id) {
  try {
    const family = String(id).replace(/_c\d+$/, "");
    return store.has(id) || store.has(family) || store.has(`${family}_c0`);
  } catch {
    return null;
  }
}

/**
 * Delete a memory family that may already be gone. store() supersedes
 * singleton topics (session-resume, todo-state, playbook) by itself, so the
 * target of a supersede is often deleted before this runs; that is success.
 * Any other error is rethrown.
 */
export function deleteIfPresent(store, id) {
  if (!id) return "no target id";
  try {
    store.delete(id);
    return `deleted ${id}`;
  } catch (e) {
    if (/not found/i.test(String(e?.message))) return `${id} was already gone`;
    throw e;
  }
}

function safeProjects(store) {
  try {
    return store.listProjects().projects;
  } catch {
    return {};
  }
}

export function cleanTopic(topic) {
  const t = String(topic || "").trim().toLowerCase().replace(/\s+/g, "-");
  return t && t !== "general" ? t : "session-watchdog";
}

async function isNearDuplicate(store, content) {
  try {
    const r = await store.search(content.slice(0, 800), { n_results: 1 });
    return r.results.length > 0 && Number(r.results[0].similarity) >= DUP_SIMILARITY;
  } catch {
    return false;
  }
}

function findMemory(store, id) {
  try {
    const r = store.recall({ n_results: 50 });
    const hit = r.results.find((m) => m.id === id);
    if (hit) return hit;
  } catch {}
  // recall window may miss it; fall back to existence check only. Family-aware
  // (`mem_x` and its chunks `mem_x_c0…` are one memory, and store.delete()
  // treats them that way), so a proposal naming a chunk id is not "missing".
  // A failed lookup counts as present so a store error never silently drops a
  // proposal; unknown importance is treated as high, so it is queued.
  if (memoryFamilyExists(store, id) === false) return null;
  return { importance: 1.0, topic: "unknown" };
}

/**
 * Lower a memory's importance, recording the old value first.
 *
 * Demotions are applied without review since 2026-10-02 (Shashank, harness
 * audit: "Auto-apply demotions"). They only re-weight ranking and never remove
 * a memory, and watchdog-demoted.json keeps `from`, so each one can be undone
 * with setImportance(id, from). A proposal that would not lower the importance
 * is not a demotion and is skipped.
 */
export function applyDemotion(store, { id, importance, project, evidence = "", source = "consolidation" }) {
  const to = Number(importance);
  if (!id || !(to >= 0 && to <= 1)) return { status: "invalid" };
  const family = String(id).replace(/_c\d+$/, "");
  let from = null;
  try {
    const row = store.db
      .prepare(`SELECT MAX(importance) AS importance FROM memories WHERE id = ? OR id = ? OR parent_id = ?`)
      .get(id, `${family}_c0`, `${family}_c0`);
    from = row?.importance ?? null;
  } catch {
    return { status: "unreadable" };
  }
  if (from === null) return { status: "missing" };
  if (!(to < from)) return { status: "not-lower", from, to };
  recordDemotions([{ id, project, from, to, source, evidence: String(evidence).slice(0, 300), at: new Date().toISOString() }]);
  store.setImportance(id, to);
  return { status: "applied", from, to };
}
