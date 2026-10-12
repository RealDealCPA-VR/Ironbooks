/**
 * Independent QA (tester) — wave-2 payroll team, RE-TEST of fix round 3 (L6).
 *
 * Fix round 3 (9b9b04f):
 *   - IIF documents with an OPENBAL column count only the open part as owed; total - open is
 *     "already applied" (absorbs same-file payments, never adds a balance);
 *   - collectIifControlRows skips transactions the ledger refuses (closed fiscal period /
 *     closing date / ledger limits), so a refused payment never reduces what a name owes.
 *
 * These tests probe the edges: credit memos with OPENBAL, OPENBAL + a payment larger than the
 * applied part, OPENBAL 0, the A/P mirror with its BILLPMT, the exact closing date, the closing
 * date password override, and re-importing a file with an extra payment (duplicate payments the
 * ledger skips must not be applied twice).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, companies, fiscalPeriods, journalEntries, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { trialBalance } from './reports';
import { importIIF } from './qbImport';
import { arApReconciliation } from './openItemsImport';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-qb-migration-wave2-retest3');
let db: DB;

const t = (...c: string[]) => c.join('\t');
let seq = 0;

async function newCompany(name: string): Promise<ServiceContext> {
  seq++;
  const [user] = await db.insert(users).values({ email: `qa-retest3-${seq}@test.local`, name: 'QA', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name, ownerId: user.id });
  return { db, companyId: company.id, userId: user.id };
}

async function bal(ctx: ServiceContext, code: string) {
  const [a] = await ctx.db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  return Number(a.balance);
}

async function jeCount(ctx: ServiceContext) {
  return (await ctx.db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
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
const cm = (date: string, name: string, amt: string, num: string, open = '') => [
  t('TRNS', '', 'CREDIT MEMO', date, 'Accounts Receivable', name, `-${amt}`, num, '', 'N', open ? `-${open}` : ''),
  t('SPL', '', 'CREDIT MEMO', date, 'Sales Income', '', amt, num, ''),
  t('ENDTRNS'),
];
const bill = (date: string, name: string, amt: string, num: string, paid = 'N', open = '') => [
  t('TRNS', '', 'BILL', date, 'Accounts Payable', name, `-${amt}`, num, '', paid, open ? `-${open}` : ''),
  t('SPL', '', 'BILL', date, 'Office Supplies', '', amt, num, ''),
  t('ENDTRNS'),
];
const pmt = (date: string, name: string, amt: string) => [
  t('TRNS', '', 'PAYMENT', date, 'Undeposited Funds', name, amt, '', '', '', ''),
  t('SPL', '', 'PAYMENT', date, 'Accounts Receivable', name, `-${amt}`, '', ''),
  t('ENDTRNS'),
];
const billpmt = (date: string, name: string, amt: string, num: string) => [
  t('TRNS', '', 'BILLPMT', date, 'Checking', name, `-${amt}`, num, '', '', ''),
  t('SPL', '', 'BILLPMT', date, 'Accounts Payable', name, amt, num, ''),
  t('ENDTRNS'),
];
const AS_DOCS = { openItems: { asDocuments: true, alreadyInGl: false } };
const iif = (...blocks: string[][]) => [...HDR, ...blocks.flat()].join('\r\n');

describe('wave-2 QB migration — re-test of fix round 3 (L6 OPENBAL + refused payments)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
  }, 300_000);

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('OPENBAL edges', () => {
    it('credit memo 100 with OPENBAL 40 and no refund in the file stays a 40 credit', async () => {
      const ctx = await newCompany('R3 CM Openbal');
      await importIIF(ctx, iif(cm('12/01/2025', 'CM Co', '100.00', 'CM-1', '40.00')), AS_DOCS);
      const rec = await tie(ctx);
      expect(rec.ar.aging).toBe('-40.00');
    });

    it('invoice 500 OPENBAL 300 with a 250 payment in the file: customer owes 250, cash 250', async () => {
      // 200 of the payment is the part QuickBooks already applied; the extra 50 is a credit
      // that reduces what the customer owes.
      const ctx = await newCompany('R3 Openbal Overpay');
      await importIIF(ctx, iif(inv('12/01/2025', 'Over Co', '500.00', 'R3-1', 'N', '300.00'), pmt('12/10/2025', 'Over Co', '250.00')), AS_DOCS);
      const rec = await tie(ctx);
      expect(rec.ar.aging).toBe('250.00');
      expect(await bal(ctx, '1050')).toBe(250);
    });

    it('invoice 500 OPENBAL 0 (PAID=N) with no payment in the file owes nothing', async () => {
      const ctx = await newCompany('R3 Openbal Zero');
      await importIIF(ctx, iif(inv('12/01/2025', 'Zero Co', '500.00', 'R3-2', 'N', '0.00')), AS_DOCS);
      const rec = await tie(ctx);
      expect(rec.ar.aging).toBe('0.00');
    });

    it('invoice 500 OPENBAL 0 with its full 500 payment in the file: owes nothing, cash 500', async () => {
      const ctx = await newCompany('R3 Openbal Zero Paid');
      await importIIF(ctx, iif(inv('12/01/2025', 'Zero Paid Co', '500.00', 'R3-3', 'N', '0.00'), pmt('12/10/2025', 'Zero Paid Co', '500.00')), AS_DOCS);
      const rec = await tie(ctx);
      expect(rec.ar.aging).toBe('0.00');
      expect(await bal(ctx, '1050')).toBe(500);
    });

    it('two OPENBAL invoices for one customer and one payment equal to both applied parts', async () => {
      const ctx = await newCompany('R3 Two Openbal');
      await importIIF(
        ctx,
        iif(
          inv('12/01/2025', 'Pair Co', '500.00', 'R3-4', 'N', '300.00'),
          inv('12/02/2025', 'Pair Co', '200.00', 'R3-5', 'N', '50.00'),
          pmt('12/10/2025', 'Pair Co', '350.00'),
        ),
        AS_DOCS,
      );
      const rec = await tie(ctx);
      expect(rec.ar.aging).toBe('350.00');
      expect(await bal(ctx, '1050')).toBe(350);
    });

    it('A/P: bill 400 OPENBAL 150 with its 250 BILLPMT in the file: vendor owed 150, checking -250', async () => {
      const ctx = await newCompany('R3 Bill Openbal Pmt');
      await importIIF(ctx, iif(bill('12/01/2025', 'Paper R3', '400.00', 'B-1', 'N', '150.00'), billpmt('12/10/2025', 'Paper R3', '250.00', '7001')), AS_DOCS);
      const rec = await tie(ctx);
      expect(rec.ap.aging).toBe('150.00');
      expect(await bal(ctx, '1000')).toBe(-250);
    });

    it('malformed OPENBAL larger than the invoice total still keeps control == aging and TB balanced', async () => {
      const ctx = await newCompany('R3 Openbal Too Big');
      await importIIF(ctx, iif(inv('12/01/2025', 'Big Open Co', '500.00', 'R3-6', 'N', '600.00')), AS_DOCS);
      await tie(ctx);
    });
  });

  describe('payments the ledger refuses are never applied', () => {
    it('a PAYMENT dated exactly ON the closing date is refused and not applied', async () => {
      const ctx = await newCompany('R3 On Closing Date');
      await db.update(companies).set({ settings: { closingDate: '2025-12-10' } }).where(eq(companies.id, ctx.companyId));
      await importIIF(ctx, iif(pmt('12/10/2025', 'Edge Co', '200.00'), inv('12/20/2025', 'Edge Co', '500.00', 'R3-7')), AS_DOCS);
      const rec = await tie(ctx);
      const cash = await bal(ctx, '1050');
      expect(cash + Number(rec.ar.aging)).toBe(500);
    });

    it('a BILLPMT refused by the closing date leaves the vendor owed the whole bill', async () => {
      const ctx = await newCompany('R3 Closed Billpmt');
      await db.update(companies).set({ settings: { closingDate: '2025-12-10' } }).where(eq(companies.id, ctx.companyId));
      await importIIF(ctx, iif(billpmt('12/05/2025', 'Closed Vendor', '150.00', '7002'), bill('12/20/2025', 'Closed Vendor', '400.00', 'B-2')), AS_DOCS);
      const rec = await tie(ctx);
      const paid = -(await bal(ctx, '1000'));
      expect(paid + Number(rec.ap.aging)).toBe(400);
    });

    it('a PAYMENT in a closed fiscal period that ends on the payment date is refused and not applied', async () => {
      const ctx = await newCompany('R3 Period End Pmt');
      await ctx.db.insert(fiscalPeriods).values({
        companyId: ctx.companyId,
        periodStart: new Date('2025-11-01T00:00:00Z'),
        periodEnd: new Date('2025-11-30T00:00:00Z'),
        isClosed: true,
      });
      await importIIF(ctx, iif(pmt('11/30/2025', 'Period End Co', '200.00'), inv('12/05/2025', 'Period End Co', '500.00', 'R3-8')), AS_DOCS);
      const rec = await tie(ctx);
      const cash = await bal(ctx, '1050');
      expect(cash + Number(rec.ar.aging)).toBe(500);
    });

    it('with the closing-date password (closingDateOverride) the payment posts AND is applied', async () => {
      const base = await newCompany('R3 Override');
      await db.update(companies).set({ settings: { closingDate: '2025-12-10' } }).where(eq(companies.id, base.companyId));
      const ctx: ServiceContext = { ...base, closingDateOverride: true };
      await importIIF(ctx, iif(pmt('12/05/2025', 'Override Co', '200.00'), inv('12/20/2025', 'Override Co', '500.00', 'R3-9')), AS_DOCS);
      const rec = await tie(ctx);
      expect(await bal(ctx, '1050')).toBe(200);
      expect(rec.ar.aging).toBe('300.00');
    });
  });

  describe('re-import idempotency with payments', () => {
    it('re-importing the same file plus one new payment applies only the new payment', async () => {
      // First file: invoice 500 + payment 200. Second file: the same rows plus a new 100
      // payment. The repeated 200 payment is a duplicate the ledger skips; it must not be
      // applied to the customer a second time.
      const ctx = await newCompany('R3 Reimport Extra');
      const first = [inv('12/01/2025', 'Again Co', '500.00', 'R3-10'), pmt('12/10/2025', 'Again Co', '200.00')];
      await importIIF(ctx, iif(...first), AS_DOCS);
      let rec = await tie(ctx);
      expect(rec.ar.aging).toBe('300.00');
      await importIIF(ctx, iif(...first, pmt('12/15/2025', 'Again Co', '100.00')), AS_DOCS);
      rec = await tie(ctx);
      const cash = await bal(ctx, '1050');
      expect(cash).toBe(300);
      expect(rec.ar.aging, 'cash 300 received against 500 invoiced: customer owes 200').toBe('200.00');
    });

    it('re-importing an identical OPENBAL file changes nothing', async () => {
      const ctx = await newCompany('R3 Reimport Openbal');
      const file = iif(inv('12/01/2025', 'Same Co', '500.00', 'R3-11', 'N', '300.00'), pmt('12/10/2025', 'Same Co', '200.00'));
      await importIIF(ctx, file, AS_DOCS);
      const before = await jeCount(ctx);
      await importIIF(ctx, file, AS_DOCS);
      expect(await jeCount(ctx)).toBe(before);
      const rec = await tie(ctx);
      expect(rec.ar.aging).toBe('300.00');
      expect(await bal(ctx, '1050')).toBe(200);
    });
  });
});
