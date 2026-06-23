# pi-mempalace (shashank-mugiwara fork)

Persistent agent memory for **pi** — raw verbatim storage with semantic search,
a knowledge graph, palace tunnels, and a diary. This is a **fork of the
[Jabbslad/pi-mempalace](https://github.com/Jabbslad/pi-mempalace) lineage**
(SQLite + sqlite-vec backend, single `~/.pi/agent/memory/memories.db`), patched
to fix a retrieval-pollution problem.

> ⚠️ This is **not** the SurrealDB-based `@sinamtz/pi-mempalace` rewrite. That
> code is preserved on the [`sinamtz-upstream`](../../tree/sinamtz-upstream)
> branch / `sinamtz-v0.2.7` tag for reference. `main` is the Jabbslad lineage,
> which is what actually runs in this setup.

## Why this fork exists

The upstream store works by **storing everything and ranking search purely by
vector distance**. Combined with the old auto-capture (every conversation turn
written at `importance 0.5`), the store filled with low-value "session data"
that **dominated `memory_search`** — even after manual cleanups, because nothing
demoted it. See [`CHANGELOG-FORK.md`](./CHANGELOG-FORK.md) for the full diagnosis.

## What changed vs upstream v0.2.0

All changes are in `extensions/pi-mempalace/`:

1. **Importance-blended search ranking** (`memory_store.ts` → `search()`).
   Results are now ranked by `similarity × importance` instead of raw vector
   distance. Low-value memories (0.5) sink below curated ones (0.8+).
   - Nothing is excluded — everything stays searchable, the noise just stops
     winning. A `rank: "blended" | "similarity"` option is added; `"blended"`
     is the default, `"similarity"` is used internally by duplicate detection.
   - Search now always over-fetches a candidate pool (`max(n×10, 50)`) so the
     blend can actually re-order, then trims to `n`.
   - The true cosine `similarity` is still returned/displayed; only the
     ordering changes. `importance` is now included in each `SearchResult` and
     shown in the tool output (`… % match · imp 0.85 …`).

2. **Safe bulk-prune** (`memory_store.ts` → `pruneBySource()`). Deletes from
   **both** the `memories` table and the `vec_memories` vector index in one
   transaction, so no orphaned vectors are left behind (the raw `sqlite3` CLI
   cannot clean the `vec0` index). Supports `{ dryRun: true }`. Not exposed as
   an agent tool — it is an admin/maintenance method.

Everything else (tools, knowledge graph, diary, tunnels, wake-up, auto-capture
hook) is unchanged from upstream.

## Validated impact

Measured on the live store (4 representative queries, top-8 results):

| query | auto-capture in top-8 (old → new) |
|---|---|
| weaver runner cloudformation cost | 8 → 0 |
| prism architecture generate-docs | 7 → 0 |
| datadog observability experiment | 6 → 0 |
| pi memory palace cleanup | 8 → 0 |

## Deployment in this setup

- **Runtime (what pi loads):** `~/.pi/agent/npm/node_modules/pi-mempalace/`
  (installed via the `npm:pi-mempalace` entry in `~/.pi/agent/settings.json`).
  The fix is applied there so it takes effect on the next pi restart, and the
  prebuilt native `better-sqlite3` is reused.
- **Source of truth (version control):** this repo, checked out locally under
  `~/.pi` and pushed to GitHub.
- **Recovery after a pi reinstall/update:** run [`./apply.sh`](./apply.sh) to
  re-copy the patched extension files into the runtime.

```bash
./apply.sh        # repo → ~/.pi/agent/npm/node_modules/pi-mempalace, then restart pi
```

## Memory is model-managed

Auto-capture is **off** (`~/.pi/agent/memory/config.json` → `autoCapture:false`).
The model saves what matters via `memory_save` / `knowledge_add` /
`memory_diary_write`; a separate `memory-summarizer` extension is the backstop.
This fork's ranking change keeps any residual low-value rows from surfacing.

---

Upstream README preserved as [`README.upstream.md`](./README.upstream.md).
