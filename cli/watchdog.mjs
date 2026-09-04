#!/usr/bin/env node
/**
 * watchdog.mjs — cross-agent session watchdog over the shared memory palace.
 *
 * Reads new dialogue from Claude Code / pi / codex (JSONL) and opencode
 * (SQLite) session stores since per-session watermarks, gates on "worth it"
 * (>= 10KB new dialogue AND quiet >= 5 min), summarizes each passing delta
 * with gpt-5.6-terra (high effort, via `codex exec`), and applies the result
 * under the additive-auto / destructive-queued policy. Scheduled every 15 min
 * by the session-watchdog pi extension; equally runnable by hand.
 *
 * Commands:
 *   tick [--dry-run] [--limit N] [--backfill HOURS] [--verbose]
 *       One pass: seed new sources, collect, gate, summarize, apply.
 *       --dry-run: full pipeline INCLUDING terra calls but no store writes
 *                  and no watermark advance. Add --no-model to also skip terra
 *                  and just print what would be summarized.
 *   status            Watermark + queue overview.
 *   review            List pending review-queue items (--json).
 *   apply-review --approve id1,id2 --reject id3,...
 *       Apply approved destructive items to the store, drop rejected ones.
 *
 * Config overrides (~/.pi/agent/memory/config.json, all optional):
 *   watchdogMinNewChars (10240), watchdogQuietMs (300000),
 *   watchdogMaxPerTick (4), watchdogModel ("gpt-5.6-terra"),
 *   watchdogEffort ("high"), watchdogActiveWithinMs (86400000)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MEM_HOME, loadState, saveState, loadReview, saveReview, recordRejections,
  acquireLock, releaseLock, log, REVIEW_PATH,
} from "../watchdog/state.mjs";
import { collectAll, seedNewSources } from "../watchdog/collectors.mjs";
import { gatherContext, buildPrompt, runTerra, canonicalProject } from "../watchdog/summarize.mjs";
import { applyResult } from "../watchdog/apply.mjs";
import { consolidateProject, dueProjects, CONSOLIDATE_EVERY_MS } from "../watchdog/consolidate.mjs";
import { MemoryStore } from "../extensions/pi-mempalace/memory_store.ts";

function config() {
  let user = {};
  try {
    user = JSON.parse(readFileSync(join(MEM_HOME, "config.json"), "utf8"));
  } catch {}
  return {
    minNewChars: user.watchdogMinNewChars ?? 10_240,
    quietMs: user.watchdogQuietMs ?? 5 * 60 * 1000,
    maxPerTick: user.watchdogMaxPerTick ?? 4,
    model: user.watchdogModel ?? "gpt-5.6-terra",
    effort: user.watchdogEffort ?? "high",
    activeWithinMs: user.watchdogActiveWithinMs ?? 24 * 60 * 60 * 1000,
    // 21 of the first 329 failures were ETIMEDOUT at 300s on high effort.
    timeoutMs: user.watchdogTimeoutMs ?? 600_000,
    // Consolidation: memories older than this are eligible for merge/demote.
    minAgeDays: user.watchdogConsolidateMinAgeDays ?? 45,
    consolidateProjectsPerTick: user.watchdogConsolidateProjectsPerTick ?? 2,
  };
}

/** Monthly re-weighing of a project's older memories. Everything goes to the
 *  review queue; nothing is applied here. */
async function runConsolidation(store, state, review, cfg, projects, opts = {}) {
  const totals = { merges: 0, demotions: 0, deletions: 0, failed: 0 };
  for (const project of projects) {
    const c = await consolidateProject(store, project, cfg, review, opts);
    totals.merges += c.merges; totals.demotions += c.demotions; totals.deletions += c.deletions; totals.failed += c.failed;
    console.log(`  consolidate ${project}: ${c.batches} batch(es) → merges ${c.merges}, demotions ${c.demotions}, deletions ${c.deletions}${c.failed ? `, failed ${c.failed}` : ""}${opts.dryRun ? " [DRY RUN]" : ""}`);
    if (!opts.dryRun && !c.failed) {
      state.consolidated ??= {};
      state.consolidated[project] = new Date().toISOString();
      state.lastConsolidationAt = state.consolidated[project];
    }
  }
  return totals;
}

