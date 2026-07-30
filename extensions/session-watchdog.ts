/**
 * session-watchdog.ts — pi extension that schedules the cross-agent session
 * watchdog (cli/watchdog.mjs) and surfaces its review queue.
 *
 * Every 15 minutes (first run 2 minutes after session start) it spawns
 *   node <fork>/cli/watchdog.mjs tick
 * detached — the tick reads new dialogue from Claude Code / pi / codex /
 * opencode session stores, gates on worth-it (>=10KB new dialogue, 5 min
 * quiet), summarizes with gpt-5.6-terra via codex exec, and applies under
 * the additive-auto / destructive-queued policy. The CLI holds its own
 * cross-process lock, so multiple pi instances scheduling ticks is safe —
 * exactly one wins per interval.
 *
 * Review queue: when ~/.pi/agent/memory/watchdog-review.json has pending
 * items, a short instruction block is appended to the system prompt telling
 * the agent to walk the user through them with AskUserQuestion and apply the
 * verdicts via `watchdog.mjs apply-review`.
 *
 * Manual control: /memory-watchdog [tick|status|review]
 *
 * Kill switch: "watchdogEnabled": false in ~/.pi/agent/memory/config.json.
 */

import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FORK = join(homedir(), ".pi", "agent", "pi-mempalace-fork");
const WATCHDOG = join(FORK, "cli", "watchdog.mjs");
const REVIEW_PATH = join(homedir(), ".pi", "agent", "memory", "watchdog-review.json");
const CONFIG_PATH = join(homedir(), ".pi", "agent", "memory", "config.json");

const TICK_INTERVAL_MS = 15 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 2 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | undefined;
let firstTick: ReturnType<typeof setTimeout> | undefined;
let reviewNoticeShown = false;

function enabled(): boolean {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return cfg.watchdogEnabled !== false;
  } catch {
    return true;
  }
}

function pendingReviewCount(): number {
  try {
    const items = JSON.parse(readFileSync(REVIEW_PATH, "utf8"));
    return Array.isArray(items) ? items.length : 0;
  } catch {
    return 0;
  }
}

function spawnTick() {
  if (!enabled()) return;
  try {
    const child = spawn("node", [WATCHDOG, "tick"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  } catch {
    /* scheduling must never break the session */
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    if (timer) return; // one scheduler per process, however many sessions
    firstTick = setTimeout(spawnTick, FIRST_TICK_DELAY_MS);
    timer = setInterval(spawnTick, TICK_INTERVAL_MS);
  });

  pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer);
    if (firstTick) clearTimeout(firstTick);
    timer = undefined;
    firstTick = undefined;
  });

  pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
    const pending = pendingReviewCount();
    if (pending === 0 || reviewNoticeShown) return;
    reviewNoticeShown = true;
    // Playbook items (docs/design/watchdog-playbook.md, Task 3) get a
    // different treatment from everything else: the live agent tries its own
    // judgment first (it has vault-write competence apply.mjs deliberately
    // doesn't), and only falls back to asking the user if it's itself unsure.
    // Trust-boundary note: this is a genuinely new class of write for this
    // codebase (LLM-inferred, LLM-approved, LLM-committed, human never in the
    // loop by default) — the audit log + unconditional user notice below are
    // required mitigations, not optional polish.
    const extra =
      `\n\n## Memory review pending (session-watchdog)\n` +
      `${pending} curation item(s) from the background session-watchdog await review. List them with ` +
      `\`node ${WATCHDOG} review --json\`.\n\n` +
      `For items with kind "playbook": these are procedural findings (command preferences, file/skill ` +
      `locations, prompt phrasings that worked). Use YOUR OWN judgment first:\n` +
      `- "location" or "command" entries are informational — they belong in the project's Obsidian HUB NOTE ` +
      `(Projects/<Project>/<Project>.md), never in Rules.md.\n` +
      `- "prompt-phrasing" entries are behavior-shaping — they belong in the project's Rules.md ONLY if you ` +
      `are confident they generalize; Rules.md is injected verbatim on every single turn, so a low-confidence ` +
      `guess there is far more costly than one in a hub note. If unsure which file, default to the hub note.\n` +
      `- Append a line to \`~/.pi/agent/memory/playbook-vault.log\` (timestamp, project, file, one-line summary) ` +
      `for every vault write you make this way — required, not optional, since this write path has no human ` +
      `in the loop by default.\n` +
      `- ALWAYS tell the user, in your normal response, what you just added and where ("I added <X> to ` +
      `<file> based on a session-watchdog finding") — unconditionally, not only when you're unsure.\n` +
      `Then run \`node ${WATCHDOG} apply-review --approve <id>\` to clear it from the queue. Use AskUserQuestion ` +
      `instead of writing it yourself if you are genuinely unsure where it belongs or whether it's accurate.\n\n` +
      `For every other kind (destructive changes, lessons, doubts): never auto-apply. At the next natural ` +
      `pause — not mid-task — walk the user through each with the AskUserQuestion tool (one item per ` +
      `question: show the evidence, recommend accept or reject), then run ` +
      `\`node ${WATCHDOG} apply-review --approve <ids> --reject <ids>\`.\n`;
    return { systemPrompt: event.systemPrompt + extra };
  });

  pi.registerCommand("memory-watchdog", {
    description: "Session watchdog: tick | status | review (default: status)",
    handler: async (args: string | undefined, _ctx: unknown) => {
      const sub = (args || "status").trim().split(/\s+/)[0];
      const allowed = ["tick", "status", "review"];
      const cmd = allowed.includes(sub) ? sub : "status";
      try {
        const out = execFileSync("node", [WATCHDOG, cmd], {
          encoding: "utf8",
          timeout: cmd === "tick" ? 20 * 60 * 1000 : 30_000,
        });
        return out.trim() || "(no output)";
      } catch (e: unknown) {
        return `watchdog ${cmd} failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });
}
