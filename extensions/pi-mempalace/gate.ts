/**
 * gate.ts — pure prompt-building and response-parsing for the LLM relevance
 * gate (see recall.ts's gray-zone partition + index.ts's judge closure).
 *
 * Deliberately has ZERO pi imports (no @earendil-works/*) so it stays
 * unit-testable with plain node (bench/gate-unit.mjs) and reusable from any
 * caller that can supply a completion. All parsing is tolerant: malformed
 * model output must resolve to `null` so the caller can fail open to the
 * plain rerankMinScore rule (never throw, never block recall).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GateCandidateInput {
  /** Synthetic key (m1..mN) — never the real memory id, to keep the prompt short and stable. */
  key: string;
  project: string;
  topic: string;
  date: string;
  /** First ~300 chars of the memory text. */
  snippet: string;
}

export interface GateSkillInput {
  name: string;
  description: string;
}

export interface BuildGatePromptInput {
  /** The user's latest message (the query being judged against). */
  message: string;
  /** Current project, or null if unknown/none. */
  project: string | null;
  /** Gray-zone candidates, already sorted/truncated by the caller. */
  candidates: GateCandidateInput[];
  /** Optional skills catalog the gate may suggest from. */
  skills?: GateSkillInput[];
}

export interface GatePrompt {
  system: string;
  user: string;
}

export interface GateVerdict {
  /** Approved candidate keys (subset of the keys passed in). */
  approve: string[];
  /** Suggested skill names (subset of the skill names passed in), max 2. */
  skills: string[];
}

// ---------------------------------------------------------------------------
// buildGatePrompt
// ---------------------------------------------------------------------------

const SNIPPET_CHARS = 300;

export function buildGatePrompt(input: BuildGatePromptInput): GatePrompt {
  const system = [
    "You are a relevance gate for an AI coding agent's persistent memory.",
    "Given the user's latest message and a list of candidate memories, approve ONLY the",
    "memories a competent engineer would actually want pulled into context for THIS",
    "specific message. Approving zero candidates is common and correct — most memories",
    "are not relevant to any given message, and injecting irrelevant context wastes the",
    "agent's attention. Do not approve a memory just because it mentions the same",
    "project or a similar topic; it must genuinely help answer or act on the message.",
    "If a list of skills is provided, you may optionally suggest up to 2 skills that are",
    "genuinely applicable to the message — omit the \"skills\" field/array (or leave it",
    "empty) if none apply.",
    "",
    'Respond with STRICT JSON only, no prose, no markdown fences: {"approve": ["m1", ...], "skills": ["name", ...]}',
  ].join("\n");

  const lines: string[] = [];
  lines.push(`User's latest message:\n${input.message}`);
  lines.push(`Current project: ${input.project ?? "(unknown)"}`);
  lines.push("");
  lines.push("Candidate memories:");
  for (const c of input.candidates) {
    const snippet = c.snippet.slice(0, SNIPPET_CHARS);
    lines.push(`- ${c.key} [${c.project}/${c.topic}] (${c.date}): ${snippet}`);
  }

  if (input.skills && input.skills.length > 0) {
    lines.push("");
    lines.push("Available skills (suggest up to 2 only if genuinely applicable):");
    for (const s of input.skills) {
      lines.push(`- ${s.name}: ${s.description}`);
    }
  }

  return { system, user: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// parseGateResponse
// ---------------------------------------------------------------------------

/**
 * Extract the first {...} JSON block from `text`, validate/tolerate its
 * shape, and drop any keys/skills not present in the valid sets. Returns
 * null on any parse failure or structurally invalid response — callers must
 * treat null as "fail open" (never throw).
 */
export function parseGateResponse(
  text: string,
  validKeys: string[],
  validSkills: string[],
): GateVerdict | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;

  const jsonSlice = text.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const validKeySet = new Set(validKeys);
  const validSkillSet = new Set(validSkills);

  const approveRaw = Array.isArray(obj.approve) ? obj.approve : [];
  const approve = approveRaw.filter(
    (k): k is string => typeof k === "string" && validKeySet.has(k),
  );
  // De-dupe while preserving first-seen order.
  const approveDeduped = Array.from(new Set(approve));

  const skillsRaw = Array.isArray(obj.skills) ? obj.skills : [];
  const skills = skillsRaw.filter(
    (s): s is string => typeof s === "string" && validSkillSet.has(s),
  );
  const skillsDeduped = Array.from(new Set(skills)).slice(0, 2);

  return { approve: approveDeduped, skills: skillsDeduped };
}
