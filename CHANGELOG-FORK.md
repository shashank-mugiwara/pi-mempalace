# Fork changelog

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
