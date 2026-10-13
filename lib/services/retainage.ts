/**
 * Retainage (holdback) — billing/release workflow and the "Retainage by customer" report.
 *
 * How it works (QuickBooks contractor files):
 *  - An invoice with a retainage % holds part of its total back: that part is debited to
 *    Retainage Receivable (account 1250, an Other Current Asset) instead of A/R, so it is not
 *    in A/R aging until it is billed (invoices.ts prepareInvoice / postInvoiceGL).
 *  - When the work is accepted the contractor BILLS the retainage: a normal invoice with one
 *    line on account 1250. That posts Dr A/R / Cr Retainage Receivable — the held amount moves
 *    into A/R, where it is collected with Receive Payments like any other invoice.
 *
 * Held      = retainage on the customer's posted (non-void, non-pending) invoices
 * Billed    = invoice lines on the retainage account (posted, non-void)
 * Open      = Held − Billed  (what is still sitting in Retainage Receivable)
 *
 * Every number here is derived from the documents AND checked against the general ledger
 * (`glOpen` = the 1250 balance from those invoices' journal entries), so the report always ties
 * to the balance sheet.
 */
import { and, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import {
  accounts,
  customers,
  invoiceLines,
  invoices,
  journalEntries,
  journalEntryLines,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { createInvoice } from './invoices';
import { docRef } from './docNumbers';

export const RETAINAGE_ACCOUNT_CODE = '1250';

export interface RetainageInvoiceRow {
  invoiceId: string;
  refNumber: string;
  date: string;
  /** 'held' = an invoice that held retainage back; 'billed' = an invoice that billed it. */
  kind: 'held' | 'billed';
  amount: string;
}

export interface RetainageCustomerRow {
  customerId: string;
  displayName: string;
  held: string;
  billed: string;
  /** Still held in Retainage Receivable (held − billed). */
  open: string;
  /** The same figure from the general ledger (account 1250, this customer's invoices). */
  glOpen: string;
  documents: RetainageInvoiceRow[];
}

export interface RetainageReport {
  asOf: string | null;
  rows: RetainageCustomerRow[];
  totalHeld: string;
  totalBilled: string;
  totalOpen: string;
  /** Balance of the Retainage Receivable account (all postings) as of the date. */
  accountBalance: string;
  /** totalOpen equals the account balance (and every customer's open equals its GL figure). */
  ties: boolean;
}

async function retainageAccountId(ctx: ServiceContext): Promise<string | null> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, RETAINAGE_ACCOUNT_CODE)));
  return row?.id ?? null;
}

const dayAfter = (d: Date) => new Date(d.getTime() + 86_400_000);
const iso = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

