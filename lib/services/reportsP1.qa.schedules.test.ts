/**
 * Independent QA (tester) for P1 item 2: the scheduled-report timer serves every company in the
 * file. Adversarial checks:
 *  - each company's schedule runs with that company's data only (no cross-company leak);
 *  - every company gets its own export folder — including two companies with the SAME name and
 *    names that would escape the export folder;
 *  - a soft-deleted (archived) company file does not keep exporting;
 *  - one company failing (schedule creator removed) does not stop the others;
 *  - a memorized cash-basis report keeps its basis when the timer runs it;
 *  - no / wrong token → no contexts (fails closed).
 * Hermetic PGlite data dir (BKA_DATA_DIR so internalContexts' getDb() opens the same file).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, companies, reportSchedules, userCompanies, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { postJournalEntry } from './posting';
import { createReportSchedule, saveMemorizedReport } from './memorizedReports';
import { companyExportDir, internalContexts, runDueForCompanies } from '@/app/api/report-schedules/_internal';

const ROOT = process.cwd();
const TEST_DIR = path.resolve(ROOT, '.bookkeeper-data', 'test-reports-p1-qa-sched');
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-p1qa-'));
const saved = { data: process.env.BKA_DATA_DIR, out: process.env.BKA_REPORT_EXPORT_DIR, tok: process.env.BKA_INTERNAL_TOKEN };
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

let db: DB;
let ownerId: string;
let helperId: string;
interface Co {
  ctx: ServiceContext;
  code: Record<string, string>;
  name: string;
}
const cos: Record<string, Co> = {};
const sched: Record<string, string> = {};

async function company(key: string, name: string, amount: string): Promise<Co> {
  const c = await createCompany(db, { name, ownerId });
  const ctx: ServiceContext = { db, companyId: c.id, userId: ownerId };
  const rows = await db.select().from(accounts).where(eq(accounts.companyId, c.id));
  const code: Record<string, string> = {};
  for (const r of rows) code[r.code] = r.id;
  await postJournalEntry(ctx, { date: d('2026-01-10'), description: `Sale ${key}`, lines: [{ accountId: code['1000'], debit: amount }, { accountId: code['4000'], credit: amount }] });
  const co = { ctx, code, name };
  cos[key] = co;
  return co;
}

async function dueTb(co: Co, name: string, ctx = co.ctx) {
  const m = await saveMemorizedReport(ctx, { name: `${name} TB`, reportType: 'trial-balance', config: { params: { asOf: '2026-01-31' } } });
  return (await createReportSchedule(ctx, { name, memorizedReportId: m.id, frequency: 'daily', startDate: '2026-01-05' })).id;
}

const req = (headers: Record<string, string> = {}) =>
  new NextRequest('http://127.0.0.1/api/reports/schedules/run-due', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  process.env.BKA_DATA_DIR = TEST_DIR;
  process.env.BKA_REPORT_EXPORT_DIR = OUT_DIR;
  db = await getDb(TEST_DIR);
  const [owner] = await db.insert(users).values({ email: 'p1qa-sched@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  const [helper] = await db.insert(users).values({ email: 'p1qa-helper@test.local', name: 'Helper', passwordHash: 'x' }).returning();
  ownerId = owner.id;
  helperId = helper.id;
  // Created in order: oldest first (createdAt ties are broken by id, so space them out).
  const plan: [string, string, string][] = [
    ['first', 'First Co', '111.11'],
    ['dupA', 'Dup Co', '222.22'],
    ['dupB', 'Dup Co', '333.33'],
    ['evil', '../../Evil', '444.44'],
    ['archived', 'Deleted Co', '555.55'],
    ['broken', 'Broken Co', '666.66'],
    ['cash', 'Cash Co', '0.01'],
  ];
  for (const [i, [key, name, amt]] of plan.entries()) {
    const co = await company(key, name, amt);
    await db.update(companies).set({ createdAt: new Date(Date.UTC(2025, 0, 1 + i)) }).where(eq(companies.id, co.ctx.companyId));
  }
  for (const key of ['first', 'dupA', 'dupB', 'evil', 'archived']) sched[key] = await dueTb(cos[key], `${key} daily`);
  // Archive (soft-delete) the "Deleted Co" file, as Company > Delete does.
  await db.update(companies).set({ settings: { archived: true } }).where(eq(companies.id, cos.archived.ctx.companyId));
  // "Broken Co": the schedule's creator is later removed from the company.
  await db.insert(userCompanies).values({ userId: helperId, companyId: cos.broken.ctx.companyId, role: 'admin' });
  sched.broken = await dueTb(cos.broken, 'broken daily', { db, companyId: cos.broken.ctx.companyId, userId: helperId });
  await db.update(userCompanies).set({ isActive: false }).where(and(eq(userCompanies.userId, helperId), eq(userCompanies.companyId, cos.broken.ctx.companyId)));
  // "Cash Co": an unpaid 100.00 invoice; a memorized cash-basis P&L must show no income.
  const cust = (await createCustomer(cos.cash.ctx, { displayName: 'Slow Payer' })).id;
  await createInvoice(cos.cash.ctx, { customerId: cust, date: d('2026-01-15'), dueDate: d('2026-02-14'), lines: [{ accountId: cos.cash.code['4100'], quantity: 1, rate: '100.00', taxable: false }] });
  const m = await saveMemorizedReport(cos.cash.ctx, { name: 'Cash P&L', reportType: 'profit-loss', config: { params: { from: '2026-01-01', to: '2026-01-31', basis: 'cash' } } });
  sched.cash = (await createReportSchedule(cos.cash.ctx, { name: 'cash daily', memorizedReportId: m.id, frequency: 'daily', startDate: '2026-01-05' })).id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore('BKA_DATA_DIR', saved.data);
  restore('BKA_REPORT_EXPORT_DIR', saved.out);
  restore('BKA_INTERNAL_TOKEN', saved.tok);
  for (const dir of [TEST_DIR, OUT_DIR]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold PGlite files briefly */
    }
  }
});

