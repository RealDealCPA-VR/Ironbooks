/**
 * Command bar executor (lib/services/commandBar.ts) against a seeded PGlite company:
 * prefilled forms (names/items/accounts matched, nothing written), ambiguity → choices,
 * spend/income answers computed from the GL, filtered unpaid-bill reports, actions, navigation,
 * permission filtering, company scoping of user-picked ids, and the AI fallback (local model,
 * zod-validated intent run by the same executor; cloud model only with opt-in + redaction).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { count, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import {
  accounts,
  bankAccounts,
  bills as billsTable,
  customers,
  estimates,
  expenses as expensesTable,
  invoices as invoicesTable,
  items,
  journalEntries,
  salesReceipts,
  users,
  vendors,
} from '@/lib/db/schema';
import { normalizeGrant, type EffectiveAccess, type PermissionGrant } from '@/lib/permissions/model';
import { setHostLookup } from '@/lib/net/tailnetVerify';
import type { FetchLike } from '@/lib/ai/providers';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { createExpense } from './expenses';
import { createBill } from './bills';
import { createInvoice } from './invoices';
import { profitAndLoss } from './reports';
import { getPublicSettings, updateSettings } from './aiSettings';
import { setNetworkPolicy } from './networkPolicy';
import { runCommand, type CommandResult } from './commandBar';

const TEST_ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-command-bar');
const TEST_DIR = path.join(TEST_ROOT, 'data');
const TODAY = new Date(Date.UTC(2026, 9, 15, 15, 0, 0));
const D = (s: string) => new Date(`${s}T12:00:00Z`);

let db: DB;
let ctx: ServiceContext;
let otherCtx: ServiceContext;
const acct: Record<string, string> = {};
const cust: Record<string, string> = {};
const vend: Record<string, string> = {};
const item: Record<string, string> = {};
let checkingBank: string;
let otherCompanyCustomer: string;

const run = (text: string, extra: Partial<Parameters<typeof runCommand>[1]> = {}, c: ServiceContext = ctx, opts: Parameters<typeof runCommand>[2] = {}) =>
  runCommand(c, { text, ...extra }, { today: TODAY, ...opts });

function accessWith(grant: PermissionGrant): EffectiveAccess {
  return {
    roleKeys: ['custom'],
    permissions: normalizeGrant(grant),
    flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false },
    isAdmin: false,
  };
}

async function writeCounts() {
  const n = async (t: typeof invoicesTable | typeof billsTable | typeof expensesTable | typeof estimates | typeof salesReceipts | typeof journalEntries) =>
    (await db.select({ n: count() }).from(t))[0].n;
  return {
    invoices: await n(invoicesTable),
    bills: await n(billsTable),
    expenses: await n(expensesTable),
    estimates: await n(estimates),
    receipts: await n(salesReceipts),
    entries: await n(journalEntries),
  };
}

function expectType<T extends CommandResult['type']>(r: CommandResult, t: T): Extract<CommandResult, { type: T }> {
  expect(r.type, JSON.stringify(r)).toBe(t);
  return r as Extract<CommandResult, { type: T }>;
}

beforeAll(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  setHostLookup(async (h) => (h.endsWith('.tail1234.ts.net') ? ['100.101.1.5'] : []));
  process.env.BKA_AUTH_SECRET = 'test-cmdbar-secret-0123456789abcdef';
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'cmdbar@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Command Bar Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const other = await createCompany(db, { name: 'Other Co', ownerId: user.id });
  otherCtx = { db, companyId: other.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))) acct[a.code] = a.id;

  acct.fuel = (await createAccount(ctx, { code: '6810', name: 'Fuel', type: 'expense', subtype: 'operating_expenses' })).id;
  acct.travel = (await createAccount(ctx, { code: '6850', name: 'Travel', type: 'expense', subtype: 'operating_expenses' })).id;
  acct.travelMeals = (await createAccount(ctx, { code: '6851', name: 'Travel Meals', type: 'expense', subtype: 'operating_expenses', parentId: acct.travel } as never)).id;
  acct.amex = (await createAccount(ctx, { code: '2150', name: 'Amex', type: 'liability', subtype: 'credit_card' })).id;

  checkingBank = (
    await db.insert(bankAccounts).values({ companyId: ctx.companyId, accountId: acct['1000'], bankName: 'First Bank', accountNumber: '4321' }).returning()
  )[0].id;

  const cs = await db
    .insert(customers)
    .values([
      { companyId: ctx.companyId, displayName: 'Acme Corporation' },
      { companyId: ctx.companyId, displayName: 'Acme Industries' },
      { companyId: ctx.companyId, displayName: 'Bayside Bakery' },
    ])
    .returning();
  [cust.acmeCorp, cust.acmeInd, cust.bayside] = cs.map((c) => c.id);
  otherCompanyCustomer = (await db.insert(customers).values({ companyId: otherCtx.companyId, displayName: 'Acme Corporation' }).returning())[0].id;

  const vs = await db
    .insert(vendors)
    .values([
      { companyId: ctx.companyId, displayName: 'Staples' },
      { companyId: ctx.companyId, displayName: 'Shell Oil' },
      { companyId: ctx.companyId, displayName: 'Office Depot', defaultExpenseAccountId: acct['6300'] },
      { companyId: ctx.companyId, displayName: 'Chevron' },
    ])
    .returning();
  [vend.staples, vend.shell, vend.depot, vend.chevron] = vs.map((v) => v.id);

  const its = await db
    .insert(items)
    .values([
      { companyId: ctx.companyId, name: 'Consulting', type: 'service', salesPrice: '150.00', incomeAccountId: acct['4100'], taxable: false },
      { companyId: ctx.companyId, name: 'Widget', type: 'non_inventory', salesPrice: '12.00', purchaseCost: '5.00', incomeAccountId: acct['4000'], expenseAccountId: acct['5000'] },
      { companyId: ctx.companyId, name: 'Printer Paper', type: 'non_inventory', purchaseCost: '30.00', expenseAccountId: acct['6300'], incomeAccountId: acct['4000'] },
    ])
    .returning();
  [item.consulting, item.widget, item.paper] = its.map((i) => i.id);

  // GL history. Fuel: Q3 = 40 + 60 + 25.50 (Chevron) = 125.50; Sep with Shell = 60; Oct = 99.
  const fuel = async (vendorId: string, date: string, amount: string) =>
    createExpense(ctx, { vendorId, date: D(date), method: 'cash', paymentAccountId: acct['1000'], lines: [{ accountId: acct.fuel, amount }] });
  await fuel(vend.shell, '2026-06-30', '11.00');
  await fuel(vend.shell, '2026-07-10', '40.00');
  await fuel(vend.shell, '2026-09-12', '60.00');
  await fuel(vend.chevron, '2026-08-01', '25.50');
  await fuel(vend.shell, '2026-10-02', '99.00');
  // Travel (parent) + Travel Meals (sub-account).
  await createExpense(ctx, {
    payeeName: 'Airline',
    date: D('2026-03-01'),
    method: 'cash',
    paymentAccountId: acct['1000'],
    lines: [
      { accountId: acct.travel, amount: '300.00' },
      { accountId: acct.travelMeals, amount: '45.25' },
    ],
  });
  // Unpaid bills: one 106 days past due, one 15 days past due.
  await createBill(ctx, { vendorId: vend.staples, date: D('2026-06-01'), dueDate: D('2026-07-01'), lines: [{ accountId: acct['6300'], amount: '300.00' }] });
  await createBill(ctx, { vendorId: vend.depot, date: D('2026-09-01'), dueDate: D('2026-09-30'), lines: [{ accountId: acct['6300'], amount: '100.00' }] });
  // Income from Acme Corporation.
  await createInvoice(ctx, { customerId: cust.acmeCorp, date: D('2026-05-05'), lines: [{ itemId: item.consulting, description: 'Consulting', quantity: 4, rate: '150.00' }] } as never);
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  delete process.env.BKA_AUTH_SECRET;
});

// ---------------------------------------------------------------------------
// Prefilled forms
// ---------------------------------------------------------------------------

describe('create commands open a prefilled form and write nothing', () => {
  it('invoice Acme Corporation 3 hours consulting', async () => {
    const before = await writeCounts();
    const r = expectType(await run('invoice Acme Corporation 3 hours consulting'), 'prefill');
    expect(r.source).toBe('grammar');
    expect(r.href).toBe('/invoices');
    expect(r.prefill).toMatchObject({
      kind: 'invoice',
      customerId: cust.acmeCorp,
      lines: [{ itemId: item.consulting, itemName: 'Consulting', quantity: '3', rate: '150', taxable: false }],
    });
    expect(r.prefill.lines[0].rateFromUser).toBeUndefined();
    expect(r.summary).toContain('$450.00');
    expect(r.summary).toMatch(/Nothing is saved/);
    expect(await writeCounts()).toEqual(before);
  });

  it('ambiguous customer → asks to choose; the pick re-runs to a prefill', async () => {
    const r = expectType(await run('invoice Acme 3 hours consulting'), 'choose');
    expect(r.question).toMatch(/Which customer/);
    expect(r.options.map((o) => o.label).sort()).toEqual(['Acme Corporation', 'Acme Industries']);
    const pick = r.options.find((o) => o.label === 'Acme Industries')!;
    const again = expectType(await runCommand(ctx, { intent: pick.intent, hints: pick.hints }, { today: TODAY }), 'prefill');
    expect(again.source).toBe('choice');
    expect(again.prefill.customerId).toBe(cust.acmeInd);
    expect(again.prefill.lines[0]).toMatchObject({ itemId: item.consulting, quantity: '3' });
  });

  it('works out where the customer name ends ("Acme Corporation consulting 3 hours")', async () => {
    const r = expectType(await run('invoice Acme Corporation consulting 3 hours'), 'prefill');
    expect(r.prefill.customerId).toBe(cust.acmeCorp);
    expect(r.prefill.lines[0]).toMatchObject({ itemId: item.consulting, quantity: '3', rate: '150' });
  });

  it('typed price wins and rate is derived from a typed total', async () => {
    const r = expectType(await run('invoice Bayside 3 hours consulting for $360'), 'prefill');
    expect(r.prefill.lines[0]).toMatchObject({ quantity: '3', rate: '120', rateFromUser: true });
  });

  it('unknown item → description kept and a note asks to pick the item', async () => {
    const r = expectType(await run('invoice Bayside 2 hours gardening at 40'), 'prefill');
    expect(r.prefill.lines[0]).toMatchObject({ description: 'gardening', quantity: '2', rate: '40' });
    expect(r.prefill.lines[0].itemId).toBeUndefined();
    expect(r.notes.join(' ')).toMatch(/No item matches “gardening”/);
  });

  it('bill from Staples 120 office supplies', async () => {
    const before = await writeCounts();
    const r = expectType(await run('bill from Staples 120 office supplies'), 'prefill');
    expect(r.href).toBe('/bills');
    expect(r.prefill).toMatchObject({ kind: 'bill', vendorId: vend.staples, lines: [{ accountId: acct['6300'], amount: '120.00', description: 'office supplies' }] });
    expect(await writeCounts()).toEqual(before);
  });

  it("a bill with no category uses the vendor's usual account", async () => {
    const r = expectType(await run('bill from Office Depot $80'), 'prefill');
    expect(r.prefill.lines[0]).toMatchObject({ accountId: acct['6300'], amount: '80.00' });
    expect(r.notes.join(' ')).toMatch(/usual account/);
  });

  it('a purchase line can be an item (qty × cost)', async () => {
    const r = expectType(await run('bill from Staples 5 boxes printer paper'), 'prefill');
    expect(r.prefill.lines[0]).toMatchObject({ itemId: item.paper, quantity: '5', rate: '30', amount: '150.00' });
  });

  it('a customer typed into "bill" → asks whether an invoice was meant', async () => {
    const r = expectType(await run('bill Bayside Bakery 50 widgets'), 'choose');
    expect(r.question).toMatch(/is a customer/);
    const flip = r.options.find((o) => o.label.startsWith('Create an invoice for Bayside'))!;
    const inv = expectType(await runCommand(ctx, { intent: flip.intent, hints: flip.hints }, { today: TODAY }), 'prefill');
    expect(inv.form).toBe('invoice');
    expect(inv.prefill.customerId).toBe(cust.bayside);
    expect(inv.prefill.lines[0]).toMatchObject({ itemId: item.widget, quantity: '50', rate: '12' });
  });

  it('check to Shell $45.20 fuel with Amex', async () => {
    const r = expectType(await run('check to Shell $45.20 fuel with Amex'), 'prefill');
    expect(r.prefill).toMatchObject({
      kind: 'expense',
      vendorId: vend.shell,
      paymentAccountId: acct.amex,
      lines: [{ accountId: acct.fuel, amount: '45.20' }],
    });
  });

  it('an unknown payee on a check becomes a one-time payee', async () => {
    const r = expectType(await run('spent $23 on travel meals at Corner Cafe'), 'prefill');
    expect(r.prefill).toMatchObject({ kind: 'expense', payeeName: 'Corner Cafe', lines: [{ accountId: acct.travelMeals, amount: '23.00' }] });
    expect(r.prefill.vendorId).toBeUndefined();
  });

  it('estimate and sales receipt', async () => {
    const est = expectType(await run('quote Acme Corporation 10 widgets at $11'), 'prefill');
    expect(est.prefill).toMatchObject({ kind: 'estimate', customerId: cust.acmeCorp, lines: [{ itemId: item.widget, quantity: '10', rate: '11', rateFromUser: true }] });
    const sr = expectType(await run('sold 2 widgets to Bayside Bakery'), 'prefill');
    expect(sr.href).toBe('/sales-receipts');
    expect(sr.prefill).toMatchObject({ kind: 'sales_receipt', customerId: cust.bayside, lines: [{ itemId: item.widget, quantity: '2', rate: '12' }] });
  });
});

// ---------------------------------------------------------------------------
// Answers from the GL
// ---------------------------------------------------------------------------

describe('spend / income questions are answered from the general ledger', () => {
  it('what did we spend on fuel in Q3', async () => {
    const r = expectType(await run('what did we spend on fuel in Q3'), 'answer');
    expect(r.amount).toBe('125.50');
    expect(r.range).toMatchObject({ from: '2026-07-01', to: '2026-09-30' });
    expect(r.answer).toContain('$125.50');
    expect(r.answer).toContain('Fuel');
    expect(r.href).toBe(`/reports/std/transaction-detail-by-account?from=2026-07-01&to=2026-09-30&accountId=${acct.fuel}`);
  });

  it('by vendor: how much did we spend at Shell last month', async () => {
    const r = expectType(await run('how much did we spend at Shell last month?'), 'answer');
    expect(r.amount).toBe('60.00');
    expect(r.href).toContain(`vendorId=${vend.shell}`);
    expect(r.breakdown).toEqual([{ label: 'Fuel', amount: '60.00' }]);
  });

  it('a parent account includes its sub-accounts', async () => {
    const r = expectType(await run('what did we spend on travel this year'), 'answer');
    expect(r.amount).toBe('345.25');
    expect(r.breakdown.map((b) => b.label).sort()).toEqual(['Travel', 'Travel Meals']);
  });

  it('total spending matches the Profit & Loss', async () => {
    const r = expectType(await run('how much did we spend in 2026'), 'answer');
    const pl = await profitAndLoss(ctx, { from: D('2026-01-01'), to: new Date('2026-12-31T23:59:59.999Z') });
    expect(r.amount).toBe(pl.totalExpenses);
    expect(r.href).toBe('/reports/profit-loss?from=2026-01-01&to=2026-12-31');
  });

  it('YTD stops at today', async () => {
    const ytd = expectType(await run('fuel expenses ytd'), 'answer');
    expect(ytd.amount).toBe('235.50');
    const q4 = expectType(await run('fuel spending this quarter'), 'answer');
    expect(q4.amount).toBe('99.00');
  });

  it('income from a customer', async () => {
    const r = expectType(await run('how much did we make from Acme Corporation this year'), 'answer');
    expect(r.amount).toBe('600.00');
    expect(r.href).toContain(`customerId=${cust.acmeCorp}`);
  });

  it('an account and a vendor with similar names → asks which one', async () => {
    const r = expectType(await run('what did we spend on office this year'), 'choose');
    const labels = r.options.map((o) => o.label);
    expect(labels).toEqual(expect.arrayContaining(['Spending in the account Office Supplies', 'Everything paid to vendor Office Depot']));
    const vendorPick = r.options.find((o) => o.label.includes('Office Depot'))!;
    const a = expectType(await runCommand(ctx, { intent: vendorPick.intent, hints: vendorPick.hints }, { today: TODAY }), 'answer');
    expect(a.amount).toBe('100.00');
  });

  it('an unknown subject offers the total instead', async () => {
    const r = expectType(await run('what did we spend on unicorns in Q3'), 'choose');
    expect(r.options).toHaveLength(1);
    const all = expectType(await runCommand(ctx, { intent: r.options[0].intent, hints: r.options[0].hints }, { today: TODAY }), 'answer');
    expect(Number(all.amount)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Reports, actions, navigation
// ---------------------------------------------------------------------------

describe('reports, actions and navigation', () => {
  it('show unpaid bills over 60 days', async () => {
    const r = expectType(await run('show unpaid bills over 60 days'), 'navigate');
    expect(r.href).toBe('/reports/std/unpaid-bills-detail?overDays=60');
    expect(r.summary).toBe('1 unpaid bill more than 60 days past due, $300.00 in total.');
    const all = expectType(await run('unpaid bills'), 'navigate');
    expect(all.summary).toBe('2 unpaid bills, $400.00 in total.');
    const staples = expectType(await run('open bills from Staples'), 'navigate');
    expect(staples.href).toBe(`/reports/std/unpaid-bills-detail?vendorId=${vend.staples}`);
  });

  it('unpaid invoices for a customer', async () => {
    const r = expectType(await run('unpaid invoices for Acme Corporation'), 'navigate');
    expect(r.href).toBe(`/reports/std/open-invoices?customerId=${cust.acmeCorp}`);
    expect(r.summary).toMatch(/^1 unpaid invoice for Acme Corporation, \$600\.00 in total\.$/);
  });

  it('reconcile checking → the Reconcile page with the account picked', async () => {
    const r = expectType(await run('reconcile checking'), 'prefill');
    expect(r.prefill).toMatchObject({ kind: 'reconcile', bankAccountId: checkingBank });
    expect(r.href).toBe('/reconcile');
    const none = expectType(await run('reconcile savings'), 'navigate');
    expect(none.href).toBe('/reconcile');
    expect(none.notes?.[0]).toMatch(/No bank account matches/);
  });

  it('actions and pages', async () => {
    expect(expectType(await run('pay bills'), 'navigate').href).toBe('/pay-bills');
    expect(expectType(await run('record deposit'), 'navigate').href).toBe('/deposits?new=1');
    const pay = expectType(await run('receive payment from Bayside'), 'prefill');
    expect(pay.prefill).toMatchObject({ kind: 'payment', customerId: cust.bayside });
    expect(expectType(await run('go to chart of accounts'), 'navigate').href).toBe('/accounts');
    expect(expectType(await run('go to p&l'), 'navigate').href).toBe('/reports/profit-loss');
  });

  it('unrecognized text without AI → examples, AI not available', async () => {
    const r = expectType(await run('purple monkey dishwasher', { allowAi: true }), 'unknown');
    expect(r.aiAvailable).toBe(false);
    expect(r.examples.length).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------------------
// Permissions & scoping
// ---------------------------------------------------------------------------

describe('permissions and company scoping', () => {
  it('a view-only role cannot get prefilled forms or financial answers', async () => {
    const viewer = { ...ctx, access: accessWith({ customers: ['view'], vendors: ['view'], reports_purchases: ['view'] }) };
    expect(expectType(await run('invoice Acme Corporation 3 hours consulting', {}, viewer), 'denied').message).toMatch(/can't create an invoice/);
    expectType(await run('what did we spend on fuel in Q3', {}, viewer), 'denied');
    expectType(await run('reconcile checking', {}, viewer), 'denied');
    // …but may see unpaid bills (reports_purchases: view).
    expectType(await run('unpaid bills over 60 days', {}, viewer), 'navigate');
    expectType(await run('unpaid invoices', {}, viewer), 'denied');
  });

  it('navigation only reaches pages the role may open', async () => {
    const clerk = { ...ctx, access: accessWith({ customers: ['view', 'create'] }) };
    expect(expectType(await run('go to invoices', {}, clerk), 'navigate').href).toBe('/invoices');
    expectType(await run('go to payroll', {}, clerk), 'unknown');
    expectType(await run('go to chart of accounts', {}, clerk), 'unknown');
  });

  it('the bill → invoice suggestion is not offered without invoice rights', async () => {
    const apClerk = { ...ctx, access: accessWith({ vendors: ['view', 'create'] }) };
    const r = expectType(await run('bill Bayside Bakery 50 widgets', {}, apClerk), 'prefill');
    expect(r.prefill.vendorId).toBeUndefined();
    expect(r.notes.join(' ')).toMatch(/No vendor matches/);
  });

  it('ids picked by the user must belong to the company', async () => {
    const intent = { kind: 'create' as const, form: 'invoice' as const, party: 'Acme', lines: [] };
    await expect(runCommand(ctx, { intent, hints: { partyId: otherCompanyCustomer } }, { today: TODAY })).rejects.toBeInstanceOf(ServiceError);
    await expect(
      runCommand(ctx, { intent: { kind: 'question', measure: 'spend', subject: 'x' }, hints: { subjectAccountId: otherCompanyCustomer } }, { today: TODAY }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it("another company's names are never matched", async () => {
    const r = expectType(await run('invoice Acme Corporation 1 hour consulting', {}, otherCtx), 'prefill');
    expect(r.prefill.customerId).toBe(otherCompanyCustomer);
    expect(r.prefill.lines[0].itemId).toBeUndefined(); // Consulting is an item of the first company only
  });
});

// ---------------------------------------------------------------------------
// AI fallback
// ---------------------------------------------------------------------------

function ollama(reply: (body: { messages: { content: string }[] }) => string) {
  const calls: { url: string; body: { messages: { content: string }[] } }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:14b' }] }), { status: 200 });
    return new Response(JSON.stringify({ model: 'qwen2.5:14b', message: { role: 'assistant', content: reply(body) } }), { status: 200 });
  };
  return { fetch, calls };
}

describe('AI fallback (only when configured; same executor; never writes)', () => {
  beforeAll(async () => {
    await updateSettings(ctx, {
      providers: [{ kind: 'ollama', label: 'GPU box', baseUrl: 'http://gpu-box.tail1234.ts.net:11434', model: 'qwen2.5:14b', enabled: true }],
    });
  });

  it('the grammar runs first — the model is not called for commands it understands', async () => {
    const m = ollama(() => '{"intent":null}');
    const r = await run('bill from Staples 120 office supplies', { allowAi: true }, ctx, { deps: { fetch: m.fetch } });
    expect(r.source).toBe('grammar');
    expect(m.calls).toHaveLength(0);
  });

  it('fuzzy text → structured intent → same deterministic executor', async () => {
    const before = await writeCounts();
    const m = ollama(() =>
      JSON.stringify({ intent: { kind: 'create', form: 'bill', party: 'Staples', lines: [{ text: 'office supplies', amount: 75 }] } }),
    );
    const r = await run('staples sent us something for paper, like seventy five bucks', { allowAi: true }, ctx, { deps: { fetch: m.fetch } });
    const p = expectType(r, 'prefill');
    expect(p.source).toBe('ai');
    expect(p.ai).toMatchObject({ locality: 'local', redacted: false });
    expect(p.prefill).toMatchObject({ kind: 'bill', vendorId: vend.staples, lines: [{ accountId: acct['6300'], amount: '75.00' }] });
    expect(m.calls.filter((c) => c.url.endsWith('/api/chat'))).toHaveLength(1);
    expect(await writeCounts()).toEqual(before);
  });

  it('without allowAi the model is never asked', async () => {
    const m = ollama(() => '{"intent":null}');
    const r = expectType(await run('staples sent us something', {}, ctx, { deps: { fetch: m.fetch } }), 'unknown');
    expect(r.aiAvailable).toBe(true);
    expect(m.calls).toHaveLength(0);
  });

  it('invalid model output is rejected by the zod schema (after one repair turn)', async () => {
    const m = ollama(() => JSON.stringify({ intent: { kind: 'post_journal_entry', debit: 100 } }));
    const r = expectType(await run('make the books balance somehow', { allowAi: true }, ctx, { deps: { fetch: m.fetch }, retries: 0 }), 'unknown');
    expect(r.message).toMatch(/didn't help/);
    expect(m.calls.filter((c) => c.url.endsWith('/api/chat'))).toHaveLength(2);
  });

  it('cloud models: blocked by the network policy, otherwise redacted and restored', async () => {
    const cur = await getPublicSettings(ctx);
    await updateSettings(ctx, {
      cloudEnabled: true,
      taskPolicies: { assistant: 'cloud-only' },
      providers: [
        ...cur.providers.map((p) => ({ id: p.id, kind: p.kind, label: p.label, baseUrl: p.baseUrl, model: p.model, enabled: false })),
        { kind: 'anthropic', label: 'Claude', model: '', apiKey: 'sk-ant-test', enabled: true },
      ],
    });
    const sent: string[] = [];
    const fakeClient = {
      messages: {
        create: async (body: { messages: { content: string }[] }) => {
          sent.push(JSON.stringify(body));
          const user = body.messages[body.messages.length - 1].content;
          const placeholder = /\[CUSTOMER_\d+\]/.exec(user)?.[0] ?? 'nobody';
          return {
            content: [{ type: 'text', text: JSON.stringify({ intent: { kind: 'create', form: 'invoice', party: placeholder, lines: [{ text: 'consulting', quantity: 2 }] } }) }],
          };
        },
      },
      models: { list: async () => ({ data: [] }) },
    };
    const text = 'Bayside Bakery wants us to charge them for a couple hours of consulting';
    const blocked = await run(text, { allowAi: true }, ctx, { deps: { anthropicFactory: () => fakeClient as never }, retries: 0 });
    expect(blocked.type).toBe('unknown');
    expect(sent).toHaveLength(0);

    await setNetworkPolicy(ctx, { mode: 'allow-cloud', cloudOptIn: { ai: true } });
    const r = await run(text, { allowAi: true }, ctx, { deps: { anthropicFactory: () => fakeClient as never }, retries: 0 });
    await setNetworkPolicy(ctx, { mode: 'tailnet-only' });
    const p = expectType(r, 'prefill');
    expect(p.ai).toMatchObject({ locality: 'cloud', redacted: true });
    expect(p.prefill).toMatchObject({ kind: 'invoice', customerId: cust.bayside, lines: [{ itemId: item.consulting, quantity: '2' }] });
    expect(sent.length).toBeGreaterThan(0);
    for (const wire of sent) expect(wire).not.toContain('Bayside Bakery');
    await updateSettings(ctx, { cloudEnabled: false, taskPolicies: { assistant: 'local-only' } });
  });
});
