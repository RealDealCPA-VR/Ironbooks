/**
 * IIF "other lists" (QB Desktop File > Utilities > Import / Export > IIF Files):
 *   OTHERNAME, TERMS, SHIPMETH, PAYMETH, CUSTMSG, SALESTAXCODE, JOBTYPE, VEH, PRICELEVEL, TODO.
 *
 * Import: each section goes into its existing list table through the list services (so the
 * usual validation + audit apply), de-duplicated by name (case-insensitive) — re-importing the
 * same file adds nothing. Export: the same sections, written with QuickBooks' own column names so
 * QB Desktop (and our importer) can read them back.
 *
 * Column conventions (QB Desktop IIF):
 *   OTHERNAME    NAME, BADDR1-5, PHONE1, PHONE2, FAXNUM, EMAIL, CONT1, NOTE, HIDDEN
 *   TERMS        NAME, DUEDAYS, MINDAYS, DISCPER, DISCDAYS, TERMSTYPE (0 standard, 1 date driven), HIDDEN
 *                (date driven: DUEDAYS = day of month due, MINDAYS = due the next month when issued
 *                within N days of the due date, DISCDAYS = discount day of month)
 *   SHIPMETH     NAME, HIDDEN
 *   PAYMETH      NAME, HIDDEN
 *   CUSTMSG      NAME, HIDDEN
 *   SALESTAXCODE CODE (or NAME), DESC, TAXABLE, HIDDEN
 *   JOBTYPE      NAME ("Parent:Sub"), HIDDEN
 *   VEH          NAME, DESC, HIDDEN
 *   PRICELEVEL   NAME, PERCENT ("-10%" = 10% below base price), HIDDEN
 *   TODO         NOTE (or DESC), DATE / ALERTDATE / DUEDATE, DONE / ISDONE
 */
import { and, eq } from 'drizzle-orm';
import { jobTypes, priceLevels } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { type ServiceContext, ServiceError } from './_base';
import { createEntry, listEntries, type SimpleListKey } from './lists/simpleLists';
import { createPriceLevel } from './pricing';
import { createTodo } from './todos';
import { importRowError } from './qbImportErrors';

export type IifListRows = Array<Record<string, string>>;

export interface ListIssue {
  name: string;
  message: string;
}

