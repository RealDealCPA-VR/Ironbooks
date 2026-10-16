/**
 * Accountant's Copy (PARITY I1) — where the stock sits, for the review's inventory walk.
 *
 * The import refuses a change that would leave an item short in total, and also one that would
 * leave a single inventory site, bin, serial number or lot short (inventorySites.ts re-derives each
 * after every batch of movements). This module mirrors that ledger so the review can predict the
 * second kind too:
 *
 *  - a NON-default site's quantity is the sum of its movements; the DEFAULT site's is the item's
 *    total on hand less the other sites (checked only while another site holds stock — the
 *    service's single-site rule);
 *  - a bin's quantity is the sum of its movements, and the site's bins together may not hold more
 *    than the site (at every site, the default one too, whenever the site is not negative);
 *  - a serial number sits at the (site, bin) whose movements sum to 1; never below 0 there and
 *    never above 1 company-wide;
 *  - a lot's quantity is the sum of its movements per site (and per bin).
 *
 * A change's moves are applied in phases (an edit first reverses the record's own movements, then
 * posts the new version's lines, as the services do; a reversal copies the record's own movements
 * exactly, while a posting out without a bin is planned like planOutboundDraws) and each phase is checked like the service
 * checks it. A posting into a site or bin the client has made inactive is refused by the service
 * too, and is reported as such.
 */
import { sql } from 'drizzle-orm';
import { Money } from '@/lib/money';
import type { ServiceContext } from '../_base';

type Ctx = Pick<ServiceContext, 'db' | 'companyId'>;
type Row = Record<string, unknown>;
type Dec = ReturnType<typeof Money.zero>;

const dec = (v: unknown) => Money.of(v == null || v === '' ? '0' : String(v));
const EPS = -0.00005;

async function q(ctx: Ctx, query: ReturnType<typeof sql>): Promise<Row[]> {
  return ((await ctx.db.execute(query)) as unknown as { rows: Row[] }).rows;
}

/** One signed movement of stock. A null site is the default site. */
export interface Move {
  itemId: string;
  siteId: string | null;
  binId: string | null;
  serial: string | null;
  lot: string | null;
  qty: Dec;
  /** A posting of the new version (not a reversal of the record's own movements). */
  posting?: boolean;
}

/** Why a phase would be refused, for the review's plain-language problem. */
export type Short =
  | { kind: 'total'; itemId: string; have: Dec; need: Dec }
  | { kind: 'site'; itemId: string; siteId: string; have: Dec; need: Dec }
  | { kind: 'bin'; itemId: string; siteId: string; binId: string; have: Dec; need: Dec }
  | { kind: 'serial'; itemId: string; siteId: string; serial: string }
  | { kind: 'serialTwice'; itemId: string; serial: string }
  | { kind: 'lot'; itemId: string; siteId: string; lot: string; have: Dec; need: Dec }
  /** The site's bins would hold more than the site (stock taken out of the site's unbinned stock). */
  | { kind: 'binsOver'; itemId: string; siteId: string; binTotal: Dec; siteQty: Dec }
  | { kind: 'inactiveSite'; itemId: string; siteId: string }
  | { kind: 'inactiveBin'; itemId: string; siteId: string; binId: string };

const k = (...parts: Array<string | null>) => parts.map((p) => p ?? '').join('|');

/** The stock ledger by item, site, bin, serial and lot, with a trial overlay for one change. */
export class StockPlaces {
  readonly items = new Map<string, { tracking: string }>();
  readonly siteName = new Map<string, string>();
  readonly siteActive = new Map<string, boolean>();
  readonly binName = new Map<string, string>();
  readonly binActive = new Map<string, boolean>();
  defaultSite = '';

