# `memory_investigate` — agent-driven recall (design, not yet implemented)

Locked via grill-me interview with Shashank on 2026-07-29/30. Supersedes the
automatic per-turn `before_agent_start` auto-recall (`recall.ts` gate path)
for the *retrieval* side only. `memory_save` / `knowledge_add` / etc. are
untouched.

## Problem with today's design

The current gate (`recall.ts` + `gate.ts` + `buildGateJudge` in `index.ts`)
is a single-shot classifier: it only approves/rejects candidates the
bi-encoder + cross-encoder already found in the memory-palace store. It never
sees the Obsidian vault, has no tool access, and runs silently on every turn
whether or not the agent actually needs memory context.

## Resolved decisions (in dependency order)

1. **Gate becomes a real tool-using subagent turn**, not a bigger classifier
   prompt — it needs to decide what to search, not just judge a fixed list.
2. **Mechanism: spawn + await a restricted headless `pi -p` child.** Reuses
   real tool implementations (including live Obsidian MCP) instead of
   reimplementing vault search. Confirmed via `pi --help`: explicit `-e`
   paths still work under `--no-extensions`, so the child can load exactly
   `pi-mcp-adapter` + `pi-mempalace` (for `memory_search`/`memory_recall`/
   `knowledge_query`) without pi-canary, harness-rules, watchdog,
   bedrock-profiles, subagents, skill-gate, ponytail, cache-ttl-config.
3. **Scope: content retrieval AND skill relevance**, replacing
   `autoRecallGateSuggestSkills`. The investigator receives the skills
   catalog and may name (not re-explain) up to 2 relevant skill names — it
   must never emit rules/writing-style prose, since `harness-rules.ts`
   already injects vault standing rules unconditionally on every turn and
   that would be pure duplication.
4. **Trigger model: on-demand tool, not automatic hook injection.**
   `pi.registerTool("memory_investigate", ...)` — the *main* session agent
   calls it (system prompt instructs it to prefer this over raw
   `memory_search`, and to call it on the first substantive message and
   whenever it needs memory context). Fully replaces the automatic
   `before_agent_start` auto-recall block — no turn-1 special case in code,
   no per-turn hardcoded rule. Frequency is the agent's own judgment.
5. **Ambiguity handling: no queue file.** Because the investigation is
   synchronous inside a tool call (not decoupled on a background timer like
   `session-watchdog.ts`), a low-confidence result is just part of the tool
   result: `{confident: false, options: [...]}`. The *live* agent (real TTY,
   unlike the spawned child) calls `ask_user_question` itself, then
   re-invokes `memory_investigate` with the clarified query. The answer
   persists into later turns via ordinary conversation history, which future
   investigations are seeded with anyway.
6. **Output cap: judgment-based, not fixed.** The investigator returns
   however many items it judges genuinely relevant (often 1, sometimes 0,
   occasionally 2-3 related facts) rather than a hardcoded count.
7. **Per-turn shape: one mechanism, no fallback tiers.** Every call to
   `memory_investigate` runs the full investigation, seeded with prior
   findings from earlier calls this session (bounded — last ~3 investigations,
   char-capped) so it's not blind re-exploration, but it is never a
   downgraded/cheap decision path standing in for the real one. Explicitly
   rejected: a 3-tier escalation chain (cheap gate → escalate → ask) — "do it
   correctly once, not going in a loop."
8. **Latency accepted as a known tradeoff, not optimized upfront** (see
   spike numbers below). Revisit only if it proves annoying in practice.

## Spike results (measured, not estimated) — 2026-07-30

```
pi -p "<query>" --no-extensions \
  -e npm/node_modules/pi-mcp-adapter/index.ts \
  -e pi-mempalace-fork/extensions/pi-mempalace/index.ts \
  --no-context-files --no-approve --no-session \
  --provider openai-codex --model gpt-5.4-mini \
  --tools memory_search,memory_recall,knowledge_query,memory_taxonomy[,mcp]
```

| Config | Wall-clock |
|---|---|
| Memory tools only | 26.6s |
| + `mcp` gateway (Obsidian via `npx @bitbonsai/mcpvault@latest`) | 62.6s |

Findings that changed the implementation plan:
- **`--mode json` is not usable for parsing.** It only streams terse
  lifecycle events (`{"type":"agent_settled"}`) — no final assistant text.
  The child must run in default text mode; its system prompt instructs it to
  end with strict JSON as its last output, parsed with the same
  tolerant-extraction approach as `gate.ts`'s `parseGateResponse` (find
  first `{...}` block, `JSON.parse`, drop invalid keys, never throw).
- **Obsidian MCP roughly triples latency** via `npx` cold-starting
  `@bitbonsai/mcpvault` fresh every call. Not model latency — process
  spin-up. Accepted as-is per decision #8; a warm/persistent MCP connection
  or a locally-installed (non-`npx`) binary would be the fix if this becomes
  a problem.

## Implementation checklist (advisor review, not yet built) — SUPERSEDED

