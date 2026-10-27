/**
 * Security review round 5 — route-level regressions:
 *  1. POST /api/auth/2fa/setup replaced the secret of a user whose two-factor sign-in was ON:
 *     the person was locked out of their authenticator app, and a stolen session cookie could
 *     mint a fresh secret, make a valid code from it and switch 2FA off (/2fa/disable).
 *  2. Registers: Banking view opened EVERY account's register (payroll liabilities and wages by
 *     employee, A/R by customer, A/P by vendor, equity). The account's own area now applies.
 *  3. Doc Center: a document with a long file name (> ~218 characters) could not be stored
 *     (the on-disk name passed the 255-character limit → HTTP 500), and a stored MIME type that
 *     is not a valid header value made the download answer 500.
 *  4. Text longer than its column (a 300-character customer name) answered HTTP 500
 *     (Postgres 22001 was not translated); it is a plain 400 now.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (n: string) => (h.cookies.has(n) ? { name: n, value: h.cookies.get(n)! } : undefined),
  }),
  headers: async () => new Headers([...h.headers.entries()]),
}));

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-security');
process.env.BKA_DATA_DIR = TEST_DIR;
process.env.BKA_AUTH_SECRET = 'review5-security-secret';
delete process.env.BKA_INTERNAL_TOKEN;

import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, attachments, bankAccounts, employees, users } from '@/lib/db/schema';
import { createSessionToken, hashPassword, SESSION_COOKIE } from '@/lib/auth';
import { COMPANY_COOKIE } from '@/lib/context';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/routes';
import { fullAccess } from '@/lib/permissions/model';
import { generateSecret } from '@/lib/totp';
import { createCompany } from './company';
import { addUser } from './users';
import { POST as setup2faPOST } from '@/app/api/auth/2fa/setup/route';
import { GET as registersGET } from '@/app/api/registers/route';
import { GET as registerGET } from '@/app/api/registers/[accountId]/route';
import { POST as attachmentsPOST } from '@/app/api/attachments/route';
import { GET as attachmentGET } from '@/app/api/attachments/[id]/route';
import { POST as customersPOST } from '@/app/api/customers/route';
import { GET as transactionLogGET } from '@/app/api/transaction-log/route';
import { GET as w2GET } from '@/app/api/payroll/w2/route';
import { POST as importPOST } from '@/app/api/import/route';
import { POST as csvPreviewPOST } from '@/app/api/import/csv-preview/route';
import { POST as portalLoginPOST } from '@/app/api/portal/login/route';
import { POST as workersCompPOST } from '@/app/api/payroll/workers-comp/route';
import { POST as stateSettingsPOST } from '@/app/api/payroll/state-settings/route';
import { createVendor } from './vendors';
import { createCustomer } from './customers';
import { createEstimate } from './estimates';
import { createPurchaseOrder } from './purchaseOrders';
import { GET as searchGET } from '@/app/api/search/route';
import { POST as errorApplyPOST } from '@/app/api/errors/[id]/apply/route';
import { POST as mergePOST } from '@/app/api/merge/route';
import { POST as refundsPrintPOST } from '@/app/api/print-queue/refunds/route';
import { POST as statementEmailPOST } from '@/app/api/sales-forms/statement-email/route';

let db: DB;
let owner: string;
let clerk: string;
let companyId: string;
let bankId: string;
let liabilityId: string;
let arId: string;

function as(userId: string, method: string, routePath: string) {
  h.headers.clear();
  h.headers.set(ROUTE_PATH_HEADER, routePath);
  h.headers.set(ROUTE_METHOD_HEADER, method);
  h.cookies.clear();
  h.cookies.set(SESSION_COOKIE, createSessionToken(userId));
  h.cookies.set(COMPANY_COOKIE, companyId);
}
function req(method: string, url: string, body?: unknown) {
  return new NextRequest(`http://127.0.0.1${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [u] = await db
    .insert(users)
    .values({ email: 'owner@review5.local', name: 'Owner', passwordHash: await hashPassword('ownerPass123') })
    .returning();
  owner = u.id;
  companyId = (await createCompany(db, { name: 'Review5 Security Co', ownerId: owner })).id;
  const ownerCtx = { db, companyId, userId: owner, access: fullAccess(), role: 'owner' as const };
  clerk = (await addUser(ownerCtx, { name: 'AR Clerk', login: 'arclerk', password: 'clerkPass123', roleKeys: ['ar_clerk'] })).userId;
  const all = await db.select().from(accounts).where(eq(accounts.companyId, companyId));
  bankId = all.find((a) => a.type === 'asset' && a.subtype === 'checking')!.id;
  arId = all.find((a) => a.subtype === 'accounts_receivable')!.id;
  liabilityId = all.find((a) => a.type === 'liability' && a.subtype !== 'accounts_payable' && a.subtype !== 'credit_card')!.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('review5: two-factor setup never replaces a live secret', () => {
  it('refuses setup while 2FA is on and keeps the secret', async () => {
    const live = generateSecret();
    await db.update(users).set({ totpSecret: live, totpEnabled: true }).where(eq(users.id, owner));
    as(owner, 'POST', '/api/auth/2fa/setup');
    const res = await setup2faPOST();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.secret).toBeUndefined();
    const [row] = await db.select().from(users).where(eq(users.id, owner));
    expect(row.totpSecret).toBe(live);
    expect(row.totpEnabled).toBe(true);
  });

  it('still sets up a new authenticator while 2FA is off', async () => {
    await db.update(users).set({ totpSecret: null, totpEnabled: false }).where(eq(users.id, owner));
    as(owner, 'POST', '/api/auth/2fa/setup');
    const res = await setup2faPOST();
    expect(res.status).toBe(200);
    const body = await res.json();
    const [row] = await db.select().from(users).where(eq(users.id, owner));
    expect(row.totpSecret).toBe(body.secret);
    expect(row.totpEnabled).toBe(false);
  });
});

describe('review5: a register needs the area of its account, not just Banking', () => {
  it('an A/R clerk (Banking view, no Sensitive Accounting) sees bank and A/R registers only', async () => {
    as(clerk, 'GET', '/api/registers');
    const res = await registersGET();
    expect(res.status).toBe(200);
    const ids = ((await res.json()).accounts as { id: string }[]).map((a) => a.id);
    expect(ids).toContain(bankId);
    expect(ids).toContain(arId);
    expect(ids).not.toContain(liabilityId);
  });

  it('opening a liability register by id is refused for the clerk, allowed for the owner', async () => {
    as(clerk, 'GET', `/api/registers/${liabilityId}`);
    const denied = await registerGET(req('GET', `/api/registers/${liabilityId}`), params({ accountId: liabilityId }));
    expect(denied.status).toBe(403);
    as(clerk, 'GET', `/api/registers/${bankId}`);
    const bank = await registerGET(req('GET', `/api/registers/${bankId}`), params({ accountId: bankId }));
    expect(bank.status).toBe(200);
    as(owner, 'GET', `/api/registers/${liabilityId}`);
    const ok = await registerGET(req('GET', `/api/registers/${liabilityId}`), params({ accountId: liabilityId }));
    expect(ok.status).toBe(200);
  });
});

describe('review5: Doc Center file names and types', () => {
  it('stores and serves a document with a very long file name', async () => {
    const filename = `${'Bank statement for checking account ending 4321 '.repeat(5)}.pdf`.slice(-250);
    as(owner, 'POST', '/api/attachments');
    const res = await attachmentsPOST(
      req('POST', '/api/attachments', { filename, mimeType: 'application/pdf', base64: Buffer.from('%PDF-1.4 test').toString('base64') }),
    );
    expect(res.status).toBe(201);
    const row = await res.json();
    expect(row.filename).toBe(filename);
    expect(path.basename(row.storagePath).length).toBeLessThanOrEqual(200);
    expect(row.storagePath.endsWith('.pdf')).toBe(true);
    as(owner, 'GET', `/api/attachments/${row.id}`);
    const dl = await attachmentGET(req('GET', `/api/attachments/${row.id}`), params({ id: row.id }));
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).toString()).toBe('%PDF-1.4 test');
  });

  it('a stored MIME type that is not a valid header value downloads as a plain file', async () => {
    as(owner, 'POST', '/api/attachments');
    const res = await attachmentsPOST(
      req('POST', '/api/attachments', { filename: 'note.txt', mimeType: 'text/plain', base64: Buffer.from('hello').toString('base64') }),
    );
    const row = await res.json();
    // e.g. a row restored from a crafted backup.
    await db.update(attachments).set({ mimeType: 'text/html\r\nX-Injected: 1' }).where(and(eq(attachments.id, row.id)));
    as(owner, 'GET', `/api/attachments/${row.id}`);
    const dl = await attachmentGET(req('GET', `/api/attachments/${row.id}?inline=1`), params({ id: row.id }));
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('application/octet-stream');
    expect(dl.headers.get('x-injected')).toBeNull();
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment;/);
  });
});

describe('review5: the transaction log masks sensitive fields like the audit trail', () => {
  it('a Banking user (financial reports, no sensitive-data rights) sees a vendor tax id masked', async () => {
    const ownerCtx = { db, companyId, userId: owner, access: fullAccess(), role: 'owner' as const };
    const banker = (await addUser(ownerCtx, { name: 'Banker', login: 'banker', password: 'bankerPass123', roleKeys: ['banking'] })).userId;
    await createVendor(ownerCtx, { displayName: 'Solo Contractor', taxId: '123-45-6789', accountNumber: '000987654321' } as never);
    as(banker, 'GET', '/api/transaction-log');
    const res = await transactionLogGET(req('GET', '/api/transaction-log?entityType=vendor'));
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('Solo Contractor');
    expect(text).not.toContain('123-45-6789');
    expect(text).not.toContain('000987654321');
    expect(text).toContain('***-**-6789');
    // The owner (all sensitive-data rights) still sees the full values.
    as(owner, 'GET', '/api/transaction-log');
    const full = JSON.stringify(await (await transactionLogGET(req('GET', '/api/transaction-log?entityType=vendor'))).json());
    expect(full).toContain('123-45-6789');
  });
});

describe('review5: payroll PDF downloads with names that are not plain ASCII', () => {
  it('a W-2 for "Seán O’Brien" (typographic apostrophe, e.g. imported from QuickBooks) is served', async () => {
    const [emp] = await db.insert(employees).values({ companyId, firstName: 'Seán', lastName: 'O’Brien' }).returning();
    as(owner, 'GET', '/api/payroll/w2');
    const res = await w2GET(req('GET', `/api/payroll/w2?employeeId=${emp.id}&year=2026`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^inline; filename="W2_O_Brien_Se_n_2026\.pdf"$/);
  });
});

describe('review5: importing a bank statement is Banking, not File Utilities', () => {
  it('a Bookkeeper can preview and import a CSV statement into a bank feed; a View-Only user cannot', async () => {
    const ownerCtx = { db, companyId, userId: owner, access: fullAccess(), role: 'owner' as const };
    const keeper = (await addUser(ownerCtx, { name: 'Keeper', login: 'keeper', password: 'keeperPass123', roleKeys: ['bookkeeper'] })).userId;
    const viewer = (await addUser(ownerCtx, { name: 'Viewer', login: 'viewer5', password: 'viewerPass123', roleKeys: ['view_only'] })).userId;
    const [bank] = await db.insert(bankAccounts).values({ companyId, accountId: bankId, bankName: 'First Bank', accountNumber: '111222333' }).returning();
    const content = 'Date,Description,Amount\n2026-03-01,Coffee,-4.50\n2026-03-02,Deposit,100.00\n';
    const csvMapping = { dateCol: 'Date', descriptionCol: 'Description', amountCol: 'Amount' };
    as(keeper, 'POST', '/api/import/csv-preview');
    const preview = await csvPreviewPOST(req('POST', '/api/import/csv-preview', { content, csvMapping }));
    expect(preview.status).toBe(200);
    as(keeper, 'POST', '/api/import');
    const imported = await importPOST(req('POST', '/api/import', { bankAccountId: bank.id, fileType: 'csv', content, csvMapping }));
    expect(imported.status).toBe(201);
    expect((await imported.json()).imported).toBe(2);
    as(viewer, 'POST', '/api/import');
    const refused = await importPOST(req('POST', '/api/import', { bankAccountId: bank.id, fileType: 'csv', content, csvMapping }));
    expect(refused.status).toBe(403);
  });
});

describe('review5: employee portal sign-in', () => {
  it('works for an employee whose email was entered with capitals (stored as typed)', async () => {
    await db.insert(employees).values({
      companyId,
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'Jane.Doe@Acme.Example',
      portalPasswordHash: await hashPassword('portalPass123'),
    });
    h.headers.clear();
    h.cookies.clear();
    for (const typed of ['Jane.Doe@Acme.Example', 'jane.doe@acme.example']) {
      const res = await portalLoginPOST(req('POST', '/api/portal/login', { email: typed, password: 'portalPass123' }));
      expect(res.status, typed).toBe(200);
    }
    const wrong = await portalLoginPOST(req('POST', '/api/portal/login', { email: 'jane.doe@acme.example', password: 'nope-nope-1' }));
    expect(wrong.status).toBe(401);
  });
});

describe('review5: text longer than its column is a 400, not a 500', () => {
  it('a payroll rate that is not a number ("abc", "NaN") is refused, never a 500 or a NaN rate', async () => {
    for (const ratePer100 of ['abc', 'NaN', '3.4%']) {
      as(owner, 'POST', '/api/payroll/workers-comp');
      const res = await workersCompPOST(req('POST', '/api/payroll/workers-comp', { code: 'WC1', ratePer100 }));
      expect(res.status, ratePer100).toBe(400);
    }
    for (const suiRate of ['abc', 'NaN']) {
      as(owner, 'POST', '/api/payroll/state-settings');
      const res = await stateSettingsPOST(req('POST', '/api/payroll/state-settings', { state: 'CA', year: 2026, suiRate }));
      expect(res.status, suiRate).toBe(400);
    }
    as(owner, 'POST', '/api/payroll/workers-comp');
    const ok = await workersCompPOST(req('POST', '/api/payroll/workers-comp', { code: 'WC2', ratePer100: '1.25' }));
    expect(ok.status).toBe(201);
    // Any other route whose service meets an unparseable amount answers 400 too.
    const { routeError } = await import('@/lib/routeErrors');
    const { MoneyParseError } = await import('@/lib/money');
    expect(routeError(new MoneyParseError('abc'), 't').status).toBe(400);
  });

  it('a 300-character customer name', async () => {
    as(owner, 'POST', '/api/customers');
    const res = await customersPOST(req('POST', '/api/customers', { displayName: 'A'.repeat(300) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/too long/i);
  });
});

describe('review5: global search (Ctrl+K) shows the numbered sales and purchase forms', () => {
  it('an estimate and a purchase order found by their typed number, each only for people who may see it', async () => {
    const ownerCtx = { db, companyId, userId: owner, access: fullAccess(), role: 'owner' as const };
    const cust = await createCustomer(ownerCtx, { displayName: 'Search Customer' });
    const vend = await createVendor(ownerCtx, { displayName: 'Search Vendor' });
    const [expense] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, companyId), eq(accounts.type, 'expense')));
    await createEstimate(ownerCtx, {
      customerId: cust.id,
      date: new Date('2026-05-04T12:00:00Z'),
      refNumber: 'QX-5501',
      lines: [{ description: 'Quote', quantity: 1, rate: 10 }],
    });
    await createPurchaseOrder(ownerCtx, {
      vendorId: vend.id,
      date: new Date('2026-05-04T12:00:00Z'),
      refNumber: 'QX-5502',
      lines: [{ accountId: expense.id, quantity: 1, rate: 5 }],
    });
    const search = async (userId: string) => {
      as(userId, 'GET', '/api/search');
      const res = await searchGET(req('GET', '/api/search?q=QX-55'));
      expect(res.status).toBe(200);
      return ((await res.json()).results as { type: string; label: string }[]).map((r) => `${r.type}: ${r.label}`);
    };
    const mine = await search(owner);
    expect(mine).toContain('Estimate: Estimate #QX-5501');
    expect(mine).toContain('Purchase Order: Purchase Order #QX-5502');
    // The A/R clerk has Customers but not Vendors.
    const clerks = await search(clerk);
    expect(clerks).toContain('Estimate: Estimate #QX-5501');
    expect(clerks).not.toContain('Purchase Order: Purchase Order #QX-5502');
  });
});

describe('review5: a JSON null body is a 400, never a 500', () => {
  it('error apply, merge, refund check printing and statement email', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const nullBody = (url: string) =>
      new NextRequest(`http://127.0.0.1${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' });
    as(owner, 'POST', `/api/errors/${id}/apply`);
    expect((await errorApplyPOST(nullBody(`/api/errors/${id}/apply`), params({ id }))).status).toBe(400);
    as(owner, 'POST', '/api/merge');
    expect((await mergePOST(nullBody('/api/merge'))).status).toBe(400);
    as(owner, 'POST', '/api/print-queue/refunds');
    expect((await refundsPrintPOST(nullBody('/api/print-queue/refunds'))).status).toBe(400);
    as(owner, 'POST', '/api/sales-forms/statement-email');
    expect((await statementEmailPOST(nullBody('/api/sales-forms/statement-email'))).status).toBe(400);
  });
});
