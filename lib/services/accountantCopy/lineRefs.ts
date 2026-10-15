/**
 * General Journal line references for the Accountant's Copy changes file (PARITY I1).
 *
 * Journal applications (a General Journal credit applied to an invoice / bill / charge, the General
 * Journal charges a payment paid) and reconciliations (the lines a statement cleared) point at
 * journal_entry_lines rows. Lines of entries that existed when the copy was made have the same id
 * in both files; lines of entries the accountant posted or re-posted (a new invoice, an edited
 * check, a new General Journal entry) get new ids when the import re-creates the record. So the
 * accountant side describes every line (lineRefOf: its id, its entry, the record that owns the
 * entry, account, amount, name) and the client side finds the matching line after the earlier
 * changes were applied (resolveLineRef).
 */
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { journalEntries, journalEntryLines } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError } from '../_base';
import type { LineRef } from './format';

/** Records whose own row names the entry they posted (posted_entry_id). */
const OWNER_TABLES: Record<string, string> = {
  invoice: 'invoices',
  sales_receipt: 'sales_receipts',
  credit_memo: 'credit_memos',
  payment_received: 'payments_received',
  bill: 'bills',
  bill_payment: 'bill_payments',
  vendor_credit: 'vendor_credits',
  item_receipt: 'item_receipts',
  transfer: 'transfers',
  deposit: 'deposits',
  expense: 'expenses',
};