async function cmdTick(opts) {
  if (!acquireLock()) {
    log("tick: lock held, skipping");
    console.log("tick skipped: another watchdog run holds the lock");
    return;
  }
  try {
    const cfg = config();
    const state = loadState();
    const seeded = seedNewSources(state, (Number(opts.backfill) || 0) * 3600 * 1000);
    if (seeded > 0 && !opts["dry-run"]) saveState(state);

    const all = collectAll(state, cfg.activeWithinMs);
    const now = Date.now();
    const eligible = all
      // A collector may set its own floor: Claude Code's local memory notes
      // are a few KB per file and already distilled, so the 10KB dialogue
      // gate would park them forever.
      .filter((c) => c.rawTextLength >= (c.minChars ?? cfg.minNewChars) && now - c.lastActivityMs >= cfg.quietMs)
      .sort((a, b) => a.lastActivityMs - b.lastActivityMs)
      .slice(0, Number(opts.limit) || cfg.maxPerTick);

    // Deltas below the gate that are pure tool noise (no dialogue at all)
    // still advance, so we never re-parse them forever.
    let noiseAdvanced = 0;
    for (const c of all) {
      if (c.rawTextLength === 0 && now - c.lastActivityMs >= cfg.quietMs) {
        c.skipCommit(state);
        noiseAdvanced++;
      }
    }

    const tracked = `tracked: files=${Object.keys(state.files).length} opencode=${Object.keys(state.opencode).length}`;
    log(`tick: ${all.length} deltas, ${eligible.length} eligible, ${noiseAdvanced} noise-advanced, seeded ${seeded}, ${tracked}`);
    console.log(`deltas: ${all.length} | eligible (>=${cfg.minNewChars} chars, quiet ${cfg.quietMs / 60000}m): ${eligible.length}`);
    for (const c of all) {
      const el = eligible.includes(c) ? "ELIGIBLE" : "below-gate";
      console.log(`  [${el}] ${c.source} ${c.project} — ${c.rawTextLength} new chars, idle ${Math.round((now - c.lastActivityMs) / 60000)}m (${String(c.key).slice(-60)})`);
    }

    if (opts["no-model"]) {
      if (!opts["dry-run"]) saveState(state);
      return;
    }

    const store = new MemoryStore();
    const review = loadReview();
    for (const c of eligible) {
      const ctx = await gatherContext(store, c);
      c.project = canonicalProject(c.project, ctx.projects);
      const prompt = buildPrompt(c, ctx);
      log(`summarizing ${c.source}/${c.project} (${c.rawTextLength} chars) with ${cfg.model}/${cfg.effort}`);
      const t0 = Date.now();
      const run = runTerra(prompt, { model: cfg.model, effort: cfg.effort, timeoutMs: cfg.timeoutMs });
      if (!run.ok) {
        log(`terra FAILED for ${c.key}: ${run.error} — watermark NOT advanced, retry next tick`);
        console.log(`  ✗ ${c.source}/${c.project}: ${run.error}`);
        continue;
      }
      const counts = await applyResult(store, c, run.result, review, { dryRun: opts["dry-run"] });
      if (!opts["dry-run"]) {
        c.commit(state);
        saveState(state);
        saveReview(review);
      }
      const summary = `saved ${counts.saved}, playbook+${counts.playbook_saved}, kg+${counts.kg_added}, superseded ${counts.superseded}, kg-inv ${counts.kg_invalidated}, queued ${counts.queued + counts.playbook_queued}, dup-skip ${counts.dup_skipped} (${Math.round((Date.now() - t0) / 1000)}s)`;
      log(`applied ${c.source}/${c.project}: ${summary}`);
      console.log(`  ✓ ${c.source}/${c.project}: ${summary}${opts["dry-run"] ? " [DRY RUN — nothing written]" : ""}`);
      if (opts["dry-run"]) console.log(JSON.stringify(run.result, null, 2));
    }

    // Monthly consolidation rides on the tick so it needs no separate
    // scheduler. Bounded per tick; proposals only ever reach the review queue.
    if (!opts["dry-run"] && Date.now() - (typeof state.lastConsolidationAt === "string" ? Date.parse(state.lastConsolidationAt) || 0 : 0) > CONSOLIDATE_EVERY_MS) {
      const due = dueProjects(store, state, cfg.consolidateProjectsPerTick);
      if (due.length) {
        log(`consolidation due: ${due.join(", ")}`);
        const t = await runConsolidation(store, state, review, cfg, due);
        saveReview(review);
        if (!t.failed) state.lastConsolidationAt = new Date().toISOString();
        log(`consolidation done: merges ${t.merges}, demotions ${t.demotions}, deletions ${t.deletions}, failed ${t.failed}`);
      } else {
        // Nothing large enough or everything recent — check again next month.
        state.lastConsolidationAt = new Date().toISOString();
      }
    }
    if (!opts["dry-run"]) saveState(state);
  } finally {
    releaseLock();
  }
}

