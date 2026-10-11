/**
 * L6 fix round 2: payments, bill payments and other named A/R / A/P rows in the same IIF as
 * the open documents are APPLIED to that customer's / vendor's open documents (not dropped into
 * the conversion account), so each name's aging equals its real QuickBooks balance.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, invoices, journalEntries, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { trialBalance } from './reports';
import { importIIF } from './qbImport';
import { arApReconciliation } from './openItemsImport';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-qb-migration-wave2-payments');
let db: DB;

const t = (...c: string[]) => c.join('\t');
let seq = 0;

async function newCompany(name: string): Promise<ServiceContext> {
  seq++;
  const [user] = await db.insert(users).values({ email: `qa-pay-${seq}@test.local`, name: 'QA', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name, ownerId: user.id });
  return { db, companyId: company.id, userId: user.id };
}

async function acct(ctx: ServiceContext, code: string) {
  const [a] = await ctx.db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  return a;
}

async function tie(ctx: ServiceContext) {
  const rec = await arApReconciliation(ctx);
  expect(rec.ar.difference, `A/R control ${rec.ar.control} vs aging ${rec.ar.aging}`).toBe('0.00');
  expect(rec.ap.difference, `A/P control ${rec.ap.control} vs aging ${rec.ap.aging}`).toBe('0.00');
  expect((await trialBalance(ctx)).balanced).toBe(true);
  return rec;
}

const HDR = [
  t('!TRNS', 'TRNSID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO', 'PAID', 'OPENBAL'),
  t('!SPL', 'SPLID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO'),
  t('!ENDTRNS'),
];
const inv = (date: string, name: string, amt: string, num: string, paid = 'N', open = '') => [
  t('TRNS', '', 'INVOICE', date, 'Accounts Receivable', name, amt, num, '', paid, open),
  t('SPL', '', 'INVOICE', date, 'Sales Income', '', `-${amt}`, num, ''),
  t('ENDTRNS'),
];
const pmt = (date: string, name: string, amt: string) => [
  t('TRNS', '', 'PAYMENT', date, 'Undeposited Funds', name, amt, '', '', '', ''),
  t('SPL', '', 'PAYMENT', date, 'Accounts Receivable', name, `-${amt}`, '', ''),
  t('ENDTRNS'),
];

describe('L6 — payments in the same IIF are applied to the open documents', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
  }, 300_000);

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('A/P: an open bill partly paid by a BILLPMT shows the vendor owed the remainder; cash leaves Checking', async () => {
    const ctx = await newCompany('Pay AP Partial');
    const iif = [
      ...HDR,
      t('TRNS', '', 'BILL', '12/01/2025', 'Accounts Payable', 'Paper Inc', '-300.00', 'B-1', '', 'N', ''),
      t('SPL', '', 'BILL', '12/01/2025', 'Office Supplies', '', '300.00', 'B-1', ''),
      t('ENDTRNS'),
      t('TRNS', '', 'BILLPMT', '12/10/2025', 'Checking', 'Paper Inc', '-120.00', '501', '', '', ''),
      t('SPL', '', 'BILLPMT', '12/10/2025', 'Accounts Payable', 'Paper Inc', '120.00', '501', ''),
      t('ENDTRNS'),
    ].join('\r\n');
    await importIIF(ctx, iif, { openItems: { asDocuments: true, alreadyInGl: false } });
    const rec = await tie(ctx);
    expect(rec.ap.aging).toBe('180.00');
    expect(rec.ap.control).toBe('180.00');
    expect(Number((await acct(ctx, '1000')).balance)).toBe(-120);
  });

  it('a payment larger than the open invoice leaves the rest as an unapplied customer credit', async () => {
    const ctx = await newCompany('Pay Overpaid');
    const iif = [...HDR, ...inv('12/01/2025', 'Over Co', '100.00', '7001'), ...pmt('12/20/2025', 'Over Co', '150.00')].join('\r\n');
    const counts = await importIIF(ctx, iif, { openItems: { asDocuments: true, alreadyInGl: false } });
    const rec = await tie(ctx);
    expect(rec.ar.aging).toBe('-50.00');
    expect(counts.openItems).toMatchObject({ invoices: 0, credits: 1 });
  });

  it('a payment is applied to the oldest open invoice first', async () => {
    const ctx = await newCompany('Pay Oldest First');
    const iif = [
      ...HDR,
      ...inv('12/05/2025', 'Two Co', '400.00', '8002'),
      ...inv('12/01/2025', 'Two Co', '300.00', '8001'),
      ...pmt('12/20/2025', 'Two Co', '450.00'),
    ].join('\r\n');
    await importIIF(ctx, iif, { openItems: { asDocuments: true, alreadyInGl: false } });
    const rec = await tie(ctx);
    expect(rec.ar.aging).toBe('250.00');
    const rows = await ctx.db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].total)).toBe(250);
    expect(rows[0].memo).toContain('8002');
  });

  it('an export that already carries the open balance is not reduced a second time by its payment', async () => {
    const ctx = await newCompany('Pay Openbal');
    const iif = [...HDR, ...inv('12/01/2025', 'Net Co', '500.00', '9001', 'N', '300.00'), ...pmt('12/15/2025', 'Net Co', '200.00')].join('\r\n');
    await importIIF(ctx, iif, { openItems: { asDocuments: true, alreadyInGl: false } });
    const rec = await tie(ctx);
    expect(rec.ar.aging).toBe('300.00');
  });

  it('a PAID invoice whose payment is in the file nets to nothing; other customers are untouched', async () => {
    const ctx = await newCompany('Pay Mixed');
    const iif = [
      ...HDR,
      ...inv('12/01/2025', 'Paid Co', '90.00', '6001', 'Y'),
      ...pmt('12/03/2025', 'Paid Co', '90.00'),
      ...inv('12/02/2025', 'Open Co', '40.00', '6002'),
    ].join('\r\n');
    await importIIF(ctx, iif, { openItems: { asDocuments: true, alreadyInGl: false } });
    const rec = await tie(ctx);
    expect(rec.ar.aging).toBe('40.00');
    expect(Number((await acct(ctx, '1050')).balance)).toBe(90);
  });

  it('re-importing the same file (documents + partial payment) changes nothing', async () => {
    const ctx = await newCompany('Pay Reimport');
    const iif = [...HDR, ...inv('12/01/2025', 'Again Co', '500.00', '4401'), ...pmt('12/15/2025', 'Again Co', '200.00')].join('\r\n');
    await importIIF(ctx, iif, { openItems: { asDocuments: true, alreadyInGl: false } });
    const before = (await ctx.db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
    await importIIF(ctx, iif, { openItems: { asDocuments: true, alreadyInGl: false } });
    const after = (await ctx.db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
    expect(after).toBe(before);
    const rec = await tie(ctx);
    expect(rec.ar.aging).toBe('300.00');
  });
});
