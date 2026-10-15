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
  /** Record id behind the entry (used by <TypeaheadSelect>, which stores ids, not text). */
  id?: string;
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

/** The query names this option exactly (its text, label or one of its terms). */
export function isExactTypeaheadMatch(o: TypeaheadOption, query: string): boolean {
  const q = norm(query);
  if (!q) return false;
  return norm(o.value) === q || norm(o.label ?? o.value) === q || (o.terms ?? []).some((t) => norm(t) === q);
}

/**
 * Which list entry is highlighted right after the user types (-1 = none, so Enter / Tab keep
 * the typed text and leave the key to the grid).
 *
 * Pick-from-list fields highlight the best match, so Enter takes it. Free-text fields (a payee
 * that may be one-time) highlight only an exact match: typing "Office" while "Office Depot"
 * exists must not turn into "Office Depot" on Enter; Down picks the first entry instead.
 */
export function initialHighlight(results: TypeaheadOption[], query: string, allowFreeText = false): number {
  if (!query.trim() || results.length === 0) return -1;
  if (!allowFreeText) return 0;
  return isExactTypeaheadMatch(results[0], query) ? 0 : -1;
}

/**
 * ARIA attributes for the combobox input. aria-controls / aria-activedescendant only point at
 * the listbox while it is rendered (an id reference to a missing element is invalid).
 */
export function comboboxAria(
  expanded: boolean,
  listId: string,
  activeOptionId: string | null,
): { 'aria-expanded': boolean; 'aria-controls'?: string; 'aria-activedescendant'?: string } {
  return {
    'aria-expanded': expanded,
    ...(expanded ? { 'aria-controls': listId } : {}),
    ...(expanded && activeOptionId ? { 'aria-activedescendant': activeOptionId } : {}),
  };
}

/** An id-backed choice for <TypeaheadSelect>. */
export interface TypeaheadChoice {
  id: string;
  label: string;
  hint?: string;
  terms?: string[];
}

export function choicesToOptions(choices: TypeaheadChoice[]): TypeaheadOption[] {
  return choices.map((c) => ({ id: c.id, value: c.label, hint: c.hint, terms: c.terms }));
}

/** Label shown for a stored id ('' when nothing is chosen or the id is not in the list). */
export function labelForId(choices: TypeaheadChoice[], id: string): string {
  if (!id) return '';
  return choices.find((c) => c.id === id)?.label ?? '';
}

/**
 * The id a <TypeaheadSelect> keeps when the user leaves the field with typed text:
 *   blank text            -> '' (cleared)
 *   still the current label -> the current id (also when two entries share that label)
 *   one exact match       -> that entry (typing "6300" or a full name and tabbing away)
 *   anything else         -> the current id (the field then shows its label again)
 */
export function resolveTypedChoice(choices: TypeaheadChoice[], text: string, currentId: string): string {
  const q = norm(text);
  if (!q) return '';
  const current = currentId ? choices.find((c) => c.id === currentId) : undefined;
  if (current && norm(current.label) === q) return currentId;
  const exact = choices.filter((c) => isExactTypeaheadMatch({ value: c.label, terms: c.terms }, q));
  if (exact.length === 1) return exact[0].id;
  return currentId;
}
