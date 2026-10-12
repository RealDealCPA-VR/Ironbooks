/**
 * Liability payment workflows — the core QuickBooks "Pay Sales Tax" and
 * "Pay Payroll Liabilities" flows.
 *
 * All GL impact is routed through postJournalEntry (the only writer of balances).
 * Balances of 2200 / 2300 are derived from posted journal entries, not cached
 * columns, so they remain accurate even after void/adjustment entries.
 *
 * p1 purchases: Sales Tax Payments and Pay Payroll Liabilities are CHECK documents
 * (payment_checks): payee, check number or "To be printed" (Print Checks queue), memo, a bank
 * pay-from account, voidable, one check per tax agency when several agencies are paid at once.
 * The journal entry stays the ledger record (sales tax: sourceRef "tax_agency:<agencyId>").
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { isBankAccount } from '@/lib/accountTypes';
import {
  accounts,
  creditMemos,
  customers,
  journalEntries,
  journalEntryLines,
  paymentChecks,
  paymentsReceived,
  taxAgencies,
  vendors,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from './_base';
import { assertNotControlAccount, postJournalEntry, voidJournalEntry } from './posting';
import { assertCheckNumberAvailable, nextCheckNumber } from './checkNumbers';
import { getHomeCurrencyCode } from './currencies';
import { getPreferences } from './company';
import {
  type SalesTaxBasis,
  type SalesTaxDueRow,
  type SalesTaxFrequency,
  lastFilingPeriod,
  salesTaxDueThrough,
  salesTaxLiabilityReport,
} from './accountant/salesTaxLedger';

// ── COA codes fixed by the project spec ─────────────────────────────────────
const CODE_SALES_TAX_PAYABLE = '2200';
const CODE_PAYROLL_LIABILITIES = '2300';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Resolve an account ID by code for this company. Throws VALIDATION when missing. */
async function accountIdByCode(ctx: ServiceContext, code: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  if (!row) {
    throw validation(`Required account ${code} not found in this company's chart of accounts.`);
  }
  return row.id;
}

/**
 * Compute the current credit-normal balance of an account from the posted GL.
 * Liability accounts are credit-normal: credit balance = amount owed.
 * Returns a string (2dp) representing the natural (credit) balance.
 * A positive result means the company owes that amount.
 */
async function creditBalance(ctx: ServiceContext, accountId: string): Promise<string> {
  const [row] = await ctx.db
    .select({
      totalDebit: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      totalCredit: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        eq(journalEntryLines.accountId, accountId),
      ),
    );

  if (!row) return '0.00';
  // Credit-normal: natural balance = credit - debit
  const net = Money.sub(row.totalCredit, row.totalDebit);
  return toAmountString(net);
}

// ── Public API ────────────────────────────────────────────────────────────────

// ── Payment check documents (QB Sales Tax Payment / Liability Check / refund check) ─────────────

export type PaymentCheckKind = 'sales_tax' | 'payroll_liability' | 'customer_refund';
type PaymentCheckRow = typeof paymentChecks.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** QB writes Sales Tax Payment and Liability checks from a Bank account only (home currency). */
async function assertPayFromBank(ctx: ServiceContext, accountId: string, what: string) {
  const [acct] = await ctx.db
    .select({ id: accounts.id, type: accounts.type, subtype: accounts.subtype, name: accounts.name, currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, accountId)));
  if (!acct) throw notFound('Pay from account');
  assertNotControlAccount(acct, 'Pay from');
  if (!isBankAccount(acct)) {
    throw validation(`"${acct.name}" is not a bank account. ${what} is paid by check, so pick a checking or savings account.`);
  }
  const cur = (acct.currency ?? '').trim().toUpperCase();
  if (cur) {
    const home = await getHomeCurrencyCode(ctx);
    if (home && cur !== home) {
      throw validation(`"${acct.name}" is a ${cur} account. Pay ${what.toLowerCase()} from a home-currency bank account.`);
    }
  }
  return acct;
}

/** "1001" → "1002"; a non-numeric number can't be continued (null = take the account's next). */
function followingNumber(n: string): string | null {
  return /^\d+$/.test(n) ? String(parseInt(n, 10) + 1) : null;
}

/**
 * The check number for the next check on `paymentAccountId`: none when it waits in the print
 * queue, the user's number (checked for duplicates), else the account's next number.
 */
async function resolveCheckNumber(
  ctx: ServiceContext,
  opts: { paymentAccountId: string; toPrint: boolean; number?: string | null; allowDuplicateNumber?: boolean },
): Promise<string | null> {
  if (opts.toPrint) return null;
  const n = opts.number?.trim() || (await nextCheckNumber(ctx, opts.paymentAccountId));
  await assertCheckNumberAvailable(ctx, {
    paymentAccountId: opts.paymentAccountId,
    number: n,
    allowDuplicate: opts.allowDuplicateNumber,
  });
  return n;
}

/**
 * The vendor a tax agency's checks are written to. QB tax agencies are vendors: when the agency is
 * not linked yet, link the vendor with the agency's name (created when missing).
 */
