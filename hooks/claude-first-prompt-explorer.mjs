#!/usr/bin/env node
/**
 * claude-first-prompt-explorer.mjs — UserPromptSubmit hook for Claude Code and
 * codex (both register this same file).
 *
 * On the FIRST substantive prompt of a session it gathers candidate memories
 * from the shared pi memory palace with a fixed set of probes run in parallel
 * — semantic search over the whole palace and over the session's project,
 * lessons, recent project memories, and knowledge-graph facts for entities the
 * prompt names — then asks Haiku once, with no tools, to keep only what would
 * change how the main agent approaches the prompt. The result goes to stdout,
 * which the host injects into the session's context. The project's
 * `session-resume` hand-off is fetched deterministically alongside and injected
 * whole.
 *
 * Degrades honestly: if the claude CLI is missing, times out, or fails, the
 * hook prints the top probe results verbatim instead, so first-prompt recall
 * never silently disappears. Any unexpected error exits 0 with no output —
 * memory must never block the session.
 *
 * Guards:
 *   - MEMPALACE_EXPLORER=1 in env  -> exit (we ARE the nested call)
 *   - marker file per session_id   -> exit (only the first prompt explores)
 *   - prompt < 30 chars or /slash  -> no exploration (the hand-off still runs)
 *
 * Register under hooks.UserPromptSubmit with a timeout >= 60.
 *
 * Latency. 2026-09-23 (audit D6): the agentic nested run (an 8-turn Bash tool
 * loop over the CLI) took a median 38s; isolating it brought that to ~20s.
 * 2026-10-02: it had drifted back to 31.3s on the audit prompt, and nearly all
 * of that was the tool loop — each palace command takes 0.1–0.7s. The probes
 * now run here, in parallel, and the model only distils, in one turn.
 *
 * Status fidelity (2026-10-02). The old prompt asked for "the distilled
 * fact/decision" and the model rewrote fixed incidents as open to-dos ("check
 * if this persists"). Each bullet must now keep its memory's status, and advice
 * the memory does not contain is forbidden.
 *
 * Project. basename(cwd) missed worktrees, subdirectories and checkouts whose
 * folder name differs from the repo (36 of 106 Claude sessions matched no
 * palace project). The project is now the first of git toplevel, main
 * worktree, origin repo name and cwd basename that names a palace project.
 * Every run appends one JSON line to explorer.log (agent, project, ms, mode).
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const FORK = join(homedir(), ".pi", "agent", "pi-mempalace-fork");
const CLI = join(FORK, "cli", "mempalace.mjs");
const MEM_HOME = process.env.MEMPALACE_HOME || join(homedir(), ".pi", "agent", "memory");
const DB = join(MEM_HOME, "memories.db");
const LOG = join(MEM_HOME, "explorer.log");
const LOG_MAX_BYTES = 512 * 1024;
const PROBE_TIMEOUT_MS = 20_000;
const DISTILL_TIMEOUT_MS = 30_000;
/** No extended thinking: the turn only picks ids from ~20 short records.
 *  Measured 2026-10-02 on the audit prompt: 1,024 thinking tokens plus written
 *  bullets took 20.6s end to end; without thinking, 10.5s; selecting ids
 *  instead of writing bullets removes most of the rest. */
const DISTILL_THINKING_TOKENS = 0;
const MAX_CONTEXT_CHARS = 3000;
const CANDIDATE_TEXT_CHARS = 700;
const SYSTEM_PROMPT =
  "You distil recalled memories for a coding agent. You have no tools. " +
  "Answer exactly in the format the user message asks for.";

function out(text) {
  if (text && text.trim()) process.stdout.write(text.trim() + "\n");
  process.exit(0);
}

function logRun(fields) {
  try {
    if (existsSync(LOG) && statSync(LOG).size > LOG_MAX_BYTES) renameSync(LOG, LOG + ".1");
    appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...fields }) + "\n");
  } catch {
    /* the log is diagnostics only */
  }
}

