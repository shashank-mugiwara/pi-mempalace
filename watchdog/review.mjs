/**
 * review.mjs — applying human verdicts to the review queue, and sweeping it.
 *
 * Used by `watchdog.mjs apply-review` (both functions) and `tick` (the sweep),
 * always while the caller holds watchdog.lock, so the queue read here is the
 * queue that gets written back.
 *
 * Ordering, per item: the store effect happens first and the queue is saved
 * last by the caller, so a crash in between leaves an applied item still
 * queued. Re-approving it is safe: the save dedupes on content hash and a
 * delete of a target that is already gone counts as done.
 *
 * - A supersede or merge saves its replacement before deleting anything, and
 *   deletes only when the save returned stored or duplicate. It never deletes
 *   the family the replacement itself landed in (a duplicate save can resolve
 *   to the target's own id).
 * - Every write resolves its project through resolveProject. An item whose
 *   project does not resolve (empty, "general", a working-directory name such
 *   as Documents or the home folder) is refused: it stays queued with a
 *   reason, and nothing is written to "general".
 */

import { resolveProject, sameMemoryFamily, cleanTopic, memoryFamilyExists, deleteIfPresent, applyDemotion } from "./apply.mjs";

function refusal(name) {
  return `project "${name ?? ""}" is not a canonical project (empty, general, or a working-directory name)`;
}

function requireText(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`payload has no ${field}`);
  return text;
}

function savedOk(res) {
  return res?.status === "stored" || res?.status === "duplicate";
}

async function applyOne(store, item, project) {
  const p = item.payload || {};
  switch (item.kind) {
    case "supersede": {
      const proj = project(p.project);
      if (!proj) return { refused: refusal(p.project) };
      const res = await store.store({
        content: requireText(p.replacement_content, "replacement_content"),
        project: proj,
        topic: cleanTopic(p.topic),
        source: "session-watchdog:review-approved",
        importance: Number(p.importance) || 0.7,
      });
      if (!savedOk(res)) throw new Error(`replacement save returned ${res?.status ?? "nothing"}; target kept`);
      if (sameMemoryFamily(res.id, p.forget_memory_id)) return { note: "replacement is the target itself; nothing deleted" };
      return { note: deleteIfPresent(store, p.forget_memory_id) };
    }
    case "lesson": {
      const proj = project(p.project);
      if (!proj) return { refused: refusal(p.project) };
      // Trigger first: a lesson is retrieved when the situation recurs, so the
      // "when X, check Y" line has to carry the searchable wording.
      await store.store({
        content: `LESSON (${p.trigger})\n${requireText(p.content, "content")}`,
        project: proj,
        topic: "lessons",
        source: "session-watchdog:lesson-approved",
        importance: Number(p.importance) || 0.85,
      });
      return {};
    }
    case "playbook": {
      // Vault write is NOT done here — apply-review has no vault-write
      // competence (same reason apply.mjs never auto-applies vault-bound
      // entries). If destination includes "vault", the human or the live agent
      // walking the queue writes the note; this persists the memory-side copy.
      const proj = project(p.project);
      if (!proj) return { refused: refusal(p.project) };
      await store.store({
        content: requireText(p.content, "content"),
        project: proj,
        topic: "playbook",
        source: "session-watchdog:playbook-approved",
        importance: Number(p.importance) || 0.7,
      });
      return {};
    }
    case "merge": {
      const proj = project(p.project);
      if (!proj) return { refused: refusal(p.project) };
      const res = await store.store({
        content: requireText(p.replacement_content, "replacement_content"),
        project: proj,
        topic: p.topic || "consolidated",
        source: "session-watchdog:consolidation-approved",
        importance: Number(p.importance) || 0.7,
      });
      if (!savedOk(res)) throw new Error(`merged save returned ${res?.status ?? "nothing"}; originals kept`);
      for (const id of p.forget_memory_ids || []) {
        if (!sameMemoryFamily(res.id, id)) deleteIfPresent(store, id);
      }
      return {};
    }
    case "demote": {
      const res = applyDemotion(store, { id: p.id, importance: p.importance, project: p.project, evidence: item.evidence, source: "review-approved" });
      if (res.status === "unreadable") throw new Error("could not read the current importance; nothing changed");
      return { note: res.status === "applied" ? `importance ${res.from} -> ${res.to}` : `not applied (${res.status})` };
    }
    case "delete":
      return { note: deleteIfPresent(store, p.id) };
    case "kg_invalidate": {
      // Resolve the replacement's project before touching anything, so a
      // refusal never leaves the fact invalidated with no replacement.
      let replProject;
      if (p.replacement?.subject) {
        replProject = project(p.replacement.project);
        if (!replProject) return { refused: refusal(p.replacement.project) };
      }
      const id = store.findTriple(p.subject, p.predicate, p.object);
      if (id !== null) store.invalidateTriple(id);
      if (p.replacement?.subject) {
        store.addTriple({
          subject: p.replacement.subject,
          predicate: p.replacement.predicate,
          object: p.replacement.object,
          valid_from: p.replacement.from || undefined,
          project: replProject,
        });
      }
      return {};
    }
    default:
      // Doubts have no mechanical action; approving one clears it (the human
      // acts on it themselves, or dictates a save in-session).
      return {};
  }
}

