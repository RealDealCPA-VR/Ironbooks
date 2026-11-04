/**
 * Feature round (accountant team) — review round 5 leftover (purchases -> ledger / imports):
 * postings found Accounts Payable (2000), Inventory Asset (1300), Cost of Goods Sold (5000),
 * Sales Tax Payable (2200) and Payroll Liabilities (2300) by their number, so on a chart converted
 * from QuickBooks with other numbering they posted to whatever account held that number. They now
 * resolve by ROLE (lib/services/accountRoles.ts): the account chosen for the role, else the usual
 * number when it is that kind of account, else the one account that clearly is.
 * Each test failed before the fix (bills hit the loan numbered 2000, etc.).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, bills, invoices, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount, deactivateAccount, updateAccount } from './accounts';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createBill } from './bills';
import { createItem } from './items';
import { createInvoice } from './invoices';
import { createTaxRate } from './salesTax';
import { adjustInventory } from './inventory';
import { listAccountRoles, resolveSystemAccount, setAccountRole } from './accountRoles';
import { salesTaxLiabilityAccounts } from './accountant/salesTaxLedger';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-feature-account-roles');
const D = (s: string) => new Date(`${s}T12:00:00Z`);

let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
let vendorId: string;
let customerId: string;

async function linesOf(entryId: string) {
  return db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, entryId));
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'roles@test.local', name: 'Roles', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Converted Chart Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  // A chart converted from QuickBooks: its own numbers, and the usual Ironbooks numbers taken by
  // other kinds of accounts (the defaults have no history yet, so their type may still change).
  await updateAccount(ctx, acct['2000'], { name: 'Loan from Owner', qbType: 'long_term_liability' });
  acct.ap = (await createAccount(ctx, { code: '20000', name: 'Accounts Payable', qbType: 'accounts_payable' })).id;
  await updateAccount(ctx, acct['1300'], { name: 'Prepaid Insurance', qbType: 'other_current_asset' });
  acct.inv = (await createAccount(ctx, { code: '12100', name: 'Inventory Asset', qbType: 'other_current_asset' })).id;
  await updateAccount(ctx, acct['5000'], { name: 'Advertising', qbType: 'expense' });
  acct.cogs = (await createAccount(ctx, { code: '50000', name: 'Cost of Goods Sold', qbType: 'cost_of_goods_sold' })).id;
  acct.stp = (await createAccount(ctx, { code: '25500', name: 'Sales Tax Payable', qbType: 'other_current_liability' })).id;
  acct.exp = (await createAccount(ctx, { code: '64000', name: 'Office Supplies', qbType: 'expense' })).id;
  acct.inc = (await createAccount(ctx, { code: '47900', name: 'Sales', qbType: 'income' })).id;
  vendorId = (await createVendor(ctx, { displayName: 'Roles Vendor' })).id;
  customerId = (await createCustomer(ctx, { displayName: 'Roles Customer' })).id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR).catch(() => undefined);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* best effort (Windows) */
  }
});

describe('postings use the account that IS the role, not the number', () => {
  it('a bill credits the Accounts Payable account, not the loan numbered 2000', async () => {
    const bill = await createBill(ctx, { vendorId, date: D('2026-05-01'), lines: [{ accountId: acct.exp, amount: '40.00' }] });
    const [b] = await db.select().from(bills).where(eq(bills.id, bill.id));
    const lines = await linesOf(b.postedEntryId!);
    expect(lines.find((l) => l.credit && Number(l.credit) > 0)?.accountId).toBe(acct.ap);
    expect(lines.some((l) => l.accountId === acct['2000'])).toBe(false);
  });

  it('stock of an item without its own asset account goes to Inventory Asset, not Prepaid Insurance', async () => {
    const item = await createItem(ctx, { name: 'Roles Widget', type: 'inventory' as never, salesPrice: '10.00', incomeAccountId: acct.inc });
    const res = await adjustInventory(ctx, { itemId: item.id, quantityChange: '2', unitCost: '3.00', date: D('2026-05-02') });
    const lines = await linesOf(res.entry!.id);
    expect(lines.find((l) => l.debit && Number(l.debit) > 0)?.accountId).toBe(acct.inv);
    expect(lines.some((l) => l.accountId === acct['1300'])).toBe(false);
  });

  it('selling it relieves Cost of Goods Sold 50000, not Advertising 5000', async () => {
    const [item] = await db.select().from((await import('@/lib/db/schema')).items).where(eq((await import('@/lib/db/schema')).items.name, 'Roles Widget'));
    const inv = await createInvoice(ctx, { customerId, date: D('2026-05-03'), lines: [{ itemId: item.id, quantity: 1, rate: '10.00', taxable: false }] });
    const entryIds = (
      await db
        .select({ id: (await import('@/lib/db/schema')).journalEntries.id })
        .from((await import('@/lib/db/schema')).journalEntries)
        .where(eq((await import('@/lib/db/schema')).journalEntries.companyId, ctx.companyId))
    ).map((r) => r.id);
    const all = (await Promise.all(entryIds.map(linesOf))).flat();
    expect(all.some((l) => l.accountId === acct.cogs && Number(l.debit ?? 0) > 0)).toBe(true);
    expect(all.some((l) => l.accountId === acct['5000'])).toBe(false);
    void inv;
  });

  it('the System Accounts page explains what it found', async () => {
    const rows = await listAccountRoles(ctx);
    const ap = rows.find((r) => r.role === 'accounts_payable')!;
    expect(ap.account?.id).toBe(acct.ap);
    expect(ap.source).toBe('detected');
    expect(ap.notes.join(' ')).toMatch(/2000/);
  });
});