  private base = new Map<string, Dec>();
  private trial = new Map<string, Dec>();
  // Indexes of the keys that exist (only ever grow; a zero bucket is harmless).
  private sitesOf = new Map<string, Set<string>>(); // item -> sites
  private binsOf = new Map<string, Set<string>>(); // item|site -> bins
  private serialAt = new Map<string, Set<string>>(); // item|serial -> site|bin
  private lotAt = new Map<string, Set<string>>(); // item|lot -> site|bin

  static async load(ctx: Ctx): Promise<StockPlaces> {
    const s = new StockPlaces();
    const c = ctx.companyId;
    for (const r of await q(ctx, sql`SELECT id, quantity_on_hand, tracking_mode FROM items WHERE company_id = ${c}::uuid AND type = 'inventory'`)) {
      s.items.set(String(r.id), { tracking: String(r.tracking_mode ?? 'none') });
      s.base.set(k('t', String(r.id)), dec(r.quantity_on_hand));
    }
    if (!s.items.size) return s;
    for (const r of await q(ctx, sql`SELECT id, name, is_default, is_active FROM inventory_sites WHERE company_id = ${c}::uuid`)) {
      s.siteName.set(String(r.id), String(r.name));
      s.siteActive.set(String(r.id), Boolean(r.is_active));
      if (r.is_default) s.defaultSite = String(r.id);
    }
    // No default site yet: the first inventory form makes one (and no other site can hold stock).
    if (!s.defaultSite) s.defaultSite = '(default)';
    for (const r of await q(ctx, sql`SELECT id, name, is_active FROM inventory_bins WHERE company_id = ${c}::uuid`)) {
      s.binName.set(String(r.id), String(r.name));
      s.binActive.set(String(r.id), Boolean(r.is_active));
    }
    for (const r of await q(
      ctx,
      sql`SELECT item_id, site_id, bin_id, serial_number, lot_number, SUM(CAST(quantity AS NUMERIC)) AS qty
          FROM inventory_movements WHERE company_id = ${c}::uuid
          GROUP BY item_id, site_id, bin_id, serial_number, lot_number`,
    )) {
      const item = String(r.item_id);
      if (!s.items.has(item)) continue;
      s.record(s.base, item, String(r.site_id), r.bin_id ? String(r.bin_id) : null, (r.serial_number as string) ?? null, (r.lot_number as string) ?? null, dec(r.qty));
    }
    return s;
  }

  isInventory(itemId: string): boolean {
    return this.items.has(itemId);
  }
  tracking(itemId: string): string {
    return this.items.get(itemId)?.tracking ?? 'none';
  }
  knownSite(siteId: string | null): boolean {
    return !siteId || this.siteName.has(siteId);
  }

  private get(key: string): Dec {
    return this.trial.get(key) ?? this.base.get(key) ?? Money.zero();
  }
  private add(m: Map<string, Dec>, key: string, v: Dec) {
    m.set(key, (m === this.trial ? this.get(key) : (m.get(key) ?? Money.zero())).plus(v));
  }
  private index(ix: Map<string, Set<string>>, key: string, v: string) {
    const set = ix.get(key) ?? new Set<string>();
    set.add(v);
    ix.set(key, set);
  }

  /** Add one movement's quantity to the site, bin, serial and lot buckets (not the total). */
  private record(m: Map<string, Dec>, item: string, site: string, bin: string | null, serial: string | null, lot: string | null, qty: Dec) {
    this.index(this.sitesOf, item, site);
    this.add(m, k('s', item, site), qty);
    if (bin) {
      this.index(this.binsOf, k(item, site), bin);
      this.add(m, k('b', item, site, bin), qty);
    }
    if (serial) {
      this.index(this.serialAt, k(item, serial), k(site, bin));
      this.add(m, k('n', item, serial, site, bin), qty);
    }
    if (lot) {
      this.index(this.lotAt, k(item, lot), k(site, bin));
      this.add(m, k('l', item, lot, site, bin), qty);
    }
  }

