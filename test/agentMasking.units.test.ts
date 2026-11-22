/**
 * Full account numbers and SSNs reach only callers with the matching right (plan 5.9, decision D6),
 * person or agent. The first wave's reviewers found four answers that skipped lib/permissions/mask.ts
 * (_vr_tmp/WAVE1-NOTES.md, banking / planning / lists / payroll):
 *
 *   1. the check print queue put the payee's full account number in the memo ("Acct # …");
 *   2. Sales Tax Payment checks store that memo, and every answer that lists or returns them sent it
 *      (the payment also copied it onto its journal entry's line, which the ledger answers unmasked);
 *   3. assigning a vendor type answered the whole vendor row (tax ID, account number);
 *   4. the state wage worksheet answered the employer's state account number in full.
 *
 * Each case: a caller without the right gets the masked form, a caller with it the full value, and
 * the text printed on the check is unchanged.
 *
 * The third wave closed what the second left open (_vr_tmp/WAVE2-NOTES.md, masking-fixes and
 * effects-callers):
 *
 *   5. line memos already in the books ("Acct # …" on Sales Tax Payment entries posted before the
 *      payment stopped copying it, or typed) were answered as stored by the journal entry, the
 *      registers, the report lines, Check Detail and the journal lines Pay Bills / Receive Payments
 *      list, and the memo filters let a caller test guesses at the hidden digits. The books keep
 *      the stored text: a save as shown, Undo and a reversal never write the masked text;
 *   6. the vendor lookup sent a payee's name to the company's SearXNG in an agent's preview.
 *
 * The fourth wave closed the places the third left (_vr_tmp/WAVE3-NOTES.md, masking, audit,
 * tests-reads, classes-a):
 *
 *   5. the journal entry window (GET /api/journal-entries/[id]) answered the stored memo;
 *   6. a preview of a payee already looked up said nothing about the lookup server;
 *   7. the shareable ledger's Journal sheet, a receipt's text (a W-9 dropped into the inbox), the
 *      transaction log's records and search, the audit-based accountant reports, and the words of
 *      an approved reveal; and Transaction Detail read the whole scan cap for every search.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { closeDb, getDb, type DB } from '@/lib/db';
import {
  accounts,
  agentPermissionRequests,
  bankAccounts,
  bankTransactions,
  journalEntries,
  journalEntryLines,
  paymentChecks,
  receiptScans,
  users,
  vendors,
} from '@/lib/db/schema';
import { effectsOfFailedRun, runWithEffects } from '@/lib/effects';
import { isNotRunInPreview } from '@/lib/ai/outbound';
import { fullAccess, withoutAreas, type EffectiveAccess } from '@/lib/permissions/model';
import type { ServiceContext } from '@/lib/services/_base';
import { createCompany } from '@/lib/services/company';
import { createExpense } from '@/lib/services/expenses';
import { createEntry } from '@/lib/services/lists/simpleLists';
import { createBill } from '@/lib/services/bills';
import { payBills } from '@/lib/services/billPayments';
import { createTaxAgency } from '@/lib/services/salesTax';
import {
  checkMemoFor,
  getPaymentCheck,
  listPaymentChecks,
  paySalesTax,
  paySalesTaxAgencies,
  voidPaymentCheck,
} from '@/lib/services/liabilityPayments';
import {
  accountRegister,
  createManualEntry,
  getAdjustingEntries,
  getEntry,
  getEntryForCaller,
  ilikeMatches,
  journalOpenItems,
  lineMemoFor,
  memoMayHoldAccountNumber,
  reverseEntry,
  updateEntry,
  voidEntry,
  type JournalEntryDetail,
  type UpdateEntryInput,
} from '@/lib/services/journal';
import { listJournalOpenItems } from '@/lib/services/journalApplications';
import { commitUndo, performUndo, prepareUndo } from '@/lib/services/undo';
import { PgSelectQueryBuilderBase } from 'drizzle-orm/pg-core';
import { fetchGlLines, GL_LIMITS, loadAccountMeta } from '@/lib/services/reportEngine';
import { checkDetail, transactionDetail } from '@/lib/services/reportsExtra';
import { checkPrintData, listPrintQueue, markPrinted } from '@/lib/services/printQueue';
import { assignVendorType, createType } from '@/lib/services/typeLists';
import { listStateTaxSettings, upsertStateTaxSetting } from '@/lib/services/payrollAdjustments';
import { stateWageWorksheet } from '@/lib/services/payrollReports';
import { setNetworkPolicy } from '@/lib/services/networkPolicy';
import { clearVendorLookupCache, lookupVendor, VENDOR_LOOKUP_PURPOSE } from '@/lib/services/vendorLookup';
import { llmSuggestBankCategory, suggestAccountForPayee } from '@/lib/services/aiCategorizer';

import AdmZip from 'adm-zip';
import type { ReportParams } from '@/lib/validation/reports';
import { writeAudit } from '@/lib/services/_base';
import { appendTransactionLog } from '@/lib/services/transactionLog';
import { buildShareableLedgerXlsx } from '@/lib/services/shareableLedger';
import { getReceipt, listReceipts, receiptTextFor, uploadReceipt } from '@/lib/services/receipts';
import { agentActivityReport, getAuditLog, listAuditLogs } from '@/lib/services/auditTrail';
import { voidedDeletedTransactions } from '@/lib/services/accountant/auditReports';

/** The caller the routes under test run for (GET /api/journal-entries/[id], GET /api/transaction-log). */
let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));
import { GET as entryGET } from '@/app/api/journal-entries/[id]/route';
import { GET as logGET } from '@/app/api/transaction-log/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-agent-masking-units');
let db: DB;
/** Trusted (no access): sets the company up. */
let ctx: ServiceContext;
/** Every right but "view full account numbers" and "sensitive payroll". */
let masked: ServiceContext;
/** Every right, both flags included. */
let full: ServiceContext;
let acct: Record<string, string>;

const FULL_NUMBER = '000123456789';
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

/** Admin permissions with the two "view sensitive data" flags set as given: only the flags differ. */
function accessWithFlags(on: boolean): EffectiveAccess {
  const a = fullAccess();
  return { ...a, flags: { ...a.flags, fullAccountNumbers: on, sensitivePayroll: on } };
}