> Superseded by the task-by-task "Implementation Plan" below, which has
> since been through a full design review (see that section's inline
> "caught in design review" notes and the Self-Review at the end). Kept here
> verbatim as the historical record of the advisor's original pass — every
> bullet below now maps onto a concrete task, several with fixes the advisor
> pass didn't catch (unscoped `mcp` access to internal/paid servers; passive
> logging repeating a documented prior silent-outage pattern). Do not use
> this checklist as the implementation source of truth; use the tasks below.

- [ ] **Recursion guard.** Spawn with `env: { ...process.env,
      MEMPALACE_INVESTIGATOR: "1" }`. At the top of `pi-mempalace/index.ts`'s
      default export, if that var is set: skip registering
      `memory_investigate`, skip wake-up digest, skip taxonomy injection —
      child gets only raw read tools. This is the real fix; the `--tools`
      allowlist (which already excludes it) is belt-and-braces on top.
      Precedent: `hooks/claude-first-prompt-explorer.mjs` already solved
      this exact problem with `MEMPALACE_EXPLORER=1`.
- [ ] **Async spawn only** (`spawn` + Promise + `AbortController`, ~90s
      timeout matching the claude-explorer precedent, kill child on abort).
      `execFileSync` is explicitly called out as TUI-freezing scar tissue in
      `bedrock-profiles.ts` — do not repeat that mistake.
- [ ] **Pin `--provider`/`--model` explicitly** for the investigator (e.g.
      `openai-codex/gpt-5.4-mini`, proven in the spike). Do not inherit the
      session default (`openai-codex/gpt-5.6-sol`, expensive) and do not
      pick a Bedrock model (`bedrock-profiles.ts` won't be loaded in the
      child to refresh SSO credentials, and the token is often expired).
- [ ] **Read-only allowlist.** `--tools memory_search,memory_recall,
      knowledge_query,memory_taxonomy,mcp` — no `bash`/`write`/`edit`/
      `memory_save`, no Obsidian write tools.
- [ ] **Fail-open safety net.** On child timeout/error/unparseable output,
      fall back to today's legacy `selectRecall` path from `recall.ts`
      (bi-encoder + cross-encoder, no LLM gate) so a broken child never
      returns nothing. Leave `recall.ts` and `bench/run-bench.mjs`
      (which shares it) untouched — this is a fallback consumer, not a
      refactor target.
- [ ] **Prior-findings seeding.** Session-scoped, bounded array (last ~3
      investigations, hard char cap) in `runtime`, folded into the child's
      prompt each call.
- [ ] **Obsidian availability.** MCP Obsidian needs Obsidian + Local REST
      API plugin running (config: `mcp.json` → `obsidian` server runs
      `npx @bitbonsai/mcpvault@latest /Users/shashank.j/Desktop/shashank`).
      If unavailable, the investigator must report vault-unavailable rather
      than silently returning memory-palace-only results — the vault holds
      the harness rules canon, so silent vault blindness is a real
      regression, not a graceful degrade.
- [ ] **Config-gate + observability.** Add `investigateEnabled` (default
      true), keep `autoRecall` config working as a one-edit rollback. Log
      every investigation (query, confidence, items returned, wall-clock,
      child exit status) to `~/.pi/agent/memory/investigate.log`, mirroring
      `recall-gate.log`. This codebase has a documented history of *silent*
      recall outages (fail-closed + the `temperature`-rejection bug,
      2026-07-28) — an unobservable new retrieval path repeats that mistake.
- [ ] Known accepted risk: removing automatic auto-recall means there is no
      safety net if the model simply doesn't call `memory_investigate`. The
      static wake-up digest + taxonomy injection (kept, unchanged) partially
      mitigate this. Retune the system-prompt instruction strength if recall
      starts getting skipped in practice.

## Implementation Plan

> REQUIRED SUB-SKILL for whoever executes this: work task-by-task, run the smoke test at the end of each task before moving on, commit after each task.

**Goal:** Replace pi-mempalace's automatic per-turn auto-recall with an on-demand `memory_investigate` tool backed by a restricted headless `pi -p` child.

**Architecture:** New module `investigate.ts` owns the child-process lifecycle, prompt-building, and JSON parsing. `index.ts` registers the tool and wires it to `runtime`. `recall.ts`'s legacy path is reused unmodified as the fail-open fallback.

**Tech Stack:** `node:child_process` (`spawn`), existing `pi-ai`/`pi-coding-agent` tool types, `gate.ts`'s tolerant JSON extraction pattern (copied, not imported — `gate.ts` is deliberately zero-pi-imports for bench reuse; don't break that by pulling it into a child-process module).

## Global Constraints