const amt = (v: string | null | undefined) => (v != null && Number(v) !== 0 ? toAmountString(v) : null);
const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Accountant side: describe a journal line (company-scoped; null when it is not in this file). */
export async function lineRefOf(ctx: Pick<ServiceContext, 'db' | 'companyId'>, lineId: string): Promise<LineRef | null> {
  const [row] = await ctx.db
    .select({
      id: journalEntryLines.id,
      entryId: journalEntryLines.journalEntryId,
      accountId: journalEntryLines.accountId,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      entityId: journalEntryLines.entityId,
      sourceRef: journalEntries.sourceRef,
      date: journalEntries.date,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
    .where(and(eq(journalEntryLines.id, lineId), eq(journalEntries.companyId, ctx.companyId)));
  if (!row) return null;
  return {
    lineId: row.id,
    entryId: row.entryId,
    sourceRef: row.sourceRef,
    date: new Date(row.date).toISOString(),
    accountId: row.accountId,
    debit: amt(row.debit),
    credit: amt(row.credit),
    entityId: row.entityId,
    owner: await ownerOfEntry(ctx, row.entryId, row.sourceRef),
  };
}

async function ownerOfEntry(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  entryId: string,
  sourceRef: string | null,
): Promise<LineRef['owner']> {
  const parts = Object.entries(OWNER_TABLES).map(
    ([type, table]) =>
      sql`SELECT ${type}::text AS type, id::text AS id FROM ${sql.raw(table)} WHERE company_id = ${ctx.companyId}::uuid AND posted_entry_id = ${entryId}::uuid`,
  );
  const res = await ctx.db.execute(sql`${sql.join(parts, sql` UNION ALL `)} LIMIT 1`);
  const found = (res as unknown as { rows: Array<{ type: string; id: string }> }).rows[0];
  if (found) return { type: found.type, id: found.id };
  if (sourceRef === null || sourceRef === 'manual' || sourceRef.startsWith('reversal:')) return { type: 'journal_entry', id: entryId };
  return null;
}

export type IdMap = Map<string, string>;

/**
 * Journal lines resolved so far in one import: accountant line id → client line id. References
 * naming the SAME accountant line (one General Journal credit split across two invoices, one
 * charge paid by two partial payments, ...) resolve to the same client line; two DIFFERENT
 * accountant lines that look alike (same account, amount and name) never land on one client line.
 */
export type LineMap = Map<string, string>;

/**
 * Client side: the journal line the reference names, after the changes applied so far
 * (`idMap`: accountant id → id of the record the import created; `lines`: see LineMap).
 */
export async function resolveLineRef(
  ctx: Pick<ServiceContext, 'db' | 'companyId'>,
  ref: LineRef,
  idMap: IdMap,
  lines: LineMap,
): Promise<string> {
  const mapId = (id: string | null) => (id ? idMap.get(id) ?? id : id);
  const postedLine = async (id: string) => {
    const [row] = await ctx.db
      .select({ id: journalEntryLines.id })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
      .where(and(eq(journalEntryLines.id, id), eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted')));
    return row?.id ?? null;
  };
  // 0. Already resolved for an earlier reference to the same accountant line (and still posted).
  const known = lines.get(ref.lineId);
  if (known && (await postedLine(known))) return known;
  if (known) lines.delete(ref.lineId);
  /** Client lines already taken by a different accountant line. */
  const taken = new Set<string>([...lines.values()]);
  const claim = (id: string) => {
    lines.set(ref.lineId, id);
    return id;
  };
  // 1. The same line (it existed when the copy was made and is still posted).
  if (!idMap.has(ref.entryId)) {
    const same = await postedLine(ref.lineId);
    if (same && !taken.has(same)) return claim(same);
  }
  // 2. The entry that now carries it: through the owning record, else the source reference.
  const entryIds = new Set<string>();
  if (ref.owner?.type === 'journal_entry') {
    entryIds.add(mapId(ref.entryId)!);
  } else if (ref.owner && OWNER_TABLES[ref.owner.type]) {
    if (ref.owner.type === 'transfer' && idMap.has(ref.entryId)) entryIds.add(idMap.get(ref.entryId)!);
    const res = await ctx.db.execute(
      sql`SELECT posted_entry_id::text AS id FROM ${sql.raw(OWNER_TABLES[ref.owner.type])} WHERE company_id = ${ctx.companyId}::uuid AND id = ${mapId(ref.owner.id)}::uuid`,
    );
    const r = (res as unknown as { rows: Array<{ id: string | null }> }).rows[0];
    if (r?.id) entryIds.add(r.id);
  }
  const day = ref.date.slice(0, 10);
  if (ref.sourceRef && ref.sourceRef !== 'manual') {
    const mappedRef = ref.sourceRef.replace(UUID_G, (u) => idMap.get(u) ?? u);
    for (const e of await ctx.db
      .select({ id: journalEntries.id, date: journalEntries.date })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, mappedRef), eq(journalEntries.status, 'posted')))) {
      if (new Date(e.date).toISOString().slice(0, 10) === day) entryIds.add(e.id);
    }
  } else if (entryIds.size === 0) {
    for (const e of await ctx.db
      .select({ id: journalEntries.id, date: journalEntries.date })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.status, 'posted'),
          or(isNull(journalEntries.sourceRef), eq(journalEntries.sourceRef, 'manual')),
        ),
      )) {
      if (new Date(e.date).toISOString().slice(0, 10) === day) entryIds.add(e.id);
    }
  }
  if (entryIds.size) {
    const lines = await ctx.db
      .select({
        id: journalEntryLines.id,
        accountId: journalEntryLines.accountId,
        debit: journalEntryLines.debit,
        credit: journalEntryLines.credit,
        entityId: journalEntryLines.entityId,
        status: journalEntries.status,
      })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
      .where(and(inArray(journalEntryLines.journalEntryId, [...entryIds]), eq(journalEntries.companyId, ctx.companyId)))
      .orderBy(asc(journalEntryLines.createdAt), asc(journalEntryLines.id));
    const want = { account: mapId(ref.accountId), debit: Money.of(ref.debit ?? 0), credit: Money.of(ref.credit ?? 0), entity: mapId(ref.entityId) };
    const hit = lines.find(
      (l) =>
        l.status === 'posted' &&
        !taken.has(l.id) &&
        l.accountId === want.account &&
        Money.of(l.debit ?? 0).equals(want.debit) &&
        Money.of(l.credit ?? 0).equals(want.credit) &&
        (l.entityId ?? null) === (want.entity ?? null),
    );
    if (hit) return claim(hit.id);
  }
  const side = ref.debit ? `debit ${ref.debit}` : `credit ${ref.credit ?? '0.00'}`;
  throw new ServiceError(
    'NOT_FOUND',
    `The journal line it refers to (${side}, dated ${day}) is not in your file.`,
  );
}
