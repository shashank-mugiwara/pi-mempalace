#!/usr/bin/env node
/**
 * mempalace.mjs — standalone CLI over the pi-mempalace memory store.
 *
 * A thin wrapper around the extension's own MemoryStore (imported directly
 * from memory_store.ts via Node's native type-stripping), so CLI reads and
 * writes carry the exact same semantics as the pi extension: blended
 * similarity×importance ranking, chunk-family dedupe, c0 context prefixing,
 * family-aware delete, schema bootstrap on first open.
 *
 * Requires Node >= 22.18 (type-stripping on by default). No pi installation
 * needed — only better-sqlite3, sqlite-vec and @huggingface/transformers.
 *
 * Store location: $MEMPALACE_HOME if set, else ~/.pi/agent/memory.
 * A missing database is created (empty) on first use.
 *
 * Usage:
 *   node mempalace.mjs <command> [options]
 *
 * Commands:
 *   search   <query> [--project P] [--topic T] [-n N] [--json]
 *   save     <content> [--project P] [--topic T] [--importance F] [--source S]
 *   recall   [--project P] [--topic T] [-n N] [--json]
 *   forget   <id>                      Delete a memory (family-aware)
 *   status   [--json]
 *   projects [--json]
 *   kg-add   <subject> <predicate> <object> --project P [--subject-type T] [--object-type T] [--from DATE] [--to DATE]
 *   kg-query <entity> [--at DATE] [--project P] [--json]
 *   kg-invalidate <subject> <predicate> <object> [--to DATE]
 *   kg-type  <entity> <type>           Set an entity's type
 *   kg-untyped [--project P] [-n N]    Entities still typed unknown
 *   kg-backfill-types                  Type unknown entities from their existing is_a facts
 *
 * Run `node mempalace.mjs --help` for full details.
 */

import { isNonProjectName, localToday, MemoryStore } from "../extensions/pi-mempalace/memory_store.ts";

const store = new MemoryStore();

// --- Commands --------------------------------------------------------------

async function cmdSearch(query, opts) {
  if (!query) fail("search requires a <query>");
  const n = Math.min(parseInt(opts.n || "5", 10), 20);
  const result = await store.search(query.trim(), {
    project: opts.project || undefined,
    topic: opts.topic || undefined,
    n_results: n,
  });
  emit(opts, result, () =>
    result.results
      .map(
        (r) =>
          `[${r.similarity} · imp ${r.importance}] (${r.project}/${r.topic}) ${r.timestamp}\n  ${r.text.replace(/\n/g, " ").slice(0, 280)}`
      )
      .join("\n\n") || "No results."
  );
}

/**
 * Writers require a real project. "general", the home folder, Documents, tmp…
 * are working directories, not projects, and memories filed there were never
 * found again (the 2026-09-04 audit turned up 46 such rows).
 */
function requireProject(opts, cmd) {
  const p = opts.project;
  if (isNonProjectName(p)) {
    fail(
      `${cmd} needs --project <canonical name>` +
        (p ? ` ("${p}" is a working directory, not a project)` : "") +
        ". Run `projects` to see the names in use."
    );
  }
  return p;
}

async function cmdSave(content, opts) {
  if (!content || !content.trim()) fail("save requires <content>");
  const project = requireProject(opts, "save");
  const result = await store.store({
    content: content.trim(),
    project,
    topic: opts.topic || "general",
    source: opts.source || "cli",
    importance: opts.importance != null ? parseFloat(opts.importance) : 0.5,
  });
  emit(opts, result, () => `${result.status}: ${result.id}`);
}

function cmdRecall(opts) {
  const n = Math.min(parseInt(opts.n || "10", 10), 50);
  const result = store.recall({
    project: opts.project || undefined,
    topic: opts.topic || undefined,
    n_results: n,
  });
  emit(opts, result, () =>
    result.results
      .map(
        (r) =>
          `${r.id}\n  (${r.project}/${r.topic}) ${r.timestamp}\n  ${r.text.replace(/\n/g, " ").slice(0, 280)}`
      )
      .join("\n\n") || "No memories."
  );
}

