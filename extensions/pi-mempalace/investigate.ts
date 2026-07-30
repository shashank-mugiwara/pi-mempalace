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
import { randomUUID } from "node:crypto";
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
  /** Whether the child actually got a response from the obsidian MCP tool
   * (even an empty one) — false if it errored, timed out, or was never
   * called. Defaults to false on absent/malformed field: fail toward
   * "flag as blind" rather than "assume it worked" (Task 5). */
  vault_reached: boolean;
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
    '{"confident": bool, "items": [{"project": str, "topic": str, "text": str, "source": "memory"|"vault"}], "skills": [str], "options": [{"text": str, "choices": [str]}], "vault_reached": bool}'
  );
  lines.push(
    "Set vault_reached=true only if you actually got a response from the obsidian MCP tool (even an " +
      "empty one) — false if the mcp tool errored, timed out, or you didn't call it."
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

/** Raised twice during implementation smoke-testing (90s -> 180s -> 240s).
 * The doc's original spike (~27-63s) used simple queries with no investigator
 * framing. The real buildChildPrompt() measured ~137-170s on working queries,
 * but 2 of 3 real end-to-end tests against "recall gate design"-style queries
 * (broad, needing both memory AND vault search) hit the 180s ceiling and were
 * killed mid-investigation, falling back to legacy recall instead of
 * completing — the fail-open path worked correctly, but the real
 * tool-using investigation silently degraded more often than expected.
 * 240s gives real headroom above the observed ~180s tail. */
const DEFAULT_TIMEOUT_MS = 240_000;

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
export function parseVerdict(text: string): InvestigateVerdict | null {
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
      // Fail toward "flag as blind": anything but a literal `true` counts as
      // not-reached, so a malformed/missing field never masquerades as success.
      vault_reached: parsed.vault_reached === true,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Subagent mechanism (pi-subagents RPC) — default, replaces the child spawn
// above for the common case. See docs/design/memory-investigate.md —
// "Subagent mechanism" section — for why: the child spawn's real cost wasn't
// the OS process, it was (a) a fresh pi process re-resolving model/auth from
// scratch (observed: two runs hung 180s on an expired Bedrock SSO token even
// though Bedrock was never requested — model-registry init reaching for it
// anyway) and (b) the Obsidian MCP server cold-starting via `npx` on every
// call (measured to roughly triple latency). Both disappear when the
// investigation runs as an in-process pi-subagent that greps/reads the vault
// directly instead of going through MCP — the vault is LLMWiki-organized
// plain markdown on disk (see agents/memory-investigator.md), not something
// that needs an API. Bonus: dissolves the MCP-scoping blocker entirely —
// no `mcp` extension loads for this agent type, so there's no `exa`/`prism`
// reach to defend against and ensureObsidianOnlyMcpConfig() above is now only
// needed by the "child" mechanism fallback.

/** Measured ~15-35s per real query (grep/read on plain files + in-process
 * memory tools, no MCP cold start, no fresh OS process) vs 90-220s for the
 * child mechanism — see the design doc's measurement log. If this still
 * needs 60s+ in practice the bottleneck moved to model reasoning, not
 * transport, and that's the signal to revisit synchronous-vs-background,
 * not to just raise this number again. */
const SUBAGENT_TIMEOUT_MS = 75_000;

/** Minimal shape of pi's EventBus (pi.events) — avoids importing pi-coding-agent
 * types into this module, matching this file's existing "zero pi imports beyond
 * node builtins" discipline (only the caller, index.ts, touches ExtensionAPI). */
export interface SubagentEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

let subagentsReady = false;
let subagentsReadyWired = false;

/** Wire the one-time subagents:ready listener. Safe to call every session_start —
 * only the first call binds the listener (module-scoped, survives across sessions
 * in the same process, which is fine: pi-subagents being loaded is a install-time
 * fact, not a per-session one). If pi-subagents is never loaded, subagentsReady
 * stays false forever and runInvestigationViaSubagent fails open immediately
 * instead of emitting into the void and timing out. */
export function wireSubagentsReadyTracking(events: SubagentEventBus): void {
  if (subagentsReadyWired) return;
  subagentsReadyWired = true;
  events.on("subagents:ready", () => {
    subagentsReady = true;
  });
}

function buildSubagentPrompt(input: InvestigateInput): string {
  // The custom agent's own system prompt (agents/memory-investigator.md)
  // already covers vault strategy, judgment rules, and output format — this
  // is just the per-call variable part (buildChildPrompt's equivalent for
  // the child mechanism carries the full instructions since -p replaces the
  // whole prompt; prompt_mode: replace here means the frontmatter body IS the
  // system prompt, so this string is the user turn, not a system prompt).
  const lines = [`Query: ${input.query}`, `Current project: ${input.project ?? "(unknown)"}`];
  if (input.skills?.length) {
    lines.push(
      "",
      "Skills you may name (never re-explain) up to 2 of, if genuinely applicable:",
      ...input.skills.map((s) => `- ${s.name}: ${s.description}`)
    );
  }
  if (input.priorFindings?.length) {
    lines.push(
      "",
      "Prior findings from earlier investigations this session (confirm still relevant or supersede, don't blindly repeat):",
      ...input.priorFindings.map((f) => `- ${f}`)
    );
  }
  return lines.join("\n");
}

/**
 * Spawn `memory-investigator` as an in-process pi-subagent via the
 * cross-extension RPC bus and await its verdict. Never throws — every
 * failure path (pi-subagents not loaded, spawn rejected, timeout, failed
 * agent, unparseable result) resolves to `null` so the caller
 * (index.ts's memory_investigate tool) falls open to fallbackToLegacyRecall,
 * exactly like the child mechanism.
 */
export async function runInvestigationViaSubagent(
  input: InvestigateInput,
  events: SubagentEventBus,
  opts: { timeoutMs: number } = { timeoutMs: SUBAGENT_TIMEOUT_MS }
): Promise<InvestigateVerdict | null> {
  if (!subagentsReady) {
    lastFailureDiagnostic = { exitCode: null, stderr: "pi-subagents not ready/loaded in this session", stdoutTail: "" };
    return null;
  }

  const prompt = buildSubagentPrompt(input);

  return new Promise((resolve) => {
    const requestId = randomUUID();
    let agentId: string | null = null;
    let settled = false;
    const unsubs: (() => void)[] = [];

    const settle = (result: InvestigateVerdict | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const unsub of unsubs) unsub();
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (agentId) events.emit("subagents:rpc:stop", { requestId: randomUUID(), agentId });
      lastFailureDiagnostic = { exitCode: null, stderr: `subagent timeout after ${opts.timeoutMs}ms`, stdoutTail: "" };
      settle(null);
    }, opts.timeoutMs);

    // Registered before the spawn emit, per pi-subagents' documented RPC
    // pattern — the reply and any lifecycle event are dispatched synchronously
    // through the same in-process event bus, so a listener added after emit()
    // returns would already have missed a same-tick reply.
    unsubs.push(
      events.on(`subagents:rpc:spawn:reply:${requestId}`, (reply: unknown) => {
        const r = reply as { success: boolean; data?: { id: string }; error?: string };
        if (!r?.success || !r.data?.id) {
          lastFailureDiagnostic = { exitCode: null, stderr: `spawn failed: ${r?.error ?? "unknown"}`, stdoutTail: "" };
          settle(null);
          return;
        }
        agentId = r.data.id;
      })
    );

    unsubs.push(
      events.on("subagents:completed", (e: unknown) => {
        const ev = e as { id?: string; result?: string };
        if (!agentId || ev?.id !== agentId) return; // another agent's completion, not ours
        const verdict = parseVerdict(String(ev.result ?? ""));
        if (verdict === null) {
          lastFailureDiagnostic = {
            exitCode: null,
            stderr: "unparseable subagent result",
            stdoutTail: String(ev.result ?? "").slice(-500),
          };
        }
        settle(verdict);
      })
    );

    unsubs.push(
      events.on("subagents:failed", (e: unknown) => {
        const ev = e as { id?: string; error?: string; status?: string };
        if (!agentId || ev?.id !== agentId) return;
        lastFailureDiagnostic = {
          exitCode: null,
          stderr: `subagent failed: ${ev?.error ?? ev?.status ?? "unknown"}`,
          stdoutTail: "",
        };
        settle(null);
      })
    );

    events.emit("subagents:rpc:spawn", {
      requestId,
      type: "memory-investigator",
      prompt,
      options: {
        description: "Memory investigation",
        // NOT cwd: VAULT_HOME. Tried that; it broke the subagent's project
        // identity — detectProject(ctx.cwd) resolved it to "shashank" (the
        // vault's own directory name) instead of the caller's actual project,
        // which is the default filter for memory_search/memory_recall and the
        // anchor for the cross-project penalty inside the investigator's own
        // recall. The agent's prompt already names the absolute vault path
        // (agents/memory-investigator.md); no-cwd is the configuration proven
        // to work (both manual tests, and the fix for this exact bug).
        isBackground: false,
      },
    });
  });
}
