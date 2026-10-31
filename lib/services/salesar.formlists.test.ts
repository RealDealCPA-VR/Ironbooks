/**
 * Team salesar — the sales forms' QuickBooks list fields, client side and API pass-through:
 *  B9  the per-line Sales Tax Code column (lib/salesFormListsClient.ts): the default code of a
 *      picked item, the code a saved line shows, the live tax the form previews, and the payload —
 *      which must give the same tax the server saves;
 *  B8  the Customer Message picker (choices and payload);
 *  B7  the Sales Receipt Payment Method picker and Make Deposits' "View payment method type".
 * Route tests: the create / update API routes of invoices, sales receipts, credit memos,
 * estimates and sales orders pass customerMessageId and each line's salesTaxCodeId (and the sales
 * receipt's paymentMethodId) through to the services; Payments to Deposit names the entry.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, items, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer, updateCustomer } from './customers';
import { getInvoice } from './invoices';
import { getSalesReceipt } from './salesReceipts';
import { getCreditMemo } from './creditMemos';
import { getEstimate } from './estimates';
import { getSalesOrder } from './salesOrders';
import { createTaxRate } from './salesTax';
import { createEntry, listEntries } from './lists/simpleLists';
import { previewSalesTotals } from '@/lib/salesLineMath';
import {
  type DepositMethodItem,
  type PaymentMethodEntry,
  type TaxCodeEntry,
  customerMessageChoices,
  customerMessagePayload,
  defaultPaymentMethodValue,
  depositMethodLabel,
  depositMethodViews,
  filledLineTaxCode,
  itemLineTaxCode,
  lineTaxPayload,
  matchesDepositMethodView,
  paymentMethodChoices,
  paymentMethodDisplay,
  paymentMethodPayload,
  paymentMethodValue,
  shownLineTaxCode,
  standardTaxCode,
  taxCodeChoices,
  withShownTaxable,
} from '@/lib/salesFormListsClient';

let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));
import { POST as invoicesPOST } from '@/app/api/invoices/route';
import { PUT as invoicePUT } from '@/app/api/invoices/[id]/route';
import { POST as salesReceiptsPOST } from '@/app/api/sales-receipts/route';
import { PUT as salesReceiptPUT } from '@/app/api/sales-receipts/[id]/route';
import { POST as creditMemosPOST } from '@/app/api/credit-memos/route';
import { PUT as creditMemoPUT } from '@/app/api/credit-memos/[id]/route';
import { POST as estimatesPOST } from '@/app/api/estimates/route';
import { PATCH as estimatePATCH } from '@/app/api/estimates/[id]/route';
import { POST as salesOrdersPOST } from '@/app/api/sales-orders/route';
import { PUT as salesOrderPUT } from '@/app/api/sales-orders/[id]/route';
import { GET as undepositedGET } from '@/app/api/deposits/undeposited/route';

// ---------------------------------------------------------------------------
// Pure: lib/salesFormListsClient.ts
// ---------------------------------------------------------------------------

const TAX: TaxCodeEntry = { id: 'c-tax', code: 'Tax', taxable: true, isActive: true };
const NON: TaxCodeEntry = { id: 'c-non', code: 'Non', taxable: false, isActive: true };
const OOS: TaxCodeEntry = { id: 'c-oos', code: 'OOS', description: 'Out of state', taxable: false, isActive: true };
const GST: TaxCodeEntry = { id: 'c-gst', code: 'GST', taxable: true, isActive: true };
const OLD: TaxCodeEntry = { id: 'c-old', code: 'Old', taxable: true, isActive: false };
const CODES = [GST, TAX, OOS, NON, OLD];

describe('B9. Sales Tax Code column — the code a line gets and shows', () => {
  it('a picked item defaults the line to its own code, else Tax / Non by its taxable flag', () => {
    expect(itemLineTaxCode({ type: 'service', taxable: false, salesTaxCodeId: OOS.id }, CODES)).toEqual({ salesTaxCodeId: OOS.id, taxable: false });
    expect(itemLineTaxCode({ type: 'service', taxable: true, salesTaxCodeId: GST.id }, CODES)).toEqual({ salesTaxCodeId: GST.id, taxable: true });
    // No code on the item: QB's standard "Tax" / "Non" (not the first code with the flag).
    expect(itemLineTaxCode({ type: 'inventory', taxable: true }, CODES)).toEqual({ salesTaxCodeId: TAX.id, taxable: true });
    expect(itemLineTaxCode({ type: 'service', taxable: false, salesTaxCodeId: null }, CODES)).toEqual({ salesTaxCodeId: NON.id, taxable: false });
    // Subtotal / payment / sales tax items carry no code and are never taxed.
    for (const type of ['subtotal', 'payment', 'sales_tax']) {
      expect(itemLineTaxCode({ type, taxable: true }, CODES)).toEqual({ salesTaxCodeId: '', taxable: false });
    }
    // A discount item does take a code (a taxable discount lowers the taxable base).
    expect(itemLineTaxCode({ type: 'discount', taxable: true }, CODES)).toEqual({ salesTaxCodeId: TAX.id, taxable: true });
    // No item (a typed line): the standard "Tax" code once the list is there.
    expect(itemLineTaxCode(null, CODES)).toEqual({ salesTaxCodeId: '', taxable: true });
    // The code list not loaded yet: the item's own code is kept, resolved when shown.
    expect(itemLineTaxCode({ type: 'service', taxable: false, salesTaxCodeId: OOS.id }, [])).toEqual({ salesTaxCodeId: OOS.id, taxable: false });
    expect(itemLineTaxCode({ type: 'service', taxable: false }, [])).toEqual({ salesTaxCodeId: '', taxable: false });
  });

  it('a filled-in row (command bar, scan) keeps a stated flag, else takes the item code', () => {
    const nonItem = { type: 'service', taxable: false, salesTaxCodeId: NON.id };
    expect(filledLineTaxCode(nonItem, CODES, undefined)).toEqual({ salesTaxCodeId: NON.id, taxable: false });
    expect(filledLineTaxCode(nonItem, CODES, null)).toEqual({ salesTaxCodeId: NON.id, taxable: false });
    expect(filledLineTaxCode(nonItem, CODES, true)).toEqual({ salesTaxCodeId: '', taxable: true });
    expect(filledLineTaxCode(null, CODES, undefined)).toEqual({ salesTaxCodeId: '', taxable: true });
  });

  it('a line saved before codes (no code) shows the standard code for its taxable flag', () => {
    expect(shownLineTaxCode({ salesTaxCodeId: '', taxable: true }, CODES, null)).toEqual({ salesTaxCodeId: TAX.id, taxable: true });
    expect(shownLineTaxCode({ salesTaxCodeId: null, taxable: false }, CODES, { taxable: true })).toEqual({ salesTaxCodeId: NON.id, taxable: false });
    // A saved code shows as saved, even when made inactive later.
    expect(shownLineTaxCode({ salesTaxCodeId: OLD.id, taxable: true }, CODES, null)).toEqual({ salesTaxCodeId: OLD.id, taxable: true });
    // The code decides, not a stale flag.
    expect(shownLineTaxCode({ salesTaxCodeId: OOS.id, taxable: true }, CODES, null)).toEqual({ salesTaxCodeId: OOS.id, taxable: false });
    // Subtotal / payment lines: no code.
    expect(shownLineTaxCode({ salesTaxCodeId: TAX.id, taxable: true, itemType: 'subtotal' }, CODES, null)).toEqual({ salesTaxCodeId: '', taxable: false });
    // Without the list (no access): what the row holds.
    expect(shownLineTaxCode({ salesTaxCodeId: '', taxable: true }, [], null)).toEqual({ salesTaxCodeId: '', taxable: true });
  });

  it("a non-taxable customer's lines show its non-taxable code (their own, the customer's, else Non)", () => {
    const nonCustomer = { taxable: false, salesTaxCodeId: null };
    expect(shownLineTaxCode({ salesTaxCodeId: TAX.id, taxable: true }, CODES, nonCustomer)).toEqual({ salesTaxCodeId: NON.id, taxable: false });
    expect(shownLineTaxCode({ salesTaxCodeId: OOS.id, taxable: false }, CODES, nonCustomer)).toEqual({ salesTaxCodeId: OOS.id, taxable: false });
    expect(shownLineTaxCode({ salesTaxCodeId: '', taxable: true }, CODES, { taxable: false, salesTaxCodeId: OOS.id })).toEqual({ salesTaxCodeId: OOS.id, taxable: false });
    // Its picker offers the non-taxable codes only.
    expect(taxCodeChoices(CODES, NON.id, nonCustomer).map((c) => c.code)).toEqual(['OOS', 'Non']);
  });

  it('the picker offers the active codes plus the code the line shows (even inactive)', () => {
    expect(taxCodeChoices(CODES, TAX.id, { taxable: true }).map((c) => c.code)).toEqual(['GST', 'Tax', 'OOS', 'Non']);
    expect(taxCodeChoices(CODES, OLD.id, null).map((c) => c.code)).toEqual(['GST', 'Tax', 'OOS', 'Non', 'Old']);
    // The standard code ignores inactive entries and other codes with the same flag.
    expect(standardTaxCode([OLD, GST, TAX], true)?.id).toBe(TAX.id);
    expect(standardTaxCode([OOS], false)?.id).toBe(OOS.id);
  });

  it('the payload sends the code shown and its flag; the live tax follows the code', () => {
    expect(lineTaxPayload({ salesTaxCodeId: '', taxable: true }, CODES, null)).toEqual({ taxable: true, salesTaxCodeId: TAX.id });
    expect(lineTaxPayload({ salesTaxCodeId: OOS.id, taxable: true }, CODES, null)).toEqual({ taxable: false, salesTaxCodeId: OOS.id });
    expect(lineTaxPayload({ salesTaxCodeId: '', taxable: true, itemType: 'payment' }, CODES, null)).toEqual({ taxable: false, salesTaxCodeId: null });
    // No list: no code, the flag (the server then decides from the item's code).
    expect(lineTaxPayload({ salesTaxCodeId: '', taxable: true }, [], null)).toEqual({ taxable: true, salesTaxCodeId: null });

    const rows = [
      { quantity: '1', rate: '100', taxable: true, salesTaxCodeId: TAX.id },
      { quantity: '1', rate: '50', taxable: true, salesTaxCodeId: OOS.id },
    ];
    expect(previewSalesTotals(withShownTaxable(rows, CODES, { taxable: true }), 0.1).tax).toBeCloseTo(10, 2);
    expect(previewSalesTotals(withShownTaxable(rows, CODES, { taxable: false }), 0.1).tax).toBe(0);
    // Unchanged rows are returned as they are (no needless re-render of the form).
    const shown = withShownTaxable(rows, CODES, null);
    expect(shown[0]).toBe(rows[0]);
    expect(shown[1]).not.toBe(rows[1]);
  });
});

describe('B8. Customer Message picker', () => {
  const msgs = [
    { id: 'm1', message: 'Thank you!', isActive: true },
    { id: 'm2', message: 'Old season greeting', isActive: false },
  ];
  it('offers the active messages plus the one the document was saved with', () => {
    expect(customerMessageChoices(msgs, '').map((m) => m.id)).toEqual(['m1']);
    expect(customerMessageChoices(msgs, 'm2').map((m) => m.id)).toEqual(['m1', 'm2']);
  });
  it('sends the picked entry, or null to clear it', () => {
    expect(customerMessagePayload('m1')).toBe('m1');
    expect(customerMessagePayload('')).toBeNull();
    expect(customerMessagePayload(undefined)).toBeNull();
  });
});

describe('B7. Payment Method picker and Make Deposits view', () => {
  const pms: PaymentMethodEntry[] = [
    { id: 'p-cash', name: 'Cash', type: 'cash', isActive: true },
    { id: 'p-visa', name: 'Visa', type: 'credit_card', isActive: true },
    { id: 'p-diners', name: 'Diners', type: 'credit_card', isActive: false },
  ];

  it('a new receipt starts on the "Cash" entry; a saved one shows its entry or bare type', () => {
    expect(defaultPaymentMethodValue(pms)).toBe('pm:p-cash');
    expect(defaultPaymentMethodValue([])).toBe('type:cash');
    expect(paymentMethodValue({ paymentMethodId: 'p-visa', method: 'credit_card' })).toBe('pm:p-visa');
    expect(paymentMethodValue({ paymentMethodId: null, method: 'check' })).toBe('type:check');
  });

  it('lists each active entry with its type, the saved inactive entry, and a bare saved type', () => {
    expect(paymentMethodChoices(pms, 'pm:p-cash').map((c) => c.label)).toEqual(['Cash — Cash', 'Visa — Credit card']);
    expect(paymentMethodChoices(pms, 'pm:p-diners').map((c) => c.value)).toEqual(['pm:p-cash', 'pm:p-visa', 'pm:p-diners']);
    expect(paymentMethodChoices(pms, 'type:check')[0]).toEqual({ value: 'type:check', label: 'Check (no payment method picked)' });
    // The list can't be read: the bare types.
    expect(paymentMethodChoices([], 'type:cash').map((c) => c.value)).toContain('type:credit_card');
  });

  it('sends paymentMethodId (and the entry type) or a bare type; lists show the name', () => {
    expect(paymentMethodPayload('pm:p-visa', pms)).toEqual({ paymentMethodId: 'p-visa', method: 'credit_card' });
    expect(paymentMethodPayload('pm:unknown', pms)).toEqual({ paymentMethodId: 'unknown' });
    expect(paymentMethodPayload('type:check', pms)).toEqual({ paymentMethodId: null, method: 'check' });
    expect(paymentMethodDisplay({ paymentMethodId: 'p-visa', method: 'credit_card' }, pms)).toBe('Visa');
    expect(paymentMethodDisplay({ paymentMethodId: null, method: 'credit_card' }, pms)).toBe('Credit card');
  });

  it('Payments to Deposit: All, Cash and checks, Credit cards and each method, filtered by view', () => {
    const list: DepositMethodItem[] = [
      { id: 'a', method: 'check' },
      { id: 'b', method: 'cash', paymentMethodId: 'p-cash', paymentMethodName: 'Cash' },
      { id: 'c', method: 'credit_card', paymentMethodId: 'p-visa', paymentMethodName: 'Visa' },
      { id: 'd', method: 'credit_card', paymentMethodId: 'p-visa', paymentMethodName: 'Visa' },
      { id: 'e', method: 'ach' },
    ];
    const views = depositMethodViews(list);
    expect(views.map((v) => `${v.label}:${v.count}`)).toEqual([
      'All payment methods:5',
      'Cash and checks:2',
      'Credit cards:2',
      'ACH / e-check:1',
      'Cash:1',
      'Check:1',
      'Visa:2',
    ]);
    const ids = (view: string) => list.filter((p) => matchesDepositMethodView(p, view)).map((p) => p.id);
    expect(ids('all')).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(ids('group:cash_check')).toEqual(['a', 'b']);
    expect(ids('group:credit_card')).toEqual(['c', 'd']);
    expect(ids('pm:p-visa')).toEqual(['c', 'd']);
    expect(ids('type:check')).toEqual(['a']);
    expect(depositMethodLabel(list[2])).toBe('Visa');
    expect(depositMethodLabel(list[0])).toBe('Check');
    // One method only: nothing to tell apart.
    expect(depositMethodViews([list[2], list[3]])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Routes: the five forms' create / update APIs pass the fields through
// ---------------------------------------------------------------------------

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-salesar-formlists');
let db: DB;
let userId: string;
let ctx: ServiceContext;
let acct: Record<string, string> = {};
let seq = 0;
let codes: TaxCodeEntry[];
let tax: string;
let non: string;
let rate: string;

function req(url: string, body: unknown, method = 'POST') {
  const u = new URL(`http://localhost${url}`);
  return Object.assign(
    new Request(u, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    { nextUrl: u },
  ) as never;
}
const params = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

async function ok(res: Response): Promise<{ id: string } & Record<string, unknown>> {
  const json = (await res.json()) as { id: string } & Record<string, unknown>;
  expect(res.status, JSON.stringify(json)).toBeLessThan(300);
  return json;
}

async function item(name: string, extra: Record<string, unknown> = {}) {
  const [it] = await db
    .insert(items)
    .values({ companyId: ctx.companyId, name: `${name} ${seq}`, type: 'service' as never, salesPrice: '100.00', incomeAccountId: acct['4000'], ...extra })
    .returning();
  return it;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'salesar-formlists@test.local', name: 'Salesar', passwordHash: 'x' }).returning();
  userId = u.id;
});

beforeEach(async () => {
  seq += 1;
  const company = await createCompany(db, { name: `Salesar FormLists ${seq}`, ownerId: userId });
  ctx = { db, companyId: company.id, userId };
  routeCtx = ctx;
  acct = {};
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
  codes = (await listEntries(ctx, 'sales-tax-codes')) as unknown as TaxCodeEntry[];
  tax = String(codes.find((c) => c.code === 'Tax')!.id);
  non = String(codes.find((c) => c.code === 'Non')!.id);
  rate = (await createTaxRate(ctx, { name: `State ${seq}`, rate: '0.10' })).id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold a handle; the next run wipes it. */
  }
});

