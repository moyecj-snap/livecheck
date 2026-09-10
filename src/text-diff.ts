import { createHash } from "node:crypto";
import { applyIgnorePatterns, compileIgnorePatterns } from "./ignore-defaults.js";

export const DEFAULT_MIN_CHANGE_RATIO = 0.02;
export const TEXT_DIFF_NO_SELECTOR_MAX_CONFIDENCE = 0.6;
export const TEXT_DIFF_SELECTOR_CONFIDENCE = 0.85;

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = new Array<number>(cols);
  let next = new Array<number>(cols);
  for (let j = 0; j < cols; j += 1) prev[j] = j;
  for (let i = 1; i < rows; i += 1) {
    next[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j < cols; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = next;
    next = tmp;
  }
  return prev[b.length] ?? 0;
}

/** 0 = identical, 1 = completely different. */
export function textChangeRatio(previous: string, current: string): number {
  if (previous === current) return 0;
  const maxLen = Math.max(previous.length, current.length, 1);
  if (maxLen <= 4_000) {
    return levenshtein(previous, current) / maxLen;
  }
  const a = new Set(tokenize(previous));
  const b = new Set(tokenize(current));
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const word of a) {
    if (b.has(word)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : 1 - inter / union;
}

export function normalizeForTextDiff(text: string, ignore: string[] = []): string {
  return applyIgnorePatterns(text, compileIgnorePatterns(ignore));
}

export function textDiffHash(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function textDiffFired(input: {
  currentNormalized: string;
  currentHash: string;
  baselineHash: string | null;
  baselineText: string | null | undefined;
  minChangeRatio: number;
}): boolean | null {
  const { currentNormalized, currentHash, baselineHash, baselineText, minChangeRatio } = input;
  if (baselineText != null && baselineText !== "") {
    return textChangeRatio(baselineText, currentNormalized) >= minChangeRatio;
  }
  if (baselineHash) return currentHash !== baselineHash;
  return null;
}

export function textDiffConfidence(hasSelector: boolean): number {
  return hasSelector ? TEXT_DIFF_SELECTOR_CONFIDENCE : TEXT_DIFF_NO_SELECTOR_MAX_CONFIDENCE;
}