export async function ensureAgencyVendor(
  ctx: ServiceContext,
  agencyId: string,
): Promise<{ agency: typeof taxAgencies.$inferSelect; vendor: typeof vendors.$inferSelect }> {
  const [agency] = await ctx.db
    .select()
    .from(taxAgencies)
    .where(and(eq(taxAgencies.companyId, ctx.companyId), eq(taxAgencies.id, agencyId)));
  if (!agency) throw notFound('Tax agency');
  if (agency.vendorId) {
    const [v] = await ctx.db
      .select()
      .from(vendors)
      .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, agency.vendorId)));
    if (v) return { agency, vendor: v };
  }
  return inTransaction(ctx, async (tx) => {
    let [vendor] = await tx.db
      .select()
      .from(vendors)
      .where(and(eq(vendors.companyId, tx.companyId), sql`lower(${vendors.displayName}) = lower(${agency.name})`));
    if (!vendor) {
      [vendor] = await tx.db
        .insert(vendors)
        .values({ companyId: tx.companyId, displayName: agency.name, notes: 'Sales tax agency' })
        .returning();
      await writeAudit(tx, { action: 'create', entityType: 'vendor', entityId: vendor.id, newValues: vendor });
    }
    await tx.db.update(taxAgencies).set({ vendorId: vendor.id }).where(eq(taxAgencies.id, agency.id));
    await writeAudit(tx, {
      action: 'update',
      entityType: 'tax_agency',
      entityId: agency.id,
      oldValues: { vendorId: agency.vendorId },
      newValues: { vendorId: vendor.id },
    });
    return { agency: { ...agency, vendorId: vendor.id }, vendor };
  });
}

/** "Print on check as" name, else the vendor's display name. */
function vendorPayee(v: { displayName: string; printOnCheckAs: string | null } | null | undefined, fallback: string) {
  return (v?.printOnCheckAs ?? '').trim() || (v?.displayName ?? '').trim() || fallback;
}

async function insertPaymentCheck(
  tx: ServiceContext,
  values: Omit<typeof paymentChecks.$inferInsert, 'companyId'>,
): Promise<PaymentCheckRow> {
  const [row] = await tx.db
    .insert(paymentChecks)
    .values({ ...values, companyId: tx.companyId })
    .returning();
  await writeAudit(tx, { action: 'create', entityType: 'payment_check', entityId: row.id, newValues: row });
  return row;
}

export interface SalesTaxPaymentLine {
  agencyId: string;
  /** Amount to pay this agency (> 0). */
  amount: number | string;
}

export interface PaySalesTaxAgenciesInput {
  /** Check date. */
  date: Date;
  /** Bank account the checks are written on. */
  paymentAccountId: string;
  /** One check per agency (QB "Pay All Tax" writes one check per agency). */
  payments: SalesTaxPaymentLine[];
  /** Printed on the memo line; defaults to the agency vendor's account number. */
  memo?: string | null;
  /** Number for the first check; later checks continue the sequence. Ignored with toPrint. */
  checkNumber?: string | null;
  /** QB "To be printed": no number now, the checks wait in Print Checks. */
  toPrint?: boolean;
  /** "Show sales tax due through" date the user paid for (kept on the audit trail). */
  dueThrough?: string | null;
  /** The user confirmed a duplicate check number. */
  allowDuplicateNumber?: boolean;
}

export interface SalesTaxPaymentResult {
  checks: Array<PaymentCheckRow & { entryId: string }>;
  total: string;
}

/**
 * QB Pay Sales Tax: write one Sales Tax Payment check per agency.
 *   Dr <agency liability account, else 2200 Sales Tax Payable>   amount
 *   Cr <bank account>                                             amount
 * The journal entry keeps sourceRef "tax_agency:<agencyId>" (the sales tax ledger attributes the
 * payment to the agency through it) and the check number as its reference, so the check shows in
 * the bank register, Check Detail and Missing Checks. The payment_checks row carries the payee
 * (the agency's vendor), the number and the "To be printed" flag.
 */
