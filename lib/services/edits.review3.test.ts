/**
 * Review round 3 — edit paths (regression tests).
 *  1. Editing a bill keeps already-invoiced billable lines billed (fixed in bills.ts updateBill).
 *  2. A ledger-neutral edit of a closed-period vendor credit with item lines needs the closing-date password.
 *  3. A deposited sales receipt cannot be re-dated after its deposit.
 *  4. Editing a printed paycheck keeps its check number on the re-posted journal entry.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, vendors, items, billLines, journalEntries, paychecks } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { createBill, updateBill } from './bills';
import { listUnbilled, createInvoiceWithBillables } from './billables';
import { createVendorCredit, updateVendorCredit } from './vendorCredits';
import { createSalesReceipt, updateSalesReceipt } from './salesReceipts';
import { createDeposit } from './deposits';
import { createCompany, setClosingDate } from './company';
import { createEmployee, editPaycheck, runPaycheck } from './payroll';
import { markPaycheckPrinted, queuePaychecks } from './printQueue';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review3-edits');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;
let supplyItemId: string;
const d = (s: string) => new Date(`${s}T12:00:00Z`);

describe('review3 edit paths', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r3e@test.local', name: 'R3', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'R3 Edits Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
      ['6000', 'Job Materials', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    customerId = (await db.insert(customers).values({ companyId: company.id, displayName: 'Jobsite' }).returning())[0].id;
    vendorId = (await db.insert(vendors).values({ companyId: company.id, displayName: 'Lumber' }).returning())[0].id;
    supplyItemId = (
      await db
        .insert(items)
        .values({ companyId: company.id, name: 'Supplies', type: 'non_inventory' as never, expenseAccountId: acct['6000'] })
        .returning()
    )[0].id;
    await postJournalEntry(ctx, {
      date: d('2025-01-01'),
      description: 'Opening',
      lines: [
        { accountId: acct['1000'], debit: '10000.00' },
        { accountId: acct['3000'], credit: '10000.00' },
      ],
    });
  }, 300_000);

  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle */
    }
  });

  it('editing a bill whose billable line was already invoiced does not make the cost billable again', async () => {
    const billInput = {
      vendorId,
      date: d('2026-03-01'),
      lines: [{ accountId: acct['6000'], amount: '200.00', description: 'Lumber', customerId }],
    };
    const bill = await createBill(ctx, billInput);
    const [line] = await db.select().from(billLines).where(eq(billLines.billId, bill.id));
    await createInvoiceWithBillables(
      ctx,
      { customerId, date: d('2026-03-02'), lines: [] } as never,
      { billLineIds: [line.id] },
    );
    expect((await listUnbilled(ctx, customerId)).costs).toHaveLength(0);

    // Memo-only edit of the bill (refusing the edit would also be acceptable).
    let refused = false;
    try {
      await updateBill(ctx, bill.id, { ...billInput, memo: 'edited' });
    } catch {
      refused = true;
    }
    if (!refused) {
      expect((await listUnbilled(ctx, customerId)).costs).toHaveLength(0); // not billable a second time
    }
  });

  it('a memo-only edit of a closed-period vendor credit with item lines needs the closing-date password', async () => {
    const input = {
      vendorId,
      date: d('2026-01-11'),
      lines: [{ itemId: supplyItemId, quantity: 1, unitCost: '5.00' }],
    };
    const vc = await createVendorCredit(ctx, input);
    await setClosingDate(ctx, { closingDate: '2026-01-31', password: 'close-pw' } as never);
    try {
      await expect(updateVendorCredit(ctx, vc.id, { ...input, memo: 'changed' })).rejects.toMatchObject({
        code: 'PERIOD_CLOSED',
      });
      // With the closing-date password the edit goes through and keeps the entry.
      const ok = await updateVendorCredit({ ...ctx, closingDateOverride: true }, vc.id, { ...input, memo: 'changed' });
      expect(ok.memo).toBe('changed');
      expect(ok.postedEntryId).toBe(vc.postedEntryId);
    } finally {
      await setClosingDate(ctx, { closingDate: null } as never);
    }
  });

  it('a deposited sales receipt cannot be re-dated after its deposit', async () => {
    const srInput = {
      customerId,
      date: d('2026-04-01'),
      depositAccountId: acct['1050'],
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '75.00', taxable: false }],
    };
    const sr = await createSalesReceipt(ctx, srInput as never);
    await createDeposit(ctx, { depositAccountId: acct['1000'], date: d('2026-04-05'), salesReceiptIds: [sr.id] });
    await expect(updateSalesReceipt(ctx, sr.id, { ...srInput, date: d('2026-04-20') } as never)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // On or before the deposit date is still fine.
    const ok = await updateSalesReceipt(ctx, sr.id, { ...srInput, date: d('2026-04-05') } as never);
    expect(new Date(ok.date).toISOString().slice(0, 10)).toBe('2026-04-05');
  });

  it('editing a printed paycheck keeps its check number on the journal entry', async () => {
    const [user] = await db.insert(users).values({ email: 'r3e-pay@test.local', name: 'R3P', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'R3 Payroll Co', ownerId: user.id });
    const pctx: ServiceContext = { db, companyId: company.id, userId: user.id };
    const e = await createEmployee(pctx, { firstName: 'Pat', lastName: 'Check', payType: 'salary', payRate: '52000' });
    const pc = await runPaycheck(pctx, { employeeId: e.id, payDate: d('2026-05-15'), grossPay: '1000.00' });
    await queuePaychecks(pctx, [pc.id]);
    await markPaycheckPrinted(pctx, { paycheckId: pc.id, checkNumber: '1043' });

    const edited = await editPaycheck(pctx, pc.id, { payDate: d('2026-05-15'), grossPay: '1100.00' });
    expect(edited.postedEntryId).not.toBe(pc.postedEntryId);
    const [row] = await db.select().from(paychecks).where(eq(paychecks.id, pc.id));
    expect(row.checkNumber).toBe('1043');
    const [entry] = await db.select().from(journalEntries).where(eq(journalEntries.id, edited.postedEntryId!));
    expect(entry.reference).toBe('1043');
  });
});
