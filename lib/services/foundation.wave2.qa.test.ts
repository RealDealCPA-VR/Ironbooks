/**
 * Wave-2 GL foundation — independent QA (tester). Adversarial tests on top of
 * foundation.wave2.test.ts:
 *  - B1 account types: subledger safety when an account's QB type changes with history,
 *    non-posting accounts never on TB / BS / P&L, malformed input.
 *  - I11 names on JE lines: tenancy, wrong-kind names, rollback, A/R + A/P subledger == control,
 *    statements == aging == customer balance, void removes the open item, closing date.
 *  - I9 adjusting flag: edit keeps / clears the flag, void handling, date bounds, tenancy.
 *  - B2 tax lines: malformed keys / forms, clearing, non-posting excluded.
 *  - A3 document numbers: increment edge cases, case-insensitive duplicates, tenancy,
 *    trigger back-fill on UPDATE, starting-number conflicts.
 *  - Permissions: new routes / pages mapped with the right (area, action).
 *  - Migration 0025 is idempotent (re-running it is harmless).
 *
 * Hermetic: one throwaway PGlite data dir, removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, auditLogs, invoices, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import { incrementAlnum as incrementAlnumPure } from './docNumbers';
import type { ServiceContext } from './_base';
import { createCompany, setClosingDate } from './company';
import { createAccount, getTaxLineMapping, setIncomeTaxForm, updateAccount } from './accounts';
import { createCustomer, customerBalanceSummary } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { postJournalEntry } from './posting';
import {
  createManualEntry,
  getAdjustingEntries,
  getEntry,
  journalOpenItems,
  updateEntry,
  voidEntry,
} from './journal';
import { apAging, arAging } from './reportsExtra';
import { customerStatement } from './statements';
import { balanceSheet, profitAndLoss, trialBalance } from './reports';
import { verifyIntegrity } from './integrity';
import {
  allocateDocNumber,
  docNumberToInt,
  nextDocNumber,
  normalizeDocNumber,
  setStartingDocNumber,
} from './docNumbers';
import { apiRuleFor, pageAreasFor } from '@/lib/permissions/routes';
import { createJournalEntrySchema } from '@/lib/validation/journal';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-wave2-foundation-qa');

let db: DB;
let ctx: ServiceContext;
let ctx2: ServiceContext;
const code: Record<string, string> = {};
let customerId: string;
let customer2Id: string;
let vendorId: string;
let otherCoCustomerId: string;

async function idByCode(c: string, context: ServiceContext = ctx) {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, context.companyId), eq(accounts.code, c)));
  return row.id;
}

/** Sum of natural balances of all accounts with the given (type, subtype), from posted GL. */
async function controlBalance(type: 'asset' | 'liability', subtype: string, asOf?: Date): Promise<number> {
  const tb = await trialBalance(ctx, asOf);
  const ids = new Set(
    (
      await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.type, type), sql`${accounts.subtype} = ${subtype}`))
    ).map((r) => r.id),
  );
  let total = 0;
  for (const r of tb.rows) {
    if (!ids.has(r.accountId)) continue;
    const net = Number(r.debit) - Number(r.credit);
    total += type === 'asset' ? net : -net;
  }
  return Math.round(total * 100) / 100;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db
    .insert(users)
    .values({ email: 'wave2-foundation-qa@test.local', name: 'QA', passwordHash: 'x' })
    .returning();
  const company = await createCompany(db, { name: 'Foundation QA Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const [user2] = await db
    .insert(users)
    .values({ email: 'wave2-foundation-qa2@test.local', name: 'QA2', passwordHash: 'x' })
    .returning();
  const company2 = await createCompany(db, { name: 'Other Co', ownerId: user2.id });
  ctx2 = { db, companyId: company2.id, userId: user2.id };
  for (const c of ['1000', '1050', '1200', '2000', '2100', '2200', '3000', '4000', '6000', '6200']) {
    code[c] = await idByCode(c);
  }
  customerId = (await createCustomer(ctx, { displayName: 'QA Customer One' })).id;
  customer2Id = (await createCustomer(ctx, { displayName: 'QA Customer Two' })).id;
  vendorId = (await createVendor(ctx, { displayName: 'QA Vendor' })).id;
  otherCoCustomerId = (await createCustomer(ctx2, { displayName: 'Foreign Customer' })).id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Permissions (no DB)
// ---------------------------------------------------------------------------

describe('QA: permission mapping of new routes and pages', () => {
  it('maps the adjusting-entries route as its own static route (not /[id])', () => {
    expect(apiRuleFor('/api/journal-entries/adjusting', 'GET')).toEqual({ area: 'accounting', action: 'view' });
    // The [id] route allows PATCH/DELETE; the static report route must not inherit them.
    expect(apiRuleFor('/api/journal-entries/adjusting', 'PATCH')).toBeNull();
    expect(apiRuleFor('/api/journal-entries/adjusting', 'DELETE')).toBeNull();
  });

  it('maps doc-numbers and tax-lines with modify rights for writes', () => {
    expect(apiRuleFor('/api/doc-numbers', 'GET')).toBe('member');
    expect(apiRuleFor('/api/doc-numbers', 'PUT')).toEqual({ area: 'company', action: 'modify' });
    expect(apiRuleFor('/api/doc-numbers', 'POST')).toBeNull();
    expect(apiRuleFor('/api/accounts/tax-lines', 'GET')).toEqual({ area: 'lists', action: 'view' });
    expect(apiRuleFor('/api/accounts/tax-lines', 'PUT')).toEqual({ area: 'accounting', action: 'modify' });
    // Must not fall through to /api/accounts/[id] (which allows PATCH / DELETE).
    expect(apiRuleFor('/api/accounts/tax-lines', 'DELETE')).toBeNull();
    expect(apiRuleFor('/api/accounts/tax-lines', 'PATCH')).toBeNull();
    expect(pageAreasFor('/doc-numbers')).toEqual(['company']);
  });

  it('zod rejects malformed JE names and non-boolean adjusting flags', () => {
    const base = {
      date: '2026-03-01',
      description: 'x',
      lines: [
        { accountId: '00000000-0000-4000-8000-000000000001', debit: '1.00' },
        { accountId: '00000000-0000-4000-8000-000000000002', credit: '1.00' },
      ],
    };
    expect(createJournalEntrySchema.safeParse(base).success).toBe(true);
    const badKind = structuredClone(base) as Record<string, any>;
    badKind.lines[0].entityType = 'supplier';
    badKind.lines[0].entityId = '00000000-0000-4000-8000-000000000003';
    expect(createJournalEntrySchema.safeParse(badKind).success).toBe(false);
    const badId = structuredClone(base) as Record<string, any>;
    badId.lines[0].entityType = 'customer';
    badId.lines[0].entityId = 'not-a-uuid';
    expect(createJournalEntrySchema.safeParse(badId).success).toBe(false);
    expect(createJournalEntrySchema.safeParse({ ...base, isAdjusting: 'yes' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// I11 — names on journal lines
// ---------------------------------------------------------------------------

describe('QA: names on journal entry lines', () => {
  const arLines = (entityType: any, entityId: any, amount = '10.00') => [
    { accountId: code['1200'], debit: amount, entityType, entityId },
    { accountId: code['4000'], credit: amount },
  ];

  it('refuses names from another company, of the wrong kind, half-filled or malformed', async () => {
    const d = new Date(2026, 1, 10);
    await expect(
      createManualEntry(ctx, { date: d, description: 'foreign customer', lines: arLines('customer', otherCoCustomerId) }),
    ).rejects.toThrow(/not found/);
    // A vendor's id passed off as a customer.
    await expect(
      createManualEntry(ctx, { date: d, description: 'vendor id as customer', lines: arLines('customer', vendorId) }),
    ).rejects.toThrow(/not found/);
    await expect(
      createManualEntry(ctx, { date: d, description: 'kind without id', lines: arLines('customer', null) }),
    ).rejects.toThrow();
    await expect(
      createManualEntry(ctx, { date: d, description: 'id without kind', lines: arLines(null, customerId) }),
    ).rejects.toThrow();
    await expect(
      createManualEntry(ctx, { date: d, description: 'bad uuid', lines: arLines('customer', 'abc') }),
    ).rejects.toThrow();
    await expect(
      createManualEntry(ctx, { date: d, description: 'bad kind', lines: arLines('martian', customerId) }),
    ).rejects.toThrow();
    // Names on non-A/R/A/P lines are validated too.
    await expect(
      createManualEntry(ctx, {
        date: d,
        description: 'foreign name on expense line',
        lines: [
          { accountId: code['6000'], debit: '5.00', entityType: 'customer', entityId: otherCoCustomerId },
          { accountId: code['1000'], credit: '5.00' },
        ],
      }),
    ).rejects.toThrow(/not found/);
  });

  it('a refused entry leaves no journal entry and no balance change (rollback)', async () => {
    const countBefore = (
      await db.select({ n: sql<number>`count(*)::int` }).from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))
    )[0].n;
    const [arBefore] = await db.select({ b: accounts.balance }).from(accounts).where(eq(accounts.id, code['1200']));
    // Second A/R line lacks a name: the whole entry must be refused.
    await expect(
      createManualEntry(ctx, {
        date: new Date(2026, 1, 11),
        description: 'half named',
        lines: [
          { accountId: code['1200'], debit: '40.00', entityType: 'customer', entityId: customerId },
          { accountId: code['1200'], debit: '60.00' },
          { accountId: code['4000'], credit: '100.00' },
        ],
      }),
    ).rejects.toThrow(/needs a customer/);
    const countAfter = (
      await db.select({ n: sql<number>`count(*)::int` }).from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId))
    )[0].n;
    const [arAfter] = await db.select({ b: accounts.balance }).from(accounts).where(eq(accounts.id, code['1200']));
    expect(countAfter).toBe(countBefore);
    expect(arAfter.b).toBe(arBefore.b);
  });

  it('A/R and A/P subledgers equal their control accounts with invoices + named GJ lines', async () => {
    await createInvoice(ctx, { customerId, date: new Date(2026, 1, 1), lines: [{ quantity: 2, rate: '100.00' }] });
    await createManualEntry(ctx, {
      date: new Date(2026, 1, 3),
      description: 'Setup fees billed by journal',
      lines: [
        { accountId: code['1200'], debit: '123.45', entityType: 'customer', entityId: customerId },
        { accountId: code['1200'], debit: '0.01', entityType: 'customer', entityId: customer2Id },
        { accountId: code['4000'], credit: '123.46' },
      ],
    });
    // A credit to A/R for customer 2 (write-off style) larger than their charges.
    await createManualEntry(ctx, {
      date: new Date(2026, 1, 4),
      description: 'Goodwill credit',
      lines: [
        { accountId: code['6000'], debit: '20.00' },
        { accountId: code['1200'], credit: '20.00', entityType: 'customer', entityId: customer2Id },
      ],
    });
    await createManualEntry(ctx, {
      date: new Date(2026, 1, 5),
      description: 'Accrued vendor charge',
      lines: [
        { accountId: code['6200'], debit: '33.33', entityType: 'vendor', entityId: vendorId },
        { accountId: code['2000'], credit: '33.33', entityType: 'vendor', entityId: vendorId },
      ],
    });
    const asOf = new Date(2026, 2, 31);
    const ar = await arAging(ctx, asOf);
    expect(Number(ar.totals.total)).toBeCloseTo(await controlBalance('asset', 'accounts_receivable', asOf), 2);
    const ap = await apAging(ctx, asOf);
    expect(Number(ap.totals.total)).toBeCloseTo(await controlBalance('liability', 'accounts_payable', asOf), 2);

    // Customer 2 is in credit: -19.99 on aging, balance summary and statement alike.
    const c2 = ar.rows.find((r) => r.id === customer2Id)!;
    expect(c2.total).toBe('-19.99');
    const summary = await customerBalanceSummary(ctx);
    expect(summary.find((r) => r.customerId === customer2Id)?.totalBalanceDue).toBe('-19.99');
    const stmt2 = await customerStatement(ctx, customer2Id);
    expect(stmt2.closingBalance).toBe('-19.99');

    // Customer 1: invoice 200 + GJ 123.45, across every view.
    const c1 = ar.rows.find((r) => r.id === customerId)!;
    expect(c1.total).toBe('323.45');
    expect(summary.find((r) => r.customerId === customerId)?.totalBalanceDue).toBe('323.45');
    // Statement with a range starting AFTER the GJ entry: GJ goes into the opening balance.
    const stmt1 = await customerStatement(ctx, customerId, { from: new Date(2026, 1, 4), to: asOf });
    expect(stmt1.closingBalance).toBe('323.45');
    expect(stmt1.lines.some((l) => l.type === 'general_journal')).toBe(false);

    const integrity = await verifyIntegrity(ctx);
    expect(integrity.checks.filter((c) => !c.ok)).toEqual([]);
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
    await balanceSheet(ctx); // throws if unbalanced
  });

  it('voiding a named GJ entry removes its open item; subledger still equals control', async () => {
    const e = await createManualEntry(ctx, {
      date: new Date(2026, 1, 6),
      description: 'to be voided',
      lines: arLines('customer', customerId, '77.00'),
    });
    expect((await journalOpenItems(ctx, 'ar', { entityId: customerId })).some((i) => i.journalEntryId === e.id)).toBe(true);
    await voidEntry(ctx, e.id);
    expect((await journalOpenItems(ctx, 'ar', { entityId: customerId })).some((i) => i.journalEntryId === e.id)).toBe(false);
    const asOf = new Date(2026, 2, 31);
    const ar = await arAging(ctx, asOf);
    expect(Number(ar.totals.total)).toBeCloseTo(await controlBalance('asset', 'accounts_receivable', asOf), 2);
  });

  it('editing a named entry to drop the customer is refused and the original stays posted', async () => {
    const e = await createManualEntry(ctx, {
      date: new Date(2026, 1, 7),
      description: 'edit me',
      lines: arLines('customer', customerId, '15.00'),
    });
    await expect(
      updateEntry(ctx, e.id, {
        date: new Date(2026, 1, 7),
        description: 'edit me',
        lines: [
          { accountId: code['1200'], debit: '15.00' },
          { accountId: code['4000'], credit: '15.00' },
        ],
      }),
    ).rejects.toThrow(/needs a customer/);
    const after = await getEntry(ctx, e.id);
    expect(after.status).toBe('posted');
    expect(after.lines.find((l) => l.accountId === code['1200'])?.entityId).toBe(customerId);
  });
});

// ---------------------------------------------------------------------------
// I9 — adjusting entries
// ---------------------------------------------------------------------------

describe('QA: adjusting entries', () => {
  it('edit keeps the flag when omitted and clears it when false; voids and other companies excluded', async () => {
    const lines = [
      { accountId: code['6200'], debit: '12.34' },
      { accountId: code['1000'], credit: '12.34' },
    ];
    const a = await createManualEntry(ctx, { date: new Date(2026, 5, 30), description: 'AJE 1', lines, isAdjusting: true });
    const edited = await updateEntry(ctx, a.id, { date: new Date(2026, 5, 30), description: 'AJE 1 edited', lines });
    expect((await getEntry(ctx, edited.id)).isAdjusting).toBe(true);

    const b = await createManualEntry(ctx, { date: new Date(2026, 5, 15), description: 'AJE 2', lines, isAdjusting: true });
    const cleared = await updateEntry(ctx, b.id, { date: new Date(2026, 5, 15), description: 'not adjusting', lines, isAdjusting: false });
    expect((await getEntry(ctx, cleared.id)).isAdjusting).toBe(false);

    // Other company's adjusting entry never leaks.
    const c1000 = await idByCode('1000', ctx2);
    const c6200 = await idByCode('6200', ctx2);
    await createManualEntry(ctx2, {
      date: new Date(2026, 5, 30),
      description: 'Other co AJE',
      isAdjusting: true,
      lines: [
        { accountId: c6200, debit: '1.00' },
        { accountId: c1000, credit: '1.00' },
      ],
    });

    const rep = await getAdjustingEntries(ctx, { from: new Date(2026, 5, 1), to: new Date(2026, 5, 30) });
    const ids = rep.entries.map((e) => e.id);
    expect(ids).toContain(edited.id);
    expect(ids).not.toContain(a.id); // the voided original of the edit
    expect(ids).not.toContain(cleared.id);
    expect(rep.entries.every((e) => e.description !== 'Other co AJE')).toBe(true);
    expect(rep.totalDebit).toBe(rep.totalCredit);

    const withVoid = await getAdjustingEntries(ctx, { from: new Date(2026, 5, 1), to: new Date(2026, 5, 30), includeVoid: true });
    expect(withVoid.entries.map((e) => e.id)).toContain(a.id);
    // Void entries are listed but do not count toward the totals.
    expect(withVoid.totalDebit).toBe(rep.totalDebit);

    // Date bounds: an entry dated exactly on `from` is included, one day before is not.
    const outside = await getAdjustingEntries(ctx, { from: new Date(2026, 6, 1) });
    expect(outside.entries.map((e) => e.id)).not.toContain(edited.id);
  });

  it('respects the closing date for adjusting entries and their edits', async () => {
    const lines = [
      { accountId: code['6200'], debit: '9.00' },
      { accountId: code['1000'], credit: '9.00' },
    ];
    const old = await createManualEntry(ctx, { date: new Date(2025, 11, 15), description: 'pre-close AJE', lines, isAdjusting: true });
    await setClosingDate(ctx, { closingDate: '2025-12-31', password: null });
    try {
      await expect(
        createManualEntry(ctx, { date: new Date(2025, 11, 31), description: 'late AJE', lines, isAdjusting: true }),
      ).rejects.toThrow(/closed/);
      // Toggling the flag on a closed-period entry is an edit of closed books.
      await expect(
        updateEntry(ctx, old.id, { date: new Date(2025, 11, 15), description: 'pre-close AJE', lines, isAdjusting: false }),
      ).rejects.toThrow(/closed/);
      expect((await getEntry(ctx, old.id)).status).toBe('posted');
      // With the closing-date override (password accepted) it is allowed.
      const ok = await createManualEntry(
        { ...ctx, closingDateOverride: true },
        { date: new Date(2025, 11, 31), description: 'late AJE (override)', lines, isAdjusting: true },
      );
      expect(ok.isAdjusting).toBe(true);
    } finally {
      await setClosingDate(ctx, { closingDate: null });
    }
  });
});

// ---------------------------------------------------------------------------
// B1 — account types
// ---------------------------------------------------------------------------

describe('QA: QuickBooks account types', () => {
  it('normalizes QB type spellings and rejects junk', async () => {
    const a = await createAccount(ctx, { code: '1610', name: 'Rent Deposit', qbType: ' Other-Asset ' });
    expect(a.subtype).toBe('other_asset');
    expect(a.qbType).toBe('other_asset');
    const b = await createAccount(ctx, { code: '2610', name: 'Visa', qbType: 'CREDIT CARD' });
    expect(b.qbType).toBe('credit_card');
    await expect(createAccount(ctx, { code: '1611', name: 'X', type: 'banana' as never })).rejects.toThrow();
    await expect(createAccount(ctx, { code: '1612', name: 'X', type: 'asset', subtype: 'non_existent' })).rejects.toThrow(/Invalid subtype/);
    await expect(createAccount(ctx, { code: '1613', name: 'X' })).rejects.toThrow(/type is required/);
    // A liability subtype on an asset account.
    await expect(createAccount(ctx, { code: '1614', name: 'X', type: 'asset', subtype: 'other_current_liability' })).rejects.toThrow();
  });

  it('refuses to turn an account WITH history into A/R (unnamed lines would break the A/R subledger)', async () => {
    const misc = await createAccount(ctx, { code: '1620', name: 'Misc Clearing', qbType: 'other_current_asset' });
    await postJournalEntry(ctx, {
      date: new Date(2026, 1, 12),
      description: 'clearing',
      lines: [
        { accountId: misc.id, debit: '500.00' },
        { accountId: code['3000'], credit: '500.00' },
      ],
    });
    // QuickBooks: an account with transactions cannot be changed to/from Accounts Receivable.
    let refused = false;
    try {
      await updateAccount(ctx, misc.id, { qbType: 'accounts_receivable' });
    } catch {
      refused = true;
    }
    // Whatever happens, A/R aging must still equal the A/R control accounts.
    const asOf = new Date(2026, 2, 31);
    const ar = await arAging(ctx, asOf);
    try {
      expect(Number(ar.totals.total)).toBeCloseTo(await controlBalance('asset', 'accounts_receivable', asOf), 2);
      expect(refused).toBe(true);
    } finally {
      // Undo so later tests start from a sane chart (no-op when refused).
      if (!refused) await updateAccount(ctx, misc.id, { qbType: 'other_current_asset' });
    }
  });

  it('refuses to turn the A/R or A/P account WITH history into another type', async () => {
    // 1200 carries invoices + named GJ lines; making it an Other Current Asset would drop those
    // open items' control account while invoices still show as owed.
    const attempt = async (id: string, qbType: string) => {
      try {
        await updateAccount(ctx, id, { qbType });
        return false;
      } catch {
        return true;
      }
    };
    const arRefused = await attempt(code['1200'], 'other_current_asset');
    const apRefused = await attempt(code['2000'], 'other_current_liability');
    const asOf = new Date(2026, 2, 31);
    try {
      // Subledger == control must survive the attempt.
      const ar = await arAging(ctx, asOf);
      expect(Number(ar.totals.total)).toBeCloseTo(await controlBalance('asset', 'accounts_receivable', asOf), 2);
      const ap = await apAging(ctx, asOf);
      expect(Number(ap.totals.total)).toBeCloseTo(await controlBalance('liability', 'accounts_payable', asOf), 2);
      expect(arRefused).toBe(true);
      expect(apRefused).toBe(true);
    } finally {
      if (!arRefused) await updateAccount(ctx, code['1200'], { qbType: 'accounts_receivable' });
      if (!apRefused) await updateAccount(ctx, code['2000'], { qbType: 'accounts_payable' });
    }
  });

  it('a non-posting account never appears on TB / BS / P&L and cannot be posted via a draft', async () => {
    const np = await createAccount(ctx, { code: '9100', name: 'QA Purchase Orders', qbType: 'non_posting' });
    // A draft referencing it is allowed (status != posted) but posting it is refused at commit.
    const draft = await postJournalEntry(ctx, {
      date: new Date(2026, 1, 13),
      description: 'draft np',
      status: 'draft',
      lines: [
        { accountId: np.id, debit: '3.00' },
        { accountId: code['1000'], credit: '3.00' },
      ],
    } as never);
    await expect(
      db.transaction(async (tx) => {
        await tx.update(journalEntries).set({ status: 'posted' }).where(eq(journalEntries.id, draft.id));
      }),
    ).rejects.toThrow();
    const [row] = await db.select({ status: journalEntries.status }).from(journalEntries).where(eq(journalEntries.id, draft.id));
    expect(row.status).toBe('draft');
    const [npRow] = await db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, np.id));
    expect(Number(npRow.balance)).toBe(0);

    const tb = await trialBalance(ctx);
    const bs = await balanceSheet(ctx);
    const pl = await profitAndLoss(ctx);
    for (const rep of [tb, bs, pl]) expect(JSON.stringify(rep)).not.toContain(np.id);
    // Changing an account with posted history to non-posting is refused by the service too.
    await expect(updateAccount(ctx, code['6200'], { subtype: 'non_posting' })).rejects.toThrow();
    // ...and a non-posting account cannot be given an opening balance.
    await expect(
      createAccount(ctx, { code: '9101', name: 'NP2', qbType: 'non_posting', openingBalance: '-0.01' }),
    ).rejects.toThrow(/non-posting/);
  });
});

// ---------------------------------------------------------------------------
// B2 — tax lines
// ---------------------------------------------------------------------------

describe('QA: income-tax line mapping', () => {
  it('rejects unknown tax lines / forms, clears with blank, excludes non-posting', async () => {
    await expect(createAccount(ctx, { code: '6810', name: 'X', qbType: 'expense', taxLine: 'nope:L99' })).rejects.toThrow(/Unknown tax line/);
    await expect(setIncomeTaxForm(ctx, '1040' as never)).rejects.toThrow(/Unknown tax form/);
    const map0 = await getTaxLineMapping(ctx);
    const someLine = map0.lines.length ? map0.lines[0].key : null;
    await setIncomeTaxForm(ctx, '1120');
    const map1 = await getTaxLineMapping(ctx);
    expect(map1.form).toBe('1120');
    const key = someLine ?? map1.lines[0].key;
    const acct = await createAccount(ctx, { code: '6811', name: 'Taxed', qbType: 'expense', taxLine: key });
    expect(acct.taxLine).toBe(key);
    const cleared = await updateAccount(ctx, acct.id, { taxLine: '' });
    expect(cleared.taxLine).toBeNull();
    await expect(updateAccount(ctx, acct.id, { taxLine: '1120:bogus' })).rejects.toThrow(/Unknown tax line/);
    const map2 = await getTaxLineMapping(ctx);
    const allIds = JSON.stringify(map2);
    const [np] = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '9100')));
    expect(allIds).not.toContain(np.id);
    expect(map2.unassigned.some((a) => a.id === acct.id)).toBe(true);
    // Clearing the form is allowed.
    await setIncomeTaxForm(ctx, null);
    expect((await getTaxLineMapping(ctx)).form).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A3 — document numbers
// ---------------------------------------------------------------------------

describe('QA: alphanumeric document numbers', () => {
  it('incrementAlnum / docNumberToInt / normalize edge cases', () => {
    expect(incrementAlnumPure('9')).toBe('10');
    expect(incrementAlnumPure('INV-0999')).toBe('INV-1000');
    expect(incrementAlnumPure('INV-999')).toBe('INV-1000');
    expect(incrementAlnumPure('A-')).toBe('A-1');
    expect(incrementAlnumPure('X9Y')).toBe('X9Y1');
    expect(incrementAlnumPure('  7 ')).toBe('8');
    expect(incrementAlnumPure('')).toBe('1');
    expect(incrementAlnumPure('99999999999999999999')).toBe('100000000000000000000');
    expect(incrementAlnumPure('2026-0099')).toBe('2026-0100');
    expect(docNumberToInt('0')).toBeNull();
    expect(docNumberToInt('INV-2147483648')).toBeNull();
    expect(docNumberToInt('INV-2147483647')).toBe(2147483647);
    expect(docNumberToInt('ABC')).toBeNull();
    expect(normalizeDocNumber('   ')).toBeNull();
    expect(normalizeDocNumber('  INV-1 ')).toBe('INV-1');
    expect(() => normalizeDocNumber('x'.repeat(51))).toThrow(/at most 50/);
    expect(() => normalizeDocNumber('INV\t1')).toThrow(/control/);
    expect(() => normalizeDocNumber('INV\n1')).toThrow(/control/);
  });

  it('duplicates are case-insensitive, per company, per doc type; triggers back-fill on UPDATE', async () => {
    const inv = await createInvoice(ctx, { customerId: customer2Id, date: new Date(2026, 2, 1), lines: [{ quantity: 1, rate: '5.00' }] });
    // Legacy writer: ref_number filled from the integer.
    const [row] = await db.select({ ref: invoices.refNumber, num: invoices.invoiceNumber }).from(invoices).where(eq(invoices.id, inv.id));
    expect(row.ref).toBe(String(row.num));
    // Blanking the ref on UPDATE refills it from the integer.
    await db.update(invoices).set({ refNumber: '  ' }).where(eq(invoices.id, inv.id));
    const [row2] = await db.select({ ref: invoices.refNumber }).from(invoices).where(eq(invoices.id, inv.id));
    expect(row2.ref).toBe(String(row.num));

    await db.update(invoices).set({ refNumber: 'QA-0099' }).where(eq(invoices.id, inv.id));
    await expect(allocateDocNumber(ctx, 'invoice', 'qa-0099')).rejects.toMatchObject({ code: 'CONFLICT' });
    const dup = await allocateDocNumber(ctx, 'invoice', ' QA-0099 ', { allowDuplicate: true });
    expect(dup.duplicate).toBe(true);
    expect(dup.refNumber).toBe('QA-0099');
    expect(dup.number).toBe(99);
    // Excluding the document itself (re-saving it) is not a duplicate.
    expect((await allocateDocNumber(ctx, 'invoice', 'QA-0099', { excludeId: inv.id })).duplicate).toBe(false);
    // Same number on a different document type is fine.
    expect((await allocateDocNumber(ctx, 'estimate', 'QA-0099')).duplicate).toBe(false);
    // Another company is unaffected.
    expect((await allocateDocNumber(ctx2, 'invoice', 'QA-0099')).duplicate).toBe(false);
    expect(await nextDocNumber(ctx2, 'invoice')).not.toMatch(/^QA-/);

    // The next number follows the last one and skips any that are taken.
    expect(await nextDocNumber(ctx, 'invoice')).toBe('QA-0100');
    const later = await createInvoice(ctx, { customerId: customer2Id, date: new Date(2026, 2, 2), lines: [{ quantity: 1, rate: '5.00' }] });
    await db.update(invoices).set({ refNumber: 'QA-0100' }).where(eq(invoices.id, later.id));
    expect(await nextDocNumber(ctx, 'invoice')).toBe('QA-0101');

    // No-digit number: integer column gets MAX+1.
    const alpha = await allocateDocNumber(ctx, 'invoice', 'ABC');
    const [{ max }] = await db
      .select({ max: sql<number>`max(${invoices.invoiceNumber})` })
      .from(invoices)
      .where(eq(invoices.companyId, ctx.companyId));
    expect(alpha.number).toBe(Number(max) + 1);
  });

  it('starting numbers: refuse a taken one (case-insensitive), clear with null, audit the change', async () => {
    await expect(setStartingDocNumber(ctx, 'invoice', 'qa-0100')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(setStartingDocNumber(ctx, 'nonsense' as never, '1')).rejects.toThrow(/Unknown document type/);
    await expect(setStartingDocNumber(ctx, 'invoice', 'y'.repeat(60))).rejects.toThrow(/at most 50/);
    const s = await setStartingDocNumber(ctx, 'purchase_order', 'PO-5000');
    expect(s.nextNumber).toBe('PO-5000');
    // Setting one type leaves the others untouched.
    const s2 = await setStartingDocNumber(ctx, 'estimate', 'E-1');
    expect(s2.startingNumber).toBe('E-1');
    expect(await nextDocNumber(ctx, 'purchase_order')).toBe('PO-5000');
    const cleared = await setStartingDocNumber(ctx, 'purchase_order', null);
    expect(cleared.startingNumber).toBeNull();
    expect(await nextDocNumber(ctx, 'purchase_order')).not.toBe('PO-5000');
    const audits = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'company')));
    expect(audits[0].n).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Migration idempotency (run LAST: re-executes 0025 against the live test DB)
// ---------------------------------------------------------------------------

describe('QA: migration 0025', () => {
  it('re-running the migration is harmless (idempotent) and keeps the books balanced', async () => {
    const file = path.resolve(process.cwd(), 'drizzle', '0025_wave2_foundation.sql');
    const stmts = fs
      .readFileSync(file, 'utf8')
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.replace(/--.*$/gm, '').trim().length > 0);
    const tbBefore = await trialBalance(ctx);
    const subtypesBefore = await db
      .select({ id: accounts.id, subtype: accounts.subtype })
      .from(accounts)
      .where(eq(accounts.companyId, ctx.companyId));
    await db.transaction(async (tx) => {
      for (const s of stmts) await tx.execute(sql.raw(s));
    });
    const subtypesAfter = await db
      .select({ id: accounts.id, subtype: accounts.subtype })
      .from(accounts)
      .where(eq(accounts.companyId, ctx.companyId));
    const before = new Map(subtypesBefore.map((r) => [r.id, r.subtype]));
    // Seeded / user-chosen subtypes survive a re-run unchanged.
    for (const r of subtypesAfter) expect(r.subtype).toBe(before.get(r.id));
    const tbAfter = await trialBalance(ctx);
    expect(tbAfter.totalDebit).toBe(tbBefore.totalDebit);
    expect(tbAfter.balanced).toBe(true);
    // Guards still installed after the re-run.
    const integrity = await verifyIntegrity(ctx);
    expect(integrity.checks.filter((c) => !c.ok)).toEqual([]);
    // Lines named before the re-run keep their names.
    const named = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(journalEntryLines)
      .where(eq(journalEntryLines.entityType, 'customer'));
    expect(named[0].n).toBeGreaterThan(0);
  });
});