function cmdForget(id, opts) {
  if (!id) fail("forget requires a memory <id>");
  const result = store.delete(id);
  emit(opts, result, () => `deleted: ${result.id} (${result.rows} row${result.rows === 1 ? "" : "s"})`);
}

function cmdStatus(opts) {
  const result = store.status();
  let kg = null;
  try {
    kg = store.knowledgeStats();
  } catch {
    /* KG tables absent in very old DBs */
  }
  emit(opts, { ...result, knowledge_graph: kg }, () => {
    const projects = Object.entries(result.projects)
      .sort(([, a], [, b]) => b - a)
      .map(([p, c]) => `  ${p}: ${c}`)
      .join("\n");
    let text =
      `db: ${result.store_path}\n` +
      `total: ${result.total_memories} memories, ${Object.keys(result.projects).length} projects, ${result.storage_size_kb} KB\n` +
      projects;
    if (kg && kg.entityCount > 0) {
      text += `\nknowledge graph: ${kg.entityCount} entities, ${kg.tripleCount} facts (${kg.activeTriples} active)`;
    }
    return text;
  });
}

function cmdProjects(opts) {
  const { projects } = store.listProjects();
  emit(opts, { projects }, () =>
    Object.entries(projects)
      .sort(([, a], [, b]) => b - a)
      .map(([p, c]) => `${c}\t${p}`)
      .join("\n") || "No projects."
  );
}

function cmdKgAdd(subject, predicate, object, opts) {
  if (!subject || !predicate || !object)
    fail("kg-add requires <subject> <predicate> <object>");
  const project = requireProject(opts, "kg-add");
  const result = store.addTriple({
    subject,
    predicate,
    object,
    valid_from: opts.from || undefined,
    valid_to: opts.to || undefined,
    project,
    subject_type: opts["subject-type"] || undefined,
    object_type: opts["object-type"] || undefined,
  });
  const untyped = store
    .listUntypedEntities({ limit: 500 })
    .filter((e) => [subject.toLowerCase(), object.toLowerCase()].includes(e.name.toLowerCase()))
    .map((e) => e.name);
  emit(opts, { ...result, untyped }, () =>
    `fact #${result.id}: ${subject} ${predicate} ${object}` +
    (untyped.length ? `\n  untyped: ${untyped.join(", ")} — type with \`kg-type <entity> <type>\` or --subject-type/--object-type` : "")
  );
}

function cmdKgType(entity, type, opts) {
  if (!entity || !type) fail("kg-type requires <entity> <type>");
  const result = store.setEntityType(entity, type);
  if (result.status === "missing") fail(`no entity named ${JSON.stringify(entity)} (names match case-insensitively; check kg-query)`);
  emit(opts, result, () => `typed: ${entity} -> ${type}`);
}

function cmdKgUntyped(opts) {
  const rows = store.listUntypedEntities({
    project: opts.project || undefined,
    limit: opts.n != null ? parseInt(opts.n, 10) : 50,
  });
  emit(opts, rows, () =>
    rows.length ? rows.map((r) => `${r.facts}\t${r.name}`).join("\n") : "No untyped entities."
  );
}

function cmdKgBackfillTypes(opts) {
  const result = store.backfillTypesFromIsA();
  emit(opts, result, () => `typed ${result.updated} entities from is_a facts (${result.skipped} skipped: no usable type)`);
}

function cmdKgInvalidate(subject, predicate, object, opts) {
  if (!subject || !predicate || !object)
    fail("kg-invalidate requires <subject> <predicate> <object> (the active fact to end)");
  const id = store.findTriple(subject, predicate, object);
  if (id === null)
    fail(`no active fact matches: ${subject} ${predicate} ${object} (already ended, or names differ — check kg-query "${subject}")`);
  store.invalidateTriple(id, opts.to || undefined);
  const endDate = opts.to || localToday();
  emit(opts, { status: "invalidated", id, valid_to: endDate }, () =>
    `fact #${id} ended ${endDate}: ${subject} ${predicate} ${object}`
  );
}

