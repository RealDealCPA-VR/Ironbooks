/**
 * Unified Print Checks queue (QB File > Print Forms > Checks, wave2 D3/D4/D6).
 *
 * Sources that can wait in the queue ("To be printed"):
 *   - expense      Write Checks saved with "Print later"            (expenses.toPrint)
 *   - bill_payment Pay Bills by check with "To be printed"          (billPayments.toPrint)
 *   - paycheck     paychecks added to the queue from Print Checks   (paychecks.toPrint)
 *   - payment_check  p1: Sales Tax Payment checks, Pay Liabilities checks and customer refund
 *                  checks (payment_checks.toPrint; refunds are added from Print Checks)
 * TODO(wave2 payroll): runPaycheck could set paychecks.toPrint when the user picks
 * "print later" — this module already lists and stamps such paychecks.
 *
 * Printing stamps the check number on the document (and its journal entry reference) through
 * the owning service, so numbering and duplicate-number protection live in one place.
 *
 * Also owns the per-company check printer setup (style, paper, alignment offsets, check position,
 * field layout, check height, paper size — drizzle/0047) and builds the data
 * a check PDF needs: "print on check as" name, vendor account number on the memo line, voucher
 * detail (expense lines / bills paid / paycheck lines).
 */
import { isBankAccount } from '@/lib/accountTypes';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  accounts,
  auditLogs,
  billPaymentApplications,
  billPayments,
  bills,
  checkPrintSettings,
  customers,
  employees,
  expenseLines,
  expenses,
  items,
  journalEntries,
  journalEntryLines,
  journalItemApplications,
  otherNames,
  paycheckLines,
  paychecks,
  paymentChecks,
  taxAgencies,
  vendors,
} from '@/lib/db/schema';
import { Money, allocate, toAmountString } from '@/lib/money';
import {
  CHECK_STOCKS,
  CHECK_STYLES,
  MAX_CHECK_OFFSET_IN,
  type CheckStock,
  type CheckStyle,
  type VoucherLine,
} from '@/lib/pdf/check';
import {
  CHECK_FIELD_KEYS,
  CHECK_FIELD_LABELS,
  CHECK_PAGE_SIZES,
  CHECK_POSITIONS,
  DEFAULT_CHECK_HEIGHT_IN,
  MAX_CHECK_HEIGHT_IN,
  MIN_CHECK_HEIGHT_IN,
  checkWidthIn,
  diffCheckLayout,
  normalizeCheckHeight,
  normalizeFirstSheetRemaining,
  resolveCheckLayout,
  validateCheckLayout,
  type CheckLayoutOverrides,
  type CheckPageSize,
  type CheckPosition,
} from '@/lib/pdf/checkLayout';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { markExpensePrinted } from './expenses';
import { markBillPaymentPrinted } from './billPayments';
import { allocateCheckNumber } from './checkNumbers';
import { markPaymentCheckPrinted } from './liabilityPayments';
import { assertClosedPeriodEdit } from './postedEdit';

export type PrintSource = 'expense' | 'bill_payment' | 'paycheck' | 'payment_check';
export const PRINT_SOURCES: PrintSource[] = ['expense', 'bill_payment', 'paycheck', 'payment_check'];

export interface PrintQueueItem {
  source: PrintSource;
  id: string;
  date: Date;
  payee: string;
  amount: string;
  memo: string | null;
  paymentAccountId: string | null;
  paymentAccountName: string | null;
}

async function checkingAccount(ctx: ServiceContext) {
  const [row] = await ctx.db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '1000')));
  return row ?? null;
}

/**
 * The bank account each paycheck was written on, by its journal entry: the bank account its entry
 * credits with the net pay (Preferences > Payroll paycheck account, or the pay run's). Paychecks
 * used to be listed, numbered and printed as if they were all drawn on 1000 Checking.
 */
async function paycheckBankAccounts(
  ctx: ServiceContext,
  entryIds: string[],
): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>();
  if (entryIds.length === 0) return out;
  const rows = await ctx.db
    .select({
      entryId: journalEntryLines.journalEntryId,
      id: accounts.id,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
    })
    .from(journalEntryLines)
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(
      and(
        eq(accounts.companyId, ctx.companyId),
        inArray(journalEntryLines.journalEntryId, entryIds),
        sql`COALESCE(${journalEntryLines.credit}, 0) > 0`,
      ),
    );
  for (const r of rows) {
    if (!out.has(r.entryId) && isBankAccount(r)) out.set(r.entryId, { id: r.id, name: r.name });
  }
  return out;
}

/** "Print on check as" name, else the vendor's display name. */
function vendorCheckName(v: { displayName: string | null; printOnCheckAs: string | null } | null, fallback: string) {
  return (v?.printOnCheckAs ?? '').trim() || (v?.displayName ?? '').trim() || fallback;
}

