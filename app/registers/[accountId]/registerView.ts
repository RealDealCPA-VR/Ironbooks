/**
 * What the account register shows while it loads (pure, unit-tested in lib/ui.review5.test.ts).
 *
 * The register reloads after every transaction typed into its entry row. The grid (and the entry
 * row in it) must stay on screen during that reload: replacing it with a spinner unmounted the
 * entry row, so after Enter the cursor was lost instead of waiting in the Date field of the next
 * blank row (QB keeps you in the register to type the next one), and every save re-read the
 * whole chart of accounts and name lists. The spinner is for the first load only.
 */
export type RegisterBody = 'spinner' | 'unavailable' | 'grid';

export function registerBody(loading: boolean, hasResult: boolean): RegisterBody {
  if (hasResult) return 'grid';
  return loading ? 'spinner' : 'unavailable';
}

/**
 * The entry row is offered on the unfiltered register only — the search the shown rows were
 * loaded with, not what is being typed into the search box (typing there used to unmount a
 * half-typed transaction before Apply was even pressed).
 */
export function showEntryRow(appliedSearch: string): boolean {
  return !appliedSearch.trim();
}