export async function paySalesTaxAgencies(
  ctx: ServiceContext,
  input: PaySalesTaxAgenciesInput,
): Promise<SalesTaxPaymentResult> {
  if (!input.payments?.length) throw validation('Pick at least one tax agency to pay.');
  const seen = new Set<string>();
  for (const p of input.payments) {
    if (!p.agencyId || !UUID_RE.test(p.agencyId)) throw validation('Pick the tax agency to pay.');
    if (seen.has(p.agencyId)) throw validation('Each tax agency can only be paid once per payment run.');
    seen.add(p.agencyId);
    let amt;
    try {
      amt = Money.of(p.amount);
    } catch {
      throw validation('Enter a valid amount to pay.');
    }
    if (!amt.greaterThan(0)) throw validation('Payment amount must be greater than zero.');
  }
  await assertPayFromBank(ctx, input.paymentAccountId, 'Sales tax');
  const toPrint = Boolean(input.toPrint);

  const resolved: Array<{ agency: typeof taxAgencies.$inferSelect; vendor: typeof vendors.$inferSelect; amount: string }> = [];
  for (const p of input.payments) {
    const { agency, vendor } = await ensureAgencyVendor(ctx, p.agencyId);
    resolved.push({ agency, vendor, amount: toAmountString(Money.of(p.amount)) });
  }
  const fallback2200 = await accountIdByCode(ctx, CODE_SALES_TAX_PAYABLE);

  return inTransaction(ctx, async (tx) => {
    const checks: SalesTaxPaymentResult['checks'] = [];
    let number: string | null = input.checkNumber?.trim() || null;
    let total = Money.zero();
    for (const r of resolved) {
      const reference = await resolveCheckNumber(tx, {
        paymentAccountId: input.paymentAccountId,
        toPrint,
        number,
        allowDuplicateNumber: input.allowDuplicateNumber,
      });
      if (reference && number) number = followingNumber(reference);
      const payee = vendorPayee(r.vendor, r.agency.name);
      const memo = input.memo?.trim() || (r.vendor.accountNumber ? `Acct # ${r.vendor.accountNumber}` : null);
      const entry = await postJournalEntry(tx, {
        date: input.date,
        description: `Sales Tax Payment — ${r.agency.name}`,
        reference,
        sourceRef: `tax_agency:${r.agency.id}`,
        lines: [
          { accountId: r.agency.liabilityAccountId ?? fallback2200, debit: r.amount, memo: memo ?? `Sales tax — ${r.agency.name}` },
          { accountId: input.paymentAccountId, credit: r.amount, memo: `Sales Tax Payment — ${payee}` },
        ],
      });
      const row = await insertPaymentCheck(tx, {
        kind: 'sales_tax',
        agencyId: r.agency.id,
        vendorId: r.vendor.id,
        payeeName: payee,
        paymentAccountId: input.paymentAccountId,
        date: input.date,
        amount: r.amount,
        reference,
        toPrint,
        memo,
        postedEntryId: entry.id,
      });
      if (input.dueThrough) {
        await writeAudit(tx, {
          action: 'update',
          entityType: 'payment_check',
          entityId: row.id,
          newValues: { action: 'sales_tax_paid', dueThrough: input.dueThrough, agencyId: r.agency.id },
        });
      }
      checks.push({ ...row, entryId: entry.id });
      total = total.plus(Money.of(r.amount));
    }
    return { checks, total: toAmountString(total) };
  });
}

export interface PaySalesTaxInput {
  /** Amount to remit to the tax agency. Must be > 0. */
  amount: number | string;
  /** Payment date. */
  date: Date;
  /** Bank account the Sales Tax Payment check is written on. */
  paymentAccountId: string;
  /** Tax agency being paid (the check's payee). */
  agencyId?: string | null;
  /** Optional memo on the check. */
  memo?: string | null;
  checkNumber?: string | null;
  toPrint?: boolean;
  allowDuplicateNumber?: boolean;
}

/**
 * Pay one tax agency (single-check form of paySalesTaxAgencies). Returns the posted journal
 * entry. Without an agency the check debits 2200 Sales Tax Payable and is payable to
 * "Sales Tax" (the amount shows as unattributed in the sales tax liability views).
 */
export async function paySalesTax(ctx: ServiceContext, input: PaySalesTaxInput) {
  const amt = Money.of(input.amount);
  if (!amt.greaterThan(0)) {
    throw validation('Payment amount must be greater than zero.');
  }
  if (input.agencyId && UUID_RE.test(input.agencyId)) {
    const res = await paySalesTaxAgencies(ctx, {
      date: input.date,
      paymentAccountId: input.paymentAccountId,
      payments: [{ agencyId: input.agencyId, amount: input.amount }],
      memo: input.memo,
      checkNumber: input.checkNumber,
      toPrint: input.toPrint,
      allowDuplicateNumber: input.allowDuplicateNumber,
    });
    const [entry] = await ctx.db.select().from(journalEntries).where(eq(journalEntries.id, res.checks[0].entryId));
    return entry;
  }
  await assertPayFromBank(ctx, input.paymentAccountId, 'Sales tax');
  const salesTaxAccountId = await accountIdByCode(ctx, CODE_SALES_TAX_PAYABLE);
  const amtStr = toAmountString(amt);
  const toPrint = Boolean(input.toPrint);
  return inTransaction(ctx, async (tx) => {
    const reference = await resolveCheckNumber(tx, {
      paymentAccountId: input.paymentAccountId,
      toPrint,
      number: input.checkNumber,
      allowDuplicateNumber: input.allowDuplicateNumber,
    });
    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: input.memo?.trim() || 'Pay Sales Tax',
      reference,
      lines: [
        { accountId: salesTaxAccountId, debit: amtStr },
        { accountId: input.paymentAccountId, credit: amtStr },
      ],
    });
    await insertPaymentCheck(tx, {
      kind: 'sales_tax',
      payeeName: 'Sales Tax',
      paymentAccountId: input.paymentAccountId,
      date: input.date,
      amount: amtStr,
      reference,
      toPrint,
      memo: input.memo?.trim() || null,
      postedEntryId: entry.id,
    });
    return entry;
  });
}

