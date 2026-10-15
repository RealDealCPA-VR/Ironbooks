/**
 * Accountant's Copy (PARITY I1): dividing-date restrictions on the client and accountant side,
 * the .ibac → .ibcx round trip applying the accountant's changes through the normal services
 * (books stay balanced), cancel, and refusal of a changes file for another file / a cancelled
 * or already imported copy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accountantCopies, accounts, classes, expenses, expenseLines, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createAccount, updateAccount } from '../accounts';
import { createCustomer, deactivateCustomer } from '../customers';
import { createVendor } from '../vendors';
import { createClass } from '../dimensions';
import { createExpense, updateExpense, voidExpense } from '../expenses';
import { createInvoice } from '../invoices';
import { createManualEntry, updateEntry, voidEntry } from '../journal';
import { mergeAccounts } from '../merge';
import { trialBalance } from '../reports';
import { accountantCopyStatus, cancelAccountantCopy, createAccountantCopy, importChangesFile, reviewChangesFile } from './client';
import { accountantChanges, exportChangesFile, inspectTransferFile, openAccountantCopyFile } from './accountant';
import { parseChangesFile, serializeChangesFile } from './format';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-acctcopy');
const CLIENT_DIR = path.join(ROOT, 'client');
const ACCT_DIR = path.join(ROOT, 'accountant');
const ACCT_DIR2 = path.join(ROOT, 'accountant2');

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const endOfDay = (s: string) => new Date(`${s}T23:59:59.999Z`);

let db: DB;
let ctx: ServiceContext;
let adb: DB;
let actx: ServiceContext;
const acct: Record<string, string> = {};
let customerId: string;
let vendorId: string;
let febEntryId: string;
let febEntry2Id: string;
let marchCheckId: string;

async function expectBalanced(c: ServiceContext) {
  const tb = await trialBalance(c);
  expect(tb.balanced).toBe(true);
}

function je(date: string, debitAcct: string, creditAcct: string, amount: string, description: string) {
  return {
    date: d(date),
    description,
    lines: [
      { accountId: debitAcct, debit: amount },
      { accountId: creditAcct, credit: amount },
    ],
  };
}

/** Trial balance keyed by account code (ids of accounts added by the accountant differ). */
async function tbByCode(c: ServiceContext, asOf: Date) {
  const tb = await trialBalance(c, asOf);
  return Object.fromEntries(tb.rows.map((r) => [r.code, `${r.debit}/${r.credit}`]));
}