/** spawn, collect stdout, never reject. status is null on spawn error or timeout. */
function run(cmd, args, { input = "", timeoutMs, env, cwd } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout });
    };
    let child;
    try {
      child = spawn(cmd, args, { env, cwd, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve({ status: null, stdout: "" });
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function palace(args) {
  const res = await run("node", [CLI, ...args, "--json"], {
    timeoutMs: PROBE_TIMEOUT_MS,
    env: { ...process.env, MEMPALACE_EXPLORER: "1" },
  });
  if (res.status !== 0) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

function git(cwd, args) {
  const res = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 2000 });
  return res.status === 0 ? (res.stdout || "").trim() : "";
}

/** Candidate project names for a working directory, most specific first. */
function projectCandidates(cwd) {
  const names = [];
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top) {
    names.push(basename(top));
    // In a linked worktree the common dir is the main checkout's .git.
    const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common && basename(common) === ".git") names.push(basename(dirname(common)));
    const url = git(cwd, ["remote", "get-url", "origin"]);
    const m = url.match(/([^/:]+?)(?:\.git)?\/?$/);
    if (m) names.push(m[1]);
  }
  names.push(basename(cwd));
  return [...new Set(names.filter(Boolean))];
}

function resolveProject(cwd, projectNames) {
  const byLower = new Map(projectNames.map((p) => [p.toLowerCase(), p]));
  for (const name of projectCandidates(cwd)) {
    const hit = byLower.get(name.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** Up to three entities worth a knowledge-graph lookup: palace projects the
 *  prompt names, then identifier-shaped tokens (kebab, snake, dotted, camel). */
function entityCandidates(prompt, projectNames, project) {
  const byLower = new Map(projectNames.map((p) => [p.toLowerCase(), p]));
  const found = new Set();
  for (const raw of prompt.split(/[\s,;:()"'`<>[\]{}]+/)) {
    const word = raw.replace(/[.!?]+$/, "");
    if (word.length < 3 || word.length > 60 || word.includes("/")) continue;
    const named = byLower.get(word.toLowerCase());
    if (named && named !== project) found.add(named);
    else if (/[a-z]/i.test(word) && (/[-_.]/.test(word) || /[a-z][A-Z]/.test(word))) found.add(word);
    if (found.size >= 3) break;
  }
  return [...found];
}

const family = (id) => String(id).replace(/_c\d+$/, "");
const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();

/** Cut at the last sentence end before max when one falls past 60% of it. */
function clip(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("; "));
  return (end > max * 0.6 ? head.slice(0, end + 1) : head.trimEnd()) + " …";
}

/** Dedupe across probes by memory family, first occurrence wins. The project's
 *  session-resume is injected whole by resumeBlock, so it is not a candidate. */
function candidates(sections) {
  const seen = new Set();
  const picked = [];
  for (const [title, results] of sections) {
    const rows = [];
    for (const m of results || []) {
      const id = family(m.id);
      if (seen.has(id) || m.topic === "session-resume" || !squash(m.text)) continue;
      seen.add(id);
      rows.push(m);
    }
    if (rows.length) picked.push([title, rows]);
  }
  return picked;
}

function renderCandidates(picked) {
  return picked
    .map(
      ([title, rows]) =>
        `## ${title}\n\n` +
        rows
          .map(
            (m) =>
              `[${family(m.id)}] ${m.project}/${m.topic} · saved ${String(m.timestamp).slice(0, 10)} · importance ${m.importance}\n` +
              squash(m.text).slice(0, CANDIDATE_TEXT_CHARS)
          )
          .join("\n\n")
    )
    .join("\n\n");
}

/** Active facts as [k1] … lines, so the model can pick them by id too. */
function kgFacts(results) {
  const facts = [];
  for (const r of results || []) {
    for (const f of (r?.facts || []).filter((f) => !f.valid_to).slice(0, 8)) {
      facts.push(`${f.subject} ${f.predicate} ${f.object}${f.valid_from ? ` (since ${f.valid_from})` : ""} [${f.project}]`);
    }
  }
  return [...new Set(facts)].map((text, i) => ({ id: `k${i + 1}`, text }));
}

function buildDistillPrompt(prompt, project, memoriesText, facts) {
  const today = new Date().toISOString().slice(0, 10);
  const kgText = facts.map((f) => `[${f.id}] ${f.text}`).join("\n");
  return `Today is ${today}. A coding agent${project ? ` working in project "${project}"` : ""} has just received this first message:

<user-prompt>
${prompt.slice(0, 2000)}
</user-prompt>

Below are candidate memories recalled from a memory palace that pi, Claude Code, codex and other agents share. Each starts with [id] project/topic, the date it was saved and its importance. A memory is a snapshot from the day it was saved.

<memories>
${memoriesText}
</memories>
${kgText ? `\n<knowledge-graph>\n${kgText}\n</knowledge-graph>\n` : ""}
Pick the memories that would change how the agent approaches this message.

- Prefer decisions, conventions, fixes and standing facts over old problem reports.
- When two memories cover the same thing, pick only the newer one. Skip a problem report when a newer memory says it was fixed, and skip one that is weeks old unless the message is about that exact problem.
- Skip near-misses, duplicates and other projects' noise. Pick a knowledge-graph fact only when it says something no picked memory says.

Output only the ids you pick, most useful first, one per line, at most 6 — for example mem_0123456789abcdef or k2. No other text. If nothing qualifies, output exactly: NONE`;
}

async function distil(prompt, project, picked, facts) {
  const res = await run(
    "claude",
    [
      "-p",
      "--model", "claude-haiku-4-5",
      // Never persisted: these transcripts are noise in ~/.claude/projects,
      // and the session-watchdog reads that directory.
      "--no-session-persistence",
      // No MCP servers, hooks, plugins or user settings.
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--setting-sources", "",
      // One turn, no tools: everything it needs is in the prompt.
      "--tools", "",
      "--disable-slash-commands",
      "--system-prompt", SYSTEM_PROMPT,
      "--max-turns", "1",
    ],
    {
      input: buildDistillPrompt(prompt, project, renderCandidates(picked), facts),
      timeoutMs: DISTILL_TIMEOUT_MS,
      env: {
        ...process.env,
        MEMPALACE_EXPLORER: "1",
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        MAX_THINKING_TOKENS: String(DISTILL_THINKING_TOKENS),
      },
      cwd: tmpdir(),
    }
  );
  if (res.status !== 0) return null;
  const text = res.stdout.trim();
  if (!text) return null;
  if (/^NONE\b/.test(text)) return [];
  // Only ids that were offered: a hallucinated id selects nothing.
  const offered = new Set([...picked.flatMap(([, rows]) => rows.map((m) => family(m.id))), ...facts.map((f) => f.id)]);
  const ids = [...new Set(text.match(/\b(mem_[0-9a-f]+|k\d+)\b/g) || [])].filter((id) => offered.has(family(id)));
  return ids.length ? ids.slice(0, 6) : null;
}

/** The chosen memories, verbatim. The model only selects: a paraphrase is
 *  where a fixed incident turned into an open to-do and a dated snapshot lost
 *  its date, so the text the agent reads is the text that was saved. */
function render(ids, picked, facts) {
  const byId = new Map();
  for (const [, rows] of picked) for (const m of rows) byId.set(family(m.id), m);
  const factById = new Map(facts.map((f) => [f.id, f]));
  const bullets = [];
  for (const id of ids) {
    const m = byId.get(family(id));
    if (m) bullets.push(`- ${clip(squash(m.text), 460)} [${m.project}/${m.topic}, saved ${String(m.timestamp).slice(0, 10)}]`);
    else if (factById.has(id)) bullets.push(`- Knowledge graph: ${factById.get(id).text}`);
  }
  let text = "";
  for (const b of bullets) {
    if ((text + "\n" + b).length > MAX_CONTEXT_CHARS) break;
    text += (text ? "\n" : "") + b;
  }
  return text;
}

/** Without the model: the top probe results, in probe order. */
function fallbackIds(picked) {
  return picked.flatMap(([, rows]) => rows.map((m) => family(m.id))).slice(0, 5);
}

/**
 * The project's `session-resume` hand-off, injected whole.
 *
 * Never routed through the distiller: it keeps only what is relevant to *this*
 * prompt, and "where we left off" is relevant to the session rather than the
 * message. It is also the context most needed by the prompts this hook
 * otherwise ignores — "continue" is 8 characters, under the exploration floor.
 * JSON, not the human output: `recall` flattens newlines and truncates to 280
 * chars, which decapitates a hand-off at the Next/Where/Blockers lines.
 */
function resumeBlock(project, recall) {
  const entry = recall?.results?.[0];
  if (!entry?.text?.trim()) return "";
  return (
    `**Where we left off in \`${project}\`** (last recorded hand-off, saved ` +
    `${String(entry.timestamp).slice(0, 10)} — not live state; check ` +
    `\`git status\`/\`git log\` before acting on it):\n\n${entry.text.trim()}`
  );
}

async function main() {
  if (process.env.MEMPALACE_EXPLORER === "1") return out("");
  if (!existsSync(DB) || !existsSync(CLI)) return out("");

  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return out("");
  }
  const started = Date.now();
  const agent = input.turn_id ? "codex" : "claude";
  const prompt = (input.prompt || "").trim();
  const sessionId = input.session_id || "unknown";
  const cwd = input.cwd || process.cwd();

  // Two independent once-per-session markers. The resume hand-off is emitted
  // on the first prompt of any length; exploration waits for a substantive
  // one, so a session opening with "continue" gets the hand-off now and full
  // exploration on the next real request.
  const exploredMarker = join(tmpdir(), `mempalace-explored-${sessionId}`);
  const resumeMarker = join(tmpdir(), `mempalace-resume-${sessionId}`);
  const wantResume = !existsSync(resumeMarker);
  const explore = prompt.length >= 30 && !prompt.startsWith("/") && !existsSync(exploredMarker);
  if (!wantResume && !explore) return out("");
  if (explore) {
    try {
      writeFileSync(exploredMarker, new Date().toISOString());
    } catch {
      /* best-effort; a duplicate exploration is annoying, not fatal */
    }
  }

  const projectNames = Object.keys((await palace(["projects"]))?.projects || {});
  const project = resolveProject(cwd, projectNames);
  const query = prompt.slice(0, 500).replace(/^-+/, "");
  const entities = explore ? entityCandidates(prompt, projectNames, project) : [];

  const [resume, scoped, global, lessons, recent, kg] = await Promise.all([
    wantResume && project ? palace(["recall", "--project", project, "--topic", "session-resume", "-n", "1"]) : null,
    explore && project ? palace(["search", query, "--project", project, "-n", "6"]) : null,
    explore ? palace(["search", query, "-n", "8"]) : null,
    explore ? palace(["search", query, "--topic", "lessons", "-n", "4"]) : null,
    explore && project ? palace(["recall", "--project", project, "-n", "6"]) : null,
    Promise.all(entities.map((e) => palace(["kg-query", e]))),
  ]);

  const sections = [];
  let resumed = false;
  if (wantResume && project) {
    const block = resumeBlock(project, resume);
    if (block) {
      sections.push(block);
      resumed = true;
      // Marked only on success: a cold first run can spend the probe budget
      // loading the embedding model and come back empty. A duplicate
      // injection is the cheaper failure.
      try {
        writeFileSync(resumeMarker, new Date().toISOString());
      } catch {}
    }
  }

  let mode = "none";
  let count = 0;
  if (explore) {
    const picked = candidates([
      [project ? `Search within ${project}` : "Search", scoped?.results],
      ["Search across all projects", global?.results],
      ["Lessons", lessons?.results],
      [project ? `Recent in ${project}` : "Recent", recent?.results],
    ]);
    count = picked.reduce((n, [, rows]) => n + rows.length, 0);
    const facts = kgFacts(kg);
    if (count || facts.length) {
      let ids = await distil(prompt, project, picked, facts);
      mode = "distilled";
      if (ids === null) {
        ids = fallbackIds(picked);
        mode = "fallback";
      }
      const context = render(ids, picked, facts);
      if (context) sections.push(context);
    }
  }

  logRun({ agent, project, cwd, ms: Date.now() - started, candidates: count, entities: entities.length, mode, resumed, chars: sections.join("").length });
  if (!sections.length) return out("");

  out(
    `<memory-palace-context>\n` +
      `Context recalled from the shared memory palace (pi/Claude Code/opencode/codex sessions). ` +
      `It reflects what was true when saved — verify against current code/config before relying on it. ` +
      `For deeper or differently-angled context: node ${CLI} search "..."\n\n` +
      sections.join("\n\n---\n\n") +
      `\n</memory-palace-context>`
  );
}

main().catch(() => process.exit(0));
