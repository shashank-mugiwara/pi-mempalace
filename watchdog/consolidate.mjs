/**
 * consolidate.mjs — the forgetting the palace never had.
 *
 * Memories accumulate (2,159 by 2026-09-02) and importance never decays, so
 * the wake-up digest and search rank month-old harness meta-facts beside
 * live decisions. A human re-weighs old beliefs against newer evidence; this
 * pass does the equivalent for one project: it hands a topic-batched slice
 * of older memories to the curator model and asks for merges, importance
 * demotions and deletions, each with evidence.
 *
 * Nothing here is applied. Every proposal is queued for review — the same
 * queue the tick uses for destructive changes — because a wrong forget is
 * the one memory error that cannot be undone by the next session.
 *
 * Used by cli/watchdog.mjs:
 *   consolidate [--project P] [--min-age-days 45] [--dry-run] [--limit N]
 *   and automatically from `tick` when the last pass is > 30 days old.
 */

import { runCurator, canonicalProject } from "./summarize.mjs";
import { applyDemotion } from "./apply.mjs";
import { queueReview, log, refreshLock } from "./state.mjs";

export const SINGLETON_TOPICS = ["session-resume", "todo-state", "playbook"];
export const CONSOLIDATE_EVERY_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_ROWS = 15;
const BATCH_CHARS = 50_000;
const MAX_BATCHES_PER_PROJECT = 3;

/** Older, non-singleton memories for a project, grouped into batches by topic. */
export function candidateBatches(store, project, minAgeDays) {
  const cutoff = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const placeholders = SINGLETON_TOPICS.map(() => "?").join(",");
  const rows = store.db
    .prepare(
      `SELECT id, topic, importance, timestamp, source, content FROM memories
       WHERE project = ? AND chunk_index = 0 AND timestamp < ? AND topic NOT IN (${placeholders})
       ORDER BY topic, timestamp`,
    )
    .all(project, cutoff, ...SINGLETON_TOPICS);
  if (rows.length < MIN_ROWS) return [];
  const batches = [];
  let current = [];
  let size = 0;
  for (const r of rows) {
    const line = `[id=${r.id} imp=${r.importance} ${r.topic} ${String(r.timestamp).slice(0, 10)} src=${r.source}]\n${String(r.content).slice(0, 1200)}`;
    if (size + line.length > BATCH_CHARS && current.length) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length;
  }
  if (current.length) batches.push(current);
  return batches.slice(0, MAX_BATCHES_PER_PROJECT);
}

function buildPrompt(project, lines) {
  return `You are the consolidation curator for a shared cross-agent memory palace (pi, Claude Code, codex, opencode all read it).
Below are older memories for project "${project}", grouped by topic. Propose how to consolidate them so the store stays
sharp: fewer, denser, still-true memories rank first; narration, duplicates and superseded state stop competing.

Rules — precision over coverage, and every proposal carries evidence quoting the memories it rests on:
- MERGE only memories that describe the same thing; the replacement must lose no fact that is still true. Never merge a LESSON with a non-lesson. Keep the replacement self-contained with absolute dates. Leave out cost figures in dollars or any other currency (API spend, bills); state that impact in tokens, duration or a relative multiplier.
- DEMOTE (lower importance) memories that are narration, transient status, or clearly superseded by a later memory in this batch. Give the new importance (0.2–0.5).
- DELETE only byte-near duplicates or transient notes with no durable content (a build passed, a file was read). When in doubt, demote instead.
- Do not touch lessons except to merge exact duplicates. Do not propose more than 15 items total. Skip anything you are unsure about — a wrong forget cannot be undone.

<memories>
${lines.join("\n\n")}
</memories>

Respond with JSON only:
{
  "merges":    [{"forget_memory_ids": [str], "replacement_content": str, "topic": str, "importance": num, "evidence": str}],
  "demotions": [{"id": str, "importance": num, "evidence": str}],
  "deletions": [{"id": str, "evidence": str}]
}`;
}

/**
 * Run one project. Returns counts of proposals queued. `opts.dryRun` prints
 * the proposals and queues nothing.
 */
export async function consolidateProject(store, project, cfg, review, opts = {}) {
  const canon = canonicalProject(project, store.listProjects().projects) || project;
  const batches = candidateBatches(store, canon, cfg.minAgeDays);
  const counts = { batches: batches.length, merges: 0, demotions: 0, deletions: 0, failed: 0 };
  if (!batches.length) {
    log(`consolidate ${canon}: fewer than ${MIN_ROWS} eligible memories — skipped`);
    return counts;
  }
  const known = new Set(
    store.db.prepare(`SELECT id FROM memories WHERE project = ?`).all(canon).map((r) => r.id),
  );
  for (const [i, lines] of batches.entries()) {
    const t0 = Date.now();
    // Heartbeat before each model call (up to cfg.timeoutMs): a live run must
    // never look hung to apply-review waiting on the same lock.
    refreshLock();
    const run = runCurator(buildPrompt(canon, lines), { model: cfg.model, effort: cfg.effort, thinkingTokens: cfg.thinkingTokens, timeoutMs: cfg.timeoutMs, raw: true });
    if (!run.ok) {
      counts.failed++;
      log(`consolidate ${canon} batch ${i + 1}/${batches.length} FAILED: ${run.error}`);
      continue;
    }
    const r = run.result || {};
    const key = `consolidate:${canon}:${new Date().toISOString().slice(0, 10)}`;
    for (const m of r.merges || []) {
      const ids = (m.forget_memory_ids || []).filter((id) => known.has(id));
      if (ids.length < 2 || !m.replacement_content) continue;
      counts.merges++;
      if (!opts.dryRun) queueReview(review, "merge", { forget_memory_ids: ids, replacement_content: m.replacement_content, project: canon, topic: m.topic, importance: m.importance }, m.evidence, key);
    }
    for (const d of r.demotions || []) {
      if (!known.has(d.id) || !(d.importance >= 0 && d.importance <= 1)) continue;
      // Applied, not queued (since 2026-10-02): reversible, see applyDemotion.
      const res = opts.dryRun ? { status: "dry-run" } : applyDemotion(store, { id: d.id, importance: d.importance, project: canon, evidence: d.evidence });
      if (res.status === "applied" || res.status === "dry-run") counts.demotions++;
      if (res.status === "applied") log(`consolidate ${canon}: demoted ${d.id} ${res.from} -> ${res.to}`);
    }
    for (const d of r.deletions || []) {
      if (!known.has(d.id)) continue;
      counts.deletions++;
      if (!opts.dryRun) queueReview(review, "delete", { id: d.id, project: canon }, d.evidence, key);
    }
    if (opts.dryRun) console.log(JSON.stringify(r, null, 2));
    log(`consolidate ${canon} batch ${i + 1}/${batches.length}: merges ${counts.merges}, demotions ${counts.demotions}, deletions ${counts.deletions} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  return counts;
}

/** Projects due for a pass: largest first, skipping ones consolidated recently. */
export function dueProjects(store, state, limit) {
  const done = state.consolidated || {};
  return Object.entries(store.listProjects().projects)
    .filter(([p, n]) => n >= MIN_ROWS && Date.now() - (typeof done[p] === "string" ? Date.parse(done[p]) || 0 : 0) > CONSOLIDATE_EVERY_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([p]) => p);
}
