/**
 * Team salesar, sub-builder "billing":
 *  B13 Billing Rate Levels price billable time on EVERY billing path (Time/Costs list on the
 *      invoice form, Create Invoice from Billable Time, the Income Tracker): a rate typed on the
 *      time entry > the person's billing rate level (custom rate for the service item, else the
 *      level's fixed rate; a custom level without that item falls back) > the item's sales price.
 *  C6  Billing Groups (service + routes), Batch Invoicing due dates from the Terms list entry.
 *  C9  Income Tracker unbilled time & costs, per-row actions, Collections Center actions.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, billingGroupMembers, customers, entityNotes, invoiceLines, items, todos, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer, deactivateCustomer } from './customers';
import { createEmployee } from './payroll';
import { createTimeEntry, billTimeToInvoice } from './timeTracking';
import { createInvoiceWithBillables, listUnbilled } from './billables';
import { getInvoice } from './invoices';
import { incomeTracker } from './incomeTracker';
import { assignBillingRateLevel, createBillingRateLevel, updateBillingRateLevel } from './lists/billingRates';
import { createBatchInvoices } from './batchInvoicing';
import { createEntry, listEntries, updateEntry } from './lists/simpleLists';
import { auditLogs, billingGroups, billLines, collectionNotes, companies } from '@/lib/db/schema';
import { createVendor } from './vendors';
import { createBill } from './bills';
import { createInvoice } from './invoices';
import { collectionsCenter, runTrackerAction } from './incomeTracker';
import { collectionLetter, emailCollectionReminder, recordCollectionContact } from './collections';
import {
  createBillingGroup,
  deleteBillingGroup,
  getBillingGroup,
  listBillingGroups,
  updateBillingGroup,
} from './billingGroups';
import { mergeCustomers } from './merge';
import { runCleanup } from './lists/cleanup';

function req(url: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  const u = new URL(`http://localhost${url}`);
  return Object.assign(
    new Request(u, body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    { nextUrl: u },
  ) as never;
}

let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));

// The app's email flow (salesForms) — real by default (no SMTP in tests: "Email is not set up
// yet"); `mail.on` stands in a working mail server so the Collections Center path can be checked.
const mail = vi.hoisted(() => ({ on: false, sent: [] as Array<{ kind: string; id: string; to?: string | null }> }));
vi.mock('./salesForms', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./salesForms')>();
  return {
    ...orig,
    emailSalesForm: async (...args: Parameters<typeof orig.emailSalesForm>) => {
      if (!mail.on) return orig.emailSalesForm(...args);
      const [, kind, id, to] = args;
      mail.sent.push({ kind, id, to });
      return { ok: true as const, to: to || 'ap@client.test' };
    },
    emailCustomerStatement: async (...args: Parameters<typeof orig.emailCustomerStatement>) => {
      if (!mail.on) return orig.emailCustomerStatement(...args);
      const [, customerId, opts] = args;
      mail.sent.push({ kind: 'statement', id: customerId, to: opts?.email });
      return { ok: true as const, to: opts?.email || 'ap@client.test' };
    },
  };
});
import { GET as groupsGET, POST as groupsPOST } from '@/app/api/billing-groups/route';
import { DELETE as groupDELETE, PATCH as groupPATCH } from '@/app/api/billing-groups/[id]/route';
import { POST as contactsPOST } from '@/app/api/collections/contacts/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-salesar-billing');
let db: DB;
let userId: string;
let ctx: ServiceContext;
let acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ymd = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString().slice(0, 10) : null);

async function svcItem(name: string, price: string) {
  const [it] = await db
    .insert(items)
    .values({ companyId: ctx.companyId, name: `${name} ${seq}`, type: 'service' as never, salesPrice: price, incomeAccountId: acct['4000'] })
    .returning();
  return it.id;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'salesar-billing@test.local', name: 'Salesar', passwordHash: 'x' }).returning();
  userId = u.id;
});

beforeEach(async () => {
  seq += 1;
  const company = await createCompany(db, { name: `Salesar Billing ${seq}`, ownerId: userId });
  ctx = { db, companyId: company.id, userId };
  routeCtx = ctx;
  acct = {};
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold a handle; the next run wipes it. */
  }
});

// ---------------------------------------------------------------------------
// B13
// ---------------------------------------------------------------------------

