/**
 * collectors.mjs — read new dialogue text from each agent's session store.
 *
 * Every collector returns candidates of the same shape:
 *   {
 *     source:   "claude" | "pi" | "codex" | "opencode",
 *     key:      stable watermark key (abs file path, or opencode session id),
 *     project:  best-effort project name (cwd basename),
 *     cwd:      absolute cwd if known,
 *     text:     newly-extracted user+assistant dialogue since the watermark
 *               (tool calls/results and meta entries excluded — the gate
 *               measures signal, not noise),
 *     newBytes: bytes/rows advanced past the watermark when this candidate
 *               is committed,
 *     lastActivityMs: last write time of the underlying source,
 *     commit(state):  advance the watermark in `state` (call ONLY after the
 *                     candidate has actually been summarized).
 *   }
 *
 * Watermark discipline: jsonl sources track a byte offset per file and only
 * ever parse complete lines (a partial trailing line stays unconsumed);
 * opencode tracks message.time_created per session in the sqlite store.
 */

import { statSync, openSync, readSync, closeSync, globSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";

const HOME = homedir();
const MAX_TEXT = 80_000; // per-candidate cap fed to the summarizer

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function truncateMiddle(text, max = MAX_TEXT) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return (
    text.slice(0, head) +
    `\n\n[... ${text.length - max} chars of transcript omitted ...]\n\n` +
    text.slice(-tail)
  );
}

/** Read complete lines of a file from a byte offset; returns { lines, consumed }. */
function readNewLines(path, fromBytes) {
  const size = statSync(path).size;
  if (size <= fromBytes) return { lines: [], consumed: 0 };
  const fd = openSync(path, "r");
  let buf;
  try {
    buf = Buffer.alloc(size - fromBytes);
    readSync(fd, buf, 0, buf.length, fromBytes);
  } finally {
    closeSync(fd);
  }
  const chunk = buf.toString("utf8");
  const lastNl = chunk.lastIndexOf("\n");
  if (lastNl === -1) return { lines: [], consumed: 0 }; // partial line only
  const complete = chunk.slice(0, lastNl);
  return {
    lines: complete.split("\n").filter((l) => l.trim()),
    consumed: Buffer.byteLength(complete, "utf8") + 1,
  };
}

function blocksToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function jsonlCandidate({ source, path, state, extract, project, cwd, mtimeMs }) {
  const prior = state.files[path]?.bytes ?? null;
  if (prior === null) return null; // unseeded — seeding handles it
  const { lines, consumed } = readNewLines(path, prior);
  if (consumed === 0) return null;
  const parts = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const t = extract(entry);
    if (t) parts.push(t);
  }
  const text = parts.join("\n\n").trim();
  return {
    source,
    key: path,
    project,
    cwd,
    text: truncateMiddle(text),
    rawTextLength: text.length,
    newBytes: consumed,
    lastActivityMs: mtimeMs,
    commit(st) {
      st.files[path] = { bytes: prior + consumed, at: new Date().toISOString() };
    },
    skipCommit(st) {
      // Nothing extractable in the delta (pure tool noise): advance the
      // watermark anyway so we never re-parse the same noise every tick.
      st.files[path] = { bytes: prior + consumed, at: new Date().toISOString() };
    },
  };
}

function projectFromCwd(cwd) {
  return cwd ? basename(cwd) : "general";
}

// ---------------------------------------------------------------------------
// Claude Code — ~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl
// ---------------------------------------------------------------------------

function extractClaude(entry) {
  if (entry.isSidechain) return "";
  if (entry.type !== "user" && entry.type !== "assistant") return "";
  const msg = entry.message;
  if (!msg || !msg.role) return "";
  const text = blocksToText(msg.content);
  if (!text.trim()) return "";
  // Skip harness noise: tool results wrapped as user messages, reminders.
  if (text.startsWith("<system-reminder>") || text.startsWith("<local-command")) return "";
  return `${msg.role.toUpperCase()}: ${text}`;
}

function claudeCwd(path) {
  try {
    const { lines } = readNewLines(path, 0);
    for (const line of lines.slice(0, 25)) {
      try {
        const e = JSON.parse(line);
        if (e.cwd) return e.cwd;
      } catch {}
    }
  } catch {}
  return null;
}

