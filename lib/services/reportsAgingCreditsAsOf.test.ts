/**
 * As-of aging with credits applied later (P1 fix round): a credit memo / vendor credit that existed
 * on the report date but was applied to an invoice / bill AFTER it must still show as an open
 * credit on that date, and the invoice / bill at its full open balance, so A/R and A/P aging tie to
 * the control accounts on every date (QB ages each document at its open balance on the report date).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { StdReport } from '@/lib/reports/types';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { createBill } from './bills';
import { applyToInvoice, createCreditMemo } from './creditMemos';
import { applyToBill, createVendorCredit } from './vendorCredits';
import { runStandardReport } from './reportRegistry';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-aging-credits-asof');
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const grand = (r: StdReport) => r.rows.find((x) => x.kind === 'grand')!;
const dataRows = (r: StdReport) => r.rows.filter((x) => x.kind === 'data');
const m = (v: unknown) => Money.of(v == null || v === '' ? '0' : String(v));

let db: DB;
let ctx: ServiceContext;
const code: Record<string, string> = {};

async function tb(label: string, asOf: string): Promise<string> {
  const r = (await runStandardReport(ctx, 'trial-balance', { asOf })).rows.find((x) => x.kind === 'data' && String(x.cells.label).includes(label));
  return r ? m(r.cells.debit).minus(m(r.cells.credit)).toFixed(2) : '0.00';
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'aging-credits@test.local', name: 'QA', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Aging Credits Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) code[r.code] = r.id;

  const cust = (await createCustomer(ctx, { displayName: 'Early Credit' })).id;
  const line = (amount: string) => ({ accountId: code['4000'], quantity: 1, rate: amount, taxable: false });
  const inv = await createInvoice(ctx, { customerId: cust, date: d('2026-01-05'), dueDate: d('2026-02-04'), lines: [line('300.00')] });
  const cm = await createCreditMemo(ctx, { customerId: cust, date: d('2026-01-10'), lines: [line('40.00')] });
  await applyToInvoice(ctx, { creditMemoId: cm.id, invoiceId: inv.id, amount: '40.00', date: d('2026-02-10') });

  const vend = (await createVendor(ctx, { displayName: 'Early Vendor Credit' })).id;
  const vc = await createVendorCredit(ctx, { vendorId: vend, date: d('2026-01-12'), lines: [{ accountId: code['6000'], amount: '30.00' }] });
  const bill = await createBill(ctx, { vendorId: vend, date: d('2026-01-20'), dueDate: d('2026-02-19'), lines: [{ accountId: code['6000'], amount: '200.00' }] });
  await applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '30.00' });
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold PGlite files briefly */
  }
});

describe('as-of aging with credits applied after the report date', () => {
  it('A/R: memo applied later is still open on 1/31; invoice at full balance; ties to A/R', async () => {
    const det = await runStandardReport(ctx, 'ar-aging-detail', { asOf: '2026-01-31' });
    expect(dataRows(det).map((x) => x.cells.open).sort()).toEqual(['-40.00', '300.00']);
    const sum = await runStandardReport(ctx, 'ar-aging-summary', { asOf: '2026-01-31' });
    expect(grand(sum).cells.total).toBe(await tb('Accounts Receivable', '2026-01-31'));
    expect(grand(sum).cells.total).toBe('260.00');
  });

  it('A/R: after the application the memo is consumed and the invoice reduced', async () => {
    const det = await runStandardReport(ctx, 'ar-aging-detail', { asOf: '2026-02-28' });
    expect(dataRows(det).map((x) => x.cells.open)).toEqual(['260.00']);
  });

  it('A/P: on 1/15 (credit exists, bill not yet) the whole credit is open; ties to A/P', async () => {
    const sum = await runStandardReport(ctx, 'ap-aging-summary', { asOf: '2026-01-15' });
    const ap = Money.of(await tb('Accounts Payable', '2026-01-15')).negated().toFixed(2);
    expect(grand(sum).cells.total).toBe(ap);
    expect(ap).toBe('-30.00');
    const det = await runStandardReport(ctx, 'ap-aging-detail', { asOf: '2026-01-31' });
    expect(dataRows(det).map((x) => x.cells.open)).toEqual(['170.00']);
  });
});
