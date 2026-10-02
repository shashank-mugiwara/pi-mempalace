# Fork changelog

## 0.8.10 — 2026-10-02 — explorer selects instead of paraphrasing; apply-review takes the lock; reversible demotions

From the 2026-10-02 cross-agent harness audit (harness bead hx-5b09) and
Shashank's choices in it: "Auto-apply demotions", "Merge stray palace
projects", strip dollar figures (bead hx-9es.8).

- **First-prompt explorer** (`hooks/claude-first-prompt-explorer.mjs`, used by
  Claude Code and codex). It had drifted back to 31.3s on the audit prompt;
  nearly all of it was the 8-turn Bash tool loop. The probes (semantic search
  over the palace and the session's project, lessons, recent project memories,
  knowledge-graph facts for entities the prompt names) now run in parallel in
  the hook, and Haiku takes one turn with no tools and no thinking to pick up
  to six ids. The chosen memories are printed verbatim with their saved date:
  the old prompt asked for "the distilled fact/decision" and rewrote fixed
  incidents as open to-dos. Same prompt: 5.6s. The project is resolved from
  the git toplevel, the main checkout behind a worktree, the origin repo name,
  then the cwd basename (36 of 106 sessions had matched no project). One JSON
  line per run goes to `explorer.log`.
- **apply-review** takes `watchdog.lock` (waits up to 2 minutes, then exits 1
  having applied nothing) and reads the queue only after holding it, so a tick
  can no longer undo verdicts. A supersede or merge saves its replacement
  before deleting anything, and never deletes its own family. Every write
  resolves its project through `resolveProject`; an unresolvable item stays
  queued with a reason. Two approved supersedes for one target are refused up
  front (bead hx-r8e). Each run logs its counts to `watchdog.log`.
- **Lock**: broken only when its holder is gone, unreadable and old, or silent
  for 3 hours; ticks and consolidation heartbeat before each model call.
- **Queue sweep** at the start of every tick and apply-review: supersedes whose
  target is gone, and all but the newest per target, move to
  `watchdog-swept.json` whole (5 swept on the first run).
- **Demotions apply automatically** and are recorded first in
  `watchdog-demoted.json` with the old importance, so each can be undone with
  `setImportance(id, from)`. A proposal that would not lower importance is
  skipped.
- **No currency figures**: the curator and merge prompts forbid them, and a
  backstop skips any unreviewed write that carries one (`looksLikeCostFigure`).
- **Log rotation**: `watchdog.log` and `watchdog-launchd.log` move to `.1` past
  1 MB at the start of a tick.
- Tests: `watchdog/apply-review.test.mjs` (23), alongside `bench/gate-unit.mjs`.

## 0.8.9 — 2026-09-23 — watchdog on Claude Haiku 4.5; isolated nested `claude -p`; queue hygiene

From the 2026-09-23 harness audit and Shashank's instruction "haiku 4.5 model
with high effort. No OpenAI models".

- **Curator model.** `runTerra` (gpt-5.6-terra via `codex exec`) is replaced by
  `runCurator` in `watchdog/summarize.mjs`: `claude -p --model claude-haiku-4-5
  --output-format json`, reusing Claude Code's OAuth/keychain login. Haiku 4.5
  rejects the API `effort` parameter, so "high" is an extended-thinking budget:
  `MAX_THINKING_TOKENS=16384` (pi's own table: low 2048, medium 8192, high
  16384, xhigh 32000, max 63999). Checked through a logging proxy against Claude
  Code 2.1.280: for Haiku, `--effort` is accepted but never sent (every level
  went out as `budget_tokens: 63999`); `MAX_THINKING_TOKENS` sets the budget.
  Non-Haiku overrides get `--effort` instead. Config keys `watchdogModel` /
  `watchdogEffort` still work; new `watchdogThinkingTokens`.
