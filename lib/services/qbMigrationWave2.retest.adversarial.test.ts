/**
 * Independent QA (tester) — wave-2 payroll team, RE-TEST of fix round 1.
 *
 * Probes the three fixes around the edges the first round did not cover:
 *   L1  full-path matching: a leaf-only ref shared by two parents is refused; an unknown sub
 *       under a KNOWN parent never posts to that parent; case/spacing variants of a real path work.
 *   L6  IIF open items with payments: the A/P mirror (PAID bill + BILLPMT), partially paid
 *       invoices whose payment is in the file, cash preserved, whole-file re-import idempotent.
 *   L6  typed-in balances that are positive but ROUND to zero are invalid input, not skipped rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, bills, customers, invoices, journalEntries, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { trialBalance } from './reports';
import { importIIF } from './qbImport';
import { arApReconciliation, importOpenItems } from './openItemsImport';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-qb-migration-wave2-retest');
let db: DB;

const t = (...c: string[]) => c.join('\t');
let seq = 0;

async function newCompany(name: string): Promise<ServiceContext> {
  seq++;
  const [user] = await db.insert(users).values({ email: `qa-retest-${seq}@test.local`, name: 'QA', passwordHash: 'x' }).returning();
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

async function expectSubledgersTie(ctx: ServiceContext) {
  const rec = await arApReconciliation(ctx);
  expect(rec.ar.difference, `A/R control ${rec.ar.control} vs aging ${rec.ar.aging}`).toBe('0.00');
  expect(rec.ap.difference, `A/P control ${rec.ap.control} vs aging ${rec.ap.aging}`).toBe('0.00');
  expect((await trialBalance(ctx)).balanced).toBe(true);
  return rec;
}

const HDR = [
  t('!TRNS', 'TRNSID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO', 'PAID'),
  t('!SPL', 'SPLID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO'),
  t('!ENDTRNS'),
];

describe('wave-2 QB migration — re-test of fix round 1', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
  }, 300_000);

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // L1
  // -------------------------------------------------------------------------
  describe('L1 full-path resolution edges', () => {
    let ctx: ServiceContext;
    beforeAll(async () => {
      ctx = await newCompany('L1 Retest Co');
      await importIIF(
        ctx,
        [
          t('!ACCNT', 'NAME', 'ACCNTTYPE', 'ACCNUM'),
          t('ACCNT', 'Entertainment', 'EXP', '6410'),
          t('ACCNT', 'Entertainment:Meals', 'EXP', '6411'),
          t('ACCNT', 'Travel', 'EXP', '6420'),
          t('ACCNT', 'Travel:Meals', 'EXP', '6421'),
          t('ACCNT', 'Ops Bank', 'BANK', '1011'),
        ].join('\r\n'),
      );
    }, 300_000);

    it('a leaf-only "Meals" shared by two parents is refused and posts nothing', async () => {
      const before = await jeCount(ctx);
      const counts = await importIIF(
        ctx,
        [
          ...HDR,
          t('TRNS', '', 'GENERAL JOURNAL', '3/1/2026', 'Meals', '', '15.00', 'A1', '', ''),
          t('SPL', '', 'GENERAL JOURNAL', '3/1/2026', 'Ops Bank', '', '-15.00', 'A1', ''),
          t('ENDTRNS'),
        ].join('\r\n'),
      );
      expect(counts.transactions).toBe(0);
      expect(await jeCount(ctx)).toBe(before);
      expect(Number((await acct(ctx, '6411')).balance)).toBe(0);
      expect(Number((await acct(ctx, '6421')).balance)).toBe(0);
    });

    it('an unknown sub under a KNOWN parent never posts to the parent or a sibling', async () => {
      await importIIF(
        ctx,
        [
          ...HDR,
          t('TRNS', '', 'GENERAL JOURNAL', '3/2/2026', 'Entertainment:Snacks', '', '7.00', 'A2', '', ''),
          t('SPL', '', 'GENERAL JOURNAL', '3/2/2026', 'Ops Bank', '', '-7.00', 'A2', ''),
          t('ENDTRNS'),
        ].join('\r\n'),
      );
      expect(Number((await acct(ctx, '6410')).balance)).toBe(0);
      expect(Number((await acct(ctx, '6411')).balance)).toBe(0);
      expect(Number((await acct(ctx, '6421')).balance)).toBe(0);
      expect(Number((await acct(ctx, '1011')).balance)).toBe(-7);
      expect((await trialBalance(ctx)).balanced).toBe(true);
    });

    it('case and spacing variants of a real full path resolve to that exact account', async () => {
      await importIIF(
        ctx,
        [
          ...HDR,
          t('TRNS', '', 'GENERAL JOURNAL', '3/3/2026', 'travel : meals', '', '20.00', 'A3', '', ''),
          t('SPL', '', 'GENERAL JOURNAL', '3/3/2026', 'Ops Bank', '', '-20.00', 'A3', ''),
          t('ENDTRNS'),
        ].join('\r\n'),
      );
      expect(Number((await acct(ctx, '6421')).balance)).toBe(20);
      expect(Number((await acct(ctx, '6411')).balance)).toBe(0);
      expect((await trialBalance(ctx)).balanced).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // L6 IIF documents + payments
  // -------------------------------------------------------------------------
  describe('L6 IIF documents with their payments (fresh books)', () => {
    it('A/P mirror: a PAID bill plus its BILLPMT keeps A/P control == aging and cash is preserved', async () => {
      const ctx = await newCompany('L6 Retest AP Co');
      const iif = [
        ...HDR,
        t('TRNS', '', 'BILL', '12/01/2025', 'Accounts Payable', 'Paper Inc', '-250.00', 'B-1', '', 'Y'),
        t('SPL', '', 'BILL', '12/01/2025', 'Office Supplies', '', '250.00', 'B-1', ''),
        t('ENDTRNS'),
        t('TRNS', '', 'BILLPMT', '12/10/2025', 'Checking', 'Paper Inc', '-250.00', '501', '', ''),
        t('SPL', '', 'BILLPMT', '12/10/2025', 'Accounts Payable', 'Paper Inc', '250.00', '501', ''),
        t('ENDTRNS'),
        t('TRNS', '', 'BILL', '12/05/2025', 'Accounts Payable', 'Paper Inc', '-80.00', 'B-2', '', 'N'),
        t('SPL', '', 'BILL', '12/05/2025', 'Office Supplies', '', '80.00', 'B-2', ''),
        t('ENDTRNS'),
      ].join('\r\n');
      await importIIF(ctx, iif, { openItems: { asDocuments: true, alreadyInGl: false } });
      const rec = await expectSubledgersTie(ctx);
      expect(rec.ap.aging).toBe('80.00');
      expect(rec.ap.control).toBe('80.00');
      // The check really left the bank.
      expect(Number((await acct(ctx, '1000')).balance)).toBe(-250);
      const b = await ctx.db.select().from(bills).where(eq(bills.companyId, ctx.companyId));
      expect(b.map((x) => x.billNumber)).toEqual(['B-2']);
    });

    it('re-importing the same IIF (documents + payments) changes nothing', async () => {
      const ctx = await newCompany('L6 Retest Idem Co');
      const iif = [
        ...HDR,
        t('TRNS', '', 'INVOICE', '12/16/2025', 'Accounts Receivable', 'Idem Co', '90.00', '3002', '', 'Y'),
        t('SPL', '', 'INVOICE', '12/16/2025', 'Sales Income', '', '-90.00', '3002', ''),
        t('ENDTRNS'),
        t('TRNS', '', 'PAYMENT', '12/20/2025', 'Undeposited Funds', 'Idem Co', '90.00', '', 'Pays 3002', ''),
        t('SPL', '', 'PAYMENT', '12/20/2025', 'Accounts Receivable', 'Idem Co', '-90.00', '', ''),
        t('ENDTRNS'),
        t('TRNS', '', 'INVOICE', '12/18/2025', 'Accounts Receivable', 'Idem Co', '400.00', '3003', '', 'N'),
        t('SPL', '', 'INVOICE', '12/18/2025', 'Sales Income', '', '-400.00', '3003', ''),
        t('ENDTRNS'),
      ].join('\r\n');
      await importIIF(ctx, iif, { openItems: { asDocuments: true, alreadyInGl: false } });
      const rec1 = await expectSubledgersTie(ctx);
      const jes1 = await jeCount(ctx);
      const inv1 = (await ctx.db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId))).length;
      const uf1 = (await acct(ctx, '1050')).balance;

      await importIIF(ctx, iif, { openItems: { asDocuments: true, alreadyInGl: false } });
      const rec2 = await expectSubledgersTie(ctx);
      expect(rec2.ar.control).toBe(rec1.ar.control);
      expect(rec2.ar.aging).toBe('400.00');
      expect(await jeCount(ctx)).toBe(jes1);
      expect((await ctx.db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId))).length).toBe(inv1);
      expect((await acct(ctx, '1050')).balance).toBe(uf1);
      expect(Number(uf1)).toBe(90);
    });

    it('an OPEN invoice partly paid by a PAYMENT in the same IIF shows the customer owing the remainder', async () => {
      // QuickBooks: invoice 500, payment 200 applied → customer owes 300. The payment's A/R row is
      // re-pointed to the conversion account and the invoice is brought in at its full 500 (IIF
      // carries no open balance), so the aging / customer statement says 500.
      const ctx = await newCompany('L6 Retest Partial Co');
      const iif = [
        ...HDR,
        t('TRNS', '', 'INVOICE', '12/01/2025', 'Accounts Receivable', 'Part Co', '500.00', '4001', '', 'N'),
        t('SPL', '', 'INVOICE', '12/01/2025', 'Sales Income', '', '-500.00', '4001', ''),
        t('ENDTRNS'),
        t('TRNS', '', 'PAYMENT', '12/15/2025', 'Undeposited Funds', 'Part Co', '200.00', '', 'Partial on 4001', ''),
        t('SPL', '', 'PAYMENT', '12/15/2025', 'Accounts Receivable', 'Part Co', '-200.00', '', ''),
        t('ENDTRNS'),
      ].join('\r\n');
      await importIIF(ctx, iif, { openItems: { asDocuments: true, alreadyInGl: false } });
      const rec = await expectSubledgersTie(ctx);
      expect(Number((await acct(ctx, '1050')).balance)).toBe(200);
      expect(rec.ar.aging, 'Part Co really owes 300 in QuickBooks').toBe('300.00');
      expect(rec.ar.control).toBe('300.00');
    });
  });

  // -------------------------------------------------------------------------
  // L6 typed-in balances: positive but rounds to zero
  // -------------------------------------------------------------------------
  describe('L6 typed-in balances that are not real cents', () => {
    let ctx: ServiceContext;
    beforeAll(async () => {
      ctx = await newCompany('L6 Retest Cents Co');
    }, 300_000);

    for (const bad of ['0.00', '-0', '0.001', '0.004', 'NaN', 'Infinity', '1e400', 'abc', '']) {
      it(`openBalance "${bad}" is refused as VALIDATION and writes nothing`, async () => {
        const name = `Cents ${bad || 'blank'}`;
        await expect(
          importOpenItems(ctx, { side: 'ar', alreadyInGl: false, items: [{ kind: 'invoice', name, date: '2026-01-01', openBalance: bad }] }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        const custs = await ctx.db.select().from(customers).where(and(eq(customers.companyId, ctx.companyId), eq(customers.displayName, name)));
        expect(custs).toHaveLength(0);
        expect(await jeCount(ctx)).toBe(0);
      });
    }

    it('a 3-decimal balance is rounded to cents once, consistently in control and aging', async () => {
      const r = await importOpenItems(ctx, {
        side: 'ar',
        alreadyInGl: false,
        items: [
          { kind: 'invoice', name: 'Round Co', date: '2026-01-01', number: 'R1', openBalance: '10.005' },
          { kind: 'invoice', name: 'Round Co', date: '2026-01-02', number: 'R2', openBalance: '10.004' },
        ],
      });
      expect(r.invoices).toBe(2);
      const rec = await expectSubledgersTie(ctx);
      expect(rec.ar.control).toBe('20.01');
    });
  });
});
