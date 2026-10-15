/**
 * Enter Batch Transactions (team keyboard): a pasted spreadsheet posts one balanced document per
 * row through the normal services, failures are reported per row without blocking the good rows,
 * the grid's lookups are company-scoped, and the closing date / permissions still apply.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq, inArray } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, bills, expenses, invoices, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany, setClosingDate } from '../company';
import { createVendor } from '../vendors';
import { createCustomer } from '../customers';
import { trialBalance } from '../reports';
import { emptyPermissionSet, type EffectiveAccess, type Area } from '@/lib/permissions/model';
import { batchEnterLookups, batchEnterTransactions } from './batchEnter';
import { parseBatchPaste } from './batchEnterParse';
import { API_ROUTE_PERMISSIONS } from '@/lib/permissions/routes';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-batch-enter-keyboard');
let db: DB;
let ctx: ServiceContext;
let other: ServiceContext;
const acct: Record<string, string> = {};

function only(areas: Partial<Record<Area, Array<'view' | 'create' | 'modify' | 'delete' | 'print'>>>): EffectiveAccess {
  const permissions = emptyPermissionSet();
  for (const [k, v] of Object.entries(areas)) (permissions as Record<string, string[]>)[k] = v as string[];
  return { roleKeys: ['kb'], permissions, flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false }, isAdmin: false };
}

async function expectBalanced(c: ServiceContext = ctx) {
  const tb = await trialBalance(c);
  expect(tb.balanced).toBe(true);
  expect(tb.totalDebit).toBe(tb.totalCredit);
}

/** Every journal entry behind the given entry ids balances on its own. */
async function expectEntriesBalanced(entryIds: string[]) {
  expect(entryIds.length).toBeGreaterThan(0);
  const lines = await db.select().from(journalEntryLines).where(inArray(journalEntryLines.journalEntryId, entryIds));
  for (const id of entryIds) {
    const ls = lines.filter((l) => l.journalEntryId === id);
    expect(ls.length).toBeGreaterThanOrEqual(2);
    const dr = ls.reduce((s, l) => s + Math.round(Number(l.debit ?? 0) * 100), 0);
    const cr = ls.reduce((s, l) => s + Math.round(Number(l.credit ?? 0) * 100), 0);
    expect(dr).toBe(cr);
  }
}

