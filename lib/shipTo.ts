/**
 * Customer ship-to addresses (QuickBooks Enterprise: several named "Ship To" addresses per
 * customer, one of them the default). Stored on customers.ship_to_addresses (drizzle/0040).
 * Pure module — used by the customer service, the packing slip and the sales forms.
 */

export interface ShipToAddress {
  /** Name shown in the Ship To dropdown, e.g. "Ship To 1", "Warehouse". */
  name: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  isDefault?: boolean;
}

export const MAX_SHIP_TO_ADDRESSES = 50;
const ADDRESS_KEYS = ['line1', 'line2', 'city', 'state', 'zip', 'country'] as const;

type Raw = object | null | undefined;
const rec = (a: Raw) => (a ?? {}) as Record<string, unknown>;

/** Just the address part (what a document's ship_to stores). */
export function shipToAddressFields(a: Raw): Record<string, string> {
  const out: Record<string, string> = {};
  if (!a) return out;
  for (const k of ADDRESS_KEYS) {
    const v = rec(a)[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

/**
 * Clean a list typed on the customer form: trims, drops empty rows, names unnamed rows
 * "Ship To n", refuses duplicate names (case-insensitive) and makes exactly one default
 * (the first one when none is marked). Throws Error with a plain-language message.
 */
export function normalizeShipToAddresses(list: Raw[] | null | undefined): ShipToAddress[] | null {
  if (!list || list.length === 0) return null;
  const out: ShipToAddress[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw) continue;
    const addr = shipToAddressFields(raw);
    const r = rec(raw);
    const typedName = typeof r.name === 'string' ? r.name.trim() : '';
    if (!typedName && Object.keys(addr).length === 0) continue;
    const name = (typedName || `Ship To ${out.length + 1}`).slice(0, 41);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`Two ship-to addresses are named "${name}". Give each one its own name.`);
    seen.add(key);
    out.push({ name, ...addr, isDefault: r.isDefault === true });
  }
  if (out.length === 0) return null;
  if (out.length > MAX_SHIP_TO_ADDRESSES) {
    throw new Error(`A customer can have at most ${MAX_SHIP_TO_ADDRESSES} ship-to addresses.`);
  }
  const firstDefault = out.findIndex((a) => a.isDefault);
  out.forEach((a, i) => (a.isDefault = i === (firstDefault < 0 ? 0 : firstDefault)));
  return out;
}

/** The default ship-to address (address fields only), or null. */
export function defaultShipTo(list: Raw[] | null | undefined): Record<string, string> | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const d = list.find((a) => a && rec(a).isDefault === true) ?? list[0];
  const fields = shipToAddressFields(d);
  return Object.keys(fields).length ? fields : null;
}

/** One-line summary for dropdowns: "Warehouse — 12 Main St, Springfield". */
export function shipToSummary(a: Raw): string {
  const f = shipToAddressFields(a);
  const parts = [f.line1, f.city].filter(Boolean).join(', ');
  const n = rec(a).name;
  const name = typeof n === 'string' ? n : '';
  return parts ? `${name} — ${parts}` : name;
}
