/**
 * state.mjs — watchdog persistent state: per-session watermarks + review queue.
 *
 * Watermarks live in ~/.pi/agent/memory/watchdog-state.json:
 *   {
 *     "seeded_at": "...",              // first-run marker
 *     "files": { "<abs path>": { "bytes": N, "at": iso } },      // jsonl sources
 *     "opencode": { "<session id>": { "lastTime": ms, "at": iso } }
 *   }
 *
 * Review queue lives in ~/.pi/agent/memory/watchdog-review.json:
 *   [ { id, kind, payload, evidence, sessionKey, created } ]
 *
 * Rejections live in ~/.pi/agent/memory/watchdog-rejections.json:
 *   [ { id, kind, project, topic, gist, evidence, rejected_at } ]
 * What the human turned down, newest first, capped. Fed back into the curator
 * prompt so a rejected inference is not re-derived on the next tick.
 *
 * First run seeds every existing source at its current end — the watchdog
 * summarizes work from "now" onward, never a surprise backfill of months of
 * history (use `watchdog.mjs tick --backfill <hours>` to deliberately reach
 * back).
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const MEM_HOME = process.env.MEMPALACE_HOME || join(homedir(), ".pi", "agent", "memory");
export const STATE_PATH = join(MEM_HOME, "watchdog-state.json");
export const REVIEW_PATH = join(MEM_HOME, "watchdog-review.json");
export const REJECTIONS_PATH = join(MEM_HOME, "watchdog-rejections.json");
/** Newest-first cap on the rejection memo — see recordRejections. */
export const MAX_REJECTIONS = 40;
export const LOCK_PATH = join(MEM_HOME, "watchdog.lock");
export const LOG_PATH = join(MEM_HOME, "watchdog.log");

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

export function loadState() {
  return readJson(STATE_PATH, { seeded_at: null, files: {}, opencode: {} });
}

export function saveState(state) {
  writeJsonAtomic(STATE_PATH, state);
}

export function loadReview() {
  return readJson(REVIEW_PATH, []);
}

export function saveReview(items) {
  writeJsonAtomic(REVIEW_PATH, items);
}

export function loadRejections() {
  return readJson(REJECTIONS_PATH, []);
}

/**
 * Record what the human turned down, so the curator can stop proposing it.
 *
 * A rejection is the only *labelled* signal in this system: a person looked at
 * a concrete proposal and said no. Dropping it (as `apply-review` used to)
 * meant the same bad inference could be re-derived from the same transcript on
 * every subsequent tick, with no way for the loop to converge.
 *
 * Capped at MAX_REJECTIONS newest-first — this is a feedback signal for recent
 * curation, not an audit log, and it is injected into a prompt where unbounded
 * growth would cost tokens on every tick.
 */
export function recordRejections(rejected) {
  if (!rejected?.length) return;
  const existing = loadRejections();
  const added = rejected.map((item) => ({
    id: item.id,
    kind: item.kind,
    project: item.payload?.project || null,
    topic: item.payload?.topic || null,
    // The gist is what the curator must not re-propose. Full payloads make the
    // file (and the prompt block built from it) grow without adding signal.
    gist: String(
      item.payload?.replacement_content ||
        item.payload?.content ||
        [item.payload?.subject, item.payload?.predicate, item.payload?.object]
          .filter(Boolean)
          .join(" ") ||
        ""
    ).slice(0, 300),
    evidence: String(item.evidence || "").slice(0, 200),
    rejected_at: new Date().toISOString(),
  }));
  writeJsonAtomic(REJECTIONS_PATH, [...added, ...existing].slice(0, MAX_REJECTIONS));
}

export function queueReview(items, kind, payload, evidence, sessionKey) {
  items.push({
    id: "rev_" + randomUUID().slice(0, 8),
    kind,
    payload,
    evidence: evidence || "",
    sessionKey,
    created: new Date().toISOString(),
  });
}

export function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    writeFileSync(LOG_PATH, line, { flag: "a" });
  } catch {
    /* logging must never break a tick */
  }
  if (process.env.WATCHDOG_VERBOSE === "1") process.stderr.write(line);
}

/**
 * Cross-process lock so overlapping ticks (multiple pi instances, or a tick
 * outliving its interval) never double-process. Stale locks (>15 min) are
 * broken — a tick is capped well under that.
 */
export function acquireLock() {
  try {
    writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
    return true;
  } catch {
    const held = readJson(LOCK_PATH, null);
    if (held && Date.now() - held.at > 15 * 60 * 1000) {
      try {
        writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() }));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

export function releaseLock() {
  try {
    const held = readJson(LOCK_PATH, null);
    if (held && held.pid === process.pid) {
      writeFileSync(LOCK_PATH, "");
      renameSync(LOCK_PATH, LOCK_PATH + ".released");
    }
  } catch {
    /* best effort */
  }
}

export { existsSync };
