/**
 * Small text helpers shared by the command-bar grammar (lib/commands/grammar.ts) and the name
 * matcher (lib/commands/match.ts). PURE: runs in the browser (live preview) and on the server.
 */

/** Lowercase, '&' → 'and', punctuation → spaces, single-spaced. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9.$/ -]+/g, ' ')
    .replace(/(?<![0-9])[.](?![0-9])/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words of a normalized string, without punctuation-only tokens. */
export function words(s: string): string[] {
  return normalize(s)
    .replace(/[-/]/g, ' ')
    .split(' ')
    .filter((w) => w && /[a-z0-9]/.test(w));
}

/** Loose singular/stem so "supplies" ~ "supply", "fuels" ~ "fuel", "hours" ~ "hour". */
export function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('ss')) return w;
  if (w.endsWith('es') && /(ch|sh|x|z)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

/** Collapse whitespace and trim stray separators/prepositions at either end. */
export function tidy(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:.\-–—]+|[\s,;:\-–—]+$/g, '')
    .trim();
}

/** Remove the first occurrence of `part` from `s` (case-sensitive, as returned by a match). */
export function cut(s: string, part: string): string {
  const i = s.indexOf(part);
  if (i < 0) return s;
  return tidy(`${s.slice(0, i)} ${s.slice(i + part.length)}`);
}

// ---------------------------------------------------------------------------
// Numbers & money
// ---------------------------------------------------------------------------

/** One numeric token: "$1,200.50", "1200", "2.5", "1.2k", "$45". */
export const NUM_TOKEN = String.raw`\$?\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?k?`;

/**
 * Parse a money/quantity token into a canonical decimal string ("1200.50" → "1200.50",
 * "$1,200" → "1200", "1.5k" → "1500"). Returns null for anything that is not a plain number.
 * Strings only — never routed through floats except for the 'k' shorthand, which is exact for
 * the at-most-3-decimal inputs it accepts.
 */
export function parseNumber(token: string): string | null {
  const t = token.trim().replace(/^\$\s?/, '').replace(/,/g, '').toLowerCase();
  const m = /^(\d+)(?:\.(\d+))?(k)?$/.exec(t);
  if (!m) return null;
  let [, int, frac = ''] = m;
  if (m[3]) {
    // ×1000 by shifting the decimal point three places.
    const padded = (frac + '000').slice(0, 3);
    const rest = frac.length > 3 ? frac.slice(3) : '';
    int = `${int}${padded}`;
    frac = rest;
  }
  int = int.replace(/^0+(?=\d)/, '');
  frac = frac.replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}

/** True when a token looks like money (leading "$" or exactly two decimals). */
export function looksLikeMoney(token: string): boolean {
  const t = token.trim();
  return t.startsWith('$') || /\.\d{2}$/.test(t);
}

/** "3" / "2.5" → number of decimal places check for quantities (max 4 dp). */
export function isReasonableQuantity(v: string): boolean {
  return /^\d{1,9}(\.\d{1,4})?$/.test(v) && /[1-9]/.test(v);
}
