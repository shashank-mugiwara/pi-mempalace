/**
 * apply-review.test.mjs — the review-queue write path and its fences.
 *
 *   node --test watchdog/apply-review.test.mjs
 *
 * Runs entirely in a temp MEMPALACE_HOME (WATCHDOG_TEST_TMP or the OS temp
 * dir); the guard below aborts before any test if the store modules resolved
 * to anything else, because the lock tests create and break watchdog.lock and
 * the live one belongs to the launchd tick.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, utimesSync, statSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "cli", "watchdog.mjs");
const PALACE_CLI = join(HERE, "..", "cli", "mempalace.mjs");
const BASE = process.env.WATCHDOG_TEST_TMP || tmpdir();
const HOME = mkdtempSync(join(BASE, "wd-test-"));
process.env.MEMPALACE_HOME = HOME; // before any repo module is imported

const state = await import("./state.mjs");
const { applyReviewItems, sweepQueue } = await import("./review.mjs");
const { looksLikeCostFigure, resolveProject, applyDemotion } = await import("./apply.mjs");
const { canonicalProject } = await import("./summarize.mjs");

assert.equal(state.MEM_HOME, HOME, "store modules must resolve to the temp MEMPALACE_HOME");

test.after(() => {
  if (process.env.WATCHDOG_TEST_KEEP !== "1") rmSync(HOME, { recursive: true, force: true });
});

const PROJECTS = { harness: 72, StandardSpec: 21, standardspec: 2 };

function item(id, kind, payload, created = "2026-09-20T00:00:00.000Z") {
  return { id, kind, payload, evidence: "", sessionKey: "test", created };
}

/** In-memory stand-in for MemoryStore with the methods review.mjs calls. */
function fakeStore({ existing = [], failStore = false, dupOf = null, failHas = false } = {}) {
  const ids = new Set(existing);
  const calls = [];
  const family = (id) => String(id).replace(/_c\d+$/, "");
  return {
    calls,
    async store(input) {
      calls.push(["store", input]);
      if (failStore) throw new Error("embedding model unavailable");
      if (dupOf) return { status: "duplicate", id: dupOf };
      const id = `mem_new${calls.length}`;
      ids.add(id);
      return { status: "stored", id };
    },
    delete(id) {
      calls.push(["delete", id]);
      const matches = [...ids].filter((x) => family(x) === family(id));
      if (!matches.length) throw new Error(`Memory not found: ${id}`);
      for (const m of matches) ids.delete(m);
      return { status: "deleted", id };
    },
    has(id) {
      if (failHas) throw new Error("database is locked");
      return ids.has(id);
    },
    setImportance(id, importance) {
      calls.push(["setImportance", id, importance]);
      return { updated: 1 };
    },
    findTriple() {
      calls.push(["findTriple"]);
      return 7;
    },
    invalidateTriple(id) {
      calls.push(["invalidateTriple", id]);
    },
    addTriple(t) {
      calls.push(["addTriple", t]);
    },
    exists: (id) => [...ids].some((x) => family(x) === family(id)),
  };
}

const kinds = (store) => store.calls.map((c) => c[0]);

// ---------------------------------------------------------------------------
// 2. supersede: save first, delete second, never the replacement's own family
// ---------------------------------------------------------------------------

test("supersede saves the replacement before deleting the target", async () => {
  const s = fakeStore({ existing: ["mem_target"] });
  const r = await applyReviewItems(
    s,
    [item("rev_a", "supersede", { forget_memory_id: "mem_target", replacement_content: "new fact", project: "harness", topic: "decisions" })],
    { approve: ["rev_a"], projects: PROJECTS }
  );
  assert.deepEqual(kinds(s), ["store", "delete"]);
  assert.equal(s.exists("mem_target"), false);
  assert.equal(r.counts.applied, 1);
  assert.deepEqual(r.keep, []);
});

test("a failed save leaves the target in place and the item queued", async () => {
  const s = fakeStore({ existing: ["mem_target"], failStore: true });
  const r = await applyReviewItems(
    s,
    [item("rev_a", "supersede", { forget_memory_id: "mem_target", replacement_content: "new fact", project: "harness" })],
    { approve: ["rev_a"], projects: PROJECTS }
  );
  assert.ok(!kinds(s).includes("delete"), "nothing may be deleted when the save failed");
  assert.equal(s.exists("mem_target"), true);
  assert.equal(r.counts.failed, 1);
  assert.deepEqual(r.keep.map((i) => i.id), ["rev_a"]);
});

