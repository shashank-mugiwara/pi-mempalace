/**
 * reranker.ts — lazy-loaded cross-encoder reranker singleton.
 *
 * The bi-encoder in memory_store.ts embeds the query and each memory text
 * independently, then compares vectors — fast enough to run over the whole
 * store, but a weak relevance judge near the decision boundary (see the
 * false-positive/false-negative pairs documented in recall.ts). A
 * cross-encoder scores the (query, text) pair jointly, which is much more
 * accurate but too slow to run over thousands of memories — so it only
 * re-scores the narrowed candidate pool selectRecall() gets back from
 * store.search().
 *
 * Model: Xenova/ms-marco-MiniLM-L-6-v2 (verified working — downloads and
 * runs cleanly under @huggingface/transformers 4.x; no fallback needed).
 */

import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
} from "@huggingface/transformers";

const MODEL_NAME = "Xenova/ms-marco-MiniLM-L-6-v2";
/** Truncate memory text to this many chars before scoring — keeps inference
 * fast and avoids the model's own token truncation cutting mid-token. */
const MAX_TEXT_CHARS = 1200;

let tokenizer: any = null;
let model: any = null;
let loadingPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (tokenizer && model) return;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    tokenizer = await AutoTokenizer.from_pretrained(MODEL_NAME);
    model = await AutoModelForSequenceClassification.from_pretrained(MODEL_NAME, {
      dtype: "fp32" as any,
    });
  })();

  try {
    await loadingPromise;
  } catch (e) {
    // Reset so a later call can retry instead of being stuck on a rejected
    // promise forever.
    tokenizer = null;
    model = null;
    loadingPromise = null;
    throw e;
  }
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Cross-encode (query, text) pairs and return relevance scores in [0, 1]
 * (sigmoid of the model's logit), one per input text, in the same order.
 *
 * Throws on model load or inference failure — callers (selectRecall) must
 * catch and fail open to the legacy similarity-only path.
 */
export async function rerank(query: string, texts: string[]): Promise<number[]> {
  if (texts.length === 0) return [];

  await ensureLoaded();

  // One (query, text) pair per model() call — DELIBERATELY not batched.
  // Batching all pairs into a single tokenizer/model() call was implemented
  // and measured (scores matched the loop to ~1.9e-7), but on this
  // single-threaded CPU/WASM onnxruntime backend it was consistently
  // ~30-60% SLOWER: ~450-510ms looped vs ~555-770ms batched on a realistic
  // 20-pair, variable-length (320-917 char) candidate pool, across 3
  // controlled runs on identical input. Root cause: batching pads every
  // pair up to the batch's longest sequence, and the extra attention FLOPs
  // spent on padding tokens cost more than the per-call overhead batching
  // saves on this runtime (length-sorting and chunk-size-4 batching
  // narrowed but never closed the gap). Revisit only on a backend with real
  // batch parallelism (GPU/multi-threaded), and re-measure there first.
  // See CHANGELOG-FORK.md (Unreleased).
  const scores: number[] = [];
  for (const text of texts) {
    const truncated = text.slice(0, MAX_TEXT_CHARS);
    const inputs = await tokenizer(query, {
      text_pair: truncated,
      padding: true,
      truncation: true,
    });
    const output = await model(inputs);
    const logit = output.logits.data[0] as number;
    scores.push(sigmoid(logit));
  }
  return scores;
}

/**
 * Warm the reranker model in the background so the first real recall call
 * doesn't pay model-load latency. Fire-and-forget; swallow errors (the
 * actual rerank() call surfaces them, and selectRecall fails open).
 */
export async function warmReranker(): Promise<void> {
  await ensureLoaded();
}
