/**
 * Report gaps round — Commented Reports (QB "Comment on Report") and QuickZoom to the SOURCE
 * FORM (a report's detail line opens the invoice / bill / check / deposit / journal entry it came
 * from, lib/services/sourceForms.ts + the ?open= / ?focus= wiring of the form pages).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { accounts, auditLogs, commentedReports, employees, users } from '@/lib/db/schema';
import { commentMarks, commentedTable } from '@/lib/reports/comments';
import { normalizeGrant, unionRoles, type EffectiveAccess, type PermissionGrant } from '@/lib/permissions/model';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { createExpense } from './expenses';
import { createBill } from './bills';
import { createManualEntry } from './journal';
import { createEmployee } from './payroll';
import { runStandardReport } from './reportRegistry';
import {
  deleteCommentedReport,
  getCommentedReport,
  listCommentedReports,
  saveCommentedReport,
  staticSnapshot,
  updateCommentedReport,
} from './commentedReports';
import { SOURCE_FORMS, sourceFormForEntry, sourceRefForm } from './sourceForms';
import { openParamOf } from '@/lib/useOpenParam';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-commented');
let db: DB;
let ctx: ServiceContext;
let other: ServiceContext;
const A: Record<string, string> = {};
const S: Record<string, string> = {};
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const range = { from: '2026-01-01', to: '2026-12-31' };

function access(grant: Record<string, string[]>): EffectiveAccess {
  return {
    roleKeys: ['custom'],
    permissions: normalizeGrant(grant as never),
    flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false },
    isAdmin: false,
  };
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'commented@test.local', name: 'Commenter', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Commented Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const company2 = await createCompany(db, { name: 'Other Co', ownerId: user.id });
  other = { db, companyId: company2.id, userId: user.id };
  for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
  S.cust = (await createCustomer(ctx, { displayName: 'Acme' } as never)).id;
  S.vendor = (await createVendor(ctx, { displayName: 'Parts Inc' } as never)).id;
  const inv = await createInvoice(ctx, {
    customerId: S.cust,
    date: d('2026-03-05'),
    dueDate: d('2026-04-04'),
    lines: [{ accountId: A['4000'], quantity: 1, rate: '250.00', taxable: false }],
  } as never);
  S.invoice = inv.id;
  const exp = await createExpense(ctx, {
    vendorId: S.vendor,
    date: d('2026-03-10'),
    method: 'check',
    reference: '1001',
    paymentAccountId: A['1000'],
    lines: [{ accountId: A['6000'], amount: '40.00' }],
  } as never);
  S.expense = exp.id;
  const bill = await createBill(ctx, { vendorId: S.vendor, date: d('2026-03-12'), lines: [{ accountId: A['6000'], amount: '75.00' }] } as never);
  S.bill = bill.id;
  const je = await createManualEntry(ctx, {
    date: d('2026-03-15'),
    description: 'Owner draw',
    lines: [
      { accountId: A['6000'], debit: '10.00' },
      { accountId: A['1000'], credit: '10.00' },
    ],
  } as never);
  S.je = je.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

async function plRowIds() {
  const r = await runStandardReport(ctx, 'profit-loss', range);
  const income = r.rows.find((x) => x.kind === 'data' && x.cells.label && String(x.cells.label).includes('4000'))
    ?? r.rows.find((x) => x.kind === 'data')!;
  const net = r.rows.find((x) => x.kind === 'grand')!;
  const amountKey = r.columns.find((c) => c.type === 'money')!.key;
  return { r, income, net, amountKey };
}

describe('Commented Reports', () => {
  it('saves a picture of the report the server ran (no QuickZoom targets) with numbered comments', async () => {
    const { income, net, amountKey } = await plRowIds();
    const saved = await saveCommentedReport(ctx, {
      name: 'March P&L for the board',
      reportType: 'profit-loss',
      params: range,
      comments: [
        { rowId: income.id, columnKey: amountKey, text: 'One big invoice to Acme.' },
        { rowId: net.id, columnKey: amountKey, text: '  Better than plan.  ' },
      ],
    });
    expect(saved.name).toBe('March P&L for the board');
    expect(saved.comments.map((c) => c.text)).toEqual(['One big invoice to Acme.', 'Better than plan.']);
    expect(saved.comments.every((c) => /^[A-Za-z0-9-]{1,64}$/.test(c.id))).toBe(true);
    // A picture: the rows carry no QuickZoom links or entry ids.
    expect(saved.snapshot.rows.some((r) => r.href || r.hrefs || r.entryId)).toBe(false);
    expect(saved.snapshot.rows.find((r) => r.id === net.id)!.cells[amountKey]).toBe(net.cells[amountKey]);
    expect(saved.params).toEqual(range);

    // It does not change when the books do.
    await createInvoice(ctx, { customerId: S.cust, date: d('2026-03-20'), dueDate: d('2026-04-20'), lines: [{ accountId: A['4000'], quantity: 1, rate: '1000.00', taxable: false }] } as never);
    const again = await getCommentedReport(ctx, saved.id);
    expect(again.snapshot.rows.find((r) => r.id === net.id)!.cells[amountKey]).toBe(net.cells[amountKey]);

    const list = await listCommentedReports(ctx);
    expect(list).toEqual([expect.objectContaining({ id: saved.id, reportType: 'profit-loss', reportTitle: 'Profit & Loss Standard', commentCount: 2 })]);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, saved.id));
    expect(audits.map((a) => a.action)).toContain('create');
  });

  it('refuses comments that are not on a line and column of the report, empty or too many', async () => {
    const { income, amountKey } = await plRowIds();
    const base = { name: 'x', reportType: 'profit-loss', params: range };
    await expect(saveCommentedReport(ctx, { ...base, comments: [{ rowId: 'nope', columnKey: amountKey, text: 'a' }] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(saveCommentedReport(ctx, { ...base, comments: [{ rowId: income.id, columnKey: 'nope', text: 'a' }] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(saveCommentedReport(ctx, { ...base, comments: [{ rowId: income.id, columnKey: amountKey, text: '   ' }] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      saveCommentedReport(ctx, { ...base, comments: Array.from({ length: 201 }, () => ({ rowId: income.id, columnKey: amountKey, text: 'a' })) }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(saveCommentedReport(ctx, { ...base, name: '  ' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(saveCommentedReport(ctx, { ...base, reportType: 'no-such-report' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('renames and changes comments (the picture never changes); delete removes it', async () => {
    const { income, amountKey } = await plRowIds();
    const saved = await saveCommentedReport(ctx, { name: 'Draft', reportType: 'profit-loss', params: range, comments: [] });
    const renamed = await updateCommentedReport(ctx, saved.id, { name: 'Final' });
    expect(renamed.name).toBe('Final');
    const withComment = await updateCommentedReport(ctx, saved.id, { comments: [{ rowId: income.id, columnKey: amountKey, text: 'Check this' }] });
    expect(withComment.comments).toHaveLength(1);
    expect(withComment.snapshot).toEqual(saved.snapshot);
    await expect(updateCommentedReport(ctx, saved.id, { comments: [{ rowId: 'gone', columnKey: amountKey, text: 'x' }] })).rejects.toMatchObject({ code: 'VALIDATION' });
    await deleteCommentedReport(ctx, saved.id);
    await expect(getCommentedReport(ctx, saved.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is company-scoped and shown only to someone who may view the report', async () => {
    const saved = await saveCommentedReport(ctx, { name: 'Private', reportType: 'profit-loss', params: range });
    await expect(getCommentedReport(other, saved.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateCommentedReport(other, saved.id, { name: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(deleteCommentedReport(other, saved.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await listCommentedReports(other)).toEqual([]);

    const salesOnly = { ...ctx, access: access({ reports_sales: ['view'] }) };
    await expect(getCommentedReport(salesOnly, saved.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await listCommentedReports(salesOnly)).some((r) => r.id === saved.id)).toBe(false);
    await expect(saveCommentedReport(salesOnly, { name: 'x', reportType: 'profit-loss', params: range })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const ar = await saveCommentedReport(salesOnly, { name: 'Aging', reportType: 'ar-aging-summary', params: { asOf: '2026-03-31' } });
    expect((await listCommentedReports(salesOnly)).map((r) => r.id)).toContain(ar.id);
    const [row] = await db.select().from(commentedReports).where(eq(commentedReports.id, ar.id));
    expect(row.companyId).toBe(ctx.companyId);
  });

  it('exports the comment numbers next to the amounts and the comments after the report', async () => {
    const { r, income, amountKey } = await plRowIds();
    const snap = staticSnapshot(r);
    const comments = [
      { id: 'a', rowId: income.id, columnKey: amountKey, text: 'First' },
      { id: 'b', rowId: income.id, columnKey: amountKey, text: 'Second' },
    ];
    expect(commentMarks(comments).get(`${income.id}|${amountKey}`)).toEqual([1, 2]);
    const t = commentedTable(snap, comments);
    const flat = t.rows.map((row) => row.map((v) => String(v ?? '')));
    expect(flat.some((row) => row.some((v) => v.endsWith('[1, 2]')))).toBe(true);
    const tail = flat.slice(-3).map((row) => row[0]);
    expect(tail).toEqual(['Comments', '[1] First', '[2] Second']);
  });
});

/** A role saved by the per-activity editor (rights on single activities, not whole areas). */
function activityRole(grant: PermissionGrant, flags: EffectiveAccess['flags'] = { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false }): EffectiveAccess {
  return unionRoles([{ key: 'custom-activities', name: 'Custom', description: '', builtin: false, permissions: grant, flags }]);
}

