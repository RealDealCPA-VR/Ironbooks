/**
 * A2 (gapsb): Preferences > Multiple Currencies is a real switch.
 *  - off by default for new companies: foreign-currency saves are refused with a plain message,
 *    the Currencies page is hidden;
 *  - turning it on puts the home currency in the list; it can be turned off again while there is
 *    no foreign-currency data, but not once there is (QB lock);
 *  - companies that never chose (older files / fixtures) are on exactly when they already use
 *    foreign currencies, and migration 0056 makes that explicit for every existing company.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, companies, currencies, invoices, users } from '@/lib/db/schema';
import { multiCurrencyHiddenPaths } from '@/lib/preferences';
import type { ServiceContext } from './_base';
import { createCompany, getPreferences, NEW_COMPANY_SETTINGS, updateCompany } from './company';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { setAccountCurrency, setBaseCurrency, upsertCurrency } from './currencies';
import { currencyRate } from './exchangeRates';
import { getMultiCurrencyStatus, hasForeignCurrencyData } from './multiCurrency';
import { applySetupInterview, type SetupInterviewInput } from './setupInterview';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-gapsb-multicurrency');
const D = (s: string) => new Date(`${s}T12:00:00Z`);

let db: DB;
let ownerId: string;
let seq = 0;

async function company(settings?: Record<string, unknown>) {
  seq += 1;
  const co = await createCompany(db, { name: `MC ${seq}`, ownerId, ...(settings ? { settings } : {}) });
  const ctx: ServiceContext = { db, companyId: co.id, userId: ownerId };
  const code: Record<string, string> = {};
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, co.id))) code[a.code] = a.id;
  const customerId = (await createCustomer(ctx, { displayName: `MC Customer ${seq}` })).id;
  return { ctx, code, customerId };
}

function invoiceInput(customerId: string, incomeId: string, extra: Record<string, unknown> = {}) {
  return {
    customerId,
    date: D('2026-04-01'),
    dueDate: D('2026-04-30'),
    lines: [{ accountId: incomeId, description: 'Work', quantity: 1, rate: '100.00', taxable: false }],
    overrideCreditLimit: true,
    ...extra,
  } as Parameters<typeof createInvoice>[1];
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'mc@test.local', name: 'MC', passwordHash: 'x' }).returning();
  ownerId = u.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('A2: Multiple Currencies preference', () => {
  it('is off for a new company: Currencies hidden, foreign-currency saves refused, home saves fine', async () => {
    const { ctx, code, customerId } = await company({ ...NEW_COMPANY_SETTINGS });
    const prefs = await getPreferences(ctx);
    expect(prefs.multiCurrencyEnabled).toBe(false);
    expect(multiCurrencyHiddenPaths(prefs).has('/currencies')).toBe(true);

    const off = /Multiple currencies is turned off for this company, so EUR can't be used/;
    await expect(upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.1' })).rejects.toThrow(off);
    await expect(createInvoice(ctx, invoiceInput(customerId, code['4000'], { currency: 'EUR', exchangeRate: '1.1' }))).rejects.toThrow(off);
    await expect(
      receivePayment(ctx, { customerId, date: D('2026-04-02'), method: 'check', amount: '10.00', currency: 'EUR', exchangeRate: '1.1', applications: [] }),
    ).rejects.toThrow(off);
    await expect(setAccountCurrency(ctx, code['1000'], 'EUR')).rejects.toThrow(off);
    await expect(currencyRate(ctx, 'EUR', '1.1')).rejects.toThrow(off);
    // Nothing foreign was saved.
    expect(await hasForeignCurrencyData(db, ctx.companyId)).toBe(false);

    // Home currency (blank, or the home code in any case) is unaffected.
    const inv = await createInvoice(ctx, invoiceInput(customerId, code['4000'], { currency: 'usd' }));
    expect(inv.id).toBeTruthy();
    await createInvoice(ctx, invoiceInput(customerId, code['4000']));
  });

  it('turning it on adds the home currency; it can go off again until foreign data exists, then it is locked on', async () => {
    const { ctx, code, customerId } = await company({ ...NEW_COMPANY_SETTINGS });
    await updateCompany(ctx, { settings: { multiCurrencyEnabled: true } });
    expect((await getPreferences(ctx)).multiCurrencyEnabled).toBe(true);
    const [base] = await db.select().from(currencies).where(eq(currencies.companyId, ctx.companyId));
    expect(base).toMatchObject({ code: 'USD', isBase: true });

    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.1' });
    expect(await getMultiCurrencyStatus(ctx)).toEqual({ enabled: true, hasForeignData: false, locked: false });

    // No foreign transactions yet: it may be turned off again (a currency in the list is not data).
    await updateCompany(ctx, { settings: { multiCurrencyEnabled: false } });
    expect((await getPreferences(ctx)).multiCurrencyEnabled).toBe(false);
    await expect(createInvoice(ctx, invoiceInput(customerId, code['4000'], { currency: 'EUR', exchangeRate: '1.1' }))).rejects.toThrow(
      /turned off/,
    );

    await updateCompany(ctx, { settings: { multiCurrencyEnabled: true } });
    await createInvoice(ctx, invoiceInput(customerId, code['4000'], { currency: 'EUR', exchangeRate: '1.1' }));
    expect(await getMultiCurrencyStatus(ctx)).toEqual({ enabled: true, hasForeignData: true, locked: true });

    const err = await updateCompany(ctx, { settings: { multiCurrencyEnabled: false } }).catch((e) => e);
    expect(err).toMatchObject({ code: 'CONFLICT', details: { multiCurrencyLocked: true } });
    expect(err.message).toMatch(/can no longer be turned off/);
    expect((await getPreferences(ctx)).multiCurrencyEnabled).toBe(true);
    // Saving other preferences together with "on" still works.
    await updateCompany(ctx, { settings: { multiCurrencyEnabled: true, defaultInvoiceMemo: 'Thanks!' } });
  });

  it('the setup interview turns it on, and a later "No" cannot undo it once foreign data exists', async () => {
    const { ctx, code, customerId } = await company({ ...NEW_COMPANY_SETTINGS });
    const answers: SetupInterviewInput = {
      businessType: 'general',
      entityType: 'llc_single',
      fiscalYearStartMonth: 1,
      taxYearStartMonth: 1,
      startDate: '2026-01-01',
      reportBasis: 'accrual',
      salesTax: false,
      inventory: false,
      employees: false,
      multiCurrency: true,
      currency: 'USD',
    } as SetupInterviewInput;
    await applySetupInterview(ctx, answers);
    expect((await getPreferences(ctx)).multiCurrencyEnabled).toBe(true);
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.1' });
    await createInvoice(ctx, invoiceInput(customerId, code['4000'], { currency: 'EUR', exchangeRate: '1.1' }));
    const again = await applySetupInterview(ctx, { ...answers, multiCurrency: false } as SetupInterviewInput);
    expect(again.plan.summary).toContain('More than one currency: yes (kept on: this company already has foreign-currency records)');
    expect((await getPreferences(ctx)).multiCurrencyEnabled).toBe(true);
  });

  it('a company that never chose is on exactly when it already uses foreign currencies', async () => {
    const legacyHome = await company();
    expect((await getPreferences(legacyHome.ctx)).multiCurrencyEnabled).toBe(false);

    const legacyFx = await company();
    await setBaseCurrency(legacyFx.ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(legacyFx.ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.2' }); // never refused
    await createInvoice(legacyFx.ctx, invoiceInput(legacyFx.customerId, legacyFx.code['4000'], { currency: 'EUR', exchangeRate: '1.2' }));
    expect((await getPreferences(legacyFx.ctx)).multiCurrencyEnabled).toBe(true);
    expect((await getMultiCurrencyStatus(legacyFx.ctx)).locked).toBe(true);
  });

  it('migration 0056 stores the explicit value for existing companies (on with foreign data, off without)', async () => {
    const withFx = await company();
    await setBaseCurrency(withFx.ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(withFx.ctx, { code: 'CAD', name: 'Canadian Dollar', rateToBase: '0.75' });
    await db.insert(invoices).values({
      companyId: withFx.ctx.companyId,
      customerId: withFx.customerId,
      invoiceNumber: 1,
      date: D('2026-01-01'),
      status: 'draft',
      total: '1.00',
      balanceDue: '1.00',
      currency: 'CAD',
      exchangeRate: '0.75',
    });
    await db.delete(currencies).where(sql`${currencies.companyId} = ${withFx.ctx.companyId} AND ${currencies.isBase} = false`);
    const plain = await company();
    const chosen = await company({ multiCurrencyEnabled: true });

    const file = fs.readFileSync(path.resolve('drizzle/0056_gapsb.sql'), 'utf8');
    const backfill = file.split('--> statement-breakpoint').map((s) => s.trim()).find((s) => s.startsWith('UPDATE "companies"'))!;
    expect(backfill).toBeTruthy();
    await db.execute(sql.raw(backfill));

    const settingsOf = async (id: string) =>
      ((await db.select({ s: companies.settings }).from(companies).where(eq(companies.id, id)))[0].s ?? {}) as Record<string, unknown>;
    expect((await settingsOf(withFx.ctx.companyId)).multiCurrencyEnabled).toBe(true);
    expect((await settingsOf(plain.ctx.companyId)).multiCurrencyEnabled).toBe(false);
    expect((await settingsOf(chosen.ctx.companyId)).multiCurrencyEnabled).toBe(true);

    const journal = JSON.parse(fs.readFileSync(path.resolve('drizzle/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    expect(journal.entries.filter((e) => e.tag === '0056_gapsb')).toEqual([
      { idx: 56, version: '7', when: 1781400056000, tag: '0056_gapsb', breakpoints: true },
    ]);
  });
});
