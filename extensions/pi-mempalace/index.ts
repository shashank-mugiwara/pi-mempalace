/**
 * pi-mempalace — Persistent Agent Memory Extension
 *
 * Raw verbatim storage of conversation exchanges with semantic search.
 * Never lose context again.
 *
 * Provides:
 * - `memory_search` tool — semantic search across all stored memories
 * - `memory_save` tool — manually save a specific piece of information
 * - `memory_recall` tool — retrieve memories for a project/topic (L2)
 * - `memory_status` tool — show memory store overview
 * - Auto-capture of conversation exchanges on session shutdown/compact
 * - Wake-up context injection (L0 identity + L1 top memories) into system prompt
 * - Auto-recall: each user prompt is semantically matched against the store and
 *   top hits are injected as a `pi-mempalace-recall` message (config: autoRecall*)
 * - Status widget showing memory count
 * - `/memory` command for quick operations
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { MemoryStats, TaxonomyNode } from "./memory_store.js";
import { Type } from "@earendil-works/pi-ai";
// `complete` isn't re-exported from the bare "@earendil-works/pi-ai" entry
// in this repo's installed version — memory-summarizer.ts's import from the
// main package doesn't resolve against this devDependency, so pull it from
// the "/compat" subpath where it's actually declared (same function, same
// call pattern: complete(model, context, options)).
import { complete } from "@earendil-works/pi-ai/compat";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { localToday, MemoryStore } from "./memory_store.js";
import { selectRecall, type GateJudgeInput, type RecallGateOptions, type RecallResult } from "./recall.ts";
import { warmReranker } from "./reranker.ts";
import { buildGatePrompt, parseGateResponse, type GateSkillInput, type GateVerdict } from "./gate.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// MEMPALACE_HOME relocates the whole store — must match memory_store.ts.
const MEMORY_DIR =
  process.env.MEMPALACE_HOME ||
  path.join(os.homedir(), ".pi", "agent", "memory");
const CONFIG_PATH = path.join(MEMORY_DIR, "config.json");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max chars appended to system prompt for the taxonomy section. */
const MAX_TAXONOMY_CHARS = 3500;
/** Max topics to show per project before truncating (keeps lines compact, model can call memory_taxonomy for full list). */
const MAX_TOPICS_PER_PROJECT = 5;
/** Skip projects with fewer memories than this — reduces noise from one-off projects. */
const MIN_PROJECT_MEMORIES = 5;
/** Where skill packs live — scanned for the gate's skill-suggestion feature. */
const SKILLS_DIR = path.join(os.homedir(), ".pi", "agent", "skills");
/** Truncate a skill's frontmatter description to this many chars before offering it to the gate. */
const MAX_SKILL_DESCRIPTION_CHARS = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MemoryConfig {
  /** Auto-capture conversation exchanges */
  autoCapture: boolean;
  /** Inject wake-up context into system prompt */
  wakeUpEnabled: boolean;
  /** Maximum tokens for wake-up context */
  wakeUpMaxTokens: number;
  /** Default project name (auto-detected from cwd if not set) */
  defaultProject: string | null;
  /** Auto-recall: semantically match each user prompt against the store and inject top hits as a message */
  autoRecall: boolean;
  /** Minimum similarity (0-1) for an auto-recalled memory */
  autoRecallMinSimilarity: number;
  /** Max memories injected per prompt */
  autoRecallMaxResults: number;
  /** Max characters of recalled content injected per prompt */
  autoRecallMaxChars: number;
  /** Skip auto-recall for prompts shorter than this many characters */
  autoRecallMinPromptChars: number;
  /** n_results passed to store.search() when reranking is on (wider pool than legacy) */
  autoRecallCandidates: number;
  /** Candidates below this bi-encoder similarity are dropped before reranking */
  autoRecallCandidateFloor: number;
  /** Lower bi-encoder floor applied instead of autoRecallCandidateFloor when the candidate's project matches the current project (same-project candidates get a fairer shot at the cross-encoder) */
  autoRecallCandidateFloorSameProject: number;
  /** Penalty subtracted from a hit's score when its project doesn't match the current project */
  autoRecallCrossProjectPenalty: number;
  /** Use the cross-encoder reranker as the relevance gate (falls back to the legacy similarity-only path on failure) */
  autoRecallRerank: boolean;
  /** Minimum cross-encoder score (post cross-project-penalty) for a reranked candidate to be picked */
  autoRecallRerankMinScore: number;
  /** Inject the project→topic taxonomy index into the system prompt */
  taxonomyEnabled: boolean;
  /** Max characters for the injected taxonomy section */
  taxonomyMaxChars: number;
  /** Send gray-zone reranked candidates to an LLM relevance gate before injecting them (falls open to the plain rerankMinScore rule on any gate failure) */
  autoRecallLlmGate: boolean;
  /** Provider for the LLM relevance gate (resolved via ctx.modelRegistry, same as memory-summarizer.ts) */
  autoRecallGateProvider: string;
  /** Model id for the LLM relevance gate */
  autoRecallGateModel: string;
  /** Hard timeout (ms) for the gate model call — abort and fail open past this */
  autoRecallGateTimeoutMs: number;
  /** Gate failure behavior: "open" injects rerank-threshold survivors, "closed" injects only the auto-approve tier (see recall.ts) */
  autoRecallGateFailMode: "open" | "closed";
  /** Candidates with finalScore >= this skip the gate entirely (auto-approved) */
  autoRecallGateAutoApprove: number;
  /** Candidates with finalScore below this are auto-rejected and never sent to the gate */
  autoRecallGateMinScore: number;
  /** Max gray-zone candidates sent to the gate in one call */
  autoRecallGateMaxCandidates: number;
  /** Ask the gate to also suggest up to 2 applicable skills from ~/.pi/agent/skills */
  autoRecallGateSuggestSkills: boolean;
}

interface MemoryRuntime {
  /** Current configuration */
  config: MemoryConfig;
  /** Total memories in store (cached) */
  totalMemories: number;
  /** Per-project counts (cached) */
  projects: Record<string, number>;
  /** Whether the backend is available */
  backendAvailable: boolean;
  /** Cached wake-up text (refreshed on session_start) */
  wakeUpText: string | null;
  /** Cached taxonomy text for system prompt injection (refreshed on session_start) */
  taxonomyText: string | null;
  /** Current project context */
  currentProject: string;
  /** Whether memory mode is enabled */
  enabled: boolean;
  /** The memory store instance */
  store: MemoryStore;
  /** Memory ids already auto-recalled this session (avoid re-injecting) */
  recalledIds: Set<string>;
  /** Cached skills catalog (name + first-200-chars description) for the LLM gate's skill-suggestion feature, refreshed on session_start when autoRecallGateSuggestSkills is on. */
  skillsCatalog: GateSkillInput[] | null;
}

// ---------------------------------------------------------------------------
// Taxonomy helpers
// ---------------------------------------------------------------------------

/**
 * Render a compact project → topic(count) index for system-prompt injection.
 * Helps the model know what memory regions exist before it calls memory_search.
 */
function buildTaxonomySection(
  taxonomy: TaxonomyNode[],
  maxChars: number = MAX_TAXONOMY_CHARS,
): string | null {
  if (!taxonomy || taxonomy.length === 0) return null;

  const lines: string[] = [
    "## Memory — Taxonomy (what's stored)",
    "Projects and topics in the memory palace. Use `memory_recall(project, topic)` or `memory_search(query)` to retrieve:",
    "",
  ];

  for (const node of taxonomy) {
    // Skip tiny projects — they add noise without actionable recall targets.
    if (node.total < MIN_PROJECT_MEMORIES) continue;
    const shown = node.topics.slice(0, MAX_TOPICS_PER_PROJECT);
    const more = node.topics.length > MAX_TOPICS_PER_PROJECT
      ? ` +${node.topics.length - MAX_TOPICS_PER_PROJECT} more`
      : "";
    const topicList = shown.map(t => `${t.topic}(${t.count})`).join(", ");
    lines.push(`- **${node.project}** (${node.total}): ${topicList}${more}`);
  }

  // Truncate at project boundary (not mid-line) to keep the output clean.
  const header = lines.slice(0, 3).join("\n");
  const projectLines = lines.slice(3);
  let result = header;
  let truncated = false;
  for (const line of projectLines) {
    const candidate = result + "\n" + line;
    if (candidate.length > maxChars) {
      truncated = true;
      break;
    }
    result = candidate;
  }
  if (truncated) result += "\n\n*…more projects available — call `memory_taxonomy()` for the full list.*";
  return result;
}