async function vendorWithNumber(displayName: string, extra: Partial<typeof vendors.$inferInsert> = {}) {
  const [v] = await db
    .insert(vendors)
    .values({ companyId: ctx.companyId, displayName, accountNumber: FULL_NUMBER, ...extra })
    .returning();
  return v;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'masking@units.local', name: 'Masking', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Masking Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  masked = { ...ctx, access: accessWithFlags(false) };
  full = { ...ctx, access: accessWithFlags(true) };
  const rows = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  acct = Object.fromEntries(rows.map((r) => [r.code, r.id]));
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('checkMemoFor (the memo text as a caller may see it)', () => {
  it('masks the account number after "Acct #" for a caller without the right', () => {
    expect(checkMemoFor(masked, `Acct # ${FULL_NUMBER}`)).toBe('Acct # ••••6789');
    expect(checkMemoFor(masked, 'Acct # 1234 5678 9012')).toBe('Acct # ••••9012');
    expect(checkMemoFor(masked, 'ACCT#ACC-778')).toBe('ACCT#••••-778');
    expect(checkMemoFor(masked, 'Acct # 12')).toBe('Acct # ••••');
    // A memo typed over two lines: everything after "Acct #" is masked, the line break included.
    expect(checkMemoFor(masked, 'Paid in full\nAcct # 0001\n23456789')).toBe('Paid in full\nAcct # ••••6789');
  });

  it('shows the memo as stored to a caller with the right and to a trusted context', () => {
    expect(checkMemoFor(full, `Acct # ${FULL_NUMBER}`)).toBe(`Acct # ${FULL_NUMBER}`);
    expect(checkMemoFor(ctx, `Acct # ${FULL_NUMBER}`)).toBe(`Acct # ${FULL_NUMBER}`);
  });

  it('leaves other memos, blanks and already masked text alone', () => {
    expect(checkMemoFor(masked, 'Q3 extra')).toBe('Q3 extra');
    expect(checkMemoFor(masked, null)).toBeNull();
    expect(checkMemoFor(masked, '')).toBe('');
    expect(checkMemoFor(masked, 'Acct # ••••6789')).toBe('Acct # ••••6789');
    expect(checkMemoFor(masked, 'Acct # ••••')).toBe('Acct # ••••');
  });

  it('a "*" or "•" in the text does not count as masked unless it is exactly the mask', () => {
    // A typed note after the number, or a number brought in by import that holds a "*".
    const typed = checkMemoFor(masked, `Acct # ${FULL_NUMBER} *rush*`);
    expect(typed).toBe('Acct # ••••ush*');
    expect(typed).not.toContain(FULL_NUMBER);
    expect(checkMemoFor(masked, 'Acct # 0001*23456789')).toBe('Acct # ••••6789');
    expect(checkMemoFor(masked, 'Acct # ••••0001 23456789')).toBe('Acct # ••••6789');
  });

  it('errs on the safe side for typed memos: everything after "Acct #" is masked', () => {
    // Deliberate: the end of an account number cannot be told from the text that follows it.
    expect(checkMemoFor(masked, 'Ref acct #5 of 12 invoices')).toBe('Ref acct #••••ices');
    expect(checkMemoFor(masked, `Paid (Acct # ${FULL_NUMBER})`)).toBe('Paid (Acct # ••••789)');
    // A caller with the right sees what was typed.
    expect(checkMemoFor(full, 'Ref acct #5 of 12 invoices')).toBe('Ref acct #5 of 12 invoices');
  });
});

describe('1. the check print queue', () => {
  it('a Write Checks check: the listing masks the memo, the printed check keeps the full number', async () => {
    const v = await vendorWithNumber('Water Utility');
    const exp = await createExpense(ctx, {
      vendorId: v.id,
      date: d('2026-03-02'),
      method: 'check',
      toPrint: true,
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6600'], amount: '10.00' }],
    });
    const hidden = (await listPrintQueue(masked)).find((q) => q.id === exp.id);
    expect(hidden?.memo).toBe('Acct # ••••6789');
    expect((await listPrintQueue(full)).find((q) => q.id === exp.id)?.memo).toBe(`Acct # ${FULL_NUMBER}`);
    // The paper check: unchanged, whoever prints it.
    expect((await checkPrintData(masked, 'expense', exp.id)).memo).toBe(`Acct # ${FULL_NUMBER}`);
    expect((await checkPrintData(full, 'expense', exp.id)).memo).toBe(`Acct # ${FULL_NUMBER}`);
  });

  it('an Other Names payee: same rule; a typed memo is shown as typed', async () => {
    const landlord = await createEntry(ctx, 'other-names', { name: 'Landlord LLC', accountNumber: 'LEASE-55501234' });
    const exp = await createExpense(ctx, {
      otherNameId: String(landlord.id),
      date: d('2026-03-03'),
      method: 'check',
      toPrint: true,
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6600'], amount: '900.00' }],
    });
    expect((await listPrintQueue(masked)).find((q) => q.id === exp.id)?.memo).toBe('Acct # ••••1234');
    expect((await listPrintQueue(full)).find((q) => q.id === exp.id)?.memo).toBe('Acct # LEASE-55501234');
    expect((await checkPrintData(masked, 'expense', exp.id)).memo).toBe('Acct # LEASE-55501234');

    const typed = await createExpense(ctx, {
      otherNameId: String(landlord.id),
      date: d('2026-03-04'),
      method: 'check',
      toPrint: true,
      memo: 'March rent',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6600'], amount: '900.00' }],
    });
    expect((await listPrintQueue(masked)).find((q) => q.id === typed.id)?.memo).toBe('March rent');
  });

  it('a Pay Bills check: the listing masks the memo, the printed check keeps the full number', async () => {
    const v = await vendorWithNumber('Paper Supplier', { printOnCheckAs: 'Paper Supplier LLC' });
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-04-03'), lines: [{ accountId: acct['6600'], amount: '60.00' }] });
    const pay = await payBills(ctx, {
      vendorId: v.id,
      date: d('2026-04-04'),
      method: 'check',
      paymentAccountId: acct['1000'],
      toPrint: true,
      applications: [{ billId: bill.id, amountApplied: '60.00' }],
    });
    const list = await listPrintQueue(masked);
    expect(list.find((q) => q.id === pay.id)?.memo).toBe('Acct # ••••6789');
    expect(JSON.stringify(list)).not.toContain(FULL_NUMBER);
    expect((await listPrintQueue(full)).find((q) => q.id === pay.id)?.memo).toBe(`Acct # ${FULL_NUMBER}`);
    expect((await checkPrintData(masked, 'bill_payment', pay.id)).memo).toBe(`Acct # ${FULL_NUMBER}`);
  });
});

describe('2. Sales Tax Payment checks', () => {
  let agencyId: string;

  beforeAll(async () => {
    // The agency's vendor, found by name when the payment links it, carries the account number.
    await vendorWithNumber('State Revenue Dept');
    agencyId = (await createTaxAgency(ctx, { name: 'State Revenue Dept' })).id;
  });

  it('stores and prints the full number on the check; the check answers mask it and the ledger never holds it', async () => {
    const paid = await paySalesTaxAgencies(masked, {
      date: d('2026-10-05'),
      paymentAccountId: acct['1000'],
      payments: [{ agencyId, amount: '25.00' }],
      toPrint: true,
    });
    const id = paid.checks[0].id;
    const entryId = paid.checks[0].entryId;
    // The answer of POST /api/sales-tax/pay.
    expect(paid.checks[0].memo).toBe('Acct # ••••6789');
    expect(JSON.stringify(paid)).not.toContain(FULL_NUMBER);

    // Stored in full: the check prints it, the agency applies the payment by it.
    const [stored] = await db.select().from(paymentChecks).where(eq(paymentChecks.id, id));
    expect(stored.memo).toBe(`Acct # ${FULL_NUMBER}`);
    const printData = await checkPrintData(masked, 'payment_check', id);
    expect(printData.memo).toBe(`Acct # ${FULL_NUMBER}`);
    // The voucher stub prints what it printed before: the check's memo on the 2200 line.
    expect(printData.voucher).toEqual([
      { account: '2200 – Sales Tax Payable', description: `Acct # ${FULL_NUMBER}`, amount: '25.00' },
    ]);

    // The journal entry's lines do not carry the number: the payment no longer copies the check
    // memo onto them, so nothing in the ledger holds it, whoever reads it and however (section 5
    // covers lines that already hold one).
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entryId));
    expect(lines.map((l) => l.memo).sort()).toEqual(['Sales Tax Payment — State Revenue Dept', 'Sales tax — State Revenue Dept']);
    expect(JSON.stringify(await getEntryForCaller(masked, entryId))).not.toContain(FULL_NUMBER);
    expect(JSON.stringify(await getEntryForCaller(full, entryId))).not.toContain(FULL_NUMBER);
    expect(JSON.stringify(await getEntry(ctx, entryId))).not.toContain(FULL_NUMBER);

    // GET /api/sales-tax/payments and /api/sales-tax/payments/[id].
    const listed = await listPaymentChecks(masked, { kind: 'sales_tax' });
    expect(listed.find((c) => c.id === id)?.memo).toBe('Acct # ••••6789');
    expect(JSON.stringify(listed)).not.toContain(FULL_NUMBER);
    expect((await getPaymentCheck(masked, id)).memo).toBe('Acct # ••••6789');
    expect((await listPaymentChecks(full, { kind: 'sales_tax' })).find((c) => c.id === id)?.memo).toBe(`Acct # ${FULL_NUMBER}`);
    expect((await getPaymentCheck(full, id)).memo).toBe(`Acct # ${FULL_NUMBER}`);

    // The print queue lists the stored memo.
    expect((await listPrintQueue(masked)).find((q) => q.id === id)?.memo).toBe('Acct # ••••6789');
    expect((await listPrintQueue(full)).find((q) => q.id === id)?.memo).toBe(`Acct # ${FULL_NUMBER}`);

    // Recording the printed number (POST /api/print-queue) and voiding answer the check too.
    const printed = (await markPrinted(masked, { source: 'payment_check', id, checkNumber: '9001' })) as { memo: string | null };
    expect(printed.memo).toBe('Acct # ••••6789');
    expect((await voidPaymentCheck(masked, id)).memo).toBe('Acct # ••••6789');
    expect((await voidPaymentCheck(full, id)).memo).toBe(`Acct # ${FULL_NUMBER}`); // already void: answered as is
    const [after] = await db.select().from(paymentChecks).where(eq(paymentChecks.id, id));
    expect(after.memo).toBe(`Acct # ${FULL_NUMBER}`);
  });

  it('a caller with the right gets the full number from the payment itself', async () => {
    const paid = await paySalesTaxAgencies(full, {
      date: d('2026-10-06'),
      paymentAccountId: acct['1000'],
      payments: [{ agencyId, amount: '5.00' }],
      toPrint: true,
    });
    expect(paid.checks[0].memo).toBe(`Acct # ${FULL_NUMBER}`);
  });

  it('a typed memo is answered as typed, and printed and posted as before', async () => {
    const paid = await paySalesTaxAgencies(masked, {
      date: d('2026-10-07'),
      paymentAccountId: acct['1000'],
      payments: [{ agencyId, amount: '1.00' }],
      memo: 'Q3 extra',
      toPrint: true,
    });
    expect(paid.checks[0].memo).toBe('Q3 extra');
    expect((await checkPrintData(masked, 'payment_check', paid.checks[0].id)).voucher[0].description).toBe('Q3 extra');
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, paid.checks[0].entryId));
    expect(lines.find((l) => l.debit && Number(l.debit) > 0)?.memo).toBe('Q3 extra');
  });

  it('an agency without an account number prints the agency on the voucher, as before', async () => {
    const otherAgency = (await createTaxAgency(ctx, { name: 'City Tax Office' })).id;
    const paid = await paySalesTaxAgencies(masked, {
      date: d('2026-10-08'),
      paymentAccountId: acct['1000'],
      payments: [{ agencyId: otherAgency, amount: '3.00' }],
      toPrint: true,
    });
    expect(paid.checks[0].memo).toBeNull();
    expect((await checkPrintData(masked, 'payment_check', paid.checks[0].id)).voucher[0].description).toBe('Sales tax — City Tax Office');
  });

  it('a payment with no agency keeps its voucher text (the check memo is not printed there)', async () => {
    const entry = await paySalesTax(masked, {
      amount: '2.00',
      date: d('2026-10-09'),
      paymentAccountId: acct['1000'],
      memo: 'Unattributed',
      toPrint: true,
    });
    const [check] = await db.select().from(paymentChecks).where(eq(paymentChecks.postedEntryId, entry.id));
    const data = await checkPrintData(masked, 'payment_check', check.id);
    expect(data.memo).toBe('Unattributed');
    expect(data.voucher[0].description).toBe('Sales Tax Payment');
  });
});

