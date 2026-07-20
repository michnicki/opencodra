import type { ParsedReviewComment } from '@shared/schema';

/**
 * Deterministic near-duplicate suppression (MP-02 / D-03 / D-04).
 *
 * A second finding source (the security pass) can surface the same issue the main pass already
 * reported. `dedupeFindings` collapses those same-file near-duplicates BEFORE anything is posted,
 * using nothing but the parsed findings — no model call, no I/O, no network, no DB (D-03: zero cost,
 * fully unit-testable). It is a pure, UNCONDITIONAL function: the `passes.security` gate that decides
 * WHETHER to call it lives at the review.ts / runCriticPhase call site (Pitfall 4), not here.
 *
 * Similarity is hand-rolled character-trigram Jaccard (~50 LOC), deliberately avoiding the
 * unmaintained / isolate-incompatible similarity libraries (RESEARCH § Don't Hand-Roll).
 */

// Tuned start value for near-duplicate collapse. 0.7 is high enough that only genuine paraphrases
// of the SAME issue merge (two unrelated findings on the same file rarely share 70% of their
// character trigrams) yet low enough to catch main-vs-security restatements of one bug. It is a
// documented tunable: if paraphrased duplicates leak through, raise/lower this rather than changing
// the algorithm.
export const DEDUP_SIMILARITY_THRESHOLD = 0.7;

// Max line distance (inclusive) for two same-file findings to be considered the "same location".
// 10 absorbs the small line drift between how the main and security passes anchor the same issue
// (a finding on the function signature vs. one line into the body) without merging distinct issues
// that merely happen to be textually similar elsewhere in the file. Also a documented tunable.
export const DEDUP_LINE_PROXIMITY = 10;

// Severity ranking (lower rank = higher severity). SINGLE SOURCE OF TRUTH — `review.ts` imports
// this constant rather than keeping its own copy (dedup.ts is a low-level, cycle-free module, so
// review.ts can safely depend on it). Previously this was hand-duplicated in both modules with a
// stale line reference; consolidating here removes the drift hazard.
export const SEVERITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3, nit: 4 };

/**
 * Normalize a finding's comparison text so that surface differences (case, markdown, backticks,
 * punctuation, whitespace, unicode composition) don't defeat the similarity comparison.
 * Order matters: NFC first so accented letters compose into a single \p{L} code point that the
 * punctuation strip below keeps, then lowercase, strip fenced code / inline backticks, strip any
 * remaining non-letter/number/space char, and collapse whitespace.
 */
export function normalizeForDedup(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`+/g, ' ') // inline backticks
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // markdown/punctuation -> space
    .replace(/\s+/g, ' ')
    .trim();
}

function trigramSet(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) {
    set.add(s.slice(i, i + 3));
  }
  return set;
}

/**
 * Character-trigram Jaccard similarity: |A∩B| / |A∪B|.
 *
 * PINNED empty/short rule: a string shorter than 3 chars has an empty trigram set. Two empty sets
 * are treated as "similar" (1) ONLY when the input strings are exactly equal, else 0; an empty set
 * against a non-empty set is 0. Callers pass already-normalized strings, so the exact-equality
 * check is over normalized text.
 */
export function trigramJaccardSimilarity(a: string, b: string): number {
  const setA = trigramSet(a);
  const setB = trigramSet(b);
  if (setA.size === 0 && setB.size === 0) {
    return a === b ? 1 : 0;
  }
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const gram of setA) {
    if (setB.has(gram)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

/**
 * D-04 survivor selection: higher severity wins; equal severity -> higher confidence
 * (confidence ?? -1, so an explicit score always beats null); remaining tie -> keep the existing
 * (stably-earlier) finding.
 */
function pickSurvivor(existing: ParsedReviewComment, candidate: ParsedReviewComment): ParsedReviewComment {
  const rankExisting = SEVERITY_RANK[existing.severity] ?? SEVERITY_RANK.nit;
  const rankCandidate = SEVERITY_RANK[candidate.severity] ?? SEVERITY_RANK.nit;
  if (rankCandidate < rankExisting) return candidate;
  if (rankCandidate > rankExisting) return existing;
  const confExisting = existing.confidence ?? -1;
  const confCandidate = candidate.confidence ?? -1;
  if (confCandidate > confExisting) return candidate;
  return existing; // tie -> keep the earlier finding (stable)
}

/**
 * PINNED proximity gate: a pair merges iff BOTH lines are non-null and within DEDUP_LINE_PROXIMITY,
 * OR both lines are null. If exactly one line is null, proximity cannot be established -> keep both.
 * `line` may be null or undefined on ParsedReviewComment; both are treated as "no line".
 */
function proximityAllowsMerge(a: ParsedReviewComment, b: ParsedReviewComment): boolean {
  const lineA = a.line ?? null;
  const lineB = b.line ?? null;
  if (lineA === null && lineB === null) return true;
  if (lineA === null || lineB === null) return false;
  return Math.abs(lineA - lineB) <= DEDUP_LINE_PROXIMITY;
}

/**
 * Deterministic same-file near-duplicate suppression. Single greedy pass over `findings` in stable
 * input order: each finding is compared against the already-KEPT survivors and, on the first match
 * (same path AND proximity gate AND similarity >= threshold), resolved by the D-04 tie-break IN
 * PLACE — the higher-severity member occupies that survivor's slot, so a later higher-severity
 * finding replaces an earlier survivor without reordering. Findings on different paths are never
 * merged (ParsedReviewComment has no line_range, so no cross-file / range-overlap branch exists).
 * Returns survivors in stable input order.
 */
export function dedupeFindings(findings: ParsedReviewComment[]): ParsedReviewComment[] {
  if (findings.length <= 1) return [...findings];

  const survivors: ParsedReviewComment[] = [];
  const survivorNorms: string[] = [];

  for (const finding of findings) {
    const norm = normalizeForDedup(`${finding.title} ${finding.body}`);
    let merged = false;

    for (let i = 0; i < survivors.length; i++) {
      const survivor = survivors[i];
      if (survivor.path !== finding.path) continue;
      if (!proximityAllowsMerge(survivor, finding)) continue;
      if (trigramJaccardSimilarity(norm, survivorNorms[i]) < DEDUP_SIMILARITY_THRESHOLD) continue;

      const winner = pickSurvivor(survivor, finding);
      survivors[i] = winner;
      survivorNorms[i] = normalizeForDedup(`${winner.title} ${winner.body}`);
      merged = true;
      break;
    }

    if (!merged) {
      survivors.push(finding);
      survivorNorms.push(norm);
    }
  }

  return survivors;
}
