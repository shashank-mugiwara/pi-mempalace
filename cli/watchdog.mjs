#!/usr/bin/env node
/**
 * watchdog.mjs — cross-agent session watchdog over the shared memory palace.
 *
 * Reads new dialogue from Claude Code / pi / codex (JSONL) and opencode
 * (SQLite) session stores since per-session watermarks, gates on "worth it"
 * (>= 10KB new dialogue AND quiet >= 5 min), summarizes each passing delta
 * with Claude Haiku 4.5 (extended thinking "high", via an isolated nested
 * `claude -p` — see runCurator in watchdog/summarize.mjs), and applies the
 * result under the additive-auto / destructive-queued policy. Scheduled every
 * 15 min by launchd (com.shashank.mempalace-watchdog); equally runnable by hand.
 *
 * Commands:
 *   tick [--dry-run] [--limit N] [--backfill HOURS] [--verbose]
 *       One pass: seed new sources, collect, gate, summarize, apply.
 *       --dry-run: full pipeline INCLUDING model calls but no store writes
 *                  and no watermark advance. Add --no-model to also skip the
 *                  model and just print what would be summarized.
 *   status            Watermark + queue overview.
 *   review            List pending review-queue items (--json).
 *   apply-review --approve id1,id2 --reject id3,...
 *       Apply approved destructive items to the store, drop rejected ones.
 *       Takes watchdog.lock first (waits up to WATCHDOG_LOCK_WAIT_MS, default
 *       120000, then exits 1 with nothing applied), sweeps dead and outranked
 *       supersedes the human did not name, and logs one line per run to
 *       watchdog.log. Items whose project does not resolve stay queued.
 *
 * Every writer of watchdog-review.json (tick, consolidate, apply-review) holds
 * watchdog.lock from the moment it reads the queue until it saves it.
 *
 * Config overrides (~/.pi/agent/memory/config.json, all optional):
 *   watchdogMinNewChars (10240), watchdogQuietMs (300000),
 *   watchdogMaxPerTick (4), watchdogModel ("claude-haiku-4-5"),
 *   watchdogEffort ("high" — a thinking budget on Haiku, --effort on others),
 *   watchdogThinkingTokens (overrides the Haiku budget), watchdogActiveWithinMs (86400000)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MEM_HOME, loadState, saveState, loadReview, saveReview, recordRejections, recordSwept,
  acquireLock, acquireLockWait, refreshLock, releaseLock, lockHolder, rotateLogs, log, REVIEW_PATH,
} from "../watchdog/state.mjs";
import { collectAll, seedNewSources } from "../watchdog/collectors.mjs";
import { gatherContext, buildPrompt, runCurator, canonicalProject } from "../watchdog/summarize.mjs";
import { applyResult } from "../watchdog/apply.mjs";
import { applyReviewItems, sweepQueue } from "../watchdog/review.mjs";
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
    model: user.watchdogModel ?? "claude-haiku-4-5",
    effort: user.watchdogEffort ?? "high",
    thinkingTokens: user.watchdogThinkingTokens,
    activeWithinMs: user.watchdogActiveWithinMs ?? 24 * 60 * 60 * 1000,
    // 21 of the first 329 terra failures were ETIMEDOUT at 300s on high effort.
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
    refreshLock();
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

/**
 * Sweep the queue under the lock: drop supersedes whose target is gone and
 * older proposals outranked by a newer one for the same target. Saves only
 * when something was dropped and this is not a dry run.
 */
function sweepUnderLock(store, { exempt, dryRun } = {}) {
  const review = loadReview();
  const { review: kept, dropped } = sweepQueue(store, review, { exempt });
  for (const d of dropped) {
    log(`sweep: dropped ${d.item.id} (${d.item.kind}, ${d.item.payload?.project || "?"}) — ${d.reason}`);
  }
  if (dropped.length && !dryRun) {
    recordSwept(dropped); // archive first: an item is never in neither file
    saveReview(kept);
  }
  return { before: review, review: kept, dropped };
}

