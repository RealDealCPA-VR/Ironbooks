/**
 * Cash-basis ledger: QuickBooks Desktop's per-transaction cash conversion.
 *
 * HOW QUICKBOOKS DOES IT (and what this module reproduces)
 * ────────────────────────────────────────────────────────
 * On a cash basis, an A/R or A/P document (invoice, credit memo, bill, vendor credit) does not
 * hit income or expense on its own date. Each income / COGS / expense line of that document is
 * recognized when, and in proportion to how much of, the document is settled:
 *
 *   recognized(line, through settlement k) = line amount × (settled through k ÷ document amount)
 *
 * dated on the settling transaction (the customer payment, the bill payment, the credit or the
 * refund). Everything else is already cash and stays exactly as posted: sales receipts, checks,
 * credit-card charges, deposits, paychecks, journal entries, and the discount / exchange
 * gain-loss lines that sit on a payment itself.
 *
 * The conversion is expressed as BALANCED adjustment pairs layered on top of the posted ledger,
 * never as a plug:
 *   - on the document's date, each P&L line is moved off its account onto the document's own
 *     A/R or A/P account ("defer");
 *   - on each settlement, the settled share is moved back from A/R or A/P onto the P&L account
 *     ("recognize").
 * Every pair nets to zero, so a cash-basis trial balance / balance sheet built from
 * ledger + adjustments balances by construction, and cash-basis earnings on the balance sheet
 * always equal cash-basis net income. Over a cycle in which every document is fully settled the
 * adjustments cancel exactly (cumulative rounding), so cash net income == accrual net income.
 *
 * DECISIONS (documented QB behavior)
 * ──────────────────────────────────
 *  - Settlement = payment applications (cash + early-payment discount), credit memos applied to
 *    invoices, bill payment applications (cash + discount), vendor credits applied to bills, and
 *    refunds of credit memos / vendor credits. A credit memo applied to an invoice settles BOTH
 *    documents on the application date, so the credit memo's (negative) income and the invoice's
 *    income are recognized together and net to the cash actually collected.
 *  - Early-payment discounts: the invoice/bill is recognized in full for the settled amount; the
 *    discount line on the payment is a cash-day posting, so net = cash received / paid.
 *  - Sales tax, inventory, retainage and any other balance-sheet line on a document are NOT
 *    deferred — only income / COGS / expense lines are. QB therefore shows the balance-sheet share
 *    of an unpaid document in A/R or A/P on a cash-basis balance sheet (e.g. the $8 tax of an
 *    unpaid $108 invoice), and so does this report.
 *  - COGS posted for an invoice (sourceRef invoice-cogs:<id>) or reversed by a credit memo
 *    (creditmemo-cogs:<id>) belongs to that document and is recognized with it.
 *  - Retainage: the document amount is the billed base (total − retainage), as in QB, where the
 *    retainage line is a balance-sheet line of the invoice. Paying the billed base recognizes the
 *    invoice's income in full; Retainage Receivable stays on the balance sheet until billed.
 *  - Unapplied customer payments / prepayments and unapplied credits recognize nothing until they
 *    are applied (they sit in A/R or A/P as credits), like QB.
 *  - Journal entries that touch A/R or A/P are not converted (QB reports journal entries the
 *    same on both bases).
 *  - Settlement dates: a payment / bill payment counts on its own date (an unapplied amount
 *    applied later also counts on the payment's date, like QB, which links it to the payment).
 *    Any settled amount we cannot date from a link (payment lines entered on the invoice itself,
 *    vendor credits applied to a bill — no application date is stored for those) counts on the
 *    document's own date. A settlement dated before its document counts on the document date.
 */