/**
 * Payee of a Write Checks / expense check: the vendor's "print on check as" name, the Other Names
 * entry's current name (B3), else the typed payee.
 */
function expensePayee(
  e: { payeeName: string | null },
  v: { displayName: string | null; printOnCheckAs: string | null } | null,
  o: { name: string } | null,
  fallback: string,
): string {
  if (v) return vendorCheckName(v, e.payeeName ?? fallback);
  if (o?.name?.trim()) return o.name.trim();
  return e.payeeName ?? fallback;
}

/**
 * QB prints the payee's account number on the memo line when the memo is blank. The payee is a
 * vendor or an Other Names entry (B3); both lists carry an account number.
 */
function expenseMemo(
  e: { memo: string | null },
  v: { accountNumber: string | null } | null,
  o: { accountNumber: string | null } | null,
): string | null {
  if (e.memo?.trim()) return e.memo;
  const acct = (v?.accountNumber ?? o?.accountNumber ?? '').trim();
  return acct ? `Acct # ${acct}` : (e.memo ?? null);
}

/** Everything waiting to be printed, oldest first (optionally for one bank account). */
export async function listPrintQueue(
  ctx: ServiceContext,
  opts?: { paymentAccountId?: string },
): Promise<PrintQueueItem[]> {
  const out: PrintQueueItem[] = [];

  const expRows = await ctx.db
    .select({ e: expenses, v: vendors, o: otherNames, acctName: accounts.name })
    .from(expenses)
    .leftJoin(vendors, eq(expenses.vendorId, vendors.id))
    .leftJoin(otherNames, eq(expenses.otherNameId, otherNames.id))
    .leftJoin(accounts, eq(expenses.paymentAccountId, accounts.id))
    .where(
      and(
        eq(expenses.companyId, ctx.companyId),
        eq(expenses.toPrint, true),
        eq(expenses.method, 'check'),
        isNull(expenses.voidedAt),
        ...(opts?.paymentAccountId ? [eq(expenses.paymentAccountId, opts.paymentAccountId)] : []),
      ),
    );
  for (const r of expRows) {
    out.push({
      source: 'expense',
      id: r.e.id,
      date: r.e.date,
      payee: expensePayee(r.e, r.v, r.o, ''),
      amount: toAmountString(Money.of(r.e.total).abs()),
      memo: expenseMemo(r.e, r.v, r.o),
      paymentAccountId: r.e.paymentAccountId,
      paymentAccountName: r.acctName ?? null,
    });
  }

  const bpRows = await ctx.db
    .select({ p: billPayments, v: vendors, acctName: accounts.name })
    .from(billPayments)
    .leftJoin(vendors, eq(billPayments.vendorId, vendors.id))
    .leftJoin(accounts, eq(billPayments.paymentAccountId, accounts.id))
    .where(
      and(
        eq(billPayments.companyId, ctx.companyId),
        eq(billPayments.toPrint, true),
        isNull(billPayments.voidedAt),
        ...(opts?.paymentAccountId ? [eq(billPayments.paymentAccountId, opts.paymentAccountId)] : []),
      ),
    );
  for (const r of bpRows) {
    out.push({
      source: 'bill_payment',
      id: r.p.id,
      date: r.p.date,
      payee: vendorCheckName(r.v, 'Vendor'),
      amount: toAmountString(r.p.amount),
      memo: r.v?.accountNumber ? `Acct # ${r.v.accountNumber}` : null,
      paymentAccountId: r.p.paymentAccountId,
      paymentAccountName: r.acctName ?? null,
    });
  }

  const pcRowsDoc = await ctx.db
    .select({ c: paymentChecks, acctName: accounts.name, entryStatus: journalEntries.status })
    .from(paymentChecks)
    .leftJoin(accounts, eq(paymentChecks.paymentAccountId, accounts.id))
    .leftJoin(journalEntries, eq(paymentChecks.postedEntryId, journalEntries.id))
    .where(
      and(
        eq(paymentChecks.companyId, ctx.companyId),
        eq(paymentChecks.toPrint, true),
        isNull(paymentChecks.voidedAt),
        ...(opts?.paymentAccountId ? [eq(paymentChecks.paymentAccountId, opts.paymentAccountId)] : []),
      ),
    );
  for (const r of pcRowsDoc) {
    if (r.entryStatus === 'void') continue; // voided outside the check (e.g. Batch Void)
    out.push({
      source: 'payment_check',
      id: r.c.id,
      date: r.c.date,
      payee: r.c.payeeName,
      amount: toAmountString(r.c.amount),
      memo: r.c.memo,
      paymentAccountId: r.c.paymentAccountId,
      paymentAccountName: r.acctName ?? null,
    });
  }

  const checking = await checkingAccount(ctx);
  const pcRows = await ctx.db
    .select({ p: paychecks, first: employees.firstName, last: employees.lastName })
    .from(paychecks)
    .innerJoin(employees, eq(paychecks.employeeId, employees.id))
    .where(and(eq(paychecks.companyId, ctx.companyId), eq(paychecks.toPrint, true), isNull(paychecks.voidedAt), eq(paychecks.entryType, 'paycheck')));
  const bankOf = await paycheckBankAccounts(
    ctx,
    pcRows.map((r) => r.p.postedEntryId).filter((x): x is string => Boolean(x)),
  );
  for (const r of pcRows) {
    // The account the paycheck was written on (1000 Checking for one with no bank line).
    const bank = (r.p.postedEntryId ? bankOf.get(r.p.postedEntryId) : undefined) ?? checking;
    if (opts?.paymentAccountId && bank?.id !== opts.paymentAccountId) continue;
    out.push({
      source: 'paycheck',
      id: r.p.id,
      date: r.p.payDate,
      payee: `${r.first} ${r.last}`.trim(),
      amount: toAmountString(r.p.netPay),
      memo: 'Paycheck',
      paymentAccountId: bank?.id ?? null,
      paymentAccountName: bank?.name ?? null,
    });
  }

  return out.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

/**
 * Real paychecks with money to pay by check: not the YTD summaries entered at mid-year setup or
 * the liability adjustments (paychecks rows with another entryType — a "net pay" of $26,000 for a
 * year-to-date summary was offered as a check to print), and not a $0 net paycheck.
 */
function printablePaycheck() {
  return and(eq(paychecks.entryType, 'paycheck'), sql`${paychecks.netPay} > 0`);
}

/** Paychecks that were never printed and are not queued (candidates for "Add paychecks"). */
export async function listUnprintedPaychecks(ctx: ServiceContext) {
  const rows = await ctx.db
    .select({ p: paychecks, first: employees.firstName, last: employees.lastName })
    .from(paychecks)
    .innerJoin(employees, eq(paychecks.employeeId, employees.id))
    .where(
      and(
        eq(paychecks.companyId, ctx.companyId),
        isNull(paychecks.voidedAt),
        isNull(paychecks.checkNumber),
        eq(paychecks.toPrint, false),
        printablePaycheck(),
      ),
    )
    .orderBy(asc(paychecks.payDate));
  return rows.map((r) => ({
    id: r.p.id,
    payDate: r.p.payDate,
    employee: `${r.first} ${r.last}`.trim(),
    netPay: r.p.netPay,
  }));
}

/** Put paychecks in the print queue. */
export async function queuePaychecks(ctx: ServiceContext, ids: string[]) {
  if (ids.length === 0) throw validation('Pick at least one paycheck.');
  return inTransaction(ctx, async (tx) => {
    const rows = await tx.db
      .select()
      .from(paychecks)
      .where(and(eq(paychecks.companyId, tx.companyId), inArray(paychecks.id, ids)));
    if (rows.length !== ids.length) throw notFound('One or more paychecks');
    for (const p of rows) {
      if (p.voidedAt) throw new ServiceError('CONFLICT', 'A voided paycheck cannot be printed.');
      if (p.entryType !== 'paycheck') {
        throw validation('A year-to-date summary or a liability adjustment is not a paycheck, so there is no check to print for it.');
      }
      if (!Money.of(p.netPay).greaterThan(0)) throw validation('This paycheck has no net pay to print a check for.');
      if (p.toPrint) continue;
      // Flagging a closed-period paycheck to print is a change to it: closing date password.
      await assertClosedPeriodEdit(tx, { entryId: p.postedEntryId, what: 'to-be-printed flag', date: p.payDate });
      await tx.db.update(paychecks).set({ toPrint: true }).where(eq(paychecks.id, p.id));
      await writeAudit(tx, {
        action: 'update',
        entityType: 'paycheck',
        entityId: p.id,
        oldValues: { toPrint: false },
        newValues: { toPrint: true },
      });
    }
    return { queued: rows.length };
  });
}

/** Stamp a printed paycheck's check number (and its journal entry reference). */
export async function markPaycheckPrinted(
  ctx: ServiceContext,
  input: { paycheckId: string; checkNumber?: string; allowDuplicateNumber?: boolean },
) {
  // Load, number and stamp in one transaction (two checks printed at once get different numbers).
  return inTransaction(ctx, (tx) => markPaycheckPrintedInTx(tx, input));
}

async function markPaycheckPrintedInTx(
  ctx: ServiceContext,
  input: { paycheckId: string; checkNumber?: string; allowDuplicateNumber?: boolean },
) {
  const [pc] = await ctx.db
    .select()
    .from(paychecks)
    .where(and(eq(paychecks.companyId, ctx.companyId), eq(paychecks.id, input.paycheckId)));
  if (!pc) throw notFound('Paycheck');
  if (pc.voidedAt) throw new ServiceError('CONFLICT', 'This paycheck is void and cannot be printed.');
  if (!pc.toPrint) throw new ServiceError('CONFLICT', 'This paycheck is not in the print queue.');
  if (pc.entryType !== 'paycheck') throw validation('A year-to-date summary or a liability adjustment is not a paycheck, so it cannot be printed.');
  // Numbered in the sequence of the bank account the paycheck was written on.
  const bank =
    (pc.postedEntryId ? (await paycheckBankAccounts(ctx, [pc.postedEntryId])).get(pc.postedEntryId) : undefined) ??
    (await checkingAccount(ctx));
  if (!bank) throw notFound('Checking account (1000)');
  const checkNumber = await allocateCheckNumber(ctx, {
    paymentAccountId: bank.id,
    number: input.checkNumber,
    exclude: { source: 'paycheck', id: pc.id },
    allowDuplicate: input.allowDuplicateNumber,
  });
  return inTransaction(ctx, async (tx) => {
    await assertClosedPeriodEdit(tx, { entryId: pc.postedEntryId, what: 'check number', date: pc.payDate });
    const [updated] = await tx.db
      .update(paychecks)
      .set({ toPrint: false, checkNumber })
      .where(eq(paychecks.id, pc.id))
      .returning();
    if (pc.postedEntryId) {
      await tx.db
        .update(journalEntries)
        .set({ reference: checkNumber, updatedAt: new Date() })
        .where(and(eq(journalEntries.id, pc.postedEntryId), eq(journalEntries.companyId, tx.companyId)));
    }
    await writeAudit(tx, {
      action: 'update',
      entityType: 'paycheck',
      entityId: pc.id,
      oldValues: { toPrint: true, checkNumber: pc.checkNumber },
      newValues: { toPrint: false, checkNumber },
    });
    return updated;
  });
}

/** Stamp the check number on any queued document. */
export async function markPrinted(
  ctx: ServiceContext,
  input: { source: PrintSource; id: string; checkNumber?: string; allowDuplicateNumber?: boolean },
) {
  switch (input.source) {
    case 'expense':
      return markExpensePrinted(ctx, {
        expenseId: input.id,
        checkNumber: input.checkNumber,
        allowDuplicateNumber: input.allowDuplicateNumber,
      });
    case 'bill_payment':
      return markBillPaymentPrinted(ctx, {
        billPaymentId: input.id,
        checkNumber: input.checkNumber,
        allowDuplicateNumber: input.allowDuplicateNumber,
      });
    case 'paycheck':
      return markPaycheckPrinted(ctx, {
        paycheckId: input.id,
        checkNumber: input.checkNumber,
        allowDuplicateNumber: input.allowDuplicateNumber,
      });
    case 'payment_check':
      return markPaymentCheckPrinted(ctx, {
        id: input.id,
        checkNumber: input.checkNumber,
        allowDuplicateNumber: input.allowDuplicateNumber,
      });
    default:
      throw validation('Unknown check source.');
  }
}

// ---------------------------------------------------------------------------
// Check data for the PDF
// ---------------------------------------------------------------------------

export interface CheckPrintData {
  payee: string;
  amount: string;
  date: string;
  memo: string | null;
  checkNumber: string | null;
  voucher: VoucherLine[];
  /** Payee mailing address lines (vendor / employee / customer), for window envelopes. */
  payeeAddress: string[];
}

/**
 * The cash a bill payment paid on each of its applications (same order), i.e. the settlement
 * minus the early-payment discount taken on that bill. The per-bill split is on the payment's
 * latest audit row (create / edit record each application's cash and discount); when that row
 * does not match the payment any more, the bills' cash (payment amount minus General Journal
 * items paid) is spread over the settlements, penny-exact.
 */
async function billPaymentCashByBill(
  ctx: ServiceContext,
  payment: { id: string; amount: string },
  apps: Array<{ billId: string; amountApplied: string }>,
  journalTotal: ReturnType<typeof Money.zero>,
): Promise<Array<ReturnType<typeof Money.zero>>> {
  if (apps.length === 0) return [];
  const billsCash = Money.round2(Money.of(payment.amount).minus(journalTotal));
  const settled = apps.reduce((s, a) => s.plus(Money.of(a.amountApplied)), Money.zero());
  if (Money.round2(settled).equals(billsCash)) return apps.map((a) => Money.of(a.amountApplied));
  const [audit] = await ctx.db
    .select({ newValues: auditLogs.newValues })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.companyId, ctx.companyId),
        eq(auditLogs.entityType, 'bill_payment'),
        eq(auditLogs.entityId, payment.id),
        sql`jsonb_typeof(${auditLogs.newValues}->'applications') = 'array'`,
      ),
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  const recorded = ((audit?.newValues as { applications?: Array<{ billId?: string; amountApplied?: string | number }> } | null)
    ?.applications ?? []) as Array<{ billId?: string; amountApplied?: string | number }>;
  const cashOf = new Map<string, ReturnType<typeof Money.zero>>();
  for (const r of recorded) {
    if (!r.billId) continue;
    try {
      cashOf.set(r.billId, Money.round2(r.amountApplied ?? 0));
    } catch {
      /* malformed history: fall back below */
    }
  }
  const fromAudit = apps.map((a) => cashOf.get(a.billId));
  if (
    fromAudit.every((c, i) => c != null && !c.greaterThan(Money.of(apps[i].amountApplied))) &&
    Money.round2(fromAudit.reduce<ReturnType<typeof Money.zero>>((s, c) => s.plus(c ?? 0), Money.zero())).equals(billsCash)
  ) {
    return fromAudit as Array<ReturnType<typeof Money.zero>>;
  }
  return billsCash.isNegative() ? apps.map((a) => Money.of(a.amountApplied)) : allocate(billsCash, apps.map((a) => a.amountApplied));
}

