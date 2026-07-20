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
  MEM_HOME, loadState, saveState, loadReview, saveReview,
  acquireLock, releaseLock, log, REVIEW_PATH,
} from "../watchdog/state.mjs";
import { collectAll, seedNewSources } from "../watchdog/collectors.mjs";
import { gatherContext, buildPrompt, runTerra, canonicalProject } from "../watchdog/summarize.mjs";
import { applyResult } from "../watchdog/apply.mjs";
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
  };
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
      .filter((c) => c.rawTextLength >= cfg.minNewChars && now - c.lastActivityMs >= cfg.quietMs)
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

    log(`tick: ${all.length} deltas, ${eligible.length} eligible, ${noiseAdvanced} noise-advanced, seeded ${seeded}`);
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
      const run = runTerra(prompt, { model: cfg.model, effort: cfg.effort });
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
      const summary = `saved ${counts.saved}, kg+${counts.kg_added}, superseded ${counts.superseded}, kg-inv ${counts.kg_invalidated}, queued ${counts.queued}, dup-skip ${counts.dup_skipped} (${Math.round((Date.now() - t0) / 1000)}s)`;
      log(`applied ${c.source}/${c.project}: ${summary}`);
      console.log(`  ✓ ${c.source}/${c.project}: ${summary}${opts["dry-run"] ? " [DRY RUN — nothing written]" : ""}`);
      if (opts["dry-run"]) console.log(JSON.stringify(run.result, null, 2));
    }
    if (!opts["dry-run"]) saveState(state);
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
  const store = new MemoryStore();
  const keep = [];
  for (const item of review) {
    if (reject.includes(item.id)) continue;
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
    default:
      console.log("usage: watchdog.mjs <tick|status|review|apply-review> [options] (see file header)");
  }
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  console.error(e?.message || e);
  process.exit(1);
});