  total(item: string): Dec {
    return this.get(k('t', item));
  }
  /** Σ of the item's non-default sites. */
  private otherSites(item: string): Dec {
    let sum = Money.zero();
    for (const s of this.sitesOf.get(item) ?? []) if (s !== this.defaultSite) sum = sum.plus(this.get(k('s', item, s)));
    return sum;
  }
  siteQty(item: string, site: string): Dec {
    return site === this.defaultSite ? this.total(item).minus(this.otherSites(item)) : this.get(k('s', item, site));
  }
  private binsAt(item: string, site: string): Array<{ bin: string; qty: Dec }> {
    return [...(this.binsOf.get(k(item, site)) ?? [])].map((bin) => ({ bin, qty: this.get(k('b', item, site, bin)) }));
  }
  private byName = (a: { bin: string }, b: { bin: string }) => (this.binName.get(a.bin) ?? '').localeCompare(this.binName.get(b.bin) ?? '');

  /** Apply one movement to the trial (the total, then where it sits — the services' order). */
  private apply(m: Move) {
    const item = m.itemId;
    const site = m.siteId || this.defaultSite;
    const before = this.siteQty(item, site);
    this.add(this.trial, k('t', item), m.qty);
    const out = m.qty.lessThan(0);
    const serial = m.serial ? m.serial.trim() : null;
    const lot = m.lot ? m.lot.trim() || null : null;

    // A reversal of the record's own movements copies them exactly (reverseSourceMovements): same
    // site, bin, serial and lot — no bin planning.
    if (!m.posting) {
      this.record(this.trial, item, site, m.binId, serial, lot, m.qty);
      return;
    }
    if (serial) {
      // A serial leaving without a bin leaves from the bin it sits in at that site.
      let bin = m.binId;
      if (!bin && out) {
        for (const at of this.serialAt.get(k(item, serial)) ?? []) {
          const [s, b] = at.split('|');
          if (s === site && b && this.get(k('n', item, serial, s, b)).greaterThan(0)) bin = b;
        }
      }
      this.record(this.trial, item, site, bin || null, serial, null, m.qty);
      return;
    }
    if (!out || m.binId) {
      this.record(this.trial, item, site, m.binId, null, lot, m.qty);
      return;
    }
    // Outbound without a bin: unbinned stock first, then bins by name (planOutboundDraws).
    const need = m.qty.abs();
    let fromBins: Dec;
    let bins: Array<{ bin: string; qty: Dec }>;
    if (lot) {
      bins = [...(this.lotAt.get(k(item, lot)) ?? [])]
        .map((at) => at.split('|'))
        .filter(([s, b]) => s === site && b)
        .map(([s, b]) => ({ bin: b, qty: this.get(k('l', item, lot, s, b)) }));
      const unbinned = this.get(k('l', item, lot, site, null));
      const fromUnbinned = unbinned.greaterThan(0) ? (unbinned.lessThan(need) ? unbinned : need) : Money.zero();
      fromBins = need.minus(fromUnbinned);
    } else {
      bins = this.binsAt(item, site);
      const binTotal = bins.filter((b) => b.qty.greaterThan(0)).reduce((s, b) => s.plus(b.qty), Money.zero());
      const after = site === this.defaultSite ? this.siteQty(item, site) : before.minus(need);
      const unbinnedAfter = after.minus(binTotal);
      fromBins = unbinnedAfter.isNegative() ? unbinnedAfter.abs() : Money.zero();
      if (fromBins.greaterThan(need)) fromBins = need;
    }
    let left = fromBins;
    let drawn = Money.zero();
    for (const b of bins.filter((x) => x.qty.greaterThan(0)).sort(this.byName)) {
      if (!left.greaterThan(0)) break;
      const take = left.lessThan(b.qty) ? left : b.qty;
      this.record(this.trial, item, site, b.bin, null, lot, take.negated());
      left = left.minus(take);
      drawn = drawn.plus(take);
    }
    const rest = need.minus(drawn);
    if (rest.greaterThan(0)) this.record(this.trial, item, site, null, null, lot, rest.negated());
  }