const yes = (v: string | undefined) => !!v && /^(y|yes|true|1)$/i.test(v.trim());
const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
const intOf = (v: string | undefined): number | null => {
  const s = opt(v);
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
/** "2%", "2.0", "0.02"? QB writes percents as "2.0%" or "2". */
const pctOf = (v: string | undefined): string | null => {
  const s = opt(v);
  if (!s) return null;
  const n = Number(s.replace(/%/g, '').trim());
  return Number.isFinite(n) ? String(n) : null;
};

/** Which payment-method type a QB payment method name implies. */
export function paymentMethodTypeFor(name: string): 'cash' | 'check' | 'credit_card' | 'ach' | 'bank_transfer' | 'other' {
  const n = name.toLowerCase();
  if (/cash/.test(n)) return 'cash';
  if (/e-?check|ach/.test(n)) return 'ach';
  if (/check|cheque/.test(n)) return 'check';
  if (/visa|master|amex|american express|discover|credit|debit|card/.test(n)) return 'credit_card';
  if (/wire|transfer|bank/.test(n)) return 'bank_transfer';
  return 'other';
}

function addressOf(r: Record<string, string>): Record<string, string> | null {
  const lines = [r.BADDR1, r.BADDR2, r.BADDR3, r.BADDR4, r.BADDR5, r.ADDR1, r.ADDR2, r.ADDR3].map(opt).filter(Boolean) as string[];
  if (!lines.length) return null;
  const last = lines[lines.length - 1];
  const m = /^(.*?),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/.exec(last);
  if (m) {
    return { line1: lines[0] === last ? '' : lines[0], line2: lines.length > 2 ? lines[1] : '', city: m[1], state: m[2].toUpperCase(), zip: m[3] };
  }
  return { line1: lines[0], line2: lines.slice(1).join(', ') };
}

/** Generic simple-list importer: one createEntry per row whose name is not already on the list. */
async function importSimple(
  ctx: ServiceContext,
  key: SimpleListKey,
  nameField: string,
  rows: IifListRows,
  toBody: (r: Record<string, string>) => Record<string, unknown> | null,
  issues: ListIssue[],
): Promise<number> {
  const existing = await listEntries(ctx, key, { includeInactive: true });
  const names = new Set(existing.map((e) => String(e[nameField] ?? '').toLowerCase()));
  let n = 0;
  for (const r of rows) {
    const body = toBody(r);
    if (!body) continue;
    const name = String(body[nameField] ?? '').trim();
    if (!name || names.has(name.toLowerCase())) continue;
    try {
      await createEntry(ctx, key, body);
      names.add(name.toLowerCase());
      n++;
    } catch (caught) {
      const err = importRowError(caught) ?? caught;
      if (err instanceof ServiceError && (err.code === 'VALIDATION' || err.code === 'NOT_FOUND')) {
        issues.push({ name, message: err.message });
        continue;
      }
      throw err;
    }
  }
  return n;
}

export async function importOtherNames(ctx: ServiceContext, rows: IifListRows, issues: ListIssue[]) {
  return importSimple(ctx, 'other-names', 'name', rows, (r) => {
    const name = opt(r.NAME);
    if (!name) return null;
    const email = opt(r.EMAIL);
    return {
      name,
      companyName: opt(r.COMPANYNAME) ?? null,
      email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
      phone: opt(r.PHONE1) ?? null,
      address: addressOf(r),
      accountNumber: opt(r.ACCNUM) ?? null,
      notes: [opt(r.NOTE), opt(r.CONT1) ? `Contact: ${r.CONT1.trim()}` : undefined].filter(Boolean).join('\n') || null,
      isActive: !yes(r.HIDDEN),
    };
  }, issues);
}

export async function importTerms(ctx: ServiceContext, rows: IifListRows, issues: ListIssue[]) {
  return importSimple(ctx, 'terms', 'name', rows, (r) => {
    const name = opt(r.NAME);
    if (!name) return null;
    const dateDriven = opt(r.TERMSTYPE) === '1' || /date/i.test(r.TERMSTYPE ?? '');
    const disc = pctOf(r.DISCPER);
    const hasDisc = !!disc && Number(disc) > 0;
    if (dateDriven) {
      return {
        name,
        kind: 'date_driven',
        dueDayOfMonth: intOf(r.DUEDAYS) || 1,
        dueNextMonthWithinDays: intOf(r.MINDAYS) ?? 0,
        discountPercent: hasDisc ? disc : null,
        discountDayOfMonth: hasDisc ? intOf(r.DISCDAYS) : null,
        isActive: !yes(r.HIDDEN),
      };
    }
    return {
      name,
      kind: 'standard',
      netDays: intOf(r.DUEDAYS) ?? 0,
      discountPercent: hasDisc ? disc : null,
      discountDays: hasDisc ? intOf(r.DISCDAYS) : null,
      isActive: !yes(r.HIDDEN),
    };
  }, issues);
}

export async function importShipMethods(ctx: ServiceContext, rows: IifListRows, issues: ListIssue[]) {
  return importSimple(ctx, 'ship-via', 'name', rows, (r) => (opt(r.NAME) ? { name: opt(r.NAME), isActive: !yes(r.HIDDEN) } : null), issues);
}

export async function importPaymentMethods(ctx: ServiceContext, rows: IifListRows, issues: ListIssue[]) {
  return importSimple(ctx, 'payment-methods', 'name', rows, (r) => {
    const name = opt(r.NAME);
    return name ? { name, type: paymentMethodTypeFor(name), isActive: !yes(r.HIDDEN) } : null;
  }, issues);
}

export async function importCustomerMessages(ctx: ServiceContext, rows: IifListRows, issues: ListIssue[]) {
  return importSimple(ctx, 'customer-messages', 'message', rows, (r) => {
    const message = opt(r.NAME) ?? opt(r.MESSAGE);
    return message ? { message, isActive: !yes(r.HIDDEN) } : null;
  }, issues);
}

export async function importSalesTaxCodes(ctx: ServiceContext, rows: IifListRows, issues: ListIssue[]) {
  return importSimple(ctx, 'sales-tax-codes', 'code', rows, (r) => {
    const code = opt(r.CODE) ?? opt(r.NAME);
    if (!code) return null;
    return {
      code,
      description: opt(r.DESC) ?? null,
      taxable: r.TAXABLE === undefined || r.TAXABLE.trim() === '' ? !/^non$/i.test(code) : yes(r.TAXABLE),
      isActive: !yes(r.HIDDEN),
    };
  }, issues);
}

export async function importVehicles(ctx: ServiceContext, rows: IifListRows, issues: ListIssue[]) {
  return importSimple(ctx, 'vehicles', 'name', rows, (r) => {
    const name = opt(r.NAME);
    return name ? { name, description: opt(r.DESC) ?? null, isActive: !yes(r.HIDDEN) } : null;
  }, issues);
}

/** JOBTYPE "Parent:Sub" — parents first, each level de-duplicated under its parent. */
export async function importJobTypes(ctx: ServiceContext, rows: IifListRows, issues: ListIssue[]) {
  await listEntries(ctx, 'job-types', { includeInactive: true });
  const existing = await ctx.db
    .select({ id: jobTypes.id, name: jobTypes.name, parentId: jobTypes.parentId })
    .from(jobTypes)
    .where(eq(jobTypes.companyId, ctx.companyId));
  const byId = new Map(existing.map((e) => [e.id, e]));
  const pathOf = (id: string, seen = new Set<string>()): string => {
    const r = byId.get(id);
    if (!r || seen.has(id)) return '';
    seen.add(id);
    return r.parentId ? `${pathOf(r.parentId, seen)}:${r.name}` : r.name;
  };
  const byPath = new Map(existing.map((e) => [pathOf(e.id).toLowerCase(), e.id]));
  const names = new Set(existing.map((e) => e.name.toLowerCase()));
  let n = 0;
  const sorted = rows.filter((r) => opt(r.NAME)).sort((a, b) => a.NAME.split(':').length - b.NAME.split(':').length);
  for (const r of sorted) {
    const segs = r.NAME.split(':').map((s) => s.trim()).filter(Boolean);
    let parentId: string | null = null;
    let path = '';
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      path = path ? `${path}:${seg}` : seg;
      let id = byPath.get(path.toLowerCase());
      if (!id) {
        if (names.has(seg.toLowerCase())) {
          // The list keeps names unique across levels (like QB's flat name check).
          issues.push({ name: r.NAME, message: `A job type named "${seg}" already exists elsewhere in the list.` });
          break;
        }
        try {
          const row = (await createEntry(ctx, 'job-types', {
            name: seg,
            parentId,
            isActive: i === segs.length - 1 ? !yes(r.HIDDEN) : true,
          })) as { id: string };
          id = row.id;
          byPath.set(path.toLowerCase(), id);
          names.add(seg.toLowerCase());
          n++;
        } catch (caught) {
          const err = importRowError(caught) ?? caught;
          if (err instanceof ServiceError && err.code === 'VALIDATION') {
            issues.push({ name: r.NAME, message: err.message });
            break;
          }
          throw err;
        }
      }
      parentId = id;
    }
  }
  return n;
}

