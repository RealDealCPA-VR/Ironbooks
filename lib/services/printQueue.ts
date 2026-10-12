/**
 * Unified Print Checks queue (QB File > Print Forms > Checks, wave2 D3/D4/D6).
 *
 * Sources that can wait in the queue ("To be printed"):
 *   - expense      Write Checks saved with "Print later"            (expenses.toPrint)
 *   - bill_payment Pay Bills by check with "To be printed"          (billPayments.toPrint)
 *   - paycheck     paychecks added to the queue from Print Checks   (paychecks.toPrint)
 * Customer refund checks have no document table yet (credit-memo / payment refunds post a
 * journal entry only), so they cannot be queued — TODO(wave2 sales): add a refund-check
 * document with a toPrint flag and list it here.
 * TODO(wave2 payroll): runPaycheck could set paychecks.toPrint when the user picks
 * "print later" — this module already lists and stamps such paychecks.
 *
 * Printing stamps the check number on the document (and its journal entry reference) through
 * the owning service, so numbering and duplicate-number protection live in one place.
 *
 * Also owns the per-company check printer setup (style + alignment offsets) and builds the data
 * a check PDF needs: "print on check as" name, vendor account number on the memo line, voucher
 * detail (expense lines / bills paid / paycheck lines).
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  accounts,
  billPaymentApplications,
  billPayments,
  bills,
  checkPrintSettings,
  employees,
  expenseLines,
  expenses,
  items,
  journalEntries,
  paycheckLines,
  paychecks,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { CHECK_STYLES, MAX_CHECK_OFFSET_IN, type CheckStyle, type VoucherLine } from '@/lib/pdf/check';
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
import { assertCheckNumberAvailable, nextCheckNumber } from './checkNumbers';

export type PrintSource = 'expense' | 'bill_payment' | 'paycheck';
export const PRINT_SOURCES: PrintSource[] = ['expense', 'bill_payment', 'paycheck'];

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

/** "Print on check as" name, else the vendor's display name. */
function vendorCheckName(v: { displayName: string | null; printOnCheckAs: string | null } | null, fallback: string) {
  return (v?.printOnCheckAs ?? '').trim() || (v?.displayName ?? '').trim() || fallback;
}

