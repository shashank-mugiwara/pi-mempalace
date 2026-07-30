# Watchdog `playbook` extraction — design and implementation plan

Locked via interview with Shashank on 2026-07-30. Extends `session-watchdog`'s
existing curation pipeline; does not create a second pipeline.

## Problem

Watchdog already extracts `memories` (facts), `lessons` (mistakes with a
generalisable trigger, always human-queued), `kg_facts`, `supersedes`,
`kg_invalidations`, and `doubts`. It has no category for *procedural*
knowledge: which commands were fast vs. slow (`fffind` vs `find`), where a
skill/file actually lives, what prompt phrasing worked or failed for a given
kind of task. Nothing surfaces this automatically on turn 1 of the next
session on the same project.

## Resolved decisions

1. **One pipeline, not two.** Extends `watchdog/summarize.mjs` +
   `watchdog/apply.mjs`. `memory-summarizer.ts`'s own (currently disabled)
   session-based path stays disabled — reviving it would re-fragment the
   2026-07-20 consolidation ("watchdog now owns automatic summarization for
   ALL agents' sessions, including pi's").
2. **New extraction category `playbook`**, schema per entry:
   ```
   { content: str, project: str, kind: "command"|"location"|"prompt-phrasing"|"other",
     destination: "memory"|"vault"|"both"|"unsure", evidence: str, confidence: "high"|"low" }
   ```
3. **Apply policy, by `kind` and `destination`:**
   - `kind: "command"|"location"`, `destination: "memory"`, high confidence →
     auto-applied by `apply.mjs`, same as plain `memories` today (topic
     `playbook`, importance capped 0.85, near-dup guarded).
   - `kind: "prompt-phrasing"|"other"` → **always queued**, same rationale as
     `lessons`: being wrong about behavior guidance is worse than being wrong
     about a fact.
   - `destination: "vault"|"both"|"unsure"` → **always queued**, regardless
     of `kind`/confidence. `apply.mjs` has zero filesystem access to the
     Obsidian vault (verified: it only ever calls `store.store()` /
     `store.addTriple()` / `store.delete()` — no `fs.writeFileSync` anywhere
     in the file) and no LLMWiki-frontmatter/git-commit discipline. Vault
     writes need the *live* agent, which already has that discipline via the
     standing rules injected every session.
4. **"Ask back the agent, not the human, first."** The queued
   `playbook-vault` item flows through the existing `before_agent_start`
   review-instruction mechanism (`session-watchdog.ts`'s pending-review
   check). New behavior there: the live agent is told to use its *own*
   judgment first — write the memory-side copy and, if it agrees the entry is
   durable, the vault note too (using the existing "durable decisions go to
   both layers" convention it already knows) — and only fall back to
   `ask_user_question` when it is *itself* uncertain. This differs from
   `lesson`/`doubt` items today, which go straight to the human.
5. **Delivery on turn 1:** memory-side copy lands under topic `playbook`, one
   per project, superseded not appended — identical convention to
   `session-resume`, injected at the same `wakeup()` slot in
   `memory_store.ts`.

## Why this isn't scope creep on `memory_investigate`

The two designs share a fork (`pi-mempalace-fork`) but touch disjoint code:
`memory_investigate` is pull (agent asks for context, live session,
TypeScript extension); `playbook` is push (watchdog infers and stages
content, background process, `.mjs` CLI). **Correction (design review,
2026-07-30): they share no code surface at all**, not even `wakeup()` —
`memory_investigate`'s implementation plan touches only
`extensions/pi-mempalace/index.ts` and a new `investigate.ts`; it never
modifies `memory_store.ts` and replaces the `before_agent_start` auto-recall
block, a different mechanism entirely. Only `playbook`'s Task 4 touches
`wakeup()`. The "no ordering dependency" conclusion still holds, but because
the two plans simply don't intersect, not because they safely share a slot.

---

## Implementation Plan

**Goal:** Watchdog proposes procedural/efficiency knowledge per project;
factual entries auto-apply to memory, vault-bound entries are staged for the
live agent to apply with its own judgment, and everything is available on
turn 1 of the next session via the same deterministic slot as
`session-resume`.

**Architecture:** Extend `summarize.mjs`'s prompt and JSON schema, extend
`apply.mjs`'s per-category dispatch, extend `session-watchdog.ts`'s review
notice text, add a `latestPlaybook()` reader to `memory_store.ts` alongside
the existing `latestResume()`.

**Tech Stack:** Existing watchdog stack only (`codex exec` / `gpt-5.6-terra`,
plain node, `better-sqlite3` via `memory_store.ts`). No new dependencies.

## Global Constraints

- `apply.mjs` must never gain filesystem write access to the vault — that
  would violate decision #3/#4 and reintroduce the exact competence gap this
  design routes around.
- `playbook` topic entries follow the same near-duplicate guard
  (`DUP_SIMILARITY = 0.92`) and importance cap (`AUTO_IMPORTANCE_CAP = 0.85`)
  as plain memories — no separate constant, reuse `apply.mjs`'s existing
  ones.
- The `playbook` wakeup slot must degrade the same way `latestResume()` does
  on any error: `try { ... } catch { return null; }` — wake-up context is
  best-effort and must never block session start.

---

### Task 1: Extend `summarize.mjs`'s prompt + schema

**Files:**
- Modify: `watchdog/summarize.mjs:buildPrompt()` (currently ends around the
  "Output — STRICT JSON only" block, ~line 200 in the current file)

**Interfaces:**
- Produces: `result.playbook: Array<{content, project, kind, destination, evidence, confidence}>`
  — consumed by Task 2 (`apply.mjs`).

- [ ] **Step 1: Add a `## Playbook (procedural / efficiency knowledge)` section to the prompt**, inserted after the existing "## Lessons" section and before "## Output":

```javascript
// Insert into the template literal returned by buildPrompt(), after the
// "## Lessons ..." block and before "## Output — STRICT JSON only:":
`
## Playbook (how to work efficiently in this project)

Separate from lessons (which record reasoning failures) and memories (which
record facts). A playbook entry records a PROCEDURE: a command that was
faster than the obvious alternative, where a file/skill actually lives (not
where you'd guess), or a way of phrasing a request that got a better result
than the first phrasing tried.

Qualifying evidence — extract ONLY from things that actually happened in this
transcript, never from general knowledge:
- A command was tried, and a faster/better alternative was used afterward
  (e.g. switched from find to fffind, from grep to ffgrep).
- A file or skill's real location differed from where it was first looked
  for.
- A prompt/request was rephrased and the rephrasing visibly worked better.

NOT playbook entries: one-off facts with no procedural value, anything
already covered by a lesson or an ordinary memory, speculation about what
MIGHT be faster.

For each entry, classify BOTH:
- kind: "command" (a CLI invocation or tool preference) | "location" (where
  something lives) | "prompt-phrasing" (a request phrasing that worked) |
  "other"
- destination: "memory" (session-scoped procedural fact, fine to auto-apply)
  | "vault" (durable enough to belong in the project's standing rules/hub
  note, alongside human-curated content) | "both" | "unsure" (you cannot
  tell — let the destination be decided downstream, not guessed here)

If nothing in this transcript qualifies, return an empty array — that is
correct far more often than not.
`
```

- [ ] **Step 2: Add `playbook` to the output JSON schema line** (same object literal as `memories`/`lessons`/etc.):

```javascript
"playbook": [{"content": str, "project": str, "kind": "command"|"location"|"prompt-phrasing"|"other", "destination": "memory"|"vault"|"both"|"unsure", "evidence": str, "confidence": "high"|"low"}],
```

- [ ] **Step 3: Add `playbook` to `normalize()`** (bottom of `summarize.mjs`, alongside the existing `memories`/`kg_facts`/etc. array coercions):

```javascript
function normalize(o) {
  return {
    memories: Array.isArray(o.memories) ? o.memories : [],
    playbook: Array.isArray(o.playbook) ? o.playbook : [],
    kg_facts: Array.isArray(o.kg_facts) ? o.kg_facts : [],
    supersedes: Array.isArray(o.supersedes) ? o.supersedes : [],
    kg_invalidations: Array.isArray(o.kg_invalidations) ? o.kg_invalidations : [],
    doubts: Array.isArray(o.doubts) ? o.doubts : [],
  };
}
```

- [ ] **Step 4: Smoke test the prompt in isolation**

```bash
node -e '
import("./watchdog/summarize.mjs").then((m) => {
  const fakeCandidate = { source: "pi", project: "pi-config", cwd: "~/.pi/agent",
    text: "User: use fffind instead of find, it is way faster in this repo.\nAgent: Noted, switching to fffind for path lookups." };
  const ctx = { memories: [], kg: [], obsidian: "", projects: { "pi-config": 10 }, rejections: [] };
  console.log(m.buildPrompt(fakeCandidate, ctx));
});'
```
Expected: prompt text includes the new Playbook section and the schema line. Read it end to end once — this is the exact prompt `gpt-5.6-terra` will see, worth eyeballing for clarity before wiring it up live.

- [ ] **Step 5: Commit**
```bash
git add watchdog/summarize.mjs
git commit -m "feat(watchdog): add playbook extraction category to summarizer prompt+schema"
```

---

### Task 2: Extend `apply.mjs`'s dispatch

**Files:**
- Modify: `watchdog/apply.mjs` — add a `playbook` loop after the existing `lessons` loop (~line 65-85 in the current file), reusing `cleanTopic`, `isNearDuplicate`, `AUTO_IMPORTANCE_CAP`, `queueReview` already imported/defined there.

**Interfaces:**
- Consumes: `result.playbook` from Task 1.
- Produces: `counts.playbook_saved`, `counts.playbook_queued` (extend the existing `counts` object returned by `applyResult`).

- [ ] **Step 1: Add the dispatch loop**

```javascript
// counts object at the top of applyResult — add two fields:
const counts = { saved: 0, kg_added: 0, superseded: 0, kg_invalidated: 0, queued: 0, dup_skipped: 0, playbook_saved: 0, playbook_queued: 0 };

// ... after the existing `for (const l of result.lessons || [])` loop ...

for (const p of result.playbook || []) {
  if (!p?.content || typeof p.content !== "string") continue;
  if (!p?.kind || !p?.destination) continue; // both required to route correctly
  const project = canonicalProject(p.project || candidate.project, projects);

  const needsVaultRoute = p.destination === "vault" || p.destination === "both" || p.destination === "unsure";
  const isFactual = p.kind === "command" || p.kind === "location";

  if (needsVaultRoute || !isFactual) {
    // Either vault-bound (apply.mjs cannot write vault — see design doc §3)
    // or behavior-shaping (prompt-phrasing/other — same risk class as lessons).
    if (await isNearDuplicate(store, p.content)) { counts.dup_skipped++; continue; }
    queueReview(
      reviewItems,
      "playbook",
      {
        content: p.content.trim(),
        project,
        topic: "playbook",
        kind: p.kind,
        destination: p.destination,
        importance: 0.7,
        confidence: p.confidence || "low",
      },
      p.evidence || "",
      candidate.key
    );
    counts.playbook_queued++;
    continue;
  }

  // kind is command|location, destination is memory — Decision #3 requires
  // HIGH confidence to auto-apply. A low-confidence factual guess is exactly
  // the unreviewed-write failure mode the 0.3.0 cleanup (4,585/5,527 memories,
  // 83% noise, CHANGELOG-FORK.md) already burned a cycle fixing — do not
  // repeat it here. (Caught in design review: the original draft of this
  // loop ignored confidence entirely and auto-applied low-confidence entries
  // too, on the false premise that plain `memories` "also ignore confidence"
  // — they don't have a confidence field to ignore in the first place.)
  if (p.confidence !== "high") {
    if (await isNearDuplicate(store, p.content)) { counts.dup_skipped++; continue; }
    queueReview(
      reviewItems,
      "playbook",
      { content: p.content.trim(), project, topic: "playbook", kind: p.kind, destination: p.destination, importance: 0.6, confidence: "low" },
      p.evidence || "",
      candidate.key
    );
    counts.playbook_queued++;
    continue;
  }
  if (await isNearDuplicate(store, p.content)) { counts.dup_skipped++; continue; }
  if (!dry) {
    // Supersede, don't accumulate: one `playbook` memory per project, same
    // discipline as `session-resume` (PROTOCOL.md). Without this, every
    // qualifying tick adds a new row forever — near-dup guard (0.92) only
    // catches near-verbatim repeats, not differently-worded restatements of
    // the same procedural fact, so the store would slowly refill with the
    // exact noise pattern 0.3.0 already cleaned up. (Caught in design
    // review — flagged as an open question in the original draft; it isn't
    // actually ambiguous, session-resume's convention is a direct precedent.)
    try {
      const prior = store.db
        .prepare(`SELECT id FROM memories WHERE project = ? AND topic = 'playbook' ORDER BY timestamp DESC LIMIT 1`)
        .get(project);
      if (prior?.id) store.delete(prior.id);
    } catch { /* best-effort supersede; a missed delete just leaves one extra row, never fatal */ }
    await store.store({
      content: p.content.trim(),
      project,
      topic: "playbook",
      source: `session-watchdog:${candidate.source}`,
      importance: Math.min(0.7, AUTO_IMPORTANCE_CAP),
    });
  }
  counts.playbook_saved++;
}
```

**Note on `store.db` access above:** verify `MemoryStore` exposes `db` as a
public/accessible property from `apply.mjs`'s call site before implementing
— if it's private, add a small `store.supersedeTopic(project, topic)` helper
to `memory_store.ts` instead of reaching into internals from `apply.mjs`.

- [ ] **Step 2: Extend `cli/watchdog.mjs`'s `cmdApplyReview`** to handle the `"playbook"` kind when a human approves one directly from the CLI (the live-agent-first path from Task 3 is the common case, but a human running `apply-review` manually must not hit the silent "no mechanical action" branch other unhandled kinds fall into):

```javascript
// In cmdApplyReview's per-item switch, alongside the existing
// "supersede"/"lesson"/"kg_invalidate" branches:
} else if (item.kind === "playbook") {
  const p = item.payload;
  await store.store({
    content: p.content.trim(),
    project: p.project || "general",
    topic: "playbook",
    source: "session-watchdog:playbook-approved",
    importance: Number(p.importance) || 0.7,
  });
  // Vault write is NOT done here — apply-review is a human/CLI path with no
  // vault-write competence either. If destination includes "vault", the
  // human (or the live agent, per Task 3) writes the note by hand/tool.
}
```

- [ ] **Step 3: Wire the new counts into `cmdTick`'s summary line** — without this, Step 4's smoke test verifies nothing. (Caught in design review: the original draft's smoke test assumed the counts would just show up; `cmdTick`'s summary template in `cli/watchdog.mjs` hardcodes its field list and the `--dry-run` branch prints the model's raw `result.playbook` array, not post-apply `counts`, so neither path surfaces the new fields without this edit.)

Find the summary template string in `cmdTick` (`cli/watchdog.mjs`, the line building `saved ${counts.saved}, kg+${counts.kg_added}, superseded ${counts.superseded}, kg-inv ${counts.kg_invalidated}, queued ${counts.queued}, dup-skip ${counts.dup_skipped} ...`) and extend it:

```javascript
const summary = `saved ${counts.saved}, playbook+${counts.playbook_saved}, kg+${counts.kg_added}, ` +
  `superseded ${counts.superseded}, kg-inv ${counts.kg_invalidated}, queued ${counts.queued + counts.playbook_queued}, ` +
  `dup-skip ${counts.dup_skipped} ...`; // keep whatever trailing content the existing template already has
```

- [ ] **Step 4: Smoke test with `--dry-run`**

```bash
node cli/watchdog.mjs tick --dry-run
```
Run against a real recent session containing a command-preference or location correction. Confirm `playbook_saved`/`playbook_queued` counts appear in the tick's printed summary (not just in the in-memory `counts` object) and that no store writes actually happen (dry-run).

- [ ] **Step 5: Commit**
```bash
git add watchdog/apply.mjs cli/watchdog.mjs
git commit -m "feat(watchdog): dispatch playbook entries — auto-apply factual/memory, queue the rest"
```

---

### Task 3: Live-agent-first review notice for `playbook-vault` items

**Trust-boundary note (added per design review):** this is a genuinely new
class of write for this codebase, not a small extension of an existing one.
Today's autonomous-write precedent (harness standing-rules updates) fires on
an explicit, in-the-moment human instruction and quotes that exact
instruction as its justification. This task instead lets a background LLM
(`gpt-5.6-terra`, no human in the loop) infer a claim from a days-old
transcript, then has the *live* agent write it to the vault and self-approve
(`apply-review --approve <id>`) on its own judgment alone — the human is
never shown it unless the agent itself is unsure. Two mitigations below are
now REQUIRED, not optional, to keep this from being a silent trust-boundary
expansion: (a) every autonomous vault write logs to `playbook-vault.log`
(Step 1b), mirroring `investigate.log`'s convention from the sibling design;
(b) the live agent always surfaces a one-line "I just added X to the vault
based on session-watchdog's finding" notice to the user, unconditionally —
not gated on the agent's own uncertainty as originally drafted.

**Files:**
- Modify: `pi-mempalace-fork/extensions/session-watchdog.ts` (confirmed the
  real file — `~/.pi/agent/extensions/session-watchdog.ts` is a one-line
  re-export shim: `export { default } from "../pi-mempalace-fork/extensions/session-watchdog.ts";`.
  Edit the fork's copy; the shim needs no change.) — extend the `pending`
  notice text.

**Interfaces:**
- Consumes: `watchdog-review.json` items with `kind: "playbook"` and `payload.destination !== "memory"` (Task 2 already routes these there).

- [ ] **Step 1: Extend the review-notice text to give the agent first crack at vault-bound playbook items**

Current code (`session-watchdog.ts`, `before_agent_start` handler):
```typescript
pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
  const pending = pendingReviewCount();
  if (pending === 0 || reviewNoticeShown) return;
  reviewNoticeShown = true;
  const extra =
    `\n\n## Memory review pending (session-watchdog)\n` +
    `${pending} curation item(s) from the background session-watchdog await the user's verdict ` +
    `(destructive changes and doubts are never auto-applied). At the next natural pause — not mid-task — ` +
    `list them with \`node ${WATCHDOG} review --json\`, walk the user through each with the AskUserQuestion tool ` +
    `(one item per question: show the evidence, recommend accept or reject), then run ` +
    `\`node ${WATCHDOG} apply-review --approve <ids> --reject <ids>\`.\n`;
  return { systemPrompt: event.systemPrompt + extra };
});
```

Replace with a version that distinguishes `playbook` items from the rest, gives an explicit hub-note-vs-Rules.md routing rule (added per design review — the original draft's "follow this project's standing-rules conventions" gave the agent no criterion for which of two differently-injected files to touch), and always surfaces a user-visible notice for autonomous vault writes:

```typescript
pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
  const pending = pendingReviewCount();
  if (pending === 0 || reviewNoticeShown) return;
  reviewNoticeShown = true;
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
```

- [ ] **Step 2: Manual end-to-end test**

1. Manually append a fake `playbook` item to `~/.pi/agent/memory/watchdog-review.json`:
   ```json
   [{"id": "test-pb-1", "kind": "playbook", "payload": {"content": "This repo's tests run via `node harness/evals/run.mjs`, not `npm test`.", "project": "harness", "topic": "playbook", "kind": "command", "destination": "both", "importance": 0.7, "confidence": "high"}, "evidence": "user corrected the test command mid-session", "sessionKey": "manual-test", "created": "2026-07-30T00:00:00Z"}]
   ```
2. Start a fresh `pi` session in this repo.
3. Confirm the injected notice appears and the agent, unprompted, either writes the vault note + runs `apply-review --approve test-pb-1` (if confident) or asks via `ask_user_question` (if it judges itself unsure) — either behavior is a pass, silent inaction is a fail.

- [ ] **Step 3: Commit**
```bash
git add ~/.pi/agent/extensions/session-watchdog.ts
git commit -m "feat(watchdog): playbook items get live-agent-first review notice, not human-first"
```
(Already resolved above — see the trust-boundary note at the top of this task.)

---

### Task 4: `latestPlaybook()` wakeup slot

**Files:**
- Modify: `extensions/pi-mempalace/memory_store.ts` — add `latestPlaybook()` alongside the existing `latestResume()` (~line 1034-1071), call it from `wakeup()` (~line 1020, right after the `latestResume` call).

**Interfaces:**
- Consumes: nothing new (same `this.db` prepared-statement pattern as `latestResume()`).
- Produces: a new paragraph in the `wakeup()` output, gated on `topic = 'playbook'` instead of `topic = 'session-resume'`.

- [ ] **Step 1: Add `latestPlaybook()`**, modeled directly on `latestResume()`:

```typescript
/**
 * Most recent `playbook` memory for `project` — procedural/efficiency
 * knowledge (fast commands, file/skill locations, prompt phrasings that
 * worked), written by session-watchdog's playbook extraction. Same
 * one-per-project, superseded-not-appended convention as session-resume.
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
```

Note: unlike `session-resume`, playbook entries are NOT chunked (Task 2's `store.store()` call has no `parent_id`/chunk logic — a single procedural note is short), and there may be MULTIPLE `playbook` memories per project over time (each `apply.mjs` tick can add a new one; there's no supersede step in Task 2's auto-apply path). Decide in review: should Task 2 also supersede the prior `playbook` memory for the same project (true one-per-project), or is `ORDER BY timestamp DESC LIMIT 1` (latest wins, older ones remain searchable via `memory_search` but not surfaced at wakeup) sufficient? Flagging as an open question rather than guessing.

- [ ] **Step 2: Wire into `wakeup()`**

```typescript
// In wakeup(), right after:
const resume = this.latestResume(project);
if (resume) parts.push(resume);
// Add:
const playbook = this.latestPlaybook(project);
if (playbook) parts.push(playbook);
```

- [ ] **Step 3: Smoke test**

```bash
node -e '
import("./extensions/pi-mempalace/memory_store.js").then(async (m) => {
  const store = new m.MemoryStore();
  await store.store({ content: "Use fffind not find in this repo — much faster on the indexed workspace.", project: "harness", topic: "playbook", source: "test", importance: 0.7 });
  console.log(store.wakeup({ project: "harness" }).text);
});'
```
Expected: output includes the new "How to work efficiently on harness" section with the stored content.

- [ ] **Step 4: Commit**
```bash
git add extensions/pi-mempalace/memory_store.ts
git commit -m "feat(watchdog): latestPlaybook() wakeup slot, mirrors latestResume() convention"
```

---

### Self-Review

**Spec coverage:** All 5 resolved decisions map to a task — one pipeline (Task 1, extends not replaces `summarize.mjs`), apply policy by kind/destination (Task 2), live-agent-first for vault-bound items (Task 3), turn-1 delivery (Task 4).

**Resolved via design review (2026-07-30):** Task 4 Step 1's chunking/supersede question is closed — Task 2's auto-apply branch now supersedes the prior `topic='playbook'` row for the same project on every write, matching `session-resume`'s discipline exactly. No accumulation.

**Also fixed via design review:** Task 2's auto-apply branch previously ignored the `confidence` field entirely, contradicting Decision #3's explicit "high confidence" requirement — corrected to queue low-confidence factual entries instead of auto-applying them. Task 2's smoke test previously couldn't have verified anything (the counts it checks for were never wired into any printed output) — fixed with an explicit step editing `cmdTick`'s summary template. Task 3 now requires an audit log and an unconditional user-facing notice for autonomous vault writes, and gives an explicit hub-note-vs-Rules.md routing rule instead of "use your judgment." The "shared surface with memory_investigate" claim in this doc's opening section was factually wrong (the two designs share no code surface at all, not `wakeup()` as claimed) and has been corrected.

**Type consistency check:** `apply.mjs`'s `applyResult` signature (`store, candidate, result, reviewItems, opts`) is unchanged by Task 2 — only the loop body and `counts` object grow. `queueReview`'s signature (`reviewItems, kind, payload, evidence, sessionKey`) matches how Task 2 calls it, consistent with the existing `lesson`/`supersede`/`doubt` call sites in the same file.
