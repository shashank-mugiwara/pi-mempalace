# Fork changelog

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
