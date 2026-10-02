/**
 * summarize.mjs — turn one session delta into curated store updates via
 * Claude Haiku 4.5 with extended thinking ("high"), invoked through a nested
 * `claude -p` so it reuses Claude Code's existing OAuth/keychain login.
 * (gpt-5.6-terra via `codex exec` until 2026-09-23 — Shashank: "haiku 4.5
 * with high effort, no OpenAI models".)
 *
 * The model gets: the transcript delta, the store's current related memories
 * (WITH ids + importance so supersedes can target real ids), related KG
 * facts, a read-only excerpt of the Obsidian vault's project hub note, and
 * the write conventions from PROTOCOL.md. It must return STRICT JSON.
 *
 * Fail-closed: any model failure / unparseable output → null (the tick skips
 * the candidate WITHOUT advancing its watermark, so nothing is ever lost —
 * it retries next tick).
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, globSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadRejections } from "./state.mjs";

const FORK = join(homedir(), ".pi", "agent", "pi-mempalace-fork");
const VAULT = process.env.WATCHDOG_VAULT || join(homedir(), "Desktop", "shashank");

export const DEFAULTS = {
  model: "claude-haiku-4-5",
  effort: "high",
  timeoutMs: 600_000,
};

/**
 * Haiku 4.5 has no API `effort` parameter (the API rejects it), so "effort"
 * becomes an extended-thinking budget. Measured against Claude Code 2.1.280
 * through a logging proxy on 2026-09-23: for Haiku, `--effort` is accepted
 * but never reaches the request (every level sent budget_tokens 63999, the
 * CLI default); MAX_THINKING_TOKENS is what sets `thinking.budget_tokens`,
 * and 0 turns thinking off. Budgets match pi's own thinking-level table
 * (pi-ai simple-options.ts), so "high" means the same thing in both places.
 * Models with adaptive thinking (Sonnet/Opus) get `--effort` instead.
 */
const HAIKU_THINKING_BUDGET = { off: 0, minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32000, max: 63999 };

const CURATOR_SYSTEM_PROMPT =
  "You are a careful, precise curator for a shared cross-agent memory store. " +
  "Follow the instructions in the user message exactly and output only what they ask for.";

// ---------------------------------------------------------------------------
// Context gathering (store + vault)
// ---------------------------------------------------------------------------

export async function gatherContext(store, candidate) {
  const ctx = { memories: [], kg: [], obsidian: "", projects: {}, rejections: [] };
  try {
    ctx.projects = store.listProjects().projects;
  } catch {}
  try {
    // Proposals a human already turned down. Scoped to this candidate's project
    // (plus unscoped ones) so the prompt carries relevant corrections, not the
    // whole history of every project's rejections.
    const canon = canonicalProject(candidate.project, ctx.projects);
    ctx.rejections = loadRejections()
      .filter((r) => !r.project || !canon || r.project === canon)
      .slice(0, 12);
  } catch {}
  try {
    const probe = candidate.text.slice(0, 400).replace(/\s+/g, " ");
    const sem = await store.search(probe, { n_results: 6 });
    const rec = store.recall({ project: canonicalProject(candidate.project, ctx.projects), n_results: 6 });
    const seen = new Set();
    for (const r of [...sem.results, ...rec.results]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      ctx.memories.push({
        id: r.id,
        project: r.project,
        topic: r.topic,
        importance: r.importance,
        timestamp: r.timestamp,
        text: String(r.text || "").slice(0, 600),
      });
    }
  } catch {}
  try {
    const ent = store.queryEntity(canonicalProject(candidate.project, ctx.projects));
    if (ent.entity) ctx.kg = ent.facts.slice(0, 30);
  } catch {}
  ctx.obsidian = readVaultExcerpt(candidate.project);
  return ctx;
}