export async function importPriceLevels(ctx: ServiceContext, rows: IifListRows, issues: ListIssue[]) {
  const existing = await ctx.db.select({ name: priceLevels.name }).from(priceLevels).where(eq(priceLevels.companyId, ctx.companyId));
  const names = new Set(existing.map((e) => e.name.toLowerCase()));
  let n = 0;
  for (const r of rows) {
    const name = opt(r.NAME);
    if (!name || names.has(name.toLowerCase())) continue;
    const pct = pctOf(r.PERCENT ?? r.PRICELEVELPERCENT ?? r.PERCENTAGE) ?? '0';
    try {
      await createPriceLevel(ctx, { name, type: 'fixed_percent', percent: pct, isActive: !yes(r.HIDDEN) });
      names.add(name.toLowerCase());
      n++;
    } catch (caught) {
      const err = importRowError(caught) ?? caught;
      if (err instanceof ServiceError && err.code === 'VALIDATION') {
        issues.push({ name, message: err.message });
        continue;
      }
      throw err;
    }
  }
  return n;
}

/**
 * The ONE place the IIF import talks to the To Do store. The ux team is unifying the to-do
 * stores; when that lands only this helper changes.
 */
async function importQbTodo(ctx: ServiceContext, t: { title: string; notes: string | null; dueDate: string | null; done: boolean }) {
  return createTodo(ctx, { title: t.title, notes: t.notes, dueDate: t.dueDate, done: t.done, kind: 'task' });
}

