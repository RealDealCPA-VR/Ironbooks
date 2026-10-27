/**
 * Review round 5 (third pass) — purchases / A/P / checks / sales tax regressions.
 *
 *  A  A bill payment voided while it is being edited never leaves the edited payment's journal
 *     entry posted on a void payment (A/P and the bank stay equal to the open bills).
 *  B  Moving a check / bill payment check to another bank account where its number is already
 *     used is the usual duplicate check-number warning, not a silent duplicate.
 *  C  A bill created from a purchase order: editing its quantity moves the P.O.'s billed quantity
 *     with it (the rest can be billed; the void releases what the bill holds now); its P.O. lines
 *     can't be removed / swapped for another item, nor billed past what was ordered.
 *  D  Print Checks never renders a check for a voided transaction or for one that is not a check.
 *  E  A combined sales tax rate equals the sum of its components as stored (6 places).
 *  F  A voided purchase order can't be closed (Undo of the void still reopens it).
 *  G  GET /api/bill-payments and /api/expenses with a negative limit are a 200, not a 500.
 *  H  The vendor form's masked account number ("••••6789") never overwrites the real one.
 *  I  Making a vendor inactive returns it masked (no full tax ID for a restricted user).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, billPayments, journalEntries, journalEntryLines, taxRates, users, vendors } from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { createItem } from './items';
import { createBill, getBill, updateBill, voidBill } from './bills';
import { payBills, updateBillPayment, voidBillPayment } from './billPayments';
import { createExpense, updateExpense, voidExpense } from './expenses';
import { convertToBill, createPurchaseOrder, getPurchaseOrder, updateStatus } from './purchaseOrders';
import { checkPrintData } from './printQueue';
import { createTaxRate } from './salesTax';
import { listComponents, setComponents } from './combinedTax';
import { createVendor, deactivateVendor, getVendor, updateVendor } from './vendors';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { GET as billPaymentsGET } from '@/app/api/bill-payments/route';
import { GET as expensesGET } from '@/app/api/expenses/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-purchases3');
let db: DB;
const acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

async function newVendor(extra: Partial<typeof vendors.$inferInsert> = {}) {
  seq += 1;
  const [v] = await db
    .insert(vendors)
    .values({ companyId: ctx.companyId, displayName: `R5C Vendor ${seq}`, ...extra })
    .returning();
  return v;
}

async function glBalance(accountId: string): Promise<string> {
  const rows = await db
    .select({ d: journalEntryLines.debit, c: journalEntryLines.credit })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        eq(journalEntryLines.accountId, accountId),
      ),
    );
  const cents = rows.reduce((s, r) => s + Math.round(Number(r.d ?? 0) * 100) - Math.round(Number(r.c ?? 0) * 100), 0);
  return (cents / 100).toFixed(2);
}

/** The ServiceError a call is refused with (fails the test when it succeeds). */
async function refusal(p: Promise<unknown>): Promise<ServiceError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'expected the call to be refused').not.toBeNull();
  expect(err).toBeInstanceOf(ServiceError);
  return err as ServiceError;
}

