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

## Prospective memory: the `session-resume` record

Episodic memories record *what happened*; the KG records *what is true*. Neither
answers **"what was I in the middle of?"** — the question that actually costs a
session when it goes unanswered. That is the `session-resume` record.

**Exactly one per project, superseded rather than appended.** A trail of stale
hand-offs is worse than none: the agent cannot tell which is current.

Write one when work reaches a stopping point — end of session, context about to
compact, a branch parked mid-change, or a hand-off to another agent:

```sh
# 1. find the existing record (there is at most one)
node cli/mempalace.mjs recall --project P --topic session-resume -n 1 --json
# 2. delete it by id — supersede, never accumulate
node cli/mempalace.mjs forget <id>
# 3. write the new one
node cli/mempalace.mjs save "<hand-off>" --project P --topic session-resume --importance 0.75
```

pi equivalents: `memory_recall` → `memory_delete` → `memory_save`.

**Always `--topic session-resume`** — that exact string is what
`wakeup()` keys on. **Always `--project`**, matching the canonical project name,
because the record is injected only for the repo you are sitting in.

Content — write it for a stranger resuming cold, and keep it under ~800 chars so
it survives as a single chunk:

- **Goal** — what is being built or fixed, in one line.
- **State** — what is done and actually verified, versus merely written.
- **Next** — the single next concrete action.
- **Where** — the file paths and the branch, so no re-discovery is needed.
- **Blockers** — failing tests, awaiting review, unanswered questions.

Do **not** put in it: anything derivable from `git status`/`git log` in seconds,
narration of the session, or a changelog of what was tried. It is a pointer to
the live frontier, not a diary — the diary is `diary-<agent>`.

**Recall side:** the record is injected automatically into the wake-up context as
"Where we left off" (fork ≥0.8.3), whole and untruncated, for the current
project. It is *not* left to semantic auto-recall — "let's continue" is 14
characters, below `autoRecallMinPromptChars` (30), so prompt-driven recall never
fires on exactly the prompt that most needs it. Treat the injected record as the
last hand-off, not live state: verify against current code and git before acting.

## Learning from mistakes: the `lessons` topic

A memory records what is true. A **lesson** records where an agent's own
reasoning failed, so the next session doesn't repeat it. Without a home of its
own, this signal gets filed as an ordinary "finding" and becomes unretrievable
by the only question that matters — *"what have I got wrong here before?"*

**Topic is always `lessons`.** Importance 0.85. Content is **trigger-first**,
because a lesson is retrieved when the situation recurs, not when someone goes
looking for it:

```
LESSON (when <situation recurs>, <do this first>)
<what was believed or done, and what was actually right>
```

Write one only from direct evidence: the user corrected the agent; an approach
was tried, failed and was abandoned; a confident claim turned out false; the
same error recurred after a fix that only addressed a symptom. **Not** lessons:
ordinary iteration, the user changing their mind, a test failing once, or
anything merely suspected to be suboptimal.

A lesson with no generalisable trigger is unactionable — don't save it. And a
*wrong* lesson is worse than none: it teaches an agent to avoid correct
behaviour. When unsure, save nothing.

### The rejection loop (watchdog ≥0.8.4)

`apply-review --reject` used to discard rejected proposals. Rejections are the
only **labelled** signal the system gets — a human judging a concrete inference
wrong — so they are now persisted to `watchdog-rejections.json` and injected
into the curator prompt as "previously rejected, do not re-propose". Without
this, the same bad inference is re-derived from the same transcript on every
tick and the loop never converges.

Lessons proposed by the watchdog are **always queued for human approval**, never
auto-applied, regardless of confidence — the model is inferring about its own
reasoning from a transcript it partly wrote, and this install already retired
auto-capture for writing 83% noise. The human is the gate.

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
