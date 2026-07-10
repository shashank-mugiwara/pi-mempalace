# pi-mempalace (shashank-mugiwara fork)

Persistent agent memory for **pi** — raw verbatim storage with semantic search,
a knowledge graph, palace tunnels, and a diary. This is a **fork of the
[Jabbslad/pi-mempalace](https://github.com/Jabbslad/pi-mempalace) lineage**
(SQLite + sqlite-vec backend, single store at `~/.pi/agent/memory/memories.db`
or `$MEMPALACE_HOME`), patched to fix a retrieval-pollution problem and since
grown: per-prompt auto-recall (0.4.0) and a standalone CLI that runs the same
engine without pi (0.5.0).

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

Full diagnosis and detail per release in [`CHANGELOG-FORK.md`](./CHANGELOG-FORK.md).

- **0.3.0 — retrieval-pollution fix.** `search()` ranks by
  `similarity × importance` instead of raw vector distance, over a candidate
  pool of `max(n×10, 50)`, so low-value memories (0.5 auto-capture) sink below
  curated ones (0.8+) without being excluded. `rank: "blended" | "similarity"`
  option (`"similarity"` used internally by duplicate detection); `importance`
  surfaced in results (`… % match · imp 0.85 …`). Plus `pruneBySource()` —
  safe bulk delete from both `memories` and the `vec0` index in one
  transaction (admin method, not an agent tool).
- **0.4.0 — auto-recall.** Each user prompt is semantically matched against
  the store on `before_agent_start`; hits above a similarity floor inject as a
  `pi-mempalace-recall` message (prompt-cache-friendly, per-session dedupe,
  fail-open). Memory instructions no longer silently drop when the wake-up
  digest is empty; taxonomy injection gated and shrunk; embedder warm-up at
  session start.
- **0.5.0 — standalone CLI + audit fixes.** `cli/mempalace.mjs` joins the repo
  as a thin wrapper over `MemoryStore` (Node ≥ 22.18 type-stripping) — same
  ranking/dedupe/chunking as the extension, no pi required, bootstraps a fresh
  store, adds `forget <id>`. `MEMPALACE_HOME` relocates the store. Audit
  fixes: `autoCapture` defaults **false**; `busy_timeout=5000` for
  multi-agent WAL concurrency; family-scoped chunk hashes (c0-orphan fix);
  concurrent duplicate saves return `duplicate` instead of throwing; KG
  temporal dates normalized to local `YYYY-MM-DD` (boundary-day fix);
  filtered search widens its pool instead of starving; `addEntity` stops
  clobbering `entity_type`/`properties`.

Everything else (tools, knowledge graph, diary, tunnels, wake-up) is unchanged
from upstream.

## Standalone use (no pi)

The CLI drives the same engine and store without a pi installation:

```bash
git clone https://github.com/shashank-mugiwara/pi-mempalace && cd pi-mempalace
npm install --omit=dev --omit=peer     # just better-sqlite3, sqlite-vec, transformers

# optional: relocate the store (default ~/.pi/agent/memory)
export MEMPALACE_HOME=/path/to/memory

node cli/mempalace.mjs save "content" --project p --topic t --importance 0.8 --source note.md
node cli/mempalace.mjs search "natural language query" --project p -n 5 --json
node cli/mempalace.mjs kg-add "subject" "predicate" "object" --from 2026-01-01
node cli/mempalace.mjs kg-query "subject" --at 2026-06-01
node cli/mempalace.mjs forget mem_<id>
node cli/mempalace.mjs status
```

Requires Node ≥ 22.18. First embedding call downloads the ~90 MB
`all-MiniLM-L6-v2` model once; everything is local thereafter. A missing
database is created with the full schema on first use.

## Validated impact

Measured on the live store (4 representative queries, top-8 results):

| query | auto-capture in top-8 (old → new) |
|---|---|
| weaver runner cloudformation cost | 8 → 0 |
| prism architecture generate-docs | 7 → 0 |
| datadog observability experiment | 6 → 0 |
| pi memory palace cleanup | 8 → 0 |

## Deployment in this setup

- **Runtime (what pi loads):** a pinned git package clone managed by pi from
  `git:github.com/shashank-mugiwara/pi-mempalace@<commit>`.
- **Source of truth (version control):** this repo / GitHub fork. Pi should not
  load the upstream `npm:pi-mempalace` package in this setup.
- **Old bridge retired:** the earlier `npm:pi-mempalace` + [`./apply.sh`](./apply.sh)
  patched-runtime workflow is kept only as historical fallback. The clean path is
  one git package source in `~/.pi/agent/settings.json`.

Example settings entry:

```json
{
  "source": "git:github.com/shashank-mugiwara/pi-mempalace@<commit>",
  "extensions": ["+extensions/pi-mempalace/index.ts"],
  "skills": ["+skills/memory-setup/SKILL.md"]
}
```

## Memory is model-managed

Auto-capture is **off — and since 0.5.0, off by default** (a fresh install
with no `config.json` no longer silently re-enables it). The model saves what
matters via `memory_save` / `knowledge_add` / `memory_diary_write`; a separate
`memory-summarizer` extension is the backstop. This fork's ranking change
keeps any residual low-value rows from surfacing.

---

Upstream README preserved as [`README.upstream.md`](./README.upstream.md).