/** Retainage held / billed / open by customer (optionally as of a date, for one customer). */
export async function retainageReport(
  ctx: ServiceContext,
  opts: { asOf?: Date | null; customerId?: string | null } = {},
): Promise<RetainageReport> {
  const asOf = opts.asOf ?? null;
  const acctId = await retainageAccountId(ctx);
  const empty: RetainageReport = {
    asOf: asOf ? iso(asOf) : null,
    rows: [],
    totalHeld: '0.00',
    totalBilled: '0.00',
    totalOpen: '0.00',
    accountBalance: '0.00',
    ties: true,
  };
  if (!acctId) return empty;

  const invConds = [
    eq(invoices.companyId, ctx.companyId),
    notInArray(invoices.status, ['void', 'draft']),
  ];
  if (asOf) invConds.push(lt(invoices.date, dayAfter(asOf)));
  if (opts.customerId) invConds.push(eq(invoices.customerId, opts.customerId));

  // Held: invoices with retainage (home currency = retainage × exchange rate).
  const heldRows = await ctx.db
    .select({
      id: invoices.id,
      customerId: invoices.customerId,
      refNumber: invoices.refNumber,
      invoiceNumber: invoices.invoiceNumber,
      date: invoices.date,
      retainageAmount: invoices.retainageAmount,
      exchangeRate: invoices.exchangeRate,
    })
    .from(invoices)
    .where(and(...invConds, sql`CAST(${invoices.retainageAmount} AS NUMERIC) <> 0`));

  // Billed: invoice lines on the retainage account.
  const billedRows = await ctx.db
    .select({
      id: invoices.id,
      customerId: invoices.customerId,
      refNumber: invoices.refNumber,
      invoiceNumber: invoices.invoiceNumber,
      date: invoices.date,
      exchangeRate: invoices.exchangeRate,
      amount: sql<string>`SUM(CAST(${invoiceLines.amount} AS NUMERIC))`,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(and(...invConds, eq(invoiceLines.accountId, acctId)))
    .groupBy(invoices.id);

  // GL: the retainage account's movement from each customer's invoice entries.
  const glConds = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
    eq(journalEntryLines.accountId, acctId),
  ];
  if (asOf) glConds.push(lt(journalEntries.date, dayAfter(asOf)));
  const glByInvoice = await ctx.db
    .select({
      sourceRef: journalEntries.sourceRef,
      net: sql<string>`SUM(CAST(COALESCE(${journalEntryLines.debit}, '0') AS NUMERIC) - CAST(COALESCE(${journalEntryLines.credit}, '0') AS NUMERIC))`,
      debit: sql<string>`SUM(CAST(COALESCE(${journalEntryLines.debit}, '0') AS NUMERIC))`,
      credit: sql<string>`SUM(CAST(COALESCE(${journalEntryLines.credit}, '0') AS NUMERIC))`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
    .where(and(...glConds))
    .groupBy(journalEntries.sourceRef);
  const glNet = new Map(glByInvoice.map((r) => [r.sourceRef ?? '', Money.of(r.net ?? '0')]));
  // The posted 1250 amounts per invoice (home currency). postInvoiceGL penny-allocates the
  // home-currency entry, so for foreign-currency invoices round2(amount x rate) can be a cent
  // off; held/billed come from the invoice's own 1250 journal lines when it has them.
  const glDebit = new Map(glByInvoice.map((r) => [r.sourceRef ?? '', Money.of(r.debit ?? '0')]));
  const glCredit = new Map(glByInvoice.map((r) => [r.sourceRef ?? '', Money.of(r.credit ?? '0')]));
  const accountBalance = glByInvoice.reduce((s, r) => s.plus(Money.of(r.net ?? '0')), Money.zero());

  const custIds = [...new Set([...heldRows, ...billedRows].map((r) => r.customerId))];
  const names = custIds.length
    ? await ctx.db
        .select({ id: customers.id, displayName: customers.displayName })
        .from(customers)
        .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, custIds)))
    : [];
  const nameById = new Map(names.map((n) => [n.id, n.displayName]));

  type Dec = ReturnType<typeof Money.zero>;
  type Acc = { held: Dec; billed: Dec; gl: Dec; docs: RetainageInvoiceRow[]; invIds: Set<string> };
  const byCust = new Map<string, Acc>();
  const acc = (id: string): Acc => {
    let a = byCust.get(id);
    if (!a) {
      a = { held: Money.zero(), billed: Money.zero(), gl: Money.zero(), docs: [], invIds: new Set() };
      byCust.set(id, a);
    }
    return a;
  };
  for (const r of heldRows) {
    const a = acc(r.customerId);
    const amt = Money.round2(glDebit.get(`invoice:${r.id}`) ?? Money.mul(r.retainageAmount, r.exchangeRate ?? '1'));
    a.held = a.held.plus(amt);
    a.invIds.add(r.id);
    a.docs.push({ invoiceId: r.id, refNumber: docRef(r.refNumber, r.invoiceNumber), date: iso(r.date), kind: 'held', amount: toAmountString(amt) });
  }
  for (const r of billedRows) {
    const a = acc(r.customerId);
    const amt = Money.round2(glCredit.get(`invoice:${r.id}`) ?? Money.mul(r.amount ?? '0', r.exchangeRate ?? '1'));
    a.billed = a.billed.plus(amt);
    a.invIds.add(r.id);
    a.docs.push({ invoiceId: r.id, refNumber: docRef(r.refNumber, r.invoiceNumber), date: iso(r.date), kind: 'billed', amount: toAmountString(amt) });
  }

  let totalHeld = Money.zero();
  let totalBilled = Money.zero();
  let ties = true;
  const rows: RetainageCustomerRow[] = [];
  for (const [customerId, a] of byCust) {
    for (const id of a.invIds) a.gl = a.gl.plus(glNet.get(`invoice:${id}`) ?? Money.zero());
    const open = Money.round2(a.held.minus(a.billed));
    if (!Money.round2(a.gl).eq(open)) ties = false;
    totalHeld = totalHeld.plus(a.held);
    totalBilled = totalBilled.plus(a.billed);
    a.docs.sort((x, y) => x.date.localeCompare(y.date) || x.refNumber.localeCompare(y.refNumber));
    rows.push({
      customerId,
      displayName: nameById.get(customerId) ?? '',
      held: toAmountString(a.held),
      billed: toAmountString(a.billed),
      open: toAmountString(open),
      glOpen: toAmountString(a.gl),
      documents: a.docs,
    });
  }
  rows.sort((x, y) => x.displayName.localeCompare(y.displayName));
  const totalOpen = Money.round2(totalHeld.minus(totalBilled));
  // The whole-account tie only makes sense for the all-customer report.
  if (!opts.customerId && !Money.round2(accountBalance).eq(totalOpen)) ties = false;
  return {
    asOf: asOf ? iso(asOf) : null,
    rows,
    totalHeld: toAmountString(totalHeld),
    totalBilled: toAmountString(totalBilled),
    totalOpen: toAmountString(totalOpen),
    accountBalance: toAmountString(opts.customerId ? rows.reduce((s, r) => s.plus(Money.of(r.glOpen)), Money.zero()) : accountBalance),
    ties,
  };
}