/** Address jsonb ({ line1, line2, city, state, zip, … }) → printable lines. */
function addressLines(addr: unknown): string[] {
  if (!addr || typeof addr !== 'object' || Array.isArray(addr)) return [];
  const a = addr as Record<string, unknown>;
  const g = (...keys: string[]) =>
    keys.map((k) => a[k]).find((v): v is string => typeof v === 'string' && v.trim() !== '')?.trim() ?? '';
  const cityLine = [g('city'), [g('state', 'region'), g('zip', 'postalCode', 'postal_code')].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  return [g('line1', 'street', 'address1', 'addressLine1'), g('line2', 'address2', 'addressLine2'), cityLine, g('country')].filter(Boolean);
}

/**
 * Payee / amount / memo / voucher lines for a recorded check. The payee uses the vendor's
 * "print on check as" name; when the memo is blank the vendor account number is printed on the
 * memo line ("Acct # …"), as QB does.
 */
export async function checkPrintData(
  ctx: ServiceContext,
  source: PrintSource,
  id: string,
): Promise<CheckPrintData> {
  // A check is a negotiable instrument: never print one for a transaction that was voided (by
  // another user while it sat in the print queue, or a stale Reprint) or that is not a check at
  // all (a credit card charge, a cash expense, an ACH bill payment) — the PDF used to come out as
  // a signed-ready check for the full original amount.
  const voided = () => new ServiceError('CONFLICT', 'This check is void, so it cannot be printed.');
  if (source === 'expense') {
    const [row] = await ctx.db
      .select({ e: expenses, v: vendors, o: otherNames })
      .from(expenses)
      .leftJoin(vendors, eq(expenses.vendorId, vendors.id))
      .leftJoin(otherNames, eq(expenses.otherNameId, otherNames.id))
      .where(and(eq(expenses.companyId, ctx.companyId), eq(expenses.id, id)));
    if (!row) throw notFound('Check');
    if (row.e.voidedAt) throw voided();
    if (row.e.method !== 'check') {
      throw validation(
        `Only checks can be printed. This is a ${row.e.method === 'credit_card' ? 'credit card charge' : 'cash expense'}.`,
      );
    }
    const lines = await ctx.db
      .select({ l: expenseLines, code: accounts.code, name: accounts.name, itemName: items.name })
      .from(expenseLines)
      .leftJoin(accounts, eq(expenseLines.accountId, accounts.id))
      .leftJoin(items, eq(expenseLines.itemId, items.id))
      .where(eq(expenseLines.expenseId, id))
      .orderBy(asc(expenseLines.lineOrder));
    return {
      payee: expensePayee(row.e, row.v, row.o, 'Payee'),
      amount: toAmountString(Money.of(row.e.total).abs()),
      date: new Date(row.e.date).toISOString().slice(0, 10),
      memo: expenseMemo(row.e, row.v, row.o),
      checkNumber: row.e.reference,
      payeeAddress: addressLines(row.v?.address ?? row.o?.address),
      voucher: lines.map((r) => ({
        account: r.l.itemId && r.itemName ? `Item: ${r.itemName}` : `${r.code ?? ''} – ${r.name ?? 'Account'}`,
        description: r.l.description,
        amount: toAmountString(Money.of(r.l.amount).abs()),
      })),
    };
  }
  if (source === 'bill_payment') {
    const [row] = await ctx.db
      .select({ p: billPayments, v: vendors })
      .from(billPayments)
      .leftJoin(vendors, eq(billPayments.vendorId, vendors.id))
      .where(and(eq(billPayments.companyId, ctx.companyId), eq(billPayments.id, id)));
    if (!row) throw notFound('Bill payment');
    if (row.p.voidedAt) throw voided();
    if (row.p.method !== 'check') throw validation('Only bill payments made by check can be printed as a check.');
    const apps = await ctx.db
      .select({ a: billPaymentApplications, billNumber: bills.billNumber, billDate: bills.date })
      .from(billPaymentApplications)
      .innerJoin(bills, eq(billPaymentApplications.billId, bills.id))
      .where(eq(billPaymentApplications.billPaymentId, id));
    // General Journal amounts owed that this check also paid (QB I11 — Pay Bills lists them).
    const journalPaid = await ctx.db
      .select({ amount: journalItemApplications.amount, entryNumber: journalEntries.entryNumber, date: journalEntries.date })
      .from(journalItemApplications)
      .innerJoin(journalEntries, eq(journalItemApplications.journalEntryId, journalEntries.id))
      .where(
        and(
          eq(journalItemApplications.companyId, ctx.companyId),
          eq(journalItemApplications.billPaymentId, id),
          eq(journalItemApplications.kind, 'bill_payment'),
        ),
      );
    // An application stores the bill's whole settlement (cash + early-payment discount); the stub
    // shows what this check pays on each bill, and the discount separately, so it adds up to the
    // check amount (QB voucher: Payment / Discount columns).
    const journalTotal = journalPaid.reduce((s, j) => s.plus(Money.of(j.amount)), Money.zero());
    const cashByBill = await billPaymentCashByBill(ctx, row.p, apps.map((r) => r.a), journalTotal);
    return {
      payee: vendorCheckName(row.v, 'Vendor'),
      amount: toAmountString(row.p.amount),
      date: new Date(row.p.date).toISOString().slice(0, 10),
      memo: row.v?.accountNumber ? `Acct # ${row.v.accountNumber}` : null,
      checkNumber: row.p.reference,
      payeeAddress: addressLines(row.v?.address),
      voucher: [
        ...apps.map((r, i) => {
          const cash = cashByBill[i];
          const discount = Money.round2(Money.of(r.a.amountApplied).minus(cash));
          const day = new Date(r.billDate).toISOString().slice(0, 10);
          return {
            account: `Bill ${r.billNumber ?? ''}`.trim(),
            description: discount.greaterThan(0) ? `${day} — discount ${toAmountString(discount)}` : day,
            amount: toAmountString(cash),
          };
        }),
        ...journalPaid.map((j) => ({
          account: `General Journal #${j.entryNumber}`,
          description: new Date(j.date).toISOString().slice(0, 10),
          amount: toAmountString(j.amount),
        })),
      ],
    };
  }
  if (source === 'payment_check') {
    const [row] = await ctx.db
      .select({ c: paymentChecks, agencyName: taxAgencies.name, agencyVendorId: taxAgencies.vendorId })
      .from(paymentChecks)
      .leftJoin(taxAgencies, eq(paymentChecks.agencyId, taxAgencies.id))
      .where(and(eq(paymentChecks.companyId, ctx.companyId), eq(paymentChecks.id, id)));
    if (!row) throw notFound('Check');
    const c = row.c;
    if (c.voidedAt) throw voided();
    if (c.postedEntryId) {
      // Voided another way (the credit memo's refund, Void journal entry, Batch Void).
      const [entry] = await ctx.db
        .select({ status: journalEntries.status })
        .from(journalEntries)
        .where(and(eq(journalEntries.id, c.postedEntryId), eq(journalEntries.companyId, ctx.companyId)));
      if (entry?.status === 'void') throw voided();
    }
    // Voucher detail: the liability lines of the entry (sales tax agency, payroll items) or the
    // refund itself.
    const lines = c.postedEntryId
      ? await ctx.db
          .select({ debit: journalEntryLines.debit, memo: journalEntryLines.memo, code: accounts.code, name: accounts.name })
          .from(journalEntryLines)
          .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
          .where(and(eq(journalEntryLines.journalEntryId, c.postedEntryId), sql`COALESCE(${journalEntryLines.debit}, 0) > 0`))
      : [];
    // Window-envelope address: the payee vendor (or the agency's vendor), else the refund customer.
    let payeeAddress: string[] = [];
    const vendorId = c.vendorId ?? row.agencyVendorId;
    if (vendorId) {
      const [v] = await ctx.db
        .select({ address: vendors.address })
        .from(vendors)
        .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, vendorId)));
      payeeAddress = addressLines(v?.address);
    } else if (c.customerId) {
      const [cu] = await ctx.db
        .select({ billing: customers.billingAddress, shipping: customers.shippingAddress })
        .from(customers)
        .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, c.customerId)));
      payeeAddress = addressLines(cu?.billing ?? cu?.shipping);
    }
    const label =
      c.kind === 'sales_tax' ? 'Sales Tax Payment' : c.kind === 'payroll_liability' ? 'Liability Check' : 'Refund';
    return {
      payee: c.payeeName,
      amount: toAmountString(c.amount),
      date: new Date(c.date).toISOString().slice(0, 10),
      memo: c.memo,
      checkNumber: c.reference,
      payeeAddress,
      voucher:
        lines.length > 0
          ? lines.map((l) => ({
              account: `${l.code} – ${l.name}`,
              description: l.memo ?? (row.agencyName ? `${label} — ${row.agencyName}` : label),
              amount: toAmountString(l.debit ?? '0'),
            }))
          : [{ account: label, description: c.memo, amount: toAmountString(c.amount) }],
    };
  }
  const [row] = await ctx.db
    .select({ p: paychecks, first: employees.firstName, last: employees.lastName, address: employees.address })
    .from(paychecks)
    .innerJoin(employees, eq(paychecks.employeeId, employees.id))
    .where(and(eq(paychecks.companyId, ctx.companyId), eq(paychecks.id, id)));
  if (!row) throw notFound('Paycheck');
  if (row.p.voidedAt) throw voided();
  if (row.p.entryType !== 'paycheck') {
    throw validation('A year-to-date summary or a liability adjustment is not a paycheck, so it cannot be printed.');
  }
  const lines = await ctx.db.select().from(paycheckLines).where(eq(paycheckLines.paycheckId, id));
  return {
    payee: `${row.first} ${row.last}`.trim(),
    amount: toAmountString(row.p.netPay),
    date: new Date(row.p.payDate).toISOString().slice(0, 10),
    memo: 'Paycheck',
    checkNumber: row.p.checkNumber,
    payeeAddress: addressLines(row.address),
    voucher: [
      { account: 'Gross pay', description: null, amount: toAmountString(row.p.grossPay) },
      ...lines
        .filter((l) => l.kind === 'tax' || l.kind === 'deduction')
        .map((l) => ({ account: l.name, description: l.kind, amount: toAmountString(Money.of(l.amount).negated()) })),
    ],
  };
}

