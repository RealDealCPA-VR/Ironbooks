/**
 * Deterministic name matching for the command bar: "Acme" → "Acme Corporation", "fuel" →
 * "Fuel & Gas", "office supply" → "Office Supplies". PURE and side-effect free so the
 * executor (lib/services/commandBar.ts) and the tests share exactly one ranking.
 *
 * pickName() decides between one clear match, several equally good ones (the command bar then
 * asks the user to choose) and none.
 */
import { normalize, stem, words } from './text';

export interface NameCandidate {
  id: string;
  name: string;
  /** Other names the record answers to (company name, account code, SKU…). */
  alt?: (string | null | undefined)[];
}

export interface RankedName<T extends NameCandidate = NameCandidate> {
  cand: T;
  score: number;
}

function scoreOne(q: string, qStems: string[], name: string): number {
  const n = normalize(name);
  if (!n) return 0;
  if (n === q) return 100;
  const nWords = words(name);
  const nStems = nWords.map(stem);
  if (nStems.join(' ') === qStems.join(' ')) return 98;
  if (n.startsWith(q + ' ') || n.startsWith(q)) return q.length >= 2 ? 88 : 0;
  // Every word typed starts a word of the name ("acme corp" → "Acme Corporation").
  if (qStems.length && qStems.every((w) => nStems.some((nw) => nw.startsWith(w)))) return 80;
  // The name appears whole inside what was typed ("office supplies expense" → "Office Supplies").
  const qJoined = ` ${qStems.join(' ')} `;
  if (nStems.length && qJoined.includes(` ${nStems.join(' ')} `)) return 70;
  if (q.length >= 3 && n.includes(q)) return 65;
  // Partial word overlap.
  const hits = qStems.filter((w) => w.length >= 3 && nStems.some((nw) => nw === w || nw.startsWith(w))).length;
  if (hits && hits / qStems.length >= 0.5) return 30 + Math.round((hits / Math.max(qStems.length, nStems.length)) * 20);
  return 0;
}

/** Score every candidate (best first); zero scores are dropped. */
export function rankNames<T extends NameCandidate>(query: string, candidates: T[]): RankedName<T>[] {
  const q = normalize(query);
  if (!q) return [];
  const qStems = words(query).map(stem);
  return candidates
    .map((cand) => {
      const names = [cand.name, ...(cand.alt ?? [])].filter((x): x is string => !!x && !!x.trim());
      const scores = names.map((n, i) => scoreOne(q, qStems, n) - (i === 0 ? 0 : 2));
      return { cand, score: Math.max(0, ...scores) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.cand.name.localeCompare(b.cand.name));
}

export type PickResult<T extends NameCandidate> =
  | { status: 'one'; match: T; score: number }
  | { status: 'many'; matches: T[] }
  | { status: 'none' };

/** Matches scoring below this are ignored altogether. */
export const MIN_SCORE = 45;

/**
 * One clear winner, several candidates to choose from, or none.
 *  - an exact (or near-exact) name wins outright when it is the only one at that level;
 *  - otherwise the best match wins when it leads the runner-up by at least 10 points;
 *  - otherwise everything within 10 points of the best is offered as a choice (max `limit`).
 */
export function pickName<T extends NameCandidate>(query: string, candidates: T[], limit = 6): PickResult<T> {
  const ranked = rankNames(query, candidates).filter((r) => r.score >= MIN_SCORE);
  if (!ranked.length) return { status: 'none' };
  const [best, second] = ranked;
  if (!second) return { status: 'one', match: best.cand, score: best.score };
  if (best.score >= 98 && second.score < 98) return { status: 'one', match: best.cand, score: best.score };
  if (best.score - second.score >= 10) return { status: 'one', match: best.cand, score: best.score };
  return { status: 'many', matches: ranked.filter((r) => best.score - r.score < 10).slice(0, limit).map((r) => r.cand) };
}