export function collectClaude(state, activeWithinMs) {
  const files = globSync(join(HOME, ".claude", "projects", "*", "*.jsonl"));
  const out = [];
  for (const f of files) {
    const st = statSync(f);
    if (Date.now() - st.mtimeMs > activeWithinMs) continue;
    const cwd = claudeCwd(f);
    const cand = jsonlCandidate({
      source: "claude",
      path: f,
      state,
      extract: extractClaude,
      project: projectFromCwd(cwd),
      cwd,
      mtimeMs: st.mtimeMs,
    });
    if (cand) out.push(cand);
  }
  return out;
}

// ---------------------------------------------------------------------------
// pi — ~/.pi/agent/sessions/<sanitized-cwd>/<ts>_<id>.jsonl
// ---------------------------------------------------------------------------

function extractPi(entry) {
  if (entry.type !== "message") return "";
  const msg = entry.message;
  if (!msg || (msg.role !== "user" && msg.role !== "assistant")) return "";
  const text = blocksToText(msg.content);
  if (!text.trim()) return "";
  return `${msg.role.toUpperCase()}: ${text}`;
}

function piCwd(path) {
  try {
    const { lines } = readNewLines(path, 0);
    for (const line of lines.slice(0, 5)) {
      try {
        const e = JSON.parse(line);
        if (e.type === "session" && e.cwd) return e.cwd;
      } catch {}
    }
  } catch {}
  return null;
}

export function collectPi(state, activeWithinMs) {
  const files = globSync(join(HOME, ".pi", "agent", "sessions", "*", "*.jsonl"));
  const out = [];
  for (const f of files) {
    const st = statSync(f);
    if (Date.now() - st.mtimeMs > activeWithinMs) continue;
    const cwd = piCwd(f);
    const cand = jsonlCandidate({
      source: "pi",
      path: f,
      state,
      extract: extractPi,
      project: projectFromCwd(cwd),
      cwd,
      mtimeMs: st.mtimeMs,
    });
    if (cand) out.push(cand);
  }
  return out;
}

// ---------------------------------------------------------------------------
// codex — ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// ---------------------------------------------------------------------------

function extractCodex(entry) {
  if (entry.type !== "event_msg") return "";
  const p = entry.payload || {};
  if (p.type === "user_message" && typeof p.message === "string") {
    const m = p.message.trim();
    // codex wraps environment_context / instructions as user messages too
    if (!m || m.startsWith("<environment_context>") || m.startsWith("<user_instructions>")) return "";
    return `USER: ${m}`;
  }
  if (p.type === "agent_message" && typeof p.message === "string" && p.message.trim()) {
    return `ASSISTANT: ${p.message}`;
  }
  return "";
}

function codexCwd(path) {
  try {
    const { lines } = readNewLines(path, 0);
    for (const line of lines.slice(0, 5)) {
      try {
        const e = JSON.parse(line);
        if (e.type === "session_meta" && e.payload?.cwd) return e.payload.cwd;
      } catch {}
    }
  } catch {}
  return null;
}

export function collectCodex(state, activeWithinMs) {
  const files = globSync(join(HOME, ".codex", "sessions", "*", "*", "*", "rollout-*.jsonl"));
  const out = [];
  for (const f of files) {
    const st = statSync(f);
    if (Date.now() - st.mtimeMs > activeWithinMs) continue;
    const cwd = codexCwd(f);
    const cand = jsonlCandidate({
      source: "codex",
      path: f,
      state,
      extract: extractCodex,
      project: projectFromCwd(cwd),
      cwd,
      mtimeMs: st.mtimeMs,
    });
    if (cand) out.push(cand);
  }
  return out;
}

// ---------------------------------------------------------------------------
// opencode — SQLite at ~/.local/share/opencode/opencode.db
// ---------------------------------------------------------------------------

const OPENCODE_DB = join(HOME, ".local", "share", "opencode", "opencode.db");

