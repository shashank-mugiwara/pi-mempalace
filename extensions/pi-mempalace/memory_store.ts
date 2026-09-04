/**
 * memory_store.ts — SQLite + sqlite-vec memory backend.
 *
 * Replaces the JSONL flat-file backend with:
 *   - better-sqlite3 for persistent storage
 *   - sqlite-vec for vector similarity search
 *   - @huggingface/transformers for local embeddings (all-MiniLM-L6-v2)
 *
 * Implements the MemPalace 4-Layer Memory Stack:
 *   L0: Identity (static file)
 *   L1: Essential Story (top 15 memories, cached per session)
 *   L2: On-Demand Project Context (filtered retrieval)
 *   L3: Deep Semantic Search (sqlite-vec vector search)
 *
 * Additional features:
 *   - Chunking: automatic 800/100 character chunking for large content
 *   - Palace Graph / Tunnels: cross-project topic connections
 *   - Knowledge Graph: temporal triples (entities + facts)
 *
 * All operations are in-process — no subprocess spawning.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// @ts-ignore — better-sqlite3 types may not be perfect
import Database from "better-sqlite3";
// @ts-ignore — sqlite-vec has no type declarations
import * as sqliteVec from "sqlite-vec";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// MEMPALACE_HOME relocates the whole store (DB, identity, config) — used by
// standalone deployments that keep memory next to a project instead of ~/.pi.
const MEMORY_DIR =
  process.env.MEMPALACE_HOME ||
  path.join(os.homedir(), ".pi", "agent", "memory");
const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIM = 384;

// Chunking constants
/**
 * Topics that hold exactly one memory per project. `store()` deletes the
 * previous family before writing, so the invariant no longer depends on the
 * caller (CLI, watchdog, pi tool, omp checkpoint) remembering to delete first.
 * Mirrored in harness/lib/health.mjs, which audits the store for violations.
 */
const SINGLETON_TOPICS = new Set(["session-resume", "todo-state", "playbook"]);

const CHUNK_SIZE = 800;      // characters per chunk
const CHUNK_OVERLAP = 100;   // overlap between chunks
const MIN_CHUNK_SIZE = 50;   // skip tiny fragments

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryMetadata {
  project: string;
  topic: string;
  source: string;
  timestamp: string;
  session_id: string;
}

export interface StoredMemory {
  id: string;
  content: string;
  metadata: MemoryMetadata;
  /** Base64-encoded Float32Array of the embedding vector */
  embedding: string;
}

export interface StoreInput {
  content: string;
  project?: string;
  topic?: string;
  source?: string;
  timestamp?: string;
  session_id?: string;
  importance?: number;
}

export interface SearchResult {
  id: string;
  text: string;
  project: string;
  topic: string;
  source: string;
  timestamp: string;
  similarity: number;
  /** Stored importance weight (0-1). Used to blend ranking in search(). */
  importance: number;
}

export interface StoreResult {
  status: "stored" | "duplicate";
  id: string;
}

export interface BatchStoreResult {
  stored: number;
  duplicates: number;
  results: StoreResult[];
}

export interface StatusResult {
  memory_dir: string;
  store_path: string;
  identity_exists: boolean;
  total_memories: number;
  projects: Record<string, number>;
  storage_size_kb: number;
}

export interface WakeupResult {
  text: string;
  token_estimate: number;
}

export interface MemoryStats {
  total: number;
  projects: Record<string, number>;
  topics: Record<string, number>;
  sources: Record<string, number>;
  sessions: number;
  oldest: string | null;
  newest: string | null;
  /** Memories per day, keyed by YYYY-MM-DD */
  timeline: Record<string, number>;
  avgContentLength: number;
  storageSizeKb: number;
}

// Palace Graph / Tunnel types
export interface TunnelInfo {
  topic: string;
  projects: [string, string];
  memoryCounts: [number, number];
}

export interface PalaceNode {
  name: string;
  memoryCount: number;
  topics: string[];
}

export interface PalaceEdge {
  topic: string;
  projectA: string;
  projectB: string;
  strength: number;
}

export interface PalaceGraph {
  nodes: PalaceNode[];
  edges: PalaceEdge[];
}

// Knowledge Graph types
export interface EntityInput {
  id?: string;
  name: string;
  entity_type?: string;
  properties?: Record<string, unknown>;
}

export interface EntityResult {
  status: "created" | "updated";
  id: string;
}

export interface TripleInput {
  subject: string;
  predicate: string;
  object: string;
  valid_from?: string;
  valid_to?: string;
  confidence?: number;
  source_memory_id?: string;
  project?: string;
  /** Optional entity types for auto-created endpoints (e.g. "service", "tool"). */
  subject_type?: string;
  object_type?: string;
}

export interface TripleResult {
  status: "created";
  id: number;
}

export interface Fact {
  subject: string;
  predicate: string;
  object: string;
  valid_from: string | null;
  valid_to: string | null;
  confidence: number;
  project: string;
}

export interface KnowledgeResult {
  entity: {
    id: string;
    name: string;
    type: string;
    properties: Record<string, unknown>;
  } | null;
  facts: Fact[];
}

export interface KnowledgeStats {
  entityCount: number;
  tripleCount: number;
  activeTriples: number;
  entityTypes: Record<string, number>;
  predicates: Record<string, number>;
}

export interface RoomInfo {
  topic: string;
  count: number;
  projects: string[];
}

export interface TaxonomyNode {
  project: string;
  topics: { topic: string; count: number }[];
  total: number;
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  hashMatch: boolean;
  semanticMatch: SearchResult | null;
}