/** Ada (fixed "Senior" $95/h), Bob (custom "Partner": Consulting $140/h), five time entries. */
async function rateFixture() {
  const cust = (await createCustomer(ctx, { displayName: `Client ${seq}` })).id;
  const consult = await svcItem('Consulting', '120.00');
  const design = await svcItem('Design', '60.00');
  const senior = await createBillingRateLevel(ctx, { name: `Senior ${seq}`, type: 'fixed_rate', fixedRate: '95' });
  const partner = await createBillingRateLevel(ctx, { name: `Partner ${seq}`, type: 'custom', items: [{ itemId: consult, rate: '140' }] });
  const ada = await createEmployee(ctx, { firstName: 'Ada', lastName: `L${seq}`, payType: 'hourly', payRate: '40' } as never);
  const bob = await createEmployee(ctx, { firstName: 'Bob', lastName: `B${seq}`, payType: 'hourly', payRate: '40' } as never);
  await assignBillingRateLevel(ctx, { employeeId: ada.id }, senior.id);
  await assignBillingRateLevel(ctx, { employeeId: bob.id }, partner.id);
  const t = async (employeeId: string | null, serviceItemId: string, hours: string, date: string, rate?: string) =>
    (await createTimeEntry(ctx, { customerId: cust, employeeId, serviceItemId, hours, date: d(date), billable: true, rate: rate ?? null })).id;
  const t1 = await t(ada.id, consult, '2', '2026-03-02'); // level fixed rate 95
  const t2 = await t(ada.id, consult, '1', '2026-03-03', '150'); // typed rate wins
  const t3 = await t(bob.id, consult, '1.5', '2026-03-04'); // custom level rate 140
  const t4 = await t(bob.id, design, '1', '2026-03-05'); // custom level without Design: item price 60
  const t5 = await t(null, design, '2', '2026-03-06'); // nobody: item price 60
  return { cust, consult, design, senior, partner, ada, bob, t1, t2, t3, t4, t5 };
}

describe('B13. Billing rate levels are applied when time is billed', () => {
  it('the Time/Costs list (GET /api/billables) prices time with the level and says where the rate came from', async () => {
    const f = await rateFixture();
    const { time } = await listUnbilled(ctx, f.cust);
    const by = new Map(time.map((x) => [x.id, x]));
    expect(by.get(f.t1)).toMatchObject({ rate: '95.00', amount: '190.00', rateSource: 'billing_rate_level', rateLevelName: `Senior ${seq}` });
    expect(by.get(f.t2)).toMatchObject({ rate: '150.00', amount: '150.00', rateSource: 'entry' });
    expect(by.get(f.t3)).toMatchObject({ rate: '140.00', amount: '210.00', rateSource: 'billing_rate_level', rateLevelName: `Partner ${seq}` });
    expect(by.get(f.t4)).toMatchObject({ rate: '60.00', amount: '60.00', rateSource: 'item_price' });
    expect(by.get(f.t5)).toMatchObject({ rate: '60.00', amount: '120.00', rateSource: 'item_price' });
  });

  it('Create Invoice from Billable Time bills at the level rates', async () => {
    const f = await rateFixture();
    const inv = await billTimeToInvoice(ctx, { customerId: f.cust });
    expect(inv.total).toBe('730.00'); // 190 + 150 + 210 + 60 + 120
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    const rates = lines.map((l) => Number(l.rate)).sort((a, b) => a - b);
    expect(rates).toEqual([60, 60, 95, 140, 150]);
  });

  it('an invoice with selected billable time bills it at the level rates', async () => {
    const f = await rateFixture();
    const inv = await createInvoiceWithBillables(ctx, { customerId: f.cust, date: d('2026-03-10'), lines: [] }, { timeEntryIds: [f.t1, f.t3] });
    expect(inv.total).toBe('400.00');
    const full = await getInvoice(ctx, inv.id);
    expect(full.lines.map((l: { rate: string }) => Number(l.rate)).sort((a: number, b: number) => a - b)).toEqual([95, 140]);
  });

  it('an inactive level is not used (the item price applies)', async () => {
    const f = await rateFixture();
    await updateBillingRateLevel(ctx, f.senior.id, { name: f.senior.name, type: 'fixed_rate', fixedRate: '95', isActive: false });
    const { time } = await listUnbilled(ctx, f.cust);
    expect(time.find((x) => x.id === f.t1)).toMatchObject({ rate: '120.00', amount: '240.00', rateSource: 'item_price' });
  });

  it('the Income Tracker values unbilled time like billing will (level, else item price)', async () => {
    const f = await rateFixture();
    const tr = await incomeTracker(ctx, { asOf: d('2026-03-31'), customerId: f.cust });
    const time = new Map(tr.rows.filter((r) => r.type === 'time').map((r) => [r.id, r]));
    expect(time.get(f.t1)?.openBalance).toBe('190.00');
    expect(time.get(f.t3)?.openBalance).toBe('210.00');
    expect(time.get(f.t4)?.openBalance).toBe('60.00');
    expect(time.get(f.t5)?.openBalance).toBe('120.00');
    expect(tr.totals.unbilled.amount).toBe('730.00');
  });
});