export function collectOpencode(state, activeWithinMs) {
  let Database;
  try {
    const require = createRequire(import.meta.url);
    Database = require("better-sqlite3");
  } catch {
    return [];
  }
  let db;
  try {
    db = new Database(OPENCODE_DB, { readonly: true, fileMustExist: true });
  } catch {
    return [];
  }
  const out = [];
  try {
    const cutoff = Date.now() - activeWithinMs;
    const sessions = db
      .prepare(
        `SELECT s.id, s.directory, s.title, MAX(m.time_created) AS last_ts
         FROM session s JOIN message m ON m.session_id = s.id
         GROUP BY s.id HAVING last_ts > ?`
      )
      .all(cutoff);

    for (const s of sessions) {
      const prior = state.opencode[s.id]?.lastTime ?? null;
      if (prior === null) continue; // unseeded
      const rows = db
        .prepare(
          `SELECT m.time_created AS ts, json_extract(m.data,'$.role') AS role,
                  group_concat(json_extract(p.data,'$.text'), char(10)) AS text
           FROM message m JOIN part p ON p.message_id = m.id
           WHERE m.session_id = ? AND m.time_created > ?
             AND json_extract(p.data,'$.type') = 'text'
           GROUP BY m.id ORDER BY m.time_created`
        )
        .all(s.id, prior);
      if (rows.length === 0) continue;
      const text = rows
        .filter((r) => r.role === "user" || r.role === "assistant")
        .map((r) => `${String(r.role).toUpperCase()}: ${r.text || ""}`)
        .filter((t) => t.length > 12)
        .join("\n\n")
        .trim();
      const maxTs = rows[rows.length - 1].ts;
      out.push({
        source: "opencode",
        key: s.id,
        project: projectFromCwd(s.directory),
        cwd: s.directory,
        text: truncateMiddle(text),
        rawTextLength: text.length,
        newBytes: rows.length,
        lastActivityMs: s.last_ts,
        commit(st) {
          st.opencode[s.id] = { lastTime: maxTs, at: new Date().toISOString() };
        },
        skipCommit(st) {
          st.opencode[s.id] = { lastTime: maxTs, at: new Date().toISOString() };
        },
      });
    }
  } finally {
    db.close();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Seeding — first run (or newly-appeared files) start at "now", never backfill
// ---------------------------------------------------------------------------

export function seedNewSources(state, backfillMs = 0) {
  // Initial seed: start everything at EOF (minus optional backfill horizon)
  // so the first run never bills months of history. Later runs: a file we've
  // never seen IS a new session — start it at 0 so its early turns count.
  const initial = !state.seeded_at;
  const seedFrom = initial ? Date.now() - backfillMs : 0;
  const jsonlGlobs = [
    join(HOME, ".claude", "projects", "*", "*.jsonl"),
    join(HOME, ".pi", "agent", "sessions", "*", "*.jsonl"),
    join(HOME, ".codex", "sessions", "*", "*", "*", "rollout-*.jsonl"),
  ];
  let seeded = 0;
  for (const g of jsonlGlobs) {
    for (const f of globSync(g)) {
      if (state.files[f]) continue;
      let size = 0;
      try {
        const st = statSync(f);
        // Initial seed: files last touched before the horizon start at EOF
        // (skipped); newer ones start at 0. Post-initial: always 0.
        size = initial && st.mtimeMs < seedFrom ? st.size : 0;
      } catch {
        continue;
      }
      state.files[f] = { bytes: size, at: new Date().toISOString() };
      seeded++;
    }
  }
  // opencode sessions
  try {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    const db = new Database(OPENCODE_DB, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare(`SELECT s.id, MAX(m.time_created) AS last_ts FROM session s JOIN message m ON m.session_id = s.id GROUP BY s.id`)
        .all();
      for (const r of rows) {
        if (state.opencode[r.id]) continue;
        state.opencode[r.id] = {
          lastTime: initial ? Math.min(r.last_ts, seedFrom - 1) : 0,
          at: new Date().toISOString(),
        };
        seeded++;
      }
    } finally {
      db.close();
    }
  } catch {
    /* opencode absent — fine */
  }
  if (!state.seeded_at) state.seeded_at = new Date().toISOString();
  return seeded;
}

/**
 * Sessions run from temp directories are our own machinery — the watchdog's
 * codex-exec terra calls and Claude Code's first-prompt explorer subagent
 * both run with cwd=tmpdir. Summarizing them would make the watchdog eat its
 * own output in a loop. Their watermarks still advance via the zero-dialogue
 * noise path or stay parked; they never reach the summarizer.
 */
function isTempCwd(cwd) {
  if (!cwd) return false;
  return (
    cwd.startsWith("/tmp/") ||
    cwd === "/tmp" ||
    cwd.includes("/var/folders/") ||
    cwd.startsWith(tmpdir())
  );
}

export function collectAll(state, activeWithinMs) {
  return [
    ...collectClaude(state, activeWithinMs),
    ...collectPi(state, activeWithinMs),
    ...collectCodex(state, activeWithinMs),
    ...collectOpencode(state, activeWithinMs),
  ].filter((c) => {
    if (!isTempCwd(c.cwd)) return true;
    c.skipCommit(state); // park the watermark so it never re-parses
    return false;
  });
}