export interface TimelineFact {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  valid_from: string | null;
  valid_to: string | null;
  confidence: number;
  project: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Database row types
// ---------------------------------------------------------------------------

interface MemoryRow {
  rowid: number;
  id: string;
  content: string;
  content_hash: string;
  project: string;
  topic: string;
  source: string;
  timestamp: string;
  session_id: string;
  importance: number;
  chunk_index: number;
  parent_id: string | null;
}

interface VecSearchRow {
  rowid: number;
  distance: number;
}

interface CountRow {
  project?: string;
  topic?: string;
  source?: string;
  session_id?: string;
  cnt: number;
}

// ---------------------------------------------------------------------------
// Embeddings (lazy-loaded)
// ---------------------------------------------------------------------------

let embedder: any = null;
let embedderLoading: Promise<any> | null = null;

async function getEmbedder(): Promise<any> {
  if (embedder) return embedder;
  if (embedderLoading) return embedderLoading;

  embedderLoading = (async () => {
    const { pipeline } = await import("@huggingface/transformers");
    embedder = await pipeline("feature-extraction", MODEL_NAME, {
      dtype: "fp32" as any,
    });
    return embedder;
  })();

  return embedderLoading;
}

async function embed(text: string): Promise<Float32Array> {
  const extractor = await getEmbedder();
  const result = await extractor(text, { pooling: "mean", normalize: true });
  return new Float32Array(result.data);
}

function base64ToEmbedding(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ---------------------------------------------------------------------------
// Content Hash
// ---------------------------------------------------------------------------

/** Predicates whose object names the subject's type (`prism is_a project`). */
export const IS_A_PREDICATES: ReadonlySet<string> = new Set(["is_a", "is_an", "instance_of", "type", "kind"]);

/**
 * Entity types are a small kebab-case vocabulary (service, tool, project, library,
 * person, file-path, mcp-server …). Free text is squashed to that shape and
 * anything that does not survive (empty, or a whole sentence) is rejected so a
 * sentence-long is_a object never becomes a "type".
 */
export function normalizeEntityType(raw: string | undefined | null): string | undefined {
  if (raw == null) return undefined;
  const t = String(raw).trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!t || t === "unknown" || t.length > 32 || t.split("-").length > 4) return undefined;
  return t;
}

/**
 * Project names that are really just a working directory: the home folder, its
 * standard children, temp dirs. Memories saved under these are unrecoverable
 * later ("Documents" is not a project), so writers refuse them.
 */
export function isNonProjectName(name: string | undefined | null): boolean {
  if (!name) return true;
  const n = String(name).trim();
  if (!n || n.toLowerCase() === "general") return true;
  const home = os.homedir();
  const junk = new Set(["documents", "desktop", "downloads", "tmp", "temp", "home", "users", "root", "src", "github", path.basename(home).toLowerCase()]);
  return junk.has(n.toLowerCase());
}

function contentHash(content: string): string {
  return crypto
    .createHash("sha256")
    .update(content, "utf-8")
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

function chunkText(content: string): string[] {
  if (content.length <= CHUNK_SIZE) return [content];

  const chunks: string[] = [];
  let offset = 0;

  while (offset < content.length) {
    let end = Math.min(offset + CHUNK_SIZE, content.length);

    // Try to break on paragraph boundary
    if (end < content.length) {
      const paraBreak = content.lastIndexOf("\n\n", end);
      if (paraBreak > offset + CHUNK_SIZE / 2) end = paraBreak;
      else {
        const lineBreak = content.lastIndexOf("\n", end);
        if (lineBreak > offset + CHUNK_SIZE / 2) end = lineBreak;
      }
    }

    const chunk = content.slice(offset, end).trim();
    if (chunk.length >= MIN_CHUNK_SIZE) chunks.push(chunk);

    offset = end - CHUNK_OVERLAP;
    if (offset >= content.length) break;
    // Prevent infinite loop
    if (end === offset + CHUNK_OVERLAP) offset = end;
  }

  return chunks.length > 0 ? chunks : [content];
}

// ---------------------------------------------------------------------------
// Distance ↔ Similarity Conversion
// ---------------------------------------------------------------------------

/**
 * Convert sqlite-vec L2 distance to cosine similarity.
 * For L2-normalized vectors: similarity = 1 - (distance² / 2)
 * sqlite-vec returns the actual L2 distance (not squared).
 */
function distanceToSimilarity(distance: number): number {
  return 1 - (distance * distance) / 2;
}

// ---------------------------------------------------------------------------
// Knowledge-graph temporal dates
// ---------------------------------------------------------------------------

/**
 * Canonical form for KG temporal values: date-only YYYY-MM-DD.
 * valid_from / valid_to / at_time are compared lexicographically, so mixing a
 * date-only value with a full ISO timestamp breaks boundary days
 * ("2025-06-01" >= "2025-06-01T12:00:00Z" is false). Facts are day-granular;
 * strip everything past the date.
 */
function toKgDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : String(value);
}

/** Today as a LOCAL date (UTC "today" is off by a day for east-of-GMT users). */
export function localToday(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
  private db: any = null;
  private loaded = false;
  private memoryDir: string;
  private cachedL1: string | null = null;

  // Prepared statements (initialized in load)
  private stmtInsertMemory: any = null;
  private stmtInsertVec: any = null;
  private stmtFindByHash: any = null;
  private stmtFindById: any = null;
  private stmtDeleteMemory: any = null;
  private stmtDeleteVec: any = null;
  private stmtCountAll: any = null;
  private stmtHasId: any = null;

  constructor(memoryDir: string = MEMORY_DIR) {
    this.memoryDir = memoryDir;
  }

  get dbPath(): string {
    return path.join(this.memoryDir, "memories.db");
  }

  /** Legacy JSONL path — used for migration detection */
  get storePath(): string {
    return path.join(this.memoryDir, "memories.jsonl");
  }

  get identityPath(): string {
    return path.join(this.memoryDir, "identity.txt");
  }

  // -----------------------------------------------------------------------
  // Database Lifecycle
  // -----------------------------------------------------------------------

  /** Open the database, create tables, and run migration if needed. */
  load(): void {
    if (this.loaded) return;

    fs.mkdirSync(this.memoryDir, { recursive: true });

    this.db = new Database(this.dbPath);
    sqliteVec.load(this.db);

    // WAL mode for better concurrent read performance
    this.db.pragma("journal_mode = WAL");
    // Multiple agents (pi, Claude Code, Codex, the CLI) share this DB; WAL
    // allows one writer at a time, so wait for a lock instead of throwing
    // SQLITE_BUSY the instant two writes overlap.
    this.db.pragma("busy_timeout = 5000");

    // Create schema
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        project TEXT NOT NULL DEFAULT 'general',
        topic TEXT NOT NULL DEFAULT 'general',
        source TEXT NOT NULL DEFAULT 'auto-capture',
        timestamp TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        importance REAL DEFAULT 0.5,
        chunk_index INTEGER DEFAULT 0,
        parent_id TEXT DEFAULT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
      CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories(topic);
      CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
      CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);
    `);

    // Migrate existing databases: add chunk_index and parent_id columns
    try {
      this.db.exec(
        `ALTER TABLE memories ADD COLUMN chunk_index INTEGER DEFAULT 0`
      );
    } catch {
      /* column already exists */
    }
    try {
      this.db.exec(
        `ALTER TABLE memories ADD COLUMN parent_id TEXT DEFAULT NULL`
      );
    } catch {
      /* column already exists */
    }

    // Knowledge Graph tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        entity_type TEXT DEFAULT 'unknown',
        properties TEXT DEFAULT '{}',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);

      CREATE TABLE IF NOT EXISTS triples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        valid_from TEXT,
        valid_to TEXT,
        confidence REAL DEFAULT 1.0,
        source_memory_id TEXT,
        project TEXT DEFAULT 'general',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (subject) REFERENCES entities(id),
        FOREIGN KEY (object) REFERENCES entities(id)
      );
      CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject);
      CREATE INDEX IF NOT EXISTS idx_triples_object ON triples(object);
      CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate);
      CREATE INDEX IF NOT EXISTS idx_triples_valid ON triples(valid_from, valid_to);
      CREATE INDEX IF NOT EXISTS idx_triples_project ON triples(project);
    `);

