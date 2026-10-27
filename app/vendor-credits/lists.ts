/**
 * Vendor credit form lists (pure, unit-tested in lib/ui.review5.test.ts).
 */

/** The rows of a list answer: a bare array, or the array under `key` ({ items: [...] }). */
export function rowsOf<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  const wrapped = data && typeof data === 'object' ? (data as Record<string, unknown>)[key] : undefined;
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

/** Item types a vendor credit's Items tab can return (no discount / subtotal / payment / tax / group items). */
const NOT_RETURNABLE = new Set(['subtotal', 'discount', 'payment', 'sales_tax', 'group']);

/**
 * Items offered on the Items tab. GET /api/items answers { items: [...] }; the form read it as a
 * bare array, so the Items tab never listed a single item and nothing could be returned to a
 * vendor on a credit.
 */
export function creditItems<T extends { type?: string }>(data: unknown): T[] {
  return rowsOf<T>(data, 'items').filter((i) => !NOT_RETURNABLE.has(i.type ?? ''));
}