export interface PaymentCheckListRow extends PaymentCheckRow {
  paymentAccountName: string | null;
  /** True when the check (or its journal entry) was voided. */
  isVoid: boolean;
}

/** Sales Tax Payment / Liability / refund checks, newest first. */
export async function listPaymentChecks(
  ctx: ServiceContext,
  opts?: { kind?: PaymentCheckKind; agencyId?: string },
): Promise<PaymentCheckListRow[]> {
  const conds = [eq(paymentChecks.companyId, ctx.companyId)];
  if (opts?.kind) conds.push(eq(paymentChecks.kind, opts.kind));
  if (opts?.agencyId) conds.push(eq(paymentChecks.agencyId, opts.agencyId));
  const rows = await ctx.db
    .select({ c: paymentChecks, acctName: accounts.name, entryStatus: journalEntries.status })
    .from(paymentChecks)
    .leftJoin(accounts, eq(paymentChecks.paymentAccountId, accounts.id))
    .leftJoin(journalEntries, eq(paymentChecks.postedEntryId, journalEntries.id))
    .where(and(...conds))
    .orderBy(desc(paymentChecks.date), desc(paymentChecks.createdAt));
  return rows.map((r) => ({
    ...r.c,
    paymentAccountName: r.acctName ?? null,
    isVoid: Boolean(r.c.voidedAt) || r.entryStatus === 'void',
  }));
}

export async function getPaymentCheck(ctx: ServiceContext, id: string): Promise<PaymentCheckRow> {
  if (!UUID_RE.test(id)) throw notFound('Check');
  const [row] = await ctx.db
    .select()
    .from(paymentChecks)
    .where(and(eq(paymentChecks.companyId, ctx.companyId), eq(paymentChecks.id, id)));
  if (!row) throw notFound('Check');
  return row;
}

/**
 * Void a Sales Tax Payment / Liability / refund check (QB Void Check): the journal entry is voided
 * (the liability is owed again and the bank gets the money back; a voided customer refund gives the
 * customer the credit back) and the check keeps its number, marked void.
 */
export async function voidPaymentCheck(ctx: ServiceContext, id: string): Promise<PaymentCheckRow> {
  const check = await getPaymentCheck(ctx, id);
  if (check.voidedAt) return check;
  return inTransaction(ctx, async (tx) => {
    if (check.postedEntryId) {
      const [entry] = await tx.db
        .select({ status: journalEntries.status })
        .from(journalEntries)
        .where(eq(journalEntries.id, check.postedEntryId));
      if (entry && entry.status !== 'void') await voidJournalEntry(tx, check.postedEntryId);
    }
    const [updated] = await tx.db
      .update(paymentChecks)
      .set({ voidedAt: new Date(), toPrint: false })
      .where(eq(paymentChecks.id, check.id))
      .returning();
    await writeAudit(tx, {
      action: 'void',
      entityType: 'payment_check',
      entityId: check.id,
      oldValues: { voidedAt: null, toPrint: check.toPrint },
      newValues: { voidedAt: updated.voidedAt, kind: check.kind },
    });
    return updated;
  });
}

/** Stamp the check number on a queued payment check (and its journal entry reference). */
export async function markPaymentCheckPrinted(
  ctx: ServiceContext,
  input: { id: string; checkNumber?: string; allowDuplicateNumber?: boolean },
): Promise<PaymentCheckRow> {
  const check = await getPaymentCheck(ctx, input.id);
  if (check.voidedAt) throw new ServiceError('CONFLICT', 'This check is void and cannot be printed.');
  if (!check.toPrint) throw new ServiceError('CONFLICT', 'This check is not in the print queue.');
  const checkNumber = input.checkNumber?.trim() || (await nextCheckNumber(ctx, check.paymentAccountId));
  await assertCheckNumberAvailable(ctx, {
    paymentAccountId: check.paymentAccountId,
    number: checkNumber,
    exclude: { source: 'payment_check', id: check.id },
    allowDuplicate: input.allowDuplicateNumber,
  });
  return inTransaction(ctx, async (tx) => {
    const [updated] = await tx.db
      .update(paymentChecks)
      .set({ toPrint: false, reference: checkNumber })
      .where(eq(paymentChecks.id, check.id))
      .returning();
    if (check.postedEntryId) {
      await tx.db
        .update(journalEntries)
        .set({ reference: checkNumber, updatedAt: new Date() })
        .where(and(eq(journalEntries.id, check.postedEntryId), eq(journalEntries.companyId, tx.companyId)));
    }
    await writeAudit(tx, {
      action: 'update',
      entityType: 'payment_check',
      entityId: check.id,
      oldValues: { toPrint: true, reference: check.reference },
      newValues: { toPrint: false, reference: checkNumber },
    });
    return updated;
  });
}

/**
 * Customer refund checks (D3): put an existing customer refund (credit memo or overpayment refund,
 * journal entry sourceRef "refund:<id>" paid from a bank account) in the Print Checks queue as a
 * check to the customer. The refund itself is already posted; this only adds the check document.
 */