// ---------------------------------------------------------------------------
// Skills catalog (LLM gate skill-suggestion feature)
// ---------------------------------------------------------------------------

/**
 * Scan each `SKILL.md` under SKILLS_DIR (one subdirectory per skill) for
 * frontmatter `name:` and `description:`, truncating descriptions to
 * MAX_SKILL_DESCRIPTION_CHARS. Best-effort: missing/unreadable/malformed
 * files are silently skipped, a missing skills dir yields an empty catalog.
 * Never throws.
 */
function scanSkillsCatalog(): GateSkillInput[] {
  const out: GateSkillInput[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(SKILLS_DIR, entry.name, "SKILL.md");
    try {
      const raw = fs.readFileSync(skillPath, "utf-8");
      const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!frontmatter) continue;
      const fm = frontmatter[1];
      const nameMatch = fm.match(/^name:\s*(.+?)\s*$/m);
      const descMatch = fm.match(/^description:\s*(.+?)\s*$/m);
      if (!nameMatch || !descMatch) continue;
      out.push({
        name: nameMatch[1].trim(),
        description: descMatch[1].trim().slice(0, MAX_SKILL_DESCRIPTION_CHARS),
      });
    } catch {
      // Skip unreadable/malformed skill — best-effort catalog.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function defaultConfig(): MemoryConfig {
  return {
    // OFF by default. Auto-capture at importance 0.5 is what polluted the
    // store this fork exists to fix (4,585 of 5,527 rows were noise) — a
    // fresh install with no config.json must not silently re-enable it.
    autoCapture: false,
    wakeUpEnabled: true,
    wakeUpMaxTokens: 800,
    defaultProject: null,
    autoRecall: true,
    autoRecallMinSimilarity: 0.5,
    autoRecallMaxResults: 4,
    autoRecallMaxChars: 2400,
    autoRecallMinPromptChars: 30,
    autoRecallCandidates: 24,
    autoRecallCandidateFloor: 0.45,
    // bench q13 — a same-project relevant memory at sim 0.386 never reached
    // the cross-encoder under the 0.45 floor. Same-project candidates get a
    // lower floor since a cross-project penalty already suppresses noise
    // from other projects; cross-project candidates keep autoRecallCandidateFloor.
    autoRecallCandidateFloorSameProject: 0.35,
    autoRecallCrossProjectPenalty: 0.08,
    autoRecallRerank: true,
    // tuned from bench v2-rerank — ce scores are bimodal, relevant 0.65+, junk <0.02.
    autoRecallRerankMinScore: 0.40,
    taxonomyEnabled: true,
    taxonomyMaxChars: 2000,
    autoRecallLlmGate: true,
    autoRecallGateProvider: "anthropic",
    autoRecallGateModel: "claude-haiku-4-5",
    autoRecallGateTimeoutMs: 2500,
    autoRecallGateFailMode: "open",
    autoRecallGateAutoApprove: 0.85,
    autoRecallGateMinScore: 0.15,
    autoRecallGateMaxCandidates: 10,
    autoRecallGateSuggestSkills: true,
  };
}

function createRuntime(): MemoryRuntime {
  return {
    config: defaultConfig(),
    totalMemories: 0,
    projects: {},
    backendAvailable: false,
    wakeUpText: null,
    taxonomyText: null,
    currentProject: "general",
    enabled: true,
    store: new MemoryStore(),
    recalledIds: new Set(),
    skillsCatalog: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadConfig(): MemoryConfig {
  const defaults = defaultConfig();
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      return { ...defaults, ...raw };
    }
  } catch {
    // Use defaults
  }
  return defaults;
}

function saveConfig(config: MemoryConfig): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function detectProject(cwd: string): string {
  const gitDir = path.join(cwd, ".git");
  if (fs.existsSync(gitDir)) {
    return path.basename(cwd);
  }
  return path.basename(cwd) || "general";
}

/**
 * Extract text content from a message content block array.
 */
function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const textParts: string[] = [];
  for (const block of content) {
    if (typeof block === "object" && block !== null) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        textParts.push(b.text);
      }
    }
  }
  return textParts.join("\n");
}

// ---------------------------------------------------------------------------
// Runtime store (per-session)
// ---------------------------------------------------------------------------

function createRuntimeStore() {
  const runtimes = new Map<string, MemoryRuntime>();

  return {
    ensure(sessionKey: string): MemoryRuntime {
      let runtime = runtimes.get(sessionKey);
      if (!runtime) {
        runtime = createRuntime();
        runtimes.set(sessionKey, runtime);
      }
      return runtime;
    },
    clear(sessionKey: string): void {
      runtimes.delete(sessionKey);
    },
  };
}

// ---------------------------------------------------------------------------
// LLM relevance gate — judge closure
// ---------------------------------------------------------------------------

/** maxTokens/temperature for the gate call — small, deterministic, cheap. */
const GATE_MAX_TOKENS = 300;
const GATE_TEMPERATURE = 0;

/**
 * Build the judge closure selectRecallRerank calls for gray-zone candidates.
 * Follows the exact pattern verified against
 * ~/.pi/agent/extensions/memory-summarizer.ts: resolve the model via
 * ctx.modelRegistry.find(provider, id), resolve auth via
 * ctx.modelRegistry.getApiKeyAndHeaders(model), call complete() with an
 * AbortController timeout, parse the response. ExtensionContext (passed to
 * every event handler, including before_agent_start) exposes modelRegistry
 * directly — no extra wiring needed to reach it from this extension.
 *
 * Every error path (model not found, no auth, network/timeout, malformed
 * response) resolves to null so selectRecallRerank fails open to the plain
 * rerankMinScore rule. Never throws.
 */
/**
 * One line per auto-recall to ~/.pi/agent/memory/recall-gate.log so gate
 * behavior is auditable — before this, a gate that silently failed open
 * (auth/model/timeout) was indistinguishable from one that judged and
 * approved, and noisy injection had no paper trail.
 */
function logRecallOutcome(project: string, query: string, r: RecallResult, failMode: string): void {
  try {
    const g = r.gate;
    const gateStr = !g
      ? "gate=off"
      : !g.called
        ? `gate=idle gray=0 auto=${g.approvedAutoCount}`
        : g.failedOpen
          ? `gate=FAILED(fell-${failMode}) gray=${g.grayCount} auto=${g.approvedAutoCount}`
          : `gate=ok gray=${g.grayCount} auto=${g.approvedAutoCount} gateApproved=${g.gateApprovedCount}`;
    const line =
      `${new Date().toISOString()} [${project}] mode=${r.mode} picked=${r.picked.length}/${r.candidates.length} ` +
      `${gateStr} t=${Math.round(r.timings.search_ms)}/${Math.round(r.timings.rerank_ms)}/${Math.round(r.timings.gate_ms)}ms ` +
      `q="${query.slice(0, 70).replace(/\n/g, " ")}"\n`;
    fs.appendFileSync(path.join(MEMORY_DIR, "recall-gate.log"), line);
  } catch {
    // observability must never break recall
  }
}

/** Append a gate failure reason to recall-gate.log — a FAILED line without a why is undebuggable. */
function logGateError(reason: string): void {
  try {
    fs.appendFileSync(
      path.join(MEMORY_DIR, "recall-gate.log"),
      `${new Date().toISOString()} gate-error: ${reason}\n`
    );
  } catch {
    /* never break recall */
  }
}

