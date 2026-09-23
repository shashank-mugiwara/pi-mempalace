#!/usr/bin/env node
/**
 * claude-first-prompt-explorer.mjs — Claude Code UserPromptSubmit hook.
 *
 * On the FIRST substantive prompt of a Claude Code session, spawns a cheap
 * headless subagent (claude -p, Haiku) that explores the shared pi memory
 * palace AGENTICALLY — taxonomy first, then multiple search phrasings, KG
 * lookups on entities it finds, project recall — and distills only the
 * genuinely relevant context into a block this hook prints to stdout, which
 * Claude Code injects into the session's context. This replaces one-shot
 * "blind" semantic search over the raw prompt.
 *
 * Degrades honestly: if the claude CLI is missing, times out, or fails, the
 * hook falls back to a deterministic multi-probe (semantic search + recent
 * same-project memories) so first-prompt recall never silently disappears.
 * Any unexpected error exits 0 with no output — memory must never block the
 * session.
 *
 * Guards:
 *   - MEMPALACE_EXPLORER=1 in env  -> exit (we ARE the nested subagent)
 *   - marker file per session_id   -> exit (only the first prompt explores)
 *   - prompt < 30 chars or /slash  -> exit (nothing to explore)
 *
 * Register in ~/.claude/settings.json under hooks.UserPromptSubmit with a
 * timeout >= 90 (the subagent is capped at 60s internally).
 *
 * Latency (2026-09-23 audit D6): the nested run took a median 38s (max 54s)
 * on the first prompt of every session. It loaded every hook, plugin and MCP
 * server, the full coding-agent system prompt and CLAUDE.md/rules, thought
 * with Claude Code's default Haiku budget (63,999 tokens) on every turn, and
 * persisted a transcript (145 junk sessions under ~/.claude/projects/
 * -private-var-folders-…). The spawn below is now isolated and bounded; see
 * runSubagent for each flag.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

const FORK = join(homedir(), ".pi", "agent", "pi-mempalace-fork");
const CLI = join(FORK, "cli", "mempalace.mjs");
const DB = join(
  process.env.MEMPALACE_HOME || join(homedir(), ".pi", "agent", "memory"),
  "memories.db"
);
const SUBAGENT_TIMEOUT_MS = 60_000;
const SUBAGENT_MAX_TURNS = 8;
/** Extended-thinking budget per turn. Claude Code's Haiku default is 63,999;
 *  the explorer's judgment is "which of these memories matter", not proofs. */
const SUBAGENT_THINKING_TOKENS = 2048;
const SUBAGENT_SYSTEM_PROMPT =
  "You are a memory-recall subagent. Use the Bash tool only to run the memory-palace CLI " +
  "commands named in the user message, then answer exactly in the format it asks for.";
const MAX_CONTEXT_CHARS = 2400;

function out(text) {
  if (text && text.trim()) process.stdout.write(text.trim() + "\n");
  process.exit(0);
}

function mempalace(args, timeoutMs = 20_000) {
  const res = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, MEMPALACE_EXPLORER: "1" },
  });
  return res.status === 0 ? (res.stdout || "").trim() : "";
}

function buildSubagentPrompt(prompt, project) {
  return `You are a memory-recall subagent for a coding session in project "${project}".
The user's first message to the main agent is:

<user-prompt>
${prompt.slice(0, 2000)}
</user-prompt>

A shared cross-agent memory palace (SQLite, past sessions of pi/Claude Code/opencode/codex) is available via:
  node ${CLI} <command>

Explore it and return ONLY context genuinely relevant to this message. Method — explore, don't one-shot. You have at most ${SUBAGENT_MAX_TURNS} turns, so chain independent commands in ONE Bash call with \`;\` (e.g. projects plus two searches):
1. \`projects\` — see which projects/counts exist; note ones related to "${project}" or to entities in the prompt.
2. \`search "<query>" -n 6\` — run 2-3 searches with DIFFERENT phrasings/angles of the user's intent (natural language, not keywords). Try both with and without \`--project ${project}\`.
3. \`kg-query "<entity>"\` for concrete entities (services, tools, projects) named in the prompt or surfaced by search.
4. \`recall --project ${project} -n 8\` — recent memories for this project.

Then output your findings as a markdown block:
- ONLY memories/facts that would change how the main agent approaches THIS request. Ruthlessly drop near-misses, stale duplicates, and cross-project noise.
- Each bullet: the distilled fact/decision, then \`[project/topic, YYYY-MM-DD]\`.
- Max ${MAX_CONTEXT_CHARS} characters total. No preamble, no commentary about your process.
- If NOTHING is genuinely relevant, output exactly: NO_RELEVANT_MEMORY`;
}

