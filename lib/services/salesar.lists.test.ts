/**
 * Team salesar — QuickBooks list fields on sales forms:
 *  B9  the Sales Tax Code of each line is decided on the server (an item whose code is "Non" is
 *      never taxed, whatever the caller sends) and stored on the line, on all five sales forms;
 *  B8  the Customer Message is picked, stored (kept on edit, carried by conversions) and printed;
 *  B7  received payments and sales receipts store the Payment Method list entry and its type, and
 *      Payments to Deposit lists it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, invoiceLines, items, paymentsReceived, salesTaxCodes, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer, updateCustomer } from './customers';
import { createInvoice, getInvoice, updateInvoice } from './invoices';
import { createSalesReceipt, getSalesReceipt, updateSalesReceipt } from './salesReceipts';
import { createCreditMemo, getCreditMemo } from './creditMemos';
import { convertToInvoice as convertEstimate, createEstimate, getEstimate } from './estimates';
import { convertToInvoice as convertSalesOrder, createSalesOrder, getSalesOrder } from './salesOrders';
import { receivePayment, updatePayment } from './payments';
import { createTaxRate } from './salesTax';
import { createEntry, listEntries, updateEntry } from './lists/simpleLists';
import { listUndepositedPayments } from './deposits';
import { buildInvoicePdf } from '@/lib/pdf/forms';
import { renderSalesForm } from './salesForms';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-salesar-lists');
let db: DB;
let userId: string;
let ctx: ServiceContext;
let acct: Record<string, string> = {};
let seq = 0;
let tax: string;
let non: string;
let rate: string;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** All text drawn in a PDF, as the upper-case hex pdf-lib writes for the standard fonts. */
function pdfHex(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const s = buf.toString('latin1');
  let out = '';
  let i = 0;
  while ((i = s.indexOf('stream', i)) >= 0) {
    if (s.slice(i - 3, i) === 'end') {
      i += 6;
      continue;
    }
    let start = i + 6;
    if (s[start] === '\r') start++;
    if (s[start] === '\n') start++;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    const chunk = buf.subarray(start, end);
    try {
      out += zlib.inflateSync(chunk, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1');
    } catch {
      out += chunk.toString('latin1');
    }
    i = end + 9;
  }
  return out.toUpperCase();
}
const hex = (t: string) => Buffer.from(t, 'latin1').toString('hex').toUpperCase();

async function item(name: string, extra: Record<string, unknown> = {}) {
  const [it] = await db
    .insert(items)
    .values({ companyId: ctx.companyId, name: `${name} ${seq}`, type: 'service' as never, salesPrice: '100.00', incomeAccountId: acct['4000'], ...extra })
    .returning();
  return it.id;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'salesar-lists@test.local', name: 'Salesar', passwordHash: 'x' }).returning();
  userId = u.id;
});