function buildGateJudge(ctx: ExtensionContext, config: MemoryConfig): RecallGateOptions["judge"] {
  return async (input: GateJudgeInput): Promise<GateVerdict | null> => {
    try {
      const model = ctx.modelRegistry?.find(config.autoRecallGateProvider, config.autoRecallGateModel);
      if (!model) {
        logGateError(`model-not-found ${config.autoRecallGateProvider}/${config.autoRecallGateModel}`);
        return null;
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      // Header-only auth (OAuth-style providers) is valid — requiring apiKey
      // rejected those and silently disabled the gate on such installs.
      if (!auth.ok || (!auth.apiKey && !auth.headers)) {
        logGateError(`auth-unavailable for ${config.autoRecallGateProvider} (ok=${auth.ok})`);
        return null;
      }

      const { system, user } = buildGatePrompt({
        message: input.message,
        project: input.project,
        candidates: input.candidates,
        skills: input.skills,
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.autoRecallGateTimeoutMs);
      let responseText = "";
      try {
        const response = await complete(
          model,
          {
            systemPrompt: system,
            messages: [
              {
                role: "user" as const,
                content: [{ type: "text" as const, text: user }],
                timestamp: Date.now(),
              },
            ],
          },
          {
            apiKey: auth.apiKey,
            headers: auth.headers,
            signal: controller.signal,
            maxTokens: GATE_MAX_TOKENS,
            temperature: GATE_TEMPERATURE,
          } as any,
        );
        if (response.stopReason === "aborted") {
          logGateError(`aborted (timeout ${config.autoRecallGateTimeoutMs}ms)`);
          return null;
        }
        responseText = (response.content ?? [])
          .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
          .map((c: any) => c.text)
          .join("")
          .trim();
      } finally {
        clearTimeout(timer);
      }

      const validKeys = input.candidates.map((c) => c.key);
      const validSkills = (input.skills ?? []).map((s) => s.name);
      const verdict = parseGateResponse(responseText, validKeys, validSkills);
      if (verdict === null) {
        logGateError(`unparseable-response: ${responseText.slice(0, 160).replace(/\n/g, " ")}`);
      }
      return verdict;
    } catch (error) {
      // Failure semantics (open vs closed) are decided by recall.ts via
      // autoRecallGateFailMode — but the reason must never be silent again.
      logGateError(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Shared tool helpers
// ---------------------------------------------------------------------------

function textResult(text: string, details: Record<string, unknown> | null = null) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function renderTextResult(result: any) {
  const t = result.content[0];
  return new Text(t?.type === "text" ? t.text : "", 0, 0);
}

// ---------------------------------------------------------------------------
// Stats overlay
// ---------------------------------------------------------------------------

function barChart(
  items: [string, number][],
  maxBarWidth: number,
  theme: { fg: (color: string, text: string) => string },
): string[] {
  if (items.length === 0) return ["  (none)"];
  const maxVal = Math.max(...items.map(([, v]) => v));
  const maxLabel = Math.max(...items.map(([k]) => k.length));
  return items.map(([label, count]) => {
    const barLen = maxVal > 0 ? Math.round((count / maxVal) * maxBarWidth) : 0;
    const bar = theme.fg("accent", "█".repeat(barLen)) + "░".repeat(maxBarWidth - barLen);
    const paddedLabel = label.padEnd(maxLabel);
    return `  ${theme.fg("text", paddedLabel)} ${bar} ${theme.fg("dim", String(count))}`;
  });
}

function sparkline(timeline: Record<string, number>, days: number): string {
  const sparks = " ▁▂▃▄▅▆▇█";
  const now = new Date();
  const values: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    values.push(timeline[key] || 0);
  }
  const max = Math.max(...values, 1);
  return values.map((v) => sparks[Math.round((v / max) * (sparks.length - 1))]).join("");
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

async function showStatsOverlay(
  ctx: ExtensionContext,
  stats: MemoryStats,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    const container = new Container();

    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", "  🧠 Memory Stats"), 0, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));

    if (stats.total === 0) {
      container.addChild(new Text(theme.fg("dim", "  No memories stored yet."), 0, 0));
    } else {
      // Overview
      const span = stats.oldest && stats.newest
        ? `${daysBetween(stats.oldest, stats.newest)}d span`
        : "";
      const lines = [
        `  ${theme.fg("text", "Total")}         ${theme.fg("accent", String(stats.total))} memories`,
        `  ${theme.fg("text", "Storage")}       ${theme.fg("accent", `${stats.storageSizeKb} KB`)}`,
        `  ${theme.fg("text", "Sessions")}      ${theme.fg("accent", String(stats.sessions))}`,
        `  ${theme.fg("text", "Avg length")}    ${theme.fg("accent", `${stats.avgContentLength}`)} chars`,
        `  ${theme.fg("text", "First memory")}  ${theme.fg("dim", formatDate(stats.oldest))}`,
        `  ${theme.fg("text", "Last memory")}   ${theme.fg("dim", formatDate(stats.newest))}${span ? `  (${theme.fg("dim", span)})` : ""}`,
      ];
      container.addChild(new Text(lines.join("\n"), 0, 0));

      // Activity sparkline (last 28 days)
      container.addChild(new Spacer(1));
      const spark = sparkline(stats.timeline, 28);
      container.addChild(new Text(
        `  ${theme.fg("text", "Activity (28d)")}  ${theme.fg("accent", spark)}`,
        0, 0,
      ));

      // Projects bar chart
      const projectEntries = Object.entries(stats.projects)
        .sort(([, a], [, b]) => b - a);
      if (projectEntries.length > 0) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("text", "  Projects"), 0, 0));
        const projectBars = barChart(projectEntries.slice(0, 8), 20, theme);
        container.addChild(new Text(projectBars.join("\n"), 0, 0));
      }

      // Topics bar chart
      const topicEntries = Object.entries(stats.topics)
        .filter(([t]) => t !== "general")
        .sort(([, a], [, b]) => b - a);
      if (topicEntries.length > 0) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("text", "  Topics"), 0, 0));
        const topicBars = barChart(topicEntries.slice(0, 8), 20, theme);
        container.addChild(new Text(topicBars.join("\n"), 0, 0));
      }

      // Sources breakdown
      const sourceEntries = Object.entries(stats.sources)
        .sort(([, a], [, b]) => b - a);
      if (sourceEntries.length > 0) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("text", "  Sources"), 0, 0));
        const sourceBars = barChart(sourceEntries, 20, theme);
        container.addChild(new Text(sourceBars.join("\n"), 0, 0));
      }
    }

    container.addChild(new DynamicBorder((s: string) => theme.fg("border", s)));
    container.addChild(new Text(theme.fg("dim", "  press any key to close"), 0, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: () => done(undefined),
    };
  });
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function memoryExtension(pi: ExtensionAPI) {
  const runtimeStore = createRuntimeStore();
  const getSessionKey = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
  const getRuntime = (ctx: ExtensionContext): MemoryRuntime =>
    runtimeStore.ensure(getSessionKey(ctx));

  // -----------------------------------------------------------------------
  // State reconstruction
  // -----------------------------------------------------------------------

  const reconstructState = async (ctx: ExtensionContext) => {
    const runtime = getRuntime(ctx);
    runtime.config = loadConfig();
    runtime.currentProject = runtime.config.defaultProject || detectProject(ctx.cwd);
    runtime.enabled = true;

    // Load the memory store from disk
    try {
      runtime.store.load();
      runtime.backendAvailable = true;
      const status = runtime.store.status();
      runtime.totalMemories = status.total_memories;
      runtime.projects = status.projects;
    } catch {
      runtime.backendAvailable = false;
      runtime.totalMemories = 0;
      runtime.projects = {};
    }

    // Pre-generate wake-up text (no embedding needed — just reads from memory)
    if (runtime.config.wakeUpEnabled && runtime.backendAvailable) {
      try {
        const wakeup = runtime.store.wakeup({
          project: runtime.currentProject,
          max_tokens: runtime.config.wakeUpMaxTokens,
        });
        runtime.wakeUpText = wakeup.text || null;
      } catch {
        runtime.wakeUpText = null;
      }

      // Pre-compute taxonomy for system-prompt injection (shows all projects/topics).
      try {
        const taxonomy = runtime.store.getTaxonomy();
        runtime.taxonomyText = buildTaxonomySection(taxonomy, runtime.config.taxonomyMaxChars);
      } catch {
        runtime.taxonomyText = null;
      }
    }

    // Warm the embedding model in the background so the first auto-recall
    // doesn't add model-load latency to the first prompt.
    if (runtime.config.autoRecall && runtime.backendAvailable) {
      void runtime.store.search("session warmup", { n_results: 1 }).catch(() => {});
    }

    // Warm the cross-encoder reranker the same way. Best-effort: if the
    // model never loads, selectRecall() fails open to the legacy path on
    // every call, so a failed warm-up here is not fatal.
    if (runtime.config.autoRecall && runtime.config.autoRecallRerank && runtime.backendAvailable) {
      void warmReranker().catch(() => {});
    }

    // Cache the skills catalog for the LLM gate's skill-suggestion feature.
    // Scanned once per session (skills rarely change mid-session); passed to
    // the gate only when a gate call actually happens (see before_agent_start).
    if (runtime.config.autoRecall && runtime.config.autoRecallLlmGate && runtime.config.autoRecallGateSuggestSkills) {
      try {
        runtime.skillsCatalog = scanSkillsCatalog();
      } catch {
        runtime.skillsCatalog = null;
      }
    } else {
      runtime.skillsCatalog = null;
    }
  };

  // -----------------------------------------------------------------------
  // Lifecycle hooks
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_e, ctx) => {
    await reconstructState(ctx);
  });

  pi.on("session_tree", async (_e, ctx) => {
    await reconstructState(ctx);
  });

  pi.on("session_shutdown", async (_e, ctx) => {
    runtimeStore.clear(getSessionKey(ctx));
  });

  // Auto-capture: after each agent turn, extract and store the exchange
  pi.on("turn_end", async (event, ctx) => {
    const runtime = getRuntime(ctx);
    if (!runtime.enabled || !runtime.config.autoCapture) return;
    if (!runtime.backendAvailable) return;

    if (event.message?.role !== "assistant") return;

    const msg = event.message as unknown as Record<string, unknown>;
    const assistantText = extractTextFromContent(msg.content);
    if (!assistantText || assistantText.length < 20) return;

    // Find the preceding user message from session history
    const branch = ctx.sessionManager.getBranch();
    let userText = "";
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "message" && entry.message.role === "user") {
        const userMsg = entry.message as unknown as Record<string, unknown>;
        if (typeof userMsg.content === "string") {
          userText = userMsg.content;
        } else if (Array.isArray(userMsg.content)) {
          userText = extractTextFromContent(userMsg.content);
        }
        break;
      }
    }

    if (!userText || userText.length < 10) return;

    // Build exchange content
    const exchange = `> ${userText}\n\n${assistantText}`;
    const content = exchange.length > 2000
      ? exchange.slice(0, 2000) + "\n[truncated]"
      : exchange;

    try {
      const result = await runtime.store.store({
        content,
        project: runtime.currentProject,
        topic: "general",
        source: "auto-capture",
        timestamp: new Date().toISOString(),
        session_id: getSessionKey(ctx),
      });

      if (result.status === "stored") {
        runtime.totalMemories++;
        runtime.projects[runtime.currentProject] =
          (runtime.projects[runtime.currentProject] || 0) + 1;
      }
    } catch {
      // Silently fail — don't interrupt the session
    }
  });

  // Inject memory instructions + wake-up digest + taxonomy index into the
  // system prompt (all stable per session, so the provider prompt cache stays
  // valid across turns), and auto-recalled memories as a per-prompt message
  // (appended at the tail of the conversation, which also keeps the cache valid).
  pi.on("before_agent_start", async (event, ctx) => {
    const runtime = getRuntime(ctx);
    if (!runtime.enabled || !runtime.backendAvailable) return;

    // The instruction block is deliberately NOT gated on wakeUpText: an empty
    // digest (fresh project, wake-up error) must not silently drop the memory
    // tool guidance from the prompt.
    let extra =
      "\n\n## Agent Memory (ACTIVE)\n" +
      "You have persistent memory across sessions. Previous conversations and decisions are stored and searchable.\n" +
      "Use `memory_search` to find past context. Use `memory_save` to explicitly remember something important.\n" +
      "Use `memory_recall` to browse memories for a specific project or topic.\n" +
      "Use `memory_graph` to discover cross-project connections via shared topics.\n" +
      "Use `knowledge_add` to record structured facts. Use `knowledge_query` to query them.\n" +
      "Use `knowledge_invalidate` to mark facts as no longer true. Use `knowledge_timeline` for chronological history.\n" +
      "Use `memory_diary_write` to record reflections. Use `memory_diary_read` to review past entries.\n" +
      "Use `memory_delete` to remove specific memories. Use `memory_check_duplicate` before storing.\n";
    if (runtime.config.wakeUpEnabled && runtime.wakeUpText) {
      extra += "\n" + runtime.wakeUpText;
    }

    // Taxonomy: compact map of what projects/topics exist — lets the model
    // know WHERE to look without having to call memory_taxonomy first.
    if (runtime.config.taxonomyEnabled && runtime.taxonomyText) {
      extra += "\n\n" + runtime.taxonomyText;
    }

    const result: {
      systemPrompt: string;
      message?: { customType: string; content: string; display: boolean };
    } = { systemPrompt: event.systemPrompt + extra };

    // Auto-recall: retrieval must not depend on the model deciding to search.
    if (runtime.config.autoRecall) {
      const query = (event.prompt || "").trim();
      if (query.length >= runtime.config.autoRecallMinPromptChars) {
        try {
          const gate: RecallGateOptions | undefined = runtime.config.autoRecallLlmGate
            ? {
                judge: buildGateJudge(ctx, runtime.config),
                suggestSkills:
                  runtime.config.autoRecallGateSuggestSkills && runtime.skillsCatalog
                    ? runtime.skillsCatalog
                    : undefined,
              }
            : undefined;

          const recallResult = await selectRecall(runtime.store, query.slice(0, 2000), {
            project: runtime.currentProject,
            excludeIds: runtime.recalledIds,
            config: runtime.config,
            gate,
          });
          const { picked, skills } = recallResult;
          logRecallOutcome(runtime.currentProject, query, recallResult, runtime.config.autoRecallGateFailMode || "open");
          if (picked.length > 0) {
            for (const hit of picked) runtime.recalledIds.add(hit.id);
            const lines = picked.map(
              (hit) =>
                `- [${hit.project}/${hit.topic}] (${(hit.similarity * 100).toFixed(0)}% match, ${hit.timestamp.slice(0, 10)})\n  ${hit.text.replace(/\n/g, "\n  ")}`
            );
            let content =
              "Auto-recalled memories relevant to the latest user message (from the shared memory palace; they reflect what was true when saved — verify against the current code/config before relying on them):\n\n" +
              lines.join("\n\n") +
              "\n\nUse `memory_search` if you need deeper or differently-angled context.";
            if (skills.length > 0) {
              content += `\n\nPossibly relevant skills for this request: ${skills.join(", ")} (load if applicable).`;
            }
            result.message = {
              customType: "pi-mempalace-recall",
              content,
              display: true,
            };
          }
        } catch {
          // Fail-open: recall must never block or break the agent loop.
        }
      }
    }

    return result;
  });

  // -----------------------------------------------------------------------
  // Tools
  // -----------------------------------------------------------------------

  // --- memory_search ---
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search stored memories using semantic similarity. Finds past conversations, decisions, and context across all sessions.",
    promptSnippet: "memory_search(query, project?, topic?, n_results?) — semantic search across stored memories",
    promptGuidelines: [
      "Use when the user asks about past decisions, previous conversations, or 'what did we decide about X'",
      "Proactively search when starting work on a known project, or when a task likely depends on prior sessions — don't wait for the user to mention the past",
      "Auto-recalled context (the pi-mempalace-recall message) covers only the latest user message; search yourself for deeper or adjacent context",
      "Filter by project to narrow results to a specific codebase",
      "Returns ranked results with similarity scores — higher is more relevant",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "What to search for (natural language)" }),
      project: Type.Optional(
        Type.String({ description: "Filter to a specific project" })
      ),
      topic: Type.Optional(
        Type.String({ description: "Filter to a specific topic" })
      ),
      n_results: Type.Optional(
        Type.Number({ description: "Number of results (default: 5, max: 20)" })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);

      try {
        const result = await runtime.store.search(params.query, {
          project: params.project,
          topic: params.topic,
          n_results: params.n_results,
        });

        if (result.results.length === 0) {
          return textResult(`No memories found for: "${params.query}"`);
        }

        let text = `Found ${result.results.length} memories for "${params.query}":\n\n`;
        for (const hit of result.results) {
          const sim = (hit.similarity * 100).toFixed(1);
          const imp = (hit.importance ?? 0.5).toFixed(2);
          text += `[${hit.project}/${hit.topic}] (${sim}% match · imp ${imp}, ${hit.timestamp})\n`;
          text += `${hit.text}\n\n---\n\n`;
        }

        return textResult(text, { query: params.query, hitCount: result.results.length });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return textResult(`Memory search failed: ${msg}`);
      }
    },

    renderResult: renderTextResult,
  });

  // --- memory_save ---
  pi.registerTool({
    name: "memory_save",
    label: "Memory Save",
    description:
      "Explicitly save a piece of information to persistent memory. Use for important decisions, facts, or context you want to remember across sessions.",
    promptSnippet: "memory_save(content, project?, topic?) — save to persistent memory",
    promptGuidelines: [
      "Use when the user says 'remember this' or when an important decision is made",
      "Include enough context in the content for it to be useful later",
      "Set project and topic for better organization and retrieval",
    ],
    parameters: Type.Object({
      content: Type.String({
        description: "The information to remember (include context)",
      }),
      project: Type.Optional(
        Type.String({ description: "Project this belongs to" })
      ),
      topic: Type.Optional(
        Type.String({ description: "Topic category (e.g., 'auth', 'database', 'architecture')" })
      ),
      importance: Type.Optional(
        Type.Number({ description: "Importance weight 0.0-1.0 (default: 0.8 for manual saves). Higher = more likely to appear in session wake-up context." })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      const project = params.project || runtime.currentProject;

      try {
        const result = await runtime.store.store({
          content: params.content,
          project,
          topic: params.topic || "general",
          source: "manual-save",
          importance: params.importance ?? 0.8, // Manual saves rank higher than auto-captures (0.5)
          timestamp: new Date().toISOString(),
          session_id: getSessionKey(ctx),
        });

        if (result.status === "duplicate") {
          return textResult(`This memory already exists (${result.id}).`, { status: "duplicate", id: result.id });
        }

        // Update cached counts
        runtime.totalMemories++;
        runtime.projects[project] = (runtime.projects[project] || 0) + 1;

        return textResult(
          `✅ Saved to memory (${result.id}) in ${project}/${params.topic || "general"}`,
          { status: "stored", id: result.id, project },
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return textResult(`Failed to save memory: ${msg}`);
      }
    },

    renderResult: renderTextResult,
  });

  // --- memory_recall ---
  pi.registerTool({
    name: "memory_recall",
    label: "Memory Recall",
    description:
      "Browse memories for a specific project or topic. Returns recent/important memories filtered by metadata. Use for getting context about a project or topic area.",
    promptSnippet: "memory_recall(project?, topic?, n_results?) — browse memories by project/topic",
    promptGuidelines: [
      "Use when you need context about a specific project or topic area",
      "Good for 'what have we been working on in project X' type questions",
      "Complements memory_search — recall browses by metadata, search uses semantic similarity",
    ],
    parameters: Type.Object({
      project: Type.Optional(
        Type.String({ description: "Filter to a specific project" })
      ),
      topic: Type.Optional(
        Type.String({ description: "Filter to a specific topic" })
      ),
      n_results: Type.Optional(
        Type.Number({ description: "Number of results (default: 10, max: 50)" })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);

      try {
        const result = runtime.store.recall({
          project: params.project,
          topic: params.topic,
          n_results: params.n_results,
        });

        if (result.results.length === 0) {
          const label = [params.project, params.topic].filter(Boolean).join("/") || "all";
          return textResult(`No memories found for: ${label}`);
        }

        let text = `${result.results.length} memories`;
        if (params.project) text += ` for project "${params.project}"`;
        if (params.topic) text += ` in topic "${params.topic}"`;
        text += ":\n\n";

        for (const item of result.results) {
          text += `[${item.project}/${item.topic}] (${item.timestamp})\n`;
          text += `${item.text}\n\n---\n\n`;
        }

        return textResult(text, { count: result.results.length });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return textResult(`Memory recall failed: ${msg}`);
      }
    },

    renderResult: renderTextResult,
  });

  // --- memory_status ---
  pi.registerTool({
    name: "memory_status",
    label: "Memory Status",
    description:
      "Show the current state of the memory store: total memories, per-project counts, storage size, and configuration.",
    promptSnippet: "memory_status() — show memory store overview",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);

      try {
        const result = runtime.store.status();

        // Update cached state
        runtime.totalMemories = result.total_memories;
        runtime.projects = result.projects;

        let text = "## Memory Status\n\n";
        text += `- **Total memories**: ${result.total_memories}\n`;
        text += `- **Identity**: ${result.identity_exists ? "✅ configured" : "❌ not configured"}\n`;
        text += `- **Storage**: ${result.storage_size_kb} KB\n`;
        text += `- **Current project**: ${runtime.currentProject}\n`;
        text += `- **Auto-capture**: ${runtime.config.autoCapture ? "on" : "off"}\n`;
        text += `- **Wake-up**: ${runtime.config.wakeUpEnabled ? "on" : "off"}\n`;
        text += `- **Backend**: pure TypeScript (in-process)\n\n`;

        if (result.projects && Object.keys(result.projects).length > 0) {
          text += "### Projects\n";
          for (const [proj, count] of Object.entries(result.projects)) {
            text += `- ${proj}: ${count} memories\n`;
          }
        }

        // Knowledge graph stats
        try {
          const kgStats = runtime.store.knowledgeStats();
          if (kgStats.entityCount > 0) {
            text += `\n### Knowledge Graph\n`;
            text += `- Entities: ${kgStats.entityCount}\n`;
            text += `- Facts: ${kgStats.tripleCount} (${kgStats.activeTriples} active)\n`;
          }
        } catch { /* KG not available yet */ }

        // Palace graph tunnels
        try {
          const graph = runtime.store.getPalaceGraph();
          if (graph.edges.length > 0) {
            text += `\n### Palace Tunnels\n`;
            text += `- ${graph.edges.length} tunnel(s) connecting projects\n`;
          }
        } catch { /* Graph not available yet */ }

        return textResult(text, { totalMemories: result.total_memories, projects: result.projects });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return textResult(`Memory status unavailable: ${msg}\n\nRun /skill:memory-setup to configure.`);
      }
    },

    renderResult: renderTextResult,
  });

  // --- memory_graph ---
  pi.registerTool({
    name: "memory_graph",
    label: "Memory Graph",
    description: "Show the palace graph: projects as nodes, shared topics as tunnel connections between them. Reveals cross-project relationships.",
    promptSnippet: "memory_graph() — view cross-project connections via shared topics",
    promptGuidelines: [
      "Use when the user asks about connections between projects",
      "Shows which topics create 'tunnels' between different projects",
      "Helps discover hidden relationships in the memory palace",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      try {
        const graph = runtime.store.getPalaceGraph();
        
        if (graph.nodes.length === 0) {
          return textResult("No projects in the palace yet.");
        }
        
        let text = "## \uD83C\uDFF0 Palace Graph\n\n";
        
        // Nodes (projects)
        text += "### Wings (Projects)\n";
        for (const node of graph.nodes.sort((a, b) => b.memoryCount - a.memoryCount)) {
          const topics = node.topics.length > 0 ? ` — rooms: ${node.topics.join(", ")}` : "";
          text += `- **${node.name}** (${node.memoryCount} memories)${topics}\n`;
        }
        
        // Edges (tunnels)
        if (graph.edges.length > 0) {
          text += "\n### Tunnels (Cross-Project Connections)\n";
          for (const edge of graph.edges.sort((a, b) => b.strength - a.strength)) {
            text += `- \uD83D\uDD17 **${edge.projectA}** \u2194 **${edge.projectB}** via topic "${edge.topic}" (${edge.strength} shared memories)\n`;
          }
        } else {
          text += "\n*No tunnels yet — topics are project-unique. Shared topics across projects create tunnel connections.*\n";
        }
        
        return textResult(text, { nodeCount: graph.nodes.length, edgeCount: graph.edges.length });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return textResult(`Palace graph failed: ${msg}`);
      }
    },
    renderResult: renderTextResult,
  });

  // --- memory_tunnel ---
  pi.registerTool({
    name: "memory_tunnel",
    label: "Memory Tunnel",
    description: "Traverse a tunnel between two projects via a shared topic. Returns memories from both projects for that topic.",
    promptSnippet: "memory_tunnel(topic, project_a, project_b, n_results?) — traverse cross-project connection",
    promptGuidelines: [
      "Use after memory_graph reveals a tunnel connection",
      "Shows how the same topic is discussed in different project contexts",
      "Good for finding cross-cutting concerns like auth, database, or architecture patterns",
    ],
    parameters: Type.Object({
      topic: Type.String({ description: "The shared topic to traverse" }),
      project_a: Type.String({ description: "First project" }),
      project_b: Type.String({ description: "Second project" }),
      n_results: Type.Optional(Type.Number({ description: "Results per project (default: 10)" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      try {
        const results = runtime.store.traverseTunnel(
          params.topic, params.project_a, params.project_b, params.n_results
        );
        
        if (results.length === 0) {
          return textResult(`No memories found in tunnel: ${params.project_a} \u2194 ${params.project_b} via "${params.topic}"`);
        }
        
        let text = `## \uD83D\uDD17 Tunnel: ${params.project_a} \u2194 ${params.project_b} via "${params.topic}"\n\n`;
        for (const item of results) {
          text += `[${item.project}/${item.topic}] (${item.timestamp})\n`;
          text += `${item.text}\n\n---\n\n`;
        }
        
        return textResult(text, { count: results.length });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return textResult(`Tunnel traversal failed: ${msg}`);
      }
    },
    renderResult: renderTextResult,
  });

  // --- knowledge_add ---
  pi.registerTool({
    name: "knowledge_add",
    label: "Knowledge Add",
    description: "Add a structured fact (triple) to the knowledge graph. Facts are temporal — they can have start and end dates. Example: 'myapp uses PostgreSQL since 2025-01-01'.",
    promptSnippet: "knowledge_add(subject, predicate, object, valid_from?, valid_to?, project?) — add a structured fact",
    promptGuidelines: [
      "Use when the user states a fact, makes a decision, or establishes a relationship",
      "Subject and object are entities (people, tools, projects), predicate is the relationship",
      "Set valid_from/valid_to for time-bounded facts (e.g., 'used React until 2025-06')",
      "Common predicates: uses, depends_on, decided, prefers, created_by, replaces, implements",
    ],
    parameters: Type.Object({
      subject: Type.String({ description: "The subject entity (e.g., 'myapp', 'Alice')" }),
      predicate: Type.String({ description: "The relationship (e.g., 'uses', 'depends_on', 'decided')" }),
      object: Type.String({ description: "The object entity (e.g., 'PostgreSQL', 'React')" }),
      valid_from: Type.Optional(Type.String({ description: "When this fact became true (ISO date)" })),
      valid_to: Type.Optional(Type.String({ description: "When this fact stopped being true (ISO date, null if still true)" })),
      project: Type.Optional(Type.String({ description: "Project context for this fact" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      const project = params.project || runtime.currentProject;
      
      try {
        const result = runtime.store.addTriple({
          subject: params.subject,
          predicate: params.predicate,
          object: params.object,
          valid_from: params.valid_from,
          valid_to: params.valid_to,
          project,
        });
        
        const timeInfo = params.valid_from ? ` (since ${params.valid_from})` : "";
        return textResult(
          `\u2705 Added fact: **${params.subject}** ${params.predicate} **${params.object}**${timeInfo}`,
          { status: result.status, id: result.id }
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return textResult(`Failed to add fact: ${msg}`);
      }
    },
    renderResult: renderTextResult,
  });

  // --- knowledge_query ---
  pi.registerTool({
    name: "knowledge_query",
    label: "Knowledge Query",
    description: "Query the knowledge graph for facts about an entity. Supports temporal queries — ask 'what was true about X in January 2025'.",
    promptSnippet: "knowledge_query(entity, at_time?, project?) — query facts about an entity",
    promptGuidelines: [
      "Use when the user asks about relationships, decisions, or facts about an entity",
      "Set at_time to query historical state (e.g., 'what database did we use in 2024?')",
      "Returns all known facts — both as subject and object of relationships",
    ],
    parameters: Type.Object({
      entity: Type.String({ description: "The entity to query (e.g., 'myapp', 'PostgreSQL')" }),
      at_time: Type.Optional(Type.String({ description: "Query facts valid at this time (ISO date)" })),
      project: Type.Optional(Type.String({ description: "Filter to a specific project" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      
      try {
        const result = runtime.store.queryEntity(params.entity, {
          at_time: params.at_time,
          project: params.project,
        });
        
        if (!result.entity) {
          return textResult(`No entity found: "${params.entity}"`);
        }
        
        let text = `## \uD83E\uDDE9 ${result.entity.name} (${result.entity.type})\n\n`;
        
        if (result.facts.length === 0) {
          text += "No facts recorded.\n";
        } else {
          for (const fact of result.facts) {
            const timeRange = [
              fact.valid_from ? `from ${fact.valid_from}` : null,
              fact.valid_to ? `until ${fact.valid_to}` : null,
            ].filter(Boolean).join(" ");
            const time = timeRange ? ` (${timeRange})` : "";
            const confidence = fact.confidence < 1.0 ? ` [${(fact.confidence * 100).toFixed(0)}% confidence]` : "";
            text += `- **${fact.subject}** ${fact.predicate} **${fact.object}**${time}${confidence}\n`;
          }
        }
        
        return textResult(text, { entity: result.entity.name, factCount: result.facts.length });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return textResult(`Knowledge query failed: ${msg}`);
      }
    },
    renderResult: renderTextResult,
  });

  // --- knowledge_status ---
  pi.registerTool({
    name: "knowledge_status",
    label: "Knowledge Status",
    description: "Show knowledge graph statistics: entities, facts, predicates, and entity types.",
    promptSnippet: "knowledge_status() — overview of the knowledge graph",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      
      try {
        const stats = runtime.store.knowledgeStats();
        
        let text = "## \uD83E\uDDE9 Knowledge Graph\n\n";
        text += `- **Entities**: ${stats.entityCount}\n`;
        text += `- **Total facts**: ${stats.tripleCount}\n`;
        text += `- **Active facts**: ${stats.activeTriples} (no end date)\n\n`;
        
        if (Object.keys(stats.entityTypes).length > 0) {
          text += "### Entity Types\n";
          for (const [type, count] of Object.entries(stats.entityTypes)) {
            text += `- ${type}: ${count}\n`;
          }
          text += "\n";
        }
        
        if (Object.keys(stats.predicates).length > 0) {
          text += "### Top Predicates\n";
          for (const [pred, count] of Object.entries(stats.predicates)) {
            text += `- ${pred}: ${count}\n`;
          }
        }
        
        return textResult(text, stats as unknown as Record<string, unknown>);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return textResult(`Knowledge status failed: ${msg}`);
      }
    },
    renderResult: renderTextResult,
  });

  // --- memory_list_rooms ---
  pi.registerTool({
    name: "memory_list_rooms",
    label: "Memory List Rooms",
    description: "List all topics (rooms) in the memory palace, optionally filtered by project. Shows how memories are organized.",
    promptSnippet: "memory_list_rooms(project?) — list topics with counts",
    promptGuidelines: [
      "Use when the user asks 'what topics do we have' or 'how are memories organized'",
      "Filter by project to see topics within a specific project",
      "Shows count per topic and which projects share each topic",
    ],
    parameters: Type.Object({
      project: Type.Optional(
        Type.String({ description: "Filter to a specific project (optional)" })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      try {
        const rooms = runtime.store.listRooms(params.project);
        if (rooms.length === 0) {
          return textResult(params.project
            ? `No topics found in project "${params.project}".`
            : "No topics found in the memory palace.");
        }
        let text = params.project
          ? `## Topics in "${params.project}"\n\n`
          : "## All Topics (Rooms)\n\n";
        for (const room of rooms) {
          const projects = room.projects.length > 1
            ? ` (shared: ${room.projects.join(", ")})`
            : "";
          text += `- **${room.topic}**: ${room.count} memories${projects}\n`;
        }
        return textResult(text, { count: rooms.length });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return textResult(`List rooms failed: ${msg}`);
      }
    },
    renderResult: renderTextResult,
  });

  // --- memory_taxonomy ---
  pi.registerTool({
    name: "memory_taxonomy",
    label: "Memory Taxonomy",
    description: "Full taxonomy of the memory palace: project → topic → count. Shows the complete organizational structure.",
    promptSnippet: "memory_taxonomy() — full project/topic/count tree",
    promptGuidelines: [
      "Use when the user asks for a full overview of memory organization",
      "Shows every project with its topics and counts",
      "Good for understanding the overall shape of stored knowledge",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      try {
        const taxonomy = runtime.store.getTaxonomy();
        if (taxonomy.length === 0) {
          return textResult("No memories stored yet.");
        }
        let text = "## \uD83C\uDFF0 Memory Taxonomy\n\n";
        for (const node of taxonomy) {
          text += `### ${node.project} (${node.total} memories)\n`;
          for (const t of node.topics) {
            text += `  - ${t.topic}: ${t.count}\n`;
          }
          text += "\n";
        }
        return textResult(text, { projectCount: taxonomy.length });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return textResult(`Taxonomy failed: ${msg}`);
      }
    },
    renderResult: renderTextResult,
  });

  // --- memory_delete ---
  pi.registerTool({
    name: "memory_delete",
    label: "Memory Delete",
    description: "Delete a specific memory by ID. Irreversible. Use memory_search or memory_recall to find IDs first.",
    promptSnippet: "memory_delete(id) — delete a memory by ID",
    promptGuidelines: [
      "Use when the user wants to remove a specific memory",
      "The ID can be found in search or recall results",
      "This is irreversible — confirm with the user before deleting",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "The memory ID to delete (e.g., 'mem_abc123')" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      try {
        const result = runtime.store.delete(params.id);
        runtime.totalMemories = Math.max(0, runtime.totalMemories - 1);
        // Refresh project counts
        const status = runtime.store.status();
        runtime.projects = status.projects;
        return textResult(`\u2705 Deleted memory: ${result.id}`, { status: "deleted", id: result.id });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return textResult(`Delete failed: ${msg}`);
      }
    },
    renderResult: renderTextResult,
  });

  // --- memory_check_duplicate ---
  pi.registerTool({
    name: "memory_check_duplicate",
    label: "Memory Check Duplicate",
    description: "Check if content already exists in the memory palace before storing. Checks both exact hash match and semantic similarity.",
    promptSnippet: "memory_check_duplicate(content, threshold?) — check for existing similar content",
    promptGuidelines: [
      "Use before storing content when you suspect it might already exist",
      "Returns both exact hash matches and semantically similar content",
      "Default similarity threshold is 0.9 (90%) — adjust for stricter or looser matching",
    ],
    parameters: Type.Object({
      content: Type.String({ description: "Content to check for duplicates" }),
      threshold: Type.Optional(
        Type.Number({ description: "Similarity threshold 0-1 (default: 0.9). Higher = stricter." })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      try {
        const result = await runtime.store.checkDuplicate(
          params.content,
          params.threshold
        );
        if (result.isDuplicate) {
          if (result.hashMatch) {
            return textResult(
              "\u26A0\uFE0F **Exact duplicate** — this content already exists (hash match).",
              { isDuplicate: true, type: "hash" }
            );
          }
          const match = result.semanticMatch!;
          return textResult(
            `\u26A0\uFE0F **Similar content found** (${(match.similarity * 100).toFixed(1)}% match):\n\n` +
            `[${match.project}/${match.topic}] ${match.timestamp}\n${match.text.slice(0, 200)}...`,
            { isDuplicate: true, type: "semantic", similarity: match.similarity }
          );
        }
        return textResult("\u2705 No duplicates found — safe to store.", { isDuplicate: false });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return textResult(`Duplicate check failed: ${msg}`);
      }
    },
    renderResult: renderTextResult,
  });

  // --- knowledge_invalidate ---
  pi.registerTool({
    name: "knowledge_invalidate",
    label: "Knowledge Invalidate",
    description: "Mark a knowledge graph fact as no longer true. Sets an end date on the fact without deleting it, preserving history. E.g., 'myapp no longer uses MongoDB'.",
    promptSnippet: "knowledge_invalidate(subject, predicate, object, ended?) — mark a fact as no longer true",
    promptGuidelines: [
      "Use when a fact has changed — e.g., switched databases, ended a project, changed preferences",
      "Does not delete the fact — it becomes historical, queryable with at_time",
      "If ended is not provided, defaults to today's date",
    ],
    parameters: Type.Object({
      subject: Type.String({ description: "The subject entity" }),
      predicate: Type.String({ description: "The relationship" }),
      object: Type.String({ description: "The object entity" }),
      ended: Type.Optional(
        Type.String({ description: "When it stopped being true (YYYY-MM-DD, default: today)" })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      try {
        const tripleId = runtime.store.findTriple(
          params.subject,
          params.predicate,
          params.object
        );
        if (tripleId === null) {
          return textResult(
            `No active fact found: **${params.subject}** ${params.predicate} **${params.object}**`,
            { status: "not_found" }
          );
        }
        const endDate = params.ended || localToday();
        runtime.store.invalidateTriple(tripleId, endDate);
        return textResult(
          `\u2705 Invalidated: **${params.subject}** ${params.predicate} **${params.object}** (ended ${endDate})`,
          { status: "invalidated", tripleId, ended: endDate }
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return textResult(`Invalidation failed: ${msg}`);
      }
    },
    renderResult: renderTextResult,
  });

  // --- knowledge_timeline ---
  pi.registerTool({
    name: "knowledge_timeline",
    label: "Knowledge Timeline",
    description: "Chronological timeline of facts in the knowledge graph. Shows the story of an entity over time, or the full timeline if no entity specified.",
    promptSnippet: "knowledge_timeline(entity?) — chronological fact history",
    promptGuidelines: [
      "Use when the user asks 'what happened with X over time' or 'show me the history'",
      "Omit entity to see the full timeline of all facts",
      "Facts are ordered by valid_from date (or creation date if no valid_from)",
    ],
    parameters: Type.Object({
      entity: Type.Optional(
        Type.String({ description: "Entity to get timeline for (optional — omit for full timeline)" })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      try {
        const facts = runtime.store.kgTimeline(params.entity);
        if (facts.length === 0) {
          return textResult(
            params.entity
              ? `No facts found for "${params.entity}".`
              : "No facts in the knowledge graph yet."
          );
        }
        let text = params.entity
          ? `## \uD83D\uDCC5 Timeline: ${params.entity}\n\n`
          : "## \uD83D\uDCC5 Knowledge Timeline\n\n";
        for (const fact of facts) {
          const date = fact.valid_from || fact.created_at.slice(0, 10);
          const ended = fact.valid_to ? ` \u2192 ended ${fact.valid_to}` : "";
          const confidence = fact.confidence < 1.0 ? ` [${(fact.confidence * 100).toFixed(0)}%]` : "";
          text += `- **${date}**${ended}: ${fact.subject} ${fact.predicate} ${fact.object}${confidence}\n`;
        }
        return textResult(text, { count: facts.length });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return textResult(`Timeline failed: ${msg}`);
      }
    },
    renderResult: renderTextResult,
  });

  // --- memory_diary_write ---
  pi.registerTool({
    name: "memory_diary_write",
    label: "Diary Write",
    description: "Write to your personal agent diary. Your observations, thoughts, what you worked on, what matters. Each agent has their own diary with full history.",
    promptSnippet: "memory_diary_write(agent_name, entry, topic?) — write a diary entry",
    promptGuidelines: [
      "Use to record reflections, observations, or session summaries",
      "Each agent gets their own diary project (diary-<agent_name>)",
      "Diary entries are stored chronologically and searchable",
    ],
    parameters: Type.Object({
      agent_name: Type.String({ description: "Your name — each agent gets their own diary" }),
      entry: Type.String({ description: "Your diary entry — observations, thoughts, session summary" }),
      topic: Type.Optional(
        Type.String({ description: "Topic tag (optional, default: diary)" })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      try {
        const result = await runtime.store.diaryWrite({
          agent_name: params.agent_name,
          entry: params.entry,
          topic: params.topic,
        });
        if (result.status === "duplicate") {
          return textResult("This diary entry already exists.", { status: "duplicate" });
        }
        const project = `diary-${params.agent_name.toLowerCase().replace(/\s+/g, "_")}`;
        return textResult(
          `\uD83D\uDCD3 Diary entry saved (${project}/${params.topic || "diary"})`,
          { status: "stored", id: result.id }
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return textResult(`Diary write failed: ${msg}`);
      }
    },
    renderResult: renderTextResult,
  });

  // --- memory_diary_read ---
  pi.registerTool({
    name: "memory_diary_read",
    label: "Diary Read",
    description: "Read recent diary entries. See what past sessions recorded — your journal across sessions, in chronological order.",
    promptSnippet: "memory_diary_read(agent_name, last_n?) — read recent diary entries",
    promptGuidelines: [
      "Use when the user asks to review past diary entries or session reflections",
      "Entries are returned in chronological order (oldest first)",
      "Good for continuity — see what happened in previous sessions",
    ],
    parameters: Type.Object({
      agent_name: Type.String({ description: "Your name — each agent gets their own diary" }),
      last_n: Type.Optional(
        Type.Number({ description: "Number of recent entries to read (default: 10, max: 100)" })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      try {
        const entries = runtime.store.diaryRead({
          agent_name: params.agent_name,
          last_n: params.last_n,
        });
        if (entries.length === 0) {
          return textResult(`No diary entries found for ${params.agent_name}.`);
        }
        const project = `diary-${params.agent_name.toLowerCase().replace(/\s+/g, "_")}`;
        let text = `## \uD83D\uDCD3 Diary: ${params.agent_name} (${entries.length} entries)\n\n`;
        for (const entry of entries) {
          const date = entry.timestamp.slice(0, 16).replace("T", " ");
          const topicTag = entry.topic !== "diary" ? ` [${entry.topic}]` : "";
          text += `### ${date}${topicTag}\n${entry.text}\n\n---\n\n`;
        }
        return textResult(text, { count: entries.length, project });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return textResult(`Diary read failed: ${msg}`);
      }
    },
    renderResult: renderTextResult,
  });

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  pi.registerCommand("memory", {
    description: "Memory management: status, search, project, graph, knowledge, on/off",
    handler: async (args, ctx) => {
      const runtime = getRuntime(ctx);
      const parts = (args || "").trim().split(/\s+/);
      const subcmd = parts[0] || "status";

      switch (subcmd) {
        case "status": {
          try {
            const result = runtime.store.status();
            ctx.ui.notify(
              `🧠 ${result.total_memories} memories | ${Object.keys(result.projects).length} projects | ${result.storage_size_kb} KB`,
              "info"
            );
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            ctx.ui.notify(`Memory error: ${msg}`, "error");
          }
          break;
        }

        case "project": {
          const projectName = parts.slice(1).join(" ") || detectProject(ctx.cwd);
          runtime.currentProject = projectName;
          runtime.config.defaultProject = projectName;
          saveConfig(runtime.config);
          ctx.ui.notify(`Project set to: ${projectName}`, "info");
          break;
        }

        case "on": {
          runtime.enabled = true;
          runtime.config.autoCapture = true;
          runtime.config.wakeUpEnabled = true;
          saveConfig(runtime.config);
          ctx.ui.notify("Memory enabled", "info");
          break;
        }

        case "off": {
          runtime.enabled = false;
          runtime.config.autoCapture = false;
          runtime.config.wakeUpEnabled = false;
          saveConfig(runtime.config);
          ctx.ui.notify("Memory disabled", "info");
          break;
        }

        case "stats": {
          if (!runtime.backendAvailable) {
            ctx.ui.notify("Memory backend not available", "error");
            break;
          }
          try {
            const stats = runtime.store.computeStats();
            await showStatsOverlay(ctx, stats);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            ctx.ui.notify(`Stats error: ${msg}`, "error");
          }
          break;
        }

        case "search": {
          const query = parts.slice(1).join(" ");
          if (!query) {
            ctx.ui.notify("Usage: /memory search <query>", "warning");
            break;
          }
          pi.sendUserMessage(`Search my memory for: ${query}`);
          break;
        }

        case "graph": {
          pi.sendUserMessage("Show the palace graph with cross-project connections");
          break;
        }

        case "knowledge": {
          const entity = parts.slice(1).join(" ");
          if (!entity) {
            ctx.ui.notify("Usage: /memory knowledge <entity>", "warning");
            break;
          }
          pi.sendUserMessage(`Query knowledge graph for: ${entity}`);
          break;
        }

        case "rooms": {
          const project = parts.slice(1).join(" ") || undefined;
          pi.sendUserMessage(project
            ? `List topics (rooms) in project: ${project}`
            : "List all topics (rooms) in the memory palace");
          break;
        }

        case "taxonomy": {
          pi.sendUserMessage("Show the full memory taxonomy: projects, topics, and counts");
          break;
        }

        case "diary": {
          const diaryArg = parts.slice(1).join(" ") || "";
          pi.sendUserMessage(diaryArg
            ? `Read my diary entries: ${diaryArg}`
            : "Read my recent diary entries");
          break;
        }

        case "timeline": {
          const entity = parts.slice(1).join(" ") || "";
          pi.sendUserMessage(entity
            ? `Show knowledge timeline for: ${entity}`
            : "Show the full knowledge timeline");
          break;
        }

        default: {
          ctx.ui.notify(
            "Usage: /memory [status|stats|project|search|graph|knowledge|rooms|taxonomy|diary|timeline|on|off]",
            "info"
          );
        }
      }
    },
    getArgumentCompletions: (prefix) => {
      const commands = ["status", "stats", "project", "search", "graph", "knowledge", "rooms", "taxonomy", "diary", "timeline", "on", "off"];
      return commands
        .filter((c) => c.startsWith(prefix))
        .map((c) => ({ label: c, value: c, type: "text" as const }));
    },
  });
}