describe('3. assigning a vendor type', () => {
  it('answers the vendor masked without the rights, in full with them', async () => {
    const v = await vendorWithNumber('Sole Prop Plumbing', { taxId: '123-45-6789' });
    const type = await createType(ctx, 'vendor', { name: 'Trades' });

    const hidden = await assignVendorType(masked, v.id, type.id);
    expect(hidden.vendorTypeId).toBe(type.id);
    expect(hidden.accountNumber).toBe('••••6789');
    expect(hidden.taxId).toBe('***-**-6789');
    expect(JSON.stringify(hidden)).not.toContain(FULL_NUMBER);

    const shown = await assignVendorType(full, v.id, null);
    expect(shown.vendorTypeId).toBeNull();
    expect(shown.accountNumber).toBe(FULL_NUMBER);
    expect(shown.taxId).toBe('123-45-6789');

    // Only the answer is masked: the vendor keeps its numbers.
    const [row] = await db.select().from(vendors).where(eq(vendors.id, v.id));
    expect(row.accountNumber).toBe(FULL_NUMBER);
    expect(row.taxId).toBe('123-45-6789');
  });
});

describe('4. the state wage worksheet', () => {
  it("answers the employer's state account number like the state settings list does", async () => {
    await upsertStateTaxSetting(ctx, { state: 'NY', year: 2026, suiRate: '0.025', suiWageBase: '12000', accountNumber: '987654321' });
    const hidden = await stateWageWorksheet(masked, { state: 'NY', year: 2026, quarter: 1 });
    expect(hidden.accountNumber).toBe('••••4321');
    expect(hidden.accountNumber).toBe((await listStateTaxSettings(masked))[0].accountNumber);
    expect((await stateWageWorksheet(full, { state: 'NY', year: 2026, quarter: 1 })).accountNumber).toBe('987654321');
    expect((await stateWageWorksheet(ctx, { state: 'NY', year: 2026, quarter: 1 })).accountNumber).toBe('987654321');
  });
});

/** What the journal window sends back on Save: the entry's lines as the caller was shown them. */
function asShownOnSave(e: JournalEntryDetail): UpdateEntryInput {
  return {
    date: e.date,
    description: e.description,
    lines: e.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo,
      classId: l.classId,
      entityType: l.entityType,
      entityId: l.entityId,
    })),
  };
}