function runSubagent(prompt, project) {
  const res = spawnSync(
    "claude",
    [
      "-p",
      "--model", "claude-haiku-4-5",
      // Never persisted: these transcripts are noise in ~/.claude/projects,
      // and the session-watchdog reads that directory.
      "--no-session-persistence",
      // No MCP servers, hooks, plugins or user settings (startup 7.1s → 2.9s).
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--setting-sources", "",
      // Bash only, and only `node …` runs without a prompt.
      "--tools", "Bash",
      "--allowedTools", "Bash(node:*)",
      "--disable-slash-commands",
      "--system-prompt", SUBAGENT_SYSTEM_PROMPT,
      "--max-turns", String(SUBAGENT_MAX_TURNS),
    ],
    {
      input: buildSubagentPrompt(prompt, project),
      encoding: "utf8",
      timeout: SUBAGENT_TIMEOUT_MS,
      env: {
        ...process.env,
        MEMPALACE_EXPLORER: "1",
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        MAX_THINKING_TOKENS: String(SUBAGENT_THINKING_TOKENS),
      },
      cwd: tmpdir(),
    }
  );
  if (res.error || res.status !== 0) return null;
  let text = (res.stdout || "").trim();
  if (!text) return null;
  if (text.includes("NO_RELEVANT_MEMORY")) return "";
  // Models sometimes prefix the bullets with narration ("Let me compile...").
  // If bullets exist, drop everything before the first one.
  const lines = text.split("\n");
  const firstBullet = lines.findIndex((l) => /^\s*[-*] /.test(l));
  if (firstBullet > 0) text = lines.slice(firstBullet).join("\n").trim();
  return text.slice(0, MAX_CONTEXT_CHARS + 400);
}

/**
 * The project's `session-resume` hand-off, fetched deterministically.
 *
 * Never routed through the exploring subagent: that subagent is instructed to
 * keep only what is relevant to *this* prompt, and "where we left off" is
 * relevant to the session rather than the message. It is also the context most
 * needed by the prompts this hook otherwise ignores — "continue" is 8
 * characters, well under the 30-char exploration floor.
 */
function resumeBlock(project) {
  // --json, not the human output: `recall` flattens newlines and truncates to
  // 280 chars, which decapitates a hand-off exactly at the Next/Where/Blockers
  // lines that carry the value. A resume record is injected whole or not at all.
  const raw = mempalace([
    "recall", "--project", project, "--topic", "session-resume", "-n", "1", "--json",
  ]);
  if (!raw) return "";
  let entry;
  try {
    entry = JSON.parse(raw).results?.[0];
  } catch {
    return "";
  }
  if (!entry?.text?.trim()) return "";
  return (
    `**Where we left off in \`${project}\`** (last recorded hand-off, saved ` +
    `${String(entry.timestamp).slice(0, 10)} — not live state; check ` +
    `\`git status\`/\`git log\` before acting on it):\n\n${entry.text.trim()}`
  );
}

function deterministicFallback(prompt, project) {
  const search = mempalace(["search", prompt.slice(0, 300), "-n", "5"]);
  const recent = mempalace(["recall", "--project", project, "-n", "3"]);
  const parts = [];
  if (search && search !== "No results.") parts.push("Semantic matches:\n" + search);
  if (recent && recent !== "No memories.") parts.push(`Recent \`${project}\` memories:\n` + recent);
  return parts.length ? parts.join("\n\n").slice(0, MAX_CONTEXT_CHARS) : "";
}

function main() {
  if (process.env.MEMPALACE_EXPLORER === "1") return out("");
  if (!existsSync(DB) || !existsSync(CLI)) return out("");

  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return out("");
  }
  const prompt = (input.prompt || "").trim();
  const sessionId = input.session_id || "unknown";
  const project = basename(input.cwd || process.cwd());

  // Two independent once-per-session markers. The resume hand-off is emitted
  // on the first prompt of any length; exploration still waits for a
  // substantive one, so a session opening with "continue" gets the hand-off
  // now and full exploration on the next real request.
  const exploredMarker = join(tmpdir(), `mempalace-explored-${sessionId}`);
  const resumeMarker = join(tmpdir(), `mempalace-resume-${sessionId}`);

  const sections = [];
  if (!existsSync(resumeMarker)) {
    const resume = resumeBlock(project);
    if (resume) {
      sections.push(resume);
      // Marked only on success: a cold first run can spend the 20s spawn
      // budget loading the embedding model and come back empty. Marking
      // before the fetch would burn the session's only attempt on that,
      // silently dropping the hand-off. A duplicate injection is the
      // cheaper failure.
      try {
        writeFileSync(resumeMarker, new Date().toISOString());
      } catch {
        /* best-effort */
      }
    }
  }

  const explorable = prompt.length >= 30 && !prompt.startsWith("/");
  if (explorable && !existsSync(exploredMarker)) {
    try {
      writeFileSync(exploredMarker, new Date().toISOString());
    } catch {
      /* marker is best-effort; a duplicate exploration is annoying, not fatal */
    }
    let context = runSubagent(prompt, project);
    if (context === null) context = deterministicFallback(prompt, project);
    if (context) sections.push(context);
  }

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

try {
  main();
} catch {
  process.exit(0);
}