async function fixtures() {
  const cust = (await createCustomer(ctx, { displayName: `Route ${seq}` } as never)).id;
  const msg1 = await createEntry(ctx, 'customer-messages', { message: `Thanks ${seq}` });
  const msg2 = await createEntry(ctx, 'customer-messages', { message: `See you ${seq}` });
  // A "Non" item the form re-codes to Tax on line 1, and a taxable item it marks Non on line 2.
  const nonItem = await item('Labor', { salesTaxCodeId: non, taxable: false });
  const taxItem = await item('Parts', { salesTaxCodeId: tax, taxable: true });
  return { cust, msg1: String(msg1.id), msg2: String(msg2.id), nonItem: nonItem.id, taxItem: taxItem.id };
}

/** Lines as the forms send them: each with its Sales Tax Code (lineTaxPayload). */
function formLines(f: { nonItem: string; taxItem: string }, first: string, second: string) {
  return [
    { itemId: f.nonItem, description: 'Labor', quantity: '1', rate: '100.00', ...lineTaxPayload({ salesTaxCodeId: first, taxable: true }, codes, { taxable: true }) },
    { itemId: f.taxItem, description: 'Parts', quantity: '1', rate: '50.00', ...lineTaxPayload({ salesTaxCodeId: second, taxable: true }, codes, { taxable: true }) },
  ];
}