async function cmdConsolidate(opts) {
  if (!acquireLock()) {
    console.log("consolidate skipped: another watchdog run holds the lock");
    return;
  }
  try {
    const cfg = config();
    if (opts["min-age-days"]) cfg.minAgeDays = Number(opts["min-age-days"]);
    const state = loadState();
    const store = new MemoryStore();
    const review = loadReview();
    const projects = opts.project ? [opts.project] : dueProjects(store, state, Number(opts.limit) || cfg.consolidateProjectsPerTick);
    if (!projects.length) return console.log("consolidate: no project is due (use --project P to force one)");
    const t = await runConsolidation(store, state, review, cfg, projects, { dryRun: !!opts["dry-run"] });
    if (!opts["dry-run"]) {
      saveReview(review);
      if (!t.failed) state.lastConsolidationAt = new Date().toISOString();
      saveState(state);
      console.log(`queued ${t.merges + t.demotions + t.deletions} proposal(s) for review — \`watchdog.mjs review\``);
    }
  } finally {
    releaseLock();
  }
}

function cmdStatus() {
  const state = loadState();
  const review = loadReview();
  console.log(`seeded_at: ${state.seeded_at}`);
  console.log(`tracked jsonl files: ${Object.keys(state.files).length}`);
  console.log(`tracked opencode sessions: ${Object.keys(state.opencode).length}`);
  console.log(`pending review items: ${review.length}  (${REVIEW_PATH})`);
}

function cmdReview(opts) {
  const review = loadReview();
  if (opts.json) return console.log(JSON.stringify(review, null, 2));
  if (review.length === 0) return console.log("Review queue empty.");
  for (const r of review) {
    console.log(`\n[${r.id}] ${r.kind} (${r.created}, session ${String(r.sessionKey).slice(-40)})`);
    if (r.kind === "doubt") {
      console.log(`  Q: ${r.payload.question}\n  context: ${r.payload.context || r.evidence}\n  proposed: ${r.payload.proposed_action}`);
    } else {
      console.log(`  ${JSON.stringify(r.payload).slice(0, 400)}`);
      if (r.evidence) console.log(`  evidence: ${r.evidence.slice(0, 300)}`);
    }
  }
}

