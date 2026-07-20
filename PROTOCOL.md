# Memory Palace Protocol (cross-agent)

The single source of truth for **how any coding agent** (pi, Claude Code, opencode, codex)
recalls from and writes to the shared memory palace
(`~/.pi/agent/memory/memories.db`). Agent-facing instruction blocks
(`~/.claude/skills/shared-memory-palace/SKILL.md`, `~/.codex/AGENTS.md`,
`~/.config/opencode/AGENTS.md`, `~/.pi/agent/APPEND_SYSTEM.md`) are summaries of
this file — when they drift, this file wins; update them from here.

Interface per agent:

| Agent | Read/write surface | First-prompt recall |
|-------|--------------------|---------------------|
| pi | native tools (`memory_search`, `memory_save`, `knowledge_*`) | in-process auto-recall every prompt (bi-encoder pool → cross-encoder rerank → Haiku gate, fork ≥0.6.0) |
| Claude Code | `node ~/.pi/agent/memory/cli/mempalace.mjs` (delegates to this repo's `cli/mempalace.mjs`) | `hooks/claude-first-prompt-explorer.mjs` — UserPromptSubmit hook spawns a Haiku subagent that explores agentically and injects a distilled block |
| opencode / codex | same CLI | instruction-driven: the agent itself runs the exploration protocol below on the first substantive request |

## Recall: explore, don't one-shot

A single semantic search over the raw user prompt is the *floor*, not the method.
When a request depends on prior context:

1. **Orient** — `projects` (or pi's injected taxonomy): what projects/topics exist at all.
2. **Search from multiple angles** — 2–4 `search` calls with different natural-language
   phrasings of the intent (goal wording, symptom wording, component wording); try both
   with and without `--project`. Ranking is blended `similarity × importance`.
3. **Follow structure** — `kg-query <entity>` for services/tools/projects named in the
   prompt *or surfaced by step 2*. Facts are temporal; `--at DATE` answers "what was
   true then".
4. **Sweep recency** — `recall --project <p> -n 8` for what recently happened here.
5. **Filter ruthlessly** — inject/use only what would change the approach to *this*
   request. Recalled memories reflect what was true when saved; verify against current
   code/config before relying on them.

## Saving memories (`save` / `memory_save`)

- **Save**: decisions + the why, durable preferences, plans, architecture, non-obvious
  findings, changed facts, file paths of touched components.
  **Never save**: transient narration, chatter, raw logs, anything derivable from git
  history in seconds, and **never secrets/credentials/tokens** — even redacted-ish.
- **Self-contained**: must make sense months later with zero surrounding chat. Name the
  project, what was decided/found, and why. Convert relative dates ("yesterday") to
  absolute (YYYY-MM-DD).
- **Always tag** `--project` (canonical repo/dir name as it appears in `projects`) and
  `--topic` (lowercase-kebab, reuse existing topics before minting new ones).
- **Importance scale** (blends into search ranking; ≥0.7 surfaces in pi's wake-up digest):
  - `0.9` — architecture decisions, hard-won lessons, standing user preferences
  - `0.7–0.8` — durable findings, plans, project conventions
  - `0.5–0.6` — useful context, session summaries
  - below `0.5` — usually not worth saving at all
- **Dedupe/supersede**: search for the fact first. If an older memory says something now
  wrong, save the corrected version and `forget <id>` the stale one (pi:
  `memory_check_duplicate`, `memory_delete`). One evolving fact = one memory, not a trail
  of contradicting ones.

## Saving knowledge-graph facts (`kg-add` / `knowledge_add`)

Use the KG for **structured, temporally-scoped relationships** you'll later query by
entity or point in time — not prose. Prose rationale goes in `save`; the relationship
goes in the KG (they complement, don't duplicate).

- **Shape**: `kg-add <subject> <predicate> <object> --project P --from YYYY-MM-DD`
- **Entities**: one canonical name per real-world thing — reuse exactly what `kg-query`
  already knows (entity match is by lowercased name hash — `Prism` and `prism` match,
  but `prism-docs` and `prism` don't). Project entities use the same name as their
  `--project` tag. Give every NEW entity a type via an `is_a` fact (e.g.
  `kg-add weaver is_a service`) — never leave it untyped.
- **Predicates**: snake_case, from the vocabulary already established in the graph —
  extend it only when nothing fits, and check `kg-query` for what's in use first:
  `uses`, `depends_on`, `calls`, `runtime_dependency`, `implements`, `decided`,
  `status`, `located_at`, `provides`, `requires`, `is_a`.
- **Projects/topics are case-sensitive strings** (unlike entities): always reuse the
  exact canonical project names listed in `~/.pi/agent/APPEND_SYSTEM.md` (e.g.
  `AIRecords`, `pi-config`, `prism`, `weaver`); never mint case/format variants, and
  never leave `--topic` as `general` — browse existing topics first.
- **Temporal honesty**: `--from` = when the fact became true (not today's date, unless
  it did). When a fact stops being true or is superseded:
  1. `kg-invalidate <subj> <pred> <obj>` (sets `valid_to`; `--to DATE` to backdate)
  2. `kg-add` the new fact with `--from` the changeover date
  Never leave two contradictory *active* facts (e.g. `prism uses postgres` AND
  `prism uses mysql`) — invalidate the loser.
- **Granularity test**: if you can't imagine querying it via `kg-query <entity>` or
  "what did X use in March?", it's not a triple — it's a memory.

## Background curation (session-watchdog, fork ≥0.8.0)

A 15-minute watchdog (scheduled by the `session-watchdog` pi extension,
runnable manually via `cli/watchdog.mjs tick`) reads new dialogue from ALL
four agents' session stores, summarizes worth-it deltas (≥10KB new dialogue,
5 min quiet) with gpt-5.6-terra via `codex exec`, and applies results under
**additive auto, destructive queued**: new memories/facts land automatically
(importance clamped ≤0.85, dupe-guarded); anything destructive, low-confidence,
or touching an importance ≥0.85 memory waits in `watchdog-review.json` for the
human's AskUserQuestion verdict at the next pi session. pi's memory-summarizer
auto-distill is retired in favor of this (manual `/memory-summarize` remains).
Agents should still save pivotal decisions inline as they happen — the
watchdog is a safety net and curator, not an excuse to skip deliberate saves.

## Concurrency & store notes

- WAL + `busy_timeout=5000`: concurrent access from multiple agents is safe;
  simultaneous writes serialize, never lost.
- Auto-capture is OFF everywhere, permanently. Only explicit saves persist.
- `MEMPALACE_HOME` relocates the store (used by tests/bench; default
  `~/.pi/agent/memory`).
