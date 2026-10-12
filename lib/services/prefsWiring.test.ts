/**
 * P1 setup (A1): company preferences that used to be saved but never read now change behaviour.
 *  - warnDuplicateInvoice/Estimate/PoNumbers: off = QB accepts a duplicate number silently.
 *  - requireAccountNumbers: on = a blank account number is refused; off = one is assigned.
 *  - trackReimbursedAsIncome: billable costs credit the expense account (off) or the
 *    reimbursement income account (on).
 *  - progressInvoicingEnabled: off = progress invoices are refused with a plain message.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { customers, expenseLines, users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, updateCompany } from './company';
import { createAccount, listAccounts } from './accounts';
import { createInvoice, getInvoice } from './invoices';
import { assertUniqueDocNumber } from './docNumbers';
import { createExpense } from './expenses';
import { createInvoiceWithBillables } from './billables';
import { createProgressInvoice } from './estimates';
import { trialBalance } from './reports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-prefs-wiring');
let db: DB;
let ctx: ServiceContext;
let customerId: string;
let vendorId: string;
const acct: Record<string, string> = {};

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'wiring@test.local', name: 'W', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Wiring Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await listAccounts(ctx)) acct[a.code] = a.id;
  const [c] = await db.insert(customers).values({ companyId: company.id, displayName: 'Client' }).returning();
  customerId = c.id;
  const [v] = await db.insert(vendors).values({ companyId: company.id, displayName: 'Supplier' }).returning();
  vendorId = v.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('duplicate document number warnings', () => {
  it('warns (refuses until confirmed) when on; accepts the duplicate silently when off', async () => {
    await createInvoice(ctx, {
      customerId,
      date: new Date('2026-03-01'),
      refNumber: 'DUP-1',
      lines: [{ description: 'Work', quantity: 1, rate: 10, accountId: acct['4100'] }],
    });
    await expect(assertUniqueDocNumber(ctx, 'invoice', 'DUP-1')).rejects.toMatchObject({ code: 'CONFLICT' });
    await updateCompany(ctx, { settings: { warnDuplicateInvoiceNumbers: false } });
    await expect(assertUniqueDocNumber(ctx, 'invoice', 'DUP-1')).resolves.toEqual({ duplicate: true });
    // Types without a preference still warn.
    await updateCompany(ctx, { settings: { warnDuplicateInvoiceNumbers: true } });
    await expect(assertUniqueDocNumber(ctx, 'invoice', 'DUP-1')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('require account numbers', () => {
  it('assigns the next free number in the type range when not required', async () => {
    const a = await createAccount(ctx, { code: '', name: 'Postage', type: 'expense', subtype: 'operating_expenses' });
    expect(a.code).toBe('6010'); // 6000 is taken by the default chart
    const b = await createAccount(ctx, { code: '', name: 'Petty Cash', type: 'asset', subtype: 'other_current_asset' });
    expect(Number(b.code)).toBeGreaterThanOrEqual(1000);
    expect(Number(b.code)).toBeLessThan(2000);
  });

  it('refuses a blank number when required', async () => {
    await updateCompany(ctx, { settings: { accountNumbersEnabled: true, requireAccountNumbers: true } });
    await expect(
      createAccount(ctx, { code: '', name: 'Tolls', type: 'expense', subtype: 'operating_expenses' }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/Enter an account number/) });
    await updateCompany(ctx, { settings: { requireAccountNumbers: false } });
  });
});

describe('track reimbursed expenses as income', () => {
  async function billableExpense(desc: string) {
    const expense = await createExpense(ctx, {
      vendorId,
      date: new Date('2026-03-02'),
      method: 'cash',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], description: desc, amount: '50.00', customerId }],
    });
    const [el] = await db.select().from(expenseLines).where(eq(expenseLines.expenseId, expense.id));
    return el.id;
  }

  it('off (QB default): the billed amount goes back to the expense account', async () => {
    const lineId = await billableExpense('Printer paper');
    const inv = await createInvoiceWithBillables(ctx, { customerId, date: new Date('2026-03-03'), lines: [] }, { expenseLineIds: [lineId] });
    const full = await getInvoice(ctx, inv.id);
    expect(full.lines[0].accountId).toBe(acct['6300']);
  });

  it('on: the billed amount goes to the reimbursement income account', async () => {
    const income = await createAccount(ctx, { code: '4130', name: 'Reimbursed Expenses Income', type: 'revenue', subtype: 'other_income' });
    await updateCompany(ctx, { settings: { trackReimbursedAsIncome: true } });
    const lineId = await billableExpense('Courier');
    const inv = await createInvoiceWithBillables(ctx, { customerId, date: new Date('2026-03-04'), lines: [] }, { expenseLineIds: [lineId] });
    const full = await getInvoice(ctx, inv.id);
    expect(full.lines[0].accountId).toBe(income.id);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });
});

describe('progress invoicing switch', () => {
  it('is refused with a plain message while turned off', async () => {
    await updateCompany(ctx, { settings: { progressInvoicingEnabled: false } });
    await expect(
      createProgressInvoice(ctx, '00000000-0000-0000-0000-000000000000', { percent: 10 } as never),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringMatching(/^Progress invoicing is turned off for this company/),
    });
    await updateCompany(ctx, { settings: { progressInvoicingEnabled: true } });
    await expect(
      createProgressInvoice(ctx, '00000000-0000-0000-0000-000000000000', { percent: 10 } as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