function cmdKgQuery(entity, opts) {
  if (!entity) fail("kg-query requires an <entity>");
  const result = store.queryEntity(entity, {
    at_time: opts.at || undefined,
    project: opts.project || undefined,
  });
  if (!result.entity) {
    return emit(opts, result, () => `Unknown entity: ${entity}`);
  }
  emit(opts, result, () =>
    result.facts
      .map(
        (f) =>
          `${f.subject} ${f.predicate} ${f.object}${f.valid_from ? ` [${f.valid_from}${f.valid_to ? `→${f.valid_to}` : "→"}]` : ""}`
      )
      .join("\n") || "No facts."
  );
}

// --- Output / args ---------------------------------------------------------

function emit(opts, obj, human) {
  if (opts.json) console.log(JSON.stringify(obj, null, 2));
  else console.log(human());
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "-n") opts.n = argv[++i];
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      opts[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else positional.push(a);
  }
  return { positional, opts };
}

const HELP = `mempalace — CLI for the pi-mempalace memory store
store: $MEMPALACE_HOME if set, else ~/.pi/agent/memory (created on first use; today is ${localToday()})

USAGE
  node mempalace.mjs <command> [options]

COMMANDS
  search   <query>                 Semantic search (blended similarity×importance)
      --project P  --topic T  -n N (max 20)  --json
  save     <content>               Store a memory (auto-chunked, deduplicated)
      --project P  --topic T  --importance 0.0-1.0  --source S  --json
  recall   [filters]               Recent memories by project/topic
      --project P  --topic T  -n N (max 50)  --json
  forget   <id>                    Delete a memory by id (removes whole chunk family)
  status                           Store overview (counts, size, KG)  --json
  projects                         List projects with counts  --json
  kg-add   <subj> <pred> <obj>     Add a knowledge-graph fact (dates stored as YYYY-MM-DD)
      --project P (required)  --subject-type T  --object-type T  --from DATE  --to DATE  --json
      An is_a fact also types its subject: kg-add weaver is_a service --project weaver
  kg-query <entity>                Query facts about an entity
      --at DATE  --project P  --json
  kg-invalidate <subj> <pred> <obj>  End an active fact (sets valid_to; pair with a
      --to DATE  --json              fresh kg-add when a fact is superseded)
  kg-type  <entity> <type>         Set an entity's type (kebab-case: service, tool, project,
                                   library, person, file-path, mcp-server, concept, …)
  kg-untyped                       Entities still typed unknown, most-referenced first
      --project P  -n N (max 500)  --json
  kg-backfill-types                Type every unknown entity that already has an is_a fact

  save and kg-add REFUSE --project general, the home folder, Documents, tmp and
  similar working-directory names: pass the canonical project (see 'projects').

NOTES
  Same engine code as the pi extension (imported from memory_store.ts), so
  ranking, dedupe and chunking are identical. Embeddings use
  Xenova/all-MiniLM-L6-v2 — local, no network after the first model download.
  Add --json to any command for machine-readable output.`;

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(HELP);
    return;
  }
  const { positional, opts } = parseArgs(rest);
  switch (cmd) {
    case "search": return cmdSearch(positional[0], opts);
    case "save": return cmdSave(positional[0], opts);
    case "recall": return cmdRecall(opts);
    case "forget": return cmdForget(positional[0], opts);
    case "status": return cmdStatus(opts);
    case "projects": return cmdProjects(opts);
    case "kg-add": return cmdKgAdd(positional[0], positional[1], positional[2], opts);
    case "kg-query": return cmdKgQuery(positional[0], opts);
    case "kg-invalidate": return cmdKgInvalidate(positional[0], positional[1], positional[2], opts);
    case "kg-type": return cmdKgType(positional[0], positional[1], opts);
    case "kg-untyped": return cmdKgUntyped(opts);
    case "kg-backfill-types": return cmdKgBackfillTypes(opts);
    default: fail(`unknown command: ${cmd}. Run --help.`);
  }
}

main().catch((e) => fail(e?.message || String(e)));