// ---------------------------------------------------------------------------
// C6 — due dates from the Terms list
// ---------------------------------------------------------------------------

describe('C6. Batch invoices take their due date from the customer’s Terms list entry', () => {
  it('uses customers.termsId, not the free-text terms copy', async () => {
    const consult = await svcItem('Consulting', '100.00');
    // A custom entry the customer picked, renamed afterwards: the copied text no longer matches.
    const club = await createEntry(ctx, 'terms', { name: `Club ${seq}`, kind: 'standard', netDays: 10 });
    const a = (await createCustomer(ctx, { displayName: `A ${seq}`, termsId: String(club.id) })).id;
    await updateEntry(ctx, 'terms', String(club.id), { name: `Members ${seq}`, kind: 'standard', netDays: 10 });
    // An imported customer whose list entry (Net 15) and legacy text ('net_30') disagree.
    const net15 = (await listEntries(ctx, 'terms')).find((t) => t.name === 'Net 15')!;
    const b = (await createCustomer(ctx, { displayName: `B ${seq}`, termsId: String(net15.id) })).id;
    await db.update(customers).set({ terms: 'net_30' }).where(eq(customers.id, b));

    const res = await createBatchInvoices(ctx, {
      customerIds: [a, b],
      date: d('2026-03-01'),
      lines: [{ itemId: consult, quantity: 1, rate: '100' }],
    });
    expect(res.skipped).toEqual([]);
    const invA = await getInvoice(ctx, res.created.find((c) => c.customerId === a)!.invoiceId);
    const invB = await getInvoice(ctx, res.created.find((c) => c.customerId === b)!.invoiceId);
    expect(ymd(invA.dueDate)).toBe('2026-03-11');
    expect(invA.terms).toBe(`Members ${seq}`);
    expect(ymd(invB.dueDate)).toBe('2026-03-16');
    expect(invB.terms).toBe('net_15');
  });
});

// ---------------------------------------------------------------------------
// C6 — Billing Groups
// ---------------------------------------------------------------------------