/**
 * Apply verdicts to `review`. Returns the items that stay queued (`keep`), the
 * rejected items (for recordRejections), per-run counts, and messages to print.
 * Approved items that fail or are refused stay in `keep`.
 */
export async function applyReviewItems(store, review, { approve = [], reject = [], projects = {} } = {}) {
  const approveSet = new Set(approve);
  const rejectSet = new Set(reject);
  const project = (name) => resolveProject(name, null, projects);
  const keep = [];
  const rejected = [];
  const messages = [];
  const counts = { approved: 0, rejected: 0, applied: 0, failed: 0, refused: 0 };
  for (const item of review) {
    if (rejectSet.has(item.id)) {
      rejected.push(item);
      counts.rejected++;
      continue;
    }
    if (!approveSet.has(item.id)) {
      keep.push(item);
      continue;
    }
    counts.approved++;
    try {
      const outcome = await applyOne(store, item, project);
      if (outcome.refused) {
        keep.push(item);
        counts.refused++;
        messages.push({ level: "error", text: `refused ${item.id} (${item.kind}): ${outcome.refused}; kept in queue, re-file payload.project or reject it` });
        continue;
      }
      counts.applied++;
      messages.push({ level: "info", text: `applied ${item.id} (${item.kind})${outcome.note ? ` — ${outcome.note}` : ""}` });
    } catch (e) {
      keep.push(item);
      counts.failed++;
      messages.push({ level: "error", text: `failed ${item.id} (${item.kind}): ${e?.message || e}; kept in queue` });
    }
  }
  return { keep, rejected, counts, messages };
}

const familyOf = (id) => String(id).replace(/_c\d+$/, "");
const createdMs = (item) => Date.parse(item.created) || 0;

/**
 * Drop supersede proposals that can no longer mean anything:
 *   1. the target memory family no longer exists (deleted, or replaced by an
 *      earlier supersede); a failed lookup keeps the item;
 *   2. an older proposal for a target that has a newer pending one — the
 *      newer carries the newer evidence (the same rule apply.mjs enforces
 *      when queueing, applied to items queued before it existed).
 * Items in `exempt` (ids the human named in this apply-review run) are never
 * dropped: an explicit verdict outranks the sweep.
 * Returns { review, dropped: [{ item, reason }] }.
 */
export function sweepQueue(store, review, { exempt = new Set() } = {}) {
  const dropped = [];
  const live = [];
  for (const item of review) {
    if (item.kind !== "supersede" || exempt.has(item.id)) {
      live.push(item);
      continue;
    }
    const target = item.payload?.forget_memory_id;
    if (!target) {
      dropped.push({ item, reason: "no target memory id" });
      continue;
    }
    if (memoryFamilyExists(store, target) === false) {
      dropped.push({ item, reason: `target ${target} no longer exists` });
      continue;
    }
    live.push(item);
  }

  const newest = new Map();
  for (const item of live) {
    if (item.kind !== "supersede" || exempt.has(item.id)) continue;
    const fam = familyOf(item.payload.forget_memory_id);
    const cur = newest.get(fam);
    // >= : on a timestamp tie the later queue position (appended later) wins.
    if (!cur || createdMs(item) >= createdMs(cur)) newest.set(fam, item);
  }

  const kept = [];
  for (const item of live) {
    if (item.kind === "supersede" && !exempt.has(item.id)) {
      const winner = newest.get(familyOf(item.payload.forget_memory_id));
      if (winner !== item) {
        dropped.push({ item, reason: `older than ${winner.id} for the same target` });
        continue;
      }
    }
    kept.push(item);
  }
  return { review: kept, dropped };
}