    // sqlite-vec virtual table — created separately since CREATE VIRTUAL TABLE
    // doesn't support IF NOT EXISTS in all versions; catch the error if it exists.
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE vec_memories USING vec0(embedding float[${EMBEDDING_DIM}])`
      );
    } catch (e: any) {
      // Table already exists — that's fine
      if (!String(e.message).includes("already exists")) {
        throw e;
      }
    }

    // Prepare statements
    this.stmtInsertMemory = this.db.prepare(`
      INSERT INTO memories (id, content, content_hash, project, topic, source, timestamp, session_id, importance, chunk_index, parent_id)
      VALUES (@id, @content, @content_hash, @project, @topic, @source, @timestamp, @session_id, @importance, @chunk_index, @parent_id)
    `);

    this.stmtInsertVec = this.db.prepare(`
      INSERT INTO vec_memories (rowid, embedding) VALUES (?, ?)
    `);

    this.stmtFindByHash = this.db.prepare(
      `SELECT id FROM memories WHERE content_hash = ?`
    );

    this.stmtFindById = this.db.prepare(
      `SELECT * FROM memories WHERE id = ?`
    );

    this.stmtDeleteMemory = this.db.prepare(
      `DELETE FROM memories WHERE id = ?`
    );

    this.stmtDeleteVec = this.db.prepare(
      `DELETE FROM vec_memories WHERE rowid = ?`
    );

    this.stmtCountAll = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM memories`
    );

    this.stmtHasId = this.db.prepare(
      `SELECT 1 FROM memories WHERE id = ? LIMIT 1`
    );

    // Run migration from JSONL if old file exists and DB is empty
    if (fs.existsSync(this.storePath) && this.countAll() === 0) {
      this.migrateFromJsonl();
    }

    this.loaded = true;
  }

  /** Ensure the store is loaded. */
  private ensureLoaded(): void {
    if (!this.loaded) this.load();
  }

  // -----------------------------------------------------------------------
  // Internal Helpers
  // -----------------------------------------------------------------------

  private countAll(): number {
    return (this.stmtCountAll.get() as CountRow).cnt;
  }

  /**
   * Insert a memory + its embedding in a single transaction.
   * Returns the rowid of the inserted memory.
   */
  private insertMemoryAndVec(
    id: string,
    content: string,
    cHash: string,
    project: string,
    topic: string,
    source: string,
    timestamp: string,
    sessionId: string,
    importance: number,
    embedding: Float32Array,
    chunkIndex: number = 0,
    parentId: string | null = null
  ): number {
    const insertBoth = this.db.transaction(() => {
      const info = this.stmtInsertMemory.run({
        id,
        content,
        content_hash: cHash,
        project,
        topic,
        source,
        timestamp,
        session_id: sessionId,
        importance,
        chunk_index: chunkIndex,
        parent_id: parentId,
      });
      const rowid = Number(info.lastInsertRowid);
      this.stmtInsertVec.run(BigInt(rowid), embedding);
      return rowid;
    });
    return insertBoth();
  }

  // -----------------------------------------------------------------------
  // Migration
  // -----------------------------------------------------------------------

  /** Migrate memories from legacy JSONL file to SQLite. */
  migrateFromJsonl(): void {
    const jsonlPath = this.storePath;
    if (!fs.existsSync(jsonlPath)) return;

    const lines = fs
      .readFileSync(jsonlPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);

    if (lines.length === 0) return;

    const migrate = this.db.transaction(() => {
      for (const line of lines) {
        let mem: StoredMemory;
        try {
          mem = JSON.parse(line);
        } catch {
          continue; // Skip corrupt lines
        }

        const cHash = contentHash(mem.content);

        // Skip if already migrated
        if (this.stmtFindByHash.get(cHash)) continue;

        // Decode existing embedding from base64
        let embedding: Float32Array;
        try {
          embedding = base64ToEmbedding(mem.embedding);
          if (embedding.length !== EMBEDDING_DIM) continue; // Skip bad embeddings
        } catch {
          continue;
        }

        try {
          this.insertMemoryAndVec(
            mem.id,
            mem.content,
            cHash,
            mem.metadata.project || "general",
            mem.metadata.topic || "general",
            mem.metadata.source || "auto-capture",
            mem.metadata.timestamp || new Date().toISOString(),
            mem.metadata.session_id || "",
            0.5, // Default importance for migrated memories
            embedding
          );
        } catch {
          // Skip duplicates or other insertion errors
        }
      }
    });

    migrate();

    // Rename old file to backup
    const bakPath = jsonlPath + ".bak";
    try {
      fs.renameSync(jsonlPath, bakPath);
    } catch {
      // If rename fails, leave it — migration is still done
    }
  }

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  async store(input: StoreInput): Promise<StoreResult> {
    this.ensureLoaded();

    const content = (input.content || "").trim();
    if (!content) {
      throw new Error("Empty content");
    }

    const project = input.project || "general";
    const topic = input.topic || "general";
    const source = input.source || "auto-capture";
    const timestamp = input.timestamp || new Date().toISOString();
    const sessionId = input.session_id || "";
    const importance = input.importance ?? 0.5;

    // One-per-project topics are superseded here, structurally, rather than
    // by every caller remembering to delete first. The convention-only version
    // failed: on 2026-08-31 the watchdog's review-approved path wrote two
    // extra session-resume rows for prism and one for weaver, and the newest
    // by timestamp was an older hand-off — the next session was told to
    // resume the wrong work. A supersede that depends on the caller is a wish.
    if (SINGLETON_TOPICS.has(topic) && project !== "general") {
      this.supersedeAllTopic(project, topic, `mem_${contentHash(content)}`);
    }

    const chunks = chunkText(content);

    // Short content: behave exactly as before (no chunking)
    if (chunks.length === 1) {
      const cHash = contentHash(content);
      const docId = `mem_${cHash}`;

      // Check for duplicate
      if (this.stmtFindByHash.get(cHash)) {
        return { status: "duplicate", id: docId };
      }

      const vec = await embed(content);

      // Concurrent agents can pass the hash check simultaneously — treat the
      // resulting UNIQUE violation as a duplicate, matching the multi-chunk path.
      try {
        this.insertMemoryAndVec(
          docId,
          content,
          cHash,
          project,
          topic,
          source,
          timestamp,
          sessionId,
          importance,
          vec,
          0,    // chunk_index
          null  // parent_id
        );
      } catch (e: any) {
        if (String(e?.message).includes("UNIQUE")) {
          return { status: "duplicate", id: docId };
        }
        throw e;
      }

      // Invalidate L1 cache when new memory is stored
      this.cachedL1 = null;

      return { status: "stored", id: docId };
    }

    // Multi-chunk: each chunk gets its own id, embedding, and row
    const baseHash = contentHash(content);
    const parentId = `mem_${baseHash}_c0`;
    let storedAny = false;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      // Scope the chunk hash by family + index: content_hash is globally
      // UNIQUE, so a raw contentHash(chunk) collides when two different
      // memories share a byte-identical chunk (boilerplate, headings). If the
      // colliding chunk is c0, the whole family becomes an orphan — recall,
      // wakeup and search's c0-prefix all filter on chunk_index 0 and never
      // surface it again. Family-scoping makes cross-family collisions
      // impossible; same-content re-saves still dedupe via the id check below.
      const chunkHash = contentHash(`${baseHash}_c${i}\n${chunk}`);
      const chunkId = `mem_${baseHash}_c${i}`;

      // Skip chunks this exact memory already stored (id check also covers
      // rows written before family-scoped hashing).
      if (this.stmtHasId.get(chunkId) || this.stmtFindByHash.get(chunkHash))
        continue;

      const vec = await embed(chunk);

      try {
        this.insertMemoryAndVec(
          chunkId,
          chunk,
          chunkHash,
          project,
          topic,
          source,
          timestamp,
          sessionId,
          importance,
          vec,
          i,
          i === 0 ? null : parentId
        );
        storedAny = true;
      } catch {
        // Skip duplicates or other insertion errors
      }
    }

    // Invalidate L1 cache when new memory is stored
    this.cachedL1 = null;

    return {
      status: storedAny ? "stored" : "duplicate",
      id: parentId,
    };
  }

  async batchStore(items: StoreInput[]): Promise<BatchStoreResult> {
    if (!items || items.length === 0) {
      throw new Error("No items provided");
    }

    const results: StoreResult[] = [];
    let stored = 0;
    let duplicates = 0;

    for (const item of items) {
      if (!(item.content || "").trim()) continue;
      const result = await this.store(item);
      results.push(result);
      if (result.status === "stored") stored++;
      else duplicates++;
    }

    return { stored, duplicates, results };
  }

  /**
   * L3: Deep Semantic Search via sqlite-vec.
   *
   * When project/topic filters are specified, performs vector search on a
   * larger candidate set and post-filters by metadata in JS.
   */
  async search(
    query: string,
    options?: {
      project?: string;
      topic?: string;
      n_results?: number;
      /**
       * Ranking mode:
       *  - "blended" (default): similarity × importance, so low-value memories
       *    (e.g. 0.5 auto-capture) sink below curated ones (0.8+).
       *  - "similarity": pure vector distance (used by duplicate detection).
       */
      rank?: "blended" | "similarity";
    }
  ): Promise<{
    query: string;
    filters: Record<string, string | null>;
    results: SearchResult[];
  }> {
    this.ensureLoaded();

    if (!query || !query.trim()) {
      throw new Error("Empty query");
    }

    const project = options?.project || null;
    const topic = options?.topic || null;
    const nResults = Math.min(options?.n_results || 5, 20);
    const rank = options?.rank ?? "blended";

    const queryVec = await embed(query.trim());

    // Always over-fetch a candidate pool (not just the nearest nResults) so the
    // importance blend can actually re-order results — otherwise a high-value
    // memory that is the 12th-nearest by distance could never surface.
    let searchLimit = Math.max(nResults * 10, 50);

    // Fetch a candidate pool and post-filter by metadata in JS. Filters and
    // build results: we keep the true cosine similarity for display, but rank
    // by a blended score = similarity × importance so that low-value memories
    // (0.5 auto-capture) sink below curated ones (0.8+) instead of competing
    // on raw vector distance alone. Nothing is excluded — everything stays
    // searchable, the noise just stops winning.
    const fetchCandidates = (limit: number): { pool: number; results: SearchResult[] } => {
      const vecRows = this.db
        .prepare(
          `SELECT rowid, distance FROM vec_memories
           WHERE embedding MATCH ?
           ORDER BY distance
           LIMIT ?`
        )
        .all(queryVec, limit) as VecSearchRow[];

      if (vecRows.length === 0) return { pool: 0, results: [] };

      // Fetch metadata for matched rowids
      const rowids = vecRows.map((r) => r.rowid);
      const distanceMap = new Map(vecRows.map((r) => [r.rowid, r.distance]));

      // Build IN clause — parameterized via individual placeholders
      const placeholders = rowids.map(() => "?").join(",");
      const memRows = this.db
        .prepare(
          `SELECT rowid, id, content, project, topic, source, timestamp, importance, chunk_index
           FROM memories WHERE rowid IN (${placeholders})`
        )
        .all(...rowids) as MemoryRow[];

      const out: SearchResult[] = [];
      for (const row of memRows) {
        if (project && row.project !== project) continue;
        if (topic && row.topic !== topic) continue;

        const distance = distanceMap.get(row.rowid) ?? Infinity;
        const similarity = distanceToSimilarity(distance);
        const importance = row.importance ?? 0.5;

        out.push({
          id: row.id,
          text: row.content,
          project: row.project,
          topic: row.topic,
          source: row.source,
          timestamp: row.timestamp,
          similarity: Math.round(similarity * 10000) / 10000,
          importance,
        });
      }
      return { pool: vecRows.length, results: out };
    };

    let { pool, results } = fetchCandidates(searchLimit);

    // Filtered searches can starve: the filter runs AFTER the ANN fetch, so if
    // a project's memories sit outside the global top-`searchLimit` by
    // distance, matches exist but never enter the pool. Widen once.
    if (
      (project || topic) &&
      results.length < nResults &&
      pool === searchLimit
    ) {
      searchLimit = Math.max(searchLimit, 2000);
      ({ pool, results } = fetchCandidates(searchLimit));
    }

    if (results.length === 0 && pool === 0) {
      return { query, filters: { project, topic }, results: [] };
    }

    // Rank: blended (similarity × importance) by default, or pure similarity
    // (used by duplicate detection, which needs the true nearest match).
    const scoreOf =
      rank === "similarity"
        ? (r: SearchResult) => r.similarity
        : (r: SearchResult) => r.similarity * r.importance;
    results.sort((a, b) => scoreOf(b) - scoreOf(a));

    // Collapse chunk families: chunks of one long memory each carry their own
    // embedding, so a single memory could occupy several top-N slots as
    // mid-sentence fragments (live failure 2026-07-07: two fragments of the
    // same style-lock memory crowded a 5-result search while the actual
    // answer ranked 6th). Keep only the best-scoring chunk per family.
    const familyOf = (id: string) => id.replace(/_c\d+$/, "");
    const seenFamilies = new Set<string>();
    const deduped: SearchResult[] = [];
    for (const r of results) {
      const family = familyOf(r.id);
      if (seenFamilies.has(family)) continue;
      seenFamilies.add(family);
      deduped.push(r);
    }
    results = deduped.slice(0, nResults);

    // A continuation chunk starts mid-sentence — prepend the family's opening
    // so the reader knows WHICH memory the fragment belongs to.
    const stmtC0 = this.db.prepare(`SELECT content FROM memories WHERE id = ?`);
    for (const r of results) {
      if (/_c[1-9]\d*$/.test(r.id)) {
        const c0 = stmtC0.get(`${familyOf(r.id)}_c0`) as { content: string } | undefined;
        if (c0) {
          const head = c0.content.trim().replace(/\s+/g, " ").slice(0, 140);
          r.text = `⟨${head}…⟩ ${r.text}`;
        }
      }
    }

    return { query, filters: { project, topic }, results };
  }

  /**
   * Wakeup: L0 Identity + L1 Essential Story.
   *
   * L0: Read from identity.txt (always loaded, static).
   * L1: Top 15 memories by importance + recency, grouped by project.
   *     Generated once per session and cached.
   */
  wakeup(options?: { project?: string; projectAliases?: string[]; max_tokens?: number }): WakeupResult {
    this.ensureLoaded();

    const project = options?.project || null;
    // Which project buckets generateL1's digest pulls from. Separate from
    // `project` above (which stays the single canonical name for identity/
    // resume/playbook — those are meant to be exactly-scoped, one hand-off
    // note per real project, never blended). projectAliases exists because
    // cwd-derived project identity (detectProject = basename(cwd)) and where
    // memories actually get saved can diverge — e.g. this repo's cwd resolves
    // to "harness" but most of a session's actual saved content lands under
    // "pi-config". Config: MemoryConfig.projectAliases (index.ts).
    const l1Projects =
      options?.projectAliases && options.projectAliases.length > 0
        ? options.projectAliases
        : project
          ? [project]
          : null;
    const maxTokens = options?.max_tokens || 800;
    const maxChars = maxTokens * 4;
    const parts: string[] = [];

    // L0: Identity
    if (fs.existsSync(this.identityPath)) {
      const identity = fs.readFileSync(this.identityPath, "utf-8").trim();
      parts.push(`## Memory — Identity\n${identity}`);
    } else {
      parts.push(
        "## Memory — Identity\nNo identity configured. Use /skill:memory-setup to set up."
      );
    }

    // L0.5: Prospective memory — where work on this project left off.
    // Deliberately NOT left to L1's importance ranking: L1 is
    // `ORDER BY importance DESC LIMIT 15` over a project that may hold
    // hundreds of 0.9+ memories, and it truncates snippets to 200 chars.
    // A resume record must surface every session, in full, or it is useless.
    const resume = this.latestResume(project);
    if (resume) parts.push(resume);

    // Procedural knowledge from session-watchdog's playbook extraction (fast
    // commands, file/skill locations, prompt phrasings that worked) — same
    // one-per-project, superseded-not-appended convention as session-resume.
    const playbook = this.latestPlaybook(project);
    if (playbook) parts.push(playbook);

    // Structured facts (knowledge graph), scoped the same way as L1 below —
    // complements the free-text memory digest with what's formally recorded
    // as fact (uses/depends_on/decided/etc) rather than narrated. Session-start
    // is otherwise KG-blind: queryEntity() needs an entity name the agent
    // doesn't have yet, so without this the KG is only reachable after the
    // agent already knows what to ask about.
    if (l1Projects) {
      const facts = this.projectFacts(l1Projects, 40);
      if (facts.length > 0) {
        const factLines = ["## Memory — Known Facts (knowledge graph)"];
        for (const f of facts) {
          factLines.push(`- ${f.subject} ${f.predicate} ${f.object}${f.valid_from ? ` (since ${f.valid_from})` : ""}`);
        }
        parts.push(factLines.join("\n"));
      }
    }

    // L1: Essential Story (cached). Budget is what's left of maxChars after
    // identity/resume/playbook/facts above — without this, a project with many
    // KG facts (e.g. prism's 40-fact cap alone runs ~4-5k chars) blows well past
    // maxChars in total even though L1 itself stays within it; the wake-up budget
    // is a promise about the WHOLE injected block, not just this one part of it.
    // Floored at 200 so a fact-heavy project still gets a token L1 line rather
    // than a negative/zero budget silently producing nothing.
    if (this.cachedL1 === null) {
      const usedChars = parts.join("\n").length;
      this.cachedL1 = this.generateL1(l1Projects, Math.max(maxChars - usedChars, 200));
    }
    parts.push(this.cachedL1);

    const text = parts.join("\n");
    return { text, token_estimate: Math.ceil(text.length / 4) };
  }

  /**
   * Most recent `session-resume` memory for `project`, reassembled from its
   * chunk family so a long hand-off arrives whole rather than clipped at the
   * 800-char chunk boundary. Returns null when the project has never had one
   * (or when no project is in scope — a resume record only means something
   * relative to the repo you are sitting in).
   */
  private latestResume(project: string | null): string | null {
    if (!project) return null;
    try {
      const head = this.db
        .prepare(
          `SELECT id, timestamp FROM memories
           WHERE project = ? AND topic = 'session-resume' AND chunk_index = 0
           ORDER BY timestamp DESC LIMIT 1`
        )
        .get(project) as { id: string; timestamp: string } | undefined;
      if (!head) return null;

      const family = this.db
        .prepare(
          `SELECT content FROM memories
           WHERE id = ? OR parent_id = ?
           ORDER BY chunk_index ASC`
        )
        .all(head.id, head.id) as { content: string }[];

      const body = family.map((r) => r.content).join("\n").trim();
      if (!body) return null;

      return (
        `## Memory — Where we left off (${project}, saved ${head.timestamp.slice(0, 10)})\n` +
        `${body}\n\n` +
        `_This is the last recorded hand-off, not live state — verify against the current code, ` +
        `git log and git status before acting on it. When this session's work reaches a stopping ` +
        `point, supersede it (see \`session-resume\` in PROTOCOL.md)._`
      );
    } catch {
      return null; // wake-up context is best-effort; never block startup
    }
  }

  /**
   * Most recent `playbook` memory for `project` — procedural/efficiency
   * knowledge written by session-watchdog's playbook extraction
   * (docs/design/watchdog-playbook.md). Unlike `latestResume()`, playbook
   * entries are never chunked (a single procedural note is short, and
   * `apply.mjs`'s auto-apply path calls `store.store()` with no chunking
   * logic), so a plain lookup without chunk-family reassembly is sufficient.
   * Kept in sync with `MemoryStore.supersedeTopic()`, which apply.mjs calls
   * before every auto-applied write so this is genuinely one row, not just
   * the newest of several.
   */
  private latestPlaybook(project: string | null): string | null {
    if (!project) return null;
    try {
      const row = this.db
        .prepare(
          `SELECT content, timestamp FROM memories
           WHERE project = ? AND topic = 'playbook'
           ORDER BY timestamp DESC LIMIT 1`
        )
        .get(project) as { content: string; timestamp: string } | undefined;
      if (!row) return null;
      return (
        `## Memory — How to work efficiently on ${project} (updated ${row.timestamp.slice(0, 10)})\n` +
        `${row.content}\n\n` +
        `_Procedural notes from session-watchdog, not a live check — verify a command still exists before relying on it._`
      );
    } catch {
      return null;
    }
  }

  /**
   * Generate L1 Essential Story: top 15 memories by importance + recency,
   * grouped by project with compact formatting.
   */
  private generateL1(project: string[] | null, maxChars: number): string {
    if (this.countAll() === 0) {
      return "\n## Memory — Recent Context\nNo memories stored yet.";
    }

    // chunk_index = 0 only: continuation chunks inherit their parent's high
    // importance and would surface as mid-word fragments in the wake identity
    // context (live failure 2026-07-07: "serted by both pytest..." led L1).
    if (project && project.length > 0) {
      // Project-scoped (the common per-session case): ordered by recency, not
      // importance — the point of a project digest is "what's the latest state
      // of this project", not "what's ever been most important" (a stale but
      // once-important row would otherwise permanently occupy a slot a fresher
      // one should have). LIMIT widened well past the multi-project branch's 15
      // since this is the ONLY project(s) being shown, not one of many sharing
      // a budget — and no per-project slice or 200-char truncation either;
      // maxChars is the sole budget. Per-entry cap raised to 800 (not removed)
      // so one outsized memory can't eat the whole budget alone.
      const placeholders = project.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT content, project, topic, timestamp, importance
           FROM memories WHERE project IN (${placeholders}) AND chunk_index = 0
           ORDER BY timestamp DESC
           LIMIT 60`
        )
        .all(...project) as MemoryRow[];

      if (rows.length === 0) {
        return "\n## Memory — Recent Context\nNo memories stored yet for this project.";
      }

      const byProject: Record<string, MemoryRow[]> = {};
      for (const row of rows) {
        const proj = row.project || "general";
        if (!byProject[proj]) byProject[proj] = [];
        byProject[proj].push(row);
      }

      const lines: string[] = ["\n## Memory — Recent Context"];
      let totalChars = 0;
      for (const [proj, entries] of Object.entries(byProject).sort()) {
        if (totalChars > maxChars) break;
        lines.push(`\n[${proj}]`);
        for (const row of entries) {
          let snippet = row.content.trim().replace(/\n/g, " ");
          if (snippet.length > 800) snippet = snippet.slice(0, 797) + "...";
          const topic = row.topic || "";
          const line = topic && topic !== "general" ? `  - [${topic}] ${snippet}` : `  - ${snippet}`;
          totalChars += line.length;
          if (totalChars > maxChars) {
            lines.push("  ... (use memory_search for more)");
            break;
          }
          lines.push(line);
        }
      }
      return lines.join("\n");
    }

    // No project in scope — global overview across everything, sampled by
    // importance so a handful of items per project gives a broad sense of
    // what's stored without any one project dominating. Unchanged from before
    // project-scoping existed.
    const rows = this.db
      .prepare(
        `SELECT content, project, topic, timestamp, importance
         FROM memories WHERE chunk_index = 0
         ORDER BY importance DESC, timestamp DESC
         LIMIT 15`
      )
      .all() as MemoryRow[];

    if (rows.length === 0) {
      return "\n## Memory — Recent Context\nNo memories stored yet.";
    }

    // Group by project
    const byProject: Record<string, MemoryRow[]> = {};
    for (const row of rows) {
      const proj = row.project || "general";
      if (!byProject[proj]) byProject[proj] = [];
      byProject[proj].push(row);
    }

    const lines: string[] = ["\n## Memory — Recent Context"];
    let totalChars = 0;

    for (const [proj, entries] of Object.entries(byProject).sort()) {
      if (totalChars > maxChars) break;
      lines.push(`\n[${proj}]`);
      for (const row of entries.slice(0, 5)) {
        let snippet = row.content.trim().replace(/\n/g, " ");
        if (snippet.length > 200) snippet = snippet.slice(0, 197) + "...";
        const topic = row.topic || "";
        const line =
          topic && topic !== "general"
            ? `  - [${topic}] ${snippet}`
            : `  - ${snippet}`;
        totalChars += line.length;
        if (totalChars > maxChars) {
          lines.push("  ... (use memory_search for more)");
          break;
        }
        lines.push(line);
      }
    }

    return lines.join("\n");
  }

  status(): StatusResult {
    this.ensureLoaded();

    const projects = this.countByProject();
    const total = this.countAll();

    return {
      memory_dir: this.memoryDir,
      store_path: this.dbPath,
      identity_exists: fs.existsSync(this.identityPath),
      total_memories: total,
      projects,
      storage_size_kb: this.getStorageSizeKb(),
    };
  }

  /**
   * Bulk-prune all memories from a given source (e.g. "auto-capture"), deleting
   * from BOTH the memories table and the vec_memories vector index in one
   * transaction so no orphaned vectors are left behind. This is the safe way to
   * purge noise — the raw sqlite3 CLI cannot touch the vec0 index.
   *
   * Pass { dryRun: true } to count matches without deleting.
   */
  pruneBySource(
    source: string,
    opts?: { dryRun?: boolean }
  ): { matched: number; deleted: number } {
    this.ensureLoaded();
    if (!source || !source.trim()) throw new Error("No source provided");

    const rows = this.db
      .prepare(`SELECT rowid FROM memories WHERE source = ?`)
      .all(source) as { rowid: number }[];

    if (opts?.dryRun) return { matched: rows.length, deleted: 0 };
    if (rows.length === 0) return { matched: 0, deleted: 0 };

    const prune = this.db.transaction(() => {
      for (const r of rows) this.stmtDeleteVec.run(BigInt(r.rowid));
      this.db.prepare(`DELETE FROM memories WHERE source = ?`).run(source);
    });
    prune();

    // Invalidate L1 cache — the recent-context set may have changed.
    this.cachedL1 = null;

    return { matched: rows.length, deleted: rows.length };
  }

  delete(id: string): { status: string; id: string; rows?: number } {
    this.ensureLoaded();

    if (!id || !id.trim()) {
      throw new Error("No id provided");
    }

    // Family-aware: deleting any chunk of a chunked memory removes the whole
    // family. A stranded continuation chunk is unfindable noise — it has no
    // c0 context yet still competes in vector search.
    const family = id.replace(/_c\d+$/, "");
    // LIKE treats "_" as a single-char wildcard, so re-verify membership in JS
    // with an exact family pattern before deleting anything.
    const familyPattern = new RegExp(
      `^${family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(_c\\d+)?$`
    );
    const rows = (
      this.db
        .prepare(`SELECT rowid, id FROM memories WHERE id = ? OR id LIKE ?`)
        .all(id, `${family}_c%`) as { rowid: number; id: string }[]
    ).filter((row) => familyPattern.test(row.id));
    if (rows.length === 0) {
      throw new Error(`Memory not found: ${id}`);
    }

    // Delete from both tables in a transaction
    const deleteTransaction = this.db.transaction(() => {
      for (const row of rows) {
        this.stmtDeleteVec.run(BigInt(row.rowid));
        this.stmtDeleteMemory.run(row.id);
      }
    });
    deleteTransaction();

    // Invalidate L1 cache
    this.cachedL1 = null;

    return { status: "deleted", id, rows: rows.length };
  }

  /**
   * Delete the most recent memory for (project, topic), if one exists.
   * Used by session-watchdog's `playbook` auto-apply path (apply.mjs,
   * docs/design/watchdog-playbook.md Task 2) to enforce "one per project,
   * superseded not appended" the same way `session-resume` already does via
   * `latestResume()` — without this, every qualifying tick would add a new
   * row forever. Exposed as a public method rather than having callers reach
   * into `this.db` directly (private by convention, even though TypeScript's
   * `private` doesn't survive type-stripping into plain JS at runtime).
   * Best-effort: swallows errors, never throws — a missed supersede just
   * leaves one extra row, never fatal.
   */
  supersedeTopic(project: string, topic: string): { superseded: boolean } {
    this.ensureLoaded();
    try {
      const prior = this.db
        .prepare(`SELECT id FROM memories WHERE project = ? AND topic = ? ORDER BY timestamp DESC LIMIT 1`)
        .get(project, topic) as { id: string } | undefined;
      if (!prior?.id) return { superseded: false };
      this.delete(prior.id);
      return { superseded: true };
    } catch {
      return { superseded: false };
    }
  }

  /**
   * Delete every memory family for (project, topic) except `keepId`'s family.
   * Called from `store()` for SINGLETON_TOPICS so the invariant "exactly one
   * per project" holds regardless of which agent or script wrote the row.
   * `keepId` is the id the incoming save will get (or already has, when the
   * content is byte-identical and the save dedupes) — that family survives.
   * Best-effort: a failure here leaves an extra row, never blocks the save.
   */
  supersedeAllTopic(project: string, topic: string, keepId: string): { removed: number } {
    this.ensureLoaded();
    let removed = 0;
    try {
      const rows = this.db
        .prepare(`SELECT id FROM memories WHERE project = ? AND topic = ? AND chunk_index = 0`)
        .all(project, topic) as { id: string }[];
      const keepFamily = keepId.replace(/_c\d+$/, "");
      for (const row of rows) {
        if (row.id.replace(/_c\d+$/, "") === keepFamily) continue;
        try {
          this.delete(row.id);
          removed++;
        } catch {
          /* already gone or unreadable — keep going */
        }
      }
    } catch {
      /* best-effort */
    }
    return { removed };
  }

  /**
   * Re-weight a memory (whole chunk family). Used by the consolidation pass
   * after a human approves a demotion — importance is the only field that
   * ranking reads besides similarity, so this is how a stale-but-true memory
   * stops competing with live ones without being forgotten.
   */
  setImportance(id: string, importance: number): { updated: number } {
    this.ensureLoaded();
    const value = Math.max(0, Math.min(1, Number(importance)));
    const family = id.replace(/_c\d+$/, "");
    const res = this.db
      .prepare(`UPDATE memories SET importance = ? WHERE id = ? OR id = ? OR parent_id = ?`)
      .run(value, id, `${family}_c0`, `${family}_c0`);
    this.cachedL1 = null;
    return { updated: Number(res.changes) };
  }

  listProjects(): { projects: Record<string, number>; total: number } {
    const { projects, total_memories: total } = this.status();
    return { projects, total };
  }

  /**
   * L2: On-Demand Project Context.
   * Filtered retrieval by project/topic, ordered by timestamp descending.
   */
  recall(options?: {
    project?: string;
    topic?: string;
    n_results?: number;
  }): {
    filters: Record<string, string | null>;
    count: number;
    results: SearchResult[];
  } {
    this.ensureLoaded();

    const project = options?.project || null;
    const topic = options?.topic || null;
    const nResults = Math.min(options?.n_results || 10, 50);

    // Build dynamic query. chunk_index = 0 only — recall is a recency listing,
    // and continuation chunks would show as duplicate mid-sentence entries of
    // the same memory.
    const conditions: string[] = ["chunk_index = 0"];
    const params: any[] = [];

    if (project) {
      conditions.push("project = ?");
      params.push(project);
    }
    if (topic) {
      conditions.push("topic = ?");
      params.push(topic);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = this.db
      .prepare(
        `SELECT id, content, project, topic, source, timestamp, importance
         FROM memories ${whereClause}
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(...params, nResults) as MemoryRow[];

    const results: SearchResult[] = rows.map((row) => ({
      id: row.id,
      text: row.content,
      project: row.project,
      topic: row.topic,
      source: row.source,
      timestamp: row.timestamp,
      similarity: 0, // Not applicable for recall
      importance: row.importance ?? 0.5,
    }));

    return { filters: { project, topic }, count: results.length, results };
  }

  // -----------------------------------------------------------------------
  // Stats
  // -----------------------------------------------------------------------

  computeStats(): MemoryStats {
    this.ensureLoaded();

    const total = this.countAll();

    if (total === 0) {
      return {
        total: 0,
        projects: {},
        topics: {},
        sources: {},
        sessions: 0,
        oldest: null,
        newest: null,
        timeline: {},
        avgContentLength: 0,
        storageSizeKb: 0,
      };
    }

    const projects = this.groupedCounts("project");
    const topics = this.groupedCounts("topic");
    const sources = this.groupedCounts("source");

    // Session count
    const sessionCount = (
      this.db
        .prepare(
          `SELECT COUNT(DISTINCT session_id) as cnt FROM memories WHERE session_id != ''`
        )
        .get() as CountRow
    ).cnt;

    // Oldest/newest timestamps
    const oldest = (
      this.db.prepare(`SELECT MIN(timestamp) as val FROM memories`).get() as {
        val: string | null;
      }
    ).val;
    const newest = (
      this.db.prepare(`SELECT MAX(timestamp) as val FROM memories`).get() as {
        val: string | null;
      }
    ).val;

    // Timeline: memories per day
    const timeline: Record<string, number> = {};
    const timelineRows = this.db
      .prepare(
        `SELECT SUBSTR(timestamp, 1, 10) as day, COUNT(*) as cnt
         FROM memories GROUP BY day ORDER BY day`
      )
      .all() as { day: string; cnt: number }[];
    for (const r of timelineRows) {
      timeline[r.day] = r.cnt;
    }

    // Average content length
    const avgLen = (
      this.db
        .prepare(`SELECT AVG(LENGTH(content)) as val FROM memories`)
        .get() as { val: number }
    ).val;

    return {
      total,
      projects,
      topics,
      sources,
      sessions: sessionCount,
      oldest,
      newest,
      timeline,
      avgContentLength: Math.round(avgLen || 0),
      storageSizeKb: this.getStorageSizeKb(),
    };
  }

  // -----------------------------------------------------------------------
  // Palace Graph / Tunnels
  // -----------------------------------------------------------------------

  /**
   * Discover tunnels: topics that appear in multiple projects.
   * A tunnel connects two projects that share the same topic.
   */
  discoverTunnels(): TunnelInfo[] {
    this.ensureLoaded();

    // Find topics shared across 2+ projects
    const rows = this.db
      .prepare(
        `SELECT topic, project, COUNT(*) as cnt
         FROM memories
         WHERE topic != 'general'
         GROUP BY topic, project
         HAVING cnt >= 1`
      )
      .all() as { topic: string; project: string; cnt: number }[];

    // Group by topic
    const topicProjects: Record<
      string,
      { project: string; count: number }[]
    > = {};
    for (const row of rows) {
      if (!topicProjects[row.topic]) topicProjects[row.topic] = [];
      topicProjects[row.topic].push({ project: row.project, count: row.cnt });
    }

    // Build tunnel list (topics with 2+ projects)
    const tunnels: TunnelInfo[] = [];
    for (const [topic, projects] of Object.entries(topicProjects)) {
      if (projects.length < 2) continue;

      // Create pairwise tunnels
      for (let i = 0; i < projects.length; i++) {
        for (let j = i + 1; j < projects.length; j++) {
          const [a, b] = [projects[i], projects[j]].sort((x, y) =>
            x.project.localeCompare(y.project)
          );
          tunnels.push({
            topic,
            projects: [a.project, b.project],
            memoryCounts: [a.count, b.count],
          });
        }
      }
    }

    return tunnels;
  }

  /**
   * Get the palace graph: projects as nodes, tunnels as edges.
   */
  getPalaceGraph(): PalaceGraph {
    this.ensureLoaded();

    const projects = this.countByProject();
    const tunnels = this.discoverTunnels();

    const nodes: PalaceNode[] = Object.entries(projects).map(
      ([name, count]) => ({
        name,
        memoryCount: count,
        topics: this.getProjectTopics(name),
      })
    );

    const edges: PalaceEdge[] = tunnels.map((t) => ({
      topic: t.topic,
      projectA: t.projects[0],
      projectB: t.projects[1],
      strength: t.memoryCounts[0] + t.memoryCounts[1],
    }));

    return { nodes, edges };
  }

  /**
   * Traverse a tunnel: find memories in both projects for a shared topic.
   */
  traverseTunnel(
    topic: string,
    projectA: string,
    projectB: string,
    n_results?: number
  ): SearchResult[] {
    this.ensureLoaded();
    const limit = Math.min(n_results || 10, 50);

    const rows = this.db
      .prepare(
        `SELECT id, content, project, topic, source, timestamp, importance
         FROM memories
         WHERE topic = ? AND project IN (?, ?)
         ORDER BY timestamp DESC
         LIMIT ?`
      )
      .all(topic, projectA, projectB, limit) as MemoryRow[];

    return rows.map((row) => ({
      id: row.id,
      text: row.content,
      project: row.project,
      topic: row.topic,
      source: row.source,
      timestamp: row.timestamp,
      similarity: 0,
      importance: row.importance ?? 0.5,
    }));
  }

  /** Helper: get distinct non-general topics for a project. */
  private getProjectTopics(project: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT topic FROM memories WHERE project = ? AND topic != 'general'`
      )
      .all(project) as { topic: string }[];
    return rows.map((r) => r.topic);
  }

  // -----------------------------------------------------------------------
  // Knowledge Graph
  // -----------------------------------------------------------------------

  /**
   * Add or update an entity in the knowledge graph.
   */
  addEntity(input: EntityInput): EntityResult {
    this.ensureLoaded();

    const id =
      input.id || `ent_${contentHash(input.name.toLowerCase())}`;
    const existing = this.db
      .prepare("SELECT id FROM entities WHERE id = ?")
      .get(id) as { id: string } | undefined;

    if (existing) {
      // Preserve existing type/properties unless the caller supplies new ones —
      // addTriple auto-creates bare entities and must not clobber typed ones.
      this.db
        .prepare(
          `UPDATE entities SET name = ?,
             entity_type = COALESCE(?, entity_type),
             properties = COALESCE(?, properties)
           WHERE id = ?`
        )
        .run(
          input.name,
          input.entity_type ?? null,
          input.properties ? JSON.stringify(input.properties) : null,
          id
        );
      return { status: "updated", id };
    }

    this.db
      .prepare(
        `INSERT INTO entities (id, name, entity_type, properties, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.entity_type || "unknown",
        JSON.stringify(input.properties || {}),
        new Date().toISOString()
      );

    return { status: "created", id };
  }

  /**
   * Add a temporal triple (fact) to the knowledge graph.
   */
  addTriple(input: TripleInput): TripleResult {
    this.ensureLoaded();

    // Auto-create entities if they don't exist. A caller-supplied type is
    // applied (COALESCE in addEntity keeps an existing type when none is given).
    this.addEntity({
      name: input.subject,
      id: `ent_${contentHash(input.subject.toLowerCase())}`,
      entity_type: normalizeEntityType(input.subject_type),
    });
    this.addEntity({
      name: input.object,
      id: `ent_${contentHash(input.object.toLowerCase())}`,
      entity_type: normalizeEntityType(input.object_type),
    });
    // PROTOCOL.md has always said "give every new entity a type via an is_a
    // fact" — but nothing read those facts, which is how 400+ entities ended up
    // typed 'unknown'. An is_a fact now types its subject.
    if (IS_A_PREDICATES.has(input.predicate.toLowerCase())) {
      const t = normalizeEntityType(input.object);
      if (t) {
        this.setEntityType(input.subject, t);
        // The object of an is_a fact is a type name, not a thing — mark it so it
        // never shows up in kg-untyped as if it were an entity nobody classified.
        this.setEntityTypeIfUnknown(input.object, "type");
      }
    }

    const subjectId = `ent_${contentHash(input.subject.toLowerCase())}`;
    const objectId = `ent_${contentHash(input.object.toLowerCase())}`;

    const info = this.db
      .prepare(
        `INSERT INTO triples (subject, predicate, object, valid_from, valid_to, confidence, source_memory_id, project, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        subjectId,
        input.predicate,
        objectId,
        toKgDate(input.valid_from),
        toKgDate(input.valid_to),
        input.confidence ?? 1.0,
        input.source_memory_id || null,
        input.project || "general",
        new Date().toISOString()
      );

    return { status: "created", id: Number(info.lastInsertRowid) };
  }

  /** Set (overwrite) the type of an existing entity by name. */
  setEntityType(name: string, type: string): { status: "updated" | "missing"; id: string } {
    this.ensureLoaded();
    const id = `ent_${contentHash(name.toLowerCase())}`;
    const t = normalizeEntityType(type);
    if (!t) throw new Error(`invalid entity type: ${JSON.stringify(type)}`);
    const info = this.db.prepare(`UPDATE entities SET entity_type = ? WHERE id = ?`).run(t, id);
    return { status: info.changes > 0 ? "updated" : "missing", id };
  }

  /** Type an entity only if it is still 'unknown' (never clobbers a real type). */
  setEntityTypeIfUnknown(name: string, type: string): boolean {
    this.ensureLoaded();
    const id = `ent_${contentHash(name.toLowerCase())}`;
    const t = normalizeEntityType(type);
    if (!t) return false;
    return this.db.prepare(`UPDATE entities SET entity_type = ? WHERE id = ? AND entity_type = 'unknown'`).run(t, id).changes > 0;
  }

  /** Entities still typed 'unknown', with how many facts reference them (optionally within a project). */
  listUntypedEntities(options?: { project?: string; limit?: number }): Array<{ name: string; facts: number }> {
    this.ensureLoaded();
    const limit = Math.max(1, Math.min(500, options?.limit ?? 50));
    const proj = options?.project ? "AND t.project = ?" : "";
    const args: unknown[] = options?.project ? [options.project, limit] : [limit];
    return this.db
      .prepare(
        `SELECT e.name as name, COUNT(t.id) as facts
         FROM entities e
         LEFT JOIN triples t ON (t.subject = e.id OR t.object = e.id) ${proj}
         WHERE e.entity_type = 'unknown'
         GROUP BY e.id ORDER BY facts DESC, e.name ASC LIMIT ?`
      )
      .all(...args) as Array<{ name: string; facts: number }>;
  }

  /** One-off migration: type every 'unknown' subject that already has an active is_a fact. */
  backfillTypesFromIsA(): { updated: number; skipped: number } {
    this.ensureLoaded();
    const preds = [...IS_A_PREDICATES].map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT s.id as sid, o.name as type FROM triples t
         JOIN entities s ON s.id = t.subject JOIN entities o ON o.id = t.object
         WHERE lower(t.predicate) IN (${preds}) AND t.valid_to IS NULL AND s.entity_type = 'unknown'
         ORDER BY t.created_at ASC`
      )
      .all(...IS_A_PREDICATES) as Array<{ sid: string; type: string }>;
    let updated = 0, skipped = 0;
    const upd = this.db.prepare(`UPDATE entities SET entity_type = ? WHERE id = ? AND entity_type = 'unknown'`);
    for (const r of rows) {
      const t = normalizeEntityType(r.type);
      if (!t) { skipped++; continue; }
      if (upd.run(t, r.sid).changes > 0) updated++; else skipped++;
      if (this.setEntityTypeIfUnknown(r.type, "type")) updated++;
    }
    return { updated, skipped };
  }

  /**
   * Query the knowledge graph for facts about an entity.
   * Supports temporal filtering: only returns facts valid at a given point in time.
   */
  queryEntity(
    name: string,
    options?: { at_time?: string; project?: string }
  ): KnowledgeResult {
    this.ensureLoaded();

    const entityId = `ent_${contentHash(name.toLowerCase())}`;
    const entity = this.db
      .prepare("SELECT * FROM entities WHERE id = ?")
      .get(entityId) as any;

    if (!entity) return { entity: null, facts: [] };

    let query = `
      SELECT t.*,
        s.name as subject_name, s.entity_type as subject_type,
        o.name as object_name, o.entity_type as object_type
      FROM triples t
      JOIN entities s ON t.subject = s.id
      JOIN entities o ON t.object = o.id
      WHERE (t.subject = ? OR t.object = ?)
    `;
    const params: any[] = [entityId, entityId];

    if (options?.at_time) {
      const at = toKgDate(options.at_time);
      query += ` AND (t.valid_from IS NULL OR t.valid_from <= ?)
                 AND (t.valid_to IS NULL OR t.valid_to >= ?)`;
      params.push(at, at);
    }

    if (options?.project) {
      query += ` AND t.project = ?`;
      params.push(options.project);
    }

    query += ` ORDER BY t.created_at DESC`;

    const rows = this.db.prepare(query).all(...params) as any[];

    const facts: Fact[] = rows.map((r) => ({
      subject: r.subject_name,
      predicate: r.predicate,
      object: r.object_name,
      valid_from: r.valid_from,
      valid_to: r.valid_to,
      confidence: r.confidence,
      project: r.project,
    }));

    return {
      entity: {
        id: entity.id,
        name: entity.name,
        type: entity.entity_type,
        properties: JSON.parse(entity.properties || "{}"),
      },
      facts,
    };
  }

  /**
   * Current (valid_to IS NULL) knowledge-graph facts scoped to project(s),
   * most recently created first. The KG counterpart to generateL1's free-text
   * memory digest, injected into wakeup() — without it, session start is
   * KG-blind: queryEntity() requires an entity name the agent doesn't have
   * yet, so structured facts are otherwise unreachable until the agent
   * already knows what to ask about.
   */
  projectFacts(
    projects: string[],
    limit = 40
  ): { subject: string; predicate: string; object: string; valid_from: string | null }[] {
    this.ensureLoaded();
    if (!projects || projects.length === 0) return [];
    const placeholders = projects.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT s.name as subject, t.predicate, o.name as object, t.valid_from
         FROM triples t
         JOIN entities s ON t.subject = s.id
         JOIN entities o ON t.object = o.id
         WHERE t.project IN (${placeholders}) AND t.valid_to IS NULL
         ORDER BY t.created_at DESC
         LIMIT ?`
      )
      .all(...projects, limit) as { subject: string; predicate: string; object: string; valid_from: string | null }[];
  }

  /**
   * Query triples by predicate (e.g., "uses", "depends_on", "decided").
   */
  queryByPredicate(
    predicate: string,
    options?: { project?: string; at_time?: string }
  ): Fact[] {
    this.ensureLoaded();

    let query = `
      SELECT t.*,
        s.name as subject_name,
        o.name as object_name
      FROM triples t
      JOIN entities s ON t.subject = s.id
      JOIN entities o ON t.object = o.id
      WHERE t.predicate = ?
    `;
    const params: any[] = [predicate];

    if (options?.at_time) {
      const at = toKgDate(options.at_time);
      query += ` AND (t.valid_from IS NULL OR t.valid_from <= ?)
                 AND (t.valid_to IS NULL OR t.valid_to >= ?)`;
      params.push(at, at);
    }

    if (options?.project) {
      query += ` AND t.project = ?`;
      params.push(options.project);
    }

    query += ` ORDER BY t.created_at DESC`;

    const rows = this.db.prepare(query).all(...params) as any[];

    return rows.map((r) => ({
      subject: r.subject_name,
      predicate: r.predicate,
      object: r.object_name,
      valid_from: r.valid_from,
      valid_to: r.valid_to,
      confidence: r.confidence,
      project: r.project,
    }));
  }

  /**
   * Invalidate a fact by setting valid_to.
   */
  invalidateTriple(tripleId: number, valid_to?: string): void {
    this.ensureLoaded();
    this.db
      .prepare(`UPDATE triples SET valid_to = ? WHERE id = ?`)
      .run(toKgDate(valid_to) || localToday(), tripleId);
  }

  /**
   * Get knowledge graph stats.
   */
  knowledgeStats(): KnowledgeStats {
    this.ensureLoaded();

    const entityCount = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM entities").get() as any
    ).cnt;
    const tripleCount = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM triples").get() as any
    ).cnt;
    const activeTriples = (
      this.db
        .prepare(
          "SELECT COUNT(*) as cnt FROM triples WHERE valid_to IS NULL"
        )
        .get() as any
    ).cnt;

    const entityTypes: Record<string, number> = {};
    const typeRows = this.db
      .prepare(
        "SELECT entity_type, COUNT(*) as cnt FROM entities GROUP BY entity_type"
      )
      .all() as any[];
    for (const r of typeRows) entityTypes[r.entity_type] = r.cnt;

    const predicates: Record<string, number> = {};
    const predRows = this.db
      .prepare(
        "SELECT predicate, COUNT(*) as cnt FROM triples GROUP BY predicate ORDER BY cnt DESC LIMIT 20"
      )
      .all() as any[];
    for (const r of predRows) predicates[r.predicate] = r.cnt;

    return {
      entityCount,
      tripleCount,
      activeTriples,
      entityTypes,
      predicates,
    };
  }

  // -----------------------------------------------------------------------
  // Utility
  // -----------------------------------------------------------------------

  private getStorageSizeKb(): number {
    try {
      if (fs.existsSync(this.dbPath)) {
        return Math.round((fs.statSync(this.dbPath).size / 1024) * 10) / 10;
      }
    } catch { /* ignore */ }
    return 0;
  }

  private countByProject(): Record<string, number> {
    return this.groupedCounts("project");
  }

  private groupedCounts(column: string): Record<string, number> {
    const result: Record<string, number> = {};
    const rows = this.db
      .prepare(`SELECT ${column}, COUNT(*) as cnt FROM memories GROUP BY ${column}`)
      .all() as Record<string, any>[];
    for (const r of rows) {
      result[r[column] || "general"] = r.cnt;
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // List Rooms / Taxonomy / Duplicate Check / Diary / KG Timeline
  // -----------------------------------------------------------------------

  /**
   * List topics (rooms) with counts, optionally filtered by project.
   */
  listRooms(project?: string): RoomInfo[] {
    this.ensureLoaded();

    let query: string;
    let params: any[];

    if (project) {
      query = `SELECT topic, COUNT(*) as cnt FROM memories
               WHERE project = ? GROUP BY topic ORDER BY cnt DESC`;
      params = [project];
    } else {
      query = `SELECT topic, COUNT(*) as cnt FROM memories
               GROUP BY topic ORDER BY cnt DESC`;
      params = [];
    }

    const rows = this.db.prepare(query).all(...params) as { topic: string; cnt: number }[];

    return rows.map((r) => {
      // Find which projects use this topic
      const projectRows = this.db
        .prepare(
          `SELECT DISTINCT project FROM memories WHERE topic = ?`
        )
        .all(r.topic) as { project: string }[];

      return {
        topic: r.topic,
        count: r.cnt,
        projects: projectRows.map((p) => p.project),
      };
    });
  }

  /**
   * Full taxonomy: project → topics → counts.
   */
  getTaxonomy(): TaxonomyNode[] {
    this.ensureLoaded();

    const rows = this.db
      .prepare(
        `SELECT project, topic, COUNT(*) as cnt FROM memories
         GROUP BY project, topic ORDER BY project, cnt DESC`
      )
      .all() as { project: string; topic: string; cnt: number }[];

    const byProject: Record<string, { topic: string; count: number }[]> = {};
    const projectTotals: Record<string, number> = {};

    for (const r of rows) {
      if (!byProject[r.project]) {
        byProject[r.project] = [];
        projectTotals[r.project] = 0;
      }
      byProject[r.project].push({ topic: r.topic, count: r.cnt });
      projectTotals[r.project] += r.cnt;
    }

    return Object.entries(byProject)
      .sort(([, a], [, b]) => {
        const totalA = a.reduce((s, t) => s + t.count, 0);
        const totalB = b.reduce((s, t) => s + t.count, 0);
        return totalB - totalA;
      })
      .map(([project, topics]) => ({
        project,
        topics,
        total: projectTotals[project],
      }));
  }

  /**
   * Check if content already exists (by hash or semantic similarity).
   */
  async checkDuplicate(
    content: string,
    threshold: number = 0.9
  ): Promise<DuplicateCheckResult> {
    this.ensureLoaded();

    // 1. Exact hash match
    const cHash = contentHash(content);
    const hashRow = this.stmtFindByHash.get(cHash);
    if (hashRow) {
      return { isDuplicate: true, hashMatch: true, semanticMatch: null };
    }

    // 2. Semantic similarity check (pure similarity — dedup needs the true
    // nearest match, not the importance-blended ranking used by memory_search).
    const searchResult = await this.search(content, { n_results: 1, rank: "similarity" });
    if (
      searchResult.results.length > 0 &&
      searchResult.results[0].similarity >= threshold
    ) {
      return {
        isDuplicate: true,
        hashMatch: false,
        semanticMatch: searchResult.results[0],
      };
    }

    return { isDuplicate: false, hashMatch: false, semanticMatch: null };
  }

  /**
   * Write a diary entry. Stored as a memory with topic="diary" and source="diary".
   */
  async diaryWrite(input: {
    agent_name: string;
    entry: string;
    topic?: string;
    project?: string;
  }): Promise<StoreResult> {
    return this.store({
      content: input.entry,
      project: input.project || `diary-${input.agent_name.toLowerCase().replace(/\s+/g, "_")}`,
      topic: input.topic || "diary",
      source: "diary",
      importance: 0.7,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Read recent diary entries for an agent, in chronological order.
   */
  diaryRead(input: {
    agent_name: string;
    last_n?: number;
    project?: string;
  }): SearchResult[] {
    this.ensureLoaded();

    const project = input.project || `diary-${input.agent_name.toLowerCase().replace(/\s+/g, "_")}`;
    const limit = Math.min(input.last_n || 10, 100);

    const rows = this.db
      .prepare(
        `SELECT id, content, project, topic, source, timestamp, importance
         FROM memories
         WHERE project = ? AND source = 'diary'
         ORDER BY timestamp ASC
         LIMIT ?`
      )
      .all(project, limit) as MemoryRow[];

    return rows.map((row) => ({
      id: row.id,
      text: row.content,
      project: row.project,
      topic: row.topic,
      source: row.source,
      timestamp: row.timestamp,
      similarity: 0,
      importance: row.importance ?? 0.5,
    }));
  }

  /**
   * Knowledge graph timeline: chronological list of facts for an entity (or all).
   */
  kgTimeline(entity?: string): TimelineFact[] {
    this.ensureLoaded();

    let query: string;
    let params: any[];

    if (entity) {
      const entityId = `ent_${contentHash(entity.toLowerCase())}`;
      query = `
        SELECT t.id, t.predicate, t.valid_from, t.valid_to, t.confidence,
               t.project, t.created_at,
               s.name as subject_name, o.name as object_name
        FROM triples t
        JOIN entities s ON t.subject = s.id
        JOIN entities o ON t.object = o.id
        WHERE t.subject = ? OR t.object = ?
        ORDER BY COALESCE(t.valid_from, t.created_at) ASC`;
      params = [entityId, entityId];
    } else {
      query = `
        SELECT t.id, t.predicate, t.valid_from, t.valid_to, t.confidence,
               t.project, t.created_at,
               s.name as subject_name, o.name as object_name
        FROM triples t
        JOIN entities s ON t.subject = s.id
        JOIN entities o ON t.object = o.id
        ORDER BY COALESCE(t.valid_from, t.created_at) ASC`;
      params = [];
    }

    const rows = this.db.prepare(query).all(...params) as any[];

    return rows.map((r) => ({
      id: r.id,
      subject: r.subject_name,
      predicate: r.predicate,
      object: r.object_name,
      valid_from: r.valid_from,
      valid_to: r.valid_to,
      confidence: r.confidence,
      project: r.project,
      created_at: r.created_at,
    }));
  }

  /**
   * Find a triple by subject/predicate/object names (for invalidation by name).
   */
  findTriple(subject: string, predicate: string, object: string): number | null {
    this.ensureLoaded();

    const subjectId = `ent_${contentHash(subject.toLowerCase())}`;
    const objectId = `ent_${contentHash(object.toLowerCase())}`;

    const row = this.db
      .prepare(
        `SELECT id FROM triples
         WHERE subject = ? AND predicate = ? AND object = ?
         AND valid_to IS NULL
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(subjectId, predicate, objectId) as { id: number } | undefined;

    return row ? row.id : null;
  }

  /** Get total memory count. */
  get size(): number {
    this.ensureLoaded();
    return this.countAll();
  }

  /** Check if a memory exists by ID. */
  has(id: string): boolean {
    this.ensureLoaded();
    return !!this.stmtHasId.get(id);
  }
}