describe('5. line memos already in the books', () => {
  const MEMO = `Acct # ${FULL_NUMBER}`;
  const SHOWN = 'Acct # ••••6789';
  // January 2027 holds only this section's lines.
  const from = d('2027-01-01');
  const to = d('2027-01-31');
  let legacyEntryId: string;
  let legacyCheckId: string;
  let manualId: string;

  /** The entry's line memos as stored, sorted. */
  const storedMemos = async (entryId: string) =>
    (await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entryId))).map((l) => l.memo).sort();
  /** The entry's line memos as stored, by account. */
  const memoByAccount = async (entryId: string) =>
    Object.fromEntries(
      (await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entryId)).orderBy(asc(journalEntryLines.createdAt))).map(
        (l) => [l.accountId, l.memo],
      ),
    );

  beforeAll(async () => {
    await vendorWithNumber('County Tax Collector');
    const agencyId = (await createTaxAgency(ctx, { name: 'County Tax Collector' })).id;
    const paid = await paySalesTaxAgencies(ctx, {
      date: d('2027-01-05'),
      paymentAccountId: acct['1000'],
      payments: [{ agencyId, amount: '40.00' }],
      toPrint: true,
    });
    legacyEntryId = paid.checks[0].entryId;
    legacyCheckId = paid.checks[0].id;
    // What the payment wrote before the second wave: the check memo on its Dr 2200 line.
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, legacyEntryId));
    const dr = lines.find((l) => l.debit && Number(l.debit) > 0)!;
    await db.update(journalEntryLines).set({ memo: MEMO }).where(eq(journalEntryLines.id, dr.id));
    // And one typed on a General Journal entry.
    const manual = await createManualEntry(ctx, {
      date: d('2027-01-10'),
      description: 'Utility deposit',
      isAdjusting: true,
      lines: [
        { accountId: acct['6600'], debit: '15.00', memo: MEMO },
        { accountId: acct['1000'], credit: '15.00', memo: 'Office rent' },
      ],
    });
    manualId = manual.id;
  });

  it('lineMemoFor: the agent mask for a caller without the right, the stored text otherwise', () => {
    expect(lineMemoFor(masked, MEMO)).toBe(SHOWN);
    expect(lineMemoFor(masked, 'Paid in full, A/C No. 1234 5678')).toBe('Paid in full, A/C No. ••••5678');
    expect(lineMemoFor(masked, 'Office rent')).toBe('Office rent');
    expect(lineMemoFor(masked, SHOWN)).toBe(SHOWN);
    expect(lineMemoFor(masked, null)).toBeNull();
    expect(lineMemoFor(full, MEMO)).toBe(MEMO);
    expect(lineMemoFor(ctx, MEMO)).toBe(MEMO);
  });

  it('ilikeMatches reads a pattern the way ILIKE does', () => {
    expect(ilikeMatches(SHOWN, '%6789%')).toBe(true);
    expect(ilikeMatches(SHOWN, '%acct # ••••%')).toBe(true);
    expect(ilikeMatches(SHOWN, '%0001%')).toBe(false);
    expect(ilikeMatches('Acct # 1_2', '%1\\_2%')).toBe(true);
    expect(ilikeMatches('Acct # 1x2', '%1\\_2%')).toBe(false);
    expect(ilikeMatches('Acct # 1x2', '%1_2%')).toBe(true);
    expect(ilikeMatches('50% off (a.b)', '%50\\% off (a.b)%')).toBe(true);
    expect(ilikeMatches(null, '%')).toBe(false);
  });

  it("ilikeMatches answers what the database's own ILIKE answers", async () => {
    const texts = [SHOWN, 'Acct # 1_2', 'Acct # 1x2', '50% off (a.b)', 'abcabc', 'aaa', '', 'a\\b', 'Paid in full\nAcct # ••••6789'];
    const patterns = [
      '%', '%%', '', '_', '%6789%', '%ACCT # ••••%', 'a%c', 'a%c%c', '%b%b%', '___', '_%_', '%1\\_2%', '%50\\%%',
      'a\\\\b', '%\\%', '%.%', '(a.b)', '%(a.b)', 'abc%', '%abc', 'a_c_bc', '%a%a%a%a', 'paid%6789', 'Paid in full_Acct%',
    ];
    for (const t of texts) {
      for (const p of patterns) {
        const { rows } = (await db.execute(sql`select ${t}::text ILIKE ${p}::text as hit`)) as unknown as { rows: Array<{ hit: boolean }> };
        expect(ilikeMatches(t, p), `${JSON.stringify(t)} ILIKE ${JSON.stringify(p)}`).toBe(rows[0].hit);
      }
    }
  });

  it('ilikeMatches takes time in proportion to the text and the pattern, however many wildcards a search holds', () => {
    // A search is passed as typed (Transaction Detail), "%" and "_" included, and matched on the one
    // server every window uses: a pattern built to backtrack must not hold it.
    const memo = lineMemoFor(masked, `Paid to the county for the third quarter, ref 2026-Q3 Acct # ${FULL_NUMBER}`)!;
    expect(memo).not.toContain(FULL_NUMBER);
    const long = `${'Paid to the county for the third quarter '.repeat(25)}${memo}`;
    const started = performance.now();
    for (const p of ['%_%_%_%_%_%_%_%_%_%_Q', `${'%_'.repeat(30)}Q`, `${'%a'.repeat(40)}Q`, `%${'_%'.repeat(200)}Q`]) {
      expect(ilikeMatches(memo, p), p).toBe(false);
      expect(ilikeMatches(long, p), p).toBe(false);
    }
    expect(ilikeMatches(long, `${'%_'.repeat(30)}6789`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('Transaction Detail answers a search full of wildcards at once', async () => {
    const started = performance.now();
    const report = await transactionDetail(masked, { from, to, search: `${'%_'.repeat(30)}Q` });
    expect(report.rows).toEqual([]);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('lineMemoFor: masks after "account #" too, chart numbers included (deliberate, fail closed)', () => {
    // The end of a vendor's account number cannot be told from the words after it.
    expect(lineMemoFor(masked, 'Reclass to account #6100 Office Supplies')).toBe('Reclass to account #••••lies');
    // Without "#", "No" or "Number" the memo is shown as typed.
    expect(lineMemoFor(masked, 'Reclass to account 6100 Office Supplies')).toBe('Reclass to account 6100 Office Supplies');
    expect(lineMemoFor(masked, 'ONLINE TRANSFER TO ACCOUNT 4455')).toBe('ONLINE TRANSFER TO ACCOUNT 4455');
    expect(lineMemoFor(full, 'Reclass to account #6100 Office Supplies')).toBe('Reclass to account #6100 Office Supplies');
  });

  it('the journal entry as answered to a caller (getEntryForCaller): masked without the right, as stored with it', async () => {
    const hidden = await getEntryForCaller(masked, legacyEntryId);
    expect(hidden.lines.map((l) => l.memo)).toContain(SHOWN);
    expect(JSON.stringify(hidden)).not.toContain(FULL_NUMBER);
    expect((await getEntryForCaller(full, legacyEntryId)).lines.map((l) => l.memo)).toContain(MEMO);
    expect((await getEntryForCaller(ctx, legacyEntryId)).lines.map((l) => l.memo)).toContain(MEMO);
    // getEntry is the stored read for work that keeps or copies the entry (Undo snapshots it):
    // whoever it runs for, it holds the memo as stored. GET /api/journal-entries/[id] answers
    // getEntryForCaller (see the route test below).
    expect((await getEntry(masked, legacyEntryId)).lines.map((l) => l.memo)).toContain(MEMO);
    // The stored line is not touched by reading it.
    const stored = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, legacyEntryId));
    expect(stored.map((l) => l.memo)).toContain(MEMO);
  });

  describe('GET /api/journal-entries/[id] (the journal entry window)', () => {
    const fromRoute = async (c: ServiceContext) => {
      routeCtx = c;
      const res = await entryGET(new NextRequest(`http://localhost/api/journal-entries/${legacyEntryId}`), {
        params: Promise.resolve({ id: legacyEntryId }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entry: JournalEntryDetail };
      return { memos: body.entry.lines.map((l) => l.memo), text: JSON.stringify(body) };
    };

    it('a caller with the right reads the memo as stored', async () => {
      expect((await fromRoute(full)).memos).toContain(MEMO);
    });

    // The route answers getEntryForCaller: the window shows the memo the way the registers and the
    // reports do. The test above proves the route itself answers under this mock.
    it('a caller without the right reads it masked (the route answers getEntryForCaller)', async () => {
      const { memos, text } = await fromRoute(masked);
      expect(memos).toContain(SHOWN);
      expect(text).not.toContain(FULL_NUMBER);
    });

    it('saving the entry as the window showed it keeps the stored memo', async () => {
      // The window sends back what GET answered; the books must keep the full number.
      const created = await createManualEntry(ctx, {
        date: d('2027-04-02'),
        description: 'Gas deposit',
        lines: [
          { accountId: acct['6600'], debit: '12.00', memo: MEMO },
          { accountId: acct['1000'], credit: '12.00', memo: 'Paid' },
        ],
      });
      routeCtx = masked;
      const res = await entryGET(new NextRequest(`http://localhost/api/journal-entries/${created.id}`), {
        params: Promise.resolve({ id: created.id }),
      });
      const { entry } = (await res.json()) as { entry: JournalEntryDetail };
      expect(entry.lines.map((l) => l.memo).sort()).toEqual([SHOWN, 'Paid']);
      await updateEntry(masked, created.id, { ...asShownOnSave(entry), date: new Date(entry.date), description: 'Gas deposit (refundable)' });
      expect(await storedMemos(created.id)).toEqual([MEMO, 'Paid']);
    });
  });

  it('the register: masked, and its search finds what the caller sees, not what the mask hides', async () => {
    const reg = await accountRegister(masked, acct['6600'], { from, to });
    expect(reg.rows.map((r) => r.memo)).toEqual([SHOWN]);
    expect(JSON.stringify(reg)).not.toContain(FULL_NUMBER);
    expect((await accountRegister(masked, acct['6600'], { from, to, search: '0001234' })).rows).toEqual([]);
    expect((await accountRegister(masked, acct['6600'], { from, to, search: '••••6789' })).rows).toHaveLength(1);
    expect((await accountRegister(full, acct['6600'], { from, to, search: '0001234' })).rows.map((r) => r.memo)).toEqual([MEMO]);
    expect((await accountRegister(full, acct['6600'], { from, to })).rows.map((r) => r.memo)).toEqual([MEMO]);
  });

  it('the Adjusting Journal Entries report', async () => {
    const memos = async (c: ServiceContext) =>
      (await getAdjustingEntries(c, { from, to })).entries.flatMap((e) => e.lines.map((l) => l.memo)).sort();
    expect(await memos(masked)).toEqual([SHOWN, 'Office rent']);
    expect(await memos(full)).toEqual([MEMO, 'Office rent']);
  });

  it('report lines (General Ledger, transaction reports): masked; the memo filter matches the memo as shown', async () => {
    const memos = async (c: ServiceContext, memo?: string) =>
      (await fetchGlLines(c, await loadAccountMeta(c), { from, to, ...(memo !== undefined ? { memo } : {}) })).lines
        .map((l) => l.memo)
        .sort();
    expect(await memos(masked)).toEqual([SHOWN, SHOWN, 'Office rent', 'Sales Tax Payment — County Tax Collector']);
    expect(JSON.stringify((await fetchGlLines(masked, await loadAccountMeta(masked), { from, to })).lines)).not.toContain(FULL_NUMBER);
    expect(await memos(full)).toEqual([MEMO, MEMO, 'Office rent', 'Sales Tax Payment — County Tax Collector']);

    // Guesses at the hidden digits find nothing...
    for (const guess of [FULL_NUMBER, '0001', 'Acct # 0001', '23456789', '%0001%']) {
      expect(await memos(masked, guess), guess).toEqual([]);
    }
    // ...what the caller sees is found...
    expect(await memos(masked, '6789')).toEqual([SHOWN, SHOWN]);
    expect(await memos(masked, 'acct # ••••')).toEqual([SHOWN, SHOWN]);
    // ...other lines, and the entry's own description, match as before.
    expect(await memos(masked, 'office RENT')).toEqual(['Office rent']);
    expect(await memos(masked, 'Utility deposit')).toEqual([SHOWN, 'Office rent']);
    // A caller with the right: the stored text, exactly as today.
    expect(await memos(full, '0001')).toEqual([MEMO, MEMO]);
    expect(await memos(full, '••••')).toEqual([]);
  });

  it('Transaction Detail: masked; its search matches the memo as shown', async () => {
    const memos = async (c: ServiceContext, search?: string) =>
      (await transactionDetail(c, { from, to, search })).rows.map((r) => r.memo).sort();
    expect(await memos(masked)).toEqual([SHOWN, SHOWN, 'Office rent', 'Sales Tax Payment — County Tax Collector']);
    for (const guess of [FULL_NUMBER, '0001', 'Acct # 0001%', '_cct # 0']) {
      expect(await memos(masked, guess), guess).toEqual([]);
    }
    expect(await memos(masked, '6789')).toEqual([SHOWN, SHOWN]);
    expect(await memos(masked, 'Utility')).toEqual([SHOWN, 'Office rent']);
    expect(await memos(full, '0001')).toEqual([MEMO, MEMO]);
    expect(await memos(full)).toEqual([MEMO, MEMO, 'Office rent', 'Sales Tax Payment — County Tax Collector']);
  });

  it('Check Detail: the Sales Tax Payment check memo is masked; the printed check keeps it', async () => {
    const line = async (c: ServiceContext) =>
      (await checkDetail(c, { from, to })).rows.find((r) => r.id === legacyCheckId)?.lines[0].description;
    expect(await line(masked)).toBe(SHOWN);
    expect(JSON.stringify(await checkDetail(masked, { from, to }))).not.toContain(FULL_NUMBER);
    expect(await line(full)).toBe(MEMO);
    expect((await checkPrintData(masked, 'payment_check', legacyCheckId)).memo).toBe(MEMO);
  });

  it('reversing an entry copies its memos as stored, whoever reverses it', async () => {
    const reversal = await reverseEntry(masked, manualId);
    const stored = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, reversal.id));
    expect(stored.map((l) => l.memo).sort()).toEqual([MEMO, 'Office rent']);
    expect((await getEntryForCaller(masked, reversal.id)).lines.map((l) => l.memo).sort()).toEqual([SHOWN, 'Office rent']);
  });

  it('saving an entry as shown keeps the stored memo; a memo typed over it is saved as typed', async () => {
    const created = await createManualEntry(ctx, {
      date: d('2027-03-10'),
      description: 'Water deposit',
      lines: [
        { accountId: acct['6600'], debit: '20.00', memo: MEMO },
        { accountId: acct['1000'], credit: '20.00', memo: 'Paid' },
      ],
    });

    // 1. Same ledger, new description: the entry is kept and its memos are untouched.
    const shown = await getEntryForCaller(masked, created.id);
    expect(shown.lines.map((l) => l.memo).sort()).toEqual([SHOWN, 'Paid']);
    await updateEntry(masked, created.id, { ...asShownOnSave(shown), description: 'Water deposit (refundable)' });
    expect(await storedMemos(created.id)).toEqual([MEMO, 'Paid']);

    // 2. New amounts: re-posted as a new entry, the memo still as stored.
    const again = asShownOnSave(await getEntryForCaller(masked, created.id));
    const replacement = await updateEntry(masked, created.id, {
      ...again,
      lines: again.lines.map((l) => (l.debit ? { ...l, debit: '21.00' } : { ...l, credit: '21.00' })),
    });
    expect(replacement.id).not.toBe(created.id);
    expect(await storedMemos(replacement.id)).toEqual([MEMO, 'Paid']);

    // 3. A memo the caller changed is saved as typed.
    const third = asShownOnSave(await getEntryForCaller(masked, replacement.id));
    await updateEntry(masked, replacement.id, {
      ...third,
      lines: third.lines.map((l) => (l.memo === SHOWN ? { ...l, memo: 'Deposit, refundable' } : l)),
    });
    expect(await storedMemos(replacement.id)).toEqual(['Deposit, refundable', 'Paid']);

    // A caller with the right saves what they see, as today.
    const withRight = asShownOnSave(await getEntryForCaller(full, replacement.id));
    await updateEntry(full, replacement.id, {
      ...withRight,
      lines: withRight.lines.map((l) => (l.memo === 'Paid' ? { ...l, memo: MEMO } : l)),
    });
    expect(await storedMemos(replacement.id)).toEqual([MEMO, 'Deposit, refundable']);
  });

  it('a memo typed as shown on another line is saved as typed: a hidden number moves only with its own line', async () => {
    const created = await createManualEntry(ctx, {
      date: d('2027-03-11'),
      description: 'Moved memo',
      lines: [
        { accountId: acct['6600'], debit: '9.00', memo: MEMO },
        { accountId: acct['1000'], credit: '9.00', memo: 'Paid' },
      ],
    });
    const shown = asShownOnSave(await getEntryForCaller(masked, created.id));
    // The 6600 memo is retyped and the masked text is typed on the bank line.
    await updateEntry(masked, created.id, {
      ...shown,
      lines: shown.lines.map((l) => ({ ...l, memo: l.memo === SHOWN ? 'Water' : SHOWN })),
    });
    expect(await memoByAccount(created.id)).toEqual({ [acct['6600']]: 'Water', [acct['1000']]: SHOWN });
  });

  it('a line moved to another account, its memo left as shown, keeps the stored memo', async () => {
    const created = await createManualEntry(ctx, {
      date: d('2027-03-13'),
      description: 'Reclass',
      lines: [
        { accountId: acct['6600'], debit: '6.00', memo: MEMO },
        { accountId: acct['1000'], credit: '6.00', memo: 'Paid' },
      ],
    });
    const shown = asShownOnSave(await getEntryForCaller(masked, created.id));
    const replacement = await updateEntry(masked, created.id, {
      ...shown,
      lines: shown.lines.map((l) => (l.accountId === acct['6600'] ? { ...l, accountId: acct['6700'] } : l)),
    });
    expect(await memoByAccount(replacement.id)).toEqual({ [acct['6700']]: MEMO, [acct['1000']]: 'Paid' });
  });

  it('a line of the same account keeps the memo before a new line that shows the same text', async () => {
    const created = await createManualEntry(ctx, {
      date: d('2027-03-14'),
      description: 'Split',
      lines: [
        { accountId: acct['6600'], debit: '5.00', memo: MEMO },
        { accountId: acct['1000'], credit: '5.00', memo: 'Paid' },
      ],
    });
    const shown = asShownOnSave(await getEntryForCaller(masked, created.id));
    const own = shown.lines.find((l) => l.accountId === acct['6600'])!;
    // A copy of the line on 6700 listed first, the bank line doubled to balance.
    const replacement = await updateEntry(masked, created.id, {
      ...shown,
      lines: [
        { ...own, accountId: acct['6700'] },
        own,
        { ...shown.lines.find((l) => l.accountId === acct['1000'])!, credit: '10.00' },
      ],
    });
    expect(await memoByAccount(replacement.id)).toEqual({ [acct['6700']]: SHOWN, [acct['6600']]: MEMO, [acct['1000']]: 'Paid' });
  });

  it('a line whose account and amounts both changed, memo left as shown, is saved as shown (deliberate)', async () => {
    // Nothing tells which stored line it was: the number is not guessed onto it.
    const created = await createManualEntry(ctx, {
      date: d('2027-03-15'),
      description: 'Reclass and new amount',
      lines: [
        { accountId: acct['6600'], debit: '4.00', memo: MEMO },
        { accountId: acct['1000'], credit: '4.00', memo: 'Paid' },
      ],
    });
    const shown = asShownOnSave(await getEntryForCaller(masked, created.id));
    const replacement = await updateEntry(masked, created.id, {
      ...shown,
      lines: shown.lines.map((l) =>
        l.accountId === acct['6600'] ? { ...l, accountId: acct['6700'], debit: '4.50' } : { ...l, credit: '4.50' },
      ),
    });
    expect(await memoByAccount(replacement.id)).toEqual({ [acct['6700']]: SHOWN, [acct['1000']]: 'Paid' });
  });

  it('a hidden memo stays on its own line of the same account when the amounts change', async () => {
    const created = await createManualEntry(ctx, {
      date: d('2027-03-12'),
      description: 'Same line, new amount',
      lines: [
        { accountId: acct['6600'], debit: '7.00', memo: MEMO },
        { accountId: acct['1000'], credit: '7.00', memo: 'Paid' },
      ],
    });
    const shown = asShownOnSave(await getEntryForCaller(masked, created.id));
    const replacement = await updateEntry(masked, created.id, {
      ...shown,
      lines: shown.lines.map((l) => (l.debit ? { ...l, debit: '8.00' } : { ...l, credit: '8.00' })),
    });
    expect(await memoByAccount(replacement.id)).toEqual({ [acct['6600']]: MEMO, [acct['1000']]: 'Paid' });
  });

  describe('Undo by a caller without the right puts back the memo as stored', () => {
    const entry = (date: string, description: string) =>
      createManualEntry(ctx, {
        date: d(date),
        description,
        lines: [
          { accountId: acct['6600'], debit: '12.00', memo: MEMO },
          { accountId: acct['1000'], credit: '12.00', memo: 'Paid' },
        ],
      });

    it('Undo of a void re-enters the memo as stored, not as the caller saw it', async () => {
      const je = await entry('2027-05-03', 'Undo void deposit');
      const { token } = await prepareUndo(masked, { resource: 'journal-entries', kind: 'void', id: je.id });
      await voidEntry(masked, je.id);
      await commitUndo(masked, { resource: 'journal-entries', kind: 'void', token });
      const out = await performUndo(masked, token);
      expect(out.newId).toBeTruthy();
      expect(await storedMemos(out.newId!)).toEqual([MEMO, 'Paid']);
      // The caller still sees the number masked on the copy.
      expect((await getEntryForCaller(masked, out.newId!)).lines.map((l) => l.memo).sort()).toEqual([SHOWN, 'Paid']);
    });

    it('Undo of a memo edit (same entry kept) puts the stored memo back', async () => {
      const je = await entry('2027-05-04', 'Undo memo edit');
      const { token } = await prepareUndo(masked, { resource: 'journal-entries', kind: 'update', id: je.id });
      const shown = asShownOnSave(await getEntryForCaller(masked, je.id));
      await updateEntry(masked, je.id, {
        ...shown,
        lines: shown.lines.map((l) => (l.memo === SHOWN ? { ...l, memo: 'Deposit returned' } : l)),
      });
      expect(await storedMemos(je.id)).toEqual(['Deposit returned', 'Paid']);
      await commitUndo(masked, { resource: 'journal-entries', kind: 'update', token });
      await performUndo(masked, token);
      expect(await storedMemos(je.id)).toEqual([MEMO, 'Paid']);
    });

    it('Undo of an edit that cleared the memo and changed the amounts puts the stored memo back', async () => {
      const je = await entry('2027-05-05', 'Undo amount edit');
      const { token } = await prepareUndo(masked, { resource: 'journal-entries', kind: 'update', id: je.id });
      const shown = asShownOnSave(await getEntryForCaller(masked, je.id));
      const replacement = await updateEntry(masked, je.id, {
        ...shown,
        lines: shown.lines.map((l) => (l.debit ? { ...l, debit: '13.00', memo: null } : { ...l, credit: '13.00' })),
      });
      expect(await storedMemos(replacement.id)).toEqual(['Paid', null]);
      await commitUndo(masked, { resource: 'journal-entries', kind: 'update', token });
      await performUndo(masked, token);
      const posted = await db
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.description, 'Undo amount edit'), eq(journalEntries.status, 'posted')));
      expect(posted).toHaveLength(1);
      expect(posted[0].id).not.toBe(replacement.id);
      expect(await storedMemos(posted[0].id)).toEqual([MEMO, 'Paid']);
    });
  });

  it('the journal lines Pay Bills and Receive Payments list (journalOpenItems): masked without the right', async () => {
    const v = await vendorWithNumber('Gas Utility');
    await createManualEntry(ctx, {
      date: d('2027-05-07'),
      description: 'Gas accrual',
      lines: [
        { accountId: acct['6600'], debit: '30.00', memo: 'Gas' },
        { accountId: acct['2000'], credit: '30.00', memo: MEMO, entityType: 'vendor', entityId: v.id },
      ],
    });
    // GET /api/bill-payments/journal-items.
    const hidden = await listJournalOpenItems(masked, 'ap', v.id);
    expect(hidden.charges.map((c) => c.memo)).toEqual([SHOWN]);
    expect(JSON.stringify(hidden)).not.toContain(FULL_NUMBER);
    expect((await listJournalOpenItems(full, 'ap', v.id)).charges.map((c) => c.memo)).toEqual([MEMO]);
    expect((await journalOpenItems(ctx, 'ap', { entityId: v.id })).map((i) => i.memo)).toEqual([MEMO]);
  });

  it('the memo search reads only memos the mask may change; every memo it changes is read', async () => {
    const memos = [
      `Acct # ${FULL_NUMBER}`,
      'A/C No. 1234 5678',
      'acct.#5550001',
      'Account Number: 99887766',
      'BankAcct#12345678',
      'Accountnumber 12345678',
      'Paid in full, ACCTS # 0042',
      'ONLINE TRANSFER TO ACCOUNT 4455',
      'Reclass to account 6100 Office Supplies',
      'Office rent',
    ];
    const je = await createManualEntry(ctx, {
      date: d('2027-06-05'),
      description: 'Label shapes',
      lines: [
        ...memos.map((memo) => ({ accountId: acct['6600'], debit: '1.00', memo })),
        { accountId: acct['1000'], credit: String(memos.length) + '.00', memo: null },
      ],
    });
    const read = await db
      .select({ memo: journalEntryLines.memo })
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, je.id), memoMayHoldAccountNumber()));
    const readMemos = new Set(read.map((r) => r.memo));
    for (const memo of memos) {
      if (lineMemoFor(masked, memo) !== memo) expect(readMemos.has(memo), memo).toBe(true);
    }
    expect(readMemos.has('ONLINE TRANSFER TO ACCOUNT 4455')).toBe(false);
    expect(readMemos.has('Reclass to account 6100 Office Supplies')).toBe(false);
    expect(readMemos.has('Office rent')).toBe(false);

    // The General Ledger's memo filter: guesses find nothing, what the caller sees is found.
    const june = { from: d('2027-06-01'), to: d('2027-06-30') };
    const gl = async (c: ServiceContext, memo: string) =>
      (await fetchGlLines(c, await loadAccountMeta(c), { ...june, memo })).lines.map((l) => l.memo).sort();
    expect(await gl(masked, '0001234')).toEqual([]);
    expect(await gl(masked, '5550001')).toEqual([]);
    expect(await gl(masked, '••••6789')).toEqual([`Acct # ••••6789`]);
    expect(await gl(masked, '4455')).toEqual(['ONLINE TRANSFER TO ACCOUNT 4455']);
    expect(await gl(full, '0001234')).toEqual([`Acct # ${FULL_NUMBER}`]);
  });
});