describe("Accountant's Copy", () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(CLIENT_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'owner-acctcopy@test.local', name: 'Client Owner', passwordHash: 'x' })
      .returning();
    const company = await createCompany(db, { name: 'Copy Client Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
    customerId = (await createCustomer(ctx, { displayName: 'Steady Customer' })).id;
    vendorId = (await createVendor(ctx, { displayName: 'Paper Supply' })).id;

    febEntryId = (await createManualEntry(ctx, je('2026-02-15', acct['6300'], acct['1000'], '100.00', 'Office supplies accrual'))).id;
    febEntry2Id = (await createManualEntry(ctx, je('2026-02-20', acct['6000'], acct['1000'], '40.00', 'Ad by mistake'))).id;
    marchCheckId = (
      await createExpense(ctx, {
        vendorId,
        date: d('2026-03-10'),
        method: 'check',
        paymentAccountId: acct['1000'],
        lines: [{ accountId: acct['6000'], amount: '50.00', description: 'Paper' }],
      })
    ).id;
  });

  afterAll(async () => {
    for (const dir of [CLIENT_DIR, ACCT_DIR, ACCT_DIR2]) await closeDb(dir).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  let transfer: Buffer;
  let changesFile: Buffer;

  it('creates the .ibac transfer file and records the outstanding copy', async () => {
    const res = await createAccountantCopy(ctx, { dividingDate: '2026-03-31', dataDir: CLIENT_DIR });
    expect(res.filename).toMatch(/Accountant's Copy 2026-03-31\)\.ibac$/);
    expect(res.copy).not.toHaveProperty('fileToken');
    transfer = res.buffer;
    const st = await accountantCopyStatus(ctx);
    expect(st.mode).toBe('client');
    expect(st.current?.dividingDate).toBe('2026-03-31');
    // Only one at a time.
    await expect(createAccountantCopy(ctx, { dividingDate: '2026-03-31', dataDir: CLIENT_DIR })).rejects.toMatchObject({ code: 'CONFLICT' });
    const info = inspectTransferFile(transfer);
    expect(info).toMatchObject({ companyName: 'Copy Client Co', dividingDate: '2026-03-31' });
  });

  it('client: locks transactions on or before the dividing date (even with the closing-date password)', async () => {
    const locked = { code: 'CONFLICT', details: expect.objectContaining({ accountantCopy: true }) };
    await expect(createManualEntry(ctx, je('2026-03-15', acct['6300'], acct['1000'], '10.00', 'Too early'))).rejects.toMatchObject(locked);
    await expect(
      createManualEntry({ ...ctx, closingDateOverride: true }, je('2026-03-31', acct['6300'], acct['1000'], '10.00', 'On the date')),
    ).rejects.toMatchObject(locked);
    await expect(voidEntry(ctx, febEntryId)).rejects.toMatchObject(locked);
    await expect(updateEntry(ctx, febEntryId, je('2026-04-02', acct['6300'], acct['1000'], '100.00', 'Moved'))).rejects.toMatchObject(locked);
    await expect(voidExpense(ctx, marchCheckId)).rejects.toMatchObject(locked);
    await expect(
      createExpense(ctx, { vendorId, date: d('2026-03-20'), method: 'check', paymentAccountId: acct['1000'], lines: [{ accountId: acct['6000'], amount: '5.00' }] }),
    ).rejects.toMatchObject(locked);
    // After the dividing date the client keeps working.
    const april = await createManualEntry(ctx, je('2026-04-05', acct['6300'], acct['1000'], '25.00', 'April supplies'));
    expect(april.status).toBe('posted');
    await expectBalanced(ctx);
  });

  it('client: list entries cannot be deleted or merged; accounts used before the dividing date cannot be edited', async () => {
    await expect(deactivateCustomer(ctx, customerId)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(mergeAccounts(ctx, { fromId: acct['6000'], toId: acct['6300'] })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(updateAccount(ctx, acct['6300'], { name: 'Office Stuff' })).rejects.toMatchObject({ code: 'CONFLICT' });
    // New accounts and accounts only used after the dividing date can be added / edited.
    const fresh = await createAccount(ctx, { code: '6910', name: 'Client New Expense', type: 'expense' as never, subtype: 'operating_expenses' });
    const renamed = await updateAccount(ctx, fresh.id, { name: 'Client Newer Expense' });
    expect(renamed.name).toBe('Client Newer Expense');
    // Unused account: making it inactive counts as deleting it.
    await expect(updateAccount(ctx, fresh.id, { isActive: false })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('accountant: opens the copy and may only work on or before the dividing date', async () => {
    const opened = await openAccountantCopyFile(transfer, ACCT_DIR);
    expect(opened).toMatchObject({ companyName: 'Copy Client Co', dividingDate: '2026-03-31' });
    adb = await getDb(ACCT_DIR);
    actx = { db: adb, companyId: ctx.companyId, userId: ctx.userId };
    expect((await accountantCopyStatus(actx)).mode).toBe('accountant');

    const locked = { code: 'CONFLICT', details: expect.objectContaining({ accountantCopy: true, side: 'accountant' }) };
    await expect(createManualEntry(actx, je('2026-04-01', acct['6300'], acct['1000'], '10.00', 'After'))).rejects.toMatchObject(locked);
    // Work the changes file can't carry back is refused (an invoice posts from its own source).
    await expect(
      createInvoice(actx, { customerId, date: d('2026-03-01'), lines: [{ description: 'Work', quantity: 1, rate: '10' }] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // No list deletes in the copy either.
    await expect(deactivateCustomer(actx, customerId)).rejects.toMatchObject({ code: 'CONFLICT' });
    // Status of the original entry is untouched by the refused work.
    const [e] = await adb.select().from(journalEntries).where(eq(journalEntries.id, febEntryId));
    expect(e.status).toBe('posted');
  });

  it('accountant: makes adjustments and exports the changes file', async () => {
    // Edit a client entry, void another, add new account + class + entry, edit a check, add a check.
    await updateEntry(actx, febEntryId, je('2026-02-15', acct['6300'], acct['1000'], '120.00', 'Office supplies accrual (corrected)'));
    await voidEntry(actx, febEntry2Id);
    const bankFees = await createAccount(actx, { code: '6150', name: 'Audit Fees', type: 'expense' as never, subtype: 'operating_expenses' });
    const cls = await createClass(actx, { name: 'Audit' });
    await createManualEntry(actx, {
      date: d('2026-03-31'),
      description: 'Year-end audit fee accrual',
      isAdjusting: true,
      lines: [
        { accountId: bankFees.id, debit: '300.00', classId: cls.id, memo: 'Audit' },
        { accountId: acct['2000'], credit: '300.00', entityType: 'vendor', entityId: vendorId },
      ],
    });
    await updateExpense(actx, marchCheckId, {
      vendorId,
      date: d('2026-03-10'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '50.00', description: 'Paper (recoded)' }],
    });
    await createExpense(actx, {
      payeeName: 'Corner Store',
      date: d('2026-03-28'),
      method: 'cash',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '12.34', description: 'Pens' }],
    });
    await expectBalanced(actx);

    const changes = await accountantChanges(actx);
    expect(changes.accounts.map((a) => a.op)).toEqual(['add']);
    expect(changes.classes).toHaveLength(1);
    const kinds = changes.transactions.map((t) => `${t.type}:${t.op}`).sort();
    expect(kinds).toEqual(['expense:add', 'expense:edit', 'journal_entry:add', 'journal_entry:edit', 'journal_entry:void']);
    expect(changes.warnings).toEqual([]);

    const out = await exportChangesFile(actx, { note: 'Please review the audit accrual.' });
    expect(out.filename).toMatch(/\.ibcx$/);
    expect(out.counts).toEqual({ accounts: 1, classes: 1, transactions: 5 });
    changesFile = out.buffer;
  });

  it('client: refuses a damaged changes file and one meant for another company file', async () => {
    const tampered = JSON.parse(changesFile.toString('utf8'));
    tampered.transactions[0].baseVersion = null;
    await expect(reviewChangesFile(ctx, Buffer.from(JSON.stringify(tampered)))).rejects.toMatchObject({ code: 'VALIDATION' });

    // Same file, but a well-formed changes file of another company / copy.
    const { sha256: _s, ...body } = parseChangesFile(changesFile);
    const otherCo = await createCompany(db, { name: 'Other Co', ownerId: ctx.userId! });
    await expect(importChangesFile({ ...ctx, companyId: otherCo.id }, changesFile)).rejects.toMatchObject({ code: 'VALIDATION' });
    const foreign = serializeChangesFile({ ...body, fileToken: 'not-the-token' });
    await expect(importChangesFile(ctx, foreign)).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/different company file/) });
  });

  it('client: reviews and imports the changes through the normal services, books stay balanced', async () => {
    const review = await reviewChangesFile(ctx, changesFile);
    expect(review.canImport).toBe(true);
    expect(review.note).toBe('Please review the audit accrual.');
    expect(review.counts).toEqual({ added: 2, changed: 2, voided: 1, lists: 2 });
    expect(review.items.find((i) => i.op === 'edit' && i.kind === 'Journal entry')?.before?.join(' ')).toMatch(/100\.00/);

    const before = await trialBalance(ctx);
    const res = await importChangesFile(ctx, changesFile);
    expect(res.applied).toEqual({ accounts: 1, classes: 1, added: 2, changed: 2, voided: 1 });
    expect(res.trialBalance.balanced).toBe(true);
    expect(before.balanced).toBe(true);
    await expectBalanced(ctx);

    // The client's books on/through the dividing date now equal the accountant's.
    expect(await tbByCode(ctx, endOfDay('2026-03-31'))).toEqual(await tbByCode(actx, endOfDay('2026-03-31')));

    // Edited entry: voided and replaced; voided entry voided.
    const [old] = await db.select().from(journalEntries).where(eq(journalEntries.id, febEntryId));
    expect(old.status).toBe('void');
    const [v2] = await db.select().from(journalEntries).where(eq(journalEntries.id, febEntry2Id));
    expect(v2.status).toBe('void');
    // New account + class created on the client, used by the new entry.
    const [fees] = await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '6150')));
    expect(fees.balance).toBe('300.00');
    const [cls] = await db.select().from(classes).where(and(eq(classes.companyId, ctx.companyId), eq(classes.name, 'Audit')));
    const [feeLine] = await db.select().from(journalEntryLines).where(eq(journalEntryLines.accountId, fees.id));
    expect(feeLine.classId).toBe(cls.id);
    const [adj] = await db.select().from(journalEntries).where(eq(journalEntries.id, feeLine.journalEntryId));
    expect(adj.isAdjusting).toBe(true);
    // Check recoded; cash expense added.
    const [line] = await db.select().from(expenseLines).where(eq(expenseLines.expenseId, marchCheckId));
    expect(line.accountId).toBe(acct['6300']);
    const store = await db.select().from(expenses).where(and(eq(expenses.companyId, ctx.companyId), eq(expenses.payeeName, 'Corner Store')));
    expect(store).toHaveLength(1);

    // Restriction lifted.
    expect((await accountantCopyStatus(ctx)).mode).toBe('none');
    await createManualEntry(ctx, je('2026-03-15', acct['6300'], acct['1000'], '10.00', 'Now allowed'));
    await deactivateCustomer(ctx, customerId);
    // The same file can't be imported twice.
    await expect(importChangesFile(ctx, changesFile)).rejects.toMatchObject({ code: 'CONFLICT' });
    const [row] = await db.select().from(accountantCopies).where(eq(accountantCopies.companyId, ctx.companyId));
    expect(row.status).toBe('imported');
  });

  it('cancel: lifts the restriction and the cancelled copy\'s changes file is refused', async () => {
    const second = await createAccountantCopy(ctx, { dividingDate: '2026-04-30', dataDir: CLIENT_DIR });
    await expect(createManualEntry(ctx, je('2026-04-10', acct['6300'], acct['1000'], '1.00', 'Locked'))).rejects.toMatchObject({ code: 'CONFLICT' });

    // The accountant works in the second copy and sends changes...
    await openAccountantCopyFile(second.buffer, ACCT_DIR2);
    const adb2 = await getDb(ACCT_DIR2);
    const actx2: ServiceContext = { db: adb2, companyId: ctx.companyId, userId: ctx.userId };
    await createManualEntry(actx2, je('2026-04-20', acct['6300'], acct['1000'], '7.00', 'Late adjustment'));
    const late = await exportChangesFile(actx2, {});
    await closeDb(ACCT_DIR2);

    // ...but the client cancels the copy first.
    const cancelled = await cancelAccountantCopy(ctx);
    expect(cancelled.status).toBe('cancelled');
    expect((await accountantCopyStatus(ctx)).mode).toBe('none');
    await createManualEntry(ctx, je('2026-04-10', acct['6300'], acct['1000'], '1.00', 'Allowed again'));
    await expect(reviewChangesFile(ctx, late.buffer)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/cancelled/) });
    await expect(importChangesFile(ctx, late.buffer)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(cancelAccountantCopy(ctx)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expectBalanced(ctx);
  });
});
