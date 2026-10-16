/**
 * Regression tests for the app-shell audit fixes:
 *
 *  1. lib/nav.ts — command palette destinations are derived from the sidebar nav (no drift),
 *     and include the intentionally non-sidebar pages (/budgets, /transactions).
 *  2. app/api/search/results.ts — global search results carry the matched record's id in the
 *     href (?focus=<id>) instead of pointing at the bare list page.
 *  3. lib/ytd.ts — fiscal-aware YTD window used by the dashboard "YTD" KPI cards, and the
 *     dashboard P&L call excludes prior-year activity when the range is applied.
 *  4. app/api/recurring/run — accepts the Electron main process's per-launch internal token
 *     (x-bka-internal) so the launch-time recurring run no longer 403s in the packaged app,
 *     while session-less calls without the token still fail closed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, invoices } from '@/lib/db/schema';
import { navGroups, paletteDestinations, EXTRA_DESTINATIONS } from '@/lib/nav';
import { buildResults } from '@/app/api/search/results';
import { ytdRange } from '@/lib/ytd';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { profitAndLoss } from './reports';
import { createTemplate } from './recurring';
import { POST as recurringRunPOST } from '@/app/api/recurring/run/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-fixes-shell');

// ---------------------------------------------------------------------------
// 1. Command palette stays in sync with the sidebar
// ---------------------------------------------------------------------------
describe('lib/nav: palette destinations derive from the sidebar', () => {
  it('includes every sidebar link (label and path)', () => {
    const byHref = new Map(paletteDestinations.map((d) => [d.href, d.label]));
    for (const group of navGroups) {
      for (const link of group.links) {
        expect(byHref.get(link.path), `missing sidebar path ${link.path}`).toBe(link.label);
      }
    }
  });

  it('includes the intentionally non-sidebar pages', () => {
    const hrefs = paletteDestinations.map((d) => d.href);
    for (const extra of EXTRA_DESTINATIONS) {
      expect(hrefs).toContain(extra.href);
    }
    expect(hrefs).toContain('/budgets');
    expect(hrefs).toContain('/transactions');
  });

  it('covers previously-missing sidebar entries (regression)', () => {
    const hrefs = new Set(paletteDestinations.map((d) => d.href));
    for (const p of [
      '/mileage',
      '/sales-reps',
      '/inventory-ops',
      '/estimates-followup',
      '/reports/1099-efile',
      '/reports/pl-comparative',
      '/reports/pl-monthly',
      '/reports/balance-sheet-cash',
      '/reports/pl-by-class',
    ]) {
      expect(hrefs.has(p), `palette missing ${p}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Search results link to the found record
// ---------------------------------------------------------------------------
describe('search results carry the matched record id', () => {
  it('builds ?focus=<id> hrefs for all four entity types', () => {
    const results = buildResults({
      cust: [{ id: 'c-1', label: 'Acme LLC' }],
      vend: [{ id: 'v-1', label: 'Paper Co' }],
      itm: [{ id: 'i-1', label: 'Widget' }],
      inv: [{ id: 'inv-1', num: 1042 }],
    });
    expect(results).toEqual([
      { type: 'Customer', label: 'Acme LLC', href: '/customers?focus=c-1', id: 'c-1' },
      { type: 'Vendor', label: 'Paper Co', href: '/vendors?focus=v-1', id: 'v-1' },
      { type: 'Item', label: 'Widget', href: '/items?focus=i-1', id: 'i-1' },
      { type: 'Invoice', label: 'Invoice #1042', href: '/invoices?focus=inv-1', id: 'inv-1' },
    ]);
    for (const r of results) {
      expect(r.href).toContain(`focus=${r.id}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. YTD window helper (dashboard KPI cards)
// ---------------------------------------------------------------------------
describe('ytdRange', () => {
  const now = new Date(2026, 5, 9); // 2026-06-09

  it('defaults to Jan 1 of the current calendar year', () => {
    const { from, to } = ytdRange(undefined, now);
    expect(from).toEqual(new Date(Date.UTC(2026, 0, 1)));
    expect(to).toEqual(new Date(Date.UTC(2026, 5, 9, 23, 59, 59, 999))); // end of the day, UTC bounds
  });

  it('honors a 12-31 fiscal year end (same as calendar)', () => {
    const { from } = ytdRange('12-31', now);
    expect(from).toEqual(new Date(Date.UTC(2026, 0, 1)));
  });

  it('starts the day after the most recent fiscal year end (06-30)', () => {
    const { from } = ytdRange('06-30', now);
    // Most recent completed FYE before 2026-06-09 is 2025-06-30 -> start 2025-07-01.
    expect(from).toEqual(new Date(Date.UTC(2025, 6, 1)));
  });

  it('treats a fiscal year ending today as still open', () => {
    const { from } = ytdRange('06-30', new Date(2026, 5, 30));
    expect(from).toEqual(new Date(Date.UTC(2025, 6, 1)));
  });

  it('falls back to Jan 1 on malformed settings', () => {
    expect(ytdRange('June 30', now).from).toEqual(new Date(Date.UTC(2026, 0, 1)));
    expect(ytdRange('', now).from).toEqual(new Date(Date.UTC(2026, 0, 1)));
    expect(ytdRange('13-40', now).from).toEqual(new Date(Date.UTC(2026, 0, 1)));
  });
});

// ---------------------------------------------------------------------------
// 4. Integration: YTD-scoped P&L + internal-token recurring run
// ---------------------------------------------------------------------------
describe('shell fixes (integration)', () => {
  let db: DB;
  let ctx: ServiceContext;
  let customerId: string;
  const acct: Record<string, string> = {};
  const prevDataDir = process.env.BKA_DATA_DIR;
  const prevToken = process.env.BKA_INTERNAL_TOKEN;
  const prevFallback = process.env.BKA_ALLOW_DEV_FALLBACK;

  beforeAll(async () => {
    // The recurring/run route resolves its db from BKA_DATA_DIR (no session in these tests).
    process.env.BKA_DATA_DIR = TEST_DIR;
    delete process.env.BKA_ALLOW_DEV_FALLBACK;
    delete process.env.BKA_INTERNAL_TOKEN;

    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'shell-owner@test.local', name: 'Shell Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Shell Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Cash', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2200', 'Sales Tax Payable', 'liability', 'accounts_payable'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    const [cust] = await db
      .insert(customers)
      .values({ companyId: company.id, displayName: 'Shell Customer', balance: '0.00', taxable: false })
      .returning();
    customerId = cust.id;
  });

  afterAll(async () => {
    if (prevDataDir === undefined) delete process.env.BKA_DATA_DIR;
    else process.env.BKA_DATA_DIR = prevDataDir;
    if (prevToken === undefined) delete process.env.BKA_INTERNAL_TOKEN;
    else process.env.BKA_INTERNAL_TOKEN = prevToken;
    if (prevFallback !== undefined) process.env.BKA_ALLOW_DEV_FALLBACK = prevFallback;
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('dashboard P&L call excludes prior-year activity when given the YTD range', async () => {
    const now = new Date(2026, 5, 9);
    await postJournalEntry(ctx, {
      date: new Date(2025, 2, 15), // prior year
      description: 'Prior-year sale',
      lines: [
        { accountId: acct['1000'], debit: '100.00' },
        { accountId: acct['4000'], credit: '100.00' },
      ],
    });
    await postJournalEntry(ctx, {
      date: new Date(2026, 1, 10), // current year
      description: 'Current-year sale',
      lines: [
        { accountId: acct['1000'], debit: '250.00' },
        { accountId: acct['4000'], credit: '250.00' },
      ],
    });

    const allTime = await profitAndLoss(ctx);
    expect(allTime.totalIncome).toBe('350.00'); // the old (mislabeled) all-time figure

    const ytd = await profitAndLoss(ctx, ytdRange(undefined, now));
    expect(ytd.totalIncome).toBe('250.00'); // prior-year 100.00 excluded
  });

  function runRequest(headers?: Record<string, string>) {
    return new NextRequest('http://127.0.0.1/api/recurring/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(headers ?? {}) },
      body: '{}',
    });
  }

  it('recurring/run fails closed (403) for session-less calls without the internal token', async () => {
    const res = await recurringRunPOST(runRequest());
    expect(res.status).toBe(403);
  });

  it('recurring/run rejects a wrong internal token', async () => {
    process.env.BKA_INTERNAL_TOKEN = 'a'.repeat(64);
    try {
      const res = await recurringRunPOST(runRequest({ 'x-bka-internal': 'b'.repeat(64) }));
      expect(res.status).toBe(403);
      const short = await recurringRunPOST(runRequest({ 'x-bka-internal': 'a' }));
      expect(short.status).toBe(403);
    } finally {
      delete process.env.BKA_INTERNAL_TOKEN;
    }
  });

  it('recurring/run accepts the internal token and generates due documents (launch-time run)', async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await createTemplate(ctx, {
      name: 'Launch Retainer',
      docType: 'invoice',
      frequency: 'monthly',
      nextRunDate: today,
      template: {
        customerId,
        date: today.toISOString(),
        lines: [{ description: 'Retainer', quantity: '1', rate: '75.00' }],
      },
    });

    const token = 'f'.repeat(64);
    process.env.BKA_INTERNAL_TOKEN = token;
    try {
      const res = await recurringRunPOST(runRequest({ 'x-bka-internal': token }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.generated).toHaveLength(1);
      expect(body.generated[0].docType).toBe('invoice');

      // The generated invoice exists and belongs to the (first) company.
      const [inv] = await db.select().from(invoices).where(eq(invoices.id, body.generated[0].docId));
      expect(inv).toBeTruthy();
      expect(inv.companyId).toBe(ctx.companyId);
      expect(inv.total).toBe('75.00');
    } finally {
      delete process.env.BKA_INTERNAL_TOKEN;
    }
  });
});
