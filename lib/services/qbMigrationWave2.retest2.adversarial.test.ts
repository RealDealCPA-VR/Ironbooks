/**
 * Independent QA (tester) — wave-2 payroll team, RE-TEST of fix round 2 (L6).
 *
 * Round 2 applies same-file payments / bill payments to the open documents brought in from an
 * IIF. These tests probe the edges of that rule:
 *   - an export that carries an OPEN BALANCE column but NOT the payment that produced it
 *     (QuickBooks already netted it — the item must not be inflated back to its full amount);
 *   - a payment that the import refuses to post (closing date, unbalanced rows) must not be
 *     applied to the customer either — the money has to land somewhere (cash or the customer);
 *   - name matching (case / spacing), isolation between customers, PAID + overpayment;
 *   - typed-in amount upper bound at the numeric(15,2) edge.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, companies, customers, invoices, journalEntries, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { trialBalance } from './reports';
import { importIIF } from './qbImport';
import { arApReconciliation, importOpenItems } from './openItemsImport';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-qb-migration-wave2-retest2');
let db: DB;

const t = (...c: string[]) => c.join('\t');
let seq = 0;

async function newCompany(name: string): Promise<ServiceContext> {
  seq++;
  const [user] = await db.insert(users).values({ email: `qa-retest2-${seq}@test.local`, name: 'QA', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name, ownerId: user.id });
  return { db, companyId: company.id, userId: user.id };
}

async function acct(ctx: ServiceContext, code: string) {
  const [a] = await ctx.db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  return a;
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
const bill = (date: string, name: string, amt: string, num: string, paid = 'N', open = '') => [
  t('TRNS', '', 'BILL', date, 'Accounts Payable', name, `-${amt}`, num, '', paid, open ? `-${open}` : ''),
  t('SPL', '', 'BILL', date, 'Office Supplies', '', amt, num, ''),
  t('ENDTRNS'),
];
const pmt = (date: string, name: string, amt: string, splAmt = `-${amt}`) => [
  t('TRNS', '', 'PAYMENT', date, 'Undeposited Funds', name, amt, '', '', '', ''),
  t('SPL', '', 'PAYMENT', date, 'Accounts Receivable', name, splAmt, '', ''),
  t('ENDTRNS'),
];
const AS_DOCS = { openItems: { asDocuments: true, alreadyInGl: false } };

describe('wave-2 QB migration — re-test of fix round 2 (L6 payments)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
  }, 300_000);

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('exports that carry an open balance but not the payment', () => {
    it('A/R: invoice 500 with OPENBAL 300 and no payment in the file stays at 300', async () => {
      // QuickBooks already applied 200 of payments (dated outside this export). The OPENBAL
      // column is the real balance; nothing in the file should push it back up to 500.
      const ctx = await newCompany('R2 Openbal Only AR');
      await importIIF(ctx, [...HDR, ...inv('12/01/2025', 'Net Only Co', '500.00', '9101', 'N', '300.00')].join('\r\n'), AS_DOCS);
      const rec = await tie(ctx);
      expect(rec.ar.aging, 'customer owes the QuickBooks open balance, 300').toBe('300.00');
      expect(rec.ar.control).toBe('300.00');
    });

    it('A/P: bill 400 with OPENBAL 150 and no bill payment in the file stays at 150', async () => {
      const ctx = await newCompany('R2 Openbal Only AP');
      await importIIF(ctx, [...HDR, ...bill('12/01/2025', 'Net Vendor', '400.00', 'NB-1', 'N', '150.00')].join('\r\n'), AS_DOCS);
      const rec = await tie(ctx);
      expect(rec.ap.aging, 'vendor is owed the QuickBooks open balance, 150').toBe('150.00');
      expect(rec.ap.control).toBe('150.00');
    });
  });

  describe('payments the import does not post are not applied either', () => {
    it('an unbalanced PAYMENT is skipped and the invoice stays at its full amount', async () => {
      const ctx = await newCompany('R2 Unbalanced Pmt');
      const counts = await importIIF(
        ctx,
        [...HDR, ...inv('12/01/2025', 'Bad Pmt Co', '500.00', '9201'), ...pmt('12/15/2025', 'Bad Pmt Co', '200.00', '-150.00')].join('\r\n'),
        AS_DOCS,
      );
      expect(counts.transactions).toBe(0);
      const rec = await tie(ctx);
      expect(Number((await acct(ctx, '1050')).balance)).toBe(0);
      expect(rec.ar.aging).toBe('500.00');
    });

    it('a PAYMENT refused by the closing date does not reduce what the customer owes', async () => {
      // Closing date 12/10. The customer's prepayment (12/05) is in the closed period, so its
      // journal entry is refused; the open invoice (12/20) is after the closing date.
      // Money must be conserved: either the cash is in the books, or the customer still owes it.
      const ctx = await newCompany('R2 Closed Pmt');
      await db.update(companies).set({ settings: { closingDate: '2025-12-10' } }).where(eq(companies.id, ctx.companyId));
      const counts = await importIIF(
        ctx,
        [...HDR, ...pmt('12/05/2025', 'Closed Co', '200.00'), ...inv('12/20/2025', 'Closed Co', '500.00', '9301')].join('\r\n'),
        AS_DOCS,
      );
      const rec = await tie(ctx);
      const cash = Number((await acct(ctx, '1050')).balance);
      expect(
        cash + Number(rec.ar.aging),
        `cash ${cash} + customer balance ${rec.ar.aging} must equal the 500 invoiced (posted ${counts.transactions} txns)`,
      ).toBe(500);
    });
  });

  describe('name matching and isolation', () => {
    it('a payment whose name differs only in case / spacing is applied to that customer', async () => {
      const ctx = await newCompany('R2 Case Co');
      await importIIF(ctx, [...HDR, ...inv('12/01/2025', 'Case Co', '500.00', '9401'), ...pmt('12/15/2025', '  case co ', '200.00')].join('\r\n'), AS_DOCS);
      const rec = await tie(ctx);
      expect(rec.ar.aging).toBe('300.00');
      const custs = await ctx.db.select().from(customers).where(eq(customers.companyId, ctx.companyId));
      expect(custs.filter((c) => c.displayName.trim().toLowerCase() === 'case co')).toHaveLength(1);
    });

    it("one customer's payment never reduces another customer's invoice", async () => {
      const ctx = await newCompany('R2 Isolation');
      await importIIF(
        ctx,
        [
          ...HDR,
          ...inv('12/01/2025', 'Alpha Co', '100.00', '9501'),
          ...inv('12/01/2025', 'Beta Co', '100.00', '9502'),
          ...pmt('12/15/2025', 'Alpha Co', '150.00'),
        ].join('\r\n'),
        AS_DOCS,
      );
      const rec = await tie(ctx);
      // Alpha: 100 - 150 = -50 credit; Beta: 100. Total 50.
      expect(rec.ar.aging).toBe('50.00');
      const [beta] = await ctx.db.select().from(customers).where(and(eq(customers.companyId, ctx.companyId), eq(customers.displayName, 'Beta Co')));
      expect(beta).toBeTruthy();
      const betaInv = await ctx.db.select().from(invoices).where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.customerId, beta.id)));
      expect(betaInv).toHaveLength(1);
      expect(Number(betaInv[0].total)).toBe(100);
    });

    it('a PAID invoice overpaid in the same file leaves only the excess as a credit', async () => {
      const ctx = await newCompany('R2 Paid Overpay');
      await importIIF(ctx, [...HDR, ...inv('12/01/2025', 'Over Paid Co', '90.00', '9601', 'Y'), ...pmt('12/03/2025', 'Over Paid Co', '120.00')].join('\r\n'), AS_DOCS);
      const rec = await tie(ctx);
      expect(rec.ar.aging).toBe('-30.00');
      expect(Number((await acct(ctx, '1050')).balance)).toBe(120);
    });

    it('re-importing a file whose payment is larger than the invoice does not add a second credit', async () => {
      const ctx = await newCompany('R2 Overpay Reimport');
      const iif = [...HDR, ...inv('12/01/2025', 'Twice Co', '100.00', '9701'), ...pmt('12/20/2025', 'Twice Co', '150.00')].join('\r\n');
      await importIIF(ctx, iif, AS_DOCS);
      const before = await jeCount(ctx);
      await importIIF(ctx, iif, AS_DOCS);
      expect(await jeCount(ctx)).toBe(before);
      const rec = await tie(ctx);
      expect(rec.ar.aging).toBe('-50.00');
    });
  });

  describe('typed-in amount bounds (numeric(15,2))', () => {
    let ctx: ServiceContext;
    beforeAll(async () => {
      ctx = await newCompany('R2 Bounds Co');
    }, 300_000);

    for (const bad of ['10000000000000', '9999999999999.995', '1e14']) {
      it(`openBalance "${bad}" is refused as VALIDATION and writes nothing`, async () => {
        const before = await jeCount(ctx);
        await expect(
          importOpenItems(ctx, { side: 'ar', alreadyInGl: false, items: [{ kind: 'invoice', name: `Big ${bad}`, date: '2026-01-01', openBalance: bad }] }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        expect(await jeCount(ctx)).toBe(before);
      });
    }

    it('openBalance "0.005" rounds to one cent and is accepted', async () => {
      const r = await importOpenItems(ctx, {
        side: 'ar',
        alreadyInGl: false,
        items: [{ kind: 'invoice', name: 'Half Cent Co', date: '2026-01-01', number: 'HC1', openBalance: '0.005' }],
      });
      expect(r.invoices).toBe(1);
      const rec = await tie(ctx);
      expect(rec.ar.aging).toBe('0.01');
    });
  });
});
