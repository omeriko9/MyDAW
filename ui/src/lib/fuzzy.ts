/**
 * Fuzzy matcher for the command palette (owned by F4).
 *
 * Whitespace-separated query tokens must EACH match the text as a case-insensitive
 * subsequence; the result is the summed token score plus the matched character
 * ranges (for highlight rendering). Scoring favors, in order: a contiguous
 * substring hit, matches starting at a word boundary, and tight (low-gap)
 * subsequences — so "exp aud" ranks "File › Export › Export Audio…" above
 * scattered coincidences.
 */

export interface FuzzyResult {
  score: number;
  /** Matched [start, end) ranges in the ORIGINAL text, merged and sorted. */
  ranges: Array<[number, number]>;
}

const WORD_SEPS = " .,;:/\\-_()[]›>&…'\"";

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (WORD_SEPS.includes(prev)) return true;
  // camelCase boundary
  return prev === prev.toLowerCase() && text[i] === text[i].toUpperCase() && /[a-z]/i.test(prev);
}

/** Match ONE token. Returns null when the token is not a subsequence of text. */
function matchToken(token: string, text: string, lower: string): FuzzyResult | null {
  if (token.length === 0) return { score: 0, ranges: [] };

  // Contiguous substring — strongly preferred; earlier and word-start hits win.
  const sub = lower.indexOf(token);
  if (sub >= 0) {
    // Prefer a word-start occurrence even if a scattered one comes earlier.
    let at = sub;
    for (let i = sub; i >= 0 && i < lower.length; i = lower.indexOf(token, i + 1)) {
      if (isWordStart(text, i)) {
        at = i;
        break;
      }
    }
    const score =
      20 + token.length * 3 + (isWordStart(text, at) ? 8 : 0) - Math.min(10, at * 0.2);
    return { score, ranges: [[at, at + token.length]] };
  }

  // Greedy subsequence with bonuses (consecutive runs, word starts) and a gap penalty.
  const ranges: Array<[number, number]> = [];
  let score = 0;
  let ti = 0;
  let last = -2;
  for (let i = 0; i < lower.length && ti < token.length; i++) {
    if (lower[i] !== token[ti]) continue;
    if (i === last + 1) {
      score += 3; // consecutive
      const r = ranges[ranges.length - 1];
      r[1] = i + 1;
    } else {
      score += isWordStart(text, i) ? 4 : 1;
      if (last >= 0) score -= Math.min(3, (i - last) * 0.05); // gap penalty
      ranges.push([i, i + 1]);
    }
    last = i;
    ti++;
  }
  if (ti < token.length) return null;
  return { score, ranges };
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const r of sorted) {
    const prev = out[out.length - 1];
    if (prev && r[0] <= prev[1]) prev[1] = Math.max(prev[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * Match a whole query (whitespace-split into tokens, ALL must match) against text.
 * Returns null when any token fails. Empty/blank query matches with score 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { score: 0, ranges: [] };
  const lower = text.toLowerCase();
  let score = 0;
  const ranges: Array<[number, number]> = [];
  for (const t of tokens) {
    const m = matchToken(t, text, lower);
    if (!m) return null;
    score += m.score;
    ranges.push(...m.ranges);
  }
  // Slight preference for shorter texts (same hits in a shorter label rank higher).
  score -= Math.min(5, text.length * 0.02);
  return { score, ranges: mergeRanges(ranges) };
}
