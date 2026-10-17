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
 *    Payment lines entered on the invoice itself (QB "Payment" items) are cash received with
 *    the invoice, so they count on the invoice date. A vendor credit applied to a bill counts, for both
 *    documents, on the day it was applied (the audit row written by applyToBill / unapplyFromBill;
 *    no earlier than either document), as QB recognizes it on the Pay Bills date — a later
 *    application never changes an earlier period. Any settled amount that still cannot be dated
 *    (legacy data with no audit row) counts on the document's own date. A settlement dated
 *    before its document counts on the document date.
 *  - Rounding: the document's P&L recognized through each settlement is rounded once (per sign
 *    group: income vs. COGS) and split across the lines by a house-monotone divisor method, so
 *    every settlement recognizes exactly its share of the cash (no 9.99 for 10.00), a payment
 *    never moves any line against its sign, and every line ties out to its own amount when fully
 *    settled.
 *  - Bounced checks: the payment's applications are deleted but snapshotted on the
 *    bounced-check row; the paid share stays recognized on the original payment date and is
 *    reversed on the bounce date (no past period changes).
 */
import { and, eq, isNull, lte, sql, type SQL } from 'drizzle-orm';
import DecimalValue from 'decimal.js';
type Decimal = DecimalValue;
import {
  accounts,
  auditLogs,
  billPaymentApplications,
  billPayments,
  bills,
  bouncedChecks,
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
    /** The document's own posted entry (QuickZoom target for 'defer' lines). */
    entryId: string | null;
    num: string;
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

/**
 * The calendar day (on this computer) a timestamp falls on, at UTC midnight — the convention
 * stored document dates use.
 */
const calendarDay = (t: Date) => new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()));

const isPL = (t: string) => t === 'revenue' || t === 'expense';
const controlSide = (a: { type: string; subtype: string | null }) =>
  a.type === 'asset' && a.subtype === 'accounts_receivable'
    ? 'ar'
    : a.type === 'liability' && a.subtype === 'accounts_payable'
      ? 'ap'
      : null;

/**
 * The last instant of `d`'s UTC day. The accrual reports count the WHOLE as-of / "to" day
 * (journal.ts onOrBeforeDay), so cash-basis reports that layer these adjustments on an accrual
 * figure must bound them the same way (a payment at 15:00 on the as-of day settles in it).
 * Idempotent for an end-of-day input.
 */