  /**
   * Try a change: each phase is applied and checked in turn. Returns why it would be refused (the
   * trial is dropped) or null (the trial stays until commit / discard).
   */
  tryPhases(phases: Move[][]): Short | null {
    for (const ph of phases) {
      const moves = ph.filter((m) => this.items.has(m.itemId));
      // A posting into a site or bin the client has made inactive.
      for (const m of moves) {
        if (!m.posting) continue;
        const site = m.siteId || this.defaultSite;
        if (this.siteActive.get(site) === false) return this.fail({ kind: 'inactiveSite', itemId: m.itemId, siteId: site });
        if (m.binId && this.binActive.get(m.binId) === false) return this.fail({ kind: 'inactiveBin', itemId: m.itemId, siteId: site, binId: m.binId });
      }
      const placed = moves.filter((m) => this.knownSite(m.siteId));
      // What the phase takes out of / puts into each place, and how much was there before.
      const net = new Map<string, Dec>();
      const pre = new Map<string, Dec>();
      const note = (key: string, v: Dec, now: Dec) => {
        if (!pre.has(key)) pre.set(key, now);
        net.set(key, (net.get(key) ?? Money.zero()).plus(v));
      };
      for (const m of moves) note(k('t', m.itemId), m.qty, this.total(m.itemId));
      for (const m of placed) {
        const site = m.siteId || this.defaultSite;
        note(k('s', m.itemId, site), m.qty, this.siteQty(m.itemId, site));
        if (m.binId) note(k('b', m.itemId, site, m.binId), m.qty, this.get(k('b', m.itemId, site, m.binId)));
        if (m.lot && !m.serial) {
          const lot = m.lot.trim();
          let now = Money.zero();
          for (const at of this.lotAt.get(k(m.itemId, lot)) ?? []) {
            const [s, b] = at.split('|');
            if (s === site) now = now.plus(this.get(k('l', m.itemId, lot, s, b || null)));
          }
          note(k('l', m.itemId, lot, site), m.qty, now);
        }
      }
      // Postings out of the default site go last (recordMovements).
      const isDefaultOut = (m: Move) => (m.siteId || this.defaultSite) === this.defaultSite && m.qty.isNegative();
      for (const m of moves) if (!this.knownSite(m.siteId)) this.add(this.trial, k('t', m.itemId), m.qty);
      for (const m of [...placed.filter((x) => !isDefaultOut(x)), ...placed.filter(isDefaultOut)]) this.apply(m);

      const short = this.check(moves, placed, net, pre);
      if (short) return this.fail(short);
    }
    return null;
  }

