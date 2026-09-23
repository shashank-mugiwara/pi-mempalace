/**
 * session-watchdog.ts — pi extension for the cross-agent session watchdog
 * (cli/watchdog.mjs). Since 2026-09-23 it only registers the manual
 * /memory-watchdog command.
 *
 * Scheduling: launchd owns it (com.shashank.mempalace-watchdog, every 15 min,
 * installed by ~/Documents/GitHub/harness/install.sh). This extension used to
 * run its own 15-minute timer in every pi process as well; with launchd in
 * place that timer only ever lost the CLI's lock ("tick: lock held, skipping"
 * in watchdog.log), so it was removed and launchd is the single scheduler.
 *
 * The tick reads new dialogue from Claude Code / pi / codex / opencode
 * session stores, gates on worth-it (>=10KB new dialogue, 5 min quiet),
 * summarizes with Claude Haiku 4.5 (extended thinking "high") through an
 * isolated nested `claude -p`, and applies under the additive-auto /
 * destructive-queued policy.
 *
 * Review queue: surfaced once per session by the harness health canary
 * (harness/lib/health.mjs). This extension used to append its own "Memory
 * review pending" block on the first turn too — the same news twice, and a
 * system-prompt change after turn one that cost a prompt-cache miss — so that
 * notice was removed on 2026-09-23. Walk the queue with
 *   node ~/.pi/agent/pi-mempalace-fork/cli/watchdog.mjs review --json
 * and apply verdicts with `apply-review --approve <ids> --reject <ids>`.
 *
 * Manual control: /memory-watchdog [tick|status|review]
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FORK = join(homedir(), ".pi", "agent", "pi-mempalace-fork");
const WATCHDOG = join(FORK, "cli", "watchdog.mjs");

export default function (pi: ExtensionAPI) {
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