/** What is still held for one customer (home currency). */
export async function openRetainage(ctx: ServiceContext, customerId: string): Promise<string> {
  const rep = await retainageReport(ctx, { customerId });
  return rep.rows[0]?.open ?? '0.00';
}

export interface BillRetainageInput {
  customerId: string;
  date: Date;
  /** Amount to release; defaults to everything still held for the customer. */
  amount?: string | number | null;
  dueDate?: Date | null;
  memo?: string | null;
  refNumber?: string | null;
  allowDuplicateNumber?: boolean | null;
  classId?: string | null;
  /** The user saw the credit-limit warning and chose to bill anyway. */
  overrideCreditLimit?: boolean;
}

/**
 * Bill released retainage: creates a normal invoice with one non-taxable line on Retainage
 * Receivable, which posts Dr A/R / Cr Retainage Receivable. The amount can't exceed what is
 * still held for the customer. The closing date is enforced by the invoice posting.
 */
export async function billRetainage(ctx: ServiceContext, input: BillRetainageInput) {
  const [cust] = await ctx.db
    .select({ id: customers.id, displayName: customers.displayName })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, input.customerId)));
  if (!cust) throw notFound('Customer');
  const acctId = await retainageAccountId(ctx);
  if (!acctId) {
    throw new ServiceError('CONFLICT', `${cust.displayName} has no retainage to bill.`);
  }

  return inTransaction(ctx, async (tx) => {
    // One release at a time per customer, so two clicks can't bill the same retainage twice.
    await tx.db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`retainage:${tx.companyId}:${input.customerId}`}))`,
    );
    const open = Money.of(await openRetainage(tx, input.customerId));
    if (!open.greaterThan(0)) {
      throw new ServiceError('CONFLICT', `${cust.displayName} has no retainage left to bill.`);
    }
    const amount = input.amount != null && input.amount !== '' ? Money.round2(input.amount) : open;
    if (!amount.greaterThan(0)) throw validation('Enter an amount of retainage to bill.');
    if (amount.greaterThan(open)) {
      throw validation(
        `Only ${toAmountString(open)} of retainage is still held for ${cust.displayName}, so you can't bill ${toAmountString(amount)}.`,
      );
    }
    const invoice = await createInvoice(tx, {
      customerId: input.customerId,
      date: input.date,
      dueDate: input.dueDate ?? null,
      refNumber: input.refNumber ?? null,
      allowDuplicateNumber: input.allowDuplicateNumber ?? null,
      taxRateId: null,
      classId: input.classId ?? null,
      overrideCreditLimit: input.overrideCreditLimit,
      memo: input.memo ?? 'Retainage billed',
      lines: [
        {
          description: 'Retainage billed',
          quantity: 1,
          rate: toAmountString(amount),
          accountId: acctId,
          taxable: false,
        },
      ],
    });
    await writeAudit(tx, {
      action: 'create',
      entityType: 'retainage_billing',
      entityId: invoice.id,
      newValues: {
        customerId: input.customerId,
        invoiceId: invoice.id,
        amount: toAmountString(amount),
        heldBefore: toAmountString(open),
        heldAfter: toAmountString(open.minus(amount)),
      },
    });
    return invoice;
  });
}