// ---------------------------------------------------------------------------
// Check printer setup (style + alignment)
// ---------------------------------------------------------------------------

export interface CheckPrintSettings {
  style: CheckStyle;
  /** 'preprinted' (default): only the variable fields; 'blank': full check layout on plain paper. */
  stock: CheckStock;
  offsetX: string;
  offsetY: string;
  /** Voucher / wallet stock: which third of the sheet holds the check. */
  position: CheckPosition;
  /** Field-position overrides (only what differs from the standard positions); null = standard. */
  layout: CheckLayoutOverrides | null;
  /** Standard checks: unused checks left on the first sheet (1-3). */
  firstSheetRemaining: number;
  pageSize: CheckPageSize;
  /** Height of one check, inches ("3.50"). */
  checkHeight: string;
}

export async function getCheckPrintSettings(ctx: ServiceContext): Promise<CheckPrintSettings> {
  const [row] = await ctx.db
    .select()
    .from(checkPrintSettings)
    .where(eq(checkPrintSettings.companyId, ctx.companyId));
  const style = (row?.style as CheckStyle) ?? 'voucher';
  const layout = validateCheckLayout(row?.layout ?? null);
  return {
    style,
    stock: row?.stock === 'blank' ? 'blank' : 'preprinted',
    offsetX: row ? Money.of(row.offsetX).toFixed(2) : '0.00',
    offsetY: row ? Money.of(row.offsetY).toFixed(2) : '0.00',
    position: CHECK_POSITIONS.includes(row?.checkPosition as CheckPosition) ? (row!.checkPosition as CheckPosition) : 'top',
    layout: layout.ok ? layout.value : null,
    firstSheetRemaining: normalizeFirstSheetRemaining(row?.firstSheetRemaining),
    pageSize: row?.pageSize === 'legal' ? 'legal' : 'letter',
    checkHeight: normalizeCheckHeight(row?.checkHeight ?? DEFAULT_CHECK_HEIGHT_IN).toFixed(2),
  };
}