export async function queueCustomerRefundCheck(
  ctx: ServiceContext,
  input: { entryId: string; memo?: string | null },
): Promise<PaymentCheckRow> {
  if (!UUID_RE.test(input.entryId)) throw notFound('Refund');
  const [entry] = await ctx.db
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.id, input.entryId)));
  if (!entry || !entry.sourceRef?.startsWith('refund:')) throw notFound('Customer refund');
  if (entry.status !== 'posted') throw new ServiceError('CONFLICT', 'This refund is void.');
  const [existing] = await ctx.db
    .select({ id: paymentChecks.id })
    .from(paymentChecks)
    .where(and(eq(paymentChecks.companyId, ctx.companyId), eq(paymentChecks.postedEntryId, entry.id)));
  if (existing) throw new ServiceError('CONFLICT', 'This refund already has a check.');
  const refund = (await unprintedRefunds(ctx)).find((r) => r.entryId === entry.id);
  if (!refund) {
    throw validation('Only a customer refund paid from a bank account, with no check number yet, can be printed as a check.');
  }
  return inTransaction(ctx, async (tx) =>
    insertPaymentCheck(tx, {
      kind: 'customer_refund',
      customerId: refund.customerId,
      payeeName: refund.payee,
      paymentAccountId: refund.paymentAccountId,
      date: entry.date,
      amount: refund.amount,
      reference: null,
      toPrint: true,
      memo: input.memo?.trim() || entry.description || 'Refund',
      postedEntryId: entry.id,
    }),
  );
}

export interface UnprintedRefund {
  entryId: string;
  date: Date;
  customerId: string | null;
  payee: string;
  amount: string;
  paymentAccountId: string;
  paymentAccountName: string;
  description: string;
}

/**
 * Customer refunds paid from a bank account with no check number and no check document yet —
 * the candidates for "Add refund checks" on Print Checks.
 */
export async function unprintedRefunds(ctx: ServiceContext): Promise<UnprintedRefund[]> {
  const rows = await ctx.db
    .select({
      entryId: journalEntries.id,
      date: journalEntries.date,
      description: journalEntries.description,
      reference: journalEntries.reference,
      sourceRef: journalEntries.sourceRef,
      accountId: journalEntryLines.accountId,
      credit: journalEntryLines.credit,
      acctName: accounts.name,
      acctType: accounts.type,
      acctSubtype: accounts.subtype,
    })
    .from(journalEntries)
    .innerJoin(journalEntryLines, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        sql`${journalEntries.sourceRef} LIKE 'refund:%'`,
        sql`COALESCE(${journalEntryLines.credit}, 0) > 0`,
        sql`NOT EXISTS (SELECT 1 FROM payment_checks pc WHERE pc.posted_entry_id = ${journalEntries.id})`,
      ),
    );
  const banks = rows.filter(
    (r) => isBankAccount({ type: r.acctType, subtype: r.acctSubtype }) && !(r.reference ?? '').trim(),
  );
  if (banks.length === 0) return [];
  const docIds = [...new Set(banks.map((r) => r.sourceRef!.slice('refund:'.length)).filter((x) => UUID_RE.test(x)))];
  const memoRows = docIds.length
    ? await ctx.db
        .select({ id: creditMemos.id, customerId: creditMemos.customerId, name: customers.displayName })
        .from(creditMemos)
        .innerJoin(customers, eq(creditMemos.customerId, customers.id))
        .where(and(eq(creditMemos.companyId, ctx.companyId), inArray(creditMemos.id, docIds)))
    : [];
  const payRows = docIds.length
    ? await ctx.db
        .select({ id: paymentsReceived.id, customerId: paymentsReceived.customerId, name: customers.displayName })
        .from(paymentsReceived)
        .innerJoin(customers, eq(paymentsReceived.customerId, customers.id))
        .where(and(eq(paymentsReceived.companyId, ctx.companyId), inArray(paymentsReceived.id, docIds)))
    : [];
  const byDoc = new Map([...memoRows, ...payRows].map((r) => [r.id, r] as const));
  const out: UnprintedRefund[] = [];
  for (const r of banks) {
    const doc = byDoc.get(r.sourceRef!.slice('refund:'.length));
    if (!doc) continue; // vendor-credit refunds bring money IN — not a check to a customer
    out.push({
      entryId: r.entryId,
      date: r.date,
      customerId: doc.customerId,
      payee: doc.name,
      amount: toAmountString(Money.of(r.credit ?? 0)),
      paymentAccountId: r.accountId,
      paymentAccountName: r.acctName,
      description: r.description,
    });
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** One itemized payroll-liability payment line (e.g. "Federal Income Tax" → $300). */
export interface PayrollLiabilityItemInput {
  /** Payroll item name as reported by payrollLiabilityBalances (e.g. "Federal Income Tax",
   * "401k", "Employer Social Security"). Stamped as the journal-line memo so the
   * payment reconciles against this specific item. */
  name: string;
  /** Amount to remit for this item. Must be > 0. */
  amount: number | string;
}

export interface PayPayrollLiabilitiesInput {
  /**
   * Lump-sum amount to remit (e.g. 941 tax deposit). Required when `items` is
   * omitted/empty. When `items` IS provided, this is optional — if present it must
   * equal the sum of the item amounts.
   */
  amount?: number | string;
  /** Payment date. */
  date: Date;
  /** Bank / cash account used to make the payment. */
  paymentAccountId: string;
  /** Optional memo. */
  memo?: string | null;
  /**
   * Per-item amounts (QB Pay Liabilities). Each item posts its own Dr 2300 line
   * with the item name as the memo, so payments can be reconciled per tax/deduction.
   */
  items?: PayrollLiabilityItemInput[];
  /** QB Liability Check payee: the vendor (tax agency / benefits provider) being paid. */
  vendorId?: string | null;
  /** Free-text payee when there is no vendor. */
  payeeName?: string | null;
  /** Check number (bank pay-from only); next number when omitted, none with toPrint. */
  checkNumber?: string | null;
  /** "To be printed": the check waits in Print Checks. */
  toPrint?: boolean;
  allowDuplicateNumber?: boolean;
}

/**
 * Post a payroll liability payment. Paid from a bank account it is a QB Liability Check: a
 * payment_checks row (payee, number / "To be printed") linked to the entry. Other pay-from
 * accounts (legacy callers) post the plain entry.
 */
async function postLiabilityPayment(
  ctx: ServiceContext,
  input: PayPayrollLiabilitiesInput,
  entry: { description: string; lines: Array<{ accountId: string; debit?: string; credit?: string; memo?: string | null }> },
  total: string,
) {
  const [payFrom] = await ctx.db
    .select({ type: accounts.type, subtype: accounts.subtype, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, input.paymentAccountId)));
  if (payFrom) assertNotControlAccount(payFrom, 'Pay from');
  if (!payFrom || !isBankAccount(payFrom)) {
    return postJournalEntry(ctx, { date: input.date, description: entry.description, lines: entry.lines });
  }
  let payee = input.payeeName?.trim() || '';
  let vendorId: string | null = null;
  if (input.vendorId) {
    const [v] = await ctx.db
      .select()
      .from(vendors)
      .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, input.vendorId)));
    if (!v) throw notFound('Vendor');
    vendorId = v.id;
    payee = vendorPayee(v, payee || v.displayName);
  }
  const toPrint = Boolean(input.toPrint);
  return inTransaction(ctx, async (tx) => {
    const reference = await resolveCheckNumber(tx, {
      paymentAccountId: input.paymentAccountId,
      toPrint,
      number: input.checkNumber,
      allowDuplicateNumber: input.allowDuplicateNumber,
    });
    const posted = await postJournalEntry(tx, {
      date: input.date,
      description: payee ? `${entry.description} — ${payee}` : entry.description,
      reference,
      lines: entry.lines,
    });
    await insertPaymentCheck(tx, {
      kind: 'payroll_liability',
      vendorId,
      payeeName: payee || 'Payroll liabilities',
      paymentAccountId: input.paymentAccountId,
      date: input.date,
      amount: total,
      reference,
      toPrint,
      memo: input.memo?.trim() || null,
      postedEntryId: posted.id,
    });
    return posted;
  });
}