describe('Routes pass customerMessageId and line salesTaxCodeId through (B8 / B9)', () => {
  it('invoices: POST and PUT', async () => {
    const f = await fixtures();
    const created = await ok(
      await invoicesPOST(req('/api/invoices', { customerId: f.cust, date: '2026-04-01', taxRateId: rate, customerMessageId: f.msg1, lines: formLines(f, tax, non) })),
    );
    let inv = await getInvoice(ctx, created.id);
    expect(inv.customerMessageId).toBe(f.msg1);
    expect(inv.lines.map((l) => [l.salesTaxCodeId, l.taxable])).toEqual([[tax, true], [non, false]]);
    // The tax the form previewed is the tax saved.
    const preview = previewSalesTotals(
      withShownTaxable([{ quantity: '1', rate: '100', taxable: true, salesTaxCodeId: tax }, { quantity: '1', rate: '50', taxable: true, salesTaxCodeId: non }], codes, { taxable: true }),
      0.1,
    );
    expect(inv.taxAmount).toBe(preview.tax.toFixed(2));
    expect(inv.taxAmount).toBe('10.00');

    await ok(
      await invoicePUT(
        req(`/api/invoices/${created.id}`, { customerId: f.cust, date: '2026-04-01', taxRateId: rate, customerMessageId: f.msg2, lines: formLines(f, non, tax) }, 'PUT'),
        params(created.id),
      ),
    );
    inv = await getInvoice(ctx, created.id);
    expect(inv.customerMessageId).toBe(f.msg2);
    expect(inv.lines.map((l) => l.salesTaxCodeId)).toEqual([non, tax]);
    expect(inv.taxAmount).toBe('5.00');
    // null clears the message.
    await ok(
      await invoicePUT(
        req(`/api/invoices/${created.id}`, { customerId: f.cust, date: '2026-04-01', taxRateId: rate, customerMessageId: null, lines: formLines(f, non, tax) }, 'PUT'),
        params(created.id),
      ),
    );
    expect((await getInvoice(ctx, created.id)).customerMessageId).toBeNull();
  });

  it('sales receipts: POST and PUT, with the Payment Method entry (B7)', async () => {
    const f = await fixtures();
    const pms = (await listEntries(ctx, 'payment-methods')) as unknown as PaymentMethodEntry[];
    const visa = pms.find((p) => p.name === 'Visa')!;
    const echeck = pms.find((p) => p.name === 'E-Check')!;
    const created = await ok(
      await salesReceiptsPOST(
        req('/api/sales-receipts', {
          customerId: f.cust,
          date: '2026-04-01',
          taxRateId: rate,
          ...paymentMethodPayload(`pm:${visa.id}`, pms),
          customerMessageId: f.msg1,
          lines: formLines(f, tax, non),
        }),
      ),
    );
    let sr = await getSalesReceipt(ctx, created.id);
    expect(sr.paymentMethodId).toBe(visa.id);
    expect(sr.method).toBe('credit_card');
    expect(sr.customerMessageId).toBe(f.msg1);
    expect(sr.lines.map((l) => l.salesTaxCodeId)).toEqual([tax, non]);
    expect(sr.taxAmount).toBe('10.00');

    await ok(
      await salesReceiptPUT(
        req(
          `/api/sales-receipts/${created.id}`,
          {
            customerId: f.cust,
            date: '2026-04-01',
            taxRateId: rate,
            ...paymentMethodPayload(`pm:${echeck.id}`, pms),
            customerMessageId: f.msg2,
            lines: formLines(f, non, non),
          },
          'PUT',
        ),
        params(created.id),
      ),
    );
    sr = await getSalesReceipt(ctx, created.id);
    expect(sr.paymentMethodId).toBe(echeck.id);
    expect(sr.method).toBe('ach');
    expect(sr.customerMessageId).toBe(f.msg2);
    expect(sr.lines.map((l) => l.salesTaxCodeId)).toEqual([non, non]);
    expect(sr.taxAmount).toBe('0.00');

    // A bare type (a receipt saved before the list was used) clears the entry.
    await ok(
      await salesReceiptPUT(
        req(
          `/api/sales-receipts/${created.id}`,
          { customerId: f.cust, date: '2026-04-01', taxRateId: rate, ...paymentMethodPayload('type:check', pms), lines: formLines(f, non, non) },
          'PUT',
        ),
        params(created.id),
      ),
    );
    sr = await getSalesReceipt(ctx, created.id);
    expect(sr.paymentMethodId).toBeNull();
    expect(sr.method).toBe('check');
  });

  it('credit memos: POST and PUT', async () => {
    const f = await fixtures();
    const created = await ok(
      await creditMemosPOST(req('/api/credit-memos', { customerId: f.cust, date: '2026-04-01', taxRateId: rate, customerMessageId: f.msg1, lines: formLines(f, tax, non) })),
    );
    let cm = await getCreditMemo(ctx, created.id);
    expect(cm.customerMessageId).toBe(f.msg1);
    expect(cm.lines.map((l) => l.salesTaxCodeId)).toEqual([tax, non]);
    expect(cm.taxAmount).toBe('10.00');
    await ok(
      await creditMemoPUT(
        req(`/api/credit-memos/${created.id}`, { customerId: f.cust, date: '2026-04-01', taxRateId: rate, customerMessageId: null, lines: formLines(f, non, tax) }, 'PUT'),
        params(created.id),
      ),
    );
    cm = await getCreditMemo(ctx, created.id);
    expect(cm.customerMessageId).toBeNull();
    expect(cm.lines.map((l) => l.salesTaxCodeId)).toEqual([non, tax]);
    expect(cm.taxAmount).toBe('5.00');
  });

  it('estimates: POST and PATCH (whole-estimate edit)', async () => {
    const f = await fixtures();
    const created = await ok(
      await estimatesPOST(req('/api/estimates', { customerId: f.cust, date: '2026-04-01', taxRateId: rate, customerMessageId: f.msg1, lines: formLines(f, tax, non) })),
    );
    let est = await getEstimate(ctx, created.id);
    expect(est.customerMessageId).toBe(f.msg1);
    expect(est.lines.map((l) => l.salesTaxCodeId)).toEqual([tax, non]);
    expect(est.taxAmount).toBe('10.00');
    const ids = est.lines.map((l) => l.id);
    await ok(
      await estimatePATCH(
        req(
          `/api/estimates/${created.id}`,
          {
            customerId: f.cust,
            date: '2026-04-01',
            taxRateId: rate,
            customerMessageId: f.msg2,
            lines: formLines(f, non, tax).map((l, i) => ({ id: ids[i], ...l })),
          },
          'PATCH',
        ),
        params(created.id),
      ),
    );
    est = await getEstimate(ctx, created.id);
    expect(est.customerMessageId).toBe(f.msg2);
    expect(est.lines.map((l) => l.salesTaxCodeId)).toEqual([non, tax]);
    expect(est.taxAmount).toBe('5.00');
  });

  it('sales orders: POST and PUT', async () => {
    const f = await fixtures();
    const created = await ok(
      await salesOrdersPOST(req('/api/sales-orders', { customerId: f.cust, date: '2026-04-01', taxRateId: rate, customerMessageId: f.msg1, lines: formLines(f, tax, non) })),
    );
    let so = await getSalesOrder(ctx, created.id);
    expect(so.customerMessageId).toBe(f.msg1);
    expect(so.lines.map((l) => l.salesTaxCodeId)).toEqual([tax, non]);
    const ids = so.lines.map((l) => l.id);
    await ok(
      await salesOrderPUT(
        req(
          `/api/sales-orders/${created.id}`,
          {
            customerId: f.cust,
            date: '2026-04-01',
            taxRateId: rate,
            customerMessageId: null,
            lines: formLines(f, non, tax).map((l, i) => ({ id: ids[i], ...l })),
          },
          'PUT',
        ),
        params(created.id),
      ),
    );
    so = await getSalesOrder(ctx, created.id);
    expect(so.customerMessageId).toBeNull();
    expect(so.lines.map((l) => l.salesTaxCodeId)).toEqual([non, tax]);
  });

  it('a non-taxable customer: the form shows Non on every line and the server taxes nothing', async () => {
    const f = await fixtures();
    const nonCust = (await createCustomer(ctx, { displayName: `Exempt ${seq}` } as never)).id;
    await updateCustomer(ctx, nonCust, { salesTaxCodeId: non, taxable: false } as never);
    const lines = formLines(f, tax, tax).map((l) => ({
      ...l,
      ...lineTaxPayload({ salesTaxCodeId: tax, taxable: true }, codes, { taxable: false, salesTaxCodeId: null }),
    }));
    expect(lines.map((l) => l.salesTaxCodeId)).toEqual([non, non]);
    const created = await ok(await invoicesPOST(req('/api/invoices', { customerId: nonCust, date: '2026-04-01', taxRateId: rate, lines })));
    const inv = await getInvoice(ctx, created.id);
    expect(inv.taxAmount).toBe('0.00');
    expect(inv.lines.map((l) => [l.salesTaxCodeId, l.taxable])).toEqual([[non, false], [non, false]]);
  });
});

