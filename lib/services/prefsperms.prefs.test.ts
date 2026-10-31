/**
 * prefsperms (PARITY A1 / A2): preferences that must take effect.
 *
 *  - Reports & Graphs > "Reports show accounts by" (accountDisplay): every report names accounts
 *    by name, description, or both (QB "Show accounts by"). It only reached the journal page's
 *    account picker before; reports always used the name.
 *  - Finance Charge (A2, a QB category that was missing): the finance charge account, "Assess
 *    finance charges on overdue finance charges", "Calculate charges from due date / invoice
 *    date" and "Mark finance charge invoices To be printed" take effect in the assessment.
 *  - Desktop View, Search, Calendar, Integrated Applications: the settings resolve safely and
 *    take effect (Home icons, start page, portal / phone-receipt access).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-prefsperms-prefs');
process.env.BKA_DATA_DIR = TEST_DIR;

import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, invoices, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, updateCompany } from './company';
import { createManualEntry } from './journal';
import { runStandardReport } from './reportRegistry';
import { loadAccountMeta } from './reportEngine';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { assessFinanceCharges, getFinanceChargeSettings, previewFinanceCharges, updateFinanceChargeSettings } from './financeCharges';

let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'prefs@acme.test', name: 'Pat Prefs', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Prefs Co', ownerId: u.id });
  ctx = { db, companyId: company.id, userId: u.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  await db.update(accounts).set({ description: 'Consulting revenue' }).where(eq(accounts.id, acct['4000']));
  await createManualEntry(ctx, {
    date: new Date('2026-03-10T00:00:00Z'),
    description: 'Fee',
    lines: [
      { accountId: acct['1000'], debit: '500.00' },
      { accountId: acct['4000'], credit: '500.00' },
    ],
  } as never);
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR).catch(() => undefined);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* Windows */
  }
});

async function plLabels(): Promise<string[]> {
  const r = await runStandardReport(ctx, 'profit-loss', { from: '2026-01-01', to: '2026-12-31' });
  return r.rows.map((x) => String(x.cells.label ?? ''));
}

describe('A1: Reports show accounts by (accountDisplay)', () => {
  it('name (the default): the account name', async () => {
    const [a] = await db.select().from(accounts).where(eq(accounts.id, acct['4000']));
    const labels = await plLabels();
    expect(labels).toContain(a.name);
    expect(labels.some((l) => l.includes('Consulting revenue'))).toBe(false);
  });

  it('description only: the description (the name when an account has none)', async () => {
    await updateCompany(ctx, { settings: { accountDisplay: 'description' } } as never);
    const labels = await plLabels();
    expect(labels).toContain('Consulting revenue');
    expect(labels).toContain('Total Income');
    // Detail reports name accounts the same way.
    const detail = await runStandardReport(ctx, 'transaction-detail-by-account', { from: '2026-01-01', to: '2026-12-31' });
    expect(JSON.stringify(detail.rows)).toContain('Consulting revenue');
  });

  it('name and description', async () => {
    await updateCompany(ctx, { settings: { accountDisplay: 'both' } } as never);
    const [a] = await db.select().from(accounts).where(eq(accounts.id, acct['4000']));
    expect(await plLabels()).toContain(`${a.name} (Consulting revenue)`);
  });

  it('raw metadata (cross-company matching) keeps the real names', async () => {
    const meta = await loadAccountMeta(ctx, { raw: true });
    const [a] = await db.select().from(accounts).where(eq(accounts.id, acct['4000']));
    expect(meta.get(acct['4000'])!.name).toBe(a.name);
    await updateCompany(ctx, { settings: { accountDisplay: 'name' } } as never);
  });
});

describe('A2: Finance Charge preferences take effect', () => {
  let customerId: string;
  let invoiceId: string;
  beforeAll(async () => {
    const c = await createCustomer(ctx, { displayName: 'Slow Payer Inc' } as never);
    customerId = c.id;
    const inv = await createInvoice(ctx, {
      customerId,
      date: new Date('2026-01-01T00:00:00Z'),
      dueDate: new Date('2026-01-31T00:00:00Z'),
      lines: [{ accountId: acct['4000'], description: 'Work', quantity: 1, rate: '1000.00' }],
    } as never);
    invoiceId = inv.id;
  });

  it('defaults keep the old behaviour', async () => {
    expect(await getFinanceChargeSettings(ctx)).toMatchObject({
      annualRate: '18',
      accountId: null,
      assessOnFinanceCharges: false,
      calculateFrom: 'due_date',
      markToBePrinted: false,
    });
  });

  it('refuses a finance charge account that is not an income account of this company', async () => {
    await expect(updateFinanceChargeSettings(ctx, { accountId: acct['1000'] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(updateFinanceChargeSettings(ctx, { accountId: '00000000-0000-0000-0000-000000000000' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('"Calculate charges from" the invoice date counts the days from the invoice date', async () => {
    const asOf = new Date('2026-03-02T00:00:00Z');
    const byDue = await previewFinanceCharges(ctx, { asOf });
    const fromDue = byDue.customers.find((c) => c.customerId === customerId)!.overdueInvoices[0];
    expect(fromDue.daysCharged).toBe(30); // Jan 31 -> Mar 2
    await updateFinanceChargeSettings(ctx, { calculateFrom: 'invoice_date' });
    const byInvoice = await previewFinanceCharges(ctx, { asOf });
    const fromInv = byInvoice.customers.find((c) => c.customerId === customerId)!.overdueInvoices[0];
    expect(fromInv.daysCharged).toBe(60); // Jan 1 -> Mar 2
    await updateFinanceChargeSettings(ctx, { calculateFrom: 'due_date' });
  });

  it('posts to the chosen account and marks the invoice To be printed', async () => {
    await updateFinanceChargeSettings(ctx, { accountId: acct['4000'], markToBePrinted: true });
    const r = await assessFinanceCharges(ctx, { asOf: new Date('2026-03-02T00:00:00Z'), customerIds: [customerId] });
    expect(r.assessed).toHaveLength(1);
    const [fc] = await db.select().from(invoices).where(eq(invoices.id, r.assessed[0].invoiceId));
    expect(fc.toBePrinted).toBe(true);
    const lines = await db.query.invoiceLines.findMany({ where: (l, { eq: e }) => e(l.invoiceId, fc.id) });
    expect(lines[0].accountId).toBe(acct['4000']);
  });

  it('"Assess finance charges on overdue finance charges" adds unpaid finance charges to the base', async () => {
    const asOf = new Date('2026-05-15T00:00:00Z');
    const off = await previewFinanceCharges(ctx, { asOf });
    const offRows = off.customers.find((c) => c.customerId === customerId)!.overdueInvoices;
    expect(offRows.map((r) => r.invoiceId)).toEqual([invoiceId]);
    await updateFinanceChargeSettings(ctx, { assessOnFinanceCharges: true });
    const on = await previewFinanceCharges(ctx, { asOf });
    const onRows = on.customers.find((c) => c.customerId === customerId)!.overdueInvoices;
    expect(onRows.length).toBe(2);
    await updateFinanceChargeSettings(ctx, { assessOnFinanceCharges: false });
  });
});
