/**
 * Feature round (team purchbank): route-level checks — the Quick Check PDF amount and the
 * permission a Loan Manager payment entered as a bill needs.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, users, vendors } from '@/lib/db/schema';
import { builtinRole, unionRoles } from '@/lib/permissions/model';
import { ServiceError, type ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { createLoan, setUpLoanPayment } from './loans';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { POST as checksPdfPOST } from '@/app/api/checks/pdf/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-purchbank-routes');
let db: DB;
let owner: ServiceContext;
const acct: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'purchbank-routes@test.local', name: 'PB', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Purchbank routes', ownerId: u.id });
  owner = { db, companyId: company.id, userId: u.id };
  ctx = owner;
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* best effort */
  }
});

describe('POST /api/checks/pdf — Quick Check', () => {
  const post = (body: Record<string, unknown>) =>
    checksPdfPOST(
      new Request('http://localhost/api/checks/pdf', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }) as never,
    );

  it('refuses an amount that is not money (it used to print "12abc" in words)', async () => {
    for (const amount of ['12abc', '1e3', '12.345', '-5.00', '0', 'twelve']) {
      const res = await post({ payee: 'Joe', amount, date: '2026-03-01' });
      expect(res.status, amount).toBe(400);
    }
  });

  it('prints a valid amount', async () => {
    const res = await post({ payee: 'Joe', amount: '1,234.50', date: '2026-03-01' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/pdf/);
    const ok = await post({ payee: 'Joe', amount: '12.5', date: '2026-03-01' });
    expect(ok.status).toBe(200);
  });
});

describe('Loan Manager payment entered as a bill', () => {
  it('needs the Vendors & Payables (A/P) permission, as Enter Bills does', async () => {
    ctx = owner;
    const [lender] = await db.insert(vendors).values({ companyId: owner.companyId, displayName: 'Lender Bank' }).returning();
    const liab = await createAccount(owner, { code: '2610', name: 'Truck Loan', type: 'liability' as never, subtype: 'long_term_liability' });
    const loan = await createLoan(owner, {
      name: 'Truck',
      lenderVendorId: lender.id,
      liabilityAccountId: liab.id,
      interestAccountId: acct['6300'] ?? Object.values(acct)[0],
      paymentAccountId: acct['1000'],
      originalAmount: '12000.00',
      annualRate: '6',
      termMonths: 24,
      originDate: d('2026-01-01'),
      firstPaymentDate: d('2026-02-01'),
    });
    // A Banking user (vendors: view only) may write the payment as a check, not enter it as a bill.
    const banking: ServiceContext = { ...owner, access: unionRoles([builtinRole('banking')!]) };
    const err = await setUpLoanPayment(banking, loan.id, { kind: 'bill' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('FORBIDDEN');
    const chk = await setUpLoanPayment(banking, loan.id, { kind: 'check' });
    expect(chk.kind).toBe('check');
    // An A/P clerk may enter it as a bill.
    const ap: ServiceContext = { ...owner, access: unionRoles([builtinRole('ap_clerk')!]) };
    const bill = await setUpLoanPayment(ap, loan.id, { kind: 'bill' });
    expect(bill.kind).toBe('bill');
  });
});