import { and, eq, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import {
  accounts,
  billPaymentApplications,
  billPayments,
  bills,
  creditApplications,
  creditMemos,
  invoices,
  journalEntries,
  journalEntryLines,
  paymentApplications,
  paymentsReceived,
  vendorCredits,
} from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { TxnTypeKey } from '@/lib/validation/reports';
import type { ServiceContext } from './_base';

export type CashDocKind = 'invoice' | 'credit_memo' | 'bill' | 'vendor_credit';

export interface CashBasisAdjustment {
  accountId: string;
  classId: string | null;
  date: Date;
  /** Signed debit − credit. */
  net: Decimal;
  /** 'defer' moves a document's P&L line onto A/R / A/P; 'recognize' moves a settled share back. */
  kind: 'defer' | 'recognize';
  /** True on the A/R / A/P side of the pair. */
  control: boolean;
  doc: {
    kind: CashDocKind;
    id: string;
    nameType: 'customer' | 'vendor';
    nameId: string;
  };
  /** The settling transaction (recognize only). */
  settle?: {
    entryId: string | null;
    txnType: TxnTypeKey;
    num: string;
    date: Date;
  };
}

export interface CashBasisLedger {
  adjustments: CashBasisAdjustment[];
  /** Journal entries whose P&L lines are fully deferred (each P&L line is reversed on its date). */
  deferredEntryIds: Set<string>;
}

const DOC_PREFIX: Record<string, CashDocKind> = {
  invoice: 'invoice',
  'invoice-cogs': 'invoice',
  credit_memo: 'credit_memo',
  'creditmemo-cogs': 'credit_memo',
  bill: 'bill',
  vendor_credit: 'vendor_credit',
};

interface Settlement {
  date: Date;
  amount: Decimal;
  entryId: string | null;
  txnType: TxnTypeKey;
  num: string;
}

interface DocInfo {
  kind: CashDocKind;
  id: string;
  date: Date;
  nameType: 'customer' | 'vendor';
  nameId: string;
  /** The document amount settlements are measured against (document currency). */
  base: Decimal;
  /** Total settled per the document itself (document currency). */
  settledTotal: Decimal;
  ownEntryId: string | null;
  ownType: TxnTypeKey;
  ownNum: string;
  settlements: Settlement[];
}

const isPL = (t: string) => t === 'revenue' || t === 'expense';
const controlSide = (a: { type: string; subtype: string | null }) =>
  a.type === 'asset' && a.subtype === 'accounts_receivable'
    ? 'ar'
    : a.type === 'liability' && a.subtype === 'accounts_payable'
      ? 'ap'
      : null;

/**
 * Build the cash-basis adjustments for the company, through `to` (inclusive) when given.
 * Adjustments dated after `to` are omitted; callers filter further by date / class / account.
 */
export async function cashBasisLedger(ctx: ServiceContext, opts: { to?: Date } = {}): Promise<CashBasisLedger> {
  const to = opts.to;
  const acctRows = await ctx.db
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const acct = new Map(acctRows.map((a) => [a.id, { type: String(a.type), subtype: a.subtype }]));

  // 1. Posted lines of every A/R / A/P document (and their COGS entries), plus refunds.
  const prefix = sql<string>`split_part(${journalEntries.sourceRef}, ':', 1)`;
  const conds: SQL[] = [
    eq(journalEntries.companyId, ctx.companyId),
    eq(journalEntries.status, 'posted'),
    sql`${prefix} IN ('invoice', 'invoice-cogs', 'credit_memo', 'creditmemo-cogs', 'bill', 'vendor_credit', 'refund')`,
  ];
  if (to) conds.push(lte(journalEntries.date, to));
  const lines = await ctx.db
    .select({
      entryId: journalEntries.id,
      date: journalEntries.date,
      sourceRef: journalEntries.sourceRef,
      accountId: journalEntryLines.accountId,
      classId: journalEntryLines.classId,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(and(...conds));

  type DocLines = { pl: typeof lines; controlAccountId: string | null; entryIds: Set<string> };
  const byDoc = new Map<string, DocLines>();
  const refunds = new Map<string, { entryId: string; date: Date; amount: Decimal }[]>();
  for (const l of lines) {
    const ref = l.sourceRef ?? '';
    const i = ref.indexOf(':');
    const p = ref.slice(0, i);
    const id = ref.slice(i + 1);
    const a = acct.get(l.accountId);
    if (!a) continue;
    if (p === 'refund') {
      // A refund's own control line is the refunded amount (the bank line is the other side).
      if (controlSide(a)) {
        const amt = Money.sub(l.debit ?? 0, l.credit ?? 0).abs();
        const arr = refunds.get(id) ?? [];
        const ex = arr.find((r) => r.entryId === l.entryId);
        if (ex) ex.amount = ex.amount.plus(amt);
        else arr.push({ entryId: l.entryId, date: l.date, amount: amt });
        refunds.set(id, arr);
      }
      continue;
    }
    const kind = DOC_PREFIX[p];
    if (!kind) continue;
    const key = `${kind}:${id}`;
    const d = byDoc.get(key) ?? { pl: [], controlAccountId: null, entryIds: new Set<string>() };
    if (isPL(a.type)) {
      d.pl.push(l);
      d.entryIds.add(l.entryId);
    } else if (controlSide(a) && !d.controlAccountId) {
      d.controlAccountId = l.accountId;
    }
    byDoc.set(key, d);
  }
  const docIds = (k: CashDocKind) =>
    [...byDoc.keys()].filter((key) => key.startsWith(`${k}:`)).map((key) => key.slice(k.length + 1));

  // 2. Document headers + their dated settlements.
  const docs = new Map<string, DocInfo>();
  const invIds = docIds('invoice');
  const cmIds = docIds('credit_memo');
  const billIds = docIds('bill');
  const vcIds = docIds('vendor_credit');

  const cmEntry = new Map<string, string | null>();
  if (cmIds.length) {
    for (const m of await ctx.db
      .select()
      .from(creditMemos)
      .where(eq(creditMemos.companyId, ctx.companyId))) {
      if (!byDoc.has(`credit_memo:${m.id}`)) continue;
      cmEntry.set(m.id, m.postedEntryId);
      docs.set(`credit_memo:${m.id}`, {
        kind: 'credit_memo',
        id: m.id,
        date: m.date,
        nameType: 'customer',
        nameId: m.customerId,
        base: Money.of(m.total),
        settledTotal: Money.sub(m.total, m.unapplied),
        ownEntryId: m.postedEntryId,
        ownType: 'credit_memo',
        ownNum: m.refNumber ?? String(m.memoNumber),
        settlements: [],
      });
    }
  }
  if (invIds.length) {
    for (const v of await ctx.db
      .select()
      .from(invoices)
      .where(eq(invoices.companyId, ctx.companyId))) {
      if (!byDoc.has(`invoice:${v.id}`)) continue;
      docs.set(`invoice:${v.id}`, {
        kind: 'invoice',
        id: v.id,
        date: v.date,
        nameType: 'customer',
        nameId: v.customerId,
        base: Money.sub(v.total, v.retainageAmount ?? 0),
        settledTotal: Money.of(v.amountPaid),
        ownEntryId: v.postedEntryId,
        ownType: 'invoice',
        ownNum: v.refNumber ?? String(v.invoiceNumber),
        settlements: [],
      });
    }
    const pays = await ctx.db
      .select({
        invoiceId: paymentApplications.invoiceId,
        applied: paymentApplications.amountApplied,
        discount: paymentApplications.discountAmount,
        date: paymentsReceived.date,
        entryId: paymentsReceived.postedEntryId,
        reference: paymentsReceived.reference,
      })
      .from(paymentApplications)
      .innerJoin(paymentsReceived, eq(paymentApplications.paymentId, paymentsReceived.id))
      .where(
        and(
          eq(paymentsReceived.companyId, ctx.companyId),
          isNull(paymentsReceived.voidedAt),
        ),
      );
    for (const p of pays) {
      docs.get(`invoice:${p.invoiceId}`)?.settlements.push({
        date: p.date,
        amount: Money.add(p.applied, p.discount),
        entryId: p.entryId,
        txnType: 'payment',
        num: p.reference ?? '',
      });
    }
  }
  if (invIds.length || cmIds.length) {
    const credits = await ctx.db
      .select()
      .from(creditApplications)
      .where(eq(creditApplications.companyId, ctx.companyId));
    for (const c of credits) {
      const memo = docs.get(`credit_memo:${c.creditMemoId}`);
      const s: Settlement = {
        date: c.date,
        amount: Money.of(c.amount),
        entryId: cmEntry.get(c.creditMemoId) ?? null,
        txnType: 'credit_memo',
        num: memo?.ownNum ?? '',
      };
      docs.get(`invoice:${c.invoiceId}`)?.settlements.push(s);
      memo?.settlements.push({ ...s });
    }
  }
  if (billIds.length) {
    for (const b of await ctx.db
      .select()
      .from(bills)
      .where(eq(bills.companyId, ctx.companyId))) {
      if (!byDoc.has(`bill:${b.id}`)) continue;
      docs.set(`bill:${b.id}`, {
        kind: 'bill',
        id: b.id,
        date: b.date,
        nameType: 'vendor',
        nameId: b.vendorId,
        base: Money.of(b.total),
        settledTotal: Money.add(b.amountPaid, b.amountCredited),
        ownEntryId: b.postedEntryId,
        ownType: 'bill',
        ownNum: b.billNumber ?? '',
        settlements: [],
      });
    }
    const pays = await ctx.db
      .select({
        billId: billPaymentApplications.billId,
        applied: billPaymentApplications.amountApplied,
        date: billPayments.date,
        entryId: billPayments.postedEntryId,
        reference: billPayments.reference,
      })
      .from(billPaymentApplications)
      .innerJoin(billPayments, eq(billPaymentApplications.billPaymentId, billPayments.id))
      .where(
        and(
          eq(billPayments.companyId, ctx.companyId),
          isNull(billPayments.voidedAt),
        ),
      );
    for (const p of pays) {
      docs.get(`bill:${p.billId}`)?.settlements.push({
        date: p.date,
        amount: Money.of(p.applied),
        entryId: p.entryId,
        txnType: 'bill_payment',
        num: p.reference ?? '',
      });
    }
  }
  if (vcIds.length) {
    for (const c of await ctx.db
      .select()
      .from(vendorCredits)
      .where(eq(vendorCredits.companyId, ctx.companyId))) {
      if (!byDoc.has(`vendor_credit:${c.id}`)) continue;
      docs.set(`vendor_credit:${c.id}`, {
        kind: 'vendor_credit',
        id: c.id,
        date: c.date,
        nameType: 'vendor',
        nameId: c.vendorId,
        base: Money.of(c.total),
        settledTotal: Money.sub(c.total, c.unapplied),
        ownEntryId: c.postedEntryId,
        ownType: 'bill_credit',
        ownNum: '',
        settlements: [],
      });
    }
  }
  // Refunds of credit memos / vendor credits (refunds of unapplied payments carry no P&L).
  for (const [id, list] of refunds) {
    const d = docs.get(`credit_memo:${id}`) ?? docs.get(`vendor_credit:${id}`);
    if (!d) continue;
    for (const r of list) d.settlements.push({ date: r.date, amount: r.amount, entryId: r.entryId, txnType: 'refund', num: '' });
  }

  // 3. Adjustments.
  const adjustments: CashBasisAdjustment[] = [];
  const deferredEntryIds = new Set<string>();
  for (const [key, dl] of byDoc) {
    const doc = docs.get(key);
    if (!doc || dl.pl.length === 0 || !dl.controlAccountId || !doc.base.greaterThan(0)) continue;

    // Undated remainder of what the document says is settled counts on the document date.
    const dated = doc.settlements.reduce((s, x) => s.plus(x.amount), Money.zero());
    const rest = doc.settledTotal.minus(dated);
    const events: Settlement[] = [...doc.settlements];
    if (rest.greaterThan(0)) {
      events.push({ date: doc.date, amount: rest, entryId: doc.ownEntryId, txnType: doc.ownType, num: doc.ownNum });
    }
    events.sort((a, b) => a.date.getTime() - b.date.getTime());

    // Group the document's P&L lines by account + class + date.
    const groups = new Map<string, { accountId: string; classId: string | null; date: Date; net: Decimal }>();
    for (const l of dl.pl) {
      const gk = `${l.accountId}|${l.classId ?? ''}|${l.date.getTime()}`;
      const g = groups.get(gk) ?? { accountId: l.accountId, classId: l.classId, date: l.date, net: Money.zero() };
      g.net = g.net.plus(Money.sub(l.debit ?? 0, l.credit ?? 0));
      groups.set(gk, g);
    }
    for (const id of dl.entryIds) deferredEntryIds.add(id);
    const docRef = { kind: doc.kind, id: doc.id, nameType: doc.nameType, nameId: doc.nameId };
    const ctrl = dl.controlAccountId;

    for (const g of groups.values()) {
      if (g.net.isZero()) continue;
      adjustments.push(
        { accountId: g.accountId, classId: g.classId, date: g.date, net: g.net.negated(), kind: 'defer', control: false, doc: docRef },
        { accountId: ctrl, classId: g.classId, date: g.date, net: g.net, kind: 'defer', control: true, doc: docRef },
      );
      let cum = Money.zero();
      let prev = Money.zero();
      for (const e of events) {
        if (!e.amount.greaterThan(0)) continue;
        cum = cum.plus(e.amount);
        const frac = Money.gte(cum, doc.base) ? Money.of(1) : Money.div(cum, doc.base);
        // Cumulative rounding: the last settlement lands exactly on the line amount.
        const through = Money.round2(Money.mul(g.net, frac));
        const inc = through.minus(prev);
        prev = through;
        if (inc.isZero()) continue;
        const date = e.date < g.date ? g.date : e.date;
        if (to && date > to) continue;
        const settle = { entryId: e.entryId, txnType: e.txnType, num: e.num, date };
        adjustments.push(
          { accountId: g.accountId, classId: g.classId, date, net: inc, kind: 'recognize', control: false, doc: docRef, settle },
          { accountId: ctrl, classId: g.classId, date, net: inc.negated(), kind: 'recognize', control: true, doc: docRef, settle },
        );
      }
    }
  }
  return { adjustments, deferredEntryIds };
}

/**
 * Filter adjustments the same way activityByAccount filters posted lines and aggregate them
 * into its row shape (debit / credit per account and bucket).
 */
export function cashActivityRows(
  adjustments: CashBasisAdjustment[],
  f: { from?: Date; to?: Date; classId?: string; accountIds?: string[] },
  bucket: 'none' | 'day' | 'month' | 'class',
): { accountId: string; bucket: string | null; debit: string; credit: string }[] {
  const ids = f.accountIds ? new Set(f.accountIds) : null;
  const agg = new Map<string, { accountId: string; bucket: string | null; net: Decimal }>();
  for (const a of adjustments) {
    if (f.from && a.date < f.from) continue;
    if (f.to && a.date > f.to) continue;
    if (f.classId && a.classId !== f.classId) continue;
    if (ids && !ids.has(a.accountId)) continue;
    const iso = a.date.toISOString();
    const b =
      bucket === 'day' ? iso.slice(0, 10) : bucket === 'month' ? iso.slice(0, 7) : bucket === 'class' ? (a.classId ?? '') : null;
    const k = `${a.accountId}|${b ?? ''}`;
    const r = agg.get(k) ?? { accountId: a.accountId, bucket: b, net: Money.zero() };
    r.net = r.net.plus(a.net);
    agg.set(k, r);
  }
  return [...agg.values()]
    .filter((r) => !r.net.isZero())
    .map((r) => ({
      accountId: r.accountId,
      bucket: r.bucket,
      debit: r.net.greaterThan(0) ? r.net.toFixed(2) : '0',
      credit: r.net.lessThan(0) ? r.net.negated().toFixed(2) : '0',
    }));
}