export interface CheckPrintSettingsInput {
  style: string;
  stock?: string | null;
  offsetX: string | number;
  offsetY: string | number;
  position?: string | null;
  pageSize?: string | null;
  checkHeight?: string | number | null;
  firstSheetRemaining?: string | number | null;
  /** undefined = keep the saved positions; null = back to the standard positions. */
  layout?: unknown;
}

/**
 * Validate the printer-setup fields beyond style / stock / offsets (shared by save and the
 * alignment test, which prints with unsaved settings). Returns the normalised values.
 */
export function parseCheckLayoutSettings(
  input: Omit<CheckPrintSettingsInput, 'style' | 'stock' | 'offsetX' | 'offsetY'>,
  style: string,
  before?: Pick<CheckPrintSettings, 'position' | 'pageSize' | 'checkHeight' | 'firstSheetRemaining' | 'layout'>,
) {
  if (input.position != null && !CHECK_POSITIONS.includes(input.position as CheckPosition)) {
    throw validation('Choose where the check is on the page: top, middle or bottom.');
  }
  if (input.pageSize != null && !CHECK_PAGE_SIZES.includes(input.pageSize as CheckPageSize)) {
    throw validation('Choose the paper size: Letter or Legal.');
  }
  let checkHeight = before ? Number(before.checkHeight) : DEFAULT_CHECK_HEIGHT_IN;
  if (input.checkHeight != null && String(input.checkHeight).trim() !== '') {
    let h;
    try {
      h = Money.of(String(input.checkHeight).trim());
    } catch {
      h = null;
    }
    if (!h || !h.isFinite() || h.lessThan(MIN_CHECK_HEIGHT_IN) || h.greaterThan(MAX_CHECK_HEIGHT_IN)) {
      throw validation(`Check height must be between ${MIN_CHECK_HEIGHT_IN} and ${MAX_CHECK_HEIGHT_IN} inches.`);
    }
    checkHeight = h.toNumber();
  }
  let firstSheetRemaining = before?.firstSheetRemaining ?? 3;
  if (input.firstSheetRemaining != null && String(input.firstSheetRemaining).trim() !== '') {
    const n = Number(input.firstSheetRemaining);
    if (n !== 1 && n !== 2 && n !== 3) throw validation('Checks left on the first sheet must be 1, 2 or 3.');
    firstSheetRemaining = n;
  }
  let layout = before?.layout ?? null;
  if (input.layout !== undefined) {
    const v = validateCheckLayout(input.layout);
    if (!v.ok) throw validation(v.error);
    layout = diffCheckLayout(style, v.value);
  }
  // Every field has to land on the check.
  const resolved = resolveCheckLayout(style, layout);
  const width = checkWidthIn(style);
  for (const k of CHECK_FIELD_KEYS) {
    if (resolved[k].y > checkHeight + 1e-9) {
      throw validation(`${CHECK_FIELD_LABELS[k]}: Down must be within the check height (${checkHeight}").`);
    }
    if (resolved[k].x > width + 1e-9) {
      throw validation(`${CHECK_FIELD_LABELS[k]}: Across must be within the check width (${width}").`);
    }
  }
  return {
    position: (input.position as CheckPosition | null | undefined) ?? before?.position ?? 'top',
    pageSize: (input.pageSize as CheckPageSize | null | undefined) ?? before?.pageSize ?? 'letter',
    checkHeight,
    firstSheetRemaining,
    layout,
  };
}