beforeEach(async () => {
  seq += 1;
  const company = await createCompany(db, { name: `Salesar Lists ${seq}`, ownerId: userId });
  ctx = { db, companyId: company.id, userId };
  acct = {};
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
  const codes = await listEntries(ctx, 'sales-tax-codes');
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

// ---------------------------------------------------------------------------
describe('B9. The Sales Tax Code of each line is decided on the server', () => {
  it('an item whose code is "Non" is not taxed even when the caller sends taxable: true', async () => {
    const cust = (await createCustomer(ctx, { displayName: `Taxed ${seq}` } as never)).id;
    const nonItem = await item('Labor (Non)', { salesTaxCodeId: non, taxable: false });
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      taxRateId: rate,
      lines: [{ itemId: nonItem, quantity: 1, rate: '100.00', taxable: true }],
    } as never);
    expect(inv.taxAmount).toBe('0.00');
    const [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, inv.id));
    expect(line.taxable).toBe(false);
    expect(line.salesTaxCodeId).toBe(non);
  });

  it('a code the line states wins over the item (Tax on a "Non" item, Non on a taxable item)', async () => {
    const cust = (await createCustomer(ctx, { displayName: `Stated ${seq}` } as never)).id;
    const nonItem = await item('Delivery (Non)', { salesTaxCodeId: non, taxable: false });
    const taxItem = await item('Widget (Tax)', { salesTaxCodeId: tax, taxable: true });
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      taxRateId: rate,
      lines: [
        { itemId: nonItem, quantity: 1, rate: '100.00', salesTaxCodeId: tax },
        { itemId: taxItem, quantity: 1, rate: '50.00', salesTaxCodeId: non },
      ],
    } as never);
    expect(inv.taxAmount).toBe('10.00');
    const lines = (await getInvoice(ctx, inv.id)).lines;
    expect(lines.map((l) => [l.taxable, l.salesTaxCodeId])).toEqual([[true, tax], [false, non]]);
  });

  it('a taxable item without a stated code is taxed with the item code; unticking it stores no code', async () => {
    const cust = (await createCustomer(ctx, { displayName: `Ticks ${seq}` } as never)).id;
    const taxItem = await item('Gadget', { salesTaxCodeId: tax, taxable: true });
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      taxRateId: rate,
      lines: [
        { itemId: taxItem, quantity: 1, rate: '100.00' },
        { itemId: taxItem, quantity: 1, rate: '20.00', taxable: false },
      ],
    } as never);
    expect(inv.taxAmount).toBe('10.00');
    const lines = (await getInvoice(ctx, inv.id)).lines;
    expect(lines.map((l) => [l.taxable, l.salesTaxCodeId])).toEqual([[true, tax], [false, null]]);
  });

  it('a non-taxable customer taxes nothing, whatever the lines state', async () => {
    const cust = (await createCustomer(ctx, { displayName: `Exempt ${seq}` } as never)).id;
    await updateCustomer(ctx, cust, { salesTaxCodeId: non, taxable: false } as never);
    const taxItem = await item('Thing', { salesTaxCodeId: tax, taxable: true });
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      taxRateId: rate,
      lines: [{ itemId: taxItem, quantity: 1, rate: '100.00', salesTaxCodeId: tax }],
    } as never);
    expect(inv.taxAmount).toBe('0.00');
    const [line] = (await getInvoice(ctx, inv.id)).lines;
    expect(line.taxable).toBe(false);
    expect(line.salesTaxCodeId).toBe(non);
  });

  it("refuses another company's code", async () => {
    const other = await createCompany(db, { name: `Other ${seq}`, ownerId: userId });
    const otherCtx = { db, companyId: other.id, userId };
    const theirs = String((await listEntries(otherCtx, 'sales-tax-codes'))[0].id);
    const cust = (await createCustomer(ctx, { displayName: `Foreign code ${seq}` } as never)).id;
    await expect(
      createInvoice(ctx, {
        customerId: cust,
        date: d('2026-03-01'),
        taxRateId: rate,
        lines: [{ accountId: acct['4000'], quantity: 1, rate: '10.00', salesTaxCodeId: theirs }],
      } as never),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('sales receipts, credit memos, estimates and sales orders store the code; conversions carry it', async () => {
    const cust = (await createCustomer(ctx, { displayName: `Forms ${seq}` } as never)).id;
    const nonItem = await item('Service (Non)', { salesTaxCodeId: non, taxable: false });
    const sr = await createSalesReceipt(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      taxRateId: rate,
      depositAccountId: acct['1000'],
      lines: [{ itemId: nonItem, quantity: 1, rate: '100.00', taxable: true }],
    } as never);
    expect(sr.taxAmount).toBe('0.00');
    expect((await getSalesReceipt(ctx, sr.id)).lines[0].salesTaxCodeId).toBe(non);
    const cm = await createCreditMemo(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      taxRateId: rate,
      lines: [{ itemId: nonItem, quantity: 1, rate: '40.00', salesTaxCodeId: tax }],
    } as never);
    expect(cm.taxAmount).toBe('4.00');
    expect((await getCreditMemo(ctx, cm.id)).lines[0].salesTaxCodeId).toBe(tax);
    const est = await createEstimate(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      taxRateId: rate,
      lines: [{ itemId: nonItem, quantity: 1, rate: '100.00', salesTaxCodeId: tax }],
    } as never);
    expect(est.taxAmount).toBe('10.00');
    expect((await getEstimate(ctx, est.id)).lines[0].salesTaxCodeId).toBe(tax);
    const inv = await convertEstimate(ctx, est.id);
    const invLines = (await getInvoice(ctx, inv.id)).lines;
    expect(invLines[0].salesTaxCodeId).toBe(tax);
    expect(invLines[0].taxable).toBe(true);
    const so = await createSalesOrder(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      taxRateId: rate,
      lines: [{ itemId: nonItem, quantity: 2, rate: '10.00', taxable: true }],
    } as never);
    expect((await getSalesOrder(ctx, so.id)).lines[0].salesTaxCodeId).toBe(non);
    const soInv = await convertSalesOrder(ctx, so.id);
    expect((await getInvoice(ctx, soInv.id)).lines[0].salesTaxCodeId).toBe(non);
    expect(soInv.taxAmount).toBe('0.00');
  });
});

