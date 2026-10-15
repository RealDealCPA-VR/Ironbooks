/**
 * Picker options for the QB "Other Names" list (check payees, journal line names).
 *
 * The pickers load every entry (`/api/lists/other-names?includeInactive=true`) and show the
 * active ones plus the entry a saved transaction already points to, labelled " — inactive",
 * so editing a check paid to a since-inactivated name still shows who the payee is
 * (same rule as the customer form's price level picker).
 */

export interface OtherNameEntry {
  id: string;
  name: string;
  isActive?: boolean;
  accountNumber?: string | null;
}

export interface OtherNamePickerOption extends OtherNameEntry {
  label: string;
}

export const INACTIVE_SUFFIX = ' — inactive';

/** Label for one entry: its name, plus " — inactive" when it is inactive. */
export function otherNameLabel(entry: OtherNameEntry): string {
  return entry.isActive === false ? `${entry.name}${INACTIVE_SUFFIX}` : entry.name;
}

/**
 * Entries to offer in a picker: the active ones, plus `selectedId` when it is inactive.
 * Entries without an `isActive` flag count as active.
 */
export function visibleOtherNames(
  entries: readonly OtherNameEntry[],
  selectedId?: string | null,
): OtherNamePickerOption[] {
  return entries
    .filter((e) => e.isActive !== false || (!!selectedId && e.id === selectedId))
    .map((e) => ({ ...e, label: otherNameLabel(e) }));
}

/**
 * Picker options already built as `{ value, inactive }` (journal Name column): keep the active
 * ones plus the one whose value is currently selected.
 */
export function activeOrSelected<T extends { value: string; inactive?: boolean }>(
  options: readonly T[],
  selectedValue?: string | null,
): T[] {
  return options.filter((o) => !o.inactive || (!!selectedValue && o.value === selectedValue));
}