/** Everything waiting to be printed, oldest first (optionally for one bank account). */
export async function listPrintQueue(
  ctx: ServiceContext,
  opts?: { paymentAccountId?: string },
): Promise<PrintQueueItem[]> {
  const out: PrintQueueItem[] = [];

  const expRows = await ctx.db
    .select({ e: expenses, v: vendors, acctName: accounts.name })
    .from(expenses)
    .leftJoin(vendors, eq(expenses.vendorId, vendors.id))
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
      payee: r.v ? vendorCheckName(r.v, r.e.payeeName ?? '') : (r.e.payeeName ?? ''),
      amount: toAmountString(Money.of(r.e.total).abs()),
      memo: r.e.memo,
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

  const checking = await checkingAccount(ctx);
  if (!opts?.paymentAccountId || opts.paymentAccountId === checking?.id) {
    const pcRows = await ctx.db
      .select({ p: paychecks, first: employees.firstName, last: employees.lastName })
      .from(paychecks)
      .innerJoin(employees, eq(paychecks.employeeId, employees.id))
      .where(and(eq(paychecks.companyId, ctx.companyId), eq(paychecks.toPrint, true), isNull(paychecks.voidedAt)));
    for (const r of pcRows) {
      out.push({
        source: 'paycheck',
        id: r.p.id,
        date: r.p.payDate,
        payee: `${r.first} ${r.last}`.trim(),
        amount: toAmountString(r.p.netPay),
        memo: 'Paycheck',
        paymentAccountId: checking?.id ?? null,
        paymentAccountName: checking?.name ?? null,
      });
    }
  }

  return out.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
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
      if (p.toPrint) continue;
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
  const [pc] = await ctx.db
    .select()
    .from(paychecks)
    .where(and(eq(paychecks.companyId, ctx.companyId), eq(paychecks.id, input.paycheckId)));
  if (!pc) throw notFound('Paycheck');
  if (pc.voidedAt) throw new ServiceError('CONFLICT', 'This paycheck is void and cannot be printed.');
  if (!pc.toPrint) throw new ServiceError('CONFLICT', 'This paycheck is not in the print queue.');
  const checking = await checkingAccount(ctx);
  if (!checking) throw notFound('Checking account (1000)');
  const checkNumber = input.checkNumber?.trim() || (await nextCheckNumber(ctx, checking.id));
  await assertCheckNumberAvailable(ctx, {
    paymentAccountId: checking.id,
    number: checkNumber,
    exclude: { source: 'paycheck', id: pc.id },
    allowDuplicate: input.allowDuplicateNumber,
  });
  return inTransaction(ctx, async (tx) => {
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
  if (source === 'expense') {
    const [row] = await ctx.db
      .select({ e: expenses, v: vendors })
      .from(expenses)
      .leftJoin(vendors, eq(expenses.vendorId, vendors.id))
      .where(and(eq(expenses.companyId, ctx.companyId), eq(expenses.id, id)));
    if (!row) throw notFound('Check');
    const lines = await ctx.db
      .select({ l: expenseLines, code: accounts.code, name: accounts.name, itemName: items.name })
      .from(expenseLines)
      .leftJoin(accounts, eq(expenseLines.accountId, accounts.id))
      .leftJoin(items, eq(expenseLines.itemId, items.id))
      .where(eq(expenseLines.expenseId, id))
      .orderBy(asc(expenseLines.lineOrder));
    return {
      payee: row.v ? vendorCheckName(row.v, row.e.payeeName ?? 'Payee') : (row.e.payeeName ?? 'Payee'),
      amount: toAmountString(Money.of(row.e.total).abs()),
      date: new Date(row.e.date).toISOString().slice(0, 10),
      memo: row.e.memo ?? (row.v?.accountNumber ? `Acct # ${row.v.accountNumber}` : null),
      checkNumber: row.e.reference,
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
    const apps = await ctx.db
      .select({ a: billPaymentApplications, billNumber: bills.billNumber, billDate: bills.date })
      .from(billPaymentApplications)
      .innerJoin(bills, eq(billPaymentApplications.billId, bills.id))
      .where(eq(billPaymentApplications.billPaymentId, id));
    return {
      payee: vendorCheckName(row.v, 'Vendor'),
      amount: toAmountString(row.p.amount),
      date: new Date(row.p.date).toISOString().slice(0, 10),
      memo: row.v?.accountNumber ? `Acct # ${row.v.accountNumber}` : null,
      checkNumber: row.p.reference,
      voucher: apps.map((r) => ({
        account: `Bill ${r.billNumber ?? ''}`.trim(),
        description: new Date(r.billDate).toISOString().slice(0, 10),
        amount: toAmountString(r.a.amountApplied),
      })),
    };
  }
  const [row] = await ctx.db
    .select({ p: paychecks, first: employees.firstName, last: employees.lastName })
    .from(paychecks)
    .innerJoin(employees, eq(paychecks.employeeId, employees.id))
    .where(and(eq(paychecks.companyId, ctx.companyId), eq(paychecks.id, id)));
  if (!row) throw notFound('Paycheck');
  const lines = await ctx.db.select().from(paycheckLines).where(eq(paycheckLines.paycheckId, id));
  return {
    payee: `${row.first} ${row.last}`.trim(),
    amount: toAmountString(row.p.netPay),
    date: new Date(row.p.payDate).toISOString().slice(0, 10),
    memo: 'Paycheck',
    checkNumber: row.p.checkNumber,
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
  offsetX: string;
  offsetY: string;
}

export async function getCheckPrintSettings(ctx: ServiceContext): Promise<CheckPrintSettings> {
  const [row] = await ctx.db
    .select()
    .from(checkPrintSettings)
    .where(eq(checkPrintSettings.companyId, ctx.companyId));
  return {
    style: (row?.style as CheckStyle) ?? 'voucher',
    offsetX: row ? Money.of(row.offsetX).toFixed(2) : '0.00',
    offsetY: row ? Money.of(row.offsetY).toFixed(2) : '0.00',
  };
}

export async function saveCheckPrintSettings(
  ctx: ServiceContext,
  input: { style: string; offsetX: string | number; offsetY: string | number },
): Promise<CheckPrintSettings> {
  if (!CHECK_STYLES.includes(input.style as CheckStyle)) {
    throw validation('Choose a check style: voucher, standard or wallet.');
  }
  const x = Money.of(input.offsetX);
  const y = Money.of(input.offsetY);
  for (const v of [x, y]) {
    if (!v.isFinite() || v.abs().greaterThan(MAX_CHECK_OFFSET_IN)) {
      throw validation(`Alignment can move the print at most ${MAX_CHECK_OFFSET_IN} inch in each direction.`);
    }
  }
  return inTransaction(ctx, async (tx) => {
    const before = await getCheckPrintSettings(tx);
    const [existing] = await tx.db
      .select({ id: checkPrintSettings.id })
      .from(checkPrintSettings)
      .where(eq(checkPrintSettings.companyId, tx.companyId));
    const values = { style: input.style, offsetX: x.toFixed(3), offsetY: y.toFixed(3), updatedAt: new Date() };
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