describe('Enter Batch Transactions — paste, post, per-row report', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'kb-batch@test.local', name: 'Keys', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Keyboard Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
    await createVendor(ctx, { displayName: 'Office Depot' });
    await createVendor(ctx, { displayName: 'City Power' });
    await createCustomer(ctx, { displayName: 'Slow Payer' });

    const otherCo = await createCompany(db, { name: 'Other Co', ownerId: user.id });
    other = { db, companyId: otherCo.id, userId: user.id };
    await createVendor(other, { displayName: 'Secret Vendor' });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('lookups are company-scoped and carry the closing date and A/P account', async () => {
    const l = await batchEnterLookups(ctx);
    expect(l.vendors.map((v) => v.name).sort()).toEqual(['City Power', 'Office Depot']);
    expect(l.customers.map((c) => c.name)).toEqual(['Slow Payer']);
    expect(l.accounts.some((a) => a.code === '6300')).toBe(true);
    expect(l.closingDate).toBeNull();
    expect(l.apAccountLabel).toMatch(/^2000 · /);
    const o = await batchEnterLookups(other);
    expect(o.vendors.map((v) => v.name)).toEqual(['Secret Vendor']);
  });

  it('pasted checks with headers in Excel order post one balanced check per row; bad rows are reported', async () => {
    const text = [
      'Check #\tDate\tPayee\tAmount\tCategory\tMemo',
      '3001\t3/2/2026\tOffice Depot\t$45.00\t6300\tPaper',
      '3002\t3/3/2026\tWalk-in Payee\t1,010.10\tUtilities\t',
      '3003\t3/4/2026\tSecret Vendor\t12\tNope Account\t',
      '3004\t2026-02-30\tCity Power\t5\t6600\t',
    ].join('\r\n');
    const rows = parseBatchPaste(text, 'check');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ ref: '3001', date: '3/2/2026', name: 'Office Depot', amount: '$45.00', account: '6300', memo: 'Paper' });

    const before = (await db.select().from(expenses).where(eq(expenses.companyId, ctx.companyId))).length;
    const res = await batchEnterTransactions(ctx, { type: 'check', bankAccountId: acct['1000'], mode: 'row', rows });
    expect(res).toMatchObject({ saved: 2, failed: 2, rolledBack: false });
    expect(res.results.map((r) => r.ok)).toEqual([true, true, false, false]);
    expect(res.results[0].id).toBeTruthy();
    expect(res.results[1].warnings[0]).toMatch(/one-time payee/);
    // "Secret Vendor" exists only in another company: it is a one-time payee here, and the bad
    // account is what fails the row.
    expect(res.results[2].errors.join(' ')).toMatch(/account "Nope Account" was not found/);
    expect(res.results[3].errors.join(' ')).toMatch(/not a valid date/);

    const saved = await db.select().from(expenses).where(eq(expenses.companyId, ctx.companyId));
    expect(saved.length).toBe(before + 2);
    const mine = saved.filter((e) => res.results.some((r) => r.id === e.id));
    expect(mine.map((e) => e.total).sort()).toEqual(['1010.10', '45.00']);
    const entryIds = mine.map((e) => e.postedEntryId).filter((x): x is string => !!x);
    await expectEntriesBalanced(entryIds);
    await expectBalanced();
  });

  it('a journal entry paste with one signed Amount column posts balanced entries', async () => {
    const rows = parseBatchPaste(
      'Date\tRef\tAccount\tAmount\tMemo\n3/31/2026\tKB1\t6600\t125.00\tAccrue power\n3/31/2026\tKB1\t2000\t-125.00\t\n',
      'journal',
    );
    // A/P line needs a vendor: add it the way a user fixes a red row.
    rows[1].name = 'City Power';
    const res = await batchEnterTransactions(ctx, { type: 'journal', mode: 'row', rows });
    expect(res.saved).toBe(1);
    const [je] = await db.select().from(journalEntries).where(eq(journalEntries.id, res.results[0].id!));
    expect(je.reference).toBe('KB1');
    await expectEntriesBalanced([je.id]);
    await expectBalanced();
  });

  it('invoices keep the pasted Ref as their number; an unknown customer fails only its row', async () => {
    const rows = parseBatchPaste(
      'Date\tInvoice #\tCustomer\tAccount\tAmount\n3/9/2026\tKB-INV-1\tSlow Payer\t4100\t250\n3/9/2026\tKB-INV-2\tNobody\t4100\t1\n',
      'invoice',
    );
    const res = await batchEnterTransactions(ctx, { type: 'invoice', mode: 'row', rows });
    expect(res).toMatchObject({ saved: 1, failed: 1 });
    expect(res.results[1].errors[0]).toMatch(/customer "Nobody" was not found/);
    const [inv] = await db.select().from(invoices).where(eq(invoices.id, res.results[0].id!));
    expect(inv.refNumber).toBe('KB-INV-1');
    expect(inv.total).toBe('250.00');
    await expectBalanced();
  });

  it('closing date: rows on/before it fail alone; the rest of the batch saves', async () => {
    await setClosingDate(ctx, { closingDate: '2026-01-31' });
    try {
      const res = await batchEnterTransactions(ctx, {
        type: 'bill',
        mode: 'row',
        rows: [
          { date: '2026-01-20', name: 'City Power', account: '6600', amount: '9.00' },
          { date: '2026-03-20', ref: 'KB-B2', name: 'City Power', account: '6600', amount: '8.00' },
        ],
      });
      expect(res.saved).toBe(1);
      expect(res.results[0].ok).toBe(false);
      expect(res.results[0].errors.join(' ')).toMatch(/closed|closing/i);
      const [b] = await db.select().from(bills).where(eq(bills.id, res.results[1].id!));
      expect(b.billNumber).toBe('KB-B2');
      // The grid shows the warning before saving.
      expect((await batchEnterLookups(ctx)).closingDate).toBe('2026-01-31');
    } finally {
      await setClosingDate(ctx, { closingDate: null });
    }
    await expectBalanced();
  });

  it('permissions: a role without Banking rights cannot batch-enter checks', async () => {
    const before = (await db.select().from(expenses).where(eq(expenses.companyId, ctx.companyId))).length;
    await expect(
      batchEnterTransactions({ ...ctx, access: only({ accounting: ['view', 'create'] }) }, {
        type: 'check',
        bankAccountId: acct['1000'],
        rows: [{ date: '2026-03-05', name: 'Office Depot', account: '6300', amount: '1' }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await db.select().from(expenses).where(eq(expenses.companyId, ctx.companyId))).length).toBe(before);
  });

  it('lookups (full customer and vendor lists) need the same right as batch entry, not just view', async () => {
    expect(API_ROUTE_PERMISSIONS['/api/accountant/batch-enter/lookups'].GET).toEqual({ area: 'accounting', action: 'create' });
    expect(API_ROUTE_PERMISSIONS['/api/accountant/batch-enter'].POST).toEqual({ area: 'accounting', action: 'create' });
    await expect(batchEnterLookups({ ...ctx, access: only({ accounting: ['view'] }) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const l = await batchEnterLookups({ ...ctx, access: only({ accounting: ['view', 'create'] }) });
    expect(l.vendors.length).toBe(2);
  });

  it("another company's bank account is refused", async () => {
    const [otherBank] = await db.select().from(accounts).where(eq(accounts.companyId, other.companyId));
    await expect(
      batchEnterTransactions(ctx, {
        type: 'deposit',
        bankAccountId: otherBank.id,
        rows: [{ date: '2026-03-05', account: '3000', amount: '1' }],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
