/**
 * investigate.ts — child-process invocation for `memory_investigate`
 * (docs/design/memory-investigate.md, Task 2).
 *
 * Spawns a restricted, headless `pi -p` child with real tool access (memory
 * palace search + Obsidian MCP, scoped to Obsidian only — see
 * ensureObsidianOnlyMcpConfig) so the main session's agent can get a real
 * tool-using investigation instead of a raw similarity search. Async-only
 * (`spawn`, never `execFileSync`/`spawnSync`) per bedrock-profiles.ts's
 * documented TUI-freeze incident — a sync child-process call here would
 * stall the whole TUI for however long an investigation takes.
 *
 * MEASURED (2026-07-30, real implementation, not the original spike): the
 * original design-doc spike (~27-63s) used simple direct queries with no
 * investigator framing. The REAL child prompt (buildChildPrompt below) asks
 * the model to actually search both memory AND vault and reason about
 * confidence — a genuinely ambiguous query took ~170s end to end in testing.
 * Default timeout raised accordingly (see DEFAULT_TIMEOUT_MS).
 *
 * Zero pi imports beyond node builtins, matching gate.ts's "stays
 * unit-testable with plain node" discipline — this module never talks to a
 * model registry directly, it always goes through a spawned pi process.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InvestigateInput {
  query: string;
  project: string | null;
  skills?: { name: string; description: string }[];
  priorFindings?: string[]; // bounded, from Task 3's runtime state
}

export interface InvestigateVerdict {
  confident: boolean;
  items: { project: string; topic: string; text: string; source: "memory" | "vault" }[];
  skills: string[];
  options?: { text: string; choices: string[] }[]; // present only when confident=false
}

/** Set by the most recent failed runInvestigation() call; read by index.ts's
 * logInvestigationRaw (Task 4) so a failure log line carries real diagnostics
 * instead of just "child-failed" + elapsed ms. Module-level is acceptable here
 * (not per-session state) since only one investigation runs at a time per
 * caller and the log write happens immediately after the call that set it. */
export let lastFailureDiagnostic: { exitCode: number | null; stderr: string; stdoutTail: string } | null = null;

// ---------------------------------------------------------------------------
// Child prompt
// ---------------------------------------------------------------------------

