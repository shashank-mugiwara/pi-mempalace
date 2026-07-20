/**
 * summarize.mjs — turn one session delta into curated store updates via
 * gpt-5.6-terra (high reasoning effort), invoked through `codex exec` so it
 * reuses the existing ChatGPT auth in ~/.codex/auth.json.
 *
 * The model gets: the transcript delta, the store's current related memories
 * (WITH ids + importance so supersedes can target real ids), related KG
 * facts, a read-only excerpt of the Obsidian vault's project hub note, and
 * the write conventions from PROTOCOL.md. It must return STRICT JSON.
 *
 * Fail-closed: any codex failure / unparseable output → null (the tick skips
 * the candidate WITHOUT advancing its watermark, so nothing is ever lost —
 * it retries next tick).
 */

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, globSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const FORK = join(homedir(), ".pi", "agent", "pi-mempalace-fork");
const VAULT = process.env.WATCHDOG_VAULT || join(homedir(), "Desktop", "shashank");

export const DEFAULTS = {
  model: "gpt-5.6-terra",
  effort: "high",
  timeoutMs: 300_000,
};

// ---------------------------------------------------------------------------
// Context gathering (store + vault)
// ---------------------------------------------------------------------------

export async function gatherContext(store, candidate) {
  const ctx = { memories: [], kg: [], obsidian: "", projects: {} };
  try {
    ctx.projects = store.listProjects().projects;
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
  for (const p of Object.keys(projects || {})) {
    if (p.toLowerCase() === lower) return p; // reuse exact canonical casing
  }
  return name;
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

  return `You are the session-watchdog memory curator for a shared cross-agent memory palace (pi, Claude Code, opencode, codex all read it — bad memory amplifies bad work, so precision beats coverage).

A coding session produced new dialogue. Distill it into durable memory updates.

## New session dialogue (${candidate.source}, project guess: ${candidate.project}, cwd: ${candidate.cwd || "?"})
<transcript-delta>
${candidate.text}
</transcript-delta>

## Existing related memories (with real ids — supersedes MUST target these ids)
${memories || "(none found)"}

## Existing knowledge-graph facts for this project
${kg || "(none)"}

${ctx.obsidian ? "## Obsidian vault context (read-only; human-curated — if it contradicts the session, that is a DOUBT, not an auto-fix)\n" + ctx.obsidian + "\n" : ""}
## Known canonical project names (reuse EXACT casing; never invent variants)
${projectList || "(empty store)"}

## Conventions (non-negotiable)
- Save only durable, future-useful signal: decisions + why, plans, non-obvious findings, changed facts, touched file paths. NOT narration, tool noise, or anything trivially recoverable from git.
- Memories must be self-contained (readable months later, absolute dates, project named). NEVER include secrets, tokens, or credential values — redact to a description.
- topic: lowercase-kebab, reuse the topics visible in the related memories above when they fit; never "general".
- importance: 0.9 architecture decisions/hard lessons, 0.7-0.8 durable findings/plans, 0.5-0.6 useful context. Below 0.5 → don't save it.
- KG predicates (snake_case, this exact vocabulary): uses, depends_on, calls, runtime_dependency, implements, decided, status, located_at, provides, requires, is_a. New entities need an is_a fact.
- Supersede, don't duplicate: if the session explicitly makes an existing memory/fact wrong, propose a supersede/invalidation with the evidence quote. If you are not CERTAIN, put it in doubts instead.
- If the delta contains nothing worth remembering, return empty arrays — that is a good answer.

## Output — STRICT JSON only, no markdown fences, no commentary:
{
  "memories":        [{"content": str, "project": str, "topic": str, "importance": num}],
  "kg_facts":        [{"subject": str, "predicate": str, "object": str, "project": str, "from": "YYYY-MM-DD"}],
  "supersedes":      [{"forget_memory_id": str, "replacement_content": str, "project": str, "topic": str, "importance": num, "evidence": str, "confidence": "high"|"low"}],
  "kg_invalidations":[{"subject": str, "predicate": str, "object": str, "replacement": {"subject": str, "predicate": str, "object": str, "project": str, "from": "YYYY-MM-DD"} | null, "evidence": str, "confidence": "high"|"low"}],
  "doubts":          [{"question": str, "context": str, "proposed_action": str}]
}`;
}

// ---------------------------------------------------------------------------
// codex exec invocation
// ---------------------------------------------------------------------------

export function runTerra(prompt, opts = {}) {
  const model = opts.model || DEFAULTS.model;
  const effort = opts.effort || DEFAULTS.effort;
  const outFile = join(tmpdir(), `watchdog-terra-${process.pid}-${Date.now()}.txt`);
  const args = [
    "exec",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "-m", model,
    "-c", `model_reasoning_effort="${effort}"`,
    "--output-last-message", outFile,
    "-",
  ];
  const res = spawnSync("codex", args, {
    input: prompt,
    encoding: "utf8",
    timeout: opts.timeoutMs || DEFAULTS.timeoutMs,
    cwd: tmpdir(),
    env: { ...process.env, MEMPALACE_EXPLORER: "1" },
  });
  if (res.error) return { ok: false, error: String(res.error) };
  let text = "";
  try {
    text = readFileSync(outFile, "utf8");
  } catch {
    text = res.stdout || "";
  }
  if (res.status !== 0 && !text.trim()) {
    return { ok: false, error: `codex exit ${res.status}: ${(res.stderr || "").slice(-400)}` };
  }
  const parsed = extractJson(text);
  if (!parsed) return { ok: false, error: "unparseable model output: " + text.slice(0, 200) };
  return { ok: true, result: normalize(parsed) };
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
    kg_facts: Array.isArray(o.kg_facts) ? o.kg_facts : [],
    supersedes: Array.isArray(o.supersedes) ? o.supersedes : [],
    kg_invalidations: Array.isArray(o.kg_invalidations) ? o.kg_invalidations : [],
    doubts: Array.isArray(o.doubts) ? o.doubts : [],
  };
}