export function endOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - 1);
}

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
  if (invIds.length) {
    // Bounced checks: recordBouncedCheck deletes the payment's applications (snapshotted on the
    // bounced-check row). The paid share stays recognized on the ORIGINAL payment date (a past
    // period is never rewritten) and is reversed on the bounce date, as QB does.
    const bounced = await ctx.db
      .select({
        date: bouncedChecks.date,
        applications: bouncedChecks.applications,
        reversalEntryId: bouncedChecks.reversalEntryId,
        payDate: paymentsReceived.date,
        payEntryId: paymentsReceived.postedEntryId,
        reference: paymentsReceived.reference,
      })
      .from(bouncedChecks)
      .innerJoin(paymentsReceived, eq(bouncedChecks.paymentId, paymentsReceived.id))
      .where(eq(bouncedChecks.companyId, ctx.companyId));
    for (const b of bounced) {
      for (const a of b.applications ?? []) {
        const doc = docs.get(`invoice:${a.invoiceId}`);
        const amount = Money.add(a.amountApplied ?? 0, a.discountAmount ?? 0);
        if (!doc || !amount.greaterThan(0)) continue;
        doc.settlements.push(
          { date: b.payDate, amount, entryId: b.payEntryId, txnType: 'payment', num: b.reference ?? '' },
          { date: b.date, amount: amount.negated(), entryId: b.reversalEntryId, txnType: 'journal', num: b.reference ?? '' },
        );
      }
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
  // Vendor credits applied to bills (vendorCredits.applyToBill / unapplyFromBill). These write
  // no GL entry and no dated link row; the audit trail records each (credit, bill, amount) at
  // the moment it happened. QB recognizes a bill credit on a cash basis when it is APPLIED (the
  // Pay Bills date), so each application / unapplication settles BOTH documents on the calendar
  // day its own audit row was written — never earlier than either document (floor), and never
  // reaching back into a period that may already be closed. Applications and unapplications are
  // netted per (credit, bill, day); an unapplication on a later day reverses on that day.
  if (billIds.length || vcIds.length) {
    const rows = await ctx.db
      .select({ creditId: auditLogs.entityId, newValues: auditLogs.newValues, createdAt: auditLogs.createdAt })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, ctx.companyId),
          eq(auditLogs.entityType, 'vendor_credit'),
          sql`${auditLogs.newValues}->>'action' IN ('applied_to_bill', 'unapplied_from_bill')`,
        ),
      );
    if (rows.length) {
      const vcHead = new Map(
        (
          await ctx.db
            .select({ id: vendorCredits.id, date: vendorCredits.date, entryId: vendorCredits.postedEntryId })
            .from(vendorCredits)
            .where(eq(vendorCredits.companyId, ctx.companyId))
        ).map((c) => [c.id, c]),
      );
      const billHead = new Map(
        (
          await ctx.db
            .select({ id: bills.id, date: bills.date, entryId: bills.postedEntryId, num: bills.billNumber })
            .from(bills)
            .where(eq(bills.companyId, ctx.companyId))
        ).map((b) => [b.id, b]),
      );
      const net = new Map<string, { creditId: string; billId: string; date: Date; amount: Decimal }>();
      for (const r of rows) {
        const nv = (r.newValues ?? {}) as { action?: string; billId?: string; amount?: string };
        if (!nv.billId) continue;
        const c = vcHead.get(r.creditId);
        const b = billHead.get(nv.billId);
        if (!c || !b) continue;
        let date = calendarDay(r.createdAt);
        if (c.date > date) date = c.date;
        if (b.date > date) date = b.date;
        const k = `${r.creditId}|${nv.billId}|${date.getTime()}`;
        const e = net.get(k) ?? { creditId: r.creditId, billId: nv.billId, date, amount: Money.zero() };
        const a = Money.of(nv.amount ?? '0');
        e.amount = nv.action === 'applied_to_bill' ? e.amount.plus(a) : e.amount.minus(a);
        net.set(k, e);
      }
      for (const p of net.values()) {
        if (p.amount.isZero()) continue;
        const c = vcHead.get(p.creditId)!;
        const b = billHead.get(p.billId)!;
        docs.get(`bill:${p.billId}`)?.settlements.push({
          date: p.date,
          amount: p.amount,
          entryId: c.entryId,
          txnType: 'bill_credit',
          num: '',
        });
        docs.get(`vendor_credit:${p.creditId}`)?.settlements.push({
          date: p.date,
          amount: p.amount,
          entryId: b.entryId,
          txnType: 'bill',
          num: b.num ?? '',
        });
      }
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
    // Same-day ties: positive settlements first, so a same-day bounce never dips below zero.
    events.sort((a, b) => a.date.getTime() - b.date.getTime() || b.amount.comparedTo(a.amount));

    // Group the document's P&L lines by account + class + date.
    const groups = new Map<string, { accountId: string; classId: string | null; date: Date; net: Decimal }>();
    for (const l of dl.pl) {
      const gk = `${l.accountId}|${l.classId ?? ''}|${l.date.getTime()}`;
      const g = groups.get(gk) ?? { accountId: l.accountId, classId: l.classId, date: l.date, net: Money.zero() };
      g.net = g.net.plus(Money.sub(l.debit ?? 0, l.credit ?? 0));
      groups.set(gk, g);
    }
    for (const id of dl.entryIds) deferredEntryIds.add(id);
    const docRef = { kind: doc.kind, id: doc.id, nameType: doc.nameType, nameId: doc.nameId, entryId: doc.ownEntryId, num: doc.ownNum };
    const ctrl = dl.controlAccountId;

    const gl = [...groups.values()].filter((g) => !g.net.isZero());
    for (const g of gl) {
      adjustments.push(
        { accountId: g.accountId, classId: g.classId, date: g.date, net: g.net.negated(), kind: 'defer', control: false, doc: docRef },
        { accountId: ctrl, classId: g.classId, date: g.date, net: g.net, kind: 'defer', control: true, doc: docRef },
      );
    }
    // Cumulative recognition through each settlement (see splitCumulative): rounded once per
    // settlement, each line within a cent of its pro-rata share, moved from the previous
    // settlement only in this settlement's direction; the last (frac = 1) lands every line
    // exactly on its own amount.
    const prev = gl.map(() => Money.zero());
    let cum = Money.zero();
    for (const e of events) {
      if (e.amount.isZero()) continue;
      // Negative settlements (a bounced check) reverse recognition on their own date.
      cum = cum.plus(e.amount);
      const frac = Money.gte(cum, doc.base) ? Money.of(1) : cum.lessThanOrEqualTo(0) ? Money.zero() : Money.div(cum, doc.base);
      const through = splitCumulative(gl.map((g) => g.net), frac, prev);
      gl.forEach((g, i) => {
        const inc = through[i].minus(prev[i]);
        prev[i] = through[i];
        if (inc.isZero()) return;
        const date = e.date < g.date ? g.date : e.date;
        if (to && date > to) return;
        const settle = { entryId: e.entryId, txnType: e.txnType, num: e.num, date };
        adjustments.push(
          { accountId: g.accountId, classId: g.classId, date, net: inc, kind: 'recognize', control: false, doc: docRef, settle },
          { accountId: ctrl, classId: g.classId, date, net: inc.negated(), kind: 'recognize', control: true, doc: docRef, settle },
        );
      });
    }
  }
  return { adjustments, deferredEntryIds };
}