describe('choosing the account for a role', () => {
  it('sales tax posts to the chosen Sales Tax Payable, and the sales tax engine reads it', async () => {
    // 2200 "Sales Tax Payable" exists on the default chart (no balance), so it is the automatic
    // choice; the converted file's 25500 holds the QuickBooks history.
    expect((await resolveSystemAccount(ctx, 'sales_tax_payable')).account?.id).toBe(acct['2200']);
    await setAccountRole(ctx, 'sales_tax_payable', acct.stp);
    const rate = await createTaxRate(ctx, { name: 'Roles 8%', rate: '0.08' });
    const inv = await createInvoice(ctx, {
      customerId,
      date: D('2026-05-04'),
      taxRateId: rate.id,
      lines: [{ accountId: acct.inc, description: 'Taxable', quantity: 1, rate: '100.00', taxable: true }],
    });
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    const lines = await linesOf(row.postedEntryId!);
    expect(lines.find((l) => l.accountId === acct.stp)?.credit).toBe('8.00');
    expect(lines.some((l) => l.accountId === acct['2200'])).toBe(false);
    const taxAccts = (await salesTaxLiabilityAccounts(ctx)).map((a) => a.id);
    expect(taxAccts).toContain(acct.stp);
  });

  it('is refused while the account the role uses now still carries a balance', async () => {
    // 25500 now holds the sales tax above: moving the role away would strand it.
    await expect(setAccountRole(ctx, 'sales_tax_payable', acct['2200'])).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('the refusal points to the merge that works: the other account INTO the role account (review P2)', async () => {
    const err = await setAccountRole(ctx, 'sales_tax_payable', acct['2200']).catch((e) => e);
    expect(err.message).toMatch(/merge the other account INTO "25500 Sales Tax Payable"/);
    // …and Merge Accounts does accept that direction.
    const { mergeAccounts } = await import('./merge');
    const other = (await createAccount(ctx, { code: '25600', name: 'Sales Tax Owed', qbType: 'other_current_liability' })).id;
    await expect(mergeAccounts(ctx, { fromId: other, toId: acct.stp })).resolves.toBeTruthy();
  });

  it('the Payroll preference refuses the account chosen for Sales Tax Payable (review P2)', async () => {
    const { assertPreferenceAccount } = await import('./prefAccounts');
    await expect(assertPreferenceAccount(ctx, acct.stp, 'payroll_liability', 'Payroll liabilities')).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/Sales Tax Payable account/),
    });
  });

  it('refuses an account of the wrong kind', async () => {
    await expect(setAccountRole(ctx, 'accounts_payable', acct.exp)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('payroll liabilities: the choice is the Payroll preference', async () => {
    const pl = (await createAccount(ctx, { code: '24000', name: 'Payroll Liabilities', qbType: 'other_current_liability' })).id;
    await setAccountRole(ctx, 'payroll_liabilities', pl);
    expect((await resolveSystemAccount(ctx, 'payroll_liabilities')).account?.id).toBe(pl);
    const { getPreferences } = await import('./company');
    expect((await getPreferences(ctx)).payrollLiabilityAccountId).toBe(pl);
  });
});

describe('the accounts Ironbooks posts to on its own cannot be made inactive', () => {
  it('Accounts Payable (by role) and Undeposited Funds (by number) refuse deactivation', async () => {
    await expect(deactivateAccount(ctx, acct.ap)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateAccount(ctx, acct['1050'], { isActive: false })).rejects.toMatchObject({ code: 'VALIDATION' });
    const [still] = await db.select().from(accounts).where(and(eq(accounts.id, acct.ap)));
    expect(still.isActive).toBe(true);
  });
  it('an ordinary account can still be made inactive', async () => {
    const spare = (await createAccount(ctx, { code: '64100', name: 'Spare', qbType: 'expense' })).id;
    const row = await deactivateAccount(ctx, spare);
    expect(row.isActive).toBe(false);
  });
});
