/**
 * P1 setup — TESTER re-test round 2. Independent, adversarial checks of fix round 2 (68a33a0):
 * with "Track reimbursed expenses as income" OFF, a billed-back cost is credited back only to an
 * expense-type account (operating expense / COGS); any balance-sheet (or revenue / equity) account
 * falls back to the default income account. Checks:
 *  - inventory part bill line: GL 1300 ties to the inventory valuation, COGS untouched, A/R == total;
 *  - liability, fixed-asset and equity lines are never credited back; income takes the cost;
 *  - preference ON is unchanged: Reimbursed Expenses Income, inventory still ties;
 *  - a mixed invoice (inventory + expense + COGS + asset, markup) posts each account correctly;
 *  - voiding that invoice restores every balance exactly and keeps inventory tied;
 *  - a cost recorded to an expense account that was later made inactive can still be billed back
 *    and the books stay balanced;
 *  - per-company isolation of the preference.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { billLines, customers, expenseLines, users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, updateCompany } from './company';
import { createAccount, deactivateAccount, listAccounts } from './accounts';
import { getInvoice, voidInvoice } from './invoices';
import { createItem } from './items';
import { createExpense } from './expenses';
import { createBill } from './bills';
import { createInvoiceWithBillables } from './billables';
import { inventoryValuation } from './inventory';
import { trialBalance } from './reports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-setup-retest2');
let db: DB;

interface Co {
  ctx: ServiceContext;
  acct: Record<string, string>;
  cust: string;
  vend: string;
}

let seq = 0;
async function mkCompany(name: string): Promise<Co> {
  seq += 1;
  const [user] = await db
    .insert(users)
    .values({ email: `retest2-${seq}@test.local`, name, passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name, ownerId: user.id });
  const ctx: ServiceContext = { db, companyId: company.id, userId: user.id };
  const acct: Record<string, string> = {};
  for (const a of await listAccounts(ctx)) acct[a.code] = a.id;
  const [c] = await db.insert(customers).values({ companyId: company.id, displayName: `${name} client` }).returning();
  const [v] = await db.insert(vendors).values({ companyId: company.id, displayName: `${name} supplier` }).returning();
  return { ctx, acct, cust: c.id, vend: v.id };
}

type TB = Awaited<ReturnType<typeof trialBalance>>;
function net(tb: TB, accountId: string): string {
  const row = tb.rows.find((r) => r.accountId === accountId);
  return (row ? Number(row.debit) - Number(row.credit) : 0).toFixed(2);
}
function delta(after: TB, before: TB, accountId: string): string {
  return (Number(net(after, accountId)) - Number(net(before, accountId))).toFixed(2);
}

async function inventoryPart(co: Co, name: string) {
  return createItem(co.ctx, {
    name,
    type: 'inventory',
    incomeAccountId: co.acct['4000'],
    assetAccountId: co.acct['1300'],
    expenseAccountId: co.acct['5000'],
  });
}

async function billablePartLine(co: Co, itemId: string, qty: number, unitCost: string, date = '2026-04-02') {
  const bill = await createBill(co.ctx, {
    vendorId: co.vend,
    date: new Date(date),
    lines: [{ itemId, quantity: qty, unitCost, customerId: co.cust }],
  });
  const [bl] = await db.select().from(billLines).where(eq(billLines.billId, bill.id));
  return bl.id;
}

async function billableAccountBillLine(co: Co, accountId: string, amount: string) {
  const bill = await createBill(co.ctx, {
    vendorId: co.vend,
    date: new Date('2026-04-02'),
    lines: [{ accountId, amount, description: 'Job cost on bill', customerId: co.cust }],
  });
  const [bl] = await db.select().from(billLines).where(eq(billLines.billId, bill.id));
  return bl.id;
}

async function billableExpenseLine(co: Co, accountId: string, amount: string) {
  const exp = await createExpense(co.ctx, {
    vendorId: co.vend,
    date: new Date('2026-04-03'),
    method: 'cash',
    paymentAccountId: co.acct['1000'],
    lines: [{ accountId, description: 'Job cost', amount, customerId: co.cust }],
  });
  const [el] = await db.select().from(expenseLines).where(eq(expenseLines.expenseId, exp.id));
  return el.id;
}

async function expectInventoryTies(co: Co) {
  const tb = await trialBalance(co.ctx);
  const valuation = await inventoryValuation(co.ctx);
  expect(net(tb, co.acct['1300'])).toBe(Number(valuation.grandTotal).toFixed(2));
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('billed-back costs, tracked as expense (default): only expense/COGS accounts are credited back', () => {
  it('inventory part: Inventory Asset ties to valuation, COGS untouched, income takes cost + markup, A/R == total', async () => {
    const co = await mkCompany('R2 Inventory');
    await updateCompany(co.ctx, { settings: { trackReimbursedAsIncome: false, defaultMarkupPercent: 0 } });
    const part = await inventoryPart(co, 'Valve');
    const bl = await billablePartLine(co, part.id, 3, '25.00');
    const before = await trialBalance(co.ctx);
    expect(net(before, co.acct['1300'])).toBe('75.00');
    const inv = await createInvoiceWithBillables(
      co.ctx,
      { customerId: co.cust, date: new Date('2026-04-05'), lines: [] },
      { billLineIds: [bl], markupPercent: 10 },
    );
    const full = await getInvoice(co.ctx, inv.id);
    expect(Number(full.total).toFixed(2)).toBe('82.50');
    const tb = await trialBalance(co.ctx);
    expect(tb.balanced).toBe(true);
    expect(net(tb, co.acct['1300'])).toBe('75.00');
    expect(delta(tb, before, co.acct['5000'])).toBe('0.00');
    expect(delta(tb, before, co.acct['4000'])).toBe('-82.50');
    expect(delta(tb, before, co.acct['1200'])).toBe('82.50');
    await expectInventoryTies(co);
  });

  it('liability, fixed-asset and equity lines keep their balances; the cost goes to income', async () => {
    const co = await mkCompany('R2 Balance sheet');
    await updateCompany(co.ctx, { settings: { trackReimbursedAsIncome: false, defaultMarkupPercent: 0 } });
    const liab = await createAccount(co.ctx, { code: '2391', name: 'Customer Deposits Held', type: 'liability', subtype: 'other_current_liability' });
    const fixed = await createAccount(co.ctx, { code: '1591', name: 'Job Equipment', type: 'asset', subtype: 'fixed_assets' });
    const eq3 = await createAccount(co.ctx, { code: '3391', name: 'Owner Draws Job', type: 'equity', subtype: 'owners_equity' });
    const l1 = await billableAccountBillLine(co, liab.id, '30.00');
    const l2 = await billableAccountBillLine(co, fixed.id, '200.00');
    const l3 = await billableExpenseLine(co, eq3.id, '15.00');
    const before = await trialBalance(co.ctx);
    await createInvoiceWithBillables(
      co.ctx,
      { customerId: co.cust, date: new Date('2026-04-05'), lines: [] },
      { billLineIds: [l1, l2], expenseLineIds: [l3], markupPercent: 0 },
    );
    const tb = await trialBalance(co.ctx);
    expect(tb.balanced).toBe(true);
    expect(delta(tb, before, liab.id)).toBe('0.00');
    expect(delta(tb, before, fixed.id)).toBe('0.00');
    expect(delta(tb, before, eq3.id)).toBe('0.00');
    expect(net(tb, fixed.id)).toBe('200.00');
    expect(delta(tb, before, co.acct['4000'])).toBe('-245.00');
    expect(delta(tb, before, co.acct['1200'])).toBe('245.00');
  });

  it('a revenue account on a billable line is not "netted back" either; it stays put and default income takes it', async () => {
    const co = await mkCompany('R2 Revenue line');
    await updateCompany(co.ctx, { settings: { trackReimbursedAsIncome: false, defaultMarkupPercent: 0 } });
    const rev = await createAccount(co.ctx, { code: '4391', name: 'Sundry Income', type: 'revenue', subtype: 'other_income' });
    const l = await billableExpenseLine(co, rev.id, '12.00');
    const before = await trialBalance(co.ctx);
    await createInvoiceWithBillables(
      co.ctx,
      { customerId: co.cust, date: new Date('2026-04-05'), lines: [] },
      { expenseLineIds: [l], markupPercent: 0 },
    );
    const tb = await trialBalance(co.ctx);
    expect(tb.balanced).toBe(true);
    expect(delta(tb, before, rev.id)).toBe('0.00');
    expect(delta(tb, before, co.acct['4000'])).toBe('-12.00');
  });

  it('mixed invoice (inventory + expense + COGS + prepaid, 20% markup) posts every account correctly; void restores all', async () => {
    const co = await mkCompany('R2 Mixed');
    await updateCompany(co.ctx, { settings: { trackReimbursedAsIncome: false, defaultMarkupPercent: 0 } });
    const part = await inventoryPart(co, 'Pipe');
    const opex = await createAccount(co.ctx, { code: '6491', name: 'Job Supplies', type: 'expense', subtype: 'operating_expenses' });
    const cogs = await createAccount(co.ctx, { code: '5491', name: 'Subcontract COGS', type: 'expense', subtype: 'cost_of_goods_sold' });
    const prepaid = await createAccount(co.ctx, { code: '1491', name: 'Prepaid Job Costs', type: 'asset', subtype: 'other_current_asset' });
    const a = await billablePartLine(co, part.id, 4, '10.00'); // 40.00
    const b = await billableAccountBillLine(co, opex.id, '33.33');
    const c = await billableExpenseLine(co, cogs.id, '66.67');
    const d = await billableExpenseLine(co, prepaid.id, '20.00');
    const before = await trialBalance(co.ctx);
    const inv = await createInvoiceWithBillables(
      co.ctx,
      { customerId: co.cust, date: new Date('2026-04-06'), lines: [] },
      { billLineIds: [a, b], expenseLineIds: [c, d], markupPercent: 20 },
    );
    // Markups: 8.00 + 6.67 + 13.33 + 4.00 = 32.00; costs 160.00; total 192.00.
    const full = await getInvoice(co.ctx, inv.id);
    expect(Number(full.total).toFixed(2)).toBe('192.00');
    const tb = await trialBalance(co.ctx);
    expect(tb.balanced).toBe(true);
    expect(net(tb, opex.id)).toBe('0.00');
    expect(net(tb, cogs.id)).toBe('0.00');
    expect(net(tb, prepaid.id)).toBe('20.00');
    expect(net(tb, co.acct['1300'])).toBe('40.00');
    expect(delta(tb, before, co.acct['5000'])).toBe('0.00');
    // Income: inventory cost 40 + prepaid cost 20 + all markup 32 = 92.
    expect(delta(tb, before, co.acct['4000'])).toBe('-92.00');
    expect(delta(tb, before, co.acct['1200'])).toBe('192.00');
    await expectInventoryTies(co);

    await voidInvoice(co.ctx, inv.id);
    const after = await trialBalance(co.ctx);
    expect(after.balanced).toBe(true);
    for (const id of [opex.id, cogs.id, prepaid.id, co.acct['1300'], co.acct['4000'], co.acct['1200'], co.acct['5000']]) {
      expect(net(after, id)).toBe(net(before, id));
    }
    await expectInventoryTies(co);
  });

  it('a cost on an expense account that was later made inactive can still be billed back; books stay balanced', async () => {
    const co = await mkCompany('R2 Inactive');
    await updateCompany(co.ctx, { settings: { trackReimbursedAsIncome: false, defaultMarkupPercent: 0 } });
    const opex = await createAccount(co.ctx, { code: '6591', name: 'Old Job Supplies', type: 'expense', subtype: 'operating_expenses' });
    const l = await billableExpenseLine(co, opex.id, '18.00');
    await deactivateAccount(co.ctx, opex.id, { force: true });
    const before = await trialBalance(co.ctx);
    const inv = await createInvoiceWithBillables(
      co.ctx,
      { customerId: co.cust, date: new Date('2026-04-07'), lines: [] },
      { expenseLineIds: [l], markupPercent: 0 },
    );
    expect(Number((await getInvoice(co.ctx, inv.id)).total).toFixed(2)).toBe('18.00');
    const tb = await trialBalance(co.ctx);
    expect(tb.balanced).toBe(true);
    // Either credited back to the (inactive) expense or to income — never anywhere else.
    const exp = Number(delta(tb, before, opex.id));
    const inc = Number(delta(tb, before, co.acct['4000']));
    expect((exp + inc).toFixed(2)).toBe('-18.00');
    expect(delta(tb, before, co.acct['1200'])).toBe('18.00');
  });
});

describe('billed-back costs, tracked as income: unchanged by the fix', () => {
  it('inventory part goes to Reimbursed Expenses Income; Inventory Asset ties; expense lines untouched', async () => {
    const co = await mkCompany('R2 As income');
    await updateCompany(co.ctx, { settings: { trackReimbursedAsIncome: true, defaultMarkupPercent: 0 } });
    const reimb = await createAccount(co.ctx, { code: '4191', name: 'Reimbursed Expenses Income', type: 'revenue', subtype: 'sales' });
    const opex = await createAccount(co.ctx, { code: '6691', name: 'Travel Job', type: 'expense', subtype: 'operating_expenses' });
    const part = await inventoryPart(co, 'Elbow');
    const a = await billablePartLine(co, part.id, 2, '15.00');
    const b = await billableExpenseLine(co, opex.id, '40.00');
    const before = await trialBalance(co.ctx);
    await createInvoiceWithBillables(
      co.ctx,
      { customerId: co.cust, date: new Date('2026-04-08'), lines: [] },
      { billLineIds: [a], expenseLineIds: [b], markupPercent: 0 },
    );
    const tb = await trialBalance(co.ctx);
    expect(tb.balanced).toBe(true);
    expect(delta(tb, before, reimb.id)).toBe('-70.00');
    expect(delta(tb, before, opex.id)).toBe('0.00');
    expect(net(tb, co.acct['1300'])).toBe('30.00');
    expect(delta(tb, before, co.acct['4000'])).toBe('0.00');
    await expectInventoryTies(co);
  });
});

describe('isolation', () => {
  it("one company's preference does not change another company's routing", async () => {
    const x = await mkCompany('R2 Iso X');
    const y = await mkCompany('R2 Iso Y');
    await updateCompany(x.ctx, { settings: { trackReimbursedAsIncome: false, defaultMarkupPercent: 0 } });
    await updateCompany(y.ctx, { settings: { trackReimbursedAsIncome: true, defaultMarkupPercent: 50 } });
    const opex = await createAccount(x.ctx, { code: '6791', name: 'Iso Supplies', type: 'expense', subtype: 'operating_expenses' });
    const l = await billableExpenseLine(x, opex.id, '10.00');
    const before = await trialBalance(x.ctx);
    const inv = await createInvoiceWithBillables(
      x.ctx,
      { customerId: x.cust, date: new Date('2026-04-09'), lines: [] },
      { expenseLineIds: [l] },
    );
    // X's own default markup (0) applies, and the cost nets X's expense to zero.
    expect(Number((await getInvoice(x.ctx, inv.id)).total).toFixed(2)).toBe('10.00');
    const tb = await trialBalance(x.ctx);
    expect(tb.balanced).toBe(true);
    expect(net(tb, opex.id)).toBe('0.00');
    expect(delta(tb, before, x.acct['4000'])).toBe('0.00');
    // Y is untouched.
    expect((await trialBalance(y.ctx)).balanced).toBe(true);
  });
});
