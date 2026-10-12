/**
 * Integration tests for the Deposits service.
 *
 * Scenario:
 *  1. Receive two payments into Undeposited Funds (direct insert, simulating
 *     the GL entry from receivePayment but with a test-local UF account).
 *  2. Verify both appear in listUndepositedPayments.
 *  3. Make a deposit — picks up both payments into a Checking account.
 *  4. Assert:
 *     - UF balance returns to 0 (cleared).
 *     - Checking account balance increases by the deposit total.
 *     - Trial balance stays balanced throughout.
 *  5. After deposit, neither payment appears in listUndepositedPayments.
 *  6. Attempting to deposit the same payments again throws CONFLICT.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, customers, paymentsReceived } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { postJournalEntry } from './posting';
import {
  listUndepositedPayments,
  createDeposit,
  listDeposits,
  getDeposit,
} from './deposits';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-deposits');

let ctx: ServiceContext;
let db: DB;

const acct: Record<string, string> = {};
let customerId: string;

describe('Deposits service', () => {
  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'deposits-owner@test.local', name: 'Deposit Owner', passwordHash: 'x' })
      .returning();

    const [company] = await db
      .insert(companies)
      .values({ name: 'Deposits Test Co', ownerId: user.id })
      .returning();

    ctx = { db, companyId: company.id, userId: user.id };

    // Seed accounts: Checking (1000), Undeposited Funds (1050), AR (1200), Sales (4000).
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype: subtype as never });
      acct[code] = row.id;
    }

    // Seed one customer.
    const [cust] = await db
      .insert(customers)
      .values({ companyId: company.id, displayName: 'Alice Corp' })
      .returning();
    customerId = cust.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Helper: simulate a payment into UF by posting GL directly + inserting row.
  // This mirrors what receivePayment does in production.
  // -------------------------------------------------------------------------
  async function seedUFPayment(amount: string, ref: string): Promise<string> {
    // Post GL: Dr UF / Cr AR
    await postJournalEntry(ctx, {
      allowUnnamedControl: true, // fixture posts straight to A/R or A/P
      date: new Date('2025-06-01'),
      description: `Payment from customer (${ref})`,
      lines: [
        { accountId: acct['1050'], debit: amount, memo: 'UF' },
        { accountId: acct['1200'], credit: amount, memo: 'AR' },
      ],
    });

    const [pmt] = await db
      .insert(paymentsReceived)
      .values({
        companyId: ctx.companyId,
        customerId,
        date: new Date('2025-06-01'),
        method: 'check',
        reference: ref,
        amount,
        unapplied: amount,
        depositAccountId: acct['1050'], // UF
      })
      .returning();

    return pmt.id;
  }

  // -------------------------------------------------------------------------
  // Tests
  // -------------------------------------------------------------------------

  it('listUndepositedPayments returns nothing initially', async () => {
    const rows = await listUndepositedPayments(ctx);
    expect(rows).toHaveLength(0);
  });

  let pmtId1: string;
  let pmtId2: string;

  it('after two UF payments, listUndepositedPayments returns both', async () => {
    pmtId1 = await seedUFPayment('500.00', 'CHK-001');
    pmtId2 = await seedUFPayment('250.00', 'CHK-002');

    const rows = await listUndepositedPayments(ctx);
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(pmtId1);
    expect(ids).toContain(pmtId2);

    // Trial balance should be balanced (GL was posted).
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('createDeposit posts GL, clears UF, increases Checking, inserts records', async () => {
    // Snapshot balances before.
    const [ufBefore] = await db.select().from(accounts).where(eq(accounts.id, acct['1050']));
    const [chkBefore] = await db.select().from(accounts).where(eq(accounts.id, acct['1000']));

    const result = await createDeposit(ctx, {
      depositAccountId: acct['1000'],
      date: new Date('2025-06-05'),
      paymentIds: [pmtId1, pmtId2],
      memo: 'June batch deposit',
    });

    expect(result.total).toBe('750.00');
    expect(result.postedEntryId).toBeTruthy();

    // UF should have decreased by 750.
    const [ufAfter] = await db.select().from(accounts).where(eq(accounts.id, acct['1050']));
    const ufDelta = Number(ufBefore.balance) - Number(ufAfter.balance);
    expect(ufDelta).toBeCloseTo(750, 2);

    // Checking should have increased by 750.
    const [chkAfter] = await db.select().from(accounts).where(eq(accounts.id, acct['1000']));
    const chkDelta = Number(chkAfter.balance) - Number(chkBefore.balance);
    expect(chkDelta).toBeCloseTo(750, 2);

    // Trial balance still balanced.
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it('after deposit, listUndepositedPayments returns nothing', async () => {
    const rows = await listUndepositedPayments(ctx);
    expect(rows).toHaveLength(0);
  });

  it('listDeposits returns the created deposit', async () => {
    const list = await listDeposits(ctx);
    expect(list.length).toBeGreaterThanOrEqual(1);
    const dep = list[0];
    expect(dep.total).toBe('750.00');
    expect(dep.memo).toBe('June batch deposit');
    expect(dep.lines).toHaveLength(2);
    expect(dep.accountCode).toBe('1000');
  });

  it('getDeposit returns deposit with its lines', async () => {
    const list = await listDeposits(ctx);
    const dep = await getDeposit(ctx, list[0].id);
    expect(dep.lines).toHaveLength(2);
    const payIds = dep.lines.map((l) => l.paymentId);
    expect(payIds).toContain(pmtId1);
    expect(payIds).toContain(pmtId2);
  });

  it('re-depositing the same payments throws CONFLICT', async () => {
    await expect(
      createDeposit(ctx, {
        depositAccountId: acct['1000'],
        date: new Date('2025-06-10'),
        paymentIds: [pmtId1],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('createDeposit rejects an empty paymentIds array', async () => {
    await expect(
      createDeposit(ctx, {
        depositAccountId: acct['1000'],
        date: new Date('2025-06-10'),
        paymentIds: [],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('createDeposit rejects depositing into UF itself', async () => {
    // Add a fresh payment first.
    const freshId = await seedUFPayment('100.00', 'CHK-003');
    await expect(
      createDeposit(ctx, {
        depositAccountId: acct['1050'],
        date: new Date('2025-06-10'),
        paymentIds: [freshId],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('trial balance is balanced after all operations', async () => {
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });
});