- **Isolation** on every nested call (watchdog and first-prompt explorer):
  `--no-session-persistence` (the collectors read `~/.claude/projects`, so a
  persisted run would be fed back into the watchdog), `--strict-mcp-config` with
  an empty `--mcp-config`, `--setting-sources ""`, `--disable-slash-commands`, a
  short `--system-prompt`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`,
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `MEMPALACE_EXPLORER=1`, cwd tmpdir, prompt
  on stdin. The curator runs with `--tools ""`. Per-call overhead fell from ~6.6k to ~0.5k
  input tokens. Not `--bare`: it refuses OAuth/keychain auth.
- **First-prompt explorer** (`hooks/claude-first-prompt-explorer.mjs`): the
  isolation above, `--tools Bash`, `--max-turns` 14 → 8, a 2,048-token
  thinking budget (Claude Code's Haiku default was 63,999 per turn), timeout
  90s → 60s. One realistic prism prompt: 41.0s before, 20.1s after, same
  recalled facts.
- **Collectors** skip Claude Code project dirs named for temp cwds
  (`-private-var-folders-…`, `-tmp…`) before reading or seeding them. They had
  145 of the explorer's persisted transcripts; `isTempCwd()` already kept those
  away from the summarizer (0 summarized), but only via the cwd inside each file.
- **Queue hygiene** (`watchdog/apply.mjs`, audit D7, 158 items pending): a
  supersede whose target memory is gone is dropped instead of queued; one pending
  supersede per target (the newer replaces the older); every write and queued
  item goes through `resolveProject()`. The 0.8.8 guard (`isNonProjectName`) was
  wired into the CLI and pi tools but never into the watchdog, and
  `canonicalProject()` returned `shashank.j` / `Documents` because both already
  exist as projects. Working-directory names now fall back to the session's
  project or are refused; case variants take the session's spelling.
  `findMemory()` is chunk-family aware (`mem_x_c0` exists if `mem_x` does).
- **session-watchdog.ts** keeps only `/memory-watchdog`. Its in-process 15-min
  timer duplicated launchd and only ever lost the lock; its first-turn "Memory
  review pending" block repeated the health canary and changed the system
  prompt after turn one (a prompt-cache miss).

## 0.8.8 — 2026-09-05 — the knowledge graph finally reads its own `is_a` facts; writers refuse non-projects

Found by the 2026-09-04 memory-harness audit: 405 of 658 entities were typed
`unknown`. PROTOCOL.md had said since 0.6 "give every new entity a type via an
`is_a` fact", and agents did — 77 untyped entities carried one — but nothing in
`memory_store.ts` ever read the predicate. Separately, 46 memories sat under the
projects `shashank.j` and `Documents`: `detectProject()` returns the cwd basename,
so a session started in the home folder filed everything under the user name.

- `addTriple()` now types the subject when the predicate is `is_a` / `is_an` /
  `instance_of` / `type` / `kind`, and accepts `subject_type` / `object_type` for
  the auto-created endpoints (`COALESCE` in `addEntity` keeps an existing type).
  `normalizeEntityType()` squashes free text to the kebab-case vocabulary and
  rejects sentence-long objects so `is_a "Python CLI tool for scoring…"` does not
  become a type.
- New store methods `setEntityType`, `listUntypedEntities`, `backfillTypesFromIsA`;
  new CLI commands `kg-type <entity> <type>`, `kg-untyped [--project P] [-n N]`,
  `kg-backfill-types`; `kg-add` gained `--subject-type` / `--object-type` and reports
  which endpoints are still untyped after the write.
- `knowledge_add` (pi tool) gained `subject_type` / `object_type` and a guideline
  line; `isNonProjectName()` names the working-directory placeholders (general,
  the home folder, Documents, Desktop, Downloads, tmp…). `save` / `kg-add` in the CLI
  and `memory_save` / `knowledge_add` in pi refuse them with a message that names
  the fix instead of filing the memory where nobody will look.
- `watchdog.mjs apply-review` fails before applying anything when an id is not in
  the queue or is listed as both approve and reject, and prints the counts it is
  about to apply. Unknown ids used to be skipped silently, which reads as success.

Migration for an existing store: `node cli/mempalace.mjs kg-backfill-types` (types
the entities that already have an is_a fact), then `kg-untyped` to see the rest.

## 0.8.7 — 2026-09-02 — singleton supersede, consolidation, claude-memory collector

Shipped as `ef77916` + `44e5a56` without a version bump (package.json stayed at
0.8.6); recorded here so the pin history reads correctly. `MemoryStore.store()`
deletes prior `session-resume` / `todo-state` / `playbook` families for the project
before writing (`SINGLETON_TOPICS`); `supersedeAllTopic()` and `setImportance()`
added; watchdog `consolidate` command with a monthly auto-run, `merge` / `demote` /
`delete` review kinds, a claude-memory collector for `~/.claude/projects/*/memory`,
`watchdogTimeoutMs` (600 s default) and per-candidate `minChars`.

## 0.8.6 — 2026-07-30 — auto-recall becomes project-scoped, not semantic-search-scoped

**`autoRecall` (the per-message bi-encoder + cross-encoder + Haiku-gate pipeline,
0.6.0-0.8.5) is now off by default in the live config (`autoRecall: false`),
replaced by a widened, project-scoped `wakeup()` digest.** Rationale: a fast,
correctly-working autoRecall call was traced live (2026-07-30, prism session)—
it fired instantly and returned a real memory, but the memory was topically
adjacent (docker/ECR naming) rather than actually relevant to the question
asked (UAT env vars / SSM / prod portability), and the agent's real answer came
entirely from grepping the actual PR diff and CloudFormation templates — the
memory was never cited. That, plus the fact that most of this session's actual
debugging time went into config drift and provider/timeout tuning for the
gate (see 0.8.5's own changelog entry), motivated a simpler design: instead of
ranking candidates by semantic similarity to the literal message text across
EVERY project, inject the current project's OWN memories — grouped, ordered by
recency, matching how both the memory store and the knowledge graph already
organize data by project. `memory_search` (explicit semantic search across
projects) and `memory_investigate` (the subagent-based deep investigation, kept
exactly as-is per this session's decision — it isolates Obsidian vault content
in its own context so the main session's context never absorbs a full vault
crawl) remain available on demand for anything the project digest doesn't cover.

- `generateL1()` (`memory_store.ts`), the function behind `wakeup()`'s project
  digest, gained a project-scoped branch: `ORDER BY timestamp DESC` (latest,
  not importance-ranked — a stale-but-once-important row shouldn't permanently
  occupy a slot a fresher one should have), `LIMIT` widened 15→60, the old
  5-entries-per-project cap dropped entirely, and the 200-char snippet
  truncation raised to 800. The original importance-ranked, 5-per-project,
  200-char-capped behavior is unchanged for the no-project-known case (a
  genuine cross-project sampler, where those caps still make sense).
- **`projectAliases: Record<string, string[]>`** (new `MemoryConfig` field,
  default `{}`). Exists because cwd-derived project identity
  (`detectProject = basename(cwd)`) and where memories actually get saved can
  diverge — confirmed live: this repo's cwd resolves to `harness`, which holds
  only 15 memory rows, while 62 rows of directly relevant content (including
  everything from this session) are filed under the canonical project name
  `pi-config`. Without an alias, project-scoped-only injection would have
  silently shown the 15-row bucket and missed the 62-row one — exactly the
  failure mode semantic search had been papering over. Configured in
  `~/.pi/agent/memory/config.json`: `{"harness": ["harness", "pi-config"]}`.
- **`MemoryStore.projectFacts(projects, limit)`** (new): current
  (`valid_to IS NULL`) knowledge-graph facts scoped to project(s), most recent
  first, injected into `wakeup()` right after the playbook block. Session start
  was otherwise KG-blind — `queryEntity()` requires an entity name the agent
  doesn't have yet, so structured facts were unreachable until the agent
  already knew what to ask about.
- `wakeUpMaxTokens` default raised 800→2500 (in both `defaultConfig()` and the
  live config — the missing-from-disk-config bug that cost most of this
  session's earlier debugging is not one to repeat for a new key). 800 tokens
  (~3,200 chars) can't hold a whole project's digest; `harness` alone is
  ~8k chars. `wakeup()`'s overall budget accounting was also fixed: the new
  facts block wasn't previously subtracted from `generateL1`'s budget, so a
  fact-heavy project (`prism`, 40 facts) blew total output to ~14k chars
  against a 10k-char (2500-token) target. Fixed by computing `generateL1`'s
  budget as `maxChars - (identity + resume + playbook + facts already used)`.
- Verified against the live store (read-only script, `MemoryStore` imported
  directly, no `store()`/`save()`/`delete()` calls): `harness`+`pi-config`
  alias lands at 2,438 of 2,500 target tokens with correct grouping and full,
  untruncated entries; `prism` (251 rows, no alias) now stops cleanly at 2,341
  tokens instead of spilling to ~3,530.

**Left untouched, on purpose:** `recall.ts`, `gate.ts`, `reranker.ts`, and
`bench/` — the whole rerank+gate pipeline stays intact and importable
(`autoRecall: true` is still `defaultConfig()`'s code default, the same
rollback convention as `investigateEnabled`/`investigateMechanism`), just
unreferenced from the hot path while `autoRecall: false` is set. `cachedL1`
stays session-cached, not per-turn — mid-session `memory_save` calls won't
appear in the injected block until the next session, which is what keeps the
system-prompt prefix stable and the provider's prompt cache warm.

## 0.8.5 — 2026-07-30 — memory_investigate: subagent mechanism, and the config bug that made every message slow

**Every per-message context fetch was taking 76-222s.** `investigateEnabled`
(Task 6, 0.8.4) defaults to `true` in code but was absent from the live
`~/.pi/agent/memory/config.json`, so the fast legacy autoRecall path
(`recall.ts`, ~3-8s per the gate log) was dead and the on-demand
`memory_investigate` tool's ~1-4min child-spawn investigation ran on
essentially every turn instead. Separately, `autoRecallGateProvider` had
drifted to `openai-codex/gpt-5.4-mini`, which aborted 3× under the 5s gate
timeout with `autoRecallGateFailMode: "closed"` discarding every gray-zone
candidate on each abort. Both are config fixes (not in this repo — in
`~/.pi/agent/memory/config.json`): `investigateEnabled:false` restores the
fast path as the automatic per-message injection; the gate provider moved
back to the tuned `anthropic/claude-haiku-4-5` default with
`autoRecallGateFailMode:"open"`.

**`memory_investigate` gained a second mechanism, `"subagent"`, now default.**
The original `"child"` mechanism (`investigate.ts`'s `spawn("pi", ["-p", ...])`)
paid two costs that had nothing to do with the actual search: a fresh pi
process re-resolving model/auth from scratch (two runs hung the full 180s on
an expired Bedrock SSO token even though Bedrock was never requested — model-
registry init reached for it anyway), and the Obsidian MCP server
cold-starting via `npx` on every single call (measured to roughly triple
latency). The vault is a plain git repo of LLMWiki-organized markdown on disk,
not something that needs an API — so the new mechanism spawns
`agents/memory-investigator.md` as an in-process pi-subagent (via pi-subagents'
cross-extension RPC bus: `subagents:rpc:spawn` + `subagents:completed`/
`subagents:failed`) with `read`/`grep`/`find`/`ls` plus the memory-palace
tools, no `mcp` extension loaded at all. That also dissolves the MCP-scoping
blocker that ruled out pi-subagents originally (no `mcp` tool loaded means no
`exa`/`prism` reach to defend against) and removes the Obsidian-must-be-running
dependency entirely. Measured ~15-35s per real query end to end, vs 90-220s+
for the child mechanism. `investigateMechanism: "subagent" | "child"` in
config — `"child"` kept intact as a one-line rollback, not deleted.

- `investigationCache`: session-scoped `Map<normalizedQuery, verdict>` on
  `MemoryRuntime`. Two near-identical queries 7 minutes apart in the same
  session previously cost two full investigations for what can't be a
  different answer within one session — now the second is served from cache.
- `investigationInFlight`: module-scoped single-flight guard, shared across
  every session in the process (including the investigator subagent's own
  session). Belt-and-braces anti-recursion for the subagent mechanism, and
  doubles as the signal to suppress wake-up/taxonomy noise in the
  investigator's own `before_agent_start` — it starts up while this is true.
- Reworded `memory_investigate`'s description/guidelines and the
  `before_agent_start` `preferInvestigate` text: `memory_search` is now framed
  as the default, `memory_investigate` as the slow, occasional exception —
  the prior wording ("call it on the first substantive message... and
  whenever you need memory context") was the direct driver of near-every-turn
  calls.

## 0.8.4 — 2026-07-25 — the gate was dead, and learning from mistakes

**The recall gate had never once succeeded.** `recall-gate.log` since
2026-07-20: 46 `gate=idle`, 28 `gate=FAILED(fell-closed)`, **zero `gate=ok`**.
Every invocation logged `unparseable-response:` with nothing after the colon.

Root cause is an observability defect, not a parser one: `complete()` returns
`stopReason: "error"` with an `errorMessage` and empty content on a failed
request, and the judge only special-cased `"aborted"`. An errored response fell
through to the text extraction, produced `""`, and was reported as a parse
failure — so five days of total outage looked like a model formatting quirk.
With `failMode: "closed"` the gray zone was silently dropped the whole time and
recall ran auto-tier-only. The window opens exactly on the v0.8.1 switch of the
gate model to `openai-codex/gpt-5.4-mini` (`reasoning: true`, capped at
`GATE_MAX_TOKENS = 300`).

- `stopReason === "error"` now logs `request-failed: <errorMessage> [provider/model]`.
- Genuine parse failures now log `stop=`, `types=[...]`, `len=` and `maxTokens=`,
  which separates the three modes that previously logged identically: a
  reasoning model burning the budget before emitting text, a model replying in
  prose, and a response with no content at all.
- `bench/gate-unit.mjs` passed 23/23 throughout, because it mocks the parser and
  never exercises the live call — noted here so the next reader doesn't trust it
  as integration coverage.

**Learning from mistakes.** Rejections were the only labelled signal in the
system and `apply-review` threw them away (`if (reject.includes(item.id))
continue;`), so the same bad inference could be re-derived from the same
transcript on every tick.

- `watchdog-rejections.json` (newest-first, capped at 40) records what the human
  turned down; `gatherContext` scopes them to the candidate's project and
  `buildPrompt` injects a "previously REJECTED — do not re-propose" block.
- New `lessons` extraction category: where an agent's *own reasoning* failed,
  gated on direct evidence (user correction, abandoned approach, false claim,
  recurrence after a symptom-fix) and requiring a generalisable trigger.
  Stored trigger-first under topic `lessons` at importance 0.85, so it retrieves
  when the situation recurs rather than when someone goes looking.
- Lessons are **always queued for human approval**, never auto-applied at any
  confidence. A wrong lesson teaches an agent to avoid correct behaviour, and
  this install already retired auto-capture for writing 83% noise — the fix is
  not another autonomous writer.

Verified: rejection round-trip (persist → project-scoped prompt injection),
lesson queued-not-saved with a throwing store, trigger-less lessons dropped,
approved lesson stored and retrieved at 0.54 on a paraphrased query.


## 0.8.3 — 2026-07-25 — procedural + prospective memory

The palace could recall *what happened* (memories) and *what is true* (KG), but
was blind to *what tools I have* and *what I was in the middle of*. Both fixed.

- **`scanSkillsCatalog` saw 19 of 101 skills.** Two independent bugs. (1) It
  tested `Dirent.isDirectory()`, which is **false for a symlink to a
  directory** — 56 of the 75 entries in `~/.pi/agent/skills` are symlinks, so
  the entire `cognition-*` and `thinking-*` libraries were invisible,
  including `cognition-router` and `thinking-scientific-method`, the two the
  system prompt leans on hardest. (2) It scanned only that one directory,
  missing npm packages (`<pkg>/skills/<name>/`, plus an `@scope` level), git
  packages (`<owner>/<repo>/skills/<name>/`) and the unsymlinked remainder of
  the thinking library. Now walks four roots via `statSync` (follows
  symlinks), prunes nested `node_modules`, and dedupes by name with earlier
  roots winning. Verified against the live tree: **19 → 101**.
- **`session-resume`: prospective memory.** New L0.5 slot in `wakeup()` injects
  the project's single `session-resume` record — whole, chunk-family
  reassembled, above L1. Deliberately not left to L1 (`ORDER BY importance
  DESC LIMIT 15` over projects holding hundreds of 0.9+ memories, snippets
  clipped at 200 chars) nor to semantic auto-recall ("continue" is 8 chars,
  under the 30-char `autoRecallMinPromptChars` floor — prompt-driven recall
  never fires on the prompt that most needs it). Convention documented in
  `PROTOCOL.md`: exactly one per project, superseded not appended.
- **Claude Code hook parity.** `claude-first-prompt-explorer.mjs` now fetches
  the resume record deterministically via `--json` (the human `recall` output
  flattens newlines and truncates at 280 chars, decapitating the
  Next/Where/Blockers lines) and emits it on the first prompt of **any**
  length, on a marker independent of the exploration marker — so a session
  opening with "continue" gets the hand-off immediately and still explores on
  the next substantive request.
- Bench: legacy stage reproduces `baseline.json` exactly — 14/14 per-query
  picks and all `by_category` figures identical. Neither change touches recall
  ranking (the catalog feeds only gate skill-suggestions; the resume slot only
  wake-up assembly). Typecheck: no new errors (3 pre-existing `Theme` errors
  unchanged).


## 0.8.1 — 2026-07-20 — recall-gate observability + fail-closed mode + header-auth fix

The "noisy auto-recall" complaint traced to the 0.6.0 LLM gate being able to
fail SILENTLY open (any model/auth/timeout error → plain threshold injection,
indistinguishable from a real judgment). Three fixes:

- **`recall-gate.log`:** one line per auto-recall (`~/.pi/agent/memory/`),
  showing mode, picked/candidates, gate outcome (`ok` / `idle` /
  `FAILED(fell-open|fell-closed)`), auto vs gate-approved counts, and
  search/rerank/gate timings — silent behavior is now auditable.
- **`autoRecallGateFailMode` ("open"|"closed", default "open"):** "closed"
  injects only the auto-approve tier (cross-encoder >= 0.85) when the judge
  is unavailable — the gray zone is dropped, never guessed at. Verified
  against the live store with a null judge: open picked 4 (threshold rule),
  closed picked 3 (auto tier only), gray zone of 9 dropped.
- **Header-only auth accepted:** `buildGateJudge` required `auth.apiKey`,
  silently disabling the gate on OAuth-style providers; now `apiKey OR
  headers` suffices (matches what `complete()` actually needs).
- **Local config retargeted (not in repo):** gate provider/model switched to
  `openai-codex`/`gpt-5.4-mini` — the exact auth path memory-summarizer has
  proven working on this install — with `failMode: "closed"` and
  `autoRecallMaxResults` 4→3.
- Bench: legacy parity 13/14 vs baseline (q04 drift = two relevant weaver
  cost-optimization memories saved AFTER the baseline was recorded — store
  drift, not regression); gate-unit 23/23.


## 0.8.0 — 2026-07-20 — session-watchdog: 15-min cross-agent memory curation via gpt-5.6-terra

Background watchdog that keeps the palace *current* from live session data of
all four agents, replacing pi-only end-of-session summarization. Grilled and
approved design: pi-extension-hosted timer, codex-exec/terra summarizer,
additive-auto/destructive-queued apply policy, read-only Obsidian consult.

- **`watchdog/` core + `cli/watchdog.mjs` (new, standalone node):**
  - *Collectors* read new user+assistant dialogue (tool noise excluded) since
    per-session watermarks: Claude Code (`~/.claude/projects/*/*.jsonl`, byte
    offsets, sidechain/system-reminder entries skipped), pi
    (`~/.pi/agent/sessions/*/*.jsonl`), codex
    (`~/.codex/sessions/Y/M/D/rollout-*.jsonl`, `event_msg`
    user_message/agent_message), opencode (read-only better-sqlite3 over
    `~/.local/share/opencode/opencode.db` session/message/part,
    `time_created` watermarks). JSONL offsets only ever advance past complete
    lines; partial trailing lines stay unconsumed.
  - *Seeding:* first run watermarks every existing source at EOF (no
    surprise backfill of history; `tick --backfill <hours>` reaches back
    deliberately). Sources appearing later are new sessions and start at 0.
  - *Worth-it gate:* >=10KB new dialogue AND >=5 min quiet, max 4 sessions
    per tick, oldest first; zero-dialogue (pure tool noise) deltas advance
    their watermark without a model call. Config overrides via
    `watchdog*` keys in `~/.pi/agent/memory/config.json`;
    `watchdogEnabled: false` is the kill switch.
  - *Summarizer:* `codex exec --sandbox read-only -m gpt-5.6-terra -c
    model_reasoning_effort="high" --output-last-message <tmp> -` (prompt on
    stdin, existing ChatGPT auth). Prompt carries the delta, related
    memories WITH real ids/importance, project KG facts, canonical project
    list, a read-only Obsidian hub-note excerpt, and the PROTOCOL.md write
    conventions; contract is strict JSON
    (memories/kg_facts/supersedes/kg_invalidations/doubts). Fail-closed: any
    codex error or unparseable output leaves the watermark untouched — the
    delta retries next tick.
  - *Apply policy — additive auto, destructive queued:* auto = new memories
    (importance clamped <=0.85, near-dupe skip at >=0.92 similarity), new KG
    facts (exact-active-dupe skip), high-confidence supersedes of
    sub-0.85-importance memories, high-confidence kg invalidations. Queued to
    `watchdog-review.json` = everything touching >=0.85 memories,
    low-confidence changes, all doubts, session-vs-Obsidian disagreements.
    Unknown target importance is treated as high (queued) by construction.
  - Verified end-to-end on a synthetic 14KB session: gate split
    eligible/below-gate/live-session correctly; terra (25s) returned
    contract-clean JSON and — unprompted — routed unverified implementation
    claims to doubts instead of memories.
- **`extensions/session-watchdog.ts` (new) + shim in
  `~/.pi/agent/extensions/`:** schedules `watchdog.mjs tick` every 15 min
  (first 2 min after session start), detached; the CLI's own 15-min-stale
  cross-process lock makes multi-instance scheduling safe. When the review
  queue is non-empty, appends a one-time system-prompt block instructing the
  agent to walk the user through each item via AskUserQuestion at the next
  natural pause and apply verdicts with `watchdog.mjs apply-review`.
  `/memory-watchdog tick|status|review` for manual control.
- **memory-summarizer handover:** its automatic session_shutdown /
  session_before_compact distills are disabled (early-return unless
  `PI_MEMSUM_AUTO=1`); manual `/memory-summarize` unchanged. One pipeline,
  one watermark store, no duplicate pi summaries.
- **Bedrock auth fixes (outside repo, recorded here):**
  `~/.local/bin/pi` wrapper's SSO expiry scan now keys off the NEWEST
  `~/.aws/sso/cache` token instead of the earliest — stale cache files made
  it nag "expiring in N min" (huge/negative N) every 5 min even after a
  successful login — and the displayed minutes are clamped at 0.
  `extensions/bedrock-profiles.ts` now records `lastAttemptAt` on FAILED
  exports too, so a dead SSO session backs off 30s instead of erroring every
  turn. No session auto-reload: credentials are process-env-level and
  re-resolved lazily per turn; restarting the session would only destroy
  context.

## 0.7.0 — 2026-07-20 — cross-agent protocol, first-prompt explorer subagent for Claude Code, CLI kg-invalidate

Extends the palace's non-blind retrieval + disciplined writing to the *other*
agents sharing the store (Claude Code, opencode, codex). No extension changes —
pi's pinned install (`@4299d94`, v0.6.0 behavior) is untouched; everything here
is CLI/hooks/docs, live immediately via the fork-repo paths.

- **`hooks/claude-first-prompt-explorer.mjs` (new):** Claude Code
  `UserPromptSubmit` hook. On the first substantive prompt of a session (>=30
  chars, not a slash command, once per session_id via a tmpdir marker) it
  spawns a headless Haiku subagent (`claude -p --model claude-haiku-4-5`,
  Bash restricted to `node`, 90s cap, cwd=tmpdir so no project settings load)
  that explores the store agentically — `projects` taxonomy, 2-4 differently
  phrased searches, `kg-query` on surfaced entities, project `recall` — and
  distills only what changes the approach to the actual request into a
  `<memory-palace-context>` block, which the hook prints for injection.
  Replaces one-shot blind semantic search over the raw prompt (the same
  false-positive/false-negative failure mode the 0.6.0 rerank work measured
  in pi, attacked here with agentic exploration instead of an in-process
  pipeline, since Claude Code hooks can run a full subagent). Degrades
  honestly: `claude` missing/timeout/non-zero → deterministic multi-probe
  fallback (semantic search + recent same-project memories); subagent says
  `NO_RELEVANT_MEMORY` → injects nothing (no fallback — that's a verdict,
  not a failure); any unexpected error → exit 0, no output. Recursion-guarded
  via `MEMPALACE_EXPLORER=1` (the nested session's own UserPromptSubmit hook
  sees it and exits). Narration the model prefixes before its first bullet is
  stripped post-hoc. Registered in `~/.claude/settings.json` with timeout 120.
- **`cli/mempalace.mjs`: new `kg-invalidate <subj> <pred> <obj> [--to DATE]`.**
  Closes the CLI/pi asymmetry: pi always had `knowledge_invalidate`, so only
  pi could end a superseded fact — Claude/opencode/codex could only pile up
  contradictory active triples. Resolves by name via the store's existing
  `findTriple` (active-only, most recent) + `invalidateTriple`; errors clearly
  when no active fact matches. Verified round-trip in a `MEMPALACE_HOME` temp
  store: add → invalidate --to → re-add → `--at` queries resolve each era
  correctly, double-invalidate fails loudly.
- **`PROTOCOL.md` (new):** canonical cross-agent recall/save/KG protocol —
  explore-don't-one-shot recall method, save hygiene (self-contained, tagged,
  importance scale, supersede-don't-duplicate), KG conventions (canonical
  lowercase-kebab entities, controlled predicate vocabulary, temporal honesty
  via invalidate+re-add, memory-vs-triple granularity test). The per-agent
  instruction blocks (`shared-memory-palace` skill, `~/.codex/AGENTS.md`,
  `~/.config/opencode/AGENTS.md`, `~/.pi/agent/APPEND_SYSTEM.md`) are
  summaries of this file and defer to it on drift.

## 0.6.0 — 2026-07-13 — cross-encoder rerank + LLM relevance gate for auto-recall

### Diagnosis (bench/results/baseline.json)

The 0.4.0 auto-recall pipeline (bi-encoder similarity floor only, 0.5) had two
failure modes visible in the bench harness (`bench/run-bench.mjs`):

- **False positives:** cross-project junk at sim 0.50-0.55 got injected (e.g.
  "fix the failing test" pulled a `salesappweb` Flutter memory at 0.5095 with
  no connection to the current project).
- **False negatives:** genuinely relevant memories sat just below the 0.5
  floor (q03's correct memory at 0.467-0.490 sim, q13's at 0.386) and were
  silently dropped.

### Changes

- **`extensions/pi-mempalace/recall.ts` (new):** the auto-recall selection
  pipeline extracted into `selectRecall(store, query, opts)`, shared by
  `index.ts`'s `before_agent_start` hook and `bench/run-bench.mjs` — bench and
  production now run the exact same code, not a hand-ported copy.
- **`extensions/pi-mempalace/reranker.ts` (new):** lazy-loaded cross-encoder
  singleton (`Xenova/ms-marco-MiniLM-L-6-v2` via `@huggingface/transformers`).
  Re-scores the candidate pool `store.search()` returns — much stronger
  relevance judge near the decision boundary than bi-encoder cosine
  similarity, at the cost of being too slow to run over the whole store.
- **New retrieval design:** wider candidate pool (`autoRecallCandidates`, 24)
  with a lower bi-encoder floor (`autoRecallCandidateFloor`, 0.45) to catch
  the false negatives, then the cross-encoder is the real relevance gate
  (`autoRecallRerankMinScore`), with a same-vs-cross-project penalty
  (`autoRecallCrossProjectPenalty`, 0.08) applied on top to suppress the
  false positives. Falls open to the pre-existing similarity-only ("legacy")
  path on any reranker error — auto-recall must never block the agent loop.
- **Reranker warm-up:** background warm-up at session start alongside the
  existing embedder warm-up, so the first real recall doesn't pay model-load
  latency.
- **New config** (`~/.pi/agent/memory/config.json`):
  `autoRecallMinPromptChars` raised 15 → 30; new `autoRecallCandidates` (24),
  `autoRecallCandidateFloor` (0.45), `autoRecallCrossProjectPenalty` (0.08),
  `autoRecallRerank` (default true), `autoRecallRerankMinScore` (0.35 —
  tuned from the bench v2-rerank cross-encoder score distribution).
- **`bench/run-bench.mjs`:** new `--stage legacy|v2` flag. `legacy` reproduces
  the exact pre-rerank picks (verified against `bench/results/baseline.json`,
  14/14 queries match) for regression-checking the legacy path stays
  faithful; `v2` exercises the new defaults end-to-end, including per-query
  `search_ms`/`rerank_ms` timings and full candidate score breakdowns
  (bi-encoder sim, cross-encoder score, penalty, final score) for tuning
  `autoRecallRerankMinScore`.

### Tuning + same-project floor (bench v2-rerank → v3)

- **`autoRecallRerankMinScore` 0.35 → 0.40:** tuned from the bench v2-rerank
  cross-encoder score distribution, which turned out cleanly bimodal —
  relevant candidates score 0.65+, junk scores <0.02. 0.40 sits in the empty
  middle with margin either side.
- **New `autoRecallCandidateFloorSameProject` (0.35):** bench q13 showed a
  same-project relevant memory (pi-config, sim 0.386) never reaching the
  cross-encoder because it sat below the single 0.45 bi-encoder floor.
  Same-project candidates now pass at 0.35; cross-project candidates keep the
  0.45 floor (they're already suppressed by `autoRecallCrossProjectPenalty`
  downstream, so a lower floor there would just waste cross-encoder calls on
  noise). Re-running q13 confirms the mechanism works — the previously
  unreachable candidate now gets cross-encoded — but its actual ce scores
  (0.00012 and 0.0028 for the two pi-config candidates in the pool) are far
  below relevance for this exact query wording, so it's still correctly not
  injected. The same-project floor did rescue real picks elsewhere: q01,
  q03, q04, q06 each gained one newly-eligible same-project candidate with a
  high ce score (0.68-0.94), and in q01/q03 that pick outranked and displaced
  a previously-picked lower-ce-score candidate under the `autoRecallMaxResults`
  cap — an expected consequence of widening the pool, not a bug.
- **`reranker.ts`:** `rerank()` keeps the one-`(query, text)`-pair-per-call
  loop as a *deliberate*, measured choice. Batching all pairs into a single
  `tokenizer()` + `model()` call (transformers.js `text_pair` array form)
  was implemented and verified score-equivalent (max abs diff ~1.9e-7 across
  3- and 20-pair spot checks), but on this single-threaded CPU/WASM
  onnxruntime backend it was consistently ~30-60% *slower*: ~450-510ms
  looped vs ~555-770ms batched on a realistic 20-pair variable-length
  (320-917 char) candidate pool, across 3 controlled runs on identical
  input. Root cause: batching pads every pair up to the batch's longest
  sequence, and the extra attention FLOPs spent on padding tokens cost more
  than the per-call overhead batching saves on this runtime (length-sorting
  and chunk-size-4 batching narrowed but never closed the gap). The batched
  path was removed rather than kept as dead code; revisit only on a backend
  with real batch parallelism (GPU/multi-threaded), re-measuring there
  first.

### LLM relevance gate (Haiku)

Rerank alone still leaves a "gray zone" where the cross-encoder score is
genuinely ambiguous (not obviously junk, not obviously relevant) and a
numeric threshold has to guess. New optional gate: send gray-zone candidates
to a cheap model and let it actually read the message and decide.

- **`extensions/pi-mempalace/gate.ts` (new):** pure, pi-import-free prompt
  building (`buildGatePrompt`) and tolerant response parsing
  (`parseGateResponse`) — unit tested in `bench/gate-unit.mjs` (23/23
  passing) independent of any model or store.
- **`recall.ts` gray-zone partition:** after reranking, floor-survivors split
  into auto-approve (`finalScore >= autoRecallGateAutoApprove`, 0.85),
  auto-reject (`< autoRecallGateMinScore`, 0.15, never sent to the gate), and
  gray zone (everything between). If gating is enabled and the gray zone is
  non-empty, up to `autoRecallGateMaxCandidates` (10) gray-zone candidates go
  to the gate in one call; `approved = auto-approved ∪ gate-approved`, then
  the existing budget/`autoRecallMaxResults` pick loop runs over that set.
  Empty gray zone → the gate is never called (auto-approve-only is
  equivalent to the plain threshold rule there by construction). Any gate
  failure — model not found, no auth, timeout, network error, unparseable
  response — resolves to `null` and `selectRecallRerank` falls all the way
  open to the plain `autoRecallRerankMinScore` rule over every
  floor-survivor, i.e. exactly the pre-gate (v2) behavior. `selectRecall`
  still takes zero `pi-ai`/`pi-coding-agent` imports — the caller supplies a
  `gate.judge` closure, so `bench/run-bench.mjs` can drive the same partition
  logic with a mock judge (`--stage v3 --gate-mock none|approve-all|reject-all`)
  with no network calls.
- **`index.ts` judge closure:** built per-prompt in `before_agent_start`,
  following the exact pattern in
  `~/.pi/agent/extensions/memory-summarizer.ts` — `ctx.modelRegistry.find(provider, id)`,
  `ctx.modelRegistry.getApiKeyAndHeaders(model)`, `complete()` with an
  `AbortController` timeout (`autoRecallGateTimeoutMs`, 2500ms),
  temperature 0, 300 max tokens. `ExtensionContext` (passed to every
  extension event handler) exposes `modelRegistry` directly, so no extra
  wiring was needed to reach it from this extension. Every error path
  returns `null` (fail open); the closure never throws.
- **Skill suggestions:** at session start, if `autoRecallGateSuggestSkills`
  is on, `~/.pi/agent/skills/*/SKILL.md` frontmatter is scanned for
  `name:`/`description:` (description truncated to 200 chars) and cached for
  the session. The catalog is only handed to the gate when a gate call
  actually happens (non-empty gray zone). Up to 2 suggested skill names are
  appended to the injected recall message: "Possibly relevant skills for
  this request: … (load if applicable)."
- **New config** (`~/.pi/agent/memory/config.json`): `autoRecallLlmGate`
  (default `true`), `autoRecallGateProvider` (`"anthropic"`),
  `autoRecallGateModel` (`"claude-haiku-4-5"`), `autoRecallGateTimeoutMs`
  (2500), `autoRecallGateAutoApprove` (0.85), `autoRecallGateMinScore`
  (0.15), `autoRecallGateMaxCandidates` (10), `autoRecallGateSuggestSkills`
  (default `true`); plus `autoRecallRerankMinScore` retuned 0.35 → 0.40 and
  new `autoRecallCandidateFloorSameProject` (0.35) from the tuning pass
  above.
- **`bench/run-bench.mjs`:** new `--stage v3` (v2 params + gate partition,
  driven by `--gate-mock none|approve-all|reject-all` instead of a real
  model call — validates plumbing only) and `bench/gate-unit.mjs` (pure unit
  tests for `gate.ts`, no store/model access).

## 0.5.0 — 2026-07-10 — standalone CLI, relocatable store, audit fixes

Prompted by deploying the palace on a second machine (no pi installed) and a
code audit of v0.4.0. Two themes: portability, and correctness bugs the audit
surfaced.

### New: `cli/mempalace.mjs` — the CLI now lives in the repo

The previous CLI (`~/.pi/agent/memory/cli/mempalace.mjs`) was a hand-written
re-implementation outside the repo. It had already drifted: pure-similarity
ranking (pre-0.3.0), no chunk-family dedupe, and `LIMIT n` fetches that made
re-ranking impossible — CLI users got the exact retrieval pollution 0.3.0
fixed, against the same DB. The new CLI is a thin wrapper that imports
`MemoryStore` from `memory_store.ts` directly (Node ≥ 22.18 native
type-stripping), so CLI semantics are the engine's semantics, permanently.

- Commands: `search`, `save`, `recall`, `status`, `projects`, `kg-add`,
  `kg-query`, plus new **`forget <id>`** (family-aware delete via
  `MemoryStore.delete`).
- Bootstraps a fresh store: `MemoryStore.load()` creates the directory and
  full schema when `memories.db` is absent (the old CLI refused to start).
- Needs only the three runtime deps — install with
  `npm install --omit=dev --omit=peer` to skip the pi runtime packages.

### New: `MEMPALACE_HOME` — relocatable store

`memory_store.ts` and `index.ts` resolve the memory directory from
`$MEMPALACE_HOME` when set (fallback unchanged: `~/.pi/agent/memory`). Lets a
deployment keep DB + identity + config next to a project instead of ~/.pi.

### Fixed (audit findings)

- **`autoCapture` now defaults to `false`** (`index.ts defaultConfig`). A
  fresh install with no `config.json` used to silently re-enable the exact
  0.5-importance capture noise that 0.3.0 existed to clean up.
- **`busy_timeout = 5000` in `MemoryStore.load()`**: several agents share one
  WAL DB; concurrent writes used to throw `SQLITE_BUSY` instantly.
- **Chunk-family orphans**: chunk `content_hash` is now scoped by family+index
  (`contentHash(`${baseHash}_c${i}\n${chunk}`)`). Previously a chunk
  byte-identical to one from a *different* memory was skipped by the global
  UNIQUE hash; if that chunk was c0, the whole family vanished from recall,
  wakeup, and search's c0-prefix (all filter `chunk_index = 0`). Same-content
  re-saves still dedupe via the chunk-id check.
- **Single-chunk `store()` race**: the insert is now wrapped in try/catch —
  two agents saving identical content concurrently gets `{status:"duplicate"}`
  instead of a user-visible UNIQUE-violation error (matches the multi-chunk
  path).
- **KG temporal dates normalized to `YYYY-MM-DD`** (`toKgDate`): `valid_from`
  / `valid_to` / `at_time` are compared lexicographically, and mixing
  date-only with full-ISO values broke boundary days ("2025-06-01" >=
  "2025-06-01T12:00:00Z" is false — a fact wrongly excluded on its last valid
  day). Defaults that meant "today" now use **local** time (`localToday()`),
  not UTC (off by a day east of GMT).
- **Filtered search under-return**: project/topic filtering happens after the
  ANN fetch; if a small project's memories sat outside the global top-50 by
  distance, a filtered search returned nothing despite matches. The candidate
  pool now widens once (to 2000) when a filtered search starves.
- **`addEntity` no longer clobbers** `entity_type`/`properties` with
  "unknown"/"{}" on update when the caller doesn't supply them (every
  `addTriple` auto-create used to reset them).
- **Home-dir fallback**: literal `"~"` path fallback replaced with
  `os.homedir()`.

### Packaging

- `package.json`: version 0.5.0, `engines.node >= 22.18`, `cli/` shipped in
  `files`, `package-lock.json` committed for reproducible installs.

## 0.4.0 — 2026-07-07 — auto-recall + always-on memory instructions

### Diagnosis

"Pi sometimes doesn't search memory" had three causes:

1. Retrieval was 100% model-initiated — nothing recalled memory per user
   message, so recall depended on the model *choosing* to call `memory_search`.
2. `memory_search`'s prompt guidelines only triggered on "user asks about past
   decisions", not on starting work that depends on prior sessions.
3. The whole "Agent Memory (ACTIVE)" instruction block was gated on
   `wakeUpText` being non-null — an empty wake-up digest (fresh project, or a
   wake-up error at session start) silently dropped every memory instruction
   from the system prompt.

### Changes (`extensions/pi-mempalace/index.ts`)

- **Auto-recall (new):** on `before_agent_start`, the user prompt is
  semantically searched against the store (blended ranking); hits above a
  similarity floor are injected as a persistent `pi-mempalace-recall` message.
  - Injected as a *message* (conversation tail), not a system-prompt mutation,
    so the provider prompt cache stays valid across turns.
  - Per-session dedupe by memory id — the same memory is never injected twice.
  - Greedy char budget; fail-open (recall can never block the agent loop).
  - Config (`~/.pi/agent/memory/config.json`): `autoRecall` (default true),
    `autoRecallMinSimilarity` (0.5), `autoRecallMaxResults` (4),
    `autoRecallMaxChars` (2400), `autoRecallMinPromptChars` (15).
- **Decoupled instructions from wake-up:** the memory instruction block now
  injects whenever the backend is available; only the digest itself is gated
  on `wakeUpEnabled` + non-empty `wakeUpText`.
- **Embedder warm-up:** background dummy search at session start so the first
  auto-recall doesn't pay the embedding-model load latency.
- **Broader `memory_search` guidelines:** proactively search when starting
  work on a known project; auto-recall only covers the latest message.
- **Taxonomy injection gated + shrunk** (integrates remote `6188790`, applies
  the 2026-06-28 harness-audit recommendation): new config `taxonomyEnabled`
  (default true) and `taxonomyMaxChars` (default 2000, was hardcoded 3500).

## 0.3.1 — 2026-06-28 — direct git-package install compatibility

- Updated extension imports from legacy `@mariozechner/*` package names to current
  `@earendil-works/*` package names used by pi `0.80.x`.
- Updated peer/dev dependencies accordingly and removed the direct `@sinclair/typebox`
  peer by importing `Type` from `@earendil-works/pi-ai`.
- Intended install mode is a pinned git package source in `~/.pi/agent/settings.json`,
  replacing the older `npm:pi-mempalace` + `apply.sh` patched-runtime bridge.

## 0.3.0 — 2026-06-23 — retrieval-pollution fix

### Diagnosis

The store had grown to **5,527 memories**, of which **4,585 (83%)** were
`source='auto-capture'` at `importance 0.5` (verbatim conversation-turn dumps;
2,392 still in `topic='general'`). Auto-capture had already been turned **off**
in config, which stopped *new* noise but **never removed the existing rows**.

Root cause of "retrieval keeps surfacing old session data even after cleanup":

- `MemoryStore.search()` ranked results **purely by vector L2 distance** — no
  weighting on `importance`, `source`, or recency, and no default project
  scoping. So the 4,585 noise rows competed on equal footing with the ~900
  curated memories and routinely won.
- Wake-up / L1 (`generateL1`) already orders by `importance DESC`, so the 0.5
  rows stayed out of the wake-up block — confirming the pollution was in
  **search**, not wake-up.
- Vector tables were consistent (memories == vec_memories, 0 orphans), so the
  problem was ranking + retained noise, not index corruption.

### Changes (`extensions/pi-mempalace/`)

**`memory_store.ts`**

- `SearchResult` gains an `importance: number` field (populated in `search`,
  `recall`, `traverseTunnel`, `diaryRead`).
- `search()`:
  - new option `rank?: "blended" | "similarity"` (default `"blended"`).
  - always over-fetches a candidate pool of `max(n_results × 10, 50)` before
    re-ranking (previously only when filters were present), so the importance
    blend can actually re-order results.
  - selects `importance` and ranks by `similarity × importance` for `"blended"`;
    `"similarity"` preserves the old pure-distance order.
  - the displayed/returned `similarity` is still the true cosine similarity;
    only the ordering changes.
- `checkDuplicate()` now calls `search(..., { rank: "similarity" })` so
  duplicate detection keeps using the true nearest match.
- new `pruneBySource(source, { dryRun? })`: deletes matching rows from **both**
  `memories` and `vec_memories` in one transaction (no orphaned vectors),
  invalidates the L1 cache. Not registered as an agent tool.

**`index.ts`**

- `memory_search` output shows importance: `[project/topic] (72.3% match · imp 0.85, ts)`.

### One-time data cleanup (separate from code)

- Backed up `memories.db` (+ `-wal`, `-shm`) to
  `~/.pi/agent/cleanup-backups/memstore-<ts>/`.
- Ran `pruneBySource("auto-capture")`: **deleted 4,585 rows** (5,527 → 942).
- `wal_checkpoint(TRUNCATE)` + `VACUUM`: DB 14.98 MB → 10.67 MB.
- Post-state: 942 memories, 942 vectors, 0 orphans, `topic='general'` = 0.
  Remaining sources: manual-save 782, cli 139, diary 13, session-summary 6,
  jcode-session 2.

### Validated impact

Top-8 `memory_search` results, auto-capture count, old → new ranking:
weaver query 8→0, prism 7→0, datadog 6→0, memory-palace 8→0.