describe('scheduled reports across every company in the file', () => {
  it('no token or a wrong token gives no trusted contexts', async () => {
    process.env.BKA_INTERNAL_TOKEN = 'a'.repeat(64);
    try {
      expect(await internalContexts(req())).toBeNull();
      expect(await internalContexts(req({ 'x-bka-internal': 'b'.repeat(64) }))).toBeNull();
    } finally {
      delete process.env.BKA_INTERNAL_TOKEN;
    }
    expect(await internalContexts(req({ 'x-bka-internal': 'a'.repeat(64) }))).toBeNull();
  });

  it('every company gets its own export folder, inside the export root, even with duplicate names', async () => {
    const dirs = new Map<string, string>();
    for (const [key, co] of Object.entries(cos)) dirs.set(key, await companyExportDir(co.ctx));
    expect(dirs.get('first')).toBe(path.resolve(OUT_DIR));
    for (const [key, dir] of dirs) {
      const rel = path.relative(path.resolve(OUT_DIR), dir);
      expect(rel.startsWith('..') || path.isAbsolute(rel), `${key}: ${dir}`).toBe(false);
    }
    // Two different company files must never share a folder (same-named exports would overwrite).
    expect(new Set(dirs.values()).size, [...dirs.entries()].map(([k, v]) => `${k}=${v}`).join('\n')).toBe(dirs.size);
  });

  it('a deleted (archived) company file is not served by the timer', async () => {
    const tok = 'c'.repeat(64);
    process.env.BKA_INTERNAL_TOKEN = tok;
    try {
      const ctxs = (await internalContexts(req({ 'x-bka-internal': tok })))!;
      const ids = ctxs.map((c) => c.companyId);
      expect(ids).toContain(cos.first.ctx.companyId);
      expect(ids).toContain(cos.dupB.ctx.companyId);
      expect(ids, 'archived company still scheduled').not.toContain(cos.archived.ctx.companyId);
    } finally {
      delete process.env.BKA_INTERNAL_TOKEN;
    }
  });

  it('runs each company’s schedule on its own data; one failing company does not stop the others; cash basis kept', async () => {
    const ctxs = ['first', 'dupA', 'dupB', 'evil', 'broken', 'cash'].map((k) => ({ db, companyId: cos[k].ctx.companyId, userId: ownerId }));
    const results = await runDueForCompanies(ctxs);
    const by = (k: string) => results.find((r) => r.scheduleId === sched[k]);
    expect(by('broken')?.status).toBe('failed');
    expect(by('broken')?.companyId).toBe(cos.broken.ctx.companyId);
    const amounts: Record<string, string> = { first: '111.11', dupA: '222.22', dupB: '333.33', evil: '444.44' };
    for (const [k, amt] of Object.entries(amounts)) {
      const r = by(k);
      expect(r?.status, k).toBe('ok');
      expect(r?.companyId, k).toBe(cos[k].ctx.companyId);
      const csv = fs.readFileSync(r!.files[0], 'utf8');
      expect(csv, k).toContain(amt);
      for (const [other, oAmt] of Object.entries(amounts)) if (other !== k) expect(csv, `${k} leaks ${other}`).not.toContain(oAmt);
      const rel = path.relative(path.resolve(OUT_DIR), r!.files[0]);
      expect(rel.startsWith('..'), `${k} wrote outside the export folder`).toBe(false);
    }
    // The memorized cash-basis P&L ran on the cash basis: the unpaid invoice is not income.
    const cash = by('cash')!;
    expect(cash.status).toBe('ok');
    const csv = fs.readFileSync(cash.files[0], 'utf8');
    expect(csv).toContain('Cash Basis');
    expect(csv).not.toContain('100.00');
    // Schedules that ran moved on; the broken one is marked failed.
    const [row] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, sched.broken));
    expect(row.lastStatus).toBe('failed');
  });
});