/**
 * Pay payroll liabilities:
 *   Dr 2300 Payroll Liabilities  <amount>      (one line per item when itemized)
 *   Cr <paymentAccountId>        <total>
 *
 * Reduces the Payroll Liabilities balance and drains the bank account. Itemized
 * payments stamp each item's name as the 2300 debit-line memo — that memo is how
 * payrollLiabilityBalances attributes payments back to specific payroll items.
 */
export async function payPayrollLiabilities(
  ctx: ServiceContext,
  input: PayPayrollLiabilitiesInput,
) {
  const payrollAccountId = await accountIdByCode(ctx, CODE_PAYROLL_LIABILITIES);
  const items = input.items ?? [];

  // ── Itemized payment ──────────────────────────────────────────────────────
  if (items.length > 0) {
    let total = Money.zero();
    const debitLines: Array<{ accountId: string; debit: string; memo: string }> = [];
    const seen = new Set<string>();
    for (const item of items) {
      const name = item.name?.trim();
      if (!name) throw validation('Each liability item needs a name.');
      if (seen.has(name)) {
        throw validation(`Duplicate liability item "${name}" — combine into one line.`);
      }
      seen.add(name);
      let amt;
      try {
        amt = Money.of(item.amount);
      } catch {
        throw validation(`Liability item "${name}": amount is not a valid number.`);
      }
      if (!amt.greaterThan(0)) {
        throw validation(`Liability item "${name}": amount must be greater than zero.`);
      }
      total = total.plus(amt);
      debitLines.push({
        accountId: payrollAccountId,
        debit: toAmountString(amt),
        memo: name,
      });
    }

    if (input.amount != null && input.amount !== '' && !Money.eq(input.amount, total)) {
      throw validation(
        `amount (${toAmountString(Money.of(input.amount))}) does not match the sum of the item amounts (${toAmountString(total)}).`,
      );
    }

    const description = input.memo?.trim()
      ? input.memo.trim()
      : `Pay Payroll Liabilities — ${items.length} item${items.length === 1 ? '' : 's'}`;

    return postLiabilityPayment(
      ctx,
      input,
      {
        description,
        lines: [...debitLines, { accountId: input.paymentAccountId, credit: toAmountString(total) }],
      },
      toAmountString(total),
    );
  }

  // ── Legacy lump-sum payment ───────────────────────────────────────────────
  if (input.amount == null || input.amount === '') {
    throw validation('Provide amount or at least one liability item.');
  }
  const amt = Money.of(input.amount);
  if (!amt.greaterThan(0)) {
    throw validation('Payment amount must be greater than zero.');
  }

  const amtStr = toAmountString(amt);
  const description = input.memo?.trim() ? input.memo.trim() : 'Pay Payroll Liabilities';

  return postLiabilityPayment(
    ctx,
    input,
    {
      description,
      lines: [
        { accountId: payrollAccountId, debit: amtStr },
        { accountId: input.paymentAccountId, credit: amtStr },
      ],
    },
    amtStr,
  );
}

