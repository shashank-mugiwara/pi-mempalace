/**
 * apply.mjs — the "additive auto, destructive queued" policy.
 *
 * Auto-applied:
 *   - new memories (importance clamped to <= 0.85, near-duplicate guarded:
 *     skipped when an existing memory matches at >= 0.92 similarity)
 *   - new KG facts
 *   - supersedes with confidence "high" whose target memory has
 *     importance < 0.85 (forget old + save replacement)
 *   - kg invalidations with confidence "high" (invalidate + optional re-add)
 *
 * Queued for human review (watchdog-review.json → AskUserQuestion in pi):
 *   - supersedes targeting importance >= 0.85 memories, or confidence "low"
 *   - kg invalidations with confidence "low"
 *   - every doubt
 *
 * Doubt ⇒ queue, never guess.
 */

import { queueReview } from "./state.mjs";
import { canonicalProject } from "./summarize.mjs";

const AUTO_IMPORTANCE_CAP = 0.85;
const DUP_SIMILARITY = 0.92;

export async function applyResult(store, candidate, result, reviewItems, opts = {}) {
  const dry = !!opts.dryRun;
  const counts = { saved: 0, kg_added: 0, superseded: 0, kg_invalidated: 0, queued: 0, dup_skipped: 0 };
  const projects = safeProjects(store);
  const src = `session-watchdog:${candidate.source}`;

  for (const m of result.memories) {
    if (!m?.content || typeof m.content !== "string") continue;
    const project = canonicalProject(m.project || candidate.project, projects);
    const importance = Math.min(Number(m.importance) || 0.6, AUTO_IMPORTANCE_CAP);
    if (await isNearDuplicate(store, m.content)) {
      counts.dup_skipped++;
      continue;
    }
    if (!dry) {
      await store.store({
        content: m.content.trim(),
        project,
        topic: cleanTopic(m.topic),
        source: src,
        importance,
      });
    }
    counts.saved++;
  }

  for (const f of result.kg_facts) {
    if (!f?.subject || !f?.predicate || !f?.object) continue;
    if (!dry) {
      try {
        // skip exact-duplicate active facts
        if (store.findTriple(f.subject, f.predicate, f.object) !== null) continue;
        store.addTriple({
          subject: f.subject,
          predicate: f.predicate,
          object: f.object,
          valid_from: f.from || undefined,
          project: canonicalProject(f.project || candidate.project, projects),
        });
      } catch {
        continue;
      }
    }
    counts.kg_added++;
  }

  for (const s of result.supersedes) {
    if (!s?.forget_memory_id || !s?.replacement_content) continue;
    const target = findMemory(store, s.forget_memory_id);
    const destructiveOk =
      s.confidence === "high" && target && Number(target.importance) < AUTO_IMPORTANCE_CAP;
    if (!destructiveOk) {
      queueReview(reviewItems, "supersede", s, s.evidence, candidate.key);
      counts.queued++;
      continue;
    }
    if (!dry) {
      try {
        store.delete(s.forget_memory_id);
        await store.store({
          content: s.replacement_content.trim(),
          project: canonicalProject(s.project || candidate.project, projects),
          topic: cleanTopic(s.topic || target.topic),
          source: src,
          importance: Math.min(Number(s.importance) || Number(target.importance) || 0.6, AUTO_IMPORTANCE_CAP),
        });
      } catch {
        continue;
      }
    }
    counts.superseded++;
  }

  for (const inv of result.kg_invalidations) {
    if (!inv?.subject || !inv?.predicate || !inv?.object) continue;
    if (inv.confidence !== "high") {
      queueReview(reviewItems, "kg_invalidate", inv, inv.evidence, candidate.key);
      counts.queued++;
      continue;
    }
    if (!dry) {
      try {
        const id = store.findTriple(inv.subject, inv.predicate, inv.object);
        if (id === null) continue;
        store.invalidateTriple(id);
        if (inv.replacement?.subject) {
          store.addTriple({
            subject: inv.replacement.subject,
            predicate: inv.replacement.predicate,
            object: inv.replacement.object,
            valid_from: inv.replacement.from || undefined,
            project: canonicalProject(inv.replacement.project || candidate.project, projects),
          });
        }
      } catch {
        continue;
      }
    }
    counts.kg_invalidated++;
  }

  for (const d of result.doubts) {
    if (!d?.question) continue;
    queueReview(reviewItems, "doubt", d, d.context || "", candidate.key);
    counts.queued++;
  }

  return counts;
}

function safeProjects(store) {
  try {
    return store.listProjects().projects;
  } catch {
    return {};
  }
}

function cleanTopic(topic) {
  const t = String(topic || "").trim().toLowerCase().replace(/\s+/g, "-");
  return t && t !== "general" ? t : "session-watchdog";
}

async function isNearDuplicate(store, content) {
  try {
    const r = await store.search(content.slice(0, 800), { n_results: 1 });
    return r.results.length > 0 && Number(r.results[0].similarity) >= DUP_SIMILARITY;
  } catch {
    return false;
  }
}

function findMemory(store, id) {
  try {
    const r = store.recall({ n_results: 50 });
    const hit = r.results.find((m) => m.id === id);
    if (hit) return hit;
  } catch {}
  // recall window may miss it; fall back to existence check only
  try {
    return store.has(id) ? { importance: 1.0, topic: "unknown" } : null; // unknown importance ⇒ treated as high ⇒ queued
  } catch {
    return null;
  }
}
