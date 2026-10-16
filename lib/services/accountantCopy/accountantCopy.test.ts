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
import {
  accountantCopies,
  accounts,
  classes,
  depositLines,
  deposits,
  expenses,
  expenseLines,
  journalEntries,
  journalEntryLines,
  transfers,
  users,
} from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createAccount, updateAccount } from '../accounts';
import { createCustomer, deactivateCustomer } from '../customers';
import { createVendor } from '../vendors';
import { createClass } from '../dimensions';
import { createExpense, updateExpense, voidExpense } from '../expenses';
import { createInvoice } from '../invoices';
import { createManualEntry, updateEntry, voidEntry } from '../journal';
import { createTransfer, updateTransfer, voidTransfer } from '../transfers';
import { createDeposit, voidDeposit } from '../deposits';
import { receivePayment } from '../payments';
import { applyJournalCredit } from '../journalApplications';
import { mergeAccounts } from '../merge';
import { trialBalance } from '../reports';
import { setClosingDate } from '../company';
import { condensePeriod } from '../condense';
import { firstOpenDate } from '../fiscalPeriods';
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
let febTransferId: string;
let febDepositId: string;
let paymentBId: string;
let aprilEntryId: string;
let aprilTransferId: string;

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
    febTransferId = (await createTransfer(ctx, { date: d('2026-02-10'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '200.00', memo: 'To savings' })).id;
    // Two customer payments land in Undeposited Funds; the client deposits the first one.
    const inv = await createInvoice(ctx, { customerId, date: d('2026-02-01'), lines: [{ description: 'February work', quantity: 1, rate: '500' }] });
    const payA = await receivePayment(ctx, { customerId, date: d('2026-02-05'), method: 'check', reference: 'A-1', amount: '200.00', depositAccountId: acct['1050'], applications: [{ invoiceId: inv.id, amountApplied: '200.00' }] });
    const payB = await receivePayment(ctx, { customerId, date: d('2026-02-06'), method: 'check', reference: 'B-2', amount: '300.00', depositAccountId: acct['1050'], applications: [{ invoiceId: inv.id, amountApplied: '300.00' }] });
    paymentBId = payB.payment.id;
    febDepositId = (await createDeposit(ctx, { depositAccountId: acct['1000'], date: d('2026-02-08'), paymentIds: [payA.payment.id], memo: 'Feb deposit' })).id;
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
    aprilEntryId = april.id;
    aprilTransferId = (await createTransfer(ctx, { date: d('2026-04-06'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '15.00' })).id;
    // Transfers and deposits on or before the dividing date are locked too.
    await expect(voidTransfer(ctx, febTransferId)).rejects.toMatchObject(locked);
    await expect(voidDeposit(ctx, febDepositId)).rejects.toMatchObject(locked);
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

  it('client: Condense Data is refused while the copy is out (it would delete locked transactions)', async () => {
    await setClosingDate(ctx, { closingDate: '2026-01-31' });
    try {
      // fixit "move to the first open date" suggests a date past the dividing date, not just the closing date.
      expect(await firstOpenDate(ctx, new Date('2026-01-15T00:00:00.000Z'))).toBe('2026-04-01');
      await expect(condensePeriod(ctx, { beforeDate: new Date('2026-02-01T00:00:00.000Z'), dataDir: CLIENT_DIR })).rejects.toMatchObject({
        code: 'CONFLICT',
        details: expect.objectContaining({ accountantCopy: true }),
      });
      await expect(
        condensePeriod(ctx, { beforeDate: new Date('2026-03-01T00:00:00.000Z'), dataDir: CLIENT_DIR, dryRun: true }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    } finally {
      await setClosingDate(ctx, { closingDate: null });
    }
    const [still] = await db.select().from(journalEntries).where(eq(journalEntries.id, febEntryId));
    expect(still.status).toBe('posted');
  });

  it('accountant: opens the copy and may only work on or before the dividing date', async () => {
    const opened = await openAccountantCopyFile(transfer, ACCT_DIR);
    expect(opened).toMatchObject({ companyName: 'Copy Client Co', dividingDate: '2026-03-31' });
    adb = await getDb(ACCT_DIR);
    actx = { db: adb, companyId: ctx.companyId, userId: ctx.userId };
    expect((await accountantCopyStatus(actx)).mode).toBe('accountant');

    const locked = { code: 'CONFLICT', details: expect.objectContaining({ accountantCopy: true, side: 'accountant' }) };
    await expect(createManualEntry(actx, je('2026-04-01', acct['6300'], acct['1000'], '10.00', 'After'))).rejects.toMatchObject(locked);
    // Invoices travel in the changes file now, but only on or before the dividing date.
    await expect(
      createInvoice(actx, { customerId, date: d('2026-04-02'), lines: [{ description: 'Work', quantity: 1, rate: '10' }] }),
    ).rejects.toMatchObject(locked);
    // No list deletes in the copy either.
    await expect(deactivateCustomer(actx, customerId)).rejects.toMatchObject({ code: 'CONFLICT' });
    // Applying a General Journal credit is carried too, so it is no longer refused up front (an
    // unknown line is an ordinary not-found, as on the client).
    const noLine = '00000000-0000-4000-8000-000000000001';
    const noInvoice = '00000000-0000-4000-8000-000000000002';
    await expect(applyJournalCredit(actx, { journalLineId: noLine, invoiceId: noInvoice, amount: '1.00', date: d('2026-03-01') })).rejects.not.toMatchObject({
      code: 'FORBIDDEN',
    });
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
    // Transfers and deposits: fix the February transfer, add one, void the client's deposit and
    // deposit the other payment (with cash back) instead.
    await updateTransfer(actx, febTransferId, { date: d('2026-02-10'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '250.00', memo: 'To savings (corrected)' });
    await createTransfer(actx, { date: d('2026-03-30'), fromAccountId: acct['1010'], toAccountId: acct['1000'], amount: '75.00', memo: 'Back to checking' });
    await voidDeposit(actx, febDepositId);
    await createDeposit(actx, {
      depositAccountId: acct['1000'],
      date: d('2026-03-29'),
      paymentIds: [paymentBId],
      extraLines: [{ accountId: acct['3000'], amount: '5.00', description: 'Owner top-up' }],
      cashBack: { accountId: acct['1010'], amount: '20.00', memo: 'Petty' },
      memo: 'March deposit',
    });
    await expectBalanced(actx);

    const changes = await accountantChanges(actx);
    expect(changes.accounts.map((a) => a.op)).toEqual(['add']);
    expect(changes.classes).toHaveLength(1);
    const kinds = changes.transactions.map((t) => `${t.type}:${t.op}`).sort();
    // The transfers' own entries travel as the transfers, never as journal entries.
    expect(kinds).toEqual([
      'deposit:add',
      'deposit:void',
      'expense:add',
      'expense:edit',
      'journal_entry:add',
      'journal_entry:edit',
      'journal_entry:void',
      'transfer:add',
      'transfer:edit',
    ]);
    const dep = changes.transactions.find((t) => t.type === 'deposit' && t.op === 'add');
    expect(dep?.op === 'add' && dep.type === 'deposit' && dep.after).toMatchObject({
      total: '285.00',
      paymentIds: [paymentBId],
      salesReceiptIds: [],
      extraLines: [{ accountId: acct['3000'], amount: '5.00', description: 'Owner top-up' }],
      cashBack: { accountId: acct['1010'], amount: '20.00', memo: 'Petty' },
    });
    expect(changes.warnings).toEqual([]);

    const out = await exportChangesFile(actx, { note: 'Please review the audit accrual.' });
    expect(out.filename).toMatch(/\.ibcx$/);
    expect(out.counts).toEqual({ accounts: 1, classes: 1, transactions: 9, names: 0, documents: 0, applications: 0, reconciliations: 0 });
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

  it('client: a changes file with a valid checksum but a broken structure is refused cleanly (400, not a crash)', async () => {
    const { sha256: _s, ...body } = parseChangesFile(changesFile);
    const broken = (mutate: (b: typeof body) => void) => {
      const copy = JSON.parse(JSON.stringify(body)) as typeof body;
      mutate(copy);
      return serializeChangesFile(copy);
    };
    const cases = [
      broken((b) => { delete (b.transactions.find((t) => t.op !== 'void') as { after?: unknown }).after; }),
      broken((b) => { (b.transactions[0] as { op: string }).op = 'merge'; }),
      broken((b) => { (b.transactions[0] as { type: string }).type = 'invoice'; }),
      broken((b) => { (b.transactions.find((t) => t.op !== 'void') as { after: { lines: unknown } }).after.lines = 'nope'; }),
      broken((b) => { b.transactions.push(null as never); }),
      broken((b) => { (b.accounts[0] as { after: unknown }).after = {}; }),
      broken((b) => { (b.classes[0] as { name: unknown }).name = 42; }),
      // Ids must be UUIDs (anything else reached a uuid query and crashed it).
      broken((b) => { b.copyId = 'x'; }),
      broken((b) => { b.companyId = 'not-a-uuid'; }),
      broken((b) => { (b.transactions[0] as { id: string }).id = '42'; }),
      broken((b) => {
        const t = b.transactions.find((x) => x.type === 'journal_entry' && x.op !== 'void') as { after: { lines: Array<{ entityId: string | null }> } };
        t.after.lines[0].entityId = 'nobody';
      }),
      broken((b) => { (b.transactions.find((x) => x.type === 'expense' && x.op !== 'void') as { after: { vendorId: unknown } }).after.vendorId = 'v1'; }),
      // Money must be decimal strings.
      broken((b) => { delete (b.transactions.find((x) => x.type === 'expense' && x.op !== 'void') as { after: { total?: unknown } }).after.total; }),
      broken((b) => { (b.transactions.find((x) => x.type === 'expense' && x.op !== 'void') as { after: { total: unknown } }).after.total = 'lots'; }),
      broken((b) => { (b.transactions.find((x) => x.type === 'expense' && x.op !== 'void') as { after: { lines: Array<{ amount: unknown }> } }).after.lines[0].amount = 12; }),
      broken((b) => {
        const t = b.transactions.find((x) => x.type === 'journal_entry' && x.op !== 'void') as { after: { lines: Array<{ debit: unknown; credit: unknown }> } };
        const l = t.after.lines[0];
        if (l.debit) l.debit = '1e5'; else l.credit = '1e5';
      }),
      broken((b) => { (b.transactions.find((x) => x.type === 'transfer' && x.op !== 'void') as { after: { amount: unknown } }).after.amount = null; }),
      broken((b) => { (b.transactions.find((x) => x.type === 'deposit' && x.op !== 'void') as { after: { paymentIds: unknown } }).after.paymentIds = ['p1']; }),
    ];
    for (const file of cases) {
      await expect(reviewChangesFile(ctx, file)).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/incomplete/) });
      await expect(importChangesFile(ctx, file)).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    expect((await accountantCopyStatus(ctx)).mode).toBe('client');
  });

  it('client: a changes file that edits or voids client work dated after the dividing date is refused', async () => {
    // A normal export never does this; the checksum is unkeyed, so a hand-made file could.
    const { sha256: _s, ...body } = parseChangesFile(changesFile);
    const [april] = await db.select().from(journalEntries).where(eq(journalEntries.id, aprilEntryId));
    const [aprilTr] = await db.select().from(transfers).where(eq(transfers.id, aprilTransferId));
    const craft = (t: (typeof body.transactions)[number]) => serializeChangesFile({ ...body, transactions: [...body.transactions, t] });
    const files = [
      craft({ op: 'void', type: 'journal_entry', id: aprilEntryId, baseVersion: april.updatedAt.toISOString() }),
      craft({
        op: 'edit',
        type: 'journal_entry',
        id: aprilEntryId,
        baseVersion: april.updatedAt.toISOString(),
        after: { date: d('2026-03-31').toISOString(), description: 'Moved', reference: null, isAdjusting: false, entryNumber: april.entryNumber, lines: [{ accountId: acct['6300'], debit: '1.00', credit: null, memo: null, classId: null, entityType: null, entityId: null }, { accountId: acct['1000'], debit: null, credit: '1.00', memo: null, classId: null, entityType: null, entityId: null }] },
      }),
      craft({ op: 'void', type: 'transfer', id: aprilTransferId, baseVersion: aprilTr.updatedAt.toISOString() }),
    ];
    for (const f of files) {
      await expect(reviewChangesFile(ctx, f)).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/dated after the dividing date/) });
      await expect(importChangesFile(ctx, f)).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/dated after the dividing date/) });
    }
    const [still] = await db.select().from(journalEntries).where(eq(journalEntries.id, aprilEntryId));
    expect(still.status).toBe('posted');
    const [stillTr] = await db.select().from(transfers).where(eq(transfers.id, aprilTransferId));
    expect(stillTr.voidedAt).toBeNull();
    expect((await accountantCopyStatus(ctx)).mode).toBe('client');
  });

  it('client: reviews and imports the changes through the normal services, books stay balanced', async () => {
    const review = await reviewChangesFile(ctx, changesFile);
    expect(review.canImport).toBe(true);
    expect(review.note).toBe('Please review the audit accrual.');
    expect(review.counts).toEqual({ added: 4, changed: 3, voided: 2, lists: 2, applications: 0, reconciliations: 0 });
    expect(review.items.find((i) => i.op === 'edit' && i.kind === 'Journal entry')?.before?.join(' ')).toMatch(/100\.00/);
    const trEdit = review.items.find((i) => i.op === 'edit' && i.kind === 'Transfer');
    expect(trEdit?.before?.join(' ')).toMatch(/200\.00/);
    expect(trEdit?.after?.join(' ')).toMatch(/250\.00/);
    const depAdd = review.items.find((i) => i.op === 'add' && i.kind === 'Deposit');
    expect(depAdd?.amount).toBe('285.00');
    expect(depAdd?.after?.join(' ')).toMatch(/Payment #B-2 — \$300\.00 \(Steady Customer\)/);
    expect(review.items.find((i) => i.op === 'void' && i.kind === 'Deposit')?.before?.join(' ')).toMatch(/Payment #A-1/);

    const before = await trialBalance(ctx);
    const res = await importChangesFile(ctx, changesFile);
    expect(res.applied).toEqual({ accounts: 1, classes: 1, names: 0, added: 4, changed: 3, voided: 2, applications: 0, reconciliations: 0 });
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
    // Transfer edited in place (record-locked), new transfer added; no stray journal entries.
    const [tr] = await db.select().from(transfers).where(eq(transfers.id, febTransferId));
    expect(tr.amount).toBe('250.00');
    expect(tr.memo).toBe('To savings (corrected)');
    const back = await db.select().from(transfers).where(and(eq(transfers.companyId, ctx.companyId), eq(transfers.memo, 'Back to checking')));
    expect(back).toHaveLength(1);
    // Client deposit voided; payment B deposited with the extra line and cash back.
    const [d1] = await db.select().from(deposits).where(eq(deposits.id, febDepositId));
    expect(d1.voidedAt).not.toBeNull();
    const [d2] = await db.select().from(deposits).where(and(eq(deposits.companyId, ctx.companyId), eq(deposits.memo, 'March deposit')));
    expect(d2.total).toBe('285.00');
    const d2Lines = await db.select().from(depositLines).where(eq(depositLines.depositId, d2.id));
    expect(d2Lines.find((l) => l.paymentId)?.paymentId).toBe(paymentBId);
    expect(d2Lines.find((l) => l.description?.startsWith('cashback:'))?.amount).toBe('-20.00');

    // Restriction lifted.
    expect((await accountantCopyStatus(ctx)).mode).toBe('none');
    await createManualEntry(ctx, je('2026-03-15', acct['6300'], acct['1000'], '10.00', 'Now allowed'));
    await voidTransfer(ctx, febTransferId);
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
    await updateAccount(actx2, acct['6100'], { name: 'Bank Charges' });
    // The accountant's copy can't start or cancel copies of its own.
    await expect(createAccountantCopy(actx2, { dividingDate: '2026-04-30', dataDir: ACCT_DIR2 })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(cancelAccountantCopy(actx2)).rejects.toMatchObject({ code: 'CONFLICT' });
    const late = await exportChangesFile(actx2, {});
    await closeDb(ACCT_DIR2);

    // Record locking: the client renamed the same (unused) account meanwhile -> the review flags it
    // and the import is refused as a whole (nothing applied).
    await updateAccount(ctx, acct['6100'], { name: 'Bank Fees (client)' });
    const review = await reviewChangesFile(ctx, late.buffer);
    expect(review.canImport).toBe(false);
    expect(review.items.find((i) => i.kind === 'Account')?.problem).toMatch(/changed in your file/);
    await expect(importChangesFile(ctx, late.buffer)).rejects.toMatchObject({ code: 'CONFLICT' });
    const lateRows = await db.select().from(journalEntries).where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.description, 'Late adjustment')));
    expect(lateRows).toHaveLength(0);
    expect((await accountantCopyStatus(ctx)).mode).toBe('client');

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
