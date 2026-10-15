/**
 * Find-as-you-type matching for <Typeahead> (components/Typeahead.tsx). Pure, unit-tested.
 *
 * Ranking: exact match > label starts with the query > a word in the label starts with it >
 * the label contains it > an extra search term (e.g. an account number) starts with it.
 * Ties keep the list's own order.
 */

export interface TypeaheadOption {
  /** Text put into the field when chosen. */
  value: string;
  /** What the list shows (defaults to value). */
  label?: string;
  /** Small grey text after the label (e.g. "Vendor", "Expense"). */
  hint?: string;
  /** Extra words that also match (account number, company name...). */
  terms?: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function rank(o: TypeaheadOption, q: string): number {
  const label = norm(o.label ?? o.value);
  const value = norm(o.value);
  if (label === q || value === q) return 6;
  if (label.startsWith(q) || value.startsWith(q)) return 5;
  if (label.split(/[\s·:\-–/()]+/).some((w) => w.startsWith(q))) return 4;
  if (label.includes(q) || value.includes(q)) return 3;
  const terms = (o.terms ?? []).map(norm);
  if (terms.some((t) => t === q)) return 5;
  if (terms.some((t) => t.startsWith(q))) return 2;
  if (terms.some((t) => t.includes(q))) return 1;
  return 0;
}

/** Options matching the query, best first, at most `max`. An empty query lists the first `max`. */
export function filterTypeahead(options: TypeaheadOption[], query: string, max = 8): TypeaheadOption[] {
  const q = norm(query);
  if (!q) return options.slice(0, max);
  return options
    .map((o, i) => ({ o, i, r: rank(o, q) }))
    .filter((x) => x.r > 0)
    .sort((a, b) => b.r - a.r || a.i - b.i)
    .slice(0, max)
    .map((x) => x.o);
}

/** Next highlighted index for ArrowDown / ArrowUp / Home / End (wraps around; -1 = none). */
export function moveHighlight(current: number, count: number, key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'): number {
  if (count <= 0) return -1;
  switch (key) {
    case 'ArrowDown':
      return current < 0 || current >= count - 1 ? 0 : current + 1;
    case 'ArrowUp':
      return current <= 0 ? count - 1 : current - 1;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
  }
}