describe('Make Deposits names the Payment Method entry (B7)', () => {
  it('GET /api/deposits/undeposited returns each item’s entry name, and the views tell cards from checks', async () => {
    const f = await fixtures();
    const pms = (await listEntries(ctx, 'payment-methods')) as unknown as PaymentMethodEntry[];
    const visa = pms.find((p) => p.name === 'Visa')!;
    const line = [{ accountId: acct['4000'], quantity: '1', rate: '20.00', taxable: false }];
    const card = await ok(
      await salesReceiptsPOST(req('/api/sales-receipts', { customerId: f.cust, date: '2026-04-01', ...paymentMethodPayload(`pm:${visa.id}`, pms), lines: line })),
    );
    const check = await ok(
      await salesReceiptsPOST(req('/api/sales-receipts', { customerId: f.cust, date: '2026-04-01', ...paymentMethodPayload('type:check', pms), lines: line })),
    );
    const res = await undepositedGET();
    const list = (await res.json()) as DepositMethodItem[];
    const byId = new Map(list.map((i) => [i.id, i]));
    expect(byId.get(card.id)?.paymentMethodName).toBe('Visa');
    expect(byId.get(check.id)?.paymentMethodName ?? null).toBeNull();
    expect(depositMethodLabel(byId.get(card.id)!)).toBe('Visa');
    expect(depositMethodLabel(byId.get(check.id)!)).toBe('Check');
    const ours = list.filter((i) => i.id === card.id || i.id === check.id);
    expect(ours.filter((i) => matchesDepositMethodView(i, 'group:credit_card')).map((i) => i.id)).toEqual([card.id]);
    expect(ours.filter((i) => matchesDepositMethodView(i, 'group:cash_check')).map((i) => i.id)).toEqual([check.id]);
  });
});
