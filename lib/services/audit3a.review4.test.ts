/**
 * Round 4 audit of round 3 (5b81be5): migration 0059, application dates, the company-file lock.
 *
 *  A. 0059 must not touch foreign-currency deposits: their lines are in the deposit currency and
 *     the entry credits allocated home amounts, so pairing by amount took another line's account
 *     (EUR 125 line moved from Other Income to Owner's Equity). 0037 predates foreign deposits
 *     (0043), so none needs repair.
 *  B. A credit application without a date takes the later of the memo's and the invoice's dates
 *     (not "today"): in an Accountant's Copy "today" is after the dividing date, so Apply credits,
 *     Write Off Invoices and the Client Data Review auto-apply were all refused. End to end: the
 *     accountant applies, writes off and auto-applies, and the client imports it. When that day is
 *     locked (closed period) the application is dated today as before; an explicit date is checked.
 *  C. Vendor-credit (un)applications entered with the closing-date password are listed on the
 *     Closing Date Exception report.
 *  D. A lock taken over while this process still has the file open kills the handle: getDb throws
 *     CompanyFileInUseError, a transaction in flight rolls back, later statements are refused.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB, CompanyFileInUseError } from '@/lib/db';
import { HEARTBEAT_MS, LOCK_FILE, holdsDirLock } from '@/lib/db/dirLock';
import {
  accounts,
  auditLogs,
  companies,
  creditApplications,
  customers,
  depositLines,
  invoices,
  users,
  vendors,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { setBaseCurrency, upsertCurrency, setAccountCurrency } from './currencies';
import { createDeposit } from './deposits';
import { createInvoice } from './invoices';
import { applyToInvoice, createCreditMemo } from './creditMemos';
import { writeOffInvoices } from './accountant/writeOff';
import { autoApplyCustomerCredit } from './accountant/clientDataReview';
import { createBill } from './bills';
import { createVendorCredit, applyToBill, unapplyFromBill } from './vendorCredits';
import { createAccountantCopy, importChangesFile } from './accountantCopy/client';
import { exportChangesFile, openAccountantCopyFile } from './accountantCopy/accountant';

let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));
import { POST as creditMemoPOST } from '@/app/api/credit-memos/[id]/route';

const TEST_ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review4-audit3a');
const TEST_DIR = path.join(TEST_ROOT, 'data');
let db: DB;
let userId: string;

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const ymd = (x: Date | string) => new Date(x).toISOString().slice(0, 10);

const migrationSql = (file: string, marker: string) =>
  fs
    .readFileSync(path.resolve(process.cwd(), 'drizzle', file), 'utf8')
    .split('--> statement-breakpoint')
    .find((s) => s.includes(marker))!;

async function newCompany(on: DB, name: string): Promise<ServiceContext> {
  const company = await createCompany(on, { name, ownerId: userId });
  return { db: on, companyId: company.id, userId };
}
async function codesOf(ctx: ServiceContext) {
  const rows = await ctx.db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId));
  return (c: string) => rows.find((a) => a.code === c)!.id;
}
async function setClosingDate(ctx: ServiceContext, closingDate: string | null) {
  const [co] = await ctx.db.select().from(companies).where(eq(companies.id, ctx.companyId));
  await ctx.db
    .update(companies)
    .set({ settings: { ...((co.settings as Record<string, unknown>) ?? {}), closingDate } })
    .where(eq(companies.id, ctx.companyId));
}
const exceptionsOf = (ctx: ServiceContext) =>
  db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'closing_date_exception')));

function post(url: string, body: unknown) {
  const u = new URL(`http://localhost${url}`);
  return Object.assign(
    new Request(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    { nextUrl: u },
  ) as never;
}

beforeAll(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'r4a3a@test.local', name: 'R4', passwordHash: 'x' }).returning();
  userId = user.id;
}, 180_000);

afterAll(async () => {
  for (const dir of [TEST_DIR, path.join(TEST_ROOT, 'ac-client'), path.join(TEST_ROOT, 'ac-accountant')]) {
    await closeDb(dir).catch(() => undefined);
  }
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold a handle; the next run wipes the dir first. */
  }
});