describe('review5 purchases (third pass)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'r5c-purchases@test.local', name: 'R5C P', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'R5C Purchases Co', ownerId: u.id });
    ctx = { db, companyId: company.id, userId: u.id };
    for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) if (r.code) acct[r.code] = r.id;
    if (!acct['4000']) {
      acct['4000'] = (await createAccount(ctx, { code: '4000', name: 'Sales', type: 'revenue' as never, subtype: 'sales' })).id;
    }
    acct['1020'] = (await createAccount(ctx, { code: '1020', name: 'Payroll Checking', type: 'asset' as never, subtype: 'checking' })).id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle. */
    }
  });

  it('A: a bill payment voided while it is being edited leaves no posted payment entry behind', async () => {
    const v = await newVendor();
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-03-01'), lines: [{ accountId: acct['6000'], amount: '50.00' }] });
    const pay = await payBills(ctx, {
      vendorId: v.id,
      date: d('2026-03-02'),
      method: 'ach',
      paymentAccountId: acct['1000'],
      applications: [{ billId: bill.id, amountApplied: '50.00' }],
    });
    // Both started together (two users, or a double click): the edit's transaction runs first.
    await Promise.allSettled([
      updateBillPayment(ctx, pay.id, {
        vendorId: v.id,
        date: d('2026-03-03'),
        method: 'ach',
        paymentAccountId: acct['1000'],
        applications: [{ billId: bill.id, amountApplied: '40.00' }],
      }),
      voidBillPayment(ctx, pay.id),
    ]);
    const [p] = await db.select().from(billPayments).where(eq(billPayments.id, pay.id));
    expect(p.voidedAt).not.toBeNull();
    const after = await getBill(ctx, bill.id);
    expect(after.balanceDue).toBe('50.00');
    // Before: the edited payment's entry (Dr A/P 40 / Cr bank 40) stayed posted on a void payment.
    const posted = await db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.status, 'posted'),
          eq(journalEntries.sourceRef, `vendor:${v.id}`),
        ),
      );
    expect(posted).toHaveLength(0);
  });

  it('B: moving a check to a bank account that already has its number is a duplicate check number', async () => {
    const v = await newVendor();
    await createExpense(ctx, {
      vendorId: v.id,
      date: d('2026-03-01'),
      method: 'check',
      reference: '7001',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6000'], amount: '10.00' }],
    });
    const other = await createExpense(ctx, {
      vendorId: v.id,
      date: d('2026-03-01'),
      method: 'check',
      reference: '7001',
      paymentAccountId: acct['1020'],
      lines: [{ accountId: acct['6000'], amount: '11.00' }],
    });
    const moved = {
      vendorId: v.id,
      date: d('2026-03-01'),
      method: 'check' as const,
      reference: '7001',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6000'], amount: '11.00' }],
    };
    const err = await refusal(updateExpense(ctx, other.id, { ...moved, checkDuplicateNumber: true }));
    expect(err.code).toBe('CONFLICT');
    expect((err.details as { duplicateNumber?: boolean }).duplicateNumber).toBe(true);
    // The user confirms the duplicate: saved. Unchanged number on the same account: no warning.
    await updateExpense(ctx, other.id, { ...moved, checkDuplicateNumber: false });
    await updateExpense(ctx, other.id, { ...moved, memo: 'same check', checkDuplicateNumber: true });

    // Bill payment checks alike.
    const b1 = await createBill(ctx, { vendorId: v.id, date: d('2026-03-01'), lines: [{ accountId: acct['6000'], amount: '50.00' }] });
    const b2 = await createBill(ctx, { vendorId: v.id, date: d('2026-03-01'), lines: [{ accountId: acct['6000'], amount: '50.00' }] });
    await payBills(ctx, { vendorId: v.id, date: d('2026-03-02'), method: 'check', reference: '8001', paymentAccountId: acct['1000'], applications: [{ billId: b1.id, amountApplied: '50.00' }] });
    const p2 = await payBills(ctx, { vendorId: v.id, date: d('2026-03-02'), method: 'check', reference: '8001', paymentAccountId: acct['1020'], applications: [{ billId: b2.id, amountApplied: '50.00' }] });
    const pErr = await refusal(
      updateBillPayment(ctx, p2.id, {
        vendorId: v.id,
        date: d('2026-03-02'),
        method: 'check',
        reference: '8001',
        paymentAccountId: acct['1000'],
        applications: [{ billId: b2.id, amountApplied: '50.00' }],
        checkDuplicateNumber: true,
      }),
    );
    expect(pErr.code).toBe('CONFLICT');
    expect((pErr.details as { duplicateNumber?: boolean }).duplicateNumber).toBe(true);
  });

  it('C: editing a bill created from a purchase order moves the P.O. billed quantity with it', async () => {
    const v = await newVendor();
    const item = await createItem(ctx, {
      name: `R5C Widget ${++seq}`,
      type: 'inventory',
      assetAccountId: acct['1300'],
      incomeAccountId: acct['4000'],
      cogsAccountId: acct['5000'],
    } as never);
    const po = await createPurchaseOrder(ctx, {
      vendorId: v.id,
      date: d('2026-03-01'),
      lines: [
        { itemId: item.id, quantity: 10, rate: '5.00' },
        { accountId: acct['6000'], quantity: 1, rate: '20.00', description: 'Setup fee' },
      ],
    });
    const bill = await convertToBill(ctx, po.id, { date: d('2026-03-05') });
    expect((await getPurchaseOrder(ctx, po.id)).status).toBe('closed');

    const edit = (qty: number, extra: Record<string, unknown> = {}) =>
      updateBill(ctx, bill.id, {
        vendorId: v.id,
        date: d('2026-03-05'),
        lines: [
          { itemId: item.id, quantity: qty, unitCost: '5.00' },
          { accountId: acct['6000'], quantity: 1, amount: '20.00', description: 'Setup fee' },
        ],
        ...extra,
      });

    // The vendor billed only 6 of the 10: the P.O. stays open for the other 4.
    await edit(6);
    let after = await getPurchaseOrder(ctx, po.id);
    expect(after.status).toBe('partial');
    expect(after.lines.map((l) => Number(l.quantityBilled))).toEqual([6, 1]);

    // Billing past what was ordered is refused; removing / swapping the P.O. line too.
    expect((await refusal(edit(11))).code).toBe('VALIDATION');
    expect(
      (
        await refusal(
          updateBill(ctx, bill.id, {
            vendorId: v.id,
            date: d('2026-03-05'),
            lines: [{ accountId: acct['6000'], quantity: 1, amount: '20.00' }],
          }),
        )
      ).code,
    ).toBe('CONFLICT');
    expect((await refusal(edit(6, { vendorId: (await newVendor()).id }))).code).toBe('CONFLICT');

    // The other 4 are billed from the P.O. (it closes), then the first bill is voided: the P.O.
    // gets back the 6 it holds NOW, not the 10 it was converted with.
    const rest = await convertToBill(ctx, po.id, { date: d('2026-03-10') });
    expect(rest.total).toBe('20.00');
    after = await getPurchaseOrder(ctx, po.id);
    expect(after.status).toBe('closed');
    expect(after.lines.map((l) => Number(l.quantityBilled))).toEqual([10, 1]);
    await voidBill(ctx, bill.id);
    after = await getPurchaseOrder(ctx, po.id);
    expect(after.lines.map((l) => Number(l.quantityBilled))).toEqual([4, 0]);
    expect(after.status).toBe('partial');
  });

  it('D: Print Checks refuses a voided transaction or one that is not a check', async () => {
    const v = await newVendor();
    const chk = await createExpense(ctx, {
      vendorId: v.id,
      date: d('2026-04-01'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6000'], amount: '75.00' }],
    });
    expect((await checkPrintData(ctx, 'expense', chk.id)).amount).toBe('75.00'); // a reprint is fine
    await voidExpense(ctx, chk.id);
    // Before: a ready-to-sign $75.00 check for a voided transaction.
    expect((await refusal(checkPrintData(ctx, 'expense', chk.id))).code).toBe('CONFLICT');

    const card = await createExpense(ctx, {
      vendorId: v.id,
      date: d('2026-04-01'),
      method: 'credit_card',
      paymentAccountId: acct['2100'],
      lines: [{ accountId: acct['6000'], amount: '30.00' }],
    });
    expect((await refusal(checkPrintData(ctx, 'expense', card.id))).code).toBe('VALIDATION');

    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-04-01'), lines: [{ accountId: acct['6000'], amount: '40.00' }] });
    const ach = await payBills(ctx, { vendorId: v.id, date: d('2026-04-02'), method: 'ach', paymentAccountId: acct['1000'], applications: [{ billId: bill.id, amountApplied: '15.00' }] });
    expect((await refusal(checkPrintData(ctx, 'bill_payment', ach.id))).code).toBe('VALIDATION');
    const byCheck = await payBills(ctx, { vendorId: v.id, date: d('2026-04-02'), method: 'check', paymentAccountId: acct['1000'], applications: [{ billId: bill.id, amountApplied: '25.00' }] });
    expect((await checkPrintData(ctx, 'bill_payment', byCheck.id)).amount).toBe('25.00');
    await voidBillPayment(ctx, byCheck.id);
    expect((await refusal(checkPrintData(ctx, 'bill_payment', byCheck.id))).code).toBe('CONFLICT');
  });

  it('E: a combined sales tax rate equals the sum of its components as stored', async () => {
    const rate = await createTaxRate(ctx, { name: `R5C Combined ${++seq}`, rate: '0' });
    await setComponents(ctx, rate.id, [
      { name: 'State', rate: '0.0600005' },
      { name: 'County', rate: '0.0100005' },
    ]);
    const comps = await listComponents(ctx, rate.id);
    const [row] = await db.select().from(taxRates).where(eq(taxRates.id, rate.id));
    const sumMicros = comps.reduce((s, c) => s + Math.round(Number(c.rate) * 1e6), 0);
    // Before: components 0.060001 + 0.010001 under a combined 0.070001.
    expect(Math.round(Number(row.rate) * 1e6)).toBe(sumMicros);
  });

  it('F: a voided purchase order cannot be closed (Undo of the void still reopens it)', async () => {
    const v = await newVendor();
    const po = await createPurchaseOrder(ctx, { vendorId: v.id, date: d('2026-03-01'), lines: [{ accountId: acct['6000'], quantity: 1, rate: '5.00' }] });
    await updateStatus(ctx, po.id, 'void');
    expect((await refusal(updateStatus(ctx, po.id, 'closed'))).code).toBe('CONFLICT');
    expect((await getPurchaseOrder(ctx, po.id)).status).toBe('void');
    expect((await updateStatus(ctx, po.id, 'void')).status).toBe('void');
    expect((await updateStatus(ctx, po.id, 'open')).status).toBe('open'); // Undo
  });

  it('G: a negative limit on the bill payment / check lists is a 200, not a 500', async () => {
    const get = (url: string) => new Request(`http://localhost${url}`) as never;
    const withUrl = (url: string) => Object.assign(get(url), { nextUrl: new URL(`http://localhost${url}`) });
    const a = await billPaymentsGET(withUrl('/api/bill-payments?limit=-1&offset=-5'));
    expect(a.status).toBe(200);
    const b = await expensesGET(withUrl('/api/expenses?limit=-1&offset=-5'));
    expect(b.status).toBe(200);
  });

  it('H: the masked account number a restricted user sees never overwrites the real one', async () => {
    const { BUILTIN_ROLES, unionRoles } = await import('@/lib/permissions/model');
    const restricted: ServiceContext = { ...ctx, access: unionRoles(BUILTIN_ROLES.filter((r) => r.key === 'purchasing')) };
    const created = await createVendor(ctx, { displayName: `R5C Acct ${++seq}`, accountNumber: '000123456789' });
    const seen = await getVendor(restricted, created.id);
    expect(seen.accountNumber).toBe('••••6789');
    // The vendor form sends every field back, the masked number included.
    await updateVendor(restricted, created.id, { displayName: seen.displayName, accountNumber: seen.accountNumber, notes: 'edited' });
    const [row] = await db.select().from(vendors).where(eq(vendors.id, created.id));
    expect(row.accountNumber).toBe('000123456789');
    expect(row.notes).toBe('edited');
    // A new vendor can't be saved with a masked number; a real change is kept.
    expect((await refusal(createVendor(restricted, { displayName: `R5C Acct ${++seq}`, accountNumber: '••••1111' }))).code).toBe(
      'VALIDATION',
    );
    await updateVendor(restricted, created.id, { accountNumber: '555-0001' });
    const [row2] = await db.select().from(vendors).where(eq(vendors.id, created.id));
    expect(row2.accountNumber).toBe('555-0001');
  });

  it('J: Pay Sales Tax defaults "due through" from the local calendar day, not the UTC instant', async () => {
    const { paySalesTaxScreen } = await import('./liabilityPayments');
    const prev = process.env.TZ;
    process.env.TZ = 'America/New_York';
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // 10:30 PM on Sep 30 in New York — already Oct 1 in UTC.
      vi.setSystemTime(new Date('2026-10-01T02:30:00.000Z'));
      const screen = await paySalesTaxScreen(ctx);
      const expected = { monthly: '2026-08-31', quarterly: '2026-06-30', annually: '2025-12-31' }[screen.frequency];
      // Before: the period ending Sep 30 (the one still running) was offered as due.
      expect(screen.defaultDueThrough).toBe(expected);
    } finally {
      vi.useRealTimers();
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  it('K: Pay Bills by check pays from a bank account (no "check" queued on a credit card)', async () => {
    const v = await newVendor();
    const bill = await createBill(ctx, { vendorId: v.id, date: d('2026-05-01'), lines: [{ accountId: acct['6000'], amount: '60.00' }] });
    const base = { vendorId: v.id, date: d('2026-05-02'), applications: [{ billId: bill.id, amountApplied: '20.00' }] };
    // Before: saved, listed in Print Checks under the credit card and numbered there when printed.
    expect((await refusal(payBills(ctx, { ...base, method: 'check', toPrint: true, paymentAccountId: acct['2100'] }))).code).toBe(
      'VALIDATION',
    );
    const { listPrintQueue } = await import('./printQueue');
    expect((await listPrintQueue(ctx)).filter((q) => q.paymentAccountId === acct['2100'])).toHaveLength(0);
    // A card payment and a check from the bank are fine.
    await payBills(ctx, { ...base, method: 'credit_card', paymentAccountId: acct['2100'] });
    await payBills(ctx, { ...base, method: 'check', toPrint: true, paymentAccountId: acct['1000'] });
  });

  it('L: converting a partly billed item receipt says to use Enter Bill for Received Items', async () => {
    const { createItemReceipt, convertToBill: convertReceipt } = await import('./itemReceipts');
    const { enterBillForReceivedItems } = await import('./receiving');
    const v = await newVendor();
    const item = await createItem(ctx, {
      name: `R5C Part ${++seq}`,
      type: 'inventory',
      assetAccountId: acct['1300'],
      incomeAccountId: acct['4000'],
      cogsAccountId: acct['5000'],
    } as never);
    const receipt = await createItemReceipt(ctx, { vendorId: v.id, date: d('2026-05-01'), lines: [{ itemId: item.id, quantity: 10, unitCost: '2.00' }] });
    await enterBillForReceivedItems(ctx, {
      vendorId: v.id,
      date: d('2026-05-03'),
      lines: [{ receiptLineId: receipt.lines[0].id, quantity: 4, unitCost: '2.00' }],
    });
    const err = await refusal(convertReceipt(ctx, receipt.id));
    expect(err.code).toBe('CONFLICT');
    // Before: "converted or voided by another transaction. Reload and retry."
    expect(err.message).toMatch(/Enter Bill for Received Items/);
  });

  it('M: Convert to Bill never bills a purchase order line at a price someone just changed', async () => {
    const { updatePurchaseOrder } = await import('./purchaseOrders');
    const v = await newVendor();
    const po = await createPurchaseOrder(ctx, {
      vendorId: v.id,
      date: d('2026-06-01'),
      lines: [{ accountId: acct['6000'], quantity: 2, rate: '10.00', description: 'Service' }],
    });
    // Convert to Bill reads the P.O., then (before its transaction starts) another user saves a new
    // price on the line.
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const gatedDb = Object.create(db) as DB;
    (gatedDb as unknown as { transaction: DB['transaction'] }).transaction = (async (fn: never) => {
      await gate;
      return db.transaction(fn);
    }) as never;
    const converting = convertToBill({ ...ctx, db: gatedDb }, po.id, { date: d('2026-06-05') }).then(
      (b) => b,
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 50));
    const current = await getPurchaseOrder(ctx, po.id);
    await updatePurchaseOrder(ctx, po.id, {
      vendorId: v.id,
      date: d('2026-06-01'),
      lines: [{ id: current.lines[0].id, accountId: acct['6000'], quantity: 2, rate: '12.50', description: 'Service' }],
    });
    open();
    const result = await converting;
    // Before: a $20.00 bill (the old price) against the P.O. now priced at $25.00.
    expect(result).toBeInstanceOf(ServiceError);
    expect((result as ServiceError).code).toBe('CONFLICT');
    const after = await getPurchaseOrder(ctx, po.id);
    expect(Number(after.lines[0].quantityBilled)).toBe(0);
    expect((await convertToBill(ctx, po.id, { date: d('2026-06-05') })).total).toBe('25.00');
  });

  it('N: an item receipt edited while it is being converted is billed as edited', async () => {
    const { createItemReceipt, convertToBill: convertReceipt, updateItemReceipt, getOrCreateAccrualAccount } = await import(
      './itemReceipts'
    );
    const v = await newVendor();
    const item = await createItem(ctx, {
      name: `R5C Bolt ${++seq}`,
      type: 'inventory',
      assetAccountId: acct['1300'],
      incomeAccountId: acct['4000'],
      cogsAccountId: acct['5000'],
    } as never);
    const accrual = await getOrCreateAccrualAccount(ctx);
    const accrualBefore = await glBalance(accrual);
    const receipt = await createItemReceipt(ctx, { vendorId: v.id, date: d('2026-06-01'), lines: [{ itemId: item.id, quantity: 10, unitCost: '2.00' }] });
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const gatedDb = Object.create(db) as DB;
    (gatedDb as unknown as { transaction: DB['transaction'] }).transaction = (async (fn: never) => {
      await gate;
      return db.transaction(fn);
    }) as never;
    const converting = convertReceipt({ ...ctx, db: gatedDb }, receipt.id).then(
      (b) => b,
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 50));
    // Another user corrects the quantity received: 8, not 10.
    await updateItemReceipt(ctx, receipt.id, { vendorId: v.id, date: d('2026-06-01'), lines: [{ itemId: item.id, quantity: 8, unitCost: '2.00' }] });
    open();
    const bill = await converting;
    expect(bill).not.toBeInstanceOf(Error);
    // Before: a $20.00 bill for the 10 units that are no longer on the receipt.
    expect((bill as { total: string }).total).toBe('16.00');
    expect(await glBalance(accrual)).toBe(accrualBefore); // the accrual nets to zero
  });

  it('I: making a vendor inactive does not hand a restricted user the full tax ID', async () => {
    const { BUILTIN_ROLES, unionRoles } = await import('@/lib/permissions/model');
    const restricted: ServiceContext = { ...ctx, access: unionRoles(BUILTIN_ROLES.filter((r) => r.key === 'purchasing')) };
    const v = await createVendor(ctx, { displayName: `R5C Tin ${++seq}`, taxId: '123-45-6789', is1099: true });
    const out = await deactivateVendor(restricted, v.id);
    expect(out.taxId).toBe('***-**-6789');
    expect(out.isActive).toBe(false);
  });
});
