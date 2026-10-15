/**
 * Smart defaults (QB recall last transaction / auto-fill + next check number), computed from the
 * company file's history: every form type, check-number sequencing per bank account (gaps,
 * typed suffixes, non-numeric references), the preferences that turn recall off, and
 * company / permission scoping.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  accounts,
  billLines,
  billPayments,
  bills,
  classes,
  customers,
  estimateLines,
  estimates,
  expenseLines,
  expenses,
  invoiceLines,
  invoices,
  items,
  salesOrderLines,
  salesOrders,
  salesReceiptLines,
  salesReceipts,
  salesReps,
  taxRates,
  users,
  vendors,
} from '@/lib/db/schema';
import { fullAccess } from '@/lib/permissions/model';
import type { ServiceContext } from './_base';
import { nextCheckNumber } from './checkNumbers';
import { createCompany, updateCompany } from './company';
import { updateMyPreferences } from './preferences';
import { getSmartDefaults } from './smartDefaults';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
let ctx: ServiceContext;
const id: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T12:00:00Z`);

async function vendor(name: string) {
  const [v] = await t.db.insert(vendors).values({ companyId: ctx.companyId, displayName: name }).returning();
  return v.id;
}
async function customer(name: string) {
  const [c] = await t.db.insert(customers).values({ companyId: ctx.companyId, displayName: name }).returning();
  return c.id;
}

async function addBill(
  vendorId: string,
  date: string,
  h: { terms?: string; classId?: string; memo?: string; status?: 'open' | 'void'; number?: string },
  lines: Array<{ accountId: string; amount: string; itemId?: string; quantity?: string; description?: string; classId?: string }>,
) {
  const [b] = await t.db
    .insert(bills)
    .values({
      companyId: ctx.companyId,
      vendorId,
      date: d(date),
      billNumber: h.number ?? null,
      terms: h.terms ?? null,
      classId: h.classId ?? null,
      memo: h.memo ?? null,
      status: h.status ?? 'open',
    })
    .returning();
  await t.db.insert(billLines).values(
    lines.map((l, i) => ({
      billId: b.id,
      accountId: l.accountId,
      itemId: l.itemId ?? null,
      quantity: l.quantity ?? '1',
      amount: l.amount,
      description: l.description ?? null,
      classId: l.classId ?? null,
      lineOrder: i,
    })),
  );
  return b.id;
}

async function addExpense(
  vendorId: string | null,
  method: 'check' | 'cash' | 'credit_card' | 'ach',
  date: string,
  h: { paymentAccountId?: string; reference?: string | null; memo?: string; total?: string; voided?: boolean },
  lines: Array<{ accountId: string; amount: string; classId?: string; customerId?: string; itemId?: string; quantity?: string; unitCost?: string }> = [],
) {
  const [e] = await t.db
    .insert(expenses)
    .values({
      companyId: ctx.companyId,
      vendorId,
      method,
      date: d(date),
      reference: h.reference ?? null,
      paymentAccountId: h.paymentAccountId ?? (method === 'credit_card' ? t.acct['2100'] : t.acct['1000']),
      total: h.total ?? '10.00',
      memo: h.memo ?? null,
      voidedAt: h.voided ? new Date() : null,
    })
    .returning();
  if (lines.length) {
    await t.db.insert(expenseLines).values(
      lines.map((l, i) => ({
        expenseId: e.id,
        accountId: l.accountId,
        amount: l.amount,
        classId: l.classId ?? null,
        customerId: l.customerId ?? null,
        itemId: l.itemId ?? null,
        quantity: l.quantity ?? null,
        unitCost: l.unitCost ?? null,
        lineOrder: i,
      })),
    );
  }
  return e.id;
}

describe('smart defaults (integration)', () => {
  beforeAll(async () => {
    t = await makeTestCompany('smartdef');
    ctx = t.ctx;
    const [cls] = await t.db.insert(classes).values({ companyId: ctx.companyId, name: 'East' }).returning();
    const [cls2] = await t.db.insert(classes).values({ companyId: ctx.companyId, name: 'Old', isActive: false }).returning();
    const [rep] = await t.db.insert(salesReps).values({ companyId: ctx.companyId, name: 'Rita' }).returning();
    const [tax] = await t.db.insert(taxRates).values({ companyId: ctx.companyId, name: 'City', rate: '0.0825' }).returning();
    const [widget] = await t.db.insert(items).values({ companyId: ctx.companyId, name: 'Widget', type: 'non_inventory' }).returning();
    const [gone] = await t.db.insert(items).values({ companyId: ctx.companyId, name: 'Retired', isActive: false }).returning();
    Object.assign(id, { cls: cls.id, oldCls: cls2.id, rep: rep.id, tax: tax.id, widget: widget.id, goneItem: gone.id });
    const [chk] = await t.db.select().from(accounts).where(eq(accounts.id, t.acct['1000']));
    const [savings] = await t.db
      .insert(accounts)
      .values({ companyId: ctx.companyId, code: '1010', name: 'Second Checking', type: chk.type, subtype: chk.subtype })
      .returning();
    id.bank2 = savings.id;
  });
  afterAll(async () => {
    await t.cleanup();
  });

  // ---------------------------------------------------------------------------
  // Vendor forms
  // ---------------------------------------------------------------------------

  it('bill: recalls the last bill (accounts, items, terms, class, memo) — not void ones', async () => {
    const v = await vendor('Acme Supply');
    await addBill(v, '2026-01-05', { terms: 'net_15', memo: 'old' }, [{ accountId: t.acct['6300'], amount: '50' }]);
    await addBill(v, '2026-03-01', { terms: 'net_30', classId: id.cls, memo: 'Monthly supplies', number: 'A-7' }, [
      { accountId: t.acct['6300'], amount: '120.5', description: 'Paper' },
      { accountId: t.acct['6600'], amount: '40' },
      { accountId: t.acct['6300'], amount: '36', itemId: id.widget, quantity: '3', description: 'Widgets' },
    ]);
    await addBill(v, '2026-04-01', { status: 'void', memo: 'voided' }, [{ accountId: t.acct['6400'], amount: '9' }]);

    const r = await getSmartDefaults(ctx, { form: 'bill', vendorId: v });
    expect(r.recallEnabled).toBe(true);
    expect(r.source).toMatchObject({ form: 'bill', date: '2026-03-01', number: 'A-7' });
    expect(r.header).toEqual({ terms: 'net_30', classId: id.cls, salesRepId: null, taxRateId: null, memo: 'Monthly supplies' });
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]).toMatchObject({ kind: 'account', accountId: t.acct['6300'], amount: '120.50', description: 'Paper' });
    expect(r.lines[1]).toMatchObject({ kind: 'account', accountId: t.acct['6600'], amount: '40.00' });
    expect(r.lines[2]).toMatchObject({ kind: 'item', itemId: id.widget, quantity: '3', rate: '12', amount: '36.00' });
    expect(r.nextCheckNumber).toBeNull();
  });

  it('check: recalls the last check (lines with class / customer, memo) and offers the next number', async () => {
    const v = await vendor('Landlord LLC');
    const cust = await customer('Job Site A');
    await addExpense(v, 'check', '2026-02-01', { reference: '1001', memo: 'Feb rent' }, [{ accountId: t.acct['6400'], amount: '1500' }]);
    await addExpense(v, 'check', '2026-03-01', { reference: '1002', memo: 'Mar rent' }, [
      { accountId: t.acct['6400'], amount: '1500', classId: id.cls, customerId: cust },
    ]);
    // A later card charge for the same vendor must not be recalled on a check.
    await addExpense(v, 'credit_card', '2026-03-15', { memo: 'card' }, [{ accountId: t.acct['6600'], amount: '20' }]);

    const r = await getSmartDefaults(ctx, { form: 'check', vendorId: v, paymentAccountId: t.acct['1000'] });
    expect(r.source).toMatchObject({ form: 'check', date: '2026-03-01', number: '1002' });
    expect(r.header.memo).toBe('Mar rent');
    expect(r.header.terms).toBeNull(); // checks have no terms
    expect(r.lines).toEqual([
      expect.objectContaining({ kind: 'account', accountId: t.acct['6400'], amount: '1500.00', classId: id.cls, customerId: cust }),
    ]);
    expect(r.nextCheckNumber).toBe(await nextCheckNumber(ctx, t.acct['1000']));
  });

  it('credit card charge: recalls charges only (not card credits) and item lines with unit cost', async () => {
    const v = await vendor('Office Depot');
    await addExpense(v, 'credit_card', '2026-02-10', { memo: 'toner', total: '64' }, [
      { accountId: t.acct['6300'], amount: '64', itemId: id.widget, quantity: '2', unitCost: '32' },
    ]);
    await addExpense(v, 'credit_card', '2026-02-20', { memo: 'refund', total: '-64' }, [{ accountId: t.acct['6300'], amount: '-64' }]);
    const r = await getSmartDefaults(ctx, { form: 'credit_card', vendorId: v });
    expect(r.source).toMatchObject({ form: 'credit_card', date: '2026-02-10' });
    expect(r.header.memo).toBe('toner');
    expect(r.lines).toEqual([expect.objectContaining({ kind: 'item', itemId: id.widget, quantity: '2', rate: '32', amount: '64.00' })]);
  });

  it('expense (cash / other): recalls the last non-check, non-card expense; voided ones are skipped', async () => {
    const v = await vendor('Coffee Shop');
    await addExpense(v, 'cash', '2026-01-03', { memo: 'beans' }, [{ accountId: t.acct['6300'], amount: '12' }]);
    await addExpense(v, 'ach', '2026-01-04', { memo: 'void me', voided: true }, [{ accountId: t.acct['6600'], amount: '99' }]);
    const r = await getSmartDefaults(ctx, { form: 'expense', vendorId: v });
    expect(r.source).toMatchObject({ form: 'expense', date: '2026-01-03' });
    expect(r.lines.map((l) => l.accountId)).toEqual([t.acct['6300']]);
  });

  it("falls back to the vendor's last purchase of another type (lines only; memo / terms stay form-specific)", async () => {
    const v = await vendor('Fallback Vendor');
    await addBill(v, '2026-05-01', { terms: 'net_60', memo: 'bill memo', classId: id.cls }, [{ accountId: t.acct['6200'], amount: '300' }]);
    const r = await getSmartDefaults(ctx, { form: 'check', vendorId: v });
    expect(r.source?.form).toBe('bill');
    expect(r.lines.map((l) => l.accountId)).toEqual([t.acct['6200']]);
    expect(r.header.memo).toBeNull();
    expect(r.header.terms).toBeNull();
  });

  it('never recalls inactive accounts, items or classes', async () => {
    const v = await vendor('Stale Vendor');
    const [oldAcct] = await t.db
      .insert(accounts)
      .values({ companyId: ctx.companyId, code: '6999', name: 'Closed expense', type: 'expense', subtype: 'operating_expenses', isActive: false })
      .returning();
    await addBill(v, '2026-05-02', { classId: id.oldCls }, [
      { accountId: oldAcct.id, amount: '5' },
      { accountId: t.acct['6300'], amount: '6', itemId: id.goneItem },
      { accountId: t.acct['6100'], amount: '7', classId: id.oldCls },
    ]);
    const r = await getSmartDefaults(ctx, { form: 'bill', vendorId: v });
    expect(r.lines).toEqual([expect.objectContaining({ accountId: t.acct['6100'], classId: null })]);
    expect(r.header.classId).toBeNull();
  });

  it('nothing on file: no source, no lines', async () => {
    const v = await vendor('Brand New Vendor');
    const r = await getSmartDefaults(ctx, { form: 'bill', vendorId: v });
    expect(r.source).toBeNull();
    expect(r.lines).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Customer forms
  // ---------------------------------------------------------------------------

  it('invoice: recalls items / rates, terms, sales rep, class, tax item and memo (skips void + statement charges)', async () => {
    const c = await customer('Globex');
    const base = { companyId: ctx.companyId, customerId: c };
    const [inv] = await t.db
      .insert(invoices)
      .values({ ...base, invoiceNumber: 101, date: d('2026-06-01'), terms: 'net_15', salesRepId: id.rep, classId: id.cls, taxRateId: id.tax, memo: 'Thanks!' })
      .returning();
    await t.db.insert(invoiceLines).values([
      { invoiceId: inv.id, itemId: id.widget, description: 'Widget', quantity: '4', rate: '19.9900', amount: '79.96', taxable: true, lineOrder: 0 },
      { invoiceId: inv.id, itemId: null, accountId: t.acct['4000'], description: 'Setup', quantity: '1', rate: '50', amount: '50', taxable: false, lineOrder: 1 },
    ]);
    await t.db.insert(invoices).values({ ...base, invoiceNumber: 102, date: d('2026-06-05'), status: 'void', memo: 'void' });
    await t.db.insert(invoices).values({ ...base, invoiceNumber: 103, date: d('2026-06-06'), isStatementCharge: true, memo: 'charge' });

    const r = await getSmartDefaults(ctx, { form: 'invoice', customerId: c });
    expect(r.source).toMatchObject({ form: 'invoice', number: '101', date: '2026-06-01' });
    expect(r.header).toEqual({ terms: 'net_15', salesRepId: id.rep, classId: id.cls, taxRateId: id.tax, memo: 'Thanks!' });
    expect(r.lines[0]).toMatchObject({ kind: 'item', itemId: id.widget, quantity: '4', rate: '19.99', taxable: true });
    expect(r.lines[1]).toMatchObject({ kind: 'account', accountId: t.acct['4000'], description: 'Setup', taxable: false });
  });

  it('sales receipt: recalls lines, class, tax item and memo (no terms / rep on a receipt)', async () => {
    const c = await customer('Walk-in Regular');
    const [sr] = await t.db
      .insert(salesReceipts)
      .values({ companyId: ctx.companyId, customerId: c, receiptNumber: 1, date: d('2026-06-02'), classId: id.cls, taxRateId: id.tax, memo: 'Paid cash' })
      .returning();
    await t.db.insert(salesReceiptLines).values({ salesReceiptId: sr.id, itemId: id.widget, quantity: '1', rate: '25', amount: '25', lineOrder: 0 });
    const r = await getSmartDefaults(ctx, { form: 'sales_receipt', customerId: c });
    expect(r.source?.form).toBe('sales_receipt');
    expect(r.header).toEqual({ terms: null, salesRepId: null, classId: id.cls, taxRateId: id.tax, memo: 'Paid cash' });
    expect(r.lines).toEqual([expect.objectContaining({ itemId: id.widget, rate: '25', quantity: '1' })]);
  });

  it('estimate: recalls lines (with line class), tax item and memo', async () => {
    const c = await customer('Initech');
    const [e] = await t.db
      .insert(estimates)
      .values({ companyId: ctx.companyId, customerId: c, estimateNumber: 7, date: d('2026-06-03'), taxRateId: id.tax, memo: 'Valid 30 days' })
      .returning();
    await t.db.insert(estimateLines).values({ estimateId: e.id, itemId: id.widget, description: 'Phase 1', quantity: '10', rate: '100', amount: '1000', classId: id.cls, lineOrder: 0 });
    const r = await getSmartDefaults(ctx, { form: 'estimate', customerId: c });
    expect(r.source).toMatchObject({ form: 'estimate', number: '7' });
    expect(r.header).toEqual({ terms: null, salesRepId: null, classId: null, taxRateId: id.tax, memo: 'Valid 30 days' });
    expect(r.lines).toEqual([expect.objectContaining({ itemId: id.widget, description: 'Phase 1', quantity: '10', rate: '100', classId: id.cls })]);
  });

  it('sales order: recalls lines, tax item and memo', async () => {
    const c = await customer('Umbrella');
    const [so] = await t.db
      .insert(salesOrders)
      .values({ companyId: ctx.companyId, customerId: c, orderNumber: 3, date: d('2026-06-04'), taxRateId: id.tax, memo: 'Ship ASAP' })
      .returning();
    await t.db.insert(salesOrderLines).values({ salesOrderId: so.id, itemId: id.widget, quantity: '5', rate: '9.5', amount: '47.5', lineOrder: 0 });
    const r = await getSmartDefaults(ctx, { form: 'sales_order', customerId: c });
    expect(r.source).toMatchObject({ form: 'sales_order', number: '3' });
    expect(r.header.memo).toBe('Ship ASAP');
    expect(r.header.taxRateId).toBe(id.tax);
    expect(r.lines).toEqual([expect.objectContaining({ itemId: id.widget, quantity: '5', rate: '9.5', amount: '47.50' })]);
  });

  it("customer fallback: a first sales order uses the customer's last invoice lines and tax item, not its memo / terms / rep", async () => {
    const c = await customer('Fallback Customer');
    const [inv] = await t.db
      .insert(invoices)
      .values({ companyId: ctx.companyId, customerId: c, invoiceNumber: 201, date: d('2026-06-07'), terms: 'net_30', salesRepId: id.rep, taxRateId: id.tax, memo: 'inv memo' })
      .returning();
    await t.db.insert(invoiceLines).values({ invoiceId: inv.id, itemId: id.widget, quantity: '2', rate: '10', amount: '20', lineOrder: 0 });
    const r = await getSmartDefaults(ctx, { form: 'sales_order', customerId: c });
    expect(r.source?.form).toBe('invoice');
    expect(r.header).toEqual({ terms: null, salesRepId: null, classId: null, taxRateId: id.tax, memo: null });
    expect(r.lines).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Check numbers per bank account
  // ---------------------------------------------------------------------------

  describe('next check number per bank account', () => {
    it('starts at 1001 on an account with no numbered checks', async () => {
      const [chk] = await t.db.select().from(accounts).where(eq(accounts.id, t.acct['1000']));
      const [acct] = await t.db
        .insert(accounts)
        .values({ companyId: ctx.companyId, code: '1020', name: 'Fresh Bank', type: chk.type, subtype: chk.subtype })
        .returning();
      expect(await nextCheckNumber(ctx, acct.id)).toBe('1001');
    });

    it('is max + 1 per account (gaps are not back-filled; other accounts do not count)', async () => {
      await addExpense(null, 'check', '2026-07-01', { paymentAccountId: id.bank2, reference: '2001' });
      await addExpense(null, 'check', '2026-07-02', { paymentAccountId: id.bank2, reference: '2005' }); // gap 2002-2004
      await addExpense(null, 'check', '2026-07-03', { paymentAccountId: t.acct['1000'], reference: '9000' });
      expect(await nextCheckNumber(ctx, id.bank2)).toBe('2006');
      const r = await getSmartDefaults(ctx, { form: 'check', paymentAccountId: id.bank2 });
      expect(r.nextCheckNumber).toBe('2006');
    });

    it('reads typed suffixes (2006A counts as 2006) and ignores non-numeric / long references', async () => {
      await addExpense(null, 'check', '2026-07-04', { paymentAccountId: id.bank2, reference: '2006A' });
      await addExpense(null, 'check', '2026-07-05', { paymentAccountId: id.bank2, reference: 'EFT' });
      await addExpense(null, 'check', '2026-07-06', { paymentAccountId: id.bank2, reference: '4455667788990' });
      expect(await nextCheckNumber(ctx, id.bank2)).toBe('2007');
    });

    it('card / cash / EFT references on the account are not check numbers; bill-payment checks are', async () => {
      await addExpense(null, 'ach', '2026-07-07', { paymentAccountId: id.bank2, reference: '8000' });
      await addExpense(null, 'cash', '2026-07-08', { paymentAccountId: id.bank2, reference: '8001' });
      expect(await nextCheckNumber(ctx, id.bank2)).toBe('2007');
      const v = await vendor('Paid By Check');
      await t.db.insert(billPayments).values({
        companyId: ctx.companyId,
        vendorId: v,
        date: d('2026-07-09'),
        amount: '10',
        method: 'check',
        reference: '2010',
        paymentAccountId: id.bank2,
      });
      expect(await nextCheckNumber(ctx, id.bank2)).toBe('2011');
    });
  });

  // ---------------------------------------------------------------------------
  // Preferences, scoping, permissions
  // ---------------------------------------------------------------------------

  it("My Preferences 'Recall the last transaction' off disables recall (check number still offered)", async () => {
    const v = await vendor('Pref Vendor');
    await addExpense(v, 'check', '2026-08-01', { reference: '5', memo: 'x' }, [{ accountId: t.acct['6300'], amount: '5' }]);
    const [u] = await t.db.insert(users).values({ email: `pref-${Date.now()}@test.local`, name: 'pref', passwordHash: 'x' }).returning();
    const { userCompanies } = await import('@/lib/db/schema');
    await t.db.insert(userCompanies).values({ userId: u.id, companyId: ctx.companyId, role: 'admin' });
    const other: ServiceContext = { db: t.db, companyId: ctx.companyId, userId: u.id };
    await updateMyPreferences(other, { autoRecallLastTransaction: false });

    const off = await getSmartDefaults(other, { form: 'check', vendorId: v, paymentAccountId: t.acct['1000'] });
    expect(off.recallEnabled).toBe(false);
    expect(off.source).toBeNull();
    expect(off.lines).toEqual([]);
    expect(off.nextCheckNumber).toMatch(/^\d+$/);
    // Per user: the owner still recalls.
    expect((await getSmartDefaults(ctx, { form: 'check', vendorId: v })).source).not.toBeNull();
  });

  it("Preferences > Checking 'Autofill' off disables recall on checks / expenses / card charges but not bills", async () => {
    const v = await vendor('Autofill Vendor');
    await addExpense(v, 'check', '2026-08-02', { reference: '6' }, [{ accountId: t.acct['6300'], amount: '5' }]);
    await addBill(v, '2026-08-03', {}, [{ accountId: t.acct['6300'], amount: '5' }]);
    await updateCompany(ctx, { settings: { autofillPayeeAccount: false } });
    try {
      expect((await getSmartDefaults(ctx, { form: 'check', vendorId: v })).recallEnabled).toBe(false);
      expect((await getSmartDefaults(ctx, { form: 'bill', vendorId: v })).source?.form).toBe('bill');
    } finally {
      await updateCompany(ctx, { settings: { autofillPayeeAccount: true } });
    }
  });

  it("is company-scoped: another company's vendor / customer / bank account is refused", async () => {
    const [u] = await t.db.insert(users).values({ email: `other-${Date.now()}@test.local`, name: 'o', passwordHash: 'x' }).returning();
    const otherCo = await createCompany(t.db, { name: 'Other Co', ownerId: u.id });
    const octx: ServiceContext = { db: t.db, companyId: otherCo.id, userId: u.id };
    const v = await vendor('Secret Vendor');
    const c = await customer('Secret Customer');
    await addBill(v, '2026-08-04', { memo: 'secret' }, [{ accountId: t.acct['6300'], amount: '5' }]);
    await expect(getSmartDefaults(octx, { form: 'bill', vendorId: v })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(getSmartDefaults(octx, { form: 'invoice', customerId: c })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(getSmartDefaults(octx, { form: 'check', paymentAccountId: t.acct['1000'] })).rejects.toMatchObject({ code: 'VALIDATION' });
    // A customer id on a vendor form is not accepted as a vendor.
    await expect(getSmartDefaults(ctx, { form: 'bill', vendorId: c })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it("needs view access to the form's area", async () => {
    const access = fullAccess();
    const noBanking = { ...access, permissions: { ...access.permissions, banking: [] } };
    const limited: ServiceContext = { ...ctx, access: noBanking };
    await expect(getSmartDefaults(limited, { form: 'check' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(getSmartDefaults(limited, { form: 'bill' })).resolves.toMatchObject({ form: 'bill' });
  });

  it('refuses an unknown form type', async () => {
    await expect(getSmartDefaults(ctx, { form: 'payroll' as never })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