  private check(moves: Move[], placed: Move[], net: Map<string, Dec>, pre: Map<string, Dec>): Short | null {
    const taken = (key: string) => (net.get(key) ?? Money.zero()).negated();
    const had = (key: string) => {
      const v = pre.get(key) ?? Money.zero();
      return v.greaterThan(0) ? v : Money.zero();
    };
    // 1. The item's total on hand.
    for (const item of new Set(moves.map((m) => m.itemId))) {
      const key = k('t', item);
      if ((net.get(key) ?? Money.zero()).lessThan(0) && this.total(item).lessThan(EPS)) return { kind: 'total', itemId: item, have: had(key), need: taken(key) };
    }
    // 2. Sites and their bins.
    const sites = new Set(placed.map((m) => k(m.itemId, m.siteId || this.defaultSite)));
    for (const is of sites) {
      const [item, site] = is.split('|');
      const qty = this.siteQty(item, site);
      const policed = site !== this.defaultSite || this.otherSites(item).greaterThan(0);
      const key = k('s', item, site);
      if (policed && qty.lessThan(EPS)) return { kind: 'site', itemId: item, siteId: site, have: had(key), need: taken(key) };
      let binTotal = Money.zero();
      for (const b of this.binsAt(item, site)) {
        const bk = k('b', item, site, b.bin);
        if (b.qty.lessThan(EPS)) return { kind: 'bin', itemId: item, siteId: site, binId: b.bin, have: had(bk), need: taken(bk) };
        binTotal = binTotal.plus(b.qty);
      }
      // The bins may not hold more than the site (assertMovementState checks this at every site,
      // the default one too, whenever the site is not negative).
      if (qty.greaterThanOrEqualTo(0) && binTotal.minus(qty).greaterThan(0.00005)) {
        return { kind: 'binsOver', itemId: item, siteId: site, binTotal, siteQty: qty };
      }
    }
    // 3. Serial numbers.
    for (const m of placed) {
      if (!m.serial) continue;
      const serial = m.serial.trim();
      let total = Money.zero();
      for (const at of this.serialAt.get(k(m.itemId, serial)) ?? []) {
        const [s, b] = at.split('|');
        const v = this.get(k('n', m.itemId, serial, s, b || null));
        total = total.plus(v);
        if (v.lessThan(0)) return { kind: 'serial', itemId: m.itemId, siteId: s, serial };
        if (v.greaterThan(1)) return { kind: 'serialTwice', itemId: m.itemId, serial };
      }
      if (total.greaterThan(1)) return { kind: 'serialTwice', itemId: m.itemId, serial };
    }
    // 4. Lots, per site (and per bin).
    for (const m of placed) {
      if (!m.lot || m.serial) continue;
      const lot = m.lot.trim();
      const bySite = new Map<string, Dec>();
      for (const at of this.lotAt.get(k(m.itemId, lot)) ?? []) {
        const [s, b] = at.split('|');
        const v = this.get(k('l', m.itemId, lot, s, b || null));
        bySite.set(s, (bySite.get(s) ?? Money.zero()).plus(v));
        if (b && v.lessThan(EPS)) {
          const key = k('l', m.itemId, lot, s);
          return { kind: 'lot', itemId: m.itemId, siteId: s, lot, have: had(key), need: taken(key) };
        }
      }
      for (const [s, v] of bySite) {
        const key = k('l', m.itemId, lot, s);
        if (v.lessThan(EPS)) return { kind: 'lot', itemId: m.itemId, siteId: s, lot, have: had(key), need: taken(key) };
      }
    }
    return null;
  }

  private fail(s: Short): Short {
    this.trial.clear();
    return s;
  }
  commit() {
    for (const [key, v] of this.trial) this.base.set(key, v);
    this.trial.clear();
  }
}

// ---------------------------------------------------------------------------
// A record's moves
// ---------------------------------------------------------------------------

/** What the record moves in the client's file now (its stock movements not yet reversed). */
export async function currentMoves(ctx: Ctx, source: string, id: string): Promise<Move[]> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return [];
  const out: Move[] = [];
  for (const r of await q(
    ctx,
    sql`SELECT item_id, site_id, bin_id, serial_number, lot_number, SUM(CAST(quantity AS NUMERIC)) AS qty FROM inventory_movements
        WHERE company_id = ${ctx.companyId}::uuid AND source_type = ${source} AND source_id = ${id}::uuid
          AND reversal_of_id IS NULL AND reversed_at IS NULL
        GROUP BY item_id, site_id, bin_id, serial_number, lot_number`,
  )) {
    const qty = dec(r.qty);
    if (qty.isZero()) continue;
    out.push({
      itemId: String(r.item_id),
      siteId: String(r.site_id),
      binId: r.bin_id ? String(r.bin_id) : null,
      serial: (r.serial_number as string) ?? null,
      lot: (r.lot_number as string) ?? null,
      qty,
    });
  }
  return out;
}

const DETAIL_KEYS = ['siteId', 'binId', 'serialNumbers', 'lotNumber', 'lotExpiration'];

/** Documents whose edits keep a line's stored site / bin / serial / lot when the line carries none. */
const CARRY_FORWARD = new Set(['bill', 'invoice', 'expense', 'item_receipt']);

