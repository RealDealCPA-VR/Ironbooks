/**
 * Team salesar — the remaining sales review leftovers, each reproduced first:
 *  1. Pay Sales Tax's default "due through" (the last complete filing period) is taken on the
 *     company's calendar: a current instant in the evening west of UTC was read as the next UTC
 *     month, so the period still running was offered.
 *  2. The Customer balance summary (GET /api/customers?balanceSummary=true) totals every customer
 *     in the home currency: foreign invoices and foreign unapplied payments at their home value.
 *  3. Credit memos accept a class and a Customer:Job through the API (the route dropped them).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany, updateCompany } from './company';
import { createCustomer, customerBalanceSummary } from './customers';
import { createInvoice } from './invoices';
import { receivePayment } from './payments';
import { setBaseCurrency, upsertCurrency } from './currencies';
import { paySalesTaxScreen } from './liabilityPayments';
import { getCreditMemo } from './creditMemos';
import { createJob } from './jobs';
import { createClass } from './dimensions';

let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));
import { POST as creditMemosPOST } from '@/app/api/credit-memos/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-salesar-leftovers2');
let db: DB;
let userId: string;
let ctx: ServiceContext;
let acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function req(url: string, body?: unknown) {
  const u = new URL(`http://localhost${url}`);
  return Object.assign(
    new Request(u, body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    { nextUrl: u },
  ) as never;
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'salesar-left2@test.local', name: 'Salesar', passwordHash: 'x' }).returning();
  userId = u.id;
});

beforeEach(async () => {
  seq += 1;
  const company = await createCompany(db, { name: `Salesar L2 ${seq}`, ownerId: userId });
  ctx = { db, companyId: company.id, userId };
  routeCtx = ctx;
  acct = {};
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold a handle; the next run wipes it. */
  }
});

describe('1. Pay Sales Tax: the default due-through date is on the company calendar', () => {
  it('10:30 PM on Sep 30 in Los Angeles offers the quarter that has ended (Apr - Jun)', async () => {
    await updateCompany(ctx, { settings: { timezone: 'America/Los_Angeles', salesTaxFrequency: 'quarterly' } as never });
    const prevTz = process.env.TZ;
    process.env.TZ = 'UTC'; // the machine's clock says Oct 1 already
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-01T05:30:00.000Z'));
      const screen = await paySalesTaxScreen(ctx);
      expect(screen.dueThrough).toBe('2026-06-30');
    } finally {
      vi.useRealTimers();
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  });

  it('a "today" given as the current instant is read on the company calendar, not as a UTC day', async () => {
    await updateCompany(ctx, { settings: { timezone: 'America/New_York', salesTaxFrequency: 'monthly' } as never });
    // 9:30 PM on Oct 31 in New York is Nov 1 in UTC.
    const screen = await paySalesTaxScreen(ctx, { today: new Date('2026-11-01T01:30:00.000Z') });
    expect(screen.dueThrough).toBe('2026-09-30');
  });
});

describe('2. Customer balance summary in the home currency', () => {
  it('adds a foreign invoice and a foreign unapplied payment at their home value', async () => {
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.20' });
    const euro = (await createCustomer(ctx, { displayName: `Euro ${seq}`, currency: 'EUR' } as never)).id;
    const home = (await createCustomer(ctx, { displayName: `Home ${seq}` } as never)).id;
    await createInvoice(ctx, {
      customerId: euro,
      date: d('2026-03-01'),
      currency: 'EUR',
      exchangeRate: '1.10',
      taxRateId: null,
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '100.00', taxable: false }],
    } as never);
    await createInvoice(ctx, {
      customerId: home,
      date: d('2026-03-01'),
      taxRateId: null,
      lines: [{ accountId: acct['4000'], quantity: 1, rate: '30.00', taxable: false }],
    } as never);
    const [euroBank] = await db
      .insert(accounts)
      .values({ companyId: ctx.companyId, code: '1021', name: `Euro bank ${seq}`, type: 'asset' as never, subtype: 'checking', currency: 'EUR' })
      .returning();
    // EUR 20 received and not applied: a credit worth USD 25.00 at 1.25.
    await receivePayment(ctx, {
      customerId: euro,
      date: d('2026-03-05'),
      amount: '20.00',
      method: 'ach',
      depositAccountId: euroBank.id,
      currency: 'EUR',
      exchangeRate: '1.25',
      applications: [],
    } as never);
    const rows = await customerBalanceSummary(ctx);
    const byId = new Map(rows.map((r) => [r.customerId, r.totalBalanceDue]));
    expect(byId.get(euro)).toBe('85.00'); // 110.00 - 25.00
    expect(byId.get(home)).toBe('30.00');
  });
});

describe('3. Credit memos through the API keep their class and job', () => {
  it('POST /api/credit-memos saves the class and Customer:Job of the memo and its lines', async () => {
    const cust = (await createCustomer(ctx, { displayName: `Job owner ${seq}` } as never)).id;
    const job = await createJob(ctx, { name: `Kitchen ${seq}`, customerId: cust } as never);
    const cls = await createClass(ctx, { name: `East ${seq}` } as never);
    const res = await creditMemosPOST(
      req('/api/credit-memos', {
        customerId: cust,
        date: '2026-03-10',
        classId: cls.id,
        jobId: job.id,
        lines: [{ accountId: acct['4000'], quantity: 1, rate: '40.00', taxable: false, classId: cls.id, jobId: job.id }],
      }),
    );
    expect(res.status).toBe(201);
    const memo = await getCreditMemo(ctx, ((await res.json()) as { id: string }).id);
    expect(memo.classId).toBe(cls.id);
    expect(memo.jobId).toBe(job.id);
    expect(memo.lines[0].classId).toBe(cls.id);
    expect(memo.lines[0].jobId).toBe(job.id);
  });
});