test("a duplicate save that resolves to the target's own family deletes nothing", async () => {
  const s = fakeStore({ existing: ["mem_target_c0", "mem_target_c1"], dupOf: "mem_target_c0" });
  const r = await applyReviewItems(
    s,
    [item("rev_a", "supersede", { forget_memory_id: "mem_target", replacement_content: "same content", project: "harness" })],
    { approve: ["rev_a"], projects: PROJECTS }
  );
  assert.ok(!kinds(s).includes("delete"));
  assert.equal(s.exists("mem_target"), true);
  assert.equal(r.counts.applied, 1);
});

test("a target already removed by store() counts as applied", async () => {
  const s = fakeStore({ existing: [] });
  const r = await applyReviewItems(
    s,
    [item("rev_a", "supersede", { forget_memory_id: "mem_gone", replacement_content: "resume v2", project: "harness", topic: "session-resume" })],
    { approve: ["rev_a"], projects: PROJECTS }
  );
  assert.equal(r.counts.applied, 1);
  assert.match(r.messages[0].text, /already gone/);
});

test("merge deletes originals only after its save, and never its own family", async () => {
  const ok = fakeStore({ existing: ["mem_a", "mem_b"], dupOf: "mem_a" });
  await applyReviewItems(
    ok,
    [item("rev_m", "merge", { forget_memory_ids: ["mem_a", "mem_b"], replacement_content: "merged", project: "harness" })],
    { approve: ["rev_m"], projects: PROJECTS }
  );
  assert.deepEqual(ok.calls.filter((c) => c[0] === "delete").map((c) => c[1]), ["mem_b"]);

  const failing = fakeStore({ existing: ["mem_a", "mem_b"], failStore: true });
  const r = await applyReviewItems(
    failing,
    [item("rev_m", "merge", { forget_memory_ids: ["mem_a", "mem_b"], replacement_content: "merged", project: "harness" })],
    { approve: ["rev_m"], projects: PROJECTS }
  );
  assert.ok(!kinds(failing).includes("delete"));
  assert.equal(r.counts.failed, 1);
});

// ---------------------------------------------------------------------------
// 3. project resolution: refused items stay queued, nothing goes to general
// ---------------------------------------------------------------------------

test("items whose project does not resolve are refused, kept, and write nothing", async () => {
  const s = fakeStore({ existing: ["mem_t"] });
  const queue = [
    item("rev_1", "supersede", { forget_memory_id: "mem_t", replacement_content: "x", project: "Documents" }),
    item("rev_2", "lesson", { content: "y", trigger: "when z", project: "general" }),
    item("rev_3", "playbook", { content: "p", project: "" }),
    item("rev_4", "merge", { forget_memory_ids: ["mem_t"], replacement_content: "m", project: "tmp" }),
    item("rev_5", "kg_invalidate", { subject: "a", predicate: "uses", object: "b", replacement: { subject: "a", predicate: "uses", object: "c", project: "Desktop" } }),
  ];
  const r = await applyReviewItems(s, queue, { approve: queue.map((i) => i.id), projects: PROJECTS });
  assert.equal(r.counts.refused, 5);
  assert.deepEqual(r.keep.map((i) => i.id), queue.map((i) => i.id));
  assert.deepEqual(s.calls, [], "a refused item must not invalidate, store or delete anything");
  assert.equal(s.exists("mem_t"), true);
});

test("case variants resolve to the variant holding the most memories", async () => {
  assert.equal(canonicalProject("standardspec", PROJECTS), "StandardSpec");
  assert.equal(resolveProject("standardspec", null, PROJECTS), "StandardSpec");
  const s = fakeStore();
  await applyReviewItems(s, [item("rev_l", "lesson", { content: "c", trigger: "when t", project: "standardspec" })], { approve: ["rev_l"], projects: PROJECTS });
  assert.equal(s.calls[0][1].project, "StandardSpec");
});

test("rejections are returned for recording and unnamed items stay", async () => {
  const s = fakeStore();
  const queue = [item("rev_r", "lesson", { content: "c", trigger: "t", project: "harness" }), item("rev_k", "doubt", { question: "q?" })];
  const r = await applyReviewItems(s, queue, { reject: ["rev_r"], projects: PROJECTS });
  assert.deepEqual(r.rejected.map((i) => i.id), ["rev_r"]);
  assert.deepEqual(r.keep.map((i) => i.id), ["rev_k"]);
  assert.deepEqual(s.calls, []);
});

// ---------------------------------------------------------------------------
// 5. sweep
// ---------------------------------------------------------------------------