export function canonicalProject(name, projects) {
  if (!name) return "general";
  const lower = name.toLowerCase();
  // Reuse existing casing. When case variants already coexist (StandardSpec
  // with 21 memories, standardspec with 2), file under the larger one so the
  // stray variant stops growing.
  let best = null;
  for (const [p, count] of Object.entries(projects || {})) {
    if (p.toLowerCase() !== lower) continue;
    if (best === null || Number(count) > Number(projects[best])) best = p;
  }
  return best ?? name;
}

function readVaultExcerpt(project) {
  if (!project || !existsSync(VAULT)) return "";
  try {
    const hits = globSync(join(VAULT, "Projects", "*", "*.md")).filter((p) =>
      p.toLowerCase().includes(project.toLowerCase())
    );
    if (hits.length === 0) return "";
    return `--- Obsidian hub note (${hits[0]}) ---\n` + readFileSync(hits[0], "utf8").slice(0, 2500);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export function buildPrompt(candidate, ctx) {
  const projectList = Object.entries(ctx.projects)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 40)
    .map(([p, c]) => `${p} (${c})`)
    .join(", ");
  const memories = ctx.memories
    .map((m) => `[id=${m.id} imp=${m.importance} ${m.project}/${m.topic} ${String(m.timestamp).slice(0, 10)}]\n${m.text}`)
    .join("\n\n");
  const kg = ctx.kg
    .map((f) => `${f.subject} ${f.predicate} ${f.object}${f.valid_from ? ` [${f.valid_from}→${f.valid_to || ""}]` : ""}`)
    .join("\n");
  const rejections = (ctx.rejections || [])
    .map((r) => `- [${r.kind} · ${r.project || "?"}/${r.topic || "?"} · ${String(r.rejected_at).slice(0, 10)}] ${r.gist}`)
    .join("\n");

  return `You are the session-watchdog memory curator for a shared cross-agent memory palace (pi, Claude Code, opencode, codex all read it — bad memory amplifies bad work, so precision beats coverage).

${candidate.source === "claude-memory"
    ? "Claude Code wrote or updated its LOCAL per-project memory notes (already distilled by the agent, not a transcript). Import the durable facts, decisions and lessons they hold that the shared palace does not already have; skip anything already present or purely Claude-Code-internal."
    : "A coding session produced new dialogue. Distill it into durable memory updates."}

## ${candidate.source === "claude-memory" ? "Changed local memory notes" : "New session dialogue"} (${candidate.source}, project guess: ${candidate.project}, cwd: ${candidate.cwd || "?"})
<transcript-delta>
${candidate.text}
</transcript-delta>

## Existing related memories (with real ids — supersedes MUST target these ids)
${memories || "(none found)"}

## Existing knowledge-graph facts for this project
${kg || "(none)"}

${ctx.obsidian ? "## Obsidian vault context (read-only; human-curated — if it contradicts the session, that is a DOUBT, not an auto-fix)\n" + ctx.obsidian + "\n" : ""}${rejections ? "## Previously REJECTED by the human (do not re-propose these)\nA person reviewed each of these and said no. Treat them as corrections to your own judgment: do not re-derive them from this transcript, and if the current delta pushes you toward one of them, that is a signal your reading is wrong — prefer silence or a doubt.\n" + rejections + "\n\n" : ""}
## Known canonical project names (reuse EXACT casing; never invent variants)
${projectList || "(empty store)"}

## Conventions (non-negotiable)
- Save only durable, future-useful signal: decisions + why, plans, non-obvious findings, changed facts, touched file paths. NOT narration, tool noise, or anything trivially recoverable from git.
- Memories must be self-contained (readable months later, absolute dates, project named). NEVER include secrets, tokens, or credential values — redact to a description.
- Never write a cost figure in dollars or any other currency (API spend, cloud bills, per-run or per-token cost) in a memory, lesson, playbook entry, supersede replacement or doubt. Describe that impact in tokens, run duration or a relative multiplier ("~5x"). Amounts that are facts about the product itself, such as a loan limit in lakh or crore, are not cost figures.
- topic: lowercase-kebab, reuse the topics visible in the related memories above when they fit; never "general".
- importance: 0.9 architecture decisions/hard lessons, 0.7-0.8 durable findings/plans, 0.5-0.6 useful context. Below 0.5 → don't save it.
- KG predicates (snake_case, this exact vocabulary): uses, depends_on, calls, runtime_dependency, implements, decided, status, located_at, provides, requires, is_a. New entities need an is_a fact.
- Supersede, don't duplicate: if the session explicitly makes an existing memory/fact wrong, propose a supersede/invalidation with the evidence quote. If you are not CERTAIN, put it in doubts instead.
- If the delta contains nothing worth remembering, return empty arrays — that is a good answer.

## Lessons (the agent got something wrong)

Ordinary memories record what is true. A LESSON records where an agent's own
reasoning failed, so the next session does not repeat it. Extract one only from
DIRECT evidence in this transcript — never from your own opinion of the work.

Qualifying evidence:
- The human corrected the agent ("no", "that's wrong", "I already told you", "stop doing X").
- An approach was tried, failed, and was abandoned for a different one.
- A confident claim the agent made turned out to be false.
- The same error recurred after a fix — the first fix addressed a symptom.

NOT lessons: ordinary iteration, the human changing their mind, a plan evolving,
tests failing once and being fixed, or anything you merely suspect was suboptimal.

Each lesson: what was believed or done, what was actually right, and the
generalisable trigger ("when X, check Y first") — useless without the trigger.
A wrong lesson is worse than no lesson: it teaches an agent to avoid correct
behaviour. If unsure, emit nothing.

## Playbook (how to work efficiently in this project)

Separate from lessons (which record reasoning failures) and memories (which
record facts). A playbook entry records a PROCEDURE: a command that was
faster than the obvious alternative, where a file/skill actually lives (not
where you'd guess), or a way of phrasing a request that got a better result
than the first phrasing tried.

Qualifying evidence — extract ONLY from things that actually happened in this
transcript, never from general knowledge:
- A command was tried, and a faster/better alternative was used afterward
  (e.g. switched from find to fffind, from grep to ffgrep).
- A file or skill's real location differed from where it was first looked
  for.
- A prompt/request was rephrased and the rephrasing visibly worked better.

NOT playbook entries: one-off facts with no procedural value, anything
already covered by a lesson or an ordinary memory, speculation about what
MIGHT be faster.

For each entry, classify BOTH:
- kind: "command" (a CLI invocation or tool preference) | "location" (where
  something lives) | "prompt-phrasing" (a request phrasing that worked) |
  "other"
- destination: "memory" (session-scoped procedural fact, fine to auto-apply
  if high confidence) | "vault" (durable enough to belong in the project's
  standing rules/hub note, alongside human-curated content) | "both" |
  "unsure" (you cannot tell — let the destination be decided downstream, not
  guessed here)

If nothing in this transcript qualifies, return an empty array — that is
correct far more often than not.

## Output — STRICT JSON only, no markdown fences, no commentary:
{
  "memories":        [{"content": str, "project": str, "topic": str, "importance": num}],
  "lessons":         [{"content": str, "project": str, "trigger": str, "evidence": str, "confidence": "high"|"low"}],
  "playbook":        [{"content": str, "project": str, "kind": "command"|"location"|"prompt-phrasing"|"other", "destination": "memory"|"vault"|"both"|"unsure", "evidence": str, "confidence": "high"|"low"}],
  "kg_facts":        [{"subject": str, "predicate": str, "object": str, "project": str, "from": "YYYY-MM-DD"}],
  "supersedes":      [{"forget_memory_id": str, "replacement_content": str, "project": str, "topic": str, "importance": num, "evidence": str, "confidence": "high"|"low"}],
  "kg_invalidations":[{"subject": str, "predicate": str, "object": str, "replacement": {"subject": str, "predicate": str, "object": str, "project": str, "from": "YYYY-MM-DD"} | null, "evidence": str, "confidence": "high"|"low"}],
  "doubts":          [{"question": str, "context": str, "proposed_action": str}]
}`;
}

// ---------------------------------------------------------------------------
// claude -p invocation
// ---------------------------------------------------------------------------

/**
 * Isolation flags, each load-bearing:
 *   --no-session-persistence  the collectors read ~/.claude/projects; a
 *                             persisted run would be fed back into the
 *                             watchdog as a new "session" next tick
 *   --strict-mcp-config + empty --mcp-config, --setting-sources ""
 *                             no MCP servers, hooks, plugins or user settings
 *                             (startup measured 7.1s → 2.9s)
 *   --tools ""                no tools: the curator only reads its prompt
 *   --system-prompt + CLAUDE_CODE_DISABLE_CLAUDE_MDS/AUTO_MEMORY
 *                             drops the coding-agent prompt and CLAUDE.md /
 *                             rules files (~6.6k → ~0.5k input tokens of
 *                             overhead per call)
 *   MEMPALACE_EXPLORER=1      Claude Code's first-prompt explorer hook exits
 *                             immediately for nested runs
 * Not --bare: it refuses OAuth/keychain auth, which is how this machine logs in.
 */
export function runCurator(prompt, opts = {}) {
  const model = opts.model || DEFAULTS.model;
  const effort = opts.effort || DEFAULTS.effort;
  const isHaiku = /haiku/i.test(model);
  const args = [
    "-p",
    "--model", model,
    "--output-format", "json",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "",
    "--tools", "",
    "--disable-slash-commands",
    "--system-prompt", CURATOR_SYSTEM_PROMPT,
  ];
  if (!isHaiku) args.push("--effort", effort);
  const env = {
    ...process.env,
    MEMPALACE_EXPLORER: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  };
  if (isHaiku) env.MAX_THINKING_TOKENS = String(opts.thinkingTokens ?? HAIKU_THINKING_BUDGET[effort] ?? HAIKU_THINKING_BUDGET.high);
  const res = spawnSync("claude", args, {
    input: prompt,
    encoding: "utf8",
    timeout: opts.timeoutMs || DEFAULTS.timeoutMs,
    cwd: tmpdir(),
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) return { ok: false, error: String(res.error) };
  let envelope = null;
  try {
    envelope = JSON.parse(res.stdout || "");
  } catch {
    /* not JSON: CLI failed before producing a result */
  }
  if (!envelope || envelope.is_error || envelope.subtype !== "success") {
    const why = envelope ? `${envelope.subtype || "error"}: ${String(envelope.result || "").slice(0, 300)}` : (res.stderr || res.stdout || "").slice(-400);
    return { ok: false, error: `claude exit ${res.status}: ${why}` };
  }
  const text = String(envelope.result || "");
  const parsed = extractJson(text);
  if (!parsed) return { ok: false, error: "unparseable model output: " + text.slice(0, 200) };
  // `raw` callers (consolidate.mjs) bring their own schema; normalize() would
  // drop every key it does not know.
  return { ok: true, result: opts.raw ? parsed : normalize(parsed) };
}

export function extractJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalize(o) {
  return {
    memories: Array.isArray(o.memories) ? o.memories : [],
    lessons: Array.isArray(o.lessons) ? o.lessons : [],
    playbook: Array.isArray(o.playbook) ? o.playbook : [],
    kg_facts: Array.isArray(o.kg_facts) ? o.kg_facts : [],
    supersedes: Array.isArray(o.supersedes) ? o.supersedes : [],
    kg_invalidations: Array.isArray(o.kg_invalidations) ? o.kg_invalidations : [],
    doubts: Array.isArray(o.doubts) ? o.doubts : [],
  };
}
