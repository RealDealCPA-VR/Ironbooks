/**
 * Feature round (team purchbank): purchase orders to QuickBooks parity.
 *
 *  - Each P.O. line takes a Customer:Job and a Class; Convert to Bill carries them onto the bill
 *    lines (billable to the customer, class on the expense).
 *  - The P.O. has a Ship To: the company (default), a customer (drop ship: the customer's
 *    shipping address), or any address typed on the P.O.; it prints in the Ship To block.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { billLines, customers, itemReceiptLines, itemReceipts, journalEntryLines } from '@/lib/db/schema';
import { ServiceError } from './_base';
import { makeTestCompany, type TestCompany } from './testkit.prefs';
import { createVendor } from './vendors';
import { createCustomer } from './customers';
import { createJob } from './jobs';
import { createClass } from './dimensions';
import { convertToBill, createPurchaseOrder, getPurchaseOrder, updatePurchaseOrder } from './purchaseOrders';
import { purchaseOrderPdfData } from '@/lib/pdf/forms';
import { createPurchaseOrderSchema } from '@/lib/validation/purchaseOrders';
import { createBill } from './bills';
import { createItem } from './items';
import { createItemReceipt, convertToBill as convertReceiptToBill } from './itemReceipts';
import { enterBillForReceivedItems } from './receiving';

let t: TestCompany;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => t.ctx) }));
import { POST as poPOST } from '@/app/api/purchase-orders/[id]/route';
import { POST as receiptPOST } from '@/app/api/item-receipts/[id]/route';
import { POST as receiveBillPOST } from '@/app/api/receiving/bill/route';
let vendorId: string;
let customerId: string;
let jobId: string;
let classId: string;
let otherJobId: string;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function refusal(p: Promise<unknown>): Promise<ServiceError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'expected the call to be refused').toBeInstanceOf(ServiceError);
  return err as ServiceError;
}

beforeAll(async () => {
  t = await makeTestCompany('purchbank-po');
  vendorId = (await createVendor(t.ctx, { displayName: 'PO Vendor' } as never)).id;
  const cust = await createCustomer(t.ctx, { displayName: 'Drop Ship Customer' } as never);
  customerId = cust.id;
  await t.ctx.db
    .update(customers)
    .set({ shippingAddress: { line1: '9 Site Road', city: 'Springfield', state: 'IL', zip: '62704' } })
    .where(eq(customers.id, customerId));
  jobId = (await createJob(t.ctx, { customerId, name: 'Kitchen remodel' })).id;
  const other = await createCustomer(t.ctx, { displayName: 'Other Customer' } as never);
  otherJobId = (await createJob(t.ctx, { customerId: other.id, name: 'Other job' })).id;
  classId = (await createClass(t.ctx, { name: 'Remodeling' })).id;
}, 180_000);

afterAll(async () => {
  await t.cleanup();
});

describe('P.O. lines: Customer:Job and Class', () => {
  it('are saved on the lines, carried onto the bill by Convert to Bill, and kept by an edit', async () => {
    const po = await createPurchaseOrder(t.ctx, {
      vendorId,
      date: d('2026-04-01'),
      lines: [
        { accountId: t.acct['6300'], description: 'Tile', quantity: '2', rate: '50', customerId, jobId, classId },
        { accountId: t.acct['6300'], description: 'Shop supplies', quantity: '1', rate: '20' },
      ],
    } as never);
    const got = await getPurchaseOrder(t.ctx, po.id);
    expect(got.lines[0]).toMatchObject({ customerId, jobId, classId });
    expect(got.lines[1]).toMatchObject({ customerId: null, jobId: null, classId: null });

    // An edit can change them (here: the second line gets the class).
    await updatePurchaseOrder(t.ctx, po.id, {
      vendorId,
      date: d('2026-04-01'),
      lines: [
        { id: got.lines[0].id, accountId: t.acct['6300'], description: 'Tile', quantity: '2', rate: '50', customerId, jobId, classId },
        { id: got.lines[1].id, accountId: t.acct['6300'], description: 'Shop supplies', quantity: '1', rate: '20', classId },
      ],
    } as never);
    expect((await getPurchaseOrder(t.ctx, po.id)).lines[1].classId).toBe(classId);

    const bill = await convertToBill(t.ctx, po.id);
    const lines = await t.ctx.db.select().from(billLines).where(eq(billLines.billId, bill.id));
    const tile = lines.find((l) => l.description === 'Tile')!;
    expect(tile).toMatchObject({ customerId, jobId, classId });
    expect(lines.find((l) => l.description === 'Shop supplies')).toMatchObject({ customerId: null, classId });
  });

  it('a job of another customer, or a class / customer of another company, is refused', async () => {
    const wrongJob = await refusal(
      createPurchaseOrder(t.ctx, {
        vendorId,
        date: d('2026-04-01'),
        lines: [{ accountId: t.acct['6300'], quantity: '1', rate: '5', customerId, jobId: otherJobId }],
      } as never),
    );
    expect(wrongJob.code).toBe('VALIDATION');
    expect(wrongJob.message).toMatch(/job .*belongs to another customer/i);
    const stranger = '00000000-0000-4000-8000-000000000001';
    expect(
      (await refusal(createPurchaseOrder(t.ctx, { vendorId, date: d('2026-04-01'), lines: [{ accountId: t.acct['6300'], quantity: '1', rate: '5', classId: stranger }] } as never)))
        .code,
    ).not.toBe('INTERNAL');
    // A job alone fills in its customer.
    const po = await createPurchaseOrder(t.ctx, {
      vendorId,
      date: d('2026-04-01'),
      lines: [{ accountId: t.acct['6300'], quantity: '1', rate: '5', jobId }],
    } as never);
    expect((await getPurchaseOrder(t.ctx, po.id)).lines[0]).toMatchObject({ customerId, jobId });
  });

  it('the API schema accepts the line fields and the Ship To', () => {
    const parsed = createPurchaseOrderSchema.safeParse({
      vendorId,
      date: '2026-04-01',
      shipToCustomerId: customerId,
      shipTo: { name: 'Site', line1: '1 Main', city: 'X' },
      lines: [{ accountId: t.acct['6300'], quantity: '1', rate: '5', customerId, jobId, classId }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.lines[0]).toMatchObject({ customerId, jobId, classId });
      expect(parsed.data.shipToCustomerId).toBe(customerId);
    }
  });
});

describe('P.O. Customer:Job and Class through Receive Items (post-merge fix)', () => {
  it('a receipt against the P.O. posts the class; its bill (Convert or Enter Bill for Received Items) gets Customer:Job and Class', async () => {
    const item = await createItem(t.ctx, {
      name: 'Job tile',
      type: 'non_inventory',
      incomeAccountId: t.acct['4000'],
      expenseAccountId: t.acct['6300'],
    } as never);
    const po = await createPurchaseOrder(t.ctx, {
      vendorId,
      date: d('2026-05-01'),
      lines: [{ itemId: item.id, accountId: t.acct['6300'], description: 'Tile', quantity: '4', rate: '10', customerId, jobId, classId }],
    } as never);
    // Receive 2, convert that receipt to a bill.
    const r1 = await createItemReceipt(t.ctx, { vendorId, purchaseOrderId: po.id, date: d('2026-05-02'), lines: [{ itemId: item.id, quantity: 2, unitCost: '10' }] } as never);
    const [rec] = await t.ctx.db.select().from(itemReceipts).where(eq(itemReceipts.id, r1.id));
    const jl = await t.ctx.db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, rec.postedEntryId!));
    expect(jl.find((l) => l.accountId === t.acct['6300'])?.classId).toBe(classId);
    const bill1 = await convertReceiptToBill(t.ctx, r1.id);
    const bl1 = await t.ctx.db.select().from(billLines).where(eq(billLines.billId, bill1.id));
    expect(bl1[0]).toMatchObject({ customerId, jobId, classId });
    // Receive the other 2, bill them through Enter Bill for Received Items.
    const r2 = await createItemReceipt(t.ctx, { vendorId, purchaseOrderId: po.id, date: d('2026-05-03'), lines: [{ itemId: item.id, quantity: 2, unitCost: '10' }] } as never);
    const [rl] = await t.ctx.db.select().from(itemReceiptLines).where(eq(itemReceiptLines.itemReceiptId, r2.id));
    const res = await enterBillForReceivedItems(t.ctx, { vendorId, date: d('2026-05-04'), lines: [{ receiptLineId: rl.id, quantity: '2', unitCost: '10' }] } as never);
    const billId = (res as { bill?: { id: string }; id?: string }).bill?.id ?? (res as { id: string }).id;
    const bl2 = await t.ctx.db.select().from(billLines).where(eq(billLines.billId, billId));
    expect(bl2[0]).toMatchObject({ customerId, jobId, classId });
  });
});

describe('P.O. Ship To', () => {
  it('a customer (drop ship) fills in their shipping address; it prints in the Ship To block', async () => {
    const po = await createPurchaseOrder(t.ctx, {
      vendorId,
      date: d('2026-04-02'),
      shipToCustomerId: customerId,
      lines: [{ accountId: t.acct['6300'], quantity: '1', rate: '5' }],
    } as never);
    const got = await getPurchaseOrder(t.ctx, po.id);
    expect(got.shipToCustomerId).toBe(customerId);
    expect(got.shipTo).toMatchObject({ name: 'Drop Ship Customer', line1: '9 Site Road', city: 'Springfield' });
    const pdf = await purchaseOrderPdfData(t.ctx, po.id);
    expect(pdf.shipToName).toBe('Drop Ship Customer');
    expect(pdf.shipToLines).toEqual(['9 Site Road', 'Springfield, IL 62704']);
  });

  it('an address typed on the P.O. wins; none means the company address', async () => {
    const typed = await createPurchaseOrder(t.ctx, {
      vendorId,
      date: d('2026-04-02'),
      shipTo: { name: 'Warehouse 2', line1: '500 Dock St', city: 'Peoria', state: 'IL' },
      lines: [{ accountId: t.acct['6300'], quantity: '1', rate: '5' }],
    } as never);
    const pdf = await purchaseOrderPdfData(t.ctx, typed.id);
    expect(pdf.shipToName).toBe('Warehouse 2');
    expect(pdf.shipToLines).toEqual(['500 Dock St', 'Peoria, IL']);
    // An edit can clear it: back to the company address.
    await updatePurchaseOrder(t.ctx, typed.id, {
      vendorId,
      date: d('2026-04-02'),
      shipTo: null,
      lines: [{ id: (await getPurchaseOrder(t.ctx, typed.id)).lines[0].id, accountId: t.acct['6300'], quantity: '1', rate: '5' }],
    } as never);
    const cleared = await purchaseOrderPdfData(t.ctx, typed.id);
    expect(cleared.shipToName ?? null).toBeNull();
    expect(cleared.shipToLines).toBeUndefined();
    // An edit that does not send the Ship To keeps it.
    const kept = await createPurchaseOrder(t.ctx, {
      vendorId,
      date: d('2026-04-02'),
      shipToCustomerId: customerId,
      lines: [{ accountId: t.acct['6300'], quantity: '1', rate: '5' }],
    } as never);
    await updatePurchaseOrder(t.ctx, kept.id, {
      vendorId,
      date: d('2026-04-03'),
      lines: [{ id: (await getPurchaseOrder(t.ctx, kept.id)).lines[0].id, accountId: t.acct['6300'], quantity: '1', rate: '5' }],
    } as never);
    expect((await getPurchaseOrder(t.ctx, kept.id)).shipToCustomerId).toBe(customerId);
  });

  it('refuses a ship-to customer of another company and a too-long address', async () => {
    expect(
      (
        await refusal(
          createPurchaseOrder(t.ctx, {
            vendorId,
            date: d('2026-04-02'),
            shipToCustomerId: '00000000-0000-4000-8000-000000000002',
            lines: [{ accountId: t.acct['6300'], quantity: '1', rate: '5' }],
          } as never),
        )
      ).code,
    ).toMatch(/NOT_FOUND|VALIDATION/);
    expect(
      (
        await refusal(
          createPurchaseOrder(t.ctx, {
            vendorId,
            date: d('2026-04-02'),
            shipTo: { line1: 'x'.repeat(600) },
            lines: [{ accountId: t.acct['6300'], quantity: '1', rate: '5' }],
          } as never),
        )
      ).code,
    ).toBe('VALIDATION');
  });
});

describe('duplicate vendor reference number on converted bills: the routes pass the confirmation', () => {
  const call = (fn: (req: never, c: never) => Promise<Response>, url: string, body: unknown, id?: string) =>
    fn(
      new Request(`http://localhost${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) as never,
      { params: Promise.resolve({ id }) } as never,
    );

  it('Convert PO to Bill, item receipt Convert to Bill and Enter Bill for Received Items: 409, then saved once confirmed', async () => {
    const v = await createVendor(t.ctx, { displayName: 'Dup Route Vendor' } as never);
    await createBill(t.ctx, { vendorId: v.id, billNumber: 'R-1', date: d('2026-04-01'), lines: [{ accountId: t.acct['6300'], amount: '10.00' }] });
    const po = await createPurchaseOrder(t.ctx, { vendorId: v.id, date: d('2026-04-02'), lines: [{ accountId: t.acct['6300'], quantity: 1, rate: '20.00' }] });
    const first = await call(poPOST, `/api/purchase-orders/${po.id}`, { action: 'convert', billNumber: 'R-1' }, po.id);
    expect(first.status).toBe(409);
    expect(((await first.json()) as { error: string }).error).toMatch(/already has a bill with reference number/);
    const ok = await call(poPOST, `/api/purchase-orders/${po.id}`, { action: 'convert', billNumber: 'R-1', allowDuplicateNumber: true }, po.id);
    expect(ok.status).toBe(200);

    const item = await createItem(t.ctx, {
      name: 'Dup route item',
      type: 'inventory',
      incomeAccountId: t.acct['4000'],
      expenseAccountId: t.acct['5000'],
      assetAccountId: t.acct['1300'],
    } as never);
    const r1 = await createItemReceipt(t.ctx, { vendorId: v.id, date: d('2026-04-02'), lines: [{ itemId: item.id, quantity: 1, unitCost: '5.00' }] } as never);
    expect((await call(receiptPOST, `/api/item-receipts/${r1.id}`, { action: 'convert', billNumber: 'R-1' }, r1.id)).status).toBe(409);
    expect(
      (await call(receiptPOST, `/api/item-receipts/${r1.id}`, { action: 'convert', billNumber: 'R-1', allowDuplicateNumber: true }, r1.id)).status,
    ).toBe(200);

    const r2 = await createItemReceipt(t.ctx, { vendorId: v.id, date: d('2026-04-03'), lines: [{ itemId: item.id, quantity: 1, unitCost: '5.00' }] } as never);
    const [rl] = await t.ctx.db.select().from(itemReceiptLines).where(eq(itemReceiptLines.itemReceiptId, r2.id));
    const body = { vendorId: v.id, billNumber: 'R-1', date: '2026-04-04', lines: [{ receiptLineId: rl.id, quantity: '1', unitCost: '5.00' }] };
    expect((await call(receiveBillPOST, '/api/receiving/bill', body)).status).toBe(409);
    expect((await call(receiveBillPOST, '/api/receiving/bill', { ...body, allowDuplicateNumber: true })).status).toBe(201);
  });
});