// BigInt constants (tsconfig target predates BigInt literals).
const B0 = BigInt(0);
const B1 = BigInt(1);
const B2 = BigInt(2);

/**
 * Cumulative amount of each line recognized at fraction `frac` of the document, given what was
 * recognized through the previous settlement (`prev`, signed like `nets`; omitted = nothing yet).
 *
 * Lines are split into two same-sign groups (e.g. income vs. COGS on an invoice). The smaller
 * group recognizes round2(frac × its total); the group with the document's net sign recognizes
 * the rest of round2(frac × net), so each settlement recognizes exactly its share of the cash
 * (no 9.99 for 10.00) and both group totals only move with frac. Inside a group the cents are
 * handed out by the Balinski–Young quota rule, applied to the whole jump since `prev`
 * (see quotaStep): every line stays within one cent of its exact pro-rata share of the group
 * (never 3,333.30 for a one-third share of 10,000.00), a payment never moves a line against its
 * sign, a bounced check only moves lines back toward zero, and at frac = 1 every line lands
 * exactly on its own amount.
 */
export function splitCumulative(nets: Decimal[], frac: Decimal, prev?: Decimal[]): Decimal[] {
  if (frac.greaterThanOrEqualTo(1)) return nets.map((n) => Money.round2(n));
  const toCents = (d: Decimal) => BigInt(Money.round2(d).times(100).toFixed(0));
  const cents = nets.map(toCents);
  const before = nets.map((_, i) => (prev ? toCents(prev[i]) : B0));
  const out = nets.map(() => Money.zero());
  const fr = frac.greaterThan(0) ? frac : Money.zero();
  const roundCents = (c: bigint) =>
    BigInt(Money.round2(Money.mul(new DecimalValue(c.toString()).dividedBy(100), fr)).times(100).toFixed(0));
  const net = cents.reduce((a, x) => a + x, B0);
  // The group with the net's sign absorbs the net target, so the settlement recognizes exactly
  // round2(frac × net); the other group is rounded on its own. Both targets are monotone in frac.
  const big = net < B0 ? -B1 : B1;
  const groups = [-big, big].map((sign) => {
    const idx = cents.map((_, i) => i).filter((i) => cents[i] * sign > B0);
    return { sign, idx, total: idx.reduce((a, i) => a + cents[i], B0) };
  });
  const smallTarget = roundCents(groups[0].total);
  const targets = [smallTarget, roundCents(net) - smallTarget];
  groups.forEach((g, gi) => {
    if (g.idx.length === 0) return;
    const m = g.idx.map((i) => cents[i] * g.sign);
    // previous recognition in this group's direction, clamped to the line (defensive)
    const p = g.idx.map((i, k) => {
      const v = before[i] * g.sign;
      return v < B0 ? B0 : v > m[k] ? m[k] : v;
    });
    const t = targets[gi] * g.sign;
    const alloc = quotaStep(m, p, t < B0 ? B0 : t);
    g.idx.forEach((i, k) => {
      out[i] = new DecimalValue((alloc[k] * g.sign).toString()).dividedBy(100);
    });
  });
  return out;
}