describe('Commented Reports: sensitive data and per-activity report rights', () => {
  it('keeps SSNs masked in the picture, even when its creator may see them (and for every reader)', async () => {
    const emp = await createEmployee(ctx, { firstName: 'Sam', lastName: 'Secret', payType: 'hourly', payRate: '20.00' } as never);
    await db.update(employees).set({ ssn: '123-45-6789' }).where(eq(employees.id, emp.id));
    // The owner (trusted context: sees full SSNs on the live report) saves a commented copy.
    const live = await runStandardReport(ctx, 'employee-contact-list', {});
    expect(live.rows.some((r) => r.cells.ssn === '123-45-6789')).toBe(true);
    const saved = await saveCommentedReport(ctx, { name: 'Staff list', reportType: 'employee-contact-list', params: {} });
    const json = (x: unknown) => JSON.stringify(x);
    expect(json(saved.snapshot)).not.toContain('123-45-6789');
    expect(saved.snapshot.rows.some((r) => r.cells.ssn === '***-**-6789')).toBe(true);
    const [stored] = await db.select().from(commentedReports).where(eq(commentedReports.id, saved.id));
    expect(json(stored.snapshot)).not.toContain('123-45-6789');
    // A payroll-reports reader without "view sensitive payroll data" never sees the full SSN.
    const payrollReader = { ...ctx, access: activityRole({ 'reports_payroll.payroll': ['view'] }) };
    expect(json((await getCommentedReport(payrollReader, saved.id)).snapshot)).not.toContain('123-45-6789');
  });

  it('masks commented reports saved before this fix when they are read', async () => {
    const [old] = await db
      .insert(commentedReports)
      .values({
        companyId: ctx.companyId,
        name: 'Saved unmasked',
        reportType: 'employee-contact-list',
        params: {},
        snapshot: {
          key: 'employee-contact-list',
          title: 'Employee Contact List',
          columns: [{ key: 'label', header: 'Employee' }, { key: 'ssn', header: 'SS No.' }, { key: 'note', header: 'Original values' }],
          rows: [
            { id: 'ecl:1', depth: 0, kind: 'data', cells: { label: 'Secret, Sam', ssn: '123-45-6789', note: 'ssn: 987-65-4321 · accountNumber: 000123456789 · taxId: 12-3456789 · memo: ok' } },
          ],
        },
        comments: [],
      })
      .returning();
    const fullReader = { ...ctx, access: activityRole({ 'reports_payroll.payroll': ['view'] }, { sensitivePayroll: true, fullAccountNumbers: true, closedPeriod: false }) };
    for (const reader of [ctx, fullReader]) {
      const got = await getCommentedReport(reader, old.id);
      const text = JSON.stringify(got.snapshot);
      expect(text).not.toMatch(/123-45-6789|987-65-4321|000123456789|12-3456789/);
      expect(got.snapshot.rows[0].cells.ssn).toBe('***-**-6789');
      expect(got.snapshot.rows[0].cells.note).toContain('memo: ok');
    }
  });

  it("checks the report's own activity, not the whole area (Company & Financial does not open Accountant & Taxes)", async () => {
    const tb = await saveCommentedReport(ctx, { name: 'Year-end TB', reportType: 'trial-balance', params: { asOf: '2026-12-31' } });
    const pl = await saveCommentedReport(ctx, { name: 'Year P&L', reportType: 'profit-loss', params: range });
    const companyOnly = { ...ctx, access: activityRole({ 'reports_financial.company': ['view'] }) };
    // The live report is refused to this role…
    await expect(runStandardReport(companyOnly, 'trial-balance', { asOf: '2026-12-31' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // …and so is its commented copy: not listed, not readable, not renamable or deletable, not savable.
    const ids = (await listCommentedReports(companyOnly)).map((r) => r.id);
    expect(ids).toContain(pl.id);
    expect(ids).not.toContain(tb.id);
    await expect(getCommentedReport(companyOnly, tb.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateCommentedReport(companyOnly, tb.id, { name: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(deleteCommentedReport(companyOnly, tb.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(saveCommentedReport(companyOnly, { name: 'x', reportType: 'trial-balance', params: { asOf: '2026-12-31' } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await getCommentedReport(companyOnly, pl.id)).id).toBe(pl.id);
    const accountantOnly = { ...ctx, access: activityRole({ 'reports_financial.accountant': ['view'] }) };
    expect((await getCommentedReport(accountantOnly, tb.id)).id).toBe(tb.id);
    await expect(getCommentedReport(accountantOnly, pl.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('QuickZoom to the source form', () => {
  async function entryOf(table: 'invoices' | 'expenses' | 'bills', id: string): Promise<string> {
    const schema = await import('@/lib/db/schema');
    const t = schema[table] as typeof schema.invoices;
    const [row] = await db.select({ e: t.postedEntryId }).from(t).where(eq(t.id, id));
    return row.e!;
  }

  it('opens the invoice, check, bill or journal entry a ledger line came from', async () => {
    expect(await sourceFormForEntry(ctx, await entryOf('invoices', S.invoice))).toBe(SOURCE_FORMS.invoice(S.invoice));
    expect(await sourceFormForEntry(ctx, await entryOf('expenses', S.expense))).toBe(SOURCE_FORMS.expense(S.expense));
    expect(await sourceFormForEntry(ctx, await entryOf('bills', S.bill))).toBe(SOURCE_FORMS.bill(S.bill));
    expect(await sourceFormForEntry(ctx, S.je)).toBe(SOURCE_FORMS.journal(S.je));
  });

  it("never opens another company's entry or anything that is not an entry id", async () => {
    expect(await sourceFormForEntry(other, await entryOf('invoices', S.invoice))).toBeNull();
    expect(await sourceFormForEntry(ctx, 'not-a-uuid')).toBeNull();
    expect(await sourceFormForEntry(ctx, '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('a detail row of a standard report carries the entry that QuickZooms to the form', async () => {
    const r = await runStandardReport(ctx, 'transaction-detail-by-account', { ...range, accountId: A['6000'] });
    const rows = r.rows.filter((x) => x.entryId);
    expect(rows.length).toBeGreaterThan(0);
    const forms = await Promise.all(rows.map((x) => sourceFormForEntry(ctx, x.entryId!)));
    expect(forms).toEqual(expect.arrayContaining([SOURCE_FORMS.expense(S.expense), SOURCE_FORMS.bill(S.bill), SOURCE_FORMS.journal(S.je)]));
  });

  it('maps the sourceRef of entries kept by no document to their page', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(sourceRefForm(`invoice-cogs:${id}`, 'e')).toBe(SOURCE_FORMS.invoice(id));
    expect(sourceRefForm(`bank_transaction:${id}`, 'e')).toBe('/bank-review');
    expect(sourceRefForm('manual', 'e1')).toBe(SOURCE_FORMS.journal('e1'));
    expect(sourceRefForm(null, 'e1')).toBe(SOURCE_FORMS.journal('e1'));
    expect(sourceRefForm('invoice:not-a-uuid', 'e')).toBeNull();
    expect(sourceRefForm('reversal:x', 'e')).toBeNull();
  });

  it('every form page a QuickZoom opens reads its ?open= / ?focus= parameter', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    for (const [kind, make] of Object.entries(SOURCE_FORMS)) {
      const href = make(id);
      // Every QuickZoom opens a page of the app (the pay stub PDF used to replace the app window).
      expect(href.startsWith('/api/'), `${kind}: ${href} is a page`).toBe(false);
      const [pagePath, query] = href.split('?');
      const src = fs.readFileSync(path.join(process.cwd(), 'app', ...pagePath.split('/').filter(Boolean), 'page.tsx'), 'utf8');
      if (query.startsWith('open=')) expect(/useOpenParam\(/.test(src), `${kind}: ${pagePath} reads ?open=`).toBe(true);
      else expect(/useFocusParam\(/.test(src), `${kind}: ${pagePath} reads ?focus=`).toBe(true);
    }
    expect(openParamOf(`?open=${id}`)).toBe(id);
    expect(openParamOf('?open=javascript:alert(1)')).toBeNull();
  });
});
