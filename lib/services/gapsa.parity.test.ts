/**
 * Parity gaps (team gapsa): B3 Other Names as payees / journal names, B12 price levels on credit
 * memos + the customer form, G1 opening quantity on hand through Add/Edit Multiple, IIF and CSV.
 * Hermetic PGlite company file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import {
  accounts,
  creditMemoLines,
  expenses,
  inventoryLayers,
  items,
  journalEntries,
  journalEntryLines,
  users,
  vendors,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer, getCustomer, updateCustomer } from './customers';
import { fullAccess } from '@/lib/permissions/model';
import { createItem } from './items';
import { trialBalance } from './reports';
import { createExpense, getExpense, listExpenses, updateExpense } from './expenses';
import { checkPrintData, listPrintQueue } from './printQueue';
import { createManualEntry, getEntry } from './journal';
import { fetchGlLines, loadAccountMeta } from './reportEngine';
import { createEntry, listEntries, updateEntry } from './lists/simpleLists';
import { activeOrSelected, otherNameLabel, visibleOtherNames } from '@/lib/lists/otherNameOptions';
import { mergeOtherNames } from './lists/mergeLists';
import { createCreditMemo, getCreditMemo } from './creditMemos';
import { assignCustomerPricing, createPriceLevel } from './pricing';
import { setCustomerPrice } from './customerPricing';
import { bulkSave } from './lists/bulk';
import { importIIF, importItemsCSV } from './qbImport';
import { createItemWithOpeningStock } from './lists/openingStock';
import { createExpenseSchema } from '@/lib/validation/expenses';
import { createCreditMemoSchema } from '@/lib/validation/creditMemos';
import { createCustomerSchema } from '@/lib/validation/customers';
import { BULK_COLUMNS, parseDateCell } from '@/lib/lists/bulk';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-gapsa-parity-k3v8');
let db: DB;
let ctx: ServiceContext;
let other: ServiceContext;
let acct: Record<string, string>;

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function assertBooksBalance(c: ServiceContext = ctx) {
  const tb = await trialBalance(c);
  expect(tb.balanced).toBe(true);
}

async function entryLines(entryId: string) {
  return db
    .select({ accountId: journalEntryLines.accountId, debit: journalEntryLines.debit, credit: journalEntryLines.credit })
    .from(journalEntryLines)
    .where(eq(journalEntryLines.journalEntryId, entryId));
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'gapsa@parity.local', name: 'Gap', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Gapsa Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const company2 = await createCompany(db, { name: 'Other Co', ownerId: user.id });
  other = { db, companyId: company2.id, userId: user.id };
  const rows = await db.select().from(accounts).where(eq(accounts.companyId, company.id));
  acct = Object.fromEntries(rows.map((r) => [r.code, r.id]));
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// B3 — Other Names
// ---------------------------------------------------------------------------

describe('B3 Other Names as payees and journal names', () => {
  let waterId: string;
  let ownerId: string;

  beforeAll(async () => {
    const water = await createEntry(ctx, 'other-names', {
      name: 'City Water Dept',
      accountNumber: 'ACC-778',
      address: { line1: '1 Main St', city: 'Springfield', state: 'IL', zip: '62701' },
    });
    waterId = String(water.id);
    const owner = await createEntry(ctx, 'other-names', { name: 'Pat Owner' });
    ownerId = String(owner.id);
  });

  it('writes a check to an Other Names entry, stores the link and keeps the books balanced', async () => {
    const exp = await createExpense(ctx, {
      otherNameId: waterId,
      date: d('2026-03-01'),
      method: 'check',
      reference: '501',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6600'], amount: '82.15', description: 'Water bill' }],
    });
    expect(exp.otherNameId).toBe(waterId);
    expect(exp.vendorId).toBeNull();
    expect(exp.payeeName).toBe('City Water Dept');
    const full = await getExpense(ctx, exp.id);
    expect(full.otherNameId).toBe(waterId);
    await assertBooksBalance();
  });

  it('prints the other name and its account number on the memo line when the memo is blank', async () => {
    const exp = await createExpense(ctx, {
      otherNameId: waterId,
      date: d('2026-03-02'),
      method: 'check',
      toPrint: true,
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6600'], amount: '10.00' }],
    });
    const data = await checkPrintData(ctx, 'expense', exp.id);
    expect(data.payee).toBe('City Water Dept');
    expect(data.memo).toBe('Acct # ACC-778');
    expect(data.payeeAddress).toEqual(['1 Main St', 'Springfield, IL 62701']);
    const queued = (await listPrintQueue(ctx)).find((q) => q.id === exp.id);
    expect(queued?.payee).toBe('City Water Dept');
    expect(queued?.memo).toBe('Acct # ACC-778');

    // A typed memo wins over the account number.
    const withMemo = await createExpense(ctx, {
      otherNameId: waterId,
      date: d('2026-03-02'),
      method: 'check',
      memo: 'March service',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6600'], amount: '11.00' }],
    });
    expect((await checkPrintData(ctx, 'expense', withMemo.id)).memo).toBe('March service');
  });

  it('keeps the existing vendor behaviour: vendor account number on a blank memo', async () => {
    const [v] = await db
      .insert(vendors)
      .values({ companyId: ctx.companyId, displayName: 'Power Co', accountNumber: 'PW-1', printOnCheckAs: 'Power Company Inc' })
      .returning();
    const exp = await createExpense(ctx, {
      vendorId: v.id,
      date: d('2026-03-03'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6600'], amount: '40.00' }],
    });
    const data = await checkPrintData(ctx, 'expense', exp.id);
    expect(data.payee).toBe('Power Company Inc');
    expect(data.memo).toBe('Acct # PW-1');
  });

  it('works on cash expenses and credit card charges, lists the name and filters by it', async () => {
    const cc = await createExpense(ctx, {
      otherNameId: ownerId,
      date: d('2026-03-04'),
      method: 'credit_card',
      paymentAccountId: acct['2100'],
      lines: [{ accountId: acct['6300'], amount: '25.00' }],
    });
    const cash = await createExpense(ctx, {
      otherNameId: ownerId,
      date: d('2026-03-04'),
      method: 'cash',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '5.00' }],
    });
    const listed = await listExpenses(ctx, { otherNameId: ownerId });
    expect(listed.map((e) => e.id).sort()).toEqual([cc.id, cash.id].sort());
    expect(listed.every((e) => e.otherName === 'Pat Owner')).toBe(true);
    await assertBooksBalance();
  });

  it('shows the other name in the register / general ledger Name column (and follows a rename)', async () => {
    await updateEntry(ctx, 'other-names', waterId, { name: 'City Water Department' });
    const meta = await loadAccountMeta(ctx);
    const { lines } = await fetchGlLines(ctx, meta, { accountIds: [acct['1000']] });
    const named = lines.filter((l) => l.nameId === waterId);
    expect(named.length).toBeGreaterThan(0);
    expect(named.every((l) => l.nameType === 'other' && l.name === 'City Water Department')).toBe(true);
    // The printed check uses the current list name too.
    const [first] = await listExpenses(ctx, { otherNameId: waterId });
    expect((await checkPrintData(ctx, 'expense', first.id)).payee).toBe('City Water Department');
  });

  it('refuses a vendor and an other name together, another company\'s name, and an inactive name', async () => {
    const base = {
      date: d('2026-03-05'),
      method: 'check' as const,
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '1.00' }],
    };
    const [v] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'Both Vendor' }).returning();
    await expect(createExpense(ctx, { ...base, vendorId: v.id, otherNameId: ownerId })).rejects.toMatchObject({ code: 'VALIDATION' });
    const foreign = await createEntry(other, 'other-names', { name: 'Foreign Name' });
    await expect(createExpense(ctx, { ...base, otherNameId: String(foreign.id) })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const gone = await createEntry(ctx, 'other-names', { name: 'Old Landlord', isActive: false });
    await expect(createExpense(ctx, { ...base, otherNameId: String(gone.id) })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('edits a check from an other name to a vendor and back (link and audit follow)', async () => {
    const exp = await createExpense(ctx, {
      otherNameId: ownerId,
      date: d('2026-03-06'),
      method: 'check',
      reference: '777',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '12.00' }],
    });
    const [v] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'Swap Vendor' }).returning();
    const toVendor = await updateExpense(ctx, exp.id, {
      vendorId: v.id,
      date: d('2026-03-06'),
      method: 'check',
      reference: '777',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '12.00' }],
    });
    expect(toVendor.vendorId).toBe(v.id);
    expect(toVendor.otherNameId).toBeNull();
    const back = await updateExpense(ctx, exp.id, {
      otherNameId: ownerId,
      date: d('2026-03-06'),
      method: 'check',
      reference: '777',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '12.00' }],
    });
    expect(back.otherNameId).toBe(ownerId);
    expect(back.payeeName).toBe('Pat Owner');
    await assertBooksBalance();
  });

  it('names an Other Names entry on a journal entry line and resolves it', async () => {
    const entry = await createManualEntry(ctx, {
      date: d('2026-03-07'),
      description: 'Owner reimbursement',
      lines: [
        { accountId: acct['6300'], debit: '30.00', entityType: 'other', entityId: ownerId },
        { accountId: acct['1000'], credit: '30.00' },
      ],
    });
    const detail = await getEntry(ctx, entry.id);
    const named = detail.lines.find((l) => l.entityType === 'other');
    expect(named?.entityName).toBe('Pat Owner');
    const meta = await loadAccountMeta(ctx);
    const { lines } = await fetchGlLines(ctx, meta, { accountIds: [acct['6300']] });
    expect(lines.find((l) => l.entryId === entry.id)?.name).toBe('Pat Owner');

    const inactive = await createEntry(ctx, 'other-names', { name: 'Retired Name', isActive: false });
    await expect(
      createManualEntry(ctx, {
        date: d('2026-03-07'),
        description: 'Inactive name',
        lines: [
          { accountId: acct['6300'], debit: '1.00', entityType: 'other', entityId: String(inactive.id) },
          { accountId: acct['1000'], credit: '1.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('merging other names moves checks and journal line names onto the kept name', async () => {
    const dup = await createEntry(ctx, 'other-names', { name: 'P. Owner' });
    const dupId = String(dup.id);
    const exp = await createExpense(ctx, {
      otherNameId: dupId,
      date: d('2026-03-08'),
      method: 'cash',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '3.00' }],
    });
    const je = await createManualEntry(ctx, {
      date: d('2026-03-08'),
      description: 'Dup name line',
      lines: [
        { accountId: acct['6300'], debit: '2.00', entityType: 'other', entityId: dupId },
        { accountId: acct['1000'], credit: '2.00' },
      ],
    });
    await mergeOtherNames(ctx, { fromId: dupId, toId: ownerId });
    const [row] = await db.select().from(expenses).where(eq(expenses.id, exp.id));
    expect(row.otherNameId).toBe(ownerId);
    expect(row.payeeName).toBe('Pat Owner');
    const lines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, je.id));
    expect(lines.find((l) => l.entityType === 'other')?.entityId).toBe(ownerId);
    await assertBooksBalance();
  });

  it('API schema accepts an otherNameId payee and refuses it together with a vendor', () => {
    const base = {
      date: '2026-03-01',
      method: 'check',
      paymentAccountId: '00000000-0000-4000-8000-000000000001',
      lines: [{ accountId: '00000000-0000-4000-8000-000000000002', amount: '1.00' }],
    };
    expect(createExpenseSchema.safeParse({ ...base, otherNameId: '00000000-0000-4000-8000-000000000003' }).success).toBe(true);
    expect(
      createExpenseSchema.safeParse({
        ...base,
        otherNameId: '00000000-0000-4000-8000-000000000003',
        vendorId: '00000000-0000-4000-8000-000000000004',
      }).success,
    ).toBe(false);
    expect(createExpenseSchema.safeParse(base).success).toBe(false);
  });

  it('pickers still show a saved payee / journal name that has since been made inactive', async () => {
    const landlord = await createEntry(ctx, 'other-names', { name: 'Former Landlord' });
    const landlordId = String(landlord.id);
    const checkInput = {
      date: d('2026-03-06'),
      method: 'check' as const,
      paymentAccountId: acct['1000'],
      otherNameId: landlordId,
      lines: [{ accountId: acct['6300'], amount: '9.00' }],
    };
    const check = await createExpense(ctx, checkInput);
    await updateEntry(ctx, 'other-names', landlordId, { isActive: false });

    // What the pickers load: /api/lists/other-names?includeInactive=true
    const entries = (await listEntries(ctx, 'other-names', { includeInactive: true })).map((e) => ({
      id: String(e.id),
      name: String(e.name),
      isActive: e.isActive,
    }));
    // Check form editing that check: the inactive payee is offered, labelled, so the select shows it.
    const saved = await getExpense(ctx, check.id);
    const forCheck = visibleOtherNames(entries, saved.otherNameId);
    expect(forCheck.find((o) => o.id === landlordId)?.label).toBe('Former Landlord — inactive');
    expect(forCheck.find((o) => o.id === ownerId)?.label).toBe('Pat Owner');
    // A new check: inactive names are not offered.
    expect(visibleOtherNames(entries, null).some((o) => o.id === landlordId)).toBe(false);
    expect(visibleOtherNames(entries, ownerId).some((o) => o.id === landlordId)).toBe(false);
    // The server still accepts saving the check with its (now inactive) payee unchanged.
    const resaved = await updateExpense(ctx, check.id, { ...checkInput, memo: 'still the landlord' });
    expect(resaved.otherNameId).toBe(landlordId);

    // Journal Name column: same rule per line.
    const journalOpts = entries.map((e) => ({
      value: `other:${e.id}`,
      label: otherNameLabel(e),
      inactive: e.isActive === false,
    }));
    expect(activeOrSelected(journalOpts, `other:${landlordId}`).map((o) => o.label)).toContain('Former Landlord — inactive');
    expect(activeOrSelected(journalOpts, '').some((o) => o.value === `other:${landlordId}`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B12 — Price levels on credit memos + the customer form
// ---------------------------------------------------------------------------

describe('B12 price levels on credit memos and the customer form', () => {
  let widgetId: string;
  let levelId: string;

  beforeAll(async () => {
    const widget = await createItem(ctx, { name: 'Gadget', type: 'service', salesPrice: '100.00', incomeAccountId: acct['4000'] });
    widgetId = widget.id;
    const level = await createPriceLevel(ctx, { name: 'Wholesale', type: 'fixed_percent', percent: -10 });
    levelId = level.id;
  });

  it('sets the price level on the customer form (create and edit) and refuses another company\'s level', async () => {
    const created = await createCustomer(ctx, { displayName: 'Level On Create', priceLevelId: levelId });
    expect(created.priceLevelId).toBe(levelId);
    const plain = await createCustomer(ctx, { displayName: 'Level On Edit' });
    const edited = await updateCustomer(ctx, plain.id, { priceLevelId: levelId });
    expect(edited.priceLevelId).toBe(levelId);
    const cleared = await updateCustomer(ctx, plain.id, { priceLevelId: null });
    expect(cleared.priceLevelId).toBeNull();
    const untouched = await updateCustomer(ctx, created.id, { notes: 'keeps level' });
    expect(untouched.priceLevelId).toBe(levelId);
    const foreign = await createPriceLevel(other, { name: 'Theirs', type: 'fixed_percent', percent: -50 });
    await expect(updateCustomer(ctx, plain.id, { priceLevelId: foreign.id })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(createCustomerSchema.safeParse({ displayName: 'x', priceLevelId: levelId }).success).toBe(true);
  });

  it('only users with Advanced Pricing access (lists view) can set or clear a customer price level', async () => {
    const full = fullAccess();
    const noPricing: ServiceContext = {
      ...ctx,
      access: { ...full, isAdmin: false, permissions: { ...full.permissions, lists: [] } },
    };
    const withPricing: ServiceContext = { ...ctx, access: full };
    // Create: refused with a level, fine without one.
    await expect(createCustomer(noPricing, { displayName: 'No Pricing Create', priceLevelId: levelId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const c = await createCustomer(noPricing, { displayName: 'No Pricing Plain' });
    // Edit: setting and clearing refused; other fields and resending the same value are fine.
    await expect(updateCustomer(noPricing, c.id, { priceLevelId: levelId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await updateCustomer(noPricing, c.id, { notes: 'ok', priceLevelId: null })).notes).toBe('ok');
    await updateCustomer(withPricing, c.id, { priceLevelId: levelId });
    await expect(updateCustomer(noPricing, c.id, { priceLevelId: null })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const same = await updateCustomer(noPricing, c.id, { priceLevelId: levelId, notes: 'same level' });
    expect(same.priceLevelId).toBe(levelId);
    expect((await getCustomer(ctx, c.id)).priceLevelId).toBe(levelId);
  });

  it('applies the same lists-view rule on the Advanced Pricing route (PATCH /api/pricing/customers/:id)', async () => {
    const full = fullAccess();
    const noPricing: ServiceContext = {
      ...ctx,
      access: { ...full, isAdmin: false, permissions: { ...full.permissions, lists: [] } },
    };
    const withPricing: ServiceContext = { ...ctx, access: full };
    const c = await createCustomer(ctx, { displayName: 'Pricing Route Customer' });
    // Setting a level: refused without lists view.
    await expect(assignCustomerPricing(noPricing, c.id, { priceLevelId: levelId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await getCustomer(ctx, c.id)).priceLevelId).toBeNull();
    // Resending the current (empty) value or omitting it passes.
    await assignCustomerPricing(noPricing, c.id, { priceLevelId: null });
    await assignCustomerPricing(noPricing, c.id, {});
    // With lists view: set works; then clearing without lists view is refused.
    expect((await assignCustomerPricing(withPricing, c.id, { priceLevelId: levelId })).priceLevelId).toBe(levelId);
    await expect(assignCustomerPricing(noPricing, c.id, { priceLevelId: null })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await assignCustomerPricing(noPricing, c.id, { priceLevelId: levelId })).priceLevelId).toBe(levelId);
    expect((await getCustomer(ctx, c.id)).priceLevelId).toBe(levelId);
  });

  it('prices a credit memo line from the customer\'s price level server-side and records provenance', async () => {
    const cust = await createCustomer(ctx, { displayName: 'Wholesale Buyer', priceLevelId: levelId });
    const cm = await createCreditMemo(ctx, {
      customerId: cust.id,
      date: d('2026-04-01'),
      lines: [{ itemId: widgetId, quantity: '2' }],
    });
    expect(cm.total).toBe('180.00');
    const [line] = await db.select().from(creditMemoLines).where(eq(creditMemoLines.creditMemoId, cm.id));
    expect(line.rate).toBe('90.0000');
    expect((line.pricing as { source?: string; priceLevelId?: string }).source).toBe('price_level');
    expect((line.pricing as { priceLevelId?: string }).priceLevelId).toBe(levelId);
    const detail = await getCreditMemo(ctx, cm.id);
    expect(detail.lines[0].pricing).toBeTruthy();
    await assertBooksBalance();
  });

  it('keeps a typed rate as a manual override (flagged) and ignores levels for a customer without one', async () => {
    const cust = await createCustomer(ctx, { displayName: 'Override Buyer', priceLevelId: levelId });
    const cm = await createCreditMemo(ctx, {
      customerId: cust.id,
      date: d('2026-04-02'),
      lines: [{ itemId: widgetId, quantity: '1', rate: '95' }],
    });
    const [line] = await db.select().from(creditMemoLines).where(eq(creditMemoLines.creditMemoId, cm.id));
    expect(line.rate).toBe('95.0000');
    expect((line.pricing as { overridden?: boolean; expectedPrice?: string }).overridden).toBe(true);
    expect((line.pricing as { expectedPrice?: string }).expectedPrice).toBe('90.00');

    const regular = await createCustomer(ctx, { displayName: 'Regular Buyer' });
    const cm2 = await createCreditMemo(ctx, { customerId: regular.id, date: d('2026-04-02'), lines: [{ itemId: widgetId, quantity: '1' }] });
    expect(cm2.total).toBe('100.00');
  });

  it('legacy customer-specific prices go through the same engine (lowest price wins by default)', async () => {
    const cust = await createCustomer(ctx, { displayName: 'Special Price Buyer', priceLevelId: levelId });
    await setCustomerPrice(ctx, { customerId: cust.id, itemId: widgetId, price: '85.00' });
    const cm = await createCreditMemo(ctx, { customerId: cust.id, date: d('2026-04-03'), lines: [{ itemId: widgetId, quantity: '1' }] });
    const [line] = await db.select().from(creditMemoLines).where(eq(creditMemoLines.creditMemoId, cm.id));
    expect(line.rate).toBe('85.0000');
    expect((line.pricing as { source?: string }).source).toBe('customer_price');
  });

  it('credit memo API schema lets item lines omit the rate', () => {
    expect(
      createCreditMemoSchema.safeParse({
        customerId: '00000000-0000-4000-8000-000000000001',
        date: '2026-04-01',
        lines: [{ itemId: '00000000-0000-4000-8000-000000000002', quantity: '1' }],
      }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// G1 — Opening quantity on hand via Add/Edit Multiple, IIF and CSV
// ---------------------------------------------------------------------------

describe('G1 opening quantity on hand and value', () => {
  async function itemByName(name: string) {
    const [row] = await db.select().from(items).where(and(eq(items.companyId, ctx.companyId), eq(items.name, name)));
    return row;
  }
  async function openingEntry(itemId: string) {
    const [e] = await db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, `item:${itemId}`)));
    return e;
  }

  it('date cells: ISO and US formats, invalid dates refused', () => {
    expect(parseDateCell('2026-01-31')?.toISOString().slice(0, 10)).toBe('2026-01-31');
    expect(parseDateCell('1/31/2026')?.toISOString().slice(0, 10)).toBe('2026-01-31');
    expect(parseDateCell('01/31/26')?.toISOString().slice(0, 10)).toBe('2026-01-31');
    expect(parseDateCell('2/30/2026')).toBeNull();
    expect(parseDateCell('soon')).toBeNull();
    expect(parseDateCell('')).toBeNull();
    const keys = BULK_COLUMNS.items.filter((c) => c.newOnly).map((c) => c.key);
    expect(keys).toEqual(['openingQuantity', 'openingValue', 'openingAsOf']);
  });

  it('Add/Edit Multiple: posts Dr Inventory Asset / Cr Opening Balance Equity (average cost, no FIFO layer)', async () => {
    const res = await bulkSave(ctx, 'items', [
      { name: 'Bulk Bolt', type: 'inventory', salesPrice: '2.00', openingQuantity: '100', openingValue: '125.00', openingAsOf: '1/15/2026' },
      { name: 'Bulk Nut', type: 'inventory', purchaseCost: '0.40', openingQuantity: '50', openingAsOf: '2026-01-15' },
      { name: 'Bulk Service', type: 'service', salesPrice: '10' },
    ]);
    expect(res.errors).toEqual([]);
    expect(res.saved).toBe(true);
    const bolt = await itemByName('Bulk Bolt');
    expect(bolt.quantityOnHand).toBe('100.0000');
    expect(bolt.averageCost).toBe('1.2500');
    const entry = await openingEntry(bolt.id);
    expect(entry.date.toISOString().slice(0, 10)).toBe('2026-01-15');
    const lines = await entryLines(entry.id);
    expect(lines.find((l) => l.accountId === acct['1300'])?.debit).toBe('125.00');
    const [obe] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.name, 'Opening Balance Equity')));
    expect(lines.find((l) => l.accountId === obe.id)?.credit).toBe('125.00');
    // Opening stock is average-cost by default (lib/services/lists/openingStock.ts): no FIFO layer,
    // so the item can still be built, counted and revalued.
    expect(await db.select().from(inventoryLayers).where(eq(inventoryLayers.itemId, bolt.id))).toHaveLength(0);

    // Value blank: the item's cost values the stock (50 x 0.40).
    const nut = await itemByName('Bulk Nut');
    const nutLines = await entryLines((await openingEntry(nut.id)).id);
    expect(nutLines.find((l) => l.accountId === acct['1300'])?.debit).toBe('20.00');
    await assertBooksBalance();
  });

  it('Add/Edit Multiple: refuses opening stock on existing rows, non-inventory items, bad cells (all-or-nothing)', async () => {
    const bolt = await itemByName('Bulk Bolt');
    const res = await bulkSave(ctx, 'items', [
      { id: bolt.id, openingQuantity: '5', openingValue: '5' },
      { name: 'Svc With Qty', type: 'service', openingQuantity: '3', openingValue: '3' },
      { name: 'Bad Date', type: 'inventory', openingQuantity: '1', openingValue: '1', openingAsOf: '31/31/2026' },
      { name: 'No Value', type: 'inventory', openingQuantity: '4' },
      { name: 'Would Save', type: 'inventory', openingQuantity: '1', openingValue: '1' },
    ]);
    expect(res.saved).toBe(false);
    expect(res.errors.map((e) => [e.row, e.field])).toEqual([
      [0, 'openingQuantity'],
      [1, 'openingQuantity'],
      [2, 'openingAsOf'],
      [3, 'openingValue'],
    ]);
    expect(await itemByName('Would Save')).toBeUndefined();
    expect((await itemByName('Bulk Bolt')).quantityOnHand).toBe('100.0000');
    await assertBooksBalance();
  });

  it('CSV import: quantity, total value (or cost) and as-of date become opening stock', async () => {
    const csv = [
      'Name,Type,Cost,Qty,Value,AsOf',
      'Csv Widget,Inventory Part,3.00,10,35.00,2026-02-01',
      'Csv Gizmo,Inventory Part,1.50,4,,',
      'Csv Labor,Service,,,,',
      'Csv Broken,Inventory Part,,abc,,',
    ].join('\n');
    const counts = await importItemsCSV(ctx, csv, {
      name: 'Name',
      type: 'Type',
      purchaseCost: 'Cost',
      quantityOnHand: 'Qty',
      totalValue: 'Value',
      asOfDate: 'AsOf',
    });
    expect(counts.items).toBe(4);
    expect(counts.openingStock).toEqual({ items: 2, value: '41.00' });
    const widget = await itemByName('Csv Widget');
    expect(widget.quantityOnHand).toBe('10.0000');
    const e = await openingEntry(widget.id);
    expect(e.date.toISOString().slice(0, 10)).toBe('2026-02-01');
    expect((await itemByName('Csv Gizmo')).quantityOnHand).toBe('4.0000');
    expect(Number((await itemByName('Csv Broken')).quantityOnHand ?? 0)).toBe(0);
    expect(counts.issues.some((i) => i.name === 'Csv Broken' && /not a number/.test(i.message))).toBe(true);
    await assertBooksBalance();
  });

  it('IIF import: INVITEM QNTY with COST / VALUE posts opening stock dated before the first transaction', async () => {
    const iif = [
      '!INVITEM\tNAME\tINVITEMTYPE\tCOST\tQNTY\tVALUE',
      'INVITEM\tIif Pump\tPART\t20.00\t3\t',
      'INVITEM\tIif Valve\tPART\t5.00\t8\t44.00',
      'INVITEM\tIif Fee\tSERV\t\t2\t',
    ].join('\r\n');
    const counts = await importIIF(ctx, iif);
    expect(counts.openingStock).toEqual({ items: 2, value: '104.00' });
    expect((await itemByName('Iif Pump')).quantityOnHand).toBe('3.0000');
    expect((await itemByName('Iif Valve')).averageCost).toBe('5.5000');
    expect(counts.issues.some((i) => i.name === 'Iif Fee' && /only inventory items/.test(i.message))).toBe(true);
    await assertBooksBalance();
  });

  it('IIF import: no double count when the file already carries the inventory asset balance', async () => {
    const iif = [
      '!ACCNT\tNAME\tACCNTTYPE\tOBAMOUNT',
      'ACCNT\tIif Stock\tOCASSET\t500.00',
      '!INVITEM\tNAME\tINVITEMTYPE\tCOST\tQNTY\tASSETACCNT',
      'INVITEM\tIif Carried\tPART\t50.00\t10\tIif Stock',
    ].join('\r\n');
    const counts = await importIIF(ctx, iif);
    const carried = await itemByName('Iif Carried');
    expect(carried).toBeDefined();
    // The stock itself arrives (quantity, average cost; average-cost item, so no FIFO layer)...
    expect(carried.quantityOnHand).toBe('10.0000');
    expect(carried.averageCost).toBe('50.0000');
    const layers = await db.select().from(inventoryLayers).where(eq(inventoryLayers.itemId, carried.id));
    expect(layers).toHaveLength(0);
    // ...but no journal entry: the ledger already carries the 500.00 through the account's OBAMOUNT.
    expect(await openingEntry(carried.id)).toBeUndefined();
    expect(counts.openingStock).toEqual({ items: 1, value: '500.00', unposted: 1 });
    expect(counts.issues.some((i) => i.name === 'Iif Carried' && /without a journal entry/.test(i.message))).toBe(true);
    const stockAcct = (await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.name, 'Iif Stock'))))[0];
    const stockLines = await db.select().from(journalEntryLines).where(eq(journalEntryLines.accountId, stockAcct.id));
    const stockBalance = stockLines.reduce((s, l) => s + Number(l.debit ?? 0) - Number(l.credit ?? 0), 0);
    expect(stockBalance).toBe(500); // counted once: valuation (10 x 50) == ledger
    await assertBooksBalance();
  });

  it('createItemWithOpeningStock({ postToLedger: false }) sets the stock without posting', async () => {
    const { item, opening } = await createItemWithOpeningStock(
      ctx,
      { name: 'Carried Direct', type: 'inventory', openingQuantity: '4', openingValue: '10.00', openingAsOf: d('2026-01-05') },
      { postToLedger: false },
    );
    expect(item.quantityOnHand).toBe('4.0000');
    expect(opening?.entryId).toBeNull();
    expect(await openingEntry(item.id)).toBeUndefined();
    await assertBooksBalance();
  });
});