/**
 * Move an allocation of integer cents over weights `m` from `p` to a new total `target`
 * (0 ≤ target ≤ Σm) so that every line stays within quota — strictly less than one unit from
 * its exact share target·m_i/Σm — and moves only in the direction of the change.
 *
 * Lower quota is floor(share), upper quota ceil(share). Each line first goes to the nearer of
 * its quota bounds that keeps it on its side of `p`; the few cents left (fewer than the number
 * of lines) go one each to the lines whose next cent falls due soonest, i.e. whose share will
 * reach the next whole cent first. That is the Balinski–Young quota method (Jefferson priority
 * restricted to lines under their upper quota): taking the earliest-due lines keeps every later
 * total reachable within quota, so a sequence of payments never breaks quota. When it is
 * provably just as safe, the cents go to the largest remainders instead (see pickExtras).
 * Only after a reversal (a bounced check moves the total down, then back up) can quota become
 * unreachable without moving a line backwards; monotonicity wins, and the leftover goes to the most
 * overdue lines (a line may then sit a cent or two off its share until the next settlement).
 */
function quotaStep(m: bigint[], p: bigint[], target: bigint): bigint[] {
  const total = m.reduce((a, x) => a + x, B0);
  if (target >= total) return [...m];
  if (target <= B0) return m.map(() => B0);
  const before = p.reduce((a, x) => a + x, B0);
  const up = target >= before;
  const lowerQ = m.map((mi) => (target * mi) / total);
  const upperQ = m.map((mi, i) => ((target * mi) % total === B0 ? lowerQ[i] : lowerQ[i] + B1));
  // house by which unit k of line i is due under lower quota: ceil(k·total / m_i)
  const due = (i: number, k: bigint) => (k * total + m[i] - B1) / m[i];
  const byDue = (a: bigint[]) => (x: number, y: number) => {
    const dx = due(x, a[x] + B1);
    const dy = due(y, a[y] + B1);
    return dx < dy ? -1 : dx > dy ? 1 : x - y;
  };
  // Start every line at its lower quota (or at p when the move's direction forbids going there).
  let a = m.map((_, i) => (up ? (p[i] > lowerQ[i] ? p[i] : lowerQ[i]) : p[i] < lowerQ[i] ? p[i] : lowerQ[i]));
  const hi = m.map((_, i) => (up ? (p[i] > upperQ[i] ? p[i] : upperQ[i]) : p[i] < upperQ[i] ? p[i] : upperQ[i]));
  let rem = target - a.reduce((s, x) => s + x, B0);
  if (rem < B0) {
    // (up only, after a reversal) lower quota out of reach: keep p and fill the most overdue.
    a = [...p];
    rem = target - before;
    return fillByDue(a, lowerQ, rem, byDue, m);
  }
  const cand = m.map((_, i) => i).filter((i) => a[i] < hi[i]); // each at most one cent short
  const sticky = m.map((_, i) => i).filter((i) => a[i] > lowerQ[i]);
  const k = rem < BigInt(cand.length) ? Number(rem) : cand.length;
  for (const i of pickExtras(m, total, target, a, cand, k, sticky, due, byDue)) {
    a[i] += B1;
    rem -= B1;
  }
  // (down only, after a reversal) upper quota out of reach: stay at p for the most overdue.
  return rem > B0 ? fillByDue(a, up ? m : p, rem, byDue, m) : a;
}