test("sweep drops supersedes whose target is gone and keeps everything else", () => {
  const s = fakeStore({ existing: ["mem_live"] });
  const queue = [
    item("rev_dead", "supersede", { forget_memory_id: "mem_gone", replacement_content: "x", project: "harness" }),
    item("rev_live", "supersede", { forget_memory_id: "mem_live", replacement_content: "y", project: "harness" }),
    item("rev_doubt", "doubt", { question: "q" }),
  ];
  const { review, dropped } = sweepQueue(s, queue);
  assert.deepEqual(review.map((i) => i.id), ["rev_live", "rev_doubt"]);
  assert.deepEqual(dropped.map((d) => d.item.id), ["rev_dead"]);
  assert.match(dropped[0].reason, /no longer exists/);
});

test("sweep keeps only the newest pending supersede per target family", () => {
  const s = fakeStore({ existing: ["mem_t_c0"] });
  const queue = [
    item("rev_old", "supersede", { forget_memory_id: "mem_t_c0", replacement_content: "v1", project: "harness" }, "2026-09-12T00:00:00.000Z"),
    item("rev_new", "supersede", { forget_memory_id: "mem_t", replacement_content: "v2", project: "harness" }, "2026-09-20T00:00:00.000Z"),
  ];
  const { review, dropped } = sweepQueue(s, queue);
  assert.deepEqual(review.map((i) => i.id), ["rev_new"]);
  assert.match(dropped[0].reason, /older than rev_new/);
});

test("sweep never drops an item the human named, even with a dead target", () => {
  const s = fakeStore({ existing: ["mem_t"] });
  const queue = [
    item("rev_dead", "supersede", { forget_memory_id: "mem_gone", replacement_content: "x", project: "harness" }),
    item("rev_old", "supersede", { forget_memory_id: "mem_t", replacement_content: "v1", project: "harness" }, "2026-09-12T00:00:00.000Z"),
    item("rev_new", "supersede", { forget_memory_id: "mem_t", replacement_content: "v2", project: "harness" }, "2026-09-20T00:00:00.000Z"),
  ];
  const { review, dropped } = sweepQueue(s, queue, { exempt: new Set(["rev_dead", "rev_old"]) });
  assert.deepEqual(review.map((i) => i.id), ["rev_dead", "rev_old", "rev_new"]);
  assert.deepEqual(dropped, []);
});

test("sweep keeps everything when the store lookup fails", () => {
  const s = fakeStore({ failHas: true });
  const queue = [item("rev_a", "supersede", { forget_memory_id: "mem_x", replacement_content: "x", project: "harness" })];
  const { review, dropped } = sweepQueue(s, queue);
  assert.deepEqual(review.map((i) => i.id), ["rev_a"]);
  assert.deepEqual(dropped, []);
});

// ---------------------------------------------------------------------------
// 6. cost-figure backstop
// ---------------------------------------------------------------------------

test("cost figures are detected in prose but not in code spans or rupee facts", () => {
  for (const yes of ["the run cost $1.20 per call", "about $1,200 a month", "a $3k budget", "it costs $40", "$5/day on Bedrock", "roughly 12 USD"]) {
    assert.equal(looksLikeCostFigure(yes), true, yes);
  }
  for (const no of ["use `awk '{print $10}'` to get the field", "pass $1 to the script", "loan cap ₹5 lakh", "```\necho $100\n```", "set $HOME first", "PR #189 merged"]) {
    assert.equal(looksLikeCostFigure(no), false, no);
  }
});

// ---------------------------------------------------------------------------
// 1. the lock
// ---------------------------------------------------------------------------

function liveForeignPid() {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  return child;
}

function deadPid() {
  const r = spawnSync("true");
  return r.pid;
}

function writeLock(obj) {
  writeFileSync(state.LOCK_PATH, typeof obj === "string" ? obj : JSON.stringify(obj));
}

function clearLock() {
  rmSync(state.LOCK_PATH, { force: true });
}

test("a live holder blocks acquisition for the whole wait, even past the old 15-minute rule", async () => {
  const child = liveForeignPid();
  try {
    writeLock({ pid: child.pid, at: Date.now() - 20 * 60 * 1000 });
    const t0 = Date.now();
    const got = await state.acquireLockWait(300, 50);
    assert.equal(got, false);
    assert.ok(Date.now() - t0 >= 250, "it must wait out the bound");
    assert.equal(JSON.parse(readFileSync(state.LOCK_PATH, "utf8")).pid, child.pid, "the holder's lock is untouched");
  } finally {
    child.kill();
    clearLock();
  }
});

