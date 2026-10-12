/**
 * Wave-2 GL foundation — fix round 6: Retainage Receivable is an Other Current Asset (I11).
 *
 * The amount held back on a retainage invoice is not owed by the customer yet, so A/R aging
 * leaves it out. It therefore must not sit in an A/R account either: 1250 Retainage Receivable
 * is an Other Current Asset (QB contractor setup), its invoice line is no longer a control line,
 * and billing the retainage later (an invoice line on 1250) moves it into A/R.
 *
 * Hermetic: one throwaway PGlite data dir, removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { arAging } from './reportsExtra';
import { trialBalance } from './reports';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { balanceSheetCashBasis } from './balanceSheetCashBasis';
import { profitAndLossCashBasis } from './cashBasisReports';
import { verifyIntegrity } from './integrity';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-wave2-foundation-fix6');

let db: DB;
let ctx: ServiceContext;
const code: Record<string, string> = {};
const D = new Date(2026, 11, 31);
const DAY = new Date(2026, 6, 15);

async function acct(c: string) {
  const [row] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, c)));
  return row;
}
async function arControl(asOf = D) {
  const tb = await trialBalance(ctx, asOf);
  const ids = new Set(
    (
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.subtype, 'accounts_receivable')))
    ).map((r) => r.id),
  );
  let total = Money.zero();
  for (const r of tb.rows) if (ids.has(r.accountId)) total = total.plus(Money.of(r.debit)).minus(Money.of(r.credit));
  return total;
}
async function arGap() {
  return Number((await arControl()).minus(Money.of((await arAging(ctx, D)).totals.total)).toFixed(2));
}
async function arRow(customerId: string) {
  return Number((await arAging(ctx, D)).rows.find((r) => r.id === customerId)?.total ?? 0);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'wave2-foundation-fix6@test.local', name: 'QA', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'Foundation Fix6 Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  for (const c of ['1000', '1200', '1250', '4000']) code[c] = (await acct(c))!.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Retainage Receivable is an Other Current Asset (I11)', () => {
  it('the default chart seeds 1250 Retainage Receivable as an Other Current Asset', async () => {
    const ret = await acct('1250');
    expect(ret.type).toBe('asset');
    expect(ret.subtype).toBe('other_current_asset');
  });

  it('a retainage invoice keeps A/R aging == the A/R accounts; billing the retainage later moves it into A/R', async () => {
    const c = (await createCustomer(ctx, { displayName: 'Fix6 Contractor' })).id;
    const g0 = await arGap();
    const inv = await createInvoice(ctx, {
      customerId: c,
      date: DAY,
      lines: [{ accountId: code['4000'], quantity: 1, rate: '1000.00', taxable: false }],
      retainagePercent: 10,
    });
    expect(inv.balanceDue).toBe('900.00');
    expect(await arGap()).toBe(g0);
    expect(await arRow(c)).toBe(900);
    expect((await acct('1250')).balance).toBe('100.00');

    // Customer pays the billed portion.
    await receivePayment(ctx, {
      customerId: c,
      date: DAY,
      amount: '900.00',
      method: 'check',
      depositAccountId: code['1000'],
      applications: [{ invoiceId: inv.id, amountApplied: '900.00' }],
    });
    expect(await arGap()).toBe(g0);
    expect(await arRow(c)).toBe(0);

    // Bill the retainage at job end: an invoice line on Retainage Receivable moves it into A/R.
    const rel = await createInvoice(ctx, {
      customerId: c,
      date: DAY,
      lines: [{ accountId: code['1250'], description: 'Retainage billed', quantity: 1, rate: '100.00', taxable: false }],
    });
    expect(rel.balanceDue).toBe('100.00');
    expect((await acct('1250')).balance).toBe('0.00');
    expect(await arRow(c)).toBe(100);
    expect(await arGap()).toBe(g0);

    const integrity = await verifyIntegrity(ctx);
    expect(integrity.checks.filter((k) => !k.ok)).toEqual([]);
  });

  it('cash basis still treats unpaid retainage as not-yet-received revenue, and both cash reports agree', async () => {
    const c = (await createCustomer(ctx, { displayName: 'Fix6 Cash Basis' })).id;
    await createInvoice(ctx, {
      customerId: c,
      date: DAY,
      lines: [{ accountId: code['4000'], quantity: 1, rate: '500.00', taxable: false }],
      retainagePercent: 20,
    });
    const bs = await balanceSheetCashBasis(ctx);
    expect(bs.balanced).toBe(true);
    expect(bs.adjustments.removedArLines.map((l) => l.code)).toContain('1250');
    const pl = await profitAndLossCashBasis(ctx);
    expect(Money.of(bs.retainedEarnings).toFixed(2)).toBe(Money.of(pl.netIncome).toFixed(2));
  });

  it('an older company whose 1250 is still an A/R account: the invoice is refused plainly; the 0025 fix-up retypes it', async () => {
    await db.execute(
      sql`UPDATE accounts SET subtype = 'accounts_receivable' WHERE company_id = ${ctx.companyId} AND code = '1250'`,
    );
    const c = (await createCustomer(ctx, { displayName: 'Fix6 Legacy' })).id;
    const before = (await acct('1250')).balance;
    await expect(
      createInvoice(ctx, {
        customerId: c,
        date: DAY,
        lines: [{ accountId: code['4000'], quantity: 1, rate: '300.00', taxable: false }],
        retainagePercent: 10,
      }),
    ).rejects.toThrow(/Other Current Asset/);
    expect((await acct('1250')).balance).toBe(before);
    expect(await arRow(c)).toBe(0);

    // Apply the retainage fix-up statement from the 0025 migration.
    const migration = fs.readFileSync(path.resolve(process.cwd(), 'drizzle', '0025_wave2_foundation.sql'), 'utf8');
    const stmt = migration
      .split('--> statement-breakpoint')
      .find((s) => /SET "subtype" = 'other_current_asset'\s+WHERE "code" = '1250'/.test(s));
    expect(stmt).toBeTruthy();
    await db.execute(sql.raw(stmt!));
    expect((await acct('1250')).subtype).toBe('other_current_asset');

    const g0 = await arGap();
    await createInvoice(ctx, {
      customerId: c,
      date: DAY,
      lines: [{ accountId: code['4000'], quantity: 1, rate: '300.00', taxable: false }],
      retainagePercent: 10,
    });
    expect(await arRow(c)).toBe(270);
    expect(await arGap()).toBe(g0);
  });
});