/**
 * Which `k` of the candidate lines (each one cent short of its upper quota) get the leftover
 * cents. The safe choice is the earliest-due lines (quota method). The nearest-to-exact choice
 * is the lines with the largest remainders (what a per-line rounding would show, e.g. 3,333.33
 * rather than 3,333.34 for a third of 10,000.00). Use the largest remainders whenever that
 * provably keeps every later total reachable within quota, else the earliest-due lines.
 *
 * Later totals y stay reachable iff at every y the cents still owed by rounded-up lines whose
 * share has not caught up (count of chosen due dates > y) fit in the fractional slack
 * r(y) = Σ frac(y·m_i/total). The earliest-due set is feasible; the largest-remainder set
 * differs only on [earliest j-th due, largest-remainder j-th due), where a lower bound of r(y)
 * (exact per line while it wraps at most once, else 0) must cover the count.
 */
function pickExtras(
  m: bigint[],
  total: bigint,
  target: bigint,
  a: bigint[],
  cand: number[],
  k: number,
  sticky: number[],
  due: (i: number, u: bigint) => bigint,
  byDue: (a: bigint[]) => (x: number, y: number) => number,
): number[] {
  const cmpDue = byDue(a);
  const edf = [...cand].sort(cmpDue).slice(0, k);
  const residue = (i: number) => (target * m[i]) % total;
  const lr = [...cand]
    .sort((x, y) => {
      const rx = residue(x);
      const ry = residue(y);
      return rx > ry ? -1 : rx < ry ? 1 : cmpDue(x, y);
    })
    .slice(0, k);
  const inEdf = new Set(edf);
  if (lr.every((i) => inEdf.has(i))) return edf;
  const asc = (x: bigint, y: bigint) => (x < y ? -1 : x > y ? 1 : 0);
  const stickyDue = sticky.map((i) => due(i, a[i]));
  const dEdf = [...stickyDue, ...edf.map((i) => due(i, a[i] + B1))].sort(asc);
  const dLr = [...stickyDue, ...lr.map((i) => due(i, a[i] + B1))].sort(asc);
  const K = dEdf.length;
  for (let j = 0; j < K; j++) {
    if (dLr[j] <= dEdf[j]) continue;
    const need = BigInt(K - j);
    const lo = dEdf[j];
    const len = dLr[j] - B1 - lo;
    let slack = B0; // Σ_i min over y in [lo, lo+len] of (y·m_i mod total), a lower bound
    for (const mi of m) {
      const r0 = (lo * mi) % total;
      const end = r0 + len * mi;
      if (end < total) slack += r0;
      else if (end < B2 * total) {
        const wrapped = r0 + ((total - r0 + mi - B1) / mi) * mi - total;
        slack += wrapped < r0 ? wrapped : r0;
      }
    }
    if (slack <= (need - B1) * total) return edf;
  }
  return lr;
}

/** Give `rem` units to lines below `cap`, whole lines at a time, earliest-due first. */
function fillByDue(
  a: bigint[],
  cap: bigint[],
  rem: bigint,
  byDue: (a: bigint[]) => (x: number, y: number) => number,
  m: bigint[],
): bigint[] {
  for (const i of a.map((_, k) => k).filter((k) => a[k] < cap[k]).sort(byDue(a))) {
    if (rem === B0) return a;
    const g = cap[i] - a[i] < rem ? cap[i] - a[i] : rem;
    a[i] += g;
    rem -= g;
  }
  for (let i = 0; i < a.length && rem > B0; i++) {
    const g = m[i] - a[i] < rem ? m[i] - a[i] : rem;
    a[i] += g;
    rem -= g;
  }
  return a;
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
