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

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";

export const MEM_HOME = process.env.MEMPALACE_HOME || join(homedir(), ".pi", "agent", "memory");
export const STATE_PATH = join(MEM_HOME, "watchdog-state.json");
export const REVIEW_PATH = join(MEM_HOME, "watchdog-review.json");
export const REJECTIONS_PATH = join(MEM_HOME, "watchdog-rejections.json");
/** Newest-first cap on the rejection memo — see recordRejections. */
export const MAX_REJECTIONS = 40;
/** Items the queue sweep dropped, whole, so any of them can be put back. */
export const SWEPT_PATH = join(MEM_HOME, "watchdog-swept.json");
export const MAX_SWEPT = 300;
/** Every applied demotion with its old importance, so each one can be undone. */
export const DEMOTED_PATH = join(MEM_HOME, "watchdog-demoted.json");
export const MAX_DEMOTED = 2000;
export const LOCK_PATH = join(MEM_HOME, "watchdog.lock");
export const LOG_PATH = join(MEM_HOME, "watchdog.log");
/** launchd's StandardOutPath/StandardErrorPath for the tick (see the plist). */
export const LAUNCHD_LOG_PATH = join(MEM_HOME, "watchdog-launchd.log");
/** A log past this size is moved to `<name>.1` at the start of a tick. */
export const LOG_ROTATE_BYTES = 1024 * 1024;
/** An unreadable lock, or one whose holder pid is gone, is broken after this. */
export const LOCK_STALE_MS = 15 * 60 * 1000;
/** A live holder that has not heart-beaten for this long is presumed hung. */
export const LOCK_HARD_STALE_MS = 3 * 60 * 60 * 1000;

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

/**
 * Keep what the queue sweep dropped. No human judged these, so unlike
 * rejections they are never fed to the curator; they are kept whole (newest
 * first, capped) so a wrongly swept item can be copied back into the queue.
 * Written before the swept queue is saved: an item is never in neither file.
 */
export function recordSwept(dropped) {
  if (!dropped?.length) return;
  const at = new Date().toISOString();
  const added = dropped.map((d) => ({ ...d.item, swept_at: at, swept_reason: d.reason }));
  writeJsonAtomic(SWEPT_PATH, [...added, ...readJson(SWEPT_PATH, [])].slice(0, MAX_SWEPT));
}

/**
 * Record demotions before they are applied (newest first, capped). A crash
 * between the record and the update leaves a record of a demotion that may
 * not have happened; re-applying is idempotent and `from` restores either way.
 */
export function recordDemotions(entries) {
  if (!entries?.length) return;
  writeJsonAtomic(DEMOTED_PATH, [...entries, ...readJson(DEMOTED_PATH, [])].slice(0, MAX_DEMOTED));
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
 * Cross-process lock over the review queue and the watermarks. Every writer of
 * watchdog-review.json takes it — tick, consolidate and apply-review — and
 * reads the queue only after acquiring it, so a verdict can never be undone by
 * a tick that loaded the queue earlier and saved it later.
 *
 * Staleness is judged by the holder, not by age alone. A tick can legitimately
 * hold the lock for well over 15 minutes (four curator calls at a 600s timeout,
 * plus consolidation batches), and the old age-only rule let another process
 * break a live lock. Now a lock is broken only when its holder pid is gone,
 * when it cannot be parsed and is older than LOCK_STALE_MS, or when a live
 * holder has not called refreshLock() for LOCK_HARD_STALE_MS (hung).
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM"; // exists, owned by someone else
  }
}

/** The current holder, or null when the lock is free. */
export function lockHolder() {
  let raw;
  try {
    raw = readFileSync(LOCK_PATH, "utf8");
  } catch {
    return null;
  }
  let held = null;
  try {
    held = JSON.parse(raw);
  } catch {}
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(LOCK_PATH).mtimeMs;
  } catch {}
  const pid = Number.isInteger(held?.pid) ? held.pid : null;
  return { raw, pid, at: Number(held?.at) || mtimeMs, alive: pid !== null && pidAlive(pid) };
}

function isStale(holder, now = Date.now()) {
  if (holder.pid === null) return now - holder.at > LOCK_STALE_MS;
  if (!holder.alive) return true;
  return now - holder.at > LOCK_HARD_STALE_MS;
}

/**
 * Move a stale lock aside, then confirm what moved is the lock judged stale.
 * If another process replaced it in between, that lock is live: put it back.
 */
function breakStaleLock(holder) {
  const aside = `${LOCK_PATH}.stale-${process.pid}`;
  try {
    renameSync(LOCK_PATH, aside);
  } catch {
    return false;
  }
  let moved = null;
  try {
    moved = readFileSync(aside, "utf8");
  } catch {}
  if (moved !== holder.raw) {
    try {
      renameSync(aside, LOCK_PATH);
    } catch {}
    return false;
  }
  try {
    unlinkSync(aside);
  } catch {}
  log(
    `lock: broke stale lock of pid ${holder.pid ?? "?"} (last heartbeat ` +
      `${new Date(holder.at).toISOString()}, ${holder.alive ? "alive but silent" : "holder gone"})`
  );
  return true;
}

export function acquireLock() {
  const mine = () => JSON.stringify({ pid: process.pid, at: Date.now() });
  try {
    writeFileSync(LOCK_PATH, mine(), { flag: "wx" });
    return true;
  } catch {}
  const holder = lockHolder();
  if (holder && (!isStale(holder) || !breakStaleLock(holder))) return false;
  try {
    writeFileSync(LOCK_PATH, mine(), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** acquireLock(), retried until `waitMs` has passed. For human-run commands. */
export async function acquireLockWait(waitMs = 120_000, pollMs = 1_000) {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    if (acquireLock()) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, left)));
  }
}

/** Heartbeat: a long run calls this between model calls so it never looks hung. */
export function refreshLock() {
  const holder = lockHolder();
  if (!holder || holder.pid !== process.pid) return false;
  try {
    writeJsonAtomic(LOCK_PATH, { pid: process.pid, at: Date.now() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Move a log past LOG_ROTATE_BYTES to `<name>.1`, replacing the previous one,
 * so each log keeps at most about twice the threshold. Call under the lock at
 * the start of a tick: launchd reopens StandardOutPath for every run, so the
 * run in progress keeps writing to the renamed file and the next one starts
 * fresh. The log line written afterwards keeps the harness pulse canary, which
 * reads the last line of watchdog.log, pointing at a current timestamp.
 */
export function rotateLogs(paths = [LOG_PATH, LAUNCHD_LOG_PATH], maxBytes = LOG_ROTATE_BYTES) {
  const rotated = [];
  for (const p of paths) {
    try {
      const size = statSync(p).size;
      if (size <= maxBytes) continue;
      renameSync(p, `${p}.1`);
      rotated.push(`${basename(p)} (${(size / 1048576).toFixed(1)} MB)`);
    } catch {
      /* absent or unreadable: nothing to rotate */
    }
  }
  if (rotated.length) log(`rotated ${rotated.join(", ")} to .1`);
  return rotated;
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