export interface PayCreditCardInput {
  /** GL liability account for the credit card (Dr side — reduces the amount owed). */
  creditCardAccountId: string;
  /** Bank / cash GL account the payment is drawn from (Cr side). */
  paymentAccountId: string;
  /** Amount to pay. Must be > 0. */
  amount: number | string;
  /** Payment date. */
  date: Date;
  /**
   * When the payment settles a completed credit-card reconciliation, pass its id:
   * the entry is stamped sourceRef "cc-payment:<reconciliationId>" and a second
   * payment for the same reconciliation is rejected (CONFLICT).
   */
  reconciliationId?: string | null;
  /** Optional memo / description. */
  memo?: string | null;
}

/**
 * Pay a credit card (QB "Write a check for the balance" after reconciling a CC):
 *   Dr <creditCardAccountId>  <amount>   — reduces the card liability
 *   Cr <paymentAccountId>     <amount>   — drains the bank account
 */
export async function payCreditCard(ctx: ServiceContext, input: PayCreditCardInput) {
  const amt = Money.of(input.amount);
  if (!amt.greaterThan(0)) {
    throw validation('Payment amount must be greater than zero.');
  }
  if (!input.creditCardAccountId) throw validation('creditCardAccountId is required.');
  if (!input.paymentAccountId) throw validation('paymentAccountId is required.');
  if (input.creditCardAccountId === input.paymentAccountId) {
    throw validation('Payment account must be different from the credit card account.');
  }

  // Both accounts must belong to this company; the CC side must be a liability.
  const [cc] = await ctx.db
    .select({ id: accounts.id, type: accounts.type })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, input.creditCardAccountId)));
  if (!cc) throw notFound('Credit card account');
  if (cc.type !== 'liability') {
    throw validation('creditCardAccountId must be a liability (credit card) account.');
  }
  const [pay] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, input.paymentAccountId)));
  if (!pay) throw notFound('Payment account');

  // Duplicate guard: one payment per reconciliation.
  const sourceRef = input.reconciliationId ? `cc-payment:${input.reconciliationId}` : undefined;
  if (sourceRef) {
    const [existing] = await ctx.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.sourceRef, sourceRef),
          eq(journalEntries.status, 'posted'),
        ),
      );
    if (existing) {
      throw new ServiceError(
        'CONFLICT',
        'A credit card payment for this reconciliation has already been recorded.',
      );
    }
  }

  const amtStr = toAmountString(amt);
  return postJournalEntry(ctx, {
    date: input.date,
    description: input.memo?.trim() ? input.memo.trim() : 'Credit card payment',
    sourceRef,
    lines: [
      { accountId: input.creditCardAccountId, debit: amtStr },
      { accountId: input.paymentAccountId, credit: amtStr },
    ],
  });
}

/**
 * Current credit balance of account 2200 (Sales Tax Payable).
 * A positive number means the company owes that amount in sales tax.
 */
export async function salesTaxDue(ctx: ServiceContext): Promise<string> {
  const accountId = await accountIdByCode(ctx, CODE_SALES_TAX_PAYABLE);
  return creditBalance(ctx, accountId);
}

/**
 * Current credit balance of account 2300 (Payroll Liabilities).
 * A positive number means the company owes that amount in payroll taxes/withholdings.
 */
export async function payrollLiabilitiesDue(ctx: ServiceContext): Promise<string> {
  const accountId = await accountIdByCode(ctx, CODE_PAYROLL_LIABILITIES);
  return creditBalance(ctx, accountId);
}

// ── Sales tax by agency (QB Pay Sales Tax grid) ──────────────────────────────

export interface AgencyLiabilityRow {
  /** null = tax that cannot be tied to an agency (no rate/agency, or recorded outside sales tax). */
  agencyId: string | null;
  agencyName: string | null;
  /** The agency's dedicated liability account (payments post here when set; else 2200). */
  liabilityAccountId: string | null;
  /** Owed before the range (all earlier activity). '0.00' when no `from`. */
  openingBalance: string;
  /** Net tax charged in the range: invoices + sales receipts − credit memos. */
  collected: string;
  /** Sales tax adjustments in the range (signed; + increases what is owed). */
  adjusted: string;
  /** Payments remitted to this agency in the range. */
  paid: string;
  /** Owed as of the end of the range: opening + collected + adjusted − paid. */
  balance: string;
}

