/**
 * Feature round (team purchbank): PARITY D5 — Bills and Pay Bills take the due date and the
 * early-payment discount from the Terms list, custom and date-driven terms included, and keep
 * following the entry the bill was entered with (bills.terms_id) when it is renamed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bills } from '@/lib/db/schema';
import { makeTestCompany, type TestCompany } from './testkit.prefs';
import { createVendor } from './vendors';
import { createBill, getBill, listBillsToPay, updateBill } from './bills';
import { createEntry, updateEntry } from './lists/simpleLists';

let t: TestCompany;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (x: Date | string | null | undefined) => (x ? new Date(x).toISOString().slice(0, 10) : null);
let dateDriven: { id: string };
let custom: { id: string };

beforeAll(async () => {
  t = await makeTestCompany('purchbank-terms');
  // Date-driven: due on the 10th of the next month, 1% off when paid by the 25th.
  dateDriven = (await createEntry(t.ctx, 'terms', {
    name: '10th Prox 1% 25th',
    kind: 'date_driven',
    dueDayOfMonth: 10,
    dueNextMonthWithinDays: 20,
    discountPercent: '1',
    discountDayOfMonth: 25,
  })) as { id: string };
  custom = (await createEntry(t.ctx, 'terms', {
    name: '2% 15 Net 45',
    kind: 'standard',
    netDays: 45,
    discountPercent: '2',
    discountDays: 15,
  })) as { id: string };
}, 180_000);

afterAll(async () => {
  await t.cleanup();
});

const lines = () => [{ accountId: t.acct['6300'], amount: '1000.00' }];

describe('D5: Terms list due dates and discounts', () => {
  it('a vendor on date-driven terms: the bill is due the 10th of next month and Pay Bills offers 1% until the 25th', async () => {
    const v = await createVendor(t.ctx, { displayName: 'Prox Vendor', termsId: dateDriven.id } as never);
    const bill = await createBill(t.ctx, { vendorId: v.id, date: d('2026-03-05'), lines: lines() });
    expect(iso(bill.dueDate)).toBe('2026-04-10');
    const [row] = await t.ctx.db.select().from(bills).where(eq(bills.id, bill.id));
    expect(row.termsId).toBe(dateDriven.id);
    const early = await listBillsToPay(t.ctx, { vendorId: v.id, asOf: d('2026-03-20') });
    expect(early[0]).toMatchObject({ discountPercent: 1, suggestedDiscount: '10.00', discountAvailable: true });
    expect(iso(early[0].discountDate)).toBe('2026-03-25');
    const late = await listBillsToPay(t.ctx, { vendorId: v.id, asOf: d('2026-03-26') });
    expect(late[0]).toMatchObject({ discountAvailable: false });
  });

  it('a custom standard entry picked on the bill: due in 45 days, 2% within 15', async () => {
    const v = await createVendor(t.ctx, { displayName: 'Plain Vendor' } as never);
    const bill = await createBill(t.ctx, { vendorId: v.id, date: d('2026-03-01'), terms: '2% 15 Net 45', lines: lines() });
    expect(iso(bill.dueDate)).toBe('2026-04-15');
    const rows = await listBillsToPay(t.ctx, { vendorId: v.id, asOf: d('2026-03-10') });
    expect(rows[0]).toMatchObject({ discountPercent: 2, suggestedDiscount: '20.00', discountAvailable: true });
    expect(iso(rows[0].discountDate)).toBe('2026-03-16');
  });

  it('renaming the Terms list entry: the bill keeps its due date and Pay Bills discount (bills.terms_id)', async () => {
    const v = await createVendor(t.ctx, { displayName: 'Rename Vendor' } as never);
    const bill = await createBill(t.ctx, { vendorId: v.id, date: d('2026-05-01'), terms: '2% 15 Net 45', lines: lines() });
    await updateEntry(t.ctx, 'terms', custom.id, { name: '2/15 Net 45 (renamed)' });
    const rows = await listBillsToPay(t.ctx, { vendorId: v.id, asOf: d('2026-05-05') });
    expect(rows[0]).toMatchObject({ discountPercent: 2, discountAvailable: true });
    // An edit that does not touch the terms keeps the entry and the due date it gives.
    const detail = await getBill(t.ctx, bill.id);
    await updateBill(t.ctx, bill.id, {
      vendorId: v.id,
      date: d('2026-05-01'),
      terms: detail.terms,
      memo: 'memo only',
      lines: lines(),
    } as never);
    const [row] = await t.ctx.db.select().from(bills).where(eq(bills.id, bill.id));
    expect(row.termsId).toBe(custom.id);
    expect(iso(row.dueDate)).toBe('2026-06-15');
  });
});