export async function saveCheckPrintSettings(
  ctx: ServiceContext,
  input: CheckPrintSettingsInput,
): Promise<CheckPrintSettings> {
  if (!CHECK_STYLES.includes(input.style as CheckStyle)) {
    throw validation('Choose a check style: voucher, standard or wallet.');
  }
  if (input.stock != null && !CHECK_STOCKS.includes(input.stock as CheckStock)) {
    throw validation('Choose the check paper: pre-printed checks or blank check stock.');
  }
  const x = Money.of(input.offsetX);
  const y = Money.of(input.offsetY);
  for (const v of [x, y]) {
    if (!v.isFinite() || v.abs().greaterThan(MAX_CHECK_OFFSET_IN)) {
      throw validation(`Alignment can move the print at most ${MAX_CHECK_OFFSET_IN} inch in each direction.`);
    }
  }
  const current = await getCheckPrintSettings(ctx);
  const extra = parseCheckLayoutSettings(input, input.style, current);
  return inTransaction(ctx, async (tx) => {
    const before = await getCheckPrintSettings(tx);
    const [existing] = await tx.db
      .select({ id: checkPrintSettings.id })
      .from(checkPrintSettings)
      .where(eq(checkPrintSettings.companyId, tx.companyId));
    const values = {
      style: input.style,
      stock: (input.stock as CheckStock | null | undefined) ?? before.stock,
      offsetX: x.toFixed(3),
      offsetY: y.toFixed(3),
      checkPosition: extra.position,
      layout: extra.layout as Record<string, Record<string, number | boolean>> | null,
      firstSheetRemaining: extra.firstSheetRemaining,
      pageSize: extra.pageSize,
      checkHeight: extra.checkHeight.toFixed(3),
      updatedAt: new Date(),
    };
    let id: string;
    if (existing) {
      await tx.db.update(checkPrintSettings).set(values).where(eq(checkPrintSettings.id, existing.id));
      id = existing.id;
    } else {
      const [row] = await tx.db.insert(checkPrintSettings).values({ companyId: tx.companyId, ...values }).returning();
      id = row.id;
    }
    const after = await getCheckPrintSettings(tx);
    await writeAudit(tx, {
      action: existing ? 'update' : 'create',
      entityType: 'check_print_settings',
      entityId: id,
      oldValues: before,
      newValues: after,
    });
    return after;
  });
}