export interface SalesTaxLiabilityByAgencyResult {
  rows: AgencyLiabilityRow[];
  totalCollected: string;
  totalPaid: string;
  totalBalance: string;
  /** Sales-tax liability accounts' GL balance at the end of the range. */
  glBalance: string;
  /** Σ balances == GL (accrual). */
  tiesToGl: boolean;
}

/**
 * Per-agency sales-tax liability for the QB "Pay Sales Tax" screen.
 *
 * GL-driven (lib/services/accountant/salesTaxLedger.ts): every posted line on a sales-tax
 * liability account is attributed to agencies — invoice / sales receipt / credit memo tax via the
 * document's rates and combined-rate components, Pay Sales Tax payments ("tax_agency:<id>"),
 * Sales Tax Adjustments ("sales_tax_adj:<id>") and lines linked by Fix Incorrectly Recorded Sales
 * Tax. Voided documents drop out automatically, and Σ balance equals the GL balance exactly.
 * Activity that cannot be attributed shows in the null-agency row.
 */
export async function salesTaxLiabilityByAgency(
  ctx: ServiceContext,
  range?: { from?: Date; to?: Date; basis?: SalesTaxBasis },
): Promise<SalesTaxLiabilityByAgencyResult> {
  const report = await salesTaxLiabilityReport(ctx, range ?? {});
  const rows: AgencyLiabilityRow[] = report.agencies.map((a) => ({
    agencyId: a.agencyId,
    agencyName: a.agencyName,
    liabilityAccountId: a.liabilityAccountId,
    openingBalance: a.openingBalance,
    collected: toAmountString(Money.add(a.collected, a.credited, a.unattributed)),
    adjusted: a.adjustments,
    paid: a.paid,
    balance: a.balance,
  }));
  // Largest balances first; the null bucket sorts by its balance too.
  rows.sort((a, b) => Money.of(b.balance).comparedTo(Money.of(a.balance)));
  return {
    rows,
    totalCollected: toAmountString(Money.add(report.totals.collected, report.totals.credited, report.totals.unattributed)),
    totalPaid: report.totals.paid,
    totalBalance: report.totals.balance,
    glBalance: report.glBalance,
    tiesToGl: report.tiesToGl,
  };
}

// ── Pay Sales Tax screen (QB Vendors > Sales Tax > Pay Sales Tax) ────────────────────────────────

export interface PaySalesTaxScreenRow extends SalesTaxDueRow {
  /** Payee on the check: the agency's vendor ("print on check as"), else the agency name. */
  payee: string | null;
  vendorId: string | null;
}

export interface PaySalesTaxScreen {
  /** Company preference: owe sales tax as of invoice date (accrual) or upon payment (cash). */
  basis: SalesTaxBasis;
  frequency: SalesTaxFrequency;
  /** Default "Show sales tax due through": the end of the last filing period. */
  defaultDueThrough: string;
  dueThrough: string;
  rows: PaySalesTaxScreenRow[];
  totalDue: string;
}

/**
 * Data for Pay Sales Tax: per-agency amounts due through `dueThrough` (default: end of the last
 * filing period for the company's filing frequency) on the company's sales tax basis.
 */
export async function paySalesTaxScreen(
  ctx: ServiceContext,
  opts: { dueThrough?: string | null; today?: Date } = {},
): Promise<PaySalesTaxScreen> {
  const prefs = await getPreferences(ctx);
  const basis: SalesTaxBasis = prefs.salesTaxBasis === 'cash' ? 'cash' : 'accrual';
  const frequency = prefs.salesTaxFrequency as SalesTaxFrequency;
  const defaultDueThrough = lastFilingPeriod(frequency, opts.today ?? new Date()).to;
  const dueThrough =
    opts.dueThrough && /^\d{4}-\d{2}-\d{2}/.test(opts.dueThrough) ? opts.dueThrough.slice(0, 10) : defaultDueThrough;
  const due = await salesTaxDueThrough(ctx, { dueThrough, basis });
  const agencyRows = await ctx.db
    .select({ id: taxAgencies.id, name: taxAgencies.name, vendorId: vendors.id, displayName: vendors.displayName, printOnCheckAs: vendors.printOnCheckAs })
    .from(taxAgencies)
    .leftJoin(vendors, eq(taxAgencies.vendorId, vendors.id))
    .where(eq(taxAgencies.companyId, ctx.companyId));
  const byId = new Map(agencyRows.map((a) => [a.id, a] as const));
  return {
    basis,
    frequency,
    defaultDueThrough,
    dueThrough: due.dueThrough,
    rows: due.rows.map((r) => {
      const a = r.agencyId ? byId.get(r.agencyId) : undefined;
      return {
        ...r,
        vendorId: a?.vendorId ?? null,
        payee: a ? (a.vendorId ? vendorPayee({ displayName: a.displayName ?? a.name, printOnCheckAs: a.printOnCheckAs }, a.name) : a.name) : null,
      };
    }),
    totalDue: due.totalDue,
  };
}