async function cmdApplyReview(opts) {
  const approve = String(opts.approve || "").split(",").filter(Boolean);
  const reject = String(opts.reject || "").split(",").filter(Boolean);
  if (approve.length + reject.length === 0) {
    console.error("apply-review needs --approve and/or --reject id lists");
    process.exit(1);
  }
  const review = loadReview();
  // Fail before touching anything if an id is not in the queue: a typo or a
  // stale id used to be ignored silently, which reads as "applied" to the caller.
  const known = new Set(review.map((r) => r.id));
  const unknown = [...approve, ...reject].filter((id) => !known.has(id));
  const both = approve.filter((id) => reject.includes(id));
  if (unknown.length || both.length) {
    if (unknown.length) console.error(`not in queue: ${unknown.join(", ")}`);
    if (both.length) console.error(`listed as both approve and reject: ${both.join(", ")}`);
    console.error(`nothing applied (queue: ${review.length} items; run \`review\` to list ids)`);
    process.exit(1);
  }
  console.log(`applying: ${approve.length} approve, ${reject.length} reject (queue: ${review.length})`);
  const store = new MemoryStore();
  const keep = [];
  const rejected = [];
  for (const item of review) {
    if (reject.includes(item.id)) {
      // Rejections used to be dropped here. They are the only labelled signal
      // the system gets — a human judging a concrete proposal wrong — so they
      // are persisted and fed back into the curator prompt, which is what stops
      // the same inference being re-derived from the same transcript next tick.
      rejected.push(item);
      continue;
    }
    if (!approve.includes(item.id)) {
      keep.push(item);
      continue;
    }
    try {
      if (item.kind === "supersede") {
        const s = item.payload;
        try { store.delete(s.forget_memory_id); } catch {}
        await store.store({
          content: s.replacement_content.trim(),
          project: s.project || "general",
          topic: s.topic || "session-watchdog",
          source: "session-watchdog:review-approved",
          importance: Number(s.importance) || 0.7,
        });
      } else if (item.kind === "lesson") {
        const l = item.payload;
        // Trigger first: a lesson is retrieved when the situation recurs, so
        // the "when X, check Y" line has to carry the searchable wording.
        await store.store({
          content: `LESSON (${l.trigger})\n${l.content.trim()}`,
          project: l.project || "general",
          topic: "lessons",
          source: "session-watchdog:lesson-approved",
          importance: Number(l.importance) || 0.85,
        });
      } else if (item.kind === "playbook") {
        const p = item.payload;
        // Vault write is NOT done here — apply-review is a human/CLI path with
        // no vault-write competence either (same reason apply.mjs never
        // auto-applies vault-bound entries). If destination includes "vault",
        // the human (or the live agent, per session-watchdog.ts's review
        // notice) writes the note by hand/tool; this only persists the
        // memory-side copy.
        await store.store({
          content: p.content.trim(),
          project: p.project || "general",
          topic: "playbook",
          source: "session-watchdog:playbook-approved",
          importance: Number(p.importance) || 0.7,
        });
      } else if (item.kind === "merge") {
        // Consolidation: several memories → one. Store first so a failed save
        // never leaves the originals gone.
        const m = item.payload;
        const res = await store.store({
          content: m.replacement_content.trim(),
          project: m.project || "general",
          topic: m.topic || "consolidated",
          source: "session-watchdog:consolidation-approved",
          importance: Number(m.importance) || 0.7,
        });
        if (res.status === "stored" || res.status === "duplicate") {
          for (const id of m.forget_memory_ids || []) {
            try { store.delete(id); } catch {}
          }
        }
      } else if (item.kind === "demote") {
        store.setImportance(item.payload.id, Number(item.payload.importance));
      } else if (item.kind === "delete") {
        try { store.delete(item.payload.id); } catch {}
      } else if (item.kind === "kg_invalidate") {
        const inv = item.payload;
        const id = store.findTriple(inv.subject, inv.predicate, inv.object);
        if (id !== null) store.invalidateTriple(id);
        if (inv.replacement?.subject) {
          store.addTriple({
            subject: inv.replacement.subject,
            predicate: inv.replacement.predicate,
            object: inv.replacement.object,
            valid_from: inv.replacement.from || undefined,
            project: inv.replacement.project || "general",
          });
        }
      } else {
        // doubts have no mechanical action; approving one just clears it
        // (the human acts on it themselves, or dictates a save in-session).
      }
      console.log(`applied ${item.id} (${item.kind})`);
    } catch (e) {
      console.error(`failed ${item.id}: ${e?.message || e} — kept in queue`);
      keep.push(item);
    }
  }
  saveReview(keep);
  recordRejections(rejected);
  if (rejected.length) {
    console.log(
      `rejected: ${rejected.length} recorded to watchdog-rejections.json ` +
        `(fed back into the curator prompt so they are not re-proposed)`
    );
  }
  console.log(`queue: ${keep.length} remaining`);
}

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else opts[key] = true;
    } else positional.push(a);
  }
  return { positional, opts };
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { opts } = parseArgs(rest);
  if (opts.verbose) process.env.WATCHDOG_VERBOSE = "1";
  switch (cmd) {
    case "tick": return cmdTick(opts);
    case "status": return cmdStatus();
    case "review": return cmdReview(opts);
    case "apply-review": return cmdApplyReview(opts);
    case "consolidate": return cmdConsolidate(opts);
    default:
      console.log("usage: watchdog.mjs <tick|status|review|apply-review|consolidate> [options] (see file header)");
  }
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  console.error(e?.message || e);
  process.exit(1);
});