/**
 * What a version of a record (the file's payload) moves in (+) or out (-) of stock, line by line
 * with its site, bin, serial numbers and lot. `stored` is the record's saved line detail (an
 * edit of a form that keeps it for lines that carry none).
 */
export async function versionMoves(ctx: Ctx, type: string, p: Row, places: StockPlaces, edit: { id: string } | null): Promise<Move[]> {
  const lines = Array.isArray(p.lines) ? (p.lines as Row[]) : [];
  let dir: 1 | -1;
  let moving: (l: Row) => boolean = () => true;
  if (type === 'invoice') {
    if (p.status === 'draft') return []; // a pending invoice relieves no stock
    dir = -1;
  } else if (type === 'sales_receipt' || type === 'vendor_credit') {
    dir = -1;
  } else if (type === 'credit_memo') {
    dir = 1;
    moving = (l) => l.restock !== false;
  } else if (type === 'bill' || type === 'item_receipt' || type === 'expense') {
    dir = 1;
  } else if (type === 'inventory_adjustment') {
    const qty = dec(p.quantityChange);
    if (typeof p.itemId !== 'string' || qty.isZero()) return [];
    return movesOfLine(p.itemId, qty, p, places);
  } else {
    return [];
  }

  let stored = new Map<number, Row>();
  if (edit && CARRY_FORWARD.has(type) && /^[0-9a-f-]{36}$/i.test(edit.id)) {
    for (const r of await q(
      ctx,
      sql`SELECT line_order, item_id, site_id, bin_id, serial_numbers, lot_number FROM inventory_line_details
          WHERE company_id = ${ctx.companyId}::uuid AND source_type = ${type} AND source_id = ${edit.id}::uuid`,
    )) {
      stored.set(Number(r.line_order), { itemId: r.item_id, siteId: r.site_id, binId: r.bin_id, serialNumbers: r.serial_numbers, lotNumber: r.lot_number });
    }
  }
  const out: Move[] = [];
  lines.forEach((l, i) => {
    if (typeof l.itemId !== 'string' || !places.isInventory(l.itemId) || !moving(l)) return;
    const qty = dec(l.quantity ?? '1').abs();
    if (qty.isZero()) return;
    // A vendor credit's return carries no site (it leaves the default site).
    let detail: Row = type === 'vendor_credit' ? {} : l;
    if (type !== 'vendor_credit' && DETAIL_KEYS.every((key) => l[key] === undefined)) {
      const prev = stored.get(i);
      detail = prev && prev.itemId === l.itemId ? prev : {};
    }
    out.push(...movesOfLine(l.itemId, dir === 1 ? qty : qty.negated(), detail, places));
  });
  return out;
}

function movesOfLine(itemId: string, qty: Dec, detail: Row, places: StockPlaces): Move[] {
  const siteId = typeof detail.siteId === 'string' && detail.siteId ? detail.siteId : null;
  const binId = typeof detail.binId === 'string' && detail.binId ? detail.binId : null;
  const lot = typeof detail.lotNumber === 'string' && detail.lotNumber.trim() ? detail.lotNumber.trim() : null;
  const serials = Array.isArray(detail.serialNumbers) ? (detail.serialNumbers as unknown[]).map((s) => String(s).trim()).filter(Boolean) : [];
  const tracking = places.tracking(itemId);
  const base = { itemId, siteId, binId, posting: true };
  if (tracking === 'serial' && serials.length) {
    const one = qty.isNegative() ? Money.of('-1') : Money.of('1');
    const out: Move[] = serials.map((serial) => ({ ...base, serial, lot: null, qty: one }));
    const rest = qty.abs().minus(serials.length);
    if (rest.greaterThan(0)) out.push({ ...base, serial: null, lot: null, qty: qty.isNegative() ? rest.negated() : rest });
    return out;
  }
  return [{ ...base, serial: null, lot: tracking === 'lot' ? lot : null, qty }];
}