describe('C6. Billing Groups', () => {
  it('creates, lists, renames, re-members and deletes groups; names are unique; all audited', async () => {
    const a = (await createCustomer(ctx, { displayName: `Alpha ${seq}` })).id;
    const b = (await createCustomer(ctx, { displayName: `Beta ${seq}` })).id;
    const g = await createBillingGroup(ctx, { name: '  Monthly   retainers ', customerIds: [a, b, a] });
    expect(g.name).toBe('Monthly retainers');
    expect([...g.customerIds].sort()).toEqual([a, b].sort());
    await expect(createBillingGroup(ctx, { name: 'MONTHLY RETAINERS' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createBillingGroup(ctx, { name: '' })).rejects.toMatchObject({ code: 'VALIDATION' });

    const renamed = await updateBillingGroup(ctx, g.id, { name: 'Retainers', customerIds: [b] });
    expect(renamed).toMatchObject({ name: 'Retainers', customerIds: [b] });
    expect((await listBillingGroups(ctx)).map((x) => x.name)).toEqual(['Retainers']);

    await deleteBillingGroup(ctx, g.id);
    await expect(getBillingGroup(ctx, g.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await db.select().from(billingGroupMembers).where(eq(billingGroupMembers.groupId, g.id))).toHaveLength(0);
    const audit = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'billing_group'), eq(auditLogs.entityId, g.id)));
    expect(audit.map((r) => r.action).sort()).toEqual(['create', 'delete', 'update']);
  });

  it('members must be customers of this company, and groups stay inside their company', async () => {
    const mine = (await createCustomer(ctx, { displayName: `Mine ${seq}` })).id;
    const [other] = await db.insert(companies).values({ name: `Other ${seq}`, ownerId: userId }).returning();
    const [theirs] = await db.insert(customers).values({ companyId: other.id, displayName: 'Theirs' }).returning();
    await expect(createBillingGroup(ctx, { name: 'Mixed', customerIds: [mine, theirs.id] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const g = await createBillingGroup(ctx, { name: 'Mine only', customerIds: [mine] });
    const otherCtx = { db, companyId: other.id, userId };
    await expect(getBillingGroup(otherCtx, g.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateBillingGroup(otherCtx, g.id, { name: 'Hijack' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await listBillingGroups(otherCtx)).toEqual([]);
  });

  it('routes: GET / POST /api/billing-groups, PATCH (add members) and DELETE /api/billing-groups/:id', async () => {
    const a = (await createCustomer(ctx, { displayName: `Ann ${seq}` })).id;
    const b = (await createCustomer(ctx, { displayName: `Bo ${seq}` })).id;
    const created = await groupsPOST(req('/api/billing-groups', { name: 'HOA', customerIds: [a] }));
    expect(created.status).toBe(201);
    const g = (await created.json()) as { id: string };
    const patched = await groupPATCH(req(`/api/billing-groups/${g.id}`, { addCustomerIds: [b] }, 'PATCH'), {
      params: Promise.resolve({ id: g.id }),
    });
    expect([...((await patched.json()) as { customerIds: string[] }).customerIds].sort()).toEqual([a, b].sort());
    const dup = await groupsPOST(req('/api/billing-groups', { name: 'hoa' }));
    expect(dup.status).toBe(400);
    const list = (await (await groupsGET()).json()) as { groups: Array<{ id: string; members: Array<{ displayName: string }> }> };
    expect(list.groups.find((x) => x.id === g.id)?.members.map((m) => m.displayName)).toEqual([`Ann ${seq}`, `Bo ${seq}`]);
    const del = await groupDELETE(req(`/api/billing-groups/${g.id}`, undefined, 'DELETE'), { params: Promise.resolve({ id: g.id }) });
    expect(del.status).toBe(200);
    expect(await db.select().from(billingGroups).where(eq(billingGroups.id, g.id))).toHaveLength(0);
  });

  it('a customer merge moves memberships to the survivor (once); Clean Up removes an unused inactive member', async () => {
    const a = (await createCustomer(ctx, { displayName: `From ${seq}` })).id;
    const b = (await createCustomer(ctx, { displayName: `To ${seq}` })).id;
    const both = await createBillingGroup(ctx, { name: 'Both', customerIds: [a, b] });
    const onlyA = await createBillingGroup(ctx, { name: 'Only A', customerIds: [a] });
    await mergeCustomers(ctx, { fromId: a, toId: b });
    expect((await getBillingGroup(ctx, both.id)).customerIds).toEqual([b]);
    expect((await getBillingGroup(ctx, onlyA.id)).customerIds).toEqual([b]);

    const gone = (await createCustomer(ctx, { displayName: `Gone ${seq}` })).id;
    await updateBillingGroup(ctx, both.id, { customerIds: [b, gone] });
    await deactivateCustomer(ctx, gone);
    const res = await runCleanup(ctx, { lists: ['customers'] });
    expect(res.removed.map((r) => r.id)).toContain(gone);
    expect((await getBillingGroup(ctx, both.id)).customerIds).toEqual([b]);
  });
});

// ---------------------------------------------------------------------------
// C9 — Income Tracker: unbilled time & costs, per-row actions
// ---------------------------------------------------------------------------

async function expenseAccount() {
  const [a] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.type, 'expense')))
    .limit(1);
  return a.id;
}

async function billableCost(customerId: string, date: string, amount: string) {
  const vendorId = (await createVendor(ctx, { displayName: `Permits ${seq} ${amount}` } as never)).id;
  const bill = await createBill(ctx, {
    vendorId,
    date: d(date),
    lines: [{ accountId: await expenseAccount(), description: 'Permit fee', amount, customerId }],
  } as never);
  const [line] = await db.select({ id: billLines.id }).from(billLines).where(eq(billLines.billId, bill.id));
  return { billId: bill.id, lineId: line.id };
}

describe('C9. Income Tracker — unbilled time & costs and row actions', () => {
  it('lists billable costs with time in the Unbilled bucket, honouring the as-of day and the customer filter', async () => {
    const f = await rateFixture();
    const cost = await billableCost(f.cust, '2026-03-05', '80.00');
    const other = (await createCustomer(ctx, { displayName: `Other ${seq}` })).id;
    await billableCost(other, '2026-03-05', '15.00');

    const tr = await incomeTracker(ctx, { asOf: d('2026-03-31'), customerId: f.cust });
    const costRow = tr.rows.find((r) => r.type === 'cost');
    expect(costRow).toMatchObject({ id: cost.lineId, bucket: 'unbilled', openBalance: '80.00', source: 'bill', docId: cost.billId });
    expect(tr.rows.filter((r) => r.type === 'cost')).toHaveLength(1); // the other customer's cost is filtered out
    expect(tr.totals.unbilled.amount).toBe('810.00'); // 730 time + 80 cost
    expect(tr.rows.find((r) => r.id === f.t1)?.detail).toContain(`Senior ${seq} rate`);

    // Before the bill / the later time: not there yet.
    const early = await incomeTracker(ctx, { asOf: d('2026-03-04'), customerId: f.cust });
    expect(early.rows.some((r) => r.type === 'cost')).toBe(false);
    expect(early.rows.filter((r) => r.type === 'time').map((r) => r.id).sort()).toEqual([f.t1, f.t2, f.t3].sort());

    // Billed on 2026-04-10: still unbilled as of 2026-03-31, gone as of 2026-04-30.
    await createInvoiceWithBillables(ctx, { customerId: f.cust, date: d('2026-04-10'), lines: [] }, { billLineIds: [cost.lineId], timeEntryIds: [f.t1] });
    const before = await incomeTracker(ctx, { asOf: d('2026-03-31'), customerId: f.cust });
    expect(before.rows.some((r) => r.id === cost.lineId)).toBe(true);
    expect(before.rows.some((r) => r.id === f.t1)).toBe(true);
    const after = await incomeTracker(ctx, { asOf: d('2026-04-30'), customerId: f.cust });
    expect(after.rows.some((r) => r.id === cost.lineId)).toBe(false);
    expect(after.rows.some((r) => r.id === f.t1)).toBe(false);
  });

  it('"Turn into invoices" on time & cost rows makes one invoice per customer at the billing rates', async () => {
    const f = await rateFixture();
    const cost = await billableCost(f.cust, '2026-03-05', '80.00');
    const res = await runTrackerAction(ctx, 'convert', [
      { type: 'time', id: f.t1 },
      { type: 'time', id: f.t3 },
      { type: 'cost', id: cost.lineId },
    ]);
    expect(res.failed).toEqual([]);
    expect(res.done).toHaveLength(3);
    expect(new Set(res.done.map((x) => x.detail)).size).toBe(1);
    const { time, costs } = await listUnbilled(ctx, f.cust);
    expect(time.map((t) => t.id).sort()).toEqual([f.t2, f.t4, f.t5].sort());
    expect(costs).toEqual([]);
    const [line] = await db.select({ inv: billLines.billedInvoiceId }).from(billLines).where(eq(billLines.id, cost.lineId));
    const inv = await getInvoice(ctx, line.inv!);
    expect(inv.total).toBe('480.00'); // 190 + 210 + 80
    // Already billed now: reported, nothing billed twice.
    const again = await runTrackerAction(ctx, 'convert', [{ type: 'time', id: f.t1 }]);
    expect(again.done).toEqual([]);
    expect(again.failed[0].error).toMatch(/already billed/i);
  });
});

// ---------------------------------------------------------------------------
// C9 — Collections Center actions
// ---------------------------------------------------------------------------

async function lateCustomer() {
  const consult = await svcItem('Consulting', '100.00');
  const cust = (await createCustomer(ctx, { displayName: `Late ${seq}`, email: `late${seq}@client.test` })).id;
  const inv = await createInvoice(ctx, {
    customerId: cust,
    date: d('2026-01-02'),
    dueDate: d('2026-02-01'),
    lines: [{ itemId: consult, quantity: 1, rate: '250.00', taxable: false }],
  });
  return { cust, inv };
}

describe('C9. Collections Center — contacts, follow-ups, email and letters', () => {
  it('records a call with a follow-up on the To Do list and the customer Notes; shows "last contacted"', async () => {
    const { cust, inv } = await lateCustomer();
    const res = await recordCollectionContact(ctx, {
      customerId: cust,
      method: 'call',
      note: 'Promised to pay Friday',
      invoiceId: inv.id,
      followUpDate: '2027-01-08',
      addTodo: true,
      addCustomerNote: true,
    });
    expect(res.note.contactMethod).toBe('call');
    const [todo] = await db.select().from(todos).where(eq(todos.id, res.todoId!));
    expect(todo).toMatchObject({ entityType: 'customer', entityId: cust, kind: 'call', dueDate: '2027-01-08' });
    const [note] = await db.select().from(entityNotes).where(eq(entityNotes.id, res.customerNoteId!));
    expect(note).toMatchObject({ entityType: 'customer', entityId: cust });
    expect(note.body).toContain('Promised to pay Friday');

    // A plain note is not a contact.
    await recordCollectionContact(ctx, { customerId: cust, note: 'Disputes the hours' });
    const center = await collectionsCenter(ctx, { asOf: d('2026-03-01') });
    const row = center.overdue.find((c) => c.customerId === cust)!;
    expect(row.lastContact).toMatchObject({ method: 'call', note: 'Promised to pay Friday' });
    expect(row.nextFollowUp).toBe('2027-01-08');

    await expect(recordCollectionContact(ctx, { customerId: cust, method: 'call', addTodo: true })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(recordCollectionContact(ctx, { customerId: cust, method: 'fax' as never })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(recordCollectionContact(ctx, { customerId: cust, note: 'x', followUpDate: '2027-02-30' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('POST /api/collections/contacts records the contact (route)', async () => {
    const { cust } = await lateCustomer();
    const res = await contactsPOST(req('/api/collections/contacts', { customerId: cust, method: 'visit', note: 'Dropped by the office' }));
    expect(res.status).toBe(201);
    const bad = await contactsPOST(req('/api/collections/contacts', { customerId: cust, method: 'pigeon' }));
    expect(bad.status).toBe(400);
  });

  it('emails the overdue invoices through the app email (recorded as a contact); without email set up nothing is recorded', async () => {
    const { cust, inv } = await lateCustomer();
    mail.on = false;
    await expect(emailCollectionReminder(ctx, { customerId: cust, what: 'invoices' })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await db.select().from(collectionNotes).where(eq(collectionNotes.customerId, cust))).toHaveLength(0);

    mail.on = true;
    mail.sent = [];
    try {
      const r = await emailCollectionReminder(ctx, { customerId: cust, what: 'invoices', followUpDate: '2027-01-15', addTodo: true });
      expect(mail.sent).toEqual([{ kind: 'invoice', id: inv.id, to: null }]);
      expect(r.sent).toHaveLength(1);
      expect(r.note).toMatchObject({ contactMethod: 'email' });
      expect(r.note!.note).toMatch(/^Emailed Invoice #/);
      expect(r.todoId).toBeTruthy();
      const s = await emailCollectionReminder(ctx, { customerId: cust, what: 'statement', to: 'boss@client.test' });
      expect(s.note).toMatchObject({ contactMethod: 'statement', note: 'Emailed a statement to boss@client.test.' });
    } finally {
      mail.on = false;
    }
  });

  it('prints a collection letter (PDF) and records it as a letter contact', async () => {
    const { cust } = await lateCustomer();
    const r = await collectionLetter(ctx, { customerId: cust, templateId: 'builtin:collection-friendly' });
    expect(Buffer.from(r.bytes.slice(0, 5)).toString()).toBe('%PDF-');
    expect(r.note).toMatchObject({ contactMethod: 'letter' });
    await expect(collectionLetter(ctx, { customerId: cust, templateId: 'builtin:nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const center = await collectionsCenter(ctx, { asOf: d('2026-03-01') });
    expect(center.overdue.find((c) => c.customerId === cust)?.lastContact?.method).toBe('letter');
  });
});