- Recursion guard is non-negotiable and must land in Task 1, before the tool exists — an ordering violation here is a fork bomb, not a bug.
- No `execFileSync`/`spawnSync` for the child call — `bedrock-profiles.ts` documents the TUI-freeze failure mode this caused historically.
- Child must never receive `bash`, `write`, `edit`, `memory_save`, or any Obsidian write tool in its `--tools` allowlist.
- Pin `--provider openai-codex --model gpt-5.4-mini` explicitly (spike-verified, non-Bedrock, avoids the SSO-refresh gap since `bedrock-profiles.ts` isn't loaded in the child).

---

### Task 1: Recursion guard

**Files:**
- Modify: `extensions/pi-mempalace/index.ts:` top of the default export function (before any `pi.on`/`pi.registerTool` calls — currently starts around the runtime/config setup block near the top of `export default function`)

**Interfaces:**
- Produces: `const isInvestigatorChild = process.env.MEMPALACE_INVESTIGATOR === "1";` — later tasks gate on this constant.

- [ ] **Step 1: Add the guard constant and early-return branches**

```typescript
export default function (pi: ExtensionAPI) {
  const isInvestigatorChild = process.env.MEMPALACE_INVESTIGATOR === "1";
  // ... existing runtime/config setup ...
```

Then wrap the three things a child must never do:
1. Wrap the `memory_investigate` tool registration (added in Task 3) in `if (!isInvestigatorChild) { ... }`.
2. In the `before_agent_start` handler, skip the wake-up digest / taxonomy injection block when `isInvestigatorChild` is true (child gets a plain system prompt from `--append-system-prompt` instead — see Task 2).
3. Leave `memory_search`/`memory_recall`/`knowledge_query`/`memory_taxonomy` tool registrations unguarded — the child needs those.

- [ ] **Step 2: Smoke test the guard in isolation**

Run (pinning `--provider`/`--model` explicitly, matching the real Task 2 invocation — an unpinned run falls through to the session default and risks an unrelated auth failure masquerading as a guard failure):
```bash
MEMPALACE_INVESTIGATOR=1 pi -p "list your tools" --no-extensions \
  -e extensions/pi-mempalace/index.ts \
  --no-session --provider openai-codex --model gpt-5.4-mini \
  --tools memory_search,memory_investigate 2>&1 | head -5
```
Expected: no `memory_investigate` in the tool list the model reports having — if it's absent, the guard works. No hang, no recursive spawn.

- [ ] **Step 3: Commit**
```bash
git add extensions/pi-mempalace/index.ts
git commit -m "guard(investigate): MEMPALACE_INVESTIGATOR env skips tool registration + injections in child"
```

---

### Task 2: Child invocation module

**Files:**
- Create: `extensions/pi-mempalace/investigate.ts`
- Test: manual smoke test (Step 4 below) — no unit test framework exists in this repo for process-spawning code; `bench/` covers `recall.ts` only.

**Interfaces:**
- Consumes: nothing from other new tasks (this is the leaf module).
- Produces:
  ```typescript
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
  export async function runInvestigation(input: InvestigateInput, opts: { timeoutMs: number }): Promise<InvestigateVerdict | null>; // null = spawn/parse failure, caller fails open
  ```

- [ ] **Step 1: Write the child system prompt builder**

```typescript
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
  lines.push('End your response with STRICT JSON on its own line, no markdown fence:');
  lines.push('{"confident": bool, "items": [{"project": str, "topic": str, "text": str, "source": "memory"|"vault"}], "skills": [str], "options": [{"text": str, "choices": [str]}]}');
  return lines.join("\n");
}
```

- [ ] **Step 2a: Generate an Obsidian-only MCP config for the child** (fixes a critical gap caught in design review: `--tools ...,mcp` alone does NOT scope the `mcp` gateway tool to Obsidian — `pi-mcp-adapter` registers ONE `mcp` proxy tool backed by every server in `~/.pi/agent/mcp.json`, which today includes `exa` (paid web search), `prism` (an internal Credit Saison fintech API), and `context7`, not just `obsidian`. An unsupervised `--no-approve` child must not get network reach to an internal API or a paid search API just because it needed vault search. `pi-mcp-adapter` exposes `--mcp-config <path>` for exactly this — confirmed in `pi --help` and `pi-mcp-adapter/index.ts:252`.)

```typescript
import { writeFileSync, existsSync, mkdirSync } from "node:fs";

const OBSIDIAN_ONLY_MCP_CONFIG = join(homedir(), ".pi", "agent", "memory", "mcp-obsidian-only.json");

/** Written once (idempotent) from the live mcp.json's obsidian entry, so the
 * child never sees exa/prism/context7. Regenerated on every call rather than
 * cached across process lifetime — cheap (one small file write) and keeps it
 * in sync if the user reconfigures the obsidian server. */
function ensureObsidianOnlyMcpConfig(): string {
  const fullConfigPath = join(homedir(), ".pi", "agent", "mcp.json");
  const full = JSON.parse(require("node:fs").readFileSync(fullConfigPath, "utf8"));
  const obsidian = full.mcpServers?.obsidian;
  const filtered = { mcpServers: obsidian ? { obsidian } : {} };
  mkdirSync(join(homedir(), ".pi", "agent", "memory"), { recursive: true });
  writeFileSync(OBSIDIAN_ONLY_MCP_CONFIG, JSON.stringify(filtered, null, 2));
  return OBSIDIAN_ONLY_MCP_CONFIG;
}
```

- [ ] **Step 2b: Write the spawn + await wrapper (async only, per Global Constraints — see Task 2 note on the async-only citation below)**

```typescript
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const FORK = join(homedir(), ".pi", "agent", "pi-mempalace-fork");
const MCP_ADAPTER = join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-mcp-adapter", "index.ts");
const MEMPALACE_EXT = join(FORK, "extensions", "pi-mempalace", "index.ts");

export async function runInvestigation(
  input: InvestigateInput,
  opts: { timeoutMs: number } = { timeoutMs: 90_000 }
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
    let errOut = ""; // captured per design review — previously dropped entirely, leaving a failed
                      // child undebuggable from investigate.log alone (see Task 4's logging fix)
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (errOut += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, opts.timeoutMs);

    let exitCode: number | null = null;
    child.on("close", (code) => {
      clearTimeout(timer);
      exitCode = code;
      const verdict = parseVerdict(out);
      if (verdict === null) {
        lastFailureDiagnostic = { exitCode, stderr: errOut.slice(-2000), stdoutTail: out.slice(-500) };
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

/** Set by the most recent failed runInvestigation() call; read by index.ts's
 * logInvestigationRaw (Task 4) so a failure log line carries real diagnostics
 * instead of just "child-failed" + elapsed ms. Module-level is acceptable here
 * (not per-session state) since only one investigation runs at a time per
 * caller and the log write happens immediately after the call that set it. */
export let lastFailureDiagnostic: { exitCode: number | null; stderr: string; stdoutTail: string } | null = null;
```

**Async-spawn citation correction (design review):** the doc's Global
Constraints correctly require async `spawn`, not `execFileSync`/`spawnSync`
— but the real justification is `bedrock-profiles.ts`'s documented
TUI-freeze incident, not `claude-first-prompt-explorer.mjs`. That precedent
actually uses `spawnSync` (verified: `hooks/claude-first-prompt-explorer.mjs:47-49,88`)
and is only precedent for the *recursion-guard* pattern and the *90s timeout*
value, not for async-vs-sync spawning. Both constraints are real; keep them
separate when citing sources so a future reader doesn't go looking for
async-spawn precedent in the wrong file.

- [ ] **Step 3: Write the tolerant JSON parser** (mirrors `gate.ts`'s `parseGateResponse` — find last `{...}` block since the model's prose precedes it, not the first, because unlike `gate.ts`'s single-purpose prompt this child narrates its search process before concluding). Fixed per design review: a malformed-but-parseable response with `confident:false` and no/empty `options` previously fell through silently to the normal items branch, discarding the model's expressed uncertainty — `parseVerdict` now normalizes that case explicitly rather than leaving it for the caller to (not) handle.

```typescript
function parseVerdict(text: string): InvestigateVerdict | null {
  const start = text.lastIndexOf("{");
  if (start === -1) return null;
  // Walk forward from the last '{' is wrong for nested JSON — instead find
  // the LAST '}' and the matching '{' by scanning backward for balance.
  const end = text.lastIndexOf("}");
  if (end === -1 || end < start) return null;
  // Find the start of the JSON object that CONTAINS position `end` by
  // scanning backward from `end` tracking brace depth.
  let depth = 0;
  let objStart = -1;
  for (let i = end; i >= 0; i--) {
    if (text[i] === "}") depth++;
    else if (text[i] === "{") {
      depth--;
      if (depth === 0) { objStart = i; break; }
    }
  }
  if (objStart === -1) return null;
  try {
    const parsed = JSON.parse(text.slice(objStart, end + 1));
    if (typeof parsed !== "object" || parsed === null) return null;
    const options = Array.isArray(parsed.options) ? parsed.options.filter((o: unknown) => o && typeof (o as { text?: unknown }).text === "string") : [];
    // A model that says confident:false but supplies no usable options has
    // expressed uncertainty it can't act on itself — normalize to a generic
    // clarifying question rather than silently falling through to the
    // items/no-items branches downstream (Task 3), which would discard the
    // uncertainty entirely.
    const confident = parsed.confident !== false;
    return {
      confident,
      items: Array.isArray(parsed.items) ? parsed.items.filter((i: unknown) => i && typeof (i as { text?: unknown }).text === "string") : [],
      skills: Array.isArray(parsed.skills) ? parsed.skills.filter((s: unknown) => typeof s === "string").slice(0, 2) : [],
      options: !confident && options.length === 0
        ? [{ text: "Investigation was uncertain but did not provide specific options. Proceed anyway, or narrow the query?", choices: ["proceed without memory context", "let me rephrase"] }]
        : (options.length > 0 ? options : undefined),
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Smoke test**
```bash
node -e '
import("./extensions/pi-mempalace/investigate.ts").then(async (m) => {
  const r = await m.runInvestigation({ query: "what did we decide about the recall gate", project: "pi-config" }, { timeoutMs: 90000 });
  console.log(JSON.stringify(r, null, 2));
});'
```
Expected: parsed object with `confident`, `items` (non-empty for this known-answerable query), no crash. Compare wall-clock to the spike numbers (~27-63s) — if far outside that range, something regressed (e.g. accidentally including `mcp` when Obsidian is unreachable and it's retrying). Also verify `mcp-obsidian-only.json` was written to `~/.pi/agent/memory/` and contains only the `obsidian` server key.

- [ ] **Step 5: Commit**
```bash
git add extensions/pi-mempalace/investigate.ts
git commit -m "feat(investigate): child pi -p spawn wrapper (scoped MCP config, stderr capture), prompt builder, tolerant JSON parse"
```

---

### Task 3: Register `memory_investigate` tool + prior-findings seeding

**Files:**
- Modify: `extensions/pi-mempalace/index.ts` — add inside the `if (!isInvestigatorChild)` guard from Task 1, near the other `pi.registerTool` calls (after `memory_search`, ~line 1028-1085 today)

**Interfaces:**
- Consumes: `runInvestigation`, `InvestigateInput`, `InvestigateVerdict` from `investigate.ts` (Task 2); `selectRecall` from `recall.ts` (existing, for fail-open fallback — see Task 4).
- Produces: session-scoped `runtime.investigationFindings: string[]` (bounded to last 3, each capped ~500 chars) — read back into `InvestigateInput.priorFindings` on the next call within the same session.

- [ ] **Step 1: Add the bounded findings array (and a call-rate counter) to runtime state**

Find the `MemoryRuntime` interface (`index.ts`, search `interface MemoryRuntime`) and add:
```typescript
investigationFindings: string[]; // bounded FIFO, see pushFinding()
investigationCallsThisSession: number; // soft cap, see Step 2's rate check
```
**Also update `createRuntime()`** (`index.ts:348-361` today — it returns a fixed object literal covering every `MemoryRuntime` field; adding fields to the interface without adding them here fails to typecheck). Add both new fields there, initialized to `[]` and `0`.

Add a helper near the interface:
```typescript
function pushFinding(runtime: MemoryRuntime, summary: string) {
  runtime.investigationFindings.push(summary.slice(0, 500));
  if (runtime.investigationFindings.length > 3) runtime.investigationFindings.shift();
}

/** Soft cap only — logs and lets the call through, never blocks ("fail
 * open, never block" per Global Constraints). Every memory_investigate call
 * is a real billed model turn (27-63s per the spike); with no automatic
 * per-turn trigger (recall is fully agent-judgment-driven per decision #4),
 * this is the only backstop against a model re-investigating in a loop on
 * repeated low-confidence results. */
const INVESTIGATION_SOFT_CAP_PER_SESSION = 15;
function checkRateSoft(runtime: MemoryRuntime): void {
  runtime.investigationCallsThisSession++;
  if (runtime.investigationCallsThisSession === INVESTIGATION_SOFT_CAP_PER_SESSION) {
    logInvestigationRaw(runtime.currentProject, "(rate-cap-warning)", "soft-cap-reached", 0);
  }
}
```

- [ ] **Step 2: Register the tool**

```typescript
if (!isInvestigatorChild) {
  pi.registerTool({
    name: "memory_investigate",
    label: "Memory Investigate",
    description:
      "Investigate the memory palace AND Obsidian vault for context relevant to a query, using a " +
      "real tool-using search (not just similarity ranking). Prefer this over memory_search when " +
      "you need curated, judged context rather than a raw similarity list. Slower (20-60s) but " +
      "returns only what actually matters, and can flag when it's genuinely unsure so you can ask " +
      "the user rather than guess.",
    promptSnippet: "memory_investigate(query) — agentic memory+vault investigation, prefer over memory_search for context-gathering",
    promptGuidelines: [
      "Call this on the first substantive message of a session, and whenever you need memory context mid-session — not on every trivial follow-up",
      "If the result has confident=false, it will include an 'options' clarifying question — ask the user via ask_user_question using those options, then call memory_investigate again with the clarified query",
      "Use memory_save/knowledge_add directly to WRITE memory — this tool is search-only",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "What to investigate (natural language)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const runtime = getRuntime(ctx);
      checkRateSoft(runtime);
      const t0 = Date.now();
      const verdict = await runInvestigation(
        {
          query: params.query,
          project: runtime.currentProject,
          // `runtime.skillsCatalog` is typed `GateSkillInput[] | null` (index.ts:168,
          // null on scan failure or before first scan) but InvestigateInput.skills
          // has no null in its union (Task 2) — `?? undefined` closes that type gap
          // (caught in design review; without it this fails to compile whenever
          // autoRecallGateSuggestSkills is true and skillsCatalog hasn't loaded yet).
          skills: runtime.config.autoRecallGateSuggestSkills ? (runtime.skillsCatalog ?? undefined) : undefined,
          priorFindings: runtime.investigationFindings,
        },
        { timeoutMs: 90_000 }
      );
      const elapsedMs = Date.now() - t0;

      if (verdict === null) {
        // Fail open — Task 4 wires this to the legacy selectRecall path.
        return await fallbackToLegacyRecall(runtime, params.query, elapsedMs);
      }

      logInvestigation(runtime.currentProject, params.query, verdict, elapsedMs, "ok");

      // parseVerdict (Task 2) guarantees `options` is populated whenever
      // `confident` is false — including a generic fallback question when the
      // model said it was unsure but gave no usable options — so this check no
      // longer needs (and must not silently drop) the bare confident:false case.
      if (!verdict.confident) {
        return textResult(
          "Investigation was not confident enough to pick automatically. Ask the user via " +
          "ask_user_question using this, then call memory_investigate again with the clarified query:\n\n" +
          JSON.stringify(verdict.options, null, 2)
        );
      }

      if (verdict.items.length === 0) {
        return textResult(`No relevant memory or vault context found for: "${params.query}"`);
      }

      const summary = verdict.items.map((i) => `[${i.source}:${i.project}/${i.topic}] ${i.text.slice(0, 150)}`).join(" | ");
      pushFinding(runtime, summary);

      let text = `Investigation found ${verdict.items.length} relevant item(s):\n\n`;
      for (const item of verdict.items) {
        text += `[${item.source} · ${item.project}/${item.topic}]\n${item.text}\n\n---\n\n`;
      }
      if (verdict.skills.length) text += `Possibly relevant skills: ${verdict.skills.join(", ")} (load if applicable).\n`;
      return textResult(text, { query: params.query, itemCount: verdict.items.length });
    },
    renderResult: renderTextResult,
  });
}
```

- [ ] **Step 3: Smoke test inside a real session**
Start `pi` normally in this repo, ask a question that requires memory context, confirm the model calls `memory_investigate` (system prompt guidance from Task 6 must be in place first — if it doesn't get called, that's expected until Task 6 lands; verify the tool is at least *listed* and *callable* by invoking it explicitly: "call memory_investigate with query X").

- [ ] **Step 4: Commit**
```bash
git add extensions/pi-mempalace/index.ts
git commit -m "feat(investigate): register memory_investigate tool with bounded prior-findings seeding"
```

---

### Task 4: Fail-open fallback + logging

**Files:**
- Modify: `extensions/pi-mempalace/index.ts` — add `fallbackToLegacyRecall` and `logInvestigation` near the tool registered in Task 3

**Interfaces:**
- Consumes: `selectRecall` from `recall.ts` (existing, unmodified), `runtime.config` (existing `RecallConfigSubset` fields).

- [ ] **Step 1: Fail-open fallback**

```typescript
async function fallbackToLegacyRecall(runtime: Runtime, query: string, elapsedMs: number) {
  logInvestigationRaw(runtime.currentProject, query, "child-failed", elapsedMs);
  try {
    const result = await selectRecall(runtime.store, query, {
      project: runtime.currentProject,
      excludeIds: new Set(),
      // Mislabeled in an earlier draft (caught in design review): with
      // autoRecallRerank left at its config default (true), this still runs
      // recall.ts's selectRecallRerank in "rerank" mode via the plain
      // rerankMinScore branch — NOT selectRecallLegacy's bi-encoder-only
      // "legacy" mode. Disabling only the LLM gate is intentional (the child
      // already failed once, don't chain a second model call), it just isn't
      // the "legacy" path by recall.ts's own vocabulary.
      config: { ...runtime.config, autoRecallLlmGate: false },
    });
    if (result.picked.length === 0) return textResult(`No relevant memory found for: "${query}" (investigation unavailable, fell back to similarity search)`);
    let text = `Investigation unavailable — fell back to similarity search. Found ${result.picked.length} candidate(s), unverified:\n\n`;
    for (const hit of result.picked) text += `[${hit.project}/${hit.topic}] (${(hit.similarity * 100).toFixed(0)}% match)\n${hit.text}\n\n---\n\n`;
    return textResult(text);
  } catch {
    return textResult(`No relevant memory found for: "${query}" (investigation and fallback both unavailable)`);
  }
}
```

- [ ] **Step 2: Logging** — mirror `recall-gate.log`'s format/location convention, but with real failure diagnostics (design review Issue #8: the original draft dropped `stderr` entirely, so a failed child was undebuggable from the log alone — Task 2's spawn wrapper now populates `lastFailureDiagnostic` on every failure, consumed here)

```typescript
import { appendFileSync } from "node:fs";
import { lastFailureDiagnostic } from "./investigate.ts";
const INVESTIGATE_LOG = join(os.homedir(), ".pi", "agent", "memory", "investigate.log");

function logInvestigation(project: string | null, query: string, verdict: InvestigateVerdict, elapsedMs: number, status: string) {
  try {
    appendFileSync(
      INVESTIGATE_LOG,
      `${new Date().toISOString()} project=${project ?? "?"} status=${status} confident=${verdict.confident} items=${verdict.items.length} skills=${verdict.skills.length} ms=${elapsedMs} query=${JSON.stringify(query.slice(0, 100))}\n`
    );
  } catch { /* logging must never break the tool */ }
}
function logInvestigationRaw(project: string | null, query: string, status: string, elapsedMs: number) {
  try {
    const diag = lastFailureDiagnostic;
    const diagStr = diag ? ` exit=${diag.exitCode} stderr=${JSON.stringify(diag.stderr.slice(0, 300))}` : "";
    appendFileSync(INVESTIGATE_LOG, `${new Date().toISOString()} project=${project ?? "?"} status=${status} ms=${elapsedMs}${diagStr} query=${JSON.stringify(query.slice(0, 100))}\n`);
  } catch {}
}
```

- [ ] **Step 3: Force a failure to verify the fallback path**
Temporarily set `--model nonexistent-model` inside `investigate.ts`, run the smoke test from Task 3 Step 3, confirm `fallbackToLegacyRecall` fires and returns legacy `selectRecall` results, confirm `investigate.log` shows `status=child-failed` **with a non-empty `stderr=` field** (not just the status/elapsed-ms that a bare log line gave before this fix). Revert the temporary change.

- [ ] **Step 4: Commit**
```bash
git add extensions/pi-mempalace/index.ts
git commit -m "feat(investigate): fail-open fallback to legacy selectRecall + investigate.log with real diagnostics"
```

---

### Task 5: Obsidian availability check + active failure alerting

**Added per design review (Critical Issues #2 and #9).** The original plan's
only observability was `investigate.log` — a passive log file. This exact
codebase already has a documented multi-week silent outage
(`index.ts:438-460`'s own comments: `recall-gate.log` recorded
`gate=FAILED(fell-closed)` on every prompt for weeks before anyone noticed)
caused by trusting a human to notice a log file. Task 4's log alone would
repeat that failure mode for the new path — and the plan's own self-review
flagged Obsidian-unavailability as "a real regression, not a graceful
degrade" while leaving it untested. Both close together here because they're
the same fix: an active check that surfaces consecutive failures/vault
blindness instead of relying on someone to grep a file.

**This task must land before Task 6** (which removes the only existing
automatic safety net) — shipping Task 6 first means worse observability
(no active check yet) stacked on top of a documented-as-unacceptable failure
mode (silent vault blindness) with nothing watching for either.

**Files:**
- Modify: `extensions/pi-mempalace/investigate.ts` (Task 2) — detect
  vault-blindness in the child's own response.
- Modify: `extensions/pi-mempalace/index.ts` — add a `session_start` scan of
  recent `investigate.log` entries, piggybacking on the pattern
  `session-watchdog.ts` already uses for its own pending-review notice (an
  injected system-prompt line, not a blocking check).

**Interfaces:**
- Consumes: `investigate.log`'s format from Task 4 Step 2.
- Produces: a `vault_reached: boolean` field added to `InvestigateVerdict`
  (Task 2) and logged (Task 4); a startup notice appended to
  `before_agent_start`'s system prompt when recent history shows a problem.

- [ ] **Step 1: Have the child self-report whether it actually reached Obsidian**

Add to Task 2's `buildChildPrompt()`, in the JSON schema instruction line:
```
{"confident": bool, "items": [...], "skills": [...], "options": [...], "vault_reached": bool}
```
And an explicit instruction line: `"Set vault_reached=true only if you actually got a response from the obsidian MCP tool (even an empty one) — false if the mcp tool errored, timed out, or you didn't call it."` Extend `parseVerdict` (Task 2 Step 3) and `InvestigateVerdict` (Task 2's interface block) to include `vault_reached: boolean` (default `false` if absent/malformed — fail toward "flag as blind", not toward "assume it worked").

- [ ] **Step 2: Log `vault_reached` and add a consecutive-failure/blindness scan**

Extend `logInvestigation` (Task 4 Step 2) to include `vault_reached=${verdict.vault_reached}` in the log line. Add a small reader function:

```typescript
function scanRecentInvestigateLog(maxLines = 20): { consecutiveFailures: number; consecutiveVaultBlind: number } {
  try {
    const lines = fs.readFileSync(INVESTIGATE_LOG, "utf8").trim().split("\n").slice(-maxLines).reverse();
    let consecutiveFailures = 0;
    let consecutiveVaultBlind = 0;
    for (const line of lines) {
      if (line.includes("status=child-failed")) { consecutiveFailures++; continue; }
      break; // any non-failure line ends the failure streak
    }
    for (const line of lines) {
      if (line.includes("status=ok") && line.includes("vault_reached=false")) { consecutiveVaultBlind++; continue; }
      if (line.includes("status=ok") && line.includes("vault_reached=true")) break; // a successful vault hit ends the streak
      if (!line.includes("status=ok")) continue; // failures don't count toward vault-blindness, only toward Step 1's separate counter
      break;
    }
    return { consecutiveFailures, consecutiveVaultBlind };
  } catch {
    return { consecutiveFailures: 0, consecutiveVaultBlind: 0 };
  }
}
```

- [ ] **Step 3: Surface an active notice, not just a log line**

In the `before_agent_start` handler (same one Task 6 Step 2 edits), before building `extra`:
```typescript
const { consecutiveFailures, consecutiveVaultBlind } = scanRecentInvestigateLog();
if (consecutiveFailures >= 3) {
  extra += `\n\n## memory_investigate degraded\nThe last ${consecutiveFailures} investigations failed and fell back to plain similarity search. Mention this to the user once, briefly — memory context may be lower quality than usual this session.\n`;
} else if (consecutiveVaultBlind >= 3) {
  extra += `\n\n## Obsidian vault unreachable\nThe last ${consecutiveVaultBlind} investigations could not reach the Obsidian vault (memory palace search still worked). Mention this to the user once — vault content (including project standing rules) is not being searched this session.\n`;
}
```
This is the "active check" the design review asked for: unlike a passive log file, it's impossible for the agent to have a degraded session without at least one mention to the user, without hard-blocking anything ("fail open, never block" preserved).

- [ ] **Step 4: Force both failure modes and verify the notice fires**
1. Repeat Task 4 Step 3's forced-failure test 3 times in a row (or manually append 3 `status=child-failed` lines to `investigate.log`) — confirm the degraded notice appears on the next `before_agent_start`.
2. Manually append 3 lines with `status=ok vault_reached=false` — confirm the vault-unreachable notice appears instead.
3. Append one `status=ok vault_reached=true` line after either streak — confirm the notice stops appearing (streak broken).

- [ ] **Step 5: Commit**
```bash
git add extensions/pi-mempalace/investigate.ts extensions/pi-mempalace/index.ts
git commit -m "feat(investigate): active degraded-session notice for consecutive failures / vault blindness"
```

---

### Task 6: Remove automatic auto-recall, add config gate, update system-prompt guidance

**Files:**
- Modify: `extensions/pi-mempalace/index.ts` — the `before_agent_start` handler's auto-recall block (the `if (runtime.config.autoRecall) { ... selectRecall ... }` section, ~lines 965-1013 per current file)
- Modify: `~/.pi/agent/memory/config.json` (live config, not repo-tracked) — add `investigateEnabled: true`

- [ ] **Step 1: Config-gate instead of delete**

Wrap the existing per-turn `selectRecall` + gate block:
```typescript
if (runtime.config.autoRecall && runtime.config.investigateEnabled !== true) {
  // ... existing block, unchanged ...
}
```
Default `investigateEnabled` to `true` in `defaultConfig` (near the other `autoRecallGate*` defaults) — so a fresh install gets the new behavior, and `investigateEnabled: false` in `~/.pi/agent/memory/config.json` is the one-line rollback to today's behavior.

- [ ] **Step 2: Update the static "Agent Memory (ACTIVE)" instruction block** (same `before_agent_start` handler, the `extra` string built earlier in the function) to mention `memory_investigate` and set the preference:

```typescript
let extra =
  "\n\n## Agent Memory (ACTIVE)\n" +
  "You have persistent memory across sessions.\n" +
  "Use `memory_investigate(query)` to gather relevant memory+vault context — call it on the " +
  "first substantive message of a session and whenever you need memory context; prefer it over " +
  "memory_search for context-gathering (memory_search is a fast raw similarity list; " +
  "memory_investigate is a judged, curated investigation with vault access).\n" +
  "Use `memory_save` to explicitly remember something important. " + // (keep existing lines for memory_recall/knowledge_add/etc unchanged)
  ...
```

- [ ] **Step 3: Restart pi, verify on a fresh session** that the first message triggers a `memory_investigate` call (not silent auto-recall) — check `investigate.log` gets an entry and `recall-gate.log` does NOT (confirms the old path is off).

- [ ] **Step 4: Commit**
```bash
git add extensions/pi-mempalace/index.ts
git commit -m "feat(investigate): config-gate legacy auto-recall behind investigateEnabled, update system-prompt guidance"
```

---

### Self-Review (per writing-plans convention — run before treating this plan as final)

**Spec coverage:** All 8 resolved decisions from the Design section map to a task — recursion guard (Task 1), spawn+await mechanism (Task 2), tool registration replacing auto-recall (Task 3+5), skills consolidation (Task 3 `promptGuidelines` + `skillsCatalog` param), no-queue-file ask flow (Task 3's `options` handling), judgment-based count (Task 2's schema has no cap), seeded prior-findings (Task 3 Step 1), fail-open safety net (Task 4).

**Resolved via design review (2026-07-30):** the two Critical issues raised — unscoped `mcp` access to internal/paid servers (fixed: Task 2 Step 2a generates and passes a filtered `--mcp-config`), and passive-log-only observability repeating a documented prior silent-outage pattern (fixed: new Task 5, landing before the old Task 5/now Task 6 that removes the existing safety net) — are both now addressed with dedicated tasks rather than deferred. The Important-severity gaps (`createRuntime()` field wiring, a type-union mismatch on `skillsCatalog`, no session-scoped rate ceiling, an imprecise precedent citation for async-spawn, a `confident:false`-with-no-options edge case, dropped stderr diagnostics) are fixed inline in Tasks 2–4 above, each marked with a "caught in design review" note at the exact line it touches.

## Explicitly out of scope for this change

- `memory_save`, `knowledge_add`, `knowledge_invalidate` — unchanged.
- `recall.ts` / `reranker.ts` / `bench/run-bench.mjs` — kept as the fail-open
  fallback path, not refactored.
- Rules/skill *injection* mechanics (`harness-rules.ts`, `pi-skill-gate`) —
  unchanged; the investigator only *names* skills, never re-emits rules.