// ---------------------------------------------------------------------------
// A. 0059 and foreign-currency deposits
// ---------------------------------------------------------------------------
describe('A. 0059 on a foreign-currency deposit', () => {
  it('leaves a EUR deposit alone, correct or not (only home-currency deposits are re-derived)', async () => {
    const ctx = await newCompany(db, 'R4 FX Deposit Co');
    const id = await codesOf(ctx);
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.25' });
    const eurBank = (await createAccount(ctx, { code: '1025', name: 'Euro Bank', type: 'asset', subtype: 'checking' })).id;
    await setAccountCurrency(ctx, eurBank, 'EUR');

    // EUR 100 owner contribution (3000) + EUR 125 other income (4900) at 1.25:
    // the entry credits USD 125.00 (3000) and USD 156.25 (4900).
    const dep: any = await createDeposit(ctx, {
      depositAccountId: eurBank,
      date: d('2026-02-10'),
      paymentIds: [],
      exchangeRate: '1.25',
      extraLines: [
        { accountId: id('3000'), amount: '100.00' },
        { accountId: id('4900'), amount: '125.00' },
      ],
    } as never);
    const depId: string = dep.id ?? dep.deposit.id;
    const lineCodes = async () => {
      const rows = await db.select().from(depositLines).where(eq(depositLines.depositId, depId));
      return rows
        .map((l) => ({ amt: l.amount, acct: l.accountId === id('3000') ? '3000' : l.accountId === id('4900') ? '4900' : l.accountId }))
        .sort((a, b) => Number(a.amt) - Number(b.amt));
    };
    const run0059 = async () => {
      const res: any = await db.execute(sql.raw(migrationSql('0059_deposit_line_accounts.sql', 'UPDATE "deposit_lines"')));
      return Number(res.affectedRows ?? res.rowCount ?? 0);
    };
    const correct = [
      { amt: '100.00', acct: '3000' },
      { amt: '125.00', acct: '4900' },
    ];
    expect(await lineCodes()).toEqual(correct);
    expect(await run0059()).toBe(0);
    expect(await lineCodes()).toEqual(correct);
    // Even lines that look like 0037's damage are not re-derived from home amounts (ambiguous).
    await db.execute(sql`UPDATE deposit_lines SET account_id = ${id('3000')} WHERE deposit_id = ${depId}`);
    expect(await run0059()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// B. Credit application dates
// ---------------------------------------------------------------------------
describe("B. applying credits in an Accountant's Copy (end to end)", () => {
  const CLIENT_DIR = path.join(TEST_ROOT, 'ac-client');
  const ACCT_DIR = path.join(TEST_ROOT, 'ac-accountant');
  let ctx: ServiceContext;
  let actx: ServiceContext;
  const R: Record<string, string> = {};

  beforeAll(async () => {
    const cdb = await getDb(CLIENT_DIR);
    await cdb.insert(users).values({ id: userId, email: 'r4a3a@test.local', name: 'R4', passwordHash: 'x' });
    ctx = await newCompany(cdb, 'R4 Acct Copy Co');
    const id = await codesOf(ctx);
    const [cust] = await cdb.insert(customers).values({ companyId: ctx.companyId, displayName: 'Copy Cust' }).returning();
    R.cust = cust.id;
    const line = (amt: string) => [{ accountId: id('4000'), description: 'Work', quantity: 1, rate: amt, taxable: false }];
    const inv = async (amt: string, day: string) =>
      ((await createInvoice(ctx, { customerId: R.cust, date: d(day), taxRateId: null, lines: line(amt) } as never)) as any).id as string;
    const memo = async (amt: string, day: string) =>
      ((await createCreditMemo(ctx, { customerId: R.cust, date: d(day), taxRateId: null, lines: line(amt) } as never)) as any).id as string;
    R.invA = await inv('100.00', '2026-03-05');
    R.invB = await inv('70.00', '2026-03-06');
    R.invC = await inv('50.00', '2026-03-07');
    R.memo1 = await memo('40.00', '2026-03-15');
    R.memo2 = await memo('30.00', '2026-03-20');
    R.badDebt = (await createAccount(ctx, { code: '6990', name: 'Bad Debt', type: 'expense', subtype: 'operating_expenses' })).id;

    const transfer = (await createAccountantCopy(ctx, { dividingDate: '2026-03-31', dataDir: CLIENT_DIR })).buffer;
    await openAccountantCopyFile(transfer, ACCT_DIR);
    actx = { db: await getDb(ACCT_DIR), companyId: ctx.companyId, userId };
  }, 240_000);

  it('Apply (no date, as the credit memo page sends it) is dated on the later document', async () => {
    await applyToInvoice(actx, { creditMemoId: R.memo1, invoiceId: R.invA, amount: '40.00' });
    const [app] = await actx.db.select().from(creditApplications).where(eq(creditApplications.creditMemoId, R.memo1));
    expect(ymd(app.date)).toBe('2026-03-15');
  });

  it('Write Off Invoices dates the application with the write-off', async () => {
    await writeOffInvoices(actx, { invoiceIds: [R.invB], date: d('2026-03-31'), badDebtAccountId: R.badDebt });
    const [app] = await actx.db.select().from(creditApplications).where(eq(creditApplications.invoiceId, R.invB));
    expect(ymd(app.date)).toBe('2026-03-31');
  });

  it('a date after the dividing date is still refused in the copy', async () => {
    await expect(
      applyToInvoice(actx, { creditMemoId: R.memo2, invoiceId: R.invC, amount: '1.00', date: d('2026-04-02') }),
    ).rejects.toThrow(/dividing date/);
  });

  it('Client Data Review auto-apply works in the copy', async () => {
    await expect(autoApplyCustomerCredit(actx, { refType: 'credit_memo', refId: R.memo2 })).resolves.toEqual({
      applied: '30.00',
      invoices: 1,
    });
  });

  it("the client imports the accountant's applications", async () => {
    const changes = (await exportChangesFile(actx, {})).buffer;
    await importChangesFile(ctx, changes);
    const bal = async (inv: string) =>
      (await ctx.db.select({ b: invoices.balanceDue }).from(invoices).where(eq(invoices.id, inv)))[0].b;
    expect(await bal(R.invA)).toBe('30.00');
    expect(await bal(R.invB)).toBe('0.00');
    expect(await bal(R.invC)).toBe('50.00');
  });
});

describe('B2. credit application date in an ordinary file', () => {
  let ctx: ServiceContext;
  const R: Record<string, string> = {};

  beforeAll(async () => {
    ctx = await newCompany(db, 'R4 Closed Period Co');
    routeCtx = ctx;
    const id = await codesOf(ctx);
    const [cust] = await db.insert(customers).values({ companyId: ctx.companyId, displayName: 'Closed Cust' }).returning();
    const line = (amt: string) => [{ accountId: id('4000'), description: 'Work', quantity: 1, rate: amt, taxable: false }];
    R.inv = ((await createInvoice(ctx, { customerId: cust.id, date: d('2026-02-05'), taxRateId: null, lines: line('100.00') } as never)) as any).id;
    R.memo = ((await createCreditMemo(ctx, { customerId: cust.id, date: d('2026-02-10'), taxRateId: null, lines: line('60.00') } as never)) as any).id;
    await setClosingDate(ctx, '2026-02-28');
  });

  it('both documents in a closed period: without a date it is applied today, as before', async () => {
    const res = await creditMemoPOST(post(`/api/credit-memos/${R.memo}`, { action: 'apply', invoiceId: R.inv, amount: '10.00' }), {
      params: Promise.resolve({ id: R.memo }),
    } as never);
    expect(res.status).toBe(200);
    const [app] = await db.select().from(creditApplications).where(eq(creditApplications.creditMemoId, R.memo));
    expect(ymd(app.date)).toBe(ymd(new Date()));
  });

  it('the route passes a date: checked against the closing date, and validated', async () => {
    const call = (body: Record<string, unknown>) =>
      creditMemoPOST(post(`/api/credit-memos/${R.memo}`, { action: 'apply', invoiceId: R.inv, amount: '10.00', ...body }), {
        params: Promise.resolve({ id: R.memo }),
      } as never);
    expect((await call({ date: '2026-02-20' })).status).toBe(400); // PERIOD_CLOSED
    expect((await call({ date: '2026-02-30' })).status).toBe(400); // not a real day
    const ok = await call({ date: '2026-03-02' });
    expect(ok.status).toBe(200);
    const apps = await db.select().from(creditApplications).where(eq(creditApplications.creditMemoId, R.memo));
    expect(apps.map((a) => ymd(a.date))).toContain('2026-03-02');
  });
});

// ---------------------------------------------------------------------------
// C. Closing Date Exception for vendor credit (un)applications
// ---------------------------------------------------------------------------
describe('C. vendor credit apply / unapply with the closing-date password', () => {
  it('both are listed on the Closing Date Exception report', async () => {
    const ctx = await newCompany(db, 'R4 VC Closing Co');
    const [v] = await db.insert(vendors).values({ companyId: ctx.companyId, displayName: 'Closing Vend' }).returning();
    const expense = (await db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.type, 'expense'))))[0].id;
    const bill: any = await createBill(ctx, { vendorId: v.id, date: d('2026-02-05'), lines: [{ accountId: expense, amount: '100.00' }] } as never);
    const vc: any = await createVendorCredit(ctx, { vendorId: v.id, date: d('2026-02-06'), lines: [{ accountId: expense, amount: '30.00' }] } as never);
    await setClosingDate(ctx, '2026-02-28');

    // Without the password the dated application is refused ...
    await expect(
      applyToBill(ctx, { vendorCreditId: vc.id, billId: bill.id, amount: '10.00', date: d('2026-02-20') }),
    ).rejects.toThrow(/closed through/);
    expect(await exceptionsOf(ctx)).toHaveLength(0);
    // ... with it, it goes through and is listed.
    const pw = { ...ctx, closingDateOverride: true };
    await applyToBill(pw, { vendorCreditId: vc.id, billId: bill.id, amount: '10.00', date: d('2026-02-20') });
    await unapplyFromBill(pw, { vendorCreditId: vc.id, billId: bill.id, amount: '10.00', date: d('2026-02-25') });
    const ops = (await exceptionsOf(ctx)).map((r) => {
      const v = r.newValues as { operation: string; transactionDate: string };
      return `${v.operation} ${v.transactionDate}`;
    });
    expect(ops.sort()).toEqual(['apply 2026-02-20', 'unapply 2026-02-25']);
  });
});

// ---------------------------------------------------------------------------
// D. Lock taken over while open
// ---------------------------------------------------------------------------
describe('D. lock taken over while this process still has the file open', () => {
  const takeOver = (dir: string) =>
    fs.writeFileSync(
      path.join(dir, LOCK_FILE),
      JSON.stringify({ pid: 4242, hostname: 'OTHER-PC', startedAt: 'x', heartbeatAt: 'x' }),
    );

  it('heartbeat: the handle dies, getDb throws CompanyFileInUseError, statements are refused', async () => {
    const dir = path.join(TEST_ROOT, 'takeover-heartbeat');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let dead: DB | null = null;
    try {
      dead = await getDb(dir);
      expect(holdsDirLock(path.resolve(dir))).toBe(true);
      // The laptop slept > 2 minutes: another PC judged the lock stale and took it over.
      takeOver(dir);
      vi.advanceTimersByTime(HEARTBEAT_MS + 10);
      expect(holdsDirLock(path.resolve(dir))).toBe(false);
      await expect(getDb(dir)).rejects.toBeInstanceOf(CompanyFileInUseError);
      await expect(getDb(dir)).rejects.toThrow(/open on OTHER-PC/);
      await expect(dead.select().from(users)).rejects.toBeInstanceOf(CompanyFileInUseError);
      await expect(dead.transaction(async (tx) => tx.select().from(users))).rejects.toBeInstanceOf(CompanyFileInUseError);
      // The other computer's lock is left alone.
      expect(JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE), 'utf8')).hostname).toBe('OTHER-PC');
    } finally {
      vi.useRealTimers();
      await (dead as unknown as { $client?: { close(): Promise<void> } } | null)?.$client?.close().catch(() => undefined);
    }
  });

  it('commit: a transaction in flight when the lock is taken over is rolled back', async () => {
    const dir = path.join(TEST_ROOT, 'takeover-commit');
    const ldb = await getDb(dir);
    try {
      const [u] = await ldb.insert(users).values({ email: 'before@test.local', name: 'Before', passwordHash: 'x' }).returning();
      expect(u.id).toBeTruthy();
      await expect(
        ldb.transaction(async (tx) => {
          await tx.insert(users).values({ email: 'inflight@test.local', name: 'In flight', passwordHash: 'x' });
          takeOver(dir); // no heartbeat needed: the commit re-checks the lock
        }),
      ).rejects.toBeInstanceOf(CompanyFileInUseError);
      await expect(getDb(dir)).rejects.toBeInstanceOf(CompanyFileInUseError);
      // Verify with the dead handle's own engine (closing it below): the in-flight row never committed.
      const client = (ldb as unknown as { $client: { close(): Promise<void> } }).$client;
      await client.close();
      fs.rmSync(path.join(dir, LOCK_FILE), { force: true }); // the other PC closed the file
      const reopened = await getDb(dir);
      const rows = await reopened.select({ email: users.email }).from(users);
      expect(rows.map((r) => r.email).sort()).toEqual(['before@test.local']);
    } finally {
      await closeDb(dir).catch(() => undefined);
    }
  });

  it('a normal open / close cycle is unaffected', async () => {
    const dir = path.join(TEST_ROOT, 'takeover-none');
    const ndb = await getDb(dir);
    await ndb.transaction(async (tx) => tx.insert(users).values({ email: 'n@test.local', name: 'N', passwordHash: 'x' }));
    await closeDb(dir);
    expect(fs.existsSync(path.join(dir, LOCK_FILE))).toBe(false);
  });
});
