#!/usr/bin/env node
/**
 * gate-unit.mjs — unit tests for extensions/pi-mempalace/gate.ts's pure
 * functions (buildGatePrompt, parseGateResponse). No pi imports, no model
 * calls, no store access — just prompt shape and response-parsing
 * tolerance/fail-open behavior.
 *
 * Usage: node bench/gate-unit.mjs
 */

import { buildGatePrompt, parseGateResponse } from "../extensions/pi-mempalace/gate.ts";

let pass = 0;
let fail = 0;

function assert(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ok — ${label}`);
  } else {
    fail++;
    console.log(`  FAIL — ${label}`);
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// buildGatePrompt
// ---------------------------------------------------------------------------

console.log("buildGatePrompt");

{
  const { system, user } = buildGatePrompt({
    message: "what did we decide about memory recall thresholds?",
    project: "pi-config",
    candidates: [
      { key: "m1", project: "pi-config", topic: "pi-mempalace-fork", date: "2026-06-23", snippet: "Forked + fixed pi-mempalace to stop retrieval pollution." },
      { key: "m2", project: "shashank.j", topic: "obsidian-memory-sync", date: "2026-05-26", snippet: "Obsidian vault cleanup sweep." },
    ],
  });
  assert(typeof system === "string" && system.length > 0, "system prompt is a non-empty string");
  assert(system.includes("relevance gate"), "system prompt describes the relevance-gate role");
  assert(system.includes("STRICT JSON"), "system prompt demands strict JSON");
  assert(system.toLowerCase().includes("approving zero"), "system prompt states approving zero is common/correct");
  assert(user.includes("what did we decide about memory recall thresholds?"), "user prompt includes the message");
  assert(user.includes("m1") && user.includes("m2"), "user prompt includes both candidate keys");
  assert(user.includes("pi-config") && user.includes("pi-mempalace-fork"), "user prompt includes candidate project/topic");
  assert(!user.includes("Available skills"), "no skills section when skills omitted");
}

{
  const { user } = buildGatePrompt({
    message: "hello",
    project: null,
    candidates: [{ key: "m1", project: "p", topic: "t", date: "2026-01-01", snippet: "x".repeat(500) }],
    skills: [{ name: "agent-browser", description: "Browser automation." }],
  });
  assert(user.includes("(unknown)"), "null project renders as (unknown)");
  assert(user.includes("Available skills"), "skills section present when skills provided");
  assert(user.includes("agent-browser"), "skill name included");
  // snippet truncated to 300 chars in the rendered prompt
  const snippetLine = user.split("\n").find((l) => l.startsWith("- m1"));
  assert(snippetLine.length < 400, "long snippet truncated in rendered prompt");
}

// ---------------------------------------------------------------------------
// parseGateResponse
// ---------------------------------------------------------------------------

console.log("\nparseGateResponse");

{
  const r = parseGateResponse('{"approve": ["m1", "m3"], "skills": ["agent-browser"]}', ["m1", "m2", "m3"], ["agent-browser", "run"]);
  assert(deepEqual(r, { approve: ["m1", "m3"], skills: ["agent-browser"] }), "valid strict JSON parses cleanly");
}

{
  const r = parseGateResponse(
    'Sure, here is my answer:\n```json\n{"approve": ["m2"], "skills": []}\n```\nHope that helps!',
    ["m1", "m2"],
    [],
  );
  assert(deepEqual(r, { approve: ["m2"], skills: [] }), "JSON wrapped in prose/fences still extracts");
}

{
  const r = parseGateResponse("not json at all, sorry I can't help with that", ["m1"], []);
  assert(r === null, "malformed/non-JSON text returns null (fail open)");
}

{
  const r = parseGateResponse("", ["m1"], []);
  assert(r === null, "empty string returns null");
}

{
  const r = parseGateResponse("{", ["m1"], []);
  assert(r === null, "truncated/unbalanced JSON returns null");
}

{
  const r = parseGateResponse('{"approve": ["m1", "m99", "not-a-real-key"], "skills": ["agent-browser", "fake-skill"]}', ["m1", "m2"], ["agent-browser"]);
  assert(deepEqual(r, { approve: ["m1"], skills: ["agent-browser"] }), "unknown candidate keys and skill names are dropped, valid ones kept");
}

{
  const r = parseGateResponse('{"approve": ["m1", "m1", "m2"]}', ["m1", "m2"], []);
  assert(deepEqual(r, { approve: ["m1", "m2"], skills: [] }), "duplicate keys deduped; missing skills field defaults to []");
}

{
  const r = parseGateResponse('{"approve": "m1"}', ["m1"], []);
  assert(deepEqual(r, { approve: [], skills: [] }), "non-array approve field yields empty approve (tolerant, not a crash)");
}

{
  const r = parseGateResponse('{"skills": ["a", "b", "c"]}', [], ["a", "b", "c"]);
  assert(r.skills.length === 2, "skills suggestions capped at 2");
}

{
  const r = parseGateResponse("null", ["m1"], []);
  assert(r === null, "JSON literal null (no object) returns null");
}

{
  const r = parseGateResponse('[1,2,3]', ["m1"], []);
  assert(r === null, "top-level JSON array (no object) returns null");
}

// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