async function cmdTick(opts) {
  if (!acquireLock()) {
    log("tick: lock held, skipping");
    console.log("tick skipped: another watchdog run holds the lock");
    return;
  }
  try {
    rotateLogs();
    const store = new MemoryStore();
    if (!opts["dry-run"]) {
      try {
        const sw = sweepUnderLock(store);
        if (sw.dropped.length) console.log(`swept ${sw.dropped.length} dead or outranked supersede(s) from the review queue`);
      } catch (e) {
        log(`sweep FAILED: ${e?.message || e} — queue left as it was`);
      }
    }
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

    const review = loadReview();
    for (const c of eligible) {
      const ctx = await gatherContext(store, c);
      c.project = canonicalProject(c.project, ctx.projects);
      const prompt = buildPrompt(c, ctx);
      log(`summarizing ${c.source}/${c.project} (${c.rawTextLength} chars) with ${cfg.model}/${cfg.effort}`);
      const t0 = Date.now();
      // Heartbeat before each model call (up to cfg.timeoutMs): a live tick
      // must never look hung to apply-review waiting on the same lock.
      refreshLock();
      const run = runCurator(prompt, { model: cfg.model, effort: cfg.effort, thinkingTokens: cfg.thinkingTokens, timeoutMs: cfg.timeoutMs });
      if (!run.ok) {
        log(`model FAILED (${cfg.model}) for ${c.key}: ${run.error} — watermark NOT advanced, retry next tick`);
        console.log(`  ✗ ${c.source}/${c.project}: ${run.error}`);
        continue;
      }
      const counts = await applyResult(store, c, run.result, review, { dryRun: opts["dry-run"] });
      if (!opts["dry-run"]) {
        c.commit(state);
        saveState(state);
        saveReview(review);
      }
      const summary = `saved ${counts.saved}, playbook+${counts.playbook_saved}, kg+${counts.kg_added}, superseded ${counts.superseded}, kg-inv ${counts.kg_invalidated}, queued ${counts.queued + counts.playbook_queued}, dup-skip ${counts.dup_skipped}${counts.currency_skipped ? `, currency-skip ${counts.currency_skipped}` : ""} (${Math.round((Date.now() - t0) / 1000)}s)`;
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
  // The tick and consolidation hold this lock from reading the queue to saving
  // it. Without it, a tick that loaded the queue before this run and saved it
  // after would silently put back every item approved or rejected here.
  const waitMs = Number(process.env.WATCHDOG_LOCK_WAIT_MS ?? 120_000);
  if (!(await acquireLockWait(waitMs))) {
    const h = lockHolder();
    console.error(
      `apply-review: another watchdog run holds the lock` +
        (h?.pid ? ` (pid ${h.pid}, last heartbeat ${new Date(h.at).toISOString()})` : "") +
        `; waited ${Math.round(waitMs / 1000)}s. Nothing applied; retry when it finishes.`
    );
    process.exitCode = 1;
    return;
  }
  try {
    // Read only after the lock is held: a tick that finished while we waited
    // may have changed the queue.
    const review = loadReview();
    // Fail before touching anything if an id is not in the queue: a typo or a
    // stale id used to be ignored silently, which reads as "applied" to the caller.
    const known = new Set(review.map((r) => r.id));
    const unknown = [...approve, ...reject].filter((id) => !known.has(id));
    const both = approve.filter((id) => reject.includes(id));
    // Two approved supersedes for one target would write two replacements and
    // delete the target once — the accumulated trail the one-record rule exists
    // to prevent (bead hx-r8e). Approve one, reject the rest.
    const byTarget = new Map();
    for (const r of review) {
      if (r.kind !== "supersede" || !approve.includes(r.id)) continue;
      const target = String(r.payload?.forget_memory_id || "").replace(/_c\d+$/, "");
      if (target) byTarget.set(target, [...(byTarget.get(target) || []), r.id]);
    }
    const collisions = [...byTarget].filter(([, ids]) => ids.length > 1);
    if (unknown.length || both.length || collisions.length) {
      if (unknown.length) console.error(`not in queue: ${unknown.join(", ")}`);
      if (both.length) console.error(`listed as both approve and reject: ${both.join(", ")}`);
      for (const [target, ids] of collisions) console.error(`approved supersedes share target ${target}: ${ids.join(", ")} — approve one, reject the others`);
      console.error(`nothing applied (queue: ${review.length} items; run \`review\` to list ids)`);
      process.exitCode = 1;
      return;
    }
    const store = new MemoryStore();
    // Ids named on this command line are exempt: an explicit verdict outranks
    // the sweep. Rejections are recorded (they are the only labelled signal);
    // swept items are not, because no human judged them.
    const sw = sweepQueue(store, review, { exempt: new Set([...approve, ...reject]) });
    for (const d of sw.dropped) {
      log(`sweep: dropped ${d.item.id} (${d.item.kind}, ${d.item.payload?.project || "?"}) — ${d.reason}`);
      console.log(`swept ${d.item.id} (${d.item.kind}): ${d.reason}`);
    }
    recordSwept(sw.dropped); // archived before the swept queue is saved below
    console.log(`applying: ${approve.length} approve, ${reject.length} reject (queue: ${review.length})`);
    let projects = {};
    try {
      projects = store.listProjects().projects;
    } catch {}
    const { keep, rejected, counts, messages } = await applyReviewItems(store, sw.review, { approve, reject, projects });
    for (const m of messages) (m.level === "error" ? console.error : console.log)(m.text);
    // Queue last: the store effects above happen first, so a crash in between
    // leaves an applied item queued, and re-approving it is idempotent.
    saveReview(keep);
    recordRejections(rejected);
    if (rejected.length) {
      console.log(
        `rejected: ${rejected.length} recorded to watchdog-rejections.json ` +
          `(fed back into the curator prompt so they are not re-proposed)`
      );
    }
    log(
      `apply-review: approved ${counts.approved}, rejected ${counts.rejected}, applied ${counts.applied}, ` +
        `failed ${counts.failed}, refused ${counts.refused}, swept ${sw.dropped.length}; queue ${review.length} -> ${keep.length}`
    );
    console.log(`queue: ${keep.length} remaining`);
  } finally {
    releaseLock();
  }
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