// ---------------------------------------------------------------------------
describe('B8. Customer Message on sales forms', () => {
  it('is stored, kept by an edit that does not send it, cleared by null, and printed', async () => {
    const msg = await createEntry(ctx, 'customer-messages', { message: `Thanks for choosing us ${seq}!` });
    const cust = (await createCustomer(ctx, { displayName: `Msg ${seq}` } as never)).id;
    const base = { customerId: cust, date: d('2026-03-01'), taxRateId: null, lines: [{ accountId: acct['4000'], quantity: 1, rate: '25.00', taxable: false }] };
    const inv = await createInvoice(ctx, { ...base, customerMessageId: msg.id } as never);
    expect((await getInvoice(ctx, inv.id)).customerMessageId).toBe(msg.id);
    const { bytes } = await buildInvoicePdf(ctx, inv.id);
    expect(pdfHex(bytes)).toContain(hex(`Thanks for choosing us ${seq}!`));
    await updateInvoice(ctx, inv.id, { ...base, memo: 'edited' } as never);
    expect((await getInvoice(ctx, inv.id)).customerMessageId).toBe(msg.id);
    await updateInvoice(ctx, inv.id, { ...base, customerMessageId: null } as never);
    expect((await getInvoice(ctx, inv.id)).customerMessageId).toBeNull();
  });

  it('prints on sales receipts, credit memos, estimates and sales orders, and carries to the invoice', async () => {
    const text = `It was a pleasure ${seq}`;
    const msg = await createEntry(ctx, 'customer-messages', { message: text });
    const cust = (await createCustomer(ctx, { displayName: `Msg forms ${seq}` } as never)).id;
    const lines = [{ accountId: acct['4000'], quantity: 1, rate: '25.00', taxable: false }];
    const sr = await createSalesReceipt(ctx, { customerId: cust, date: d('2026-03-01'), depositAccountId: acct['1000'], customerMessageId: msg.id, lines } as never);
    const cm = await createCreditMemo(ctx, { customerId: cust, date: d('2026-03-01'), customerMessageId: msg.id, lines } as never);
    const est = await createEstimate(ctx, { customerId: cust, date: d('2026-03-01'), customerMessageId: msg.id, lines } as never);
    const so = await createSalesOrder(ctx, { customerId: cust, date: d('2026-03-01'), customerMessageId: msg.id, lines } as never);
    for (const [kind, id] of [['sales_receipt', sr.id], ['credit_memo', cm.id], ['estimate', est.id], ['sales_order', so.id]] as const) {
      const form = await renderSalesForm(ctx, kind, id);
      expect(pdfHex(form.bytes), kind).toContain(hex(text));
    }
    expect((await getInvoice(ctx, (await convertEstimate(ctx, est.id)).id)).customerMessageId).toBe(msg.id);
    expect((await getInvoice(ctx, (await convertSalesOrder(ctx, so.id)).id)).customerMessageId).toBe(msg.id);
  });

  it("refuses another company's message, and a newly picked inactive one", async () => {
    const other = await createCompany(db, { name: `Other msg ${seq}`, ownerId: userId });
    const theirs = await createEntry({ db, companyId: other.id, userId }, 'customer-messages', { message: 'Not yours' });
    const cust = (await createCustomer(ctx, { displayName: `Msg guard ${seq}` } as never)).id;
    const base = { customerId: cust, date: d('2026-03-01'), lines: [{ accountId: acct['4000'], quantity: 1, rate: '5.00', taxable: false }] };
    await expect(createInvoice(ctx, { ...base, customerMessageId: theirs.id } as never)).rejects.toMatchObject({ code: 'VALIDATION' });
    const old = await createEntry(ctx, 'customer-messages', { message: `Old one ${seq}` });
    const inv = await createInvoice(ctx, { ...base, customerMessageId: old.id } as never);
    await updateEntry(ctx, 'customer-messages', old.id, { isActive: false });
    // The invoice keeps it on an edit; a new document can't pick it.
    await updateInvoice(ctx, inv.id, { ...base, customerMessageId: old.id, memo: 'x' } as never);
    await expect(createInvoice(ctx, { ...base, customerMessageId: old.id } as never)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

// ---------------------------------------------------------------------------
describe('B7. Payment Method list on payments and sales receipts', () => {
  it('a payment stores the entry and its type; an edit keeps it; Payments to Deposit names it', async () => {
    const methods = await listEntries(ctx, 'payment-methods');
    const visa = methods.find((m) => m.name === 'Visa')!;
    const cust = (await createCustomer(ctx, { displayName: `Pays ${seq}` } as never)).id;
    const inv = await createInvoice(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '80.00', taxable: false }],
    } as never);
    const { payment } = await receivePayment(ctx, {
      customerId: cust,
      date: d('2026-03-05'),
      amount: '80.00',
      method: 'check', // the entry's type wins
      paymentMethodId: visa.id,
      applications: [{ invoiceId: inv.id, amountApplied: '80.00' }],
    } as never);
    expect(payment.method).toBe('credit_card');
    expect(payment.paymentMethodId).toBe(visa.id);
    await updatePayment(ctx, payment.id, {
      customerId: cust,
      date: d('2026-03-06'),
      amount: '80.00',
      method: 'credit_card',
      reference: 'auth 123',
      applications: [{ invoiceId: inv.id, amountApplied: '80.00' }],
    } as never);
    const [row] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, payment.id));
    expect(row.paymentMethodId).toBe(visa.id);
    const undeposited = await listUndepositedPayments(ctx);
    const item0 = undeposited.find((u) => u.id === payment.id)!;
    expect(item0.paymentMethodName).toBe('Visa');
    expect(item0.method).toBe('credit_card');
    // Changing the type without naming an entry drops the entry (it no longer describes the payment).
    await updatePayment(ctx, payment.id, {
      customerId: cust,
      date: d('2026-03-06'),
      amount: '80.00',
      method: 'cash',
      applications: [{ invoiceId: inv.id, amountApplied: '80.00' }],
    } as never);
    const [after] = await db.select().from(paymentsReceived).where(eq(paymentsReceived.id, payment.id));
    expect(after.paymentMethodId).toBeNull();
    expect(after.method).toBe('cash');
  });

  it('a sales receipt stores the entry; another company’s entry is refused', async () => {
    const methods = await listEntries(ctx, 'payment-methods');
    const echeck = methods.find((m) => m.name === 'E-Check')!;
    const cust = (await createCustomer(ctx, { displayName: `SR pays ${seq}` } as never)).id;
    const sr = await createSalesReceipt(ctx, {
      customerId: cust,
      date: d('2026-03-01'),
      paymentMethodId: echeck.id,
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '12.00', taxable: false }],
    } as never);
    expect(sr.method).toBe('ach');
    expect(sr.paymentMethodId).toBe(echeck.id);
    await updateSalesReceipt(ctx, sr.id, {
      customerId: cust,
      date: d('2026-03-02'),
      method: 'ach',
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '12.00', taxable: false }],
    } as never);
    expect((await getSalesReceipt(ctx, sr.id)).paymentMethodId).toBe(echeck.id);
    const other = await createCompany(db, { name: `Other pm ${seq}`, ownerId: userId });
    const theirs = (await listEntries({ db, companyId: other.id, userId }, 'payment-methods'))[0];
    await expect(
      createSalesReceipt(ctx, {
        customerId: cust,
        date: d('2026-03-01'),
        paymentMethodId: theirs.id,
        lines: [{ accountId: acct['4000'], quantity: 1, rate: '12.00', taxable: false }],
      } as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const all = await db.select().from(salesTaxCodes).where(and(eq(salesTaxCodes.companyId, ctx.companyId)));
    expect(all.length).toBeGreaterThan(0);
  });
});
