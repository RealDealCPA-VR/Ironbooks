/**
 * Security review 2.2: the Audit Trail and the transaction log showed pay rates, W-4 data and home
 * addresses to roles with no payroll access (a Bookkeeper, "No payroll", could read every
 * employee's pay through GET /api/audit-trail?entityType=employee).
 *
 * Entries now need the right to view the record they are about (lib/services/auditVisibility.ts):
 * hidden rows are left out of the rows, the totals, the filter lists, the CSV export and the raw
 * download; one asked for by id is "not found". Admins see everything, as before, and the log's
 * integrity check still covers the whole log.
 *
 * Review correction: a role that may run the reports covering a record (the Reports Only role, a
 * Payroll Processor's payroll reports) reads its entries too — those reports show the records
 * already. Users, roles, sign-in and file security have no such report: Admins only.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { getDb, closeDb, type DB } from '@/lib/db';
import { auditLogs, users } from '@/lib/db/schema';
import { hashPassword } from '@/lib/auth';
import { writeAudit, type ServiceContext } from './_base';
import { legacyRoleFor } from '@/lib/permissions/model';
import { resolveAccess } from './access';
import { addUser } from './users';
import { createCompany } from './company';
import { createEmployee, updateEmployee } from './payroll';
import { createCustomer } from './customers';
import { addNote } from './lists/notes';
import { getAuditLog, listAuditLogs } from './auditTrail';
import { canSeeAuditEntry, canSeeLogRecord, knownAuditEntityTypes } from './auditVisibility';
import { prepareRawLogDownload, streamTransactionLogCsv } from './transactionLogExport';
import { queryTransactionLog, readAllTransactionLog } from './transactionLog';

let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));
import { GET as auditGET } from '@/app/api/audit-trail/route';
import { GET as auditOneGET } from '@/app/api/audit-trail/[id]/route';
import { GET as logGET } from '@/app/api/transaction-log/route';
import { GET as verifyGET } from '@/app/api/transaction-log/verify/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-security1-audit-visibility');
let db: DB;
let admin: ServiceContext;
let bookkeeper: ServiceContext;
let accountant: ServiceContext;
let reportsOnly: ServiceContext;
let payrollProcessor: ServiceContext;
let employeeId: string;
let customerId: string;

async function ctxFor(userId: string, companyId: string): Promise<ServiceContext> {
  const r = await resolveAccess(db, companyId, userId);
  // Shaped like getServerContext (the legacy role too, which the log routes still read).
  return { db, companyId, userId, access: r.access, role: legacyRoleFor(r.access, r.isOwner) };
}

const get = (url: string) => new NextRequest(`http://127.0.0.1${url}`);

async function readStream(s: ReadableStream<Uint8Array>): Promise<string> {
  const reader = s.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

describe('audit trail and transaction log hide what the reader may not view (security 2.2)', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [owner] = await db
      .insert(users)
      .values({ email: 'owner@av.local', name: 'Owner', passwordHash: await hashPassword('ownerpass1') })
      .returning();
    const companyId = (await createCompany(db, { name: 'Visibility Co', ownerId: owner.id })).id;
    admin = await ctxFor(owner.id, companyId);
    const bk = await addUser(admin, { name: 'Bea Bookkeeper', login: 'bk@av.local', password: 'bkpass1234', roleKeys: ['bookkeeper'] });
    const acc = await addUser(admin, { name: 'Al Accountant', login: 'acc@av.local', password: 'accpass123', roleKeys: ['accountant'] });
    const ro = await addUser(admin, { name: 'Rita Reports', login: 'ro@av.local', password: 'ropass1234', roleKeys: ['reports_only'] });
    const pp = await addUser(admin, { name: 'Paul Payroll', login: 'pp@av.local', password: 'pppass1234', roleKeys: ['payroll_processor'] });
    bookkeeper = await ctxFor(bk.userId, companyId);
    accountant = await ctxFor(acc.userId, companyId);
    reportsOnly = await ctxFor(ro.userId, companyId);
    payrollProcessor = await ctxFor(pp.userId, companyId);

    // Payroll data in the snapshots: pay rate, W-4, home address.
    const emp = await createEmployee(admin, { firstName: 'Pat', lastName: 'Payroll', payType: 'salary', payRate: '98765.43' } as never);
    employeeId = emp.id;
    await updateEmployee(admin, employeeId, {
      payRate: '123456.78',
      address: { line1: '1 Secret Lane', city: 'Hidden', state: 'NY', zip: '10001' },
      w4: { filingStatus: 'single', extraWithholding: '55.00' },
    } as never);
    const cust = await createCustomer(admin, { displayName: 'Cora Customer' } as never);
    customerId = cust.id;
    await addNote(admin, { entityType: 'employee', entityId: employeeId, body: 'Raise to 123k approved' });
    await addNote(admin, { entityType: 'customer', entityId: customerId, body: 'Prefers email' });
    // A paycheck, an invoice, a role and a sign-in session (written as the services do).
    await writeAudit(admin, { action: 'void', entityType: 'paycheck', entityId: employeeId, oldValues: { netPay: '4321.09', payeeName: 'Pat Payroll' } });
    await writeAudit(admin, { action: 'void', entityType: 'invoice', entityId: customerId, oldValues: { invoiceNumber: 'INV-55', total: '150.00' } });
    await writeAudit(admin, { action: 'create', entityType: 'role', entityId: customerId, newValues: { name: 'Payroll helper' } });
    await writeAudit(admin, { action: 'delete', entityType: 'user_session', entityId: customerId, oldValues: { remoteAddr: '100.64.0.7' } });
    // A kind nothing maps (written by a later version, say): Admins only.
    await db.insert(auditLogs).values({ companyId, userId: owner.id, action: 'update', entityType: 'mystery_kind', entityId: customerId, newValues: { secret: 1 } });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  const allRows = () => db.select().from(auditLogs).where(eq(auditLogs.companyId, admin.companyId));

  it('a Bookkeeper gets no employee rows, even when asking for them', async () => {
    expect(await listAuditLogs(bookkeeper, { entityType: 'employee', limit: 200 })).toEqual({ rows: [], total: 0 });
    routeCtx = bookkeeper;
    const res = await auditGET(get('/api/audit-trail?entityType=employee'));
    expect(await res.json()).toEqual({ rows: [], total: 0 });
  });

  it("the Bookkeeper's list and total agree and leave out payroll, users, payroll notes and unknown kinds", async () => {
    const { rows, total } = await listAuditLogs(bookkeeper, { limit: 200 });
    expect(total).toBe(rows.length);
    const kinds = new Set(rows.map((r) => r.entityType));
    expect(kinds.has('employee')).toBe(false);
    expect(kinds.has('paycheck')).toBe(false);
    expect(kinds.has('user')).toBe(false);
    expect(kinds.has('role')).toBe(false);
    expect(kinds.has('user_session')).toBe(false);
    expect(kinds.has('mystery_kind')).toBe(false);
    expect(kinds.has('customer')).toBe(true);
    expect(kinds.has('invoice')).toBe(true);
    // Of the two notes, only the one on the customer.
    const notes = (await allRows()).filter((r) => r.entityType === 'note');
    expect(notes).toHaveLength(2);
    const shownNotes = rows.filter((r) => r.entityType === 'note');
    expect(shownNotes).toHaveLength(1);
    expect((notes.find((n) => n.id === shownNotes[0].id)!.newValues as { entityType: string }).entityType).toBe('customer');
    // Paging reports the same total.
    expect((await listAuditLogs(bookkeeper, { limit: 1, offset: 0 })).total).toBe(total);
    // Exactly the rows the rule allows (the SQL and the JS rule agree).
    const expected = (await allRows()).filter((r) => canSeeAuditEntry(bookkeeper.access, r.entityType, r.oldValues, r.newValues));
    expect(total).toBe(expected.length);
  });

  it('an employee entry asked for by id is "not found" for the Bookkeeper', async () => {
    const [empRow] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, admin.companyId), eq(auditLogs.entityType, 'employee')))
      .limit(1);
    await expect(getAuditLog(bookkeeper, empRow.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    routeCtx = bookkeeper;
    expect((await auditOneGET(get(`/api/audit-trail/${empRow.id}`), { params: Promise.resolve({ id: empRow.id }) })).status).toBe(404);
    // A customer entry still opens.
    const [custRow] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, admin.companyId), eq(auditLogs.entityType, 'customer')))
      .limit(1);
    expect((await getAuditLog(bookkeeper, custRow.id)).entityType).toBe('customer');
  });

  it('Reports Only reads what its reports cover (payroll included), nothing about users or roles', async () => {
    const { rows, total } = await listAuditLogs(reportsOnly, { limit: 500 });
    expect(total).toBe(rows.length);
    const kinds = new Set(rows.map((r) => r.entityType));
    for (const k of ['employee', 'paycheck', 'customer', 'invoice', 'note']) expect(kinds.has(k), k).toBe(true);
    for (const k of ['user', 'user_company', 'role', 'user_session', 'mystery_kind']) expect(kinds.has(k), k).toBe(false);
    // Both notes: the payroll reports show the employee, the sales reports the customer.
    expect(rows.filter((r) => r.entityType === 'note')).toHaveLength(2);
    // The SQL and the row rule agree, and the filters only ever narrow it.
    const expected = (await allRows()).filter((r) => canSeeAuditEntry(reportsOnly.access, r.entityType, r.oldValues, r.newValues));
    expect(total).toBe(expected.length);
    expect((await listAuditLogs(reportsOnly, { entityType: 'role' })).total).toBe(0);
    expect((await listAuditLogs(reportsOnly, { entityType: 'employee', limit: 200 })).total).toBe(
      expected.filter((r) => r.entityType === 'employee').length,
    );
    // The transaction log's rule gives the same answer: no user or role record, total = rows.
    const page = queryTransactionLog(TEST_DIR, {
      companyId: reportsOnly.companyId,
      visible: (r) => canSeeLogRecord(reportsOnly.access, r),
      limit: 5000,
    });
    expect(page.total).toBe(page.rows.length);
    expect(page.entityTypes).toContain('employee');
    expect(page.entityTypes).not.toContain('user');
    expect(page.entityTypes).not.toContain('role');
    // The raw download stays refused (no File Utilities export right).
    await expect(prepareRawLogDownload(reportsOnly)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a Payroll Processor reads payroll, not invoices or customers (no sales reports)', async () => {
    const { rows, total } = await listAuditLogs(payrollProcessor, { limit: 500 });
    expect(total).toBe(rows.length);
    const kinds = new Set(rows.map((r) => r.entityType));
    for (const k of ['employee', 'paycheck']) expect(kinds.has(k), k).toBe(true);
    for (const k of ['customer', 'invoice', 'user', 'role', 'user_session', 'mystery_kind']) expect(kinds.has(k), k).toBe(false);
    // Only the note on the employee.
    const notes = rows.filter((r) => r.entityType === 'note');
    expect(notes).toHaveLength(1);
    const allNotes = (await allRows()).filter((r) => r.entityType === 'note');
    expect((allNotes.find((n) => n.id === notes[0].id)!.newValues as { entityType: string }).entityType).toBe('employee');
    const expected = (await allRows()).filter((r) => canSeeAuditEntry(payrollProcessor.access, r.entityType, r.oldValues, r.newValues));
    expect(total).toBe(expected.length);
    // Transaction log page and CSV: the same records.
    routeCtx = payrollProcessor;
    const page = await (await logGET(get('/api/transaction-log?limit=5000'))).json();
    expect(page.total).toBe(page.rows.length);
    expect(page.entityTypes).toContain('employee');
    expect(page.entityTypes).not.toContain('customer');
    expect(page.entityTypes).not.toContain('invoice');
    const csv = await readStream(streamTransactionLogCsv(payrollProcessor, {}));
    expect(csv).toMatch(/Pat Payroll/);
    expect(csv).not.toMatch(/Cora Customer/);
    await expect(prepareRawLogDownload(payrollProcessor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an Admin sees every entry, as before', async () => {
    const all = await allRows();
    const { rows, total } = await listAuditLogs(admin, { limit: 200 });
    expect(total).toBe(all.length);
    expect(rows.some((r) => r.entityType === 'employee')).toBe(true);
    expect(rows.some((r) => r.entityType === 'mystery_kind')).toBe(true);
    const empRow = all.find((r) => r.entityType === 'employee')!;
    expect((await getAuditLog(admin, empRow.id)).entityType).toBe('employee');
  });

  it('transaction log: rows, total and filter lists leave the hidden records out', async () => {
    routeCtx = bookkeeper;
    const page = await (await logGET(get('/api/transaction-log?limit=5000'))).json();
    expect(page.total).toBe(page.rows.length);
    expect(page.rows.some((r: { entityType: string }) => r.entityType === 'employee')).toBe(false);
    expect(page.rows.some((r: { entityType: string }) => r.entityType === 'user')).toBe(false);
    expect(page.entityTypes).not.toContain('employee');
    expect(page.entityTypes).not.toContain('user');
    expect(JSON.stringify(page)).not.toContain('123456.78');
    expect(JSON.stringify(page)).not.toContain('Secret Lane');
    const filtered = await (await logGET(get('/api/transaction-log?entityType=employee'))).json();
    expect(filtered).toMatchObject({ rows: [], total: 0 });

    routeCtx = admin;
    const full = await (await logGET(get('/api/transaction-log?limit=5000'))).json();
    expect(full.total).toBeGreaterThan(page.total);
    expect(full.rows.some((r: { entityType: string }) => r.entityType === 'employee')).toBe(true);
  });

  it('the CSV export leaves them out too', async () => {
    const csv = await readStream(streamTransactionLogCsv(bookkeeper, {}));
    expect(csv).not.toMatch(/employee/i);
    expect(csv).toMatch(/Cora Customer/);
    const adminCsv = await readStream(streamTransactionLogCsv(admin, {}));
    expect(adminCsv).toMatch(/employee/i);
  });

  it('the raw download (which cannot be filtered) is refused to someone who may not view every record', async () => {
    // The Accountant may export the file but not view Users & Roles: the log records users.
    await expect(prepareRawLogDownload(accountant)).rejects.toMatchObject({ code: 'FORBIDDEN', message: /can’t view/ });
    await expect(prepareRawLogDownload(admin)).resolves.toMatchObject({ filename: expect.stringMatching(/\.bktlg$/) });
  });

  it('the integrity check still covers the whole log', async () => {
    routeCtx = bookkeeper;
    const v = await (await verifyGET()).json();
    expect(v.chainIntact).toBe(true);
    expect(v.records).toBe(readAllTransactionLog(TEST_DIR).records.length);
  });

  it('every kind the code writes to the audit trail or the log is mapped (unknown kinds are Admin-only)', () => {
    const known = new Set(knownAuditEntityTypes());
    const written = new Set<string>();
    const callRe = /\b(?:writeAudit|logTransaction)\s*\(/g;
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p);
          continue;
        }
        if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$|\.fixture\.ts$/.test(e.name)) continue;
        const src = fs.readFileSync(p, 'utf8');
        for (let m = callRe.exec(src); m; m = callRe.exec(src)) {
          // The call's own argument text (up to its closing parenthesis).
          let depth = 0;
          let end = m.index + m[0].length - 1;
          for (; end < src.length; end++) {
            if (src[end] === '(') depth++;
            else if (src[end] === ')' && --depth === 0) break;
          }
          const args = src.slice(m.index, end);
          const kind = /\bentityType\s*:\s*([^,\n}]+)/.exec(args);
          if (!kind) continue;
          // `a === 'x' ? 'kind1' : 'kind2'`: the compared values are not kinds.
          const value = kind[1].replace(/[!=]==\s*'[^']*'/g, '');
          for (const lit of value.matchAll(/'([A-Za-z0-9_]+)'/g)) written.add(lit[1]);
        }
      }
    };
    walk(path.resolve(process.cwd(), 'lib'));
    walk(path.resolve(process.cwd(), 'app'));
    // Kinds written through a variable (simple lists, type lists, budgets, Batch Delete, open items,
    // standing permission: agentGrants.ts AUDIT_ENTITY).
    for (const k of [
      'other_name', 'job_type', 'payment_terms', 'ship_via', 'payment_method', 'customer_message', 'sales_tax_code', 'vehicle',
      'customer_type', 'vendor_type', 'billing_rate_level', 'uom_set', 'class', 'budget', 'forecast', 'budgetLine',
      'batch_deleted_txn', 'qb_open_item_document', 'qb_open_item_total', 'agent_grant',
    ]) {
      written.add(k);
    }
    expect(written.size).toBeGreaterThan(100);
    const unmapped = [...written].filter((k) => !known.has(k)).sort();
    expect(unmapped).toEqual([]);
  });
});