describe('6. the vendor lookup in an agent preview', () => {
  const SEARX = 'http://100.64.1.9:8080';
  const HOST = '100.64.1.9:8080';
  const FERGUSON = [
    { title: 'Ferguson — Plumbing Supplies', url: 'https://www.ferguson.com/', content: 'Wholesale distributor of plumbing supplies.' },
  ];
  let calls: string[];
  const fetchImpl = async (input: string) => {
    calls.push(input);
    return new Response(JSON.stringify({ results: FERGUSON }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  beforeAll(async () => {
    await setNetworkPolicy(ctx, { mode: 'tailnet-only', cloudOptIn: { 'vendor-lookup': true }, vendorLookupUrl: SEARX });
  });
  beforeEach(() => {
    clearVendorLookupCache();
    calls = [];
  });
  afterAll(() => clearVendorLookupCache());

  it('a preview sends nothing: it stops and says which computer the name would go to', async () => {
    const err = await runWithEffects('capture', () => lookupVendor(ctx, 'SQ *FERGUSON SUPPLY #2231', { fetchImpl })).catch((e: unknown) => e);
    expect(isNotRunInPreview(err)).toBe(true);
    expect(calls).toEqual([]);
    expect((err as Error).message).toBe(
      `This would contact ${HOST} for ${VENDOR_LOOKUP_PURPOSE}. A preview does not contact other computers, so it stopped here.`,
    );
    expect(effectsOfFailedRun(err)?.effects).toEqual([
      { kind: 'network', summary: `Contact ${HOST} for ${VENDOR_LOOKUP_PURPOSE}`, detail: { host: HOST, purpose: VENDOR_LOOKUP_PURPOSE, ran: false } },
    ]);
    // The approval card says where, never the name itself.
    expect(JSON.stringify(effectsOfFailedRun(err))).not.toMatch(/ferguson/i);
  });

  it("an agent's real run looks the name up and records the call for the audit trail", async () => {
    const run = await runWithEffects('defer', () => lookupVendor(ctx, 'Ferguson Supply', { fetchImpl }));
    expect(calls).toHaveLength(1);
    expect(run.value?.summary).toContain('plumbing supplies');
    expect(run.effects).toEqual([
      { kind: 'network', summary: `Contact ${HOST} for ${VENDOR_LOOKUP_PURPOSE}`, detail: { host: HOST, purpose: VENDOR_LOOKUP_PURPOSE, ran: true } },
    ]);
    expect(await run.release()).toEqual([expect.objectContaining({ status: 'sent', error: null, ranDuringOperation: true })]);
    // A name already looked up is answered from memory for a person, and in a real run.
    expect(await lookupVendor(ctx, 'ferguson supply', { fetchImpl })).toEqual(run.value);
    expect(calls).toHaveLength(1);
  });

  it('a preview of a name already looked up still says the approved run may contact the lookup server', async () => {
    // The answer is remembered for a day and forgotten on a restart: the approved run may then send
    // the name after all, so the card must say so in advance. Nothing is sent from the preview.
    const first = await lookupVendor(ctx, 'Ferguson Supply', { fetchImpl });
    expect(first?.summary).toContain('plumbing supplies');
    expect(calls).toHaveLength(1);
    const err = await runWithEffects('capture', () => lookupVendor(ctx, 'ferguson supply', { fetchImpl })).catch((e: unknown) => e);
    expect(isNotRunInPreview(err)).toBe(true);
    expect(effectsOfFailedRun(err)?.effects).toEqual([
      { kind: 'network', summary: `Contact ${HOST} for ${VENDOR_LOOKUP_PURPOSE}`, detail: { host: HOST, purpose: VENDOR_LOOKUP_PURPOSE, ran: false } },
    ]);
    expect(calls).toHaveLength(1);
    // The approved run (defer) uses what is remembered: nothing sent, nothing to report.
    const approved = await runWithEffects('defer', () => lookupVendor(ctx, 'ferguson supply', { fetchImpl }));
    expect(approved.value).toEqual(first);
    expect(approved.effects).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('the prefill and bank-category suggestions stop in a preview before any request leaves', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('This test must not reach the network.');
    });
    try {
      const prefill = await runWithEffects('capture', () =>
        suggestAccountForPayee(ctx, { payee: 'Hydro Pipe Wholesale', amount: '12.00', ai: true }),
      ).catch((e: unknown) => e);
      expect(isNotRunInPreview(prefill)).toBe(true);
      expect(effectsOfFailedRun(prefill)?.effects.map((e) => e.detail.purpose)).toEqual([VENDOR_LOOKUP_PURPOSE]);

      const [bank] = await db
        .insert(bankAccounts)
        .values({ companyId: ctx.companyId, accountId: acct['1000'], bankName: 'Masking Bank', accountNumber: '4321' })
        .returning();
      const [txn] = await db
        .insert(bankTransactions)
        .values({ companyId: ctx.companyId, bankAccountId: bank.id, date: d('2027-04-02'), amount: '-12.00', payee: 'HYDRO PIPE WHOLESALE #77' })
        .returning();
      const suggest = await runWithEffects('capture', () => llmSuggestBankCategory(ctx, txn.id)).catch((e: unknown) => e);
      expect(isNotRunInPreview(suggest)).toBe(true);
      expect(effectsOfFailedRun(suggest)?.effects.map((e) => e.detail.purpose)).toEqual([VENDOR_LOOKUP_PURPOSE]);

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('7. the shareable ledger, receipts, the transaction log, the audit reports and reveals', () => {
  const MEMO = `Acct # ${FULL_NUMBER}`;
  const SHOWN = 'Acct # ••••6789';
  // September 2027 holds only this section's lines.
  const from = d('2027-09-01');
  const to = d('2027-09-30');
  const AGENT_ID = '00000000-0000-4000-8000-00000000a9e1';
  const agentOf = { id: AGENT_ID, name: 'Bot', mode: 'post' as const };
  /** May manage agents (Users & Roles > Users) but not see payroll; both View rights. */
  let userManager: ServiceContext;

  beforeAll(async () => {
    await createManualEntry(ctx, {
      date: d('2027-09-03'),
      description: 'Water bill',
      lines: [
        { accountId: acct['6600'], debit: '30.00', memo: MEMO },
        { accountId: acct['1000'], credit: '30.00', memo: 'Paid by check' },
      ],
    });
    userManager = { ...ctx, access: { ...withoutAreas(accessWithFlags(true), ['payroll', 'reports_payroll']), isAdmin: false } };
  });

  it('the shareable ledger: the Journal sheet writes each memo as the caller may see it', async () => {
    const text = async (c: ServiceContext) =>
      new AdmZip((await buildShareableLedgerXlsx(c)).buffer)
        .getEntries()
        .filter((e) => e.entryName.endsWith('.xml'))
        .map((e) => e.getData().toString('utf8'))
        .join('\n');
    const hidden = await text(masked);
    expect(hidden).not.toContain(FULL_NUMBER);
    expect(hidden).toContain(SHOWN);
    expect(await text(full)).toContain(MEMO);
  });

  describe("a receipt's text", () => {
    const TEXT = [
      'Form W-9',
      'Name: Pat Contractor',
      'Social security number 123-45-6789',
      'EIN: 12-3456789',
      'Account No. 4471234567 for ACH',
      `Bank ${MEMO}`,
      'Also on file 987-65-4321',
      'Total 22.79',
    ].join('\n');
    const HIDDEN = /123-45-6789|12-3456789|4471234567|000123456789|987-65-4321/;
    let receiptId: string;

    beforeAll(async () => {
      const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
      receiptId = (await uploadReceipt(ctx, { filename: 'w9.jpg', bytes: jpeg })).id;
      await db.update(receiptScans).set({ rawText: TEXT, status: 'ready' }).where(eq(receiptScans.id, receiptId));
    });

    it('one receipt: masked without the View rights, line by line; as stored with them', async () => {
      const shown = (await getReceipt(masked, receiptId)).rawText!;
      expect(shown).not.toMatch(HIDDEN);
      expect(shown.split('\n')).toEqual([
        'Form W-9',
        'Name: Pat Contractor',
        'Social security number ***-**-6789',
        'EIN: ***-**-6789',
        'Account No. ••••4567 for ACH',
        `Bank ${SHOWN}`,
        'Also on file ***-**-4321',
        'Total 22.79',
      ]);
      expect((await getReceipt(full, receiptId)).rawText).toBe(TEXT);
      expect((await getReceipt(ctx, receiptId)).rawText).toBe(TEXT);
    });

    it('each View right shows its own kind only', () => {
      const flags = (sensitivePayroll: boolean, fullAccountNumbers: boolean) => ({
        access: { ...fullAccess(), flags: { ...fullAccess().flags, sensitivePayroll, fullAccountNumbers } },
      });
      const ssnOnly = receiptTextFor(flags(true, false), TEXT)!;
      expect(ssnOnly).toContain('123-45-6789');
      expect(ssnOnly).not.toContain(FULL_NUMBER);
      const accountsOnly = receiptTextFor(flags(false, true), TEXT)!;
      expect(accountsOnly).toContain(FULL_NUMBER);
      expect(accountsOnly).not.toContain('123-45-6789');
    });

    it('the inbox list leaves the text out for everyone', async () => {
      for (const c of [masked, full]) {
        expect((await listReceipts(c, { status: 'all' })).find((r) => r.id === receiptId)?.rawText).toBeNull();
      }
    });

    it('an agent gets no text unless a person approved a reveal for its run', async () => {
      expect((await getReceipt({ ...masked, agent: agentOf }, receiptId)).rawText).toBeNull();
      expect((await getReceipt({ ...ctx, agent: agentOf }, receiptId)).rawText).toBeNull();
      // A reveal of SSNs turns that one View right on for the run: the account numbers stay masked.
      const ssnRevealed = { ...ctx, agent: agentOf, access: { ...masked.access!, flags: { ...masked.access!.flags, sensitivePayroll: true } } };
      const text = (await getReceipt(ssnRevealed, receiptId)).rawText!;
      expect(text).toContain('123-45-6789');
      expect(text).not.toContain(FULL_NUMBER);
    });

    it('a labelled SSN or EIN split oddly by the reading (OCR) is masked too; amounts and longer numbers are not', () => {
      const shown = (line: string) => receiptTextFor(masked, line);
      expect(shown('SSN: 1234-56789')).toBe('SSN: ***-**-6789');
      expect(shown('Tax ID 12 345 6789')).toBe('Tax ID ***-**-6789');
      expect(shown('SSN 1234 5678 9')).toBe('SSN ***-**-6789');
      expect(shown('Social Security Number 123 - 45 - 6789')).toBe('Social Security Number ***-**-6789');
      expect(shown('EIN #12 . 3456789, dependents 2')).toBe('EIN #***-**-6789, dependents 2');
      // Not a tax ID: an amount after the label, a number of ten digits, a short one.
      expect(shown('EIN 1234567.89 paid')).toBe('EIN 1234567.89 paid');
      expect(shown('SSN 1234 5678 90')).toBe('SSN 1234 5678 90');
      expect(shown('TIN 1234 567')).toBe('TIN 1234 567');
      // With the right, as read.
      expect(receiptTextFor(full, 'SSN 1234 5678 9')).toBe('SSN 1234 5678 9');
    });

    it('the text masks match in linear time, however long a run of spaces or digits', () => {
      const started = performance.now();
      receiptTextFor(masked, `SSN${' '.repeat(20_000)}x tax${'-'.repeat(20_000)}id ${'1'.repeat(20_000)}`);
      receiptTextFor(masked, `EIN #${' '.repeat(5_000)}:${' '.repeat(5_000)}1`.repeat(3));
      // Runs of the gaps a loosely grouped number may hold between its digits.
      receiptTextFor(masked, `SSN 1${' - 1'.repeat(10_000)} SSN ${'1 .'.repeat(10_000)} ${'SSN '.repeat(5_000)}1`);
      expect(performance.now() - started).toBeLessThan(2000);
    });
  });

  describe('GET /api/transaction-log', () => {
    const read = async (c: ServiceContext, q = '') => {
      routeCtx = { ...c, role: 'accountant' };
      const res = await logGET(new NextRequest(`http://localhost/api/transaction-log?limit=5000${q ? `&q=${encodeURIComponent(q)}` : ''}`));
      expect(res.status).toBe(200);
      return (await res.json()) as { rows: Array<{ entityType: string; summary: string; data: unknown }>; total: number };
    };

    const SUMMARY = `Paid the county, ${MEMO}`;

    beforeAll(() => {
      // A record whose own summary holds the number (logTransaction callers may write their own).
      appendTransactionLog(TEST_DIR, [
        { userId: ctx.userId!, userName: 'Masking', companyId: ctx.companyId, action: 'create', entityType: 'sales_tax_payment_note', entityId: null, summary: SUMMARY, data: null },
      ]);
    });

    it('records are answered the way the audit trail answers them: memo text and summaries masked without the right', async () => {
      const hidden = await read(masked);
      expect(JSON.stringify(hidden)).not.toContain(FULL_NUMBER);
      // The memo of a check or a journal line in a record's values, and a summary.
      expect(JSON.stringify(hidden.rows.map((r) => r.data))).toContain(SHOWN);
      expect(hidden.rows.map((r) => r.summary)).toContain(`Paid the county, ${SHOWN}`);
      const shown = await read(full);
      expect(JSON.stringify(shown.rows.map((r) => r.data))).toContain(MEMO);
      expect(shown.rows.map((r) => r.summary)).toContain(SUMMARY);
    });

    it('its search matches what the reader is shown, so a guess at hidden digits finds nothing', async () => {
      expect((await read(masked, '0001234')).total).toBe(0);
      expect((await read(full, '0001234')).rows.map((r) => r.summary)).toContain(SUMMARY);
      expect((await read(masked, 'county, Acct # ••••')).rows.map((r) => r.summary)).toEqual([`Paid the county, ${SHOWN}`]);
    });

    describe('Users & Roles records and an agent request', () => {
      const REQUEST_ID = '00000000-0000-4000-8000-00000000a9e3';
      const NOTE = 'Dana Lee is on leave until March';

      beforeAll(async () => {
        await writeAudit(ctx, { action: 'update', entityType: 'user', entityId: ctx.userId!, oldValues: { name: 'M' }, newValues: { name: 'Masking' } });
        // A person's denial of an agent's payroll request, with the reason in their note.
        await writeAudit(ctx, {
          action: 'update',
          entityType: 'agent_permission_request',
          entityId: REQUEST_ID,
          oldValues: { status: 'pending' },
          newValues: { operation: 'employees.get', agentId: AGENT_ID, status: 'denied', note: NOTE },
        });
      });

      type LogPage = { rows: Array<{ entityType: string; entityId: string | null; data: { new?: Record<string, unknown> } | null }>; entityTypes: string[] };
      const kindsOf = (page: LogPage) => new Set(page.rows.map((r) => r.entityType));

      it('an agent with the Admin role reads no Users & Roles records, nor an agent request (auditReaderFor)', async () => {
        const asAdmin = (await read(full)) as unknown as LogPage;
        expect(kindsOf(asAdmin)).toContain('user');
        expect(kindsOf(asAdmin)).toContain('agent_permission_request');
        expect(JSON.stringify(asAdmin)).toContain(NOTE);

        // Both View rights on, as after an approved reveal: still no Users & Roles records.
        for (const agentCtx of [{ ...full, agent: agentOf }, { ...masked, agent: agentOf }]) {
          const asAgent = (await read(agentCtx)) as unknown as LogPage;
          expect(asAgent.rows.length).toBeGreaterThan(0);
          for (const kind of ['user', 'agent_permission_request', 'agent_grant']) {
            expect(kindsOf(asAgent).has(kind)).toBe(false);
            expect(asAgent.entityTypes).not.toContain(kind);
          }
          expect(JSON.stringify(asAgent)).not.toContain(NOTE);
        }
        // Its flags off: the memo text masked, as for a person without the right.
        expect(JSON.stringify(await read({ ...masked, agent: agentOf }))).not.toContain(FULL_NUMBER);
      });

      it("someone who manages agents but not payroll sees the request, its note hidden", async () => {
        const page = (await read(userManager)) as unknown as LogPage;
        const record = page.rows.find((r) => r.entityType === 'agent_permission_request' && r.entityId === REQUEST_ID);
        expect(record).toBeDefined();
        expect(record!.data?.new).toMatchObject({
          status: 'denied',
          note: 'Details hidden. An Admin, or someone who may view Employees & Payroll, can see them.',
        });
        expect(JSON.stringify(page)).not.toContain(NOTE);
        // An Admin reads the note as written.
        const asAdmin = (await read(full)) as unknown as LogPage;
        expect(asAdmin.rows.find((r) => r.entityId === REQUEST_ID)?.data?.new?.note).toBe(NOTE);
      });
    });
  });

  it('Voided/Deleted Transactions Detail: the original values masked as the audit trail masks them', async () => {
    const entityId = '00000000-0000-4000-8000-00000000de1e';
    await writeAudit(ctx, {
      action: 'delete',
      entityType: 'journal_entry',
      entityId,
      oldValues: { entryNumber: 9001, description: 'Gas bill', lines: [{ debit: '8.00', memo: MEMO }, { credit: '8.00', memo: null }] },
    });
    const original = async (c: ServiceContext) =>
      JSON.stringify((await voidedDeletedTransactions(c, { detail: true })).rows.find((r) => r.entityId === entityId)?.original ?? null);
    expect(await original(masked)).not.toContain(FULL_NUMBER);
    expect(await original(masked)).toContain(SHOWN);
    expect(await original(full)).toContain(MEMO);
  });

  describe('an approved reveal in words', () => {
    const SENTENCE = 'Revealed full SSNs and tax IDs of "Show employee Dana Lee" to agent "Bot", approved by Masking.';
    const HIDDEN = 'Revealed full SSNs and tax IDs to an agent. Details hidden. An Admin, or someone who may view Employees & Payroll, can see them.';
    let requestId: string;

    beforeAll(async () => {
      const [req] = await db
        .insert(agentPermissionRequests)
        .values({
          companyId: ctx.companyId,
          agentId: AGENT_ID,
          requestKey: 'reveal-in-words',
          operation: 'employees.get',
          class: 'read_sensitive',
          summary: 'Show employee Dana Lee',
          status: 'executed',
          decidedBy: ctx.userId,
          expiresAt: new Date(Date.now() + 86_400_000),
        })
        .returning();
      requestId = req.id;
      // What agentRequests.ts writes on the decision's record of an approved reveal (revealAudit).
      await writeAudit(ctx, {
        action: 'update',
        entityType: 'agent_permission_request',
        entityId: requestId,
        oldValues: { status: 'pending' },
        newValues: {
          operation: 'employees.get',
          agentId: AGENT_ID,
          status: 'executed',
          approvedBy: ctx.userId,
          revealed: SENTENCE,
          revealedFields: 'full SSNs and tax IDs',
        },
      });
    });

    it('the audit trail: the sentence on the entry, for who may view the work; the kinds only for anyone else', async () => {
      const rowOf = async (c: ServiceContext) =>
        (await listAuditLogs(c, { entityType: 'agent_permission_request', limit: 500 })).rows.find((r) => r.entityId === requestId)!;
      const listed = await rowOf(full);
      expect(listed.summary).toBe(SENTENCE);
      expect((await getAuditLog(full, listed.id)).summary).toBe(SENTENCE);
      const managed = await rowOf(userManager);
      expect(managed.summary).toBe(HIDDEN);
      const one = await getAuditLog(userManager, managed.id);
      expect(one.summary).toBe(HIDDEN);
      expect(one.newValues).toMatchObject({ revealedFields: 'full SSNs and tax IDs', revealed: expect.stringMatching(/^Details hidden\./) });
      expect(JSON.stringify(one)).not.toContain('Dana Lee');
      // Every other entry keeps its shape: no summary.
      const others = (await listAuditLogs(full, { entityType: 'journal_entry', limit: 5 })).rows;
      expect(others.every((r) => !('summary' in r))).toBe(true);
    });

    it('the Agent Activity report says what was revealed in place of the bare summary', async () => {
      const what = async (c: ServiceContext) =>
        (await agentActivityReport(c, {} as ReportParams)).rows.find((r) => r.id === `aa:${requestId}`)?.cells.what;
      expect(await what(full)).toBe(SENTENCE);
      expect(await what(userManager)).toBe(HIDDEN);
    });
  });

  it('Transaction Detail and the General Ledger memo filter: the limit and "more lines" hold when the mask drops lines', async () => {
    const td = async (c: ServiceContext, search: string, limit: number) => {
      const r = await transactionDetail(c, { from, to, search, limit });
      return { memos: r.rows.map((x) => x.memo).sort(), truncated: r.truncated };
    };
    // "0001" matches the stored memo only; the caller sees it masked, so nothing, and nothing more.
    expect(await td(masked, '0001', 1)).toEqual({ memos: [], truncated: false });
    expect(await td(full, '0001', 1)).toEqual({ memos: [MEMO], truncated: false });
    expect(await td(masked, '6789', 1)).toEqual({ memos: [SHOWN], truncated: false });
    // Both lines match the description: one shown, and the report says there is more.
    expect(await td(masked, 'Water', 1)).toMatchObject({ truncated: true });
    expect((await td(masked, 'Water', 1)).memos).toHaveLength(1);
    expect(await td(masked, 'Water', 5)).toEqual({ memos: [SHOWN, 'Paid by check'], truncated: false });

    const gl = async (c: ServiceContext, memo: string, limit: number) => {
      const r = await fetchGlLines(c, await loadAccountMeta(c), { from, to, memo, limit });
      return { memos: r.lines.map((l) => l.memo).sort(), truncated: r.truncated };
    };
    expect(await gl(masked, '0001', 1)).toEqual({ memos: [], truncated: false });
    expect(await gl(masked, '6789', 1)).toEqual({ memos: [SHOWN], truncated: false });
    expect(await gl(masked, 'Water', 1)).toMatchObject({ truncated: true });
    expect(await gl(masked, 'Water', 5)).toEqual({ memos: [SHOWN, 'Paid by check'], truncated: false });
  });

  it('Transaction Detail and the General Ledger memo filter read only as far past the limit as the mask may drop lines', async () => {
    // Every row cap a query of the run asks the database for (drizzle's .limit()).
    const limits = vi.spyOn(PgSelectQueryBuilderBase.prototype, 'limit');
    const largestRead = async (run: () => Promise<unknown>) => {
      limits.mockClear();
      await run();
      return Math.max(...limits.mock.calls.map(([n]) => Number(n)));
    };
    try {
      // "Water" matches both lines by their description: no line can drop, so the limit and one more.
      expect(await largestRead(() => transactionDetail(masked, { from, to, search: 'Water', limit: 1 }))).toBe(2);
      // "6789" matches nothing else on the line whose memo the mask may change: one line more.
      expect(await largestRead(() => transactionDetail(masked, { from, to, search: '6789', limit: 1 }))).toBe(3);
      // A caller who sees memos as stored is matched by the database: the limit and one more.
      expect(await largestRead(() => transactionDetail(full, { from, to, search: '6789', limit: 1 }))).toBe(2);
      // Never the General Ledger's whole scan cap.
      expect(await largestRead(() => transactionDetail(masked, { from, to, search: 'a', limit: 10 }))).toBeLessThan(GL_LIMITS.postFilterScan);

      const meta = await loadAccountMeta(masked);
      expect(await largestRead(() => fetchGlLines(masked, meta, { from, to, memo: 'Water', limit: 1 }))).toBe(2);
      expect(await largestRead(() => fetchGlLines(masked, meta, { from, to, memo: '6789', limit: 1 }))).toBe(3);
      expect(await largestRead(() => fetchGlLines(masked, meta, { from, to, memo: 'a', limit: 10 }))).toBeLessThan(GL_LIMITS.postFilterScan);
    } finally {
      limits.mockRestore();
    }
  });
});
