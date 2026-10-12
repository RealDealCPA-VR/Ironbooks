/**
 * Independent QA (tester) — wave-2 QuickBooks migration fidelity, adversarial cases.
 *
 * L1 account paths never resolve to a DIFFERENT parent's sub-account · L2 item type map ·
 * L6 open A/R + A/P conversion: subledger == control after Receive Payments / Pay Bills,
 * closing date, malformed input, idempotency vs changed balances, IIF payments of paid
 * invoices · J2 IIF export: restricted users get no SSNs, voided entries are not exported,
 * deep hierarchies round-trip with the same balances.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, like } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, bills, customers, invoices, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate } from './company';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { postJournalEntry, voidJournalEntry } from './posting';
import { receivePayment } from './payments';
import { payBills } from './billPayments';
import { createEmployee, updateEmployee } from './payroll';
import { importIIF, mapIifItemType, isAssemblyType } from './qbImport';
import { exportJournalIif, exportListsIif } from './iifExport';
import { arApReconciliation, importOpenItems, QB_CONVERSION_CLEARING } from './openItemsImport';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-qb-migration-wave2-adversarial');
let db: DB;

const t = (...c: string[]) => c.join('\t');
const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');
let seq = 0;

async function newCompany(name: string): Promise<ServiceContext> {
  seq++;
  const [user] = await db.insert(users).values({ email: `qa-mig-${seq}@test.local`, name: 'QA', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name, ownerId: user.id });
  return { db, companyId: company.id, userId: user.id };
}

async function acct(ctx: ServiceContext, code: string) {
  const [a] = await ctx.db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
  return a;
}

async function accountBalances(ctx: ServiceContext): Promise<Map<string, string>> {
  // Balance by full path for every account with activity (posted entries only).
  const rows = await ctx.db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pathOf = (id: string) => {
    const parts: string[] = [];
    let cur = byId.get(id);
    while (cur) {
      parts.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return parts.join(':');
  };
  const out = new Map<string, string>();
  for (const r of rows) if (Number(r.balance) !== 0) out.set(pathOf(r.id), Number(r.balance).toFixed(2));
  return out;
}

async function expectSubledgersTie(ctx: ServiceContext) {
  const rec = await arApReconciliation(ctx);
  expect(rec.ar.difference, `A/R control ${rec.ar.control} vs aging ${rec.ar.aging}`).toBe('0.00');
  expect(rec.ap.difference, `A/P control ${rec.ap.control} vs aging ${rec.ap.aging}`).toBe('0.00');
  expect((await trialBalance(ctx)).balanced).toBe(true);
  return rec;
}

describe('wave-2 QB migration — adversarial QA', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
  }, 300_000);

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // L2 — pure item type mapping
  // -------------------------------------------------------------------------
  it('L2: every QuickBooks INVITEMTYPE maps to its own item type', () => {
    expect(mapIifItemType('SERV')).toBe('service');
    expect(mapIifItemType('PART')).toBe('inventory');
    expect(mapIifItemType('INVENTORY')).toBe('inventory');
    expect(mapIifItemType('ASSEMBLY')).toBe('inventory');
    expect(isAssemblyType('ASSEMBLY')).toBe(true);
    expect(isAssemblyType('PART')).toBe(false);
    expect(mapIifItemType('NONINV')).toBe('non_inventory');
    expect(mapIifItemType('OTHC')).toBe('other_charge');
    expect(mapIifItemType('DISC')).toBe('discount');
    expect(mapIifItemType('PMT')).toBe('payment');
    expect(mapIifItemType('STAX')).toBe('sales_tax');
    expect(mapIifItemType('COMPTAX')).toBe('sales_tax');
    expect(mapIifItemType('GRP')).toBe('bundle');
    expect(mapIifItemType('SUBT')).toBe('subtotal');
    expect(mapIifItemType(' othc ')).toBe('other_charge');
  });

  // -------------------------------------------------------------------------
  // L1 — full-path matching
  // -------------------------------------------------------------------------
  describe('L1 account paths', () => {
    let ctx: ServiceContext;
    beforeAll(async () => {
      ctx = await newCompany('L1 Paths Co');
      await importIIF(
        ctx,
        [
          t('!ACCNT', 'NAME', 'ACCNTTYPE', 'ACCNUM'),
          t('ACCNT', 'Entertainment', 'EXP', '6400'),
          t('ACCNT', 'Entertainment:Meals', 'EXP', '6410'),
          t('ACCNT', 'Ops Bank', 'BANK', '1010'),
        ].join('\r\n'),
      );
    }, 300_000);

    it('a "Travel:Meals" reference never posts to "Entertainment:Meals"', async () => {
      const meals = await ctx.db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '6410')));
      const before = Number(meals[0].balance);
      await importIIF(
        ctx,
        [
          t('!TRNS', 'TRNSID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO'),
          t('!SPL', 'SPLID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO'),
          t('!ENDTRNS'),
          t('TRNS', '', 'GENERAL JOURNAL', '3/1/2026', 'Travel:Meals', '', '42.00', 'T1', 'Trip lunch'),
          t('SPL', '', 'GENERAL JOURNAL', '3/1/2026', 'Ops Bank', '', '-42.00', 'T1', ''),
          t('ENDTRNS'),
        ].join('\r\n'),
      );
      const [after] = await ctx.db.select().from(accounts).where(eq(accounts.id, meals[0].id));
      expect(Number(after.balance), 'posted to a different parent\'s "Meals"').toBe(before);
      expect((await trialBalance(ctx)).balanced).toBe(true);
    });

    it('unbalanced / undated / one-sided IIF transactions are skipped and post nothing', async () => {
      const before = (await ctx.db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
      const counts = await importIIF(
        ctx,
        [
          t('!TRNS', 'TRNSID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO'),
          t('!SPL', 'SPLID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO'),
          t('!ENDTRNS'),
          t('TRNS', '', 'GENERAL JOURNAL', '3/2/2026', 'Entertainment:Meals', '', '10.00', 'U1', ''),
          t('SPL', '', 'GENERAL JOURNAL', '3/2/2026', 'Ops Bank', '', '-9.99', 'U1', ''),
          t('ENDTRNS'),
          t('TRNS', '', 'GENERAL JOURNAL', '13/45/2026', 'Entertainment:Meals', '', '10.00', 'U2', ''),
          t('SPL', '', 'GENERAL JOURNAL', '13/45/2026', 'Ops Bank', '', '-10.00', 'U2', ''),
          t('ENDTRNS'),
          t('TRNS', '', 'GENERAL JOURNAL', '3/2/2026', 'Entertainment:Meals', '', '10.00', 'U3', ''),
          t('ENDTRNS'),
          t('TRNS', '', 'GENERAL JOURNAL', '3/2/2026', 'Entertainment:Meals', '', 'ten', 'U4', ''),
          t('SPL', '', 'GENERAL JOURNAL', '3/2/2026', 'Ops Bank', '', '-10.00', 'U4', ''),
          t('ENDTRNS'),
        ].join('\r\n'),
      );
      expect(counts.transactions).toBe(0);
      expect(counts.skipped).toBeGreaterThanOrEqual(4);
      const after = (await ctx.db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
      expect(after).toBe(before);
    });
  });

  // -------------------------------------------------------------------------
  // L6 — open items after cutover
  // -------------------------------------------------------------------------
  describe('L6 open A/R + A/P with a prior GL import', () => {
    let ctx: ServiceContext;
    beforeAll(async () => {
      ctx = await newCompany('L6 Cutover Co');
      const ar = await acct(ctx, '1200');
      const ap = await acct(ctx, '2000');
      const eq3000 = await acct(ctx, '3000');
      await postJournalEntry(ctx, {
        date: new Date('2025-12-31T00:00:00Z'),
        description: 'GL import opening balances',
        sourceRef: 'qbgl:qa:2025-12-31',
        lines: [
          { accountId: ar.id, debit: '1500.00' },
          { accountId: eq3000.id, credit: '1000.00' },
          { accountId: ap.id, credit: '500.00' },
        ],
      });
      await importOpenItems(ctx, {
        side: 'ar',
        alreadyInGl: true,
        items: [
          { kind: 'invoice', name: 'Pay Co', date: '2025-11-30', number: 'INV-1', openBalance: '1000.00' },
          { kind: 'invoice', name: 'Pay Co:Job X', date: '2025-12-15', number: 'INV-2', openBalance: '500.00' },
        ],
      });
      await importOpenItems(ctx, {
        side: 'ap',
        alreadyInGl: true,
        items: [{ kind: 'bill', name: 'Paper Vendor', date: '2025-12-20', number: 'B-1', openBalance: '500.00' }],
      });
    }, 300_000);

    it('ties out right after conversion; the clearing account nets to zero', async () => {
      const rec = await expectSubledgersTie(ctx);
      expect(rec.ar.control).toBe('1500.00');
      expect(rec.ap.control).toBe('500.00');
      const clearing = await acct(ctx, QB_CONVERSION_CLEARING.code);
      expect(Number(clearing.balance)).toBe(0);
      const custs = await ctx.db.select().from(customers).where(eq(customers.companyId, ctx.companyId));
      const parent = custs.find((c) => c.displayName === 'Pay Co')!;
      expect(custs.find((c) => c.displayName === 'Pay Co:Job X')?.parentId).toBe(parent.id);
    });

    it('Receive Payments against a converted invoice keeps A/R control == aging', async () => {
      const [inv] = await ctx.db
        .select()
        .from(invoices)
        .where(and(eq(invoices.companyId, ctx.companyId), like(invoices.memo, '%#INV-1%')));
      expect(inv).toBeTruthy();
      await receivePayment(ctx, {
        customerId: inv.customerId,
        date: new Date('2026-01-10T00:00:00Z'),
        method: 'check',
        amount: '400.00',
        applications: [{ invoiceId: inv.id, amountApplied: '400.00' }],
      });
      const rec = await expectSubledgersTie(ctx);
      expect(rec.ar.control).toBe('1100.00');
    });

    it('Pay Bills against a converted bill keeps A/P control == aging', async () => {
      const [bill] = await ctx.db.select().from(bills).where(and(eq(bills.companyId, ctx.companyId), eq(bills.billNumber, 'B-1')));
      const checking = await acct(ctx, '1000');
      await payBills(ctx, {
        vendorId: bill.vendorId,
        date: new Date('2026-01-12T00:00:00Z'),
        method: 'check',
        paymentAccountId: checking.id,
        applications: [{ billId: bill.id, amountApplied: '500.00' }],
      });
      const rec = await expectSubledgersTie(ctx);
      expect(rec.ap.control).toBe('0.00');
    });

    it('re-importing a report whose open balance CHANGED is refused (would double count)', async () => {
      const before = (await ctx.db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId))).length;
      await expect(
        importOpenItems(ctx, {
          side: 'ar',
          alreadyInGl: true,
          items: [{ kind: 'invoice', name: 'Pay Co', date: '2025-11-30', number: 'INV-1', openBalance: '600.00' }],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      const after = (await ctx.db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId))).length;
      expect(after).toBe(before);
      await expectSubledgersTie(ctx);
    });
  });

  describe('L6 malformed input, closing date and missing names (fresh books)', () => {
    let ctx: ServiceContext;
    beforeAll(async () => {
      ctx = await newCompany('L6 Fresh Co');
    }, 300_000);

    it('rejects malformed typed-in balances and files without writing anything', async () => {
      const bad = [
        { kind: 'invoice' as const, name: 'A', date: '2026-01-01', openBalance: '-5' },
        { kind: 'invoice' as const, name: '', date: '2026-01-01', openBalance: '5' },
        { kind: 'invoice' as const, name: 'A', date: 'not a date', openBalance: '5' },
      ];
      for (const it of bad) {
        await expect(importOpenItems(ctx, { side: 'ar', alreadyInGl: false, items: [it] })).rejects.toMatchObject({ code: 'VALIDATION' });
      }
      await expect(
        importOpenItems(ctx, {
          side: 'ar',
          alreadyInGl: false,
          items: [
            { kind: 'invoice', name: 'A', date: '2026-01-01', openBalance: '5' },
            { kind: 'bill', name: 'V', date: '2026-01-01', openBalance: '5' },
          ],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(importOpenItems(ctx, { file: { name: 'x.csv', data: '' } })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(importOpenItems(ctx, { file: { name: 'x.csv', data: b64('hello,world\r\n1,2\r\n') } })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(importOpenItems(ctx, {})).rejects.toMatchObject({ code: 'VALIDATION' });
      const inv = await ctx.db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId));
      expect(inv).toHaveLength(0);
      const jes = await ctx.db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId));
      expect(jes).toHaveLength(0);
    });

    it('a ZERO open balance is refused as invalid input (Decimal(0).isPositive() is true)', async () => {
      // loadOpenItems validates with Money.of(x).isPositive(), which is true for 0 in decimal.js,
      // so a zero balance slips through to createInvoice and only fails later as a skipped row.
      await expect(
        importOpenItems(ctx, { side: 'ar', alreadyInGl: false, items: [{ kind: 'invoice', name: 'Zero Co', date: '2026-01-01', openBalance: '0' }] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      const custs = await ctx.db.select().from(customers).where(and(eq(customers.companyId, ctx.companyId), eq(customers.displayName, 'Zero Co')));
      expect(custs).toHaveLength(0); // no stray customer created for a refused row
    });

    it('items dated on/before the closing date are skipped atomically (no orphan documents)', async () => {
      await setClosingDate(ctx, { closingDate: '2025-12-31' });
      try {
        const r = await importOpenItems(ctx, {
          side: 'ar',
          alreadyInGl: false,
          items: [
            { kind: 'invoice', name: 'Closed Co', date: '2025-12-15', number: 'C-1', openBalance: '100.00' },
            { kind: 'invoice', name: 'Closed Co', date: '2026-01-15', number: 'C-2', openBalance: '50.00' },
          ],
        });
        expect(r.invoices).toBe(1);
        expect(r.skipped).toBe(1);
      } finally {
        await setClosingDate(ctx, { closingDate: null });
      }
      const inv = await ctx.db.select().from(invoices).where(eq(invoices.companyId, ctx.companyId));
      expect(inv.map((i) => i.memo?.includes('#C-2'))).toEqual([true]);
      const rec = await expectSubledgersTie(ctx);
      expect(rec.ar.control).toBe('50.00');
    });

    it('createMissingNames=false skips unknown customers and posts nothing for them', async () => {
      const jesBefore = (await ctx.db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
      const r = await importOpenItems(ctx, {
        side: 'ar',
        alreadyInGl: false,
        createMissingNames: false,
        items: [{ kind: 'invoice', name: 'Nobody Inc', date: '2026-02-01', openBalance: '75.00' }],
      });
      expect(r.invoices).toBe(0);
      expect(r.skipped).toBe(1);
      const custs = await ctx.db.select().from(customers).where(and(eq(customers.companyId, ctx.companyId), eq(customers.displayName, 'Nobody Inc')));
      expect(custs).toHaveLength(0);
      const jesAfter = (await ctx.db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))).length;
      expect(jesAfter).toBe(jesBefore);
      await expectSubledgersTie(ctx);
    });

    it('a QB report CSV with parenthesised negatives and thousands separators ties out', async () => {
      const csv = [
        '"Open Invoices"',
        '"As of January 31, 2026"',
        ',,Type,Date,Num,Terms,Due Date,Aging,Open Balance',
        'Paren Co,,,,,,,,',
        ',,Invoice,01/05/2026,P-1,Net 30,02/04/2026,,"12,345.67"',
        ',,Payment,01/20/2026,,,,,"(345.67)"',
        'Total Paren Co,,,,,,,,"12,000.00"',
        'TOTAL,,,,,,,,"12,000.00"',
      ].join('\r\n');
      const r = await importOpenItems(ctx, { file: { name: 'open.csv', data: b64(csv) }, alreadyInGl: false });
      expect(r.invoices).toBe(1);
      expect(r.credits).toBe(1);
      const rec = await expectSubledgersTie(ctx);
      expect(rec.ar.control).toBe('12050.00'); // 50 from the earlier test + 12,000
    });
  });

  describe('L6 IIF documents together with their payments', () => {
    it('a PAID invoice plus its PAYMENT in the same IIF leaves A/R control == aging', async () => {
      const ctx = await newCompany('L6 IIF Pay Co');
      const iif = [
        t('!TRNS', 'TRNSID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO', 'PAID'),
        t('!SPL', 'SPLID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO'),
        t('!ENDTRNS'),
        t('TRNS', '', 'INVOICE', '12/16/2025', 'Accounts Receivable', 'Zed Co', '90.00', '2002', '', 'Y'),
        t('SPL', '', 'INVOICE', '12/16/2025', 'Sales Income', '', '-90.00', '2002', ''),
        t('ENDTRNS'),
        t('TRNS', '', 'PAYMENT', '12/20/2025', 'Undeposited Funds', 'Zed Co', '90.00', '', 'Pays 2002', ''),
        t('SPL', '', 'PAYMENT', '12/20/2025', 'Accounts Receivable', 'Zed Co', '-90.00', '', ''),
        t('ENDTRNS'),
        t('TRNS', '', 'INVOICE', '12/18/2025', 'Accounts Receivable', 'Zed Co', '400.00', '2003', '', 'N'),
        t('SPL', '', 'INVOICE', '12/18/2025', 'Sales Income', '', '-400.00', '2003', ''),
        t('ENDTRNS'),
      ].join('\r\n');
      await importIIF(ctx, iif, { openItems: { asDocuments: true, alreadyInGl: false } });
      await expectSubledgersTie(ctx);
    });
  });

  // -------------------------------------------------------------------------
  // J2 — IIF export
  // -------------------------------------------------------------------------
  describe('J2 IIF export', () => {
    let a: ServiceContext;
    beforeAll(async () => {
      a = await newCompany('J2 Source Co');
    }, 300_000);

    it('never writes SSNs for a user without sensitive-payroll access', async () => {
      const e = await createEmployee(a, { firstName: 'Sec', lastName: 'Ret', payType: 'salary', payRate: '50000' });
      await updateEmployee(a, e.id, { ssn: '987-65-4321' });
      const restricted: ServiceContext = { ...a, access: { flags: {} } as never };
      const iif = await exportListsIif(restricted, ['employees']);
      expect(iif).not.toContain('987-65-4321');
      expect(iif).not.toContain('987654321');
      expect(iif).not.toMatch(/\*\*\*-\*\*-4321/);
      const full = await exportListsIif(a, ['employees']);
      expect(full).toContain('987-65-4321');
    });

    it('voided entries are not exported; a 3-level hierarchy with odd names round-trips with equal balances', async () => {
      const top = await createAccount(a, { code: '6800', name: 'Facilities, Rent & Co', type: 'expense', subtype: 'operating_expenses' });
      const mid = await createAccount(a, { code: '6810', name: 'Building "A"', type: 'expense', subtype: 'operating_expenses', parentId: top.id });
      const leaf = await createAccount(a, { code: '6811', name: 'Utilities', type: 'expense', subtype: 'operating_expenses', parentId: mid.id });
      const checking = await acct(a, '1000');
      await postJournalEntry(a, {
        date: new Date('2026-04-01T00:00:00Z'),
        description: 'Electric\tbill\r\nApril',
        lines: [
          { accountId: leaf.id, debit: '123.45' },
          { accountId: mid.id, debit: '10.00' },
          { accountId: checking.id, credit: '133.45' },
        ],
      });
      const voided = await postJournalEntry(a, {
        date: new Date('2026-04-02T00:00:00Z'),
        description: 'Mistake',
        lines: [
          { accountId: leaf.id, debit: '999.00' },
          { accountId: checking.id, credit: '999.00' },
        ],
      });
      await voidJournalEntry(a, voided.id);

      const range = { from: new Date('2026-01-01T00:00:00Z'), to: new Date('2026-12-31T23:59:59Z') };
      const journal = await exportJournalIif(a, range);
      expect(journal).not.toContain('999.00');
      expect(journal).toContain('Facilities, Rent & Co:Building "A":Utilities');
      // every row is a single line with the right number of cells
      for (const line of journal.split('\r\n').filter((l) => l.startsWith('TRNS') || l.startsWith('SPL'))) {
        expect(line.split('\t')).toHaveLength(10);
      }

      const b = await newCompany('J2 Target Co');
      const lists = await exportListsIif(a, ['accounts']);
      const lc = await importIIF(b, lists);
      expect(lc.issues.filter((i) => i.reason === 'validation')).toEqual([]);
      const jc = await importIIF(b, journal);
      expect(jc.skipped).toBe(0);
      expect(await accountBalances(b)).toEqual(await accountBalances(a));
      // Re-importing the same journal is a no-op.
      const again = await importIIF(b, journal);
      expect(again.transactions).toBe(0);
      expect(await accountBalances(b)).toEqual(await accountBalances(a));
      expect((await trialBalance(b)).balanced).toBe(true);
      const lines = await b.db
        .select({ id: journalEntryLines.id })
        .from(journalEntryLines)
        .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
        .where(eq(journalEntries.companyId, b.companyId));
      expect(lines.length).toBe(3);
    });
  });
});
