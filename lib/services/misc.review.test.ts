import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount, getAccount } from './accounts';
import { createManualEntry } from './journal';
import { createBill, getBill } from './bills';
import { payBills, getBillPayment, voidBillPayment, updateBillPayment } from './billPayments';
import { trialBalance } from './reports';
import { commitUndo, performUndo, prepareUndo } from './undo';
import { createItem, getItem } from './items';
import { createExpense } from './expenses';
import { memorizeSuggestion } from './aiRecurring';
import { runTemplateNow } from './recurring';
import { attachments } from '@/lib/db/schema';
import { saveAttachment, getAttachmentFile, deleteAttachment, normalizeStoragePath, attachmentAbsolutePath } from './attachments';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review-misc');
let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let vendorId: string;
const d = (s: string) => new Date(`${s}T12:00:00Z`);

describe('review misc', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    process.env.BKA_DATA_DIR = TEST_DIR;
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'rm@test.local', name: 'R', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'RM Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4900', 'Discounts Taken', 'revenue', 'other_income'],
      ['6300', 'Office Supplies', 'expense', 'operating_expenses'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['4000', 'Sales', 'revenue', 'sales'],
      ['5000', 'COGS', 'expense', 'cost_of_goods_sold'],
    ];
    for (const [code, name, type, subtype] of defs) acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    vendorId = (await db.insert(vendors).values({ companyId: company.id, displayName: 'Depot' }).returning())[0].id;
    await createManualEntry(ctx, { date: d('2026-01-01'), description: 'Open', lines: [
      { accountId: acct['1000'], debit: '10000.00' }, { accountId: acct['3000'], credit: '10000.00' }] });
  });
  afterAll(async () => {
    delete process.env.BKA_DATA_DIR;
    await closeDb();
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* */ }
  });

  it('undo of a voided bill payment with an early-payment discount re-enters the same cash', async () => {
    const bill = await createBill(ctx, { vendorId, date: d('2026-03-01'), lines: [{ accountId: acct['6300'], amount: '100.00' }] });
    const bankStart = (await getAccount(ctx, acct['1000'])).balance;
    const bp = (await payBills(ctx, {
      vendorId, date: d('2026-03-05'), method: 'check', paymentAccountId: acct['1000'], discountAccountId: acct['4900'],
      applications: [{ billId: bill.id, amountApplied: '48.00', discountTaken: '2.00' }],
    })) as unknown as { id: string };
    const bankAfterPay = (await getAccount(ctx, acct['1000'])).balance;
    expect((await getBill(ctx, bill.id)).balanceDue).toBe('50.00');
    const prepared = await prepareUndo(ctx, { resource: 'bill-payments', kind: 'void', id: bp.id });
    await voidBillPayment(ctx, bp.id);
    const armed = await commitUndo(ctx, { resource: 'bill-payments', kind: 'void', token: prepared.token, id: null });
    expect((await getAccount(ctx, acct['1000'])).balance).toBe(bankStart);
    const out = await performUndo(ctx, armed.token);
    const copy = await getBillPayment(ctx, out.newId!);
    expect(copy.amount).toBe('48.00');
    expect((await getAccount(ctx, acct['1000'])).balance).toBe(bankAfterPay);
    expect((await getBill(ctx, bill.id)).balanceDue).toBe('50.00');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('undo of an edit to a discounted single-bill payment restores the original cash and discount', async () => {
    const bill = await createBill(ctx, { vendorId, date: d('2026-03-01'), lines: [{ accountId: acct['6300'], amount: '100.00' }] });
    const base = { vendorId, date: d('2026-03-05'), method: 'check' as const, paymentAccountId: acct['1000'], discountAccountId: acct['4900'] };
    const bp = (await payBills(ctx, { ...base, applications: [{ billId: bill.id, amountApplied: '98.00', discountTaken: '2.00' }] })) as unknown as { id: string };
    const bank = (await getAccount(ctx, acct['1000'])).balance;
    const prepared = await prepareUndo(ctx, { resource: 'bill-payments', kind: 'update', id: bp.id });
    await updateBillPayment(ctx, bp.id, { ...base, memo: 'x', applications: [{ billId: bill.id, amountApplied: '60.00' }] } as never);
    const armed = await commitUndo(ctx, { resource: 'bill-payments', kind: 'update', token: prepared.token, id: null });
    await performUndo(ctx, armed.token);
    const now = await getBillPayment(ctx, bp.id);
    expect(now.amount).toBe('98.00');
    expect(now.discountTotal).toBe('2.00');
    expect((await getAccount(ctx, acct['1000'])).balance).toBe(bank);
    expect((await getBill(ctx, bill.id)).balanceDue).toBe('0.00');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('refuses to undo a void of a discounted payment that covered several bills (and leaves the token usable state intact)', async () => {
    const b1 = await createBill(ctx, { vendorId, date: d('2026-03-01'), lines: [{ accountId: acct['6300'], amount: '100.00' }] });
    const b2 = await createBill(ctx, { vendorId, date: d('2026-03-01'), lines: [{ accountId: acct['6300'], amount: '50.00' }] });
    const bp = (await payBills(ctx, {
      vendorId, date: d('2026-03-05'), method: 'check', paymentAccountId: acct['1000'], discountAccountId: acct['4900'],
      applications: [{ billId: b1.id, amountApplied: '100.00' }, { billId: b2.id, amountApplied: '49.00', discountTaken: '1.00' }],
    })) as unknown as { id: string };
    const prepared = await prepareUndo(ctx, { resource: 'bill-payments', kind: 'void', id: bp.id });
    await voidBillPayment(ctx, bp.id);
    const armed = await commitUndo(ctx, { resource: 'bill-payments', kind: 'void', token: prepared.token, id: null });
    const bank = (await getAccount(ctx, acct['1000'])).balance;
    await expect(performUndo(ctx, armed.token)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/discount/) });
    // Nothing was re-entered.
    expect((await getAccount(ctx, acct['1000'])).balance).toBe(bank);
    expect((await getBill(ctx, b1.id)).balanceDue).toBe('100.00');
    expect((await getBill(ctx, b2.id)).balanceDue).toBe('50.00');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('memorizing a check with an inventory item line keeps the item (stock received on each run)', async () => {
    const item = await createItem(ctx, { name: 'Widget', type: 'inventory', assetAccountId: acct['1300'], incomeAccountId: acct['4000'], expenseAccountId: acct['5000'], purchaseCost: '10' } as never);
    const exp = await createExpense(ctx, {
      vendorId, date: d('2026-03-01'), method: 'check', paymentAccountId: acct['1000'],
      lines: [{ itemId: item.id, quantity: '5', unitCost: '10.00', amount: '50.00' }],
    } as never);
    expect((await getItem(ctx, item.id)).quantityOnHand).toMatch(/^5(\.0+)?$/);
    const tpl = await memorizeSuggestion(ctx, { docType: 'expense', sourceDocId: exp.id, frequency: 'monthly', nextRunDate: '2026-04-01', name: 'Widgets' });
    await runTemplateNow(ctx, tpl.id, d('2026-04-01'));
    // GL inventory asset grew by 100 total; on-hand must follow (10 units).
    expect((await getAccount(ctx, acct['1300'])).balance).toBe('100.00');
    expect(Number((await getItem(ctx, item.id)).quantityOnHand)).toBe(10);
  });

  it('attachment paths are stored with forward slashes and old backslash rows still resolve', async () => {
    expect(normalizeStoragePath('attachments\\a-b.txt')).toBe('attachments/a-b.txt');
    expect(attachmentAbsolutePath('/data', 'attachments\\x.pdf')).toBe(path.join('/data', 'attachments', 'x.pdf'));
    expect(attachmentAbsolutePath('/data', 'attachments/x.pdf')).toBe(path.join('/data', 'attachments', 'x.pdf'));

    const saved = await saveAttachment(ctx, { filename: 'r.txt', mimeType: 'text/plain', base64: Buffer.from('hello').toString('base64') } as never);
    expect(saved.storagePath).toMatch(/^attachments\/[^\\/]+$/);
    expect((await getAttachmentFile(ctx, saved.id)).buffer.toString()).toBe('hello');

    // A row written by an older Windows build.
    const diskName = 'legacy-win.txt';
    fs.mkdirSync(path.join(TEST_DIR, 'attachments'), { recursive: true });
    const abs = path.join(TEST_DIR, 'attachments', diskName);
    fs.writeFileSync(abs, 'legacy');
    const [row] = await db.insert(attachments).values({
      companyId: ctx.companyId, filename: 'legacy.txt', storagePath: `attachments\\${diskName}`, mimeType: 'text/plain', sizeBytes: 6,
    }).returning();
    expect((await getAttachmentFile(ctx, row.id)).buffer.toString()).toBe('legacy');
    await deleteAttachment(ctx, row.id);
    expect(fs.existsSync(abs)).toBe(false);
  });
});