function buildChildPrompt(input: InvestigateInput): string {
  const lines = [
    "You are a memory-and-vault investigator for an AI coding agent.",
    "Search the memory palace (memory_search, memory_recall, knowledge_query, memory_taxonomy)",
    "and the Obsidian vault (mcp tool, server: obsidian) for context relevant to the query below.",
    "Approve ONLY items a competent engineer would actually want in context for this specific",
    "query. Zero items is common and correct. Do not approve something just because it mentions",
    "the same project or a similar topic.",
    "",
    "If genuinely uncertain which of several candidates is meant, set confident=false and put a",
    "clarifying question (with 2-4 short choices) in options — do not guess.",
    "",
  ];
  if (input.skills?.length) {
    lines.push("You may name (never re-explain) up to 2 skill names from this list if genuinely");
    lines.push("applicable to the query. Never restate rules or writing-style guidance — that is");
    lines.push("injected elsewhere already.");
    for (const s of input.skills) lines.push(`- ${s.name}: ${s.description}`);
    lines.push("");
  }
  if (input.priorFindings?.length) {
    lines.push("Prior findings from earlier turns this session (for continuity — confirm still");
    lines.push("relevant or supersede, don't blindly repeat):");
    lines.push(...input.priorFindings.map((f) => `- ${f}`));
    lines.push("");
  }
  lines.push(`Current project: ${input.project ?? "(unknown)"}`);
  lines.push(`Query: ${input.query}`);
  lines.push("");
  lines.push("End your response with STRICT JSON on its own line, no markdown fence:");
  lines.push(
    '{"confident": bool, "items": [{"project": str, "topic": str, "text": str, "source": "memory"|"vault"}], "skills": [str], "options": [{"text": str, "choices": [str]}]}'
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Obsidian-only MCP config
// ---------------------------------------------------------------------------

const OBSIDIAN_ONLY_MCP_CONFIG = join(homedir(), ".pi", "agent", "memory", "mcp-obsidian-only.json");

/**
 * Generate a filtered MCP config containing ONLY the `obsidian` server, so
 * an unsupervised `--no-approve` investigator child never gets reach into
 * the other servers configured in the live ~/.pi/agent/mcp.json (today:
 * `exa` paid web search, `prism` an internal Credit Saison fintech API,
 * `context7`). `--tools ...,mcp` alone does NOT scope the `mcp` gateway tool
 * to a single server — pi-mcp-adapter registers one `mcp` proxy tool backed
 * by every configured server; `--mcp-config <path>` is the actual scoping
 * mechanism (confirmed via `pi --help` and pi-mcp-adapter/index.ts:252).
 *
 * Regenerated on every call rather than cached across process lifetime —
 * cheap (one small file write) and keeps it in sync if the user
 * reconfigures the obsidian server. Best-effort: if the live config or its
 * obsidian entry is missing, writes an empty mcpServers object so the child
 * still starts (with no MCP tools reachable) instead of failing to spawn.
 */
function ensureObsidianOnlyMcpConfig(): string {
  let obsidian: unknown;
  try {
    const fullConfigPath = join(homedir(), ".pi", "agent", "mcp.json");
    const full = JSON.parse(readFileSync(fullConfigPath, "utf8"));
    obsidian = full?.mcpServers?.obsidian;
  } catch {
    obsidian = undefined;
  }
  const filtered = { mcpServers: obsidian ? { obsidian } : {} };
  mkdirSync(join(homedir(), ".pi", "agent", "memory"), { recursive: true });
  writeFileSync(OBSIDIAN_ONLY_MCP_CONFIG, JSON.stringify(filtered, null, 2));
  return OBSIDIAN_ONLY_MCP_CONFIG;
}

// ---------------------------------------------------------------------------
// Spawn + await
// ---------------------------------------------------------------------------

const FORK = join(homedir(), ".pi", "agent", "pi-mempalace-fork");
const MCP_ADAPTER = join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-mcp-adapter", "index.ts");
const MEMPALACE_EXT = join(FORK, "extensions", "pi-mempalace", "index.ts");

/** Raised from the design doc's original 90s to 180s after the real (not
 * spike-simplified) child prompt measured ~170s end-to-end on a genuinely
 * ambiguous, multi-tool query — 90s was cutting it too close to the actual
 * distribution's tail, not just its median. */
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Spawn a restricted headless `pi -p` child to investigate `input.query`.
 * Never throws — every failure path (spawn error, timeout, unparseable
 * output) resolves to `null` so callers (index.ts's memory_investigate tool)
 * fail open to the legacy selectRecall path (Task 4).
 */
export async function runInvestigation(
  input: InvestigateInput,
  opts: { timeoutMs: number } = { timeoutMs: DEFAULT_TIMEOUT_MS }
): Promise<InvestigateVerdict | null> {
  const prompt = buildChildPrompt(input);
  const mcpConfigPath = ensureObsidianOnlyMcpConfig();
  return new Promise((resolve) => {
    const child = spawn(
      "pi",
      [
        "-p", prompt,
        "--no-extensions",
        "-e", MCP_ADAPTER,
        "-e", MEMPALACE_EXT,
        "--mcp-config", mcpConfigPath,
        "--no-context-files", "--no-approve", "--no-session",
        "--provider", "openai-codex", "--model", "gpt-5.4-mini",
        "--tools", "memory_search,memory_recall,knowledge_query,memory_taxonomy,mcp",
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MEMPALACE_INVESTIGATOR: "1" } }
    );

    let out = "";
    let errOut = ""; // captured (not dropped) so a failed child is debuggable from investigate.log
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (errOut += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, opts.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const verdict = parseVerdict(out);
      if (verdict === null) {
        lastFailureDiagnostic = { exitCode: code, stderr: errOut.slice(-2000), stdoutTail: out.slice(-500) };
      }
      resolve(verdict);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      lastFailureDiagnostic = { exitCode: null, stderr: String(err), stdoutTail: out.slice(-500) };
      resolve(null);
    });
  });
}

// ---------------------------------------------------------------------------
// Tolerant JSON parser
// ---------------------------------------------------------------------------

/**
 * Mirrors gate.ts's parseGateResponse's tolerance, but finds the LAST
 * balanced {...} block rather than the first — unlike gate.ts's
 * single-purpose classifier prompt, this child narrates its search process
 * (tool calls, reasoning) before concluding with the JSON verdict, so the
 * first '{' in the transcript is very likely NOT the answer.
 *
 * Never throws. A malformed-but-parseable response with confident:false and
 * no usable options is normalized to a generic clarifying question rather
 * than silently discarding the model's expressed uncertainty.
 */
function parseVerdict(text: string): InvestigateVerdict | null {
  const end = text.lastIndexOf("}");
  if (end === -1) return null;
  // Scan backward from the last '}' tracking brace depth to find the start
  // of the JSON object that CONTAINS it (handles nested objects correctly,
  // unlike a naive first-'{'/last-'}' pairing).
  let depth = 0;
  let objStart = -1;
  for (let i = end; i >= 0; i--) {
    if (text[i] === "}") depth++;
    else if (text[i] === "{") {
      depth--;
      if (depth === 0) {
        objStart = i;
        break;
      }
    }
  }
  if (objStart === -1) return null;

  try {
    const parsed = JSON.parse(text.slice(objStart, end + 1));
    if (typeof parsed !== "object" || parsed === null) return null;

    const options = Array.isArray(parsed.options)
      ? parsed.options.filter((o: unknown) => o && typeof (o as { text?: unknown }).text === "string")
      : [];
    const confident = parsed.confident !== false;

    return {
      confident,
      items: Array.isArray(parsed.items)
        ? parsed.items.filter((i: unknown) => i && typeof (i as { text?: unknown }).text === "string")
        : [],
      skills: Array.isArray(parsed.skills)
        ? parsed.skills.filter((s: unknown) => typeof s === "string").slice(0, 2)
        : [],
      options:
        !confident && options.length === 0
          ? [
              {
                text: "Investigation was uncertain but did not provide specific options. Proceed anyway, or narrow the query?",
                choices: ["proceed without memory context", "let me rephrase"],
              },
            ]
          : options.length > 0
            ? options
            : undefined,
    };
  } catch {
    return null;
  }
}