test("a live holder silent past the hard limit is presumed hung and broken", () => {
  const child = liveForeignPid();
  try {
    writeLock({ pid: child.pid, at: Date.now() - state.LOCK_HARD_STALE_MS - 60_000 });
    assert.equal(state.acquireLock(), true);
    assert.equal(JSON.parse(readFileSync(state.LOCK_PATH, "utf8")).pid, process.pid);
  } finally {
    child.kill();
    state.releaseLock();
    clearLock();
  }
});

test("a lock whose holder pid is gone is broken at once", () => {
  writeLock({ pid: deadPid(), at: Date.now() });
  assert.equal(state.acquireLock(), true);
  assert.equal(JSON.parse(readFileSync(state.LOCK_PATH, "utf8")).pid, process.pid);
  state.releaseLock();
  assert.equal(existsSync(state.LOCK_PATH), false);
});

test("an unreadable lock is broken only once it is older than the stale limit", () => {
  writeLock("");
  assert.equal(state.acquireLock(), false, "a fresh unreadable lock may be mid-write");
  const old = new Date(Date.now() - state.LOCK_STALE_MS - 60_000);
  utimesSync(state.LOCK_PATH, old, old);
  assert.equal(state.acquireLock(), true);
  state.releaseLock();
  clearLock();
});

test("refreshLock moves the heartbeat forward for the holder only", () => {
  assert.equal(state.acquireLock(), true);
  writeLock({ pid: process.pid, at: 1 });
  assert.equal(state.refreshLock(), true);
  assert.ok(JSON.parse(readFileSync(state.LOCK_PATH, "utf8")).at > Date.now() - 5_000);
  state.releaseLock();
  const child = liveForeignPid();
  try {
    writeLock({ pid: child.pid, at: 1 });
    assert.equal(state.refreshLock(), false);
    assert.equal(JSON.parse(readFileSync(state.LOCK_PATH, "utf8")).at, 1);
  } finally {
    child.kill();
    clearLock();
  }
});

// ---------------------------------------------------------------------------
// 7. log rotation
// ---------------------------------------------------------------------------

test("a log past 1 MB moves to .1, replacing the old one; small logs stay", () => {
  const big = "x".repeat(state.LOG_ROTATE_BYTES + 1024);
  writeFileSync(state.LOG_PATH, big);
  writeFileSync(`${state.LOG_PATH}.1`, "previous rotation");
  writeFileSync(state.LAUNCHD_LOG_PATH, "small\n");
  const rotated = state.rotateLogs();
  assert.equal(rotated.length, 1);
  assert.equal(statSync(`${state.LOG_PATH}.1`).size, big.length);
  assert.match(readFileSync(state.LOG_PATH, "utf8"), /rotated watchdog\.log/);
  assert.equal(readFileSync(state.LAUNCHD_LOG_PATH, "utf8"), "small\n");
});

// ---------------------------------------------------------------------------
// CLI: the fence and the whole path against a real store
// ---------------------------------------------------------------------------

