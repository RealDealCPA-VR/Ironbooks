/**
 * Feature round (accountant) — J11: the Closing Date Exception report shows each changed
 * transaction once with its LATEST values and the PRIOR values it had before each change made with
 * the closing date password (document edits, General Journal edits, reclassify, voids).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany, setClosingDate } from '../company';
import { createVendor } from '../vendors';
import { createExpense, updateExpense, voidExpense } from '../expenses';
import { createManualEntry, updateEntry } from '../journal';
import { listReclassifyLines, reclassifyLines } from './reclassify';
import { closingDateExceptionReport } from './auditReports';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-feature-closing-exceptions');
let db: DB;
let ctx: ServiceContext;
let over: ServiceContext;
const acct: Record<string, string> = {};
let vendorId: string;
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

describe('J11 Closing Date Exception report: prior vs latest values', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'cde@test.local', name: 'Closer', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Closing Exceptions Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    over = { ...ctx, closingDateOverride: true };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
    vendorId = (await createVendor(ctx, { displayName: 'Paper Co' })).id;
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('a check edited in the closed period shows its latest and prior amounts in one group', async () => {
    const exp = await createExpense(ctx, {
      vendorId,
      date: d('2026-01-10'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6000'], amount: '100.00', description: 'Paper' }],
    });
    await setClosingDate(ctx, { closingDate: '2026-01-31', password: 'pw' });
    await updateExpense(over, exp.id, {
      vendorId,
      date: d('2026-01-10'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6000'], amount: '125.00', description: 'Paper' }],
    });
    const rep = await closingDateExceptionReport(ctx);
    const g = rep.groups.find((x) => x.typeLabel === 'Check / Expense');
    expect(g).toBeDefined();
    expect(g!.latest?.amount).toBe('125.00');
    expect(g!.prior).toHaveLength(1);
    expect(g!.prior[0].amount).toBe('100.00');
    expect(g!.prior[0].lines.find((l) => l.debit)?.account).toMatch(/^6000 · /);
    expect(g!.changes.map((c) => c.operation).sort()).toEqual(['post', 'void']);
  });

  it('a General Journal edit links the replaced entry to its replacement', async () => {
    await setClosingDate(ctx, { closingDate: null });
    const je = await createManualEntry(ctx, {
      date: d('2026-01-12'),
      description: 'Accrual',
      lines: [
        { accountId: acct['6300'], debit: '40.00' },
        { accountId: acct['1000'], credit: '40.00' },
      ],
    });
    await setClosingDate(ctx, { closingDate: '2026-01-31', password: 'pw' });
    await updateEntry(over, je.id, {
      date: d('2026-01-12'),
      description: 'Accrual (corrected)',
      lines: [
        { accountId: acct['6300'], debit: '45.00' },
        { accountId: acct['1000'], credit: '45.00' },
      ],
    });
    const rep = await closingDateExceptionReport(ctx);
    const g = rep.groups.find((x) => x.prior.some((p) => p.entryId === je.id));
    expect(g).toBeDefined();
    expect(g!.typeLabel).toBe('General Journal');
    expect(g!.prior[0].amount).toBe('40.00');
    expect(g!.prior[0].description).toBe('Accrual');
    expect(g!.latest?.amount).toBe('45.00');
    expect(g!.latest?.description).toBe('Accrual (corrected)');
  });

  it('a reclassify shows the account before the change as the prior value', async () => {
    await setClosingDate(ctx, { closingDate: null });
    const je = await createManualEntry(ctx, {
      date: d('2026-01-14'),
      description: 'Rent miscoded',
      lines: [
        { accountId: acct['6600'], debit: '900.00' },
        { accountId: acct['1000'], credit: '900.00' },
      ],
    });
    await setClosingDate(ctx, { closingDate: '2026-01-31', password: 'pw' });
    const { lines } = await listReclassifyLines(ctx, { accountId: acct['6600'] });
    await reclassifyLines(over, { lineIds: [lines.find((l) => l.entryId === je.id)!.lineId], newAccountId: acct['6400'] });
    const rep = await closingDateExceptionReport(ctx);
    const g = rep.groups.find((x) => x.latest?.entryId === je.id);
    expect(g).toBeDefined();
    expect(g!.latest!.lines.find((l) => l.debit)?.account).toMatch(/^6400 · /);
    expect(g!.prior).toHaveLength(1);
    expect(g!.prior[0].lines.find((l) => l.debit)?.account).toMatch(/^6600 · /);
  });

  it('a voided transaction has no latest version, only its prior values', async () => {
    await setClosingDate(ctx, { closingDate: null });
    const exp = await createExpense(ctx, {
      vendorId,
      date: d('2026-01-20'),
      method: 'check',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6000'], amount: '33.00', description: 'Toner' }],
    });
    await setClosingDate(ctx, { closingDate: '2026-01-31', password: 'pw' });
    await voidExpense(over, exp.id);
    const rep = await closingDateExceptionReport(ctx);
    const g = rep.groups.find((x) => x.prior.some((p) => p.amount === '33.00'));
    expect(g).toBeDefined();
    expect(g!.latest).toBeNull();
    expect(g!.changes[0].operation).toBe('void');
    // The flat rows the export and older callers read are still there.
    expect(rep.rows.length).toBeGreaterThanOrEqual(rep.groups.length);
  });
});
