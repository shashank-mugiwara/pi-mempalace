# Fork changelog

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