test("apply-review exits 1 and changes nothing while another run holds the lock", () => {
  const child = liveForeignPid();
  try {
    writeLock({ pid: child.pid, at: Date.now() });
    writeFileSync(state.REVIEW_PATH, JSON.stringify([item("rev_x", "doubt", { question: "q" })], null, 2));
    const before = readFileSync(state.REVIEW_PATH, "utf8");
    const r = spawnSync(process.execPath, [CLI, "apply-review", "--approve", "rev_x"], {
      env: { ...process.env, MEMPALACE_HOME: HOME, WATCHDOG_LOCK_WAIT_MS: "300" },
      encoding: "utf8",
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /holds the lock/);
    assert.equal(readFileSync(state.REVIEW_PATH, "utf8"), before);
  } finally {
    child.kill();
    clearLock();
  }
});

test("demotions apply only when lower, and record the old importance first", () => {
  const imp = new Map([["mem_a", 0.8], ["mem_b", 0.3]]);
  const order = [];
  const store = {
    db: { prepare: () => ({ get: (id) => ({ importance: imp.has(id) ? imp.get(id) : null }) }) },
    setImportance(id, v) {
      order.push(["set", id, existsSync(state.DEMOTED_PATH) && readFileSync(state.DEMOTED_PATH, "utf8").includes(id)]);
      imp.set(id, v);
      return { updated: 1 };
    },
  };
  rmSync(state.DEMOTED_PATH, { force: true });
  assert.deepEqual(applyDemotion(store, { id: "mem_a", importance: 0.4, project: "harness" }), { status: "applied", from: 0.8, to: 0.4 });
  assert.deepEqual(order, [["set", "mem_a", true]], "recorded before it was applied");
  assert.equal(imp.get("mem_a"), 0.4);
  assert.equal(applyDemotion(store, { id: "mem_b", importance: 0.6 }).status, "not-lower");
  assert.equal(imp.get("mem_b"), 0.3);
  assert.equal(applyDemotion(store, { id: "mem_gone", importance: 0.1 }).status, "missing");
  const rec = JSON.parse(readFileSync(state.DEMOTED_PATH, "utf8"));
  assert.equal(rec.length, 1);
  assert.equal(rec[0].from, 0.8);
  assert.equal(rec[0].to, 0.4);
});

test("apply-review refuses two approved supersedes for one target and changes nothing (hx-r8e)", () => {
  clearLock();
  const queue = [
    item("rev_a", "supersede", { forget_memory_id: "mem_target_c0", replacement_content: "a", project: "harness" }),
    item("rev_b", "supersede", { forget_memory_id: "mem_target", replacement_content: "b", project: "harness" }),
  ];
  writeFileSync(state.REVIEW_PATH, JSON.stringify(queue, null, 2));
  const before = readFileSync(state.REVIEW_PATH, "utf8");
  const r = spawnSync(process.execPath, [CLI, "apply-review", "--approve", "rev_a,rev_b"], {
    env: { ...process.env, MEMPALACE_HOME: HOME, WATCHDOG_LOCK_WAIT_MS: "300" },
    encoding: "utf8",
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /share target mem_target: rev_a, rev_b/);
  assert.equal(readFileSync(state.REVIEW_PATH, "utf8"), before);
  clearLock();
});

test("apply-review end to end: save, delete, refuse, sweep and log against a real store", { timeout: 120_000 }, () => {
  const home = mkdtempSync(join(BASE, "wd-e2e-"));
  try {
    const env = { ...process.env, MEMPALACE_HOME: home, WATCHDOG_LOCK_WAIT_MS: "5000" };
    const saved = spawnSync(process.execPath, [PALACE_CLI, "save", "Old fact: the e2e widget runs on port 8000.", "--project", "harness-e2e", "--topic", "decisions", "--json"], { env, encoding: "utf8" });
    assert.equal(saved.status, 0, saved.stderr);
    const target = JSON.parse(saved.stdout).id;
    const queue = [
      item("rev_ok", "supersede", { forget_memory_id: target, replacement_content: "New fact: the e2e widget runs on port 9000 since 2026-10-02.", project: "harness-e2e", topic: "decisions", importance: 0.7 }),
      item("rev_bad", "lesson", { content: "A lesson filed under a working-directory name.", trigger: "when testing", project: "Documents" }),
      item("rev_dead", "supersede", { forget_memory_id: "mem_doesnotexist00", replacement_content: "orphan", project: "harness-e2e" }),
      item("rev_keep", "doubt", { question: "still open?" }),
    ];
    writeFileSync(join(home, "watchdog-review.json"), JSON.stringify(queue, null, 2));

    const r = spawnSync(process.execPath, [CLI, "apply-review", "--approve", "rev_ok,rev_bad"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);

    const after = JSON.parse(readFileSync(join(home, "watchdog-review.json"), "utf8"));
    assert.deepEqual(after.map((i) => i.id), ["rev_bad", "rev_keep"]);

    const recall = spawnSync(process.execPath, [PALACE_CLI, "recall", "--project", "harness-e2e", "--json"], { env, encoding: "utf8" });
    const texts = JSON.parse(recall.stdout).results.map((m) => m.text);
    assert.ok(texts.some((t) => t.includes("port 9000")), "replacement saved");
    assert.ok(!texts.some((t) => t.includes("port 8000")), "target deleted");

    const swept = JSON.parse(readFileSync(join(home, "watchdog-swept.json"), "utf8"));
    assert.deepEqual(swept.map((i) => i.id), ["rev_dead"], "a swept item is archived whole, so it can be put back");
    assert.equal(swept[0].payload.replacement_content, "orphan");
    assert.match(swept[0].swept_reason, /no longer exists/);

    const log = readFileSync(join(home, "watchdog.log"), "utf8");
    assert.match(log, /sweep: dropped rev_dead/);
    assert.match(log, /apply-review: approved 2, rejected 0, applied 1, failed 0, refused 1, swept 1; queue 4 -> 2/);
    assert.equal(existsSync(join(home, "watchdog.lock")), false, "lock released");
  } finally {
    if (process.env.WATCHDOG_TEST_KEEP !== "1") rmSync(home, { recursive: true, force: true });
  }
});