function isoDayOf(raw: string | undefined): string | null {
  const s = opt(raw);
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += y < 50 ? 2000 : 1900;
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

/** TODO rows; a to-do with the same text and date as an existing one is not added again. */
export async function importTodos(ctx: ServiceContext, rows: IifListRows, issues: ListIssue[]) {
  const { listTodos } = await import('./todos');
  const existing = await listTodos(ctx, { includeDone: true });
  const keys = new Set(existing.map((t) => `${t.title.toLowerCase()}|${t.dueDate ?? ''}`));
  let n = 0;
  for (const r of rows) {
    const text = opt(r.NOTE) ?? opt(r.DESC) ?? opt(r.MEMO) ?? opt(r.NAME);
    if (!text) continue;
    const title = text.length > 255 ? `${text.slice(0, 252)}...` : text;
    const dueDate = isoDayOf(r.DATE ?? r.ALERTDATE ?? r.DUEDATE ?? r.REMINDDATE);
    const key = `${title.toLowerCase()}|${dueDate ?? ''}`;
    if (keys.has(key)) continue;
    try {
      await importQbTodo(ctx, {
        title,
        notes: text.length > 255 ? text : null,
        dueDate,
        done: yes(r.DONE ?? r.ISDONE),
      });
      keys.add(key);
      n++;
    } catch (caught) {
      const err = importRowError(caught) ?? caught;
      if (err instanceof ServiceError && err.code === 'VALIDATION') {
        issues.push({ name: title, message: err.message });
        continue;
      }
      throw err;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface IifSection {
  name: string;
  cols: string[];
  rows: Array<Record<string, unknown>>;
}

const hidden = (active: unknown) => (active === false ? 'Y' : 'N');
const pctText = (v: unknown) => (v == null || v === '' ? '' : `${Money.of(v as string).toDecimalPlaces(4).toString()}%`);

function addrLines(a: Record<string, string> | null | undefined): string[] {
  if (!a) return [];
  const city = [a.city ? `${a.city},` : '', a.state ?? '', a.zip ?? ''].filter(Boolean).join(' ').replace(/,$/, '').trim();
  return [a.line1, a.line2, city, a.country].filter((x) => x && String(x).trim()) as string[];
}

/** The QB "other lists" as IIF sections (empty sections are skipped by the writer). */
export async function exportOtherListSections(ctx: ServiceContext): Promise<IifSection[]> {
  const out: IifSection[] = [];
  const list = (key: SimpleListKey) => listEntries(ctx, key, { includeInactive: true });

  const terms = await list('terms');
  out.push({
    name: 'TERMS',
    cols: ['NAME', 'DUEDAYS', 'MINDAYS', 'DISCPER', 'DISCDAYS', 'TERMSTYPE', 'HIDDEN'],
    rows: terms.map((t) => {
      const dd = t.kind === 'date_driven';
      return {
        NAME: t.name,
        DUEDAYS: dd ? t.dueDayOfMonth : t.netDays,
        MINDAYS: dd ? t.dueNextMonthWithinDays : '',
        DISCPER: pctText(t.discountPercent),
        DISCDAYS: dd ? t.discountDayOfMonth ?? '' : t.discountDays ?? '',
        TERMSTYPE: dd ? 1 : 0,
        HIDDEN: hidden(t.isActive),
      };
    }),
  });

  const others = await list('other-names');
  out.push({
    name: 'OTHERNAME',
    cols: ['NAME', 'COMPANYNAME', 'BADDR1', 'BADDR2', 'BADDR3', 'BADDR4', 'PHONE1', 'EMAIL', 'ACCNUM', 'NOTE', 'HIDDEN'],
    rows: others.map((o) => {
      const a = addrLines(o.address as Record<string, string> | null);
      return {
        NAME: o.name,
        COMPANYNAME: o.companyName,
        BADDR1: a[0], BADDR2: a[1], BADDR3: a[2], BADDR4: a[3],
        PHONE1: o.phone,
        EMAIL: o.email,
        ACCNUM: o.accountNumber,
        NOTE: o.notes,
        HIDDEN: hidden(o.isActive),
      };
    }),
  });

  out.push({ name: 'SHIPMETH', cols: ['NAME', 'HIDDEN'], rows: (await list('ship-via')).map((s) => ({ NAME: s.name, HIDDEN: hidden(s.isActive) })) });
  out.push({ name: 'PAYMETH', cols: ['NAME', 'HIDDEN'], rows: (await list('payment-methods')).map((s) => ({ NAME: s.name, HIDDEN: hidden(s.isActive) })) });
  out.push({ name: 'CUSTMSG', cols: ['NAME', 'HIDDEN'], rows: (await list('customer-messages')).map((s) => ({ NAME: s.message, HIDDEN: hidden(s.isActive) })) });
  out.push({
    name: 'SALESTAXCODE',
    cols: ['CODE', 'DESC', 'TAXABLE', 'HIDDEN'],
    rows: (await list('sales-tax-codes')).map((s) => ({ CODE: s.code, DESC: s.description, TAXABLE: s.taxable ? 'Y' : 'N', HIDDEN: hidden(s.isActive) })),
  });

  const jt = await list('job-types');
  const jtById = new Map(jt.map((j) => [j.id, j]));
  const jtPath = (id: string, seen = new Set<string>()): string => {
    const j = jtById.get(id);
    if (!j || seen.has(id)) return '';
    seen.add(id);
    return j.parentId ? `${jtPath(j.parentId as string, seen)}:${j.name}` : String(j.name);
  };
  out.push({
    name: 'JOBTYPE',
    cols: ['NAME', 'HIDDEN'],
    rows: jt
      .map((j) => ({ NAME: jtPath(j.id), HIDDEN: hidden(j.isActive) }))
      .sort((a, b) => a.NAME.split(':').length - b.NAME.split(':').length || a.NAME.localeCompare(b.NAME)),
  });
  out.push({
    name: 'VEH',
    cols: ['NAME', 'DESC', 'HIDDEN'],
    rows: (await list('vehicles')).map((v) => ({ NAME: v.name, DESC: v.description, HIDDEN: hidden(v.isActive) })),
  });

  const levels = await ctx.db.select().from(priceLevels).where(eq(priceLevels.companyId, ctx.companyId));
  out.push({
    name: 'PRICELEVEL',
    cols: ['NAME', 'PERCENT', 'HIDDEN'],
    // Per-item levels have no IIF form; only fixed-percent levels are written.
    rows: levels
      .filter((l) => l.type === 'fixed_percent')
      .map((l) => ({ NAME: l.name, PERCENT: pctText(l.percent), HIDDEN: hidden(l.isActive) })),
  });

  const { listTodos } = await import('./todos');
  const todoRows = await listTodos(ctx, { includeDone: true });
  out.push({
    name: 'TODO',
    cols: ['NOTE', 'DATE', 'DONE'],
    rows: todoRows.map((t) => {
      const d = t.dueDate ? t.dueDate.split('-') : null;
      return {
        NOTE: t.notes && t.notes.startsWith(t.title.replace(/\.\.\.$/, '')) ? t.notes : t.title,
        DATE: d ? `${Number(d[1])}/${Number(d[2])}/${d[0]}` : '',
        DONE: t.done ? 'Y' : 'N',
      };
    }),
  });
  return out;
}

/** Lookup by lower-case name for the FK columns customers / vendors / jobs reference. */
export async function listIdMaps(ctx: ServiceContext) {
  const terms = await listEntries(ctx, 'terms', { includeInactive: true });
  const codes = await listEntries(ctx, 'sales-tax-codes', { includeInactive: true });
  const jt = await ctx.db.select({ id: jobTypes.id, name: jobTypes.name }).from(jobTypes).where(and(eq(jobTypes.companyId, ctx.companyId)));
  return {
    termsByName: new Map(terms.filter((t) => t.isActive).map((t) => [String(t.name).toLowerCase(), t.id])),
    taxCodeByCode: new Map(codes.filter((c) => c.isActive).map((c) => [String(c.code).toLowerCase(), { id: c.id, taxable: c.taxable === true }])),
    jobTypeByName: new Map(jt.map((j) => [j.name.toLowerCase(), j.id])),
  };
}
