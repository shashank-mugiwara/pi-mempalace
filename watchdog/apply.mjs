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
  const counts = { saved: 0, kg_added: 0, superseded: 0, kg_invalidated: 0, queued: 0, dup_skipped: 0, playbook_saved: 0, playbook_queued: 0 };
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

  // Lessons are ALWAYS queued, never auto-applied — even at high confidence.
  // A wrong lesson teaches an agent to avoid correct behaviour, so it is more
  // damaging than a wrong fact, and the model is inferring it about its own
  // reasoning from a transcript it partly wrote. This install already killed
  // auto-capture for writing 83% noise; a new autonomous writer is not the
  // shape of the fix. The human is the gate.
  for (const l of result.lessons || []) {
    if (!l?.content || typeof l.content !== "string") continue;
    if (!l?.trigger) continue; // a lesson with no trigger is unactionable
    if (await isNearDuplicate(store, l.content)) {
      counts.dup_skipped++;
      continue;
    }
    queueReview(
      reviewItems,
      "lesson",
      {
        content: l.content.trim(),
        project: canonicalProject(l.project || candidate.project, projects),
        topic: "lessons",
        trigger: String(l.trigger).trim(),
        importance: 0.85,
        confidence: l.confidence || "low",
      },
      l.evidence || "",
      candidate.key
    );
    counts.queued++;
  }

  // Playbook (docs/design/watchdog-playbook.md, Task 2): procedural findings
  // (fast commands, file/skill locations, prompt phrasings that worked).
  // Apply policy by (kind, destination):
  //   command|location + memory + HIGH confidence -> auto-apply, supersede-on-write
  //   everything else (prompt-phrasing/other, low confidence, vault/both/unsure) -> queue
  // apply.mjs has NO filesystem access to the Obsidian vault (only ever calls
  // store.store()/addTriple()/delete() — see the file's own imports/methods),
  // so any vault-bound destination must be queued for the live agent to apply
  // with its own judgment (session-watchdog.ts's review notice), never guessed
  // at here.
  for (const p of result.playbook || []) {
    if (!p?.content || typeof p.content !== "string") continue;
    if (!p?.kind || !p?.destination) continue; // both required to route correctly
    const project = canonicalProject(p.project || candidate.project, projects);

    const needsVaultRoute = p.destination === "vault" || p.destination === "both" || p.destination === "unsure";
    const isFactual = p.kind === "command" || p.kind === "location";
    const highConfidence = p.confidence === "high";

    if (needsVaultRoute || !isFactual || !highConfidence) {
      // Vault-bound (can't apply here), behavior-shaping (same risk class as
      // lessons), or not high-confidence (Decision #3 requires HIGH confidence
      // to auto-apply a factual/memory entry — a low-confidence guess written
      // straight into the shared store is the exact unreviewed-write failure
      // mode the 0.3.0 cleanup (4,585/5,527 memories, 83% noise) already paid
      // down once).
      if (await isNearDuplicate(store, p.content)) {
        counts.dup_skipped++;
        continue;
      }
      queueReview(
        reviewItems,
        "playbook",
        {
          content: p.content.trim(),
          project,
          topic: "playbook",
          kind: p.kind,
          destination: p.destination,
          importance: 0.6,
          confidence: p.confidence || "low",
        },
        p.evidence || "",
        candidate.key
      );
      counts.playbook_queued++;
      continue;
    }

    // kind is command|location, destination is memory, confidence is high.
    if (await isNearDuplicate(store, p.content)) {
      counts.dup_skipped++;
      continue;
    }
    if (!dry) {
      // Supersede, don't accumulate: one `playbook` memory per project, same
      // discipline as `session-resume` (PROTOCOL.md) — without this, every
      // qualifying tick adds a new row forever, refilling the store with the
      // exact noise pattern 0.3.0 already cleaned up (just differently-worded
      // restatements of the same procedural fact, which the near-dup guard's
      // 0.92 threshold doesn't catch).
      store.supersedeTopic(project, "playbook");
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
