/**
 * Integration tests for the dashboard insights service (lib/services/dashboard.ts).
 *
 * Boots a throwaway PGlite instance, seeds a company with a small chart of accounts,
 * posted GL activity across several months, open/overdue invoices and bills, inventory
 * items around their reorder point, and a completed reconciliation — then asserts the
 * aggregated read model: fiscal-YTD KPIs, A/R aging totals, A/P due soon, 6-month P&L
 * trend, overdue-invoice and bills-due lists, low-stock count, and reconciliation status.
 *
 * All assertions run against a FIXED `now` so the test is deterministic regardless of
 * when it executes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  bankAccounts,
  bills,
  companies,
  customers,
  invoices,
  items,
  reconciliations,
  users,
  vendors,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { getDashboardInsights } from './dashboard';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-dashboard');

/** Frozen "today" for every query: June 15 2026, noon local time. */
const NOW = new Date(2026, 5, 15, 12, 0, 0);

let ctx: ServiceContext;
let db: DB;
let userId: string;
const acct: Record<string, string> = {};

describe('Dashboard insights (getDashboardInsights)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'dash@test.local', name: 'Dash', passwordHash: 'x' })
      .returning();
    userId = user.id;
    const [company] = await db
      .insert(companies)
      .values({ name: 'Dashboard Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    // --- chart of accounts ---
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['6000', 'Office Supplies', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    // --- posted GL activity ---
    // Dec 2025: outside both the fiscal YTD window (Jan 1 2026) and the 6-month trend.
    await postJournalEntry(ctx, {
      date: new Date(2025, 11, 10),
      description: 'Old December sale',
      lines: [
        { accountId: acct['1000'], debit: '50.00' },
        { accountId: acct['4000'], credit: '50.00' },
      ],
    });
    // Apr 2026: revenue 500.
    await postJournalEntry(ctx, {
      date: new Date(2026, 3, 10),
      description: 'April sale',
      lines: [
        { accountId: acct['1000'], debit: '500.00' },
        { accountId: acct['4000'], credit: '500.00' },
      ],
    });
    // Jun 2026: revenue 1000, expense 200.
    await postJournalEntry(ctx, {
      date: new Date(2026, 5, 10),
      description: 'June sale',
      lines: [
        { accountId: acct['1000'], debit: '1000.00' },
        { accountId: acct['4000'], credit: '1000.00' },
      ],
    });
    await postJournalEntry(ctx, {
      date: new Date(2026, 5, 12),
      description: 'June supplies',
      lines: [
        { accountId: acct['6000'], debit: '200.00' },
        { accountId: acct['1000'], credit: '200.00' },
      ],
    });

    // --- customers + invoices ---
    const [acme] = await db
      .insert(customers)
      .values({ companyId: ctx.companyId, displayName: 'Acme Corp' })
      .returning();
    const [zenith] = await db
      .insert(customers)
      .values({ companyId: ctx.companyId, displayName: 'Zenith LLC' })
      .returning();

    const invoiceRows = [
      // 40 days overdue (due May 6) — 31-60 bucket.
      {
        customerId: acme.id,
        invoiceNumber: 101,
        date: new Date(2026, 3, 6),
        dueDate: new Date(2026, 4, 6),
        status: 'open' as const,
        total: '300.00',
        balanceDue: '300.00',
      },
      // 10 days overdue (due Jun 5) — 1-30 bucket.
      {
        customerId: zenith.id,
        invoiceNumber: 102,
        date: new Date(2026, 4, 6),
        dueDate: new Date(2026, 5, 5),
        status: 'open' as const,
        total: '200.00',
        balanceDue: '200.00',
      },
      // Not yet due (due Jun 25) — current bucket; must NOT appear in overdue list.
      {
        customerId: acme.id,
        invoiceNumber: 103,
        date: new Date(2026, 5, 1),
        dueDate: new Date(2026, 5, 25),
        status: 'open' as const,
        total: '100.00',
        balanceDue: '100.00',
      },
      // Fully paid long-overdue invoice — excluded everywhere.
      {
        customerId: acme.id,
        invoiceNumber: 104,
        date: new Date(2026, 2, 1),
        dueDate: new Date(2026, 3, 1),
        status: 'paid' as const,
        total: '500.00',
        amountPaid: '500.00',
        balanceDue: '0.00',
      },
    ];
    for (const row of invoiceRows) {
      await db.insert(invoices).values({ companyId: ctx.companyId, ...row });
    }

    // --- vendor + bills ---
    const [vend] = await db
      .insert(vendors)
      .values({ companyId: ctx.companyId, displayName: 'Office Depot' })
      .returning();
    const billRows = [
      // Due in 2 days (Jun 17) — in "this week" AND in A/P due soon.
      {
        billNumber: 'B-1',
        date: new Date(2026, 5, 1),
        dueDate: new Date(2026, 5, 17),
        status: 'open' as const,
        total: '150.00',
        balanceDue: '150.00',
      },
      // Overdue (Jun 10) — A/P due soon only, NOT in "due this week".
      {
        billNumber: 'B-2',
        date: new Date(2026, 4, 10),
        dueDate: new Date(2026, 5, 10),
        status: 'open' as const,
        total: '80.00',
        balanceDue: '80.00',
      },
      // Due Jul 10 — outside the 7-day horizon entirely.
      {
        billNumber: 'B-3',
        date: new Date(2026, 5, 10),
        dueDate: new Date(2026, 6, 10),
        status: 'open' as const,
        total: '999.00',
        balanceDue: '999.00',
      },
    ];
    for (const row of billRows) {
      await db.insert(bills).values({ companyId: ctx.companyId, vendorId: vend.id, ...row });
    }

    // --- items (low stock) ---
    await db.insert(items).values([
      // Low: 2 on hand <= reorder 5.
      { companyId: ctx.companyId, name: 'Widget', type: 'inventory', quantityOnHand: '2', reorderPoint: '5' },
      // Healthy: 10 > 5.
      { companyId: ctx.companyId, name: 'Gadget', type: 'inventory', quantityOnHand: '10', reorderPoint: '5' },
      // No reorder point — never counted.
      { companyId: ctx.companyId, name: 'Sprocket', type: 'inventory', quantityOnHand: '0' },
      // Inactive — never counted.
      { companyId: ctx.companyId, name: 'Retired', type: 'inventory', quantityOnHand: '0', reorderPoint: '5', isActive: false },
      // Service item — never counted.
      { companyId: ctx.companyId, name: 'Consulting', type: 'service', quantityOnHand: '0', reorderPoint: '5' },
    ]);

    // --- reconciliation ---
    const [ba] = await db
      .insert(bankAccounts)
      .values({
        companyId: ctx.companyId,
        accountId: acct['1000'],
        bankName: 'First Local Bank',
        accountNumber: '1234',
      })
      .returning();
    await db.insert(reconciliations).values({
      bankAccountId: ba.id,
      statementDate: new Date(2026, 4, 31),
      statementBalance: '1300.00',
      status: 'completed',
      createdBy: userId,
      completedAt: new Date(2026, 5, 1),
    });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns fiscal-YTD KPIs (Dec 2025 activity excluded, cash from account balances)', async () => {
    const d = await getDashboardInsights(ctx, NOW);
    expect(d.kpis.revenueYtd).toBe('1500.00'); // 500 (Apr) + 1000 (Jun); Dec 2025 excluded
    expect(d.kpis.netProfitYtd).toBe('1300.00'); // 1500 - 200
    expect(d.kpis.cash).toBe('1350.00'); // all-time checking balance: 50 + 500 + 1000 - 200
    expect(new Date(d.kpis.ytdFrom).getUTCFullYear()).toBe(2026); // UTC-midnight bound
  });

  it('summarizes A/R aging buckets', async () => {
    const d = await getDashboardInsights(ctx, NOW);
    expect(d.arAging.current).toBe('100.00');
    expect(d.arAging.days1_30).toBe('200.00');
    expect(d.arAging.days31_60).toBe('300.00');
    expect(d.arAging.days61_90).toBe('0.00');
    expect(d.arAging.days91plus).toBe('0.00');
    expect(d.arAging.total).toBe('600.00');
  });

  it('builds a 6-month P&L trend with stable month keys', async () => {
    const d = await getDashboardInsights(ctx, NOW);
    expect(d.plTrend.map((t) => t.month)).toEqual([
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
    ]);
    const byMonth = Object.fromEntries(d.plTrend.map((t) => [t.month, t]));
    expect(byMonth['2026-04'].income).toBe('500.00');
    expect(byMonth['2026-04'].net).toBe('500.00');
    expect(byMonth['2026-06'].income).toBe('1000.00');
    expect(byMonth['2026-06'].expenses).toBe('200.00');
    expect(byMonth['2026-06'].net).toBe('800.00');
    expect(byMonth['2026-02'].net).toBe('0.00'); // empty months are materialized
  });

  it('lists overdue invoices (oldest due date first) with days overdue and totals', async () => {
    const d = await getDashboardInsights(ctx, NOW);
    expect(d.overdueInvoiceCount).toBe(2);
    expect(d.overdueInvoiceTotal).toBe('500.00');
    expect(d.overdueInvoices).toHaveLength(2);
    expect(d.overdueInvoices[0].invoiceNumber).toBe(101);
    expect(d.overdueInvoices[0].customerName).toBe('Acme Corp');
    expect(d.overdueInvoices[0].daysOverdue).toBe(40);
    expect(d.overdueInvoices[0].balanceDue).toBe('300.00');
    expect(d.overdueInvoices[1].invoiceNumber).toBe(102);
    expect(d.overdueInvoices[1].daysOverdue).toBe(10);
    // Paid + not-yet-due invoices excluded.
    const numbers = d.overdueInvoices.map((i) => i.invoiceNumber);
    expect(numbers).not.toContain(103);
    expect(numbers).not.toContain(104);
  });

  it('separates bills due this week from the wider A/P due-soon rollup', async () => {
    const d = await getDashboardInsights(ctx, NOW);
    // This week = [today, today+7): only B-1.
    expect(d.billsDueThisWeekCount).toBe(1);
    expect(d.billsDueThisWeekTotal).toBe('150.00');
    expect(d.billsDueThisWeek[0].billNumber).toBe('B-1');
    expect(d.billsDueThisWeek[0].vendorName).toBe('Office Depot');
    // Due soon = overdue + due within horizon: B-1 + B-2 (not B-3).
    expect(d.apDueSoon.count).toBe(2);
    expect(d.apDueSoon.total).toBe('230.00');
    expect(d.apDueSoon.horizonDays).toBe(7);
  });

  it('counts low-stock inventory items (active inventory at/below reorder point)', async () => {
    const d = await getDashboardInsights(ctx, NOW);
    expect(d.lowStockCount).toBe(1);
  });

  it('reports the most recent reconciliation', async () => {
    const d = await getDashboardInsights(ctx, NOW);
    expect(d.lastReconciliation).not.toBeNull();
    expect(d.lastReconciliation?.accountName).toBe('Checking');
    expect(d.lastReconciliation?.bankName).toBe('First Local Bank');
    expect(d.lastReconciliation?.status).toBe('completed');
    expect(d.lastReconciliation?.completedAt).toBeTruthy();
  });

  it('is companyId-scoped (a fresh company sees an empty dashboard)', async () => {
    const [other] = await db
      .insert(companies)
      .values({ name: 'Other Co', ownerId: userId })
      .returning();
    const otherCtx: ServiceContext = { db, companyId: other.id, userId };
    const d = await getDashboardInsights(otherCtx, NOW);
    expect(d.kpis.revenueYtd).toBe('0.00');
    expect(d.arAging.total).toBe('0.00');
    expect(d.overdueInvoiceCount).toBe(0);
    expect(d.billsDueThisWeekCount).toBe(0);
    expect(d.apDueSoon.count).toBe(0);
    expect(d.lowStockCount).toBe(0);
    expect(d.lastReconciliation).toBeNull();
    expect(d.plTrend.every((t) => t.net === '0.00')).toBe(true);
  });
});
