/**
 * Security package G2 — the audit-based accountant reports follow the Audit Trail's rule
 * (lib/services/auditVisibility.ts, security 2.2 follow-up).
 *
 * The Voided/Deleted Transactions Summary and Detail read audit rows with only the financial
 * reports right, so a Bookkeeper (no payroll access) saw a deleted paycheck's name and net pay,
 * and in the Detail its original pay lines. Each row is now shown only to someone who may view the
 * record it is about; the Closing Date Exception report's own rows follow the same rule. Admins
 * (and trusted contexts) see everything, as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_ROLES, unionRoles } from '@/lib/permissions/model';
import { writeAudit, type ServiceContext } from './_base';
import { makeTestCompany, type TestCompany } from './testkit.prefs';
import { closingDateExceptionReport, voidedDeletedTransactions } from './accountant/auditReports';
import { voidedDeletedDetailStd } from './reportsMore';

let t: TestCompany;
let owner: ServiceContext;
const roleCtx = (key: string): ServiceContext => ({ ...owner, access: unionRoles(BUILTIN_ROLES.filter((r) => r.key === key)) });

const PAYCHECK_ID = '11111111-1111-4111-8111-111111111111';
const INVOICE_ID = '22222222-2222-4222-8222-222222222222';
const ENTRY_ID = '33333333-3333-4333-8333-333333333333';

beforeAll(async () => {
  t = await makeTestCompany('g2-audit-reports');
  owner = t.ctx;
  // A deleted paycheck (its original pay in the snapshot) and a voided invoice.
  await writeAudit(owner, {
    action: 'delete',
    entityType: 'paycheck',
    entityId: PAYCHECK_ID,
    oldValues: {
      payeeName: 'Jane Payroll',
      payDate: '2026-03-13',
      grossPay: '4321.00',
      netPay: '3210.98',
      lines: [{ kind: 'earning', name: 'Salary', amount: '4321.00' }],
    },
  });
  await writeAudit(owner, {
    action: 'void',
    entityType: 'invoice',
    entityId: INVOICE_ID,
    oldValues: { invoiceNumber: 'INV-77', customerName: 'Acme', total: '150.00' },
  });
  // A closing-date exception (a change made with the closing-date password).
  await writeAudit(owner, {
    action: 'create',
    entityType: 'closing_date_exception',
    entityId: ENTRY_ID,
    newValues: { entryNumber: 9, operation: 'post', transactionDate: '2026-01-15', closingDate: '2026-01-31', description: 'Late fix' },
  });
});

afterAll(async () => {
  await t.cleanup();
});

describe('Voided/Deleted Transactions', () => {
  it('a Bookkeeper (no payroll access) does not see the paycheck, in the Summary or the Detail', async () => {
    const bookkeeper = roleCtx('bookkeeper');
    const summary = await voidedDeletedTransactions(bookkeeper);
    expect(summary.rows.map((r) => r.entityType)).toEqual(['invoice']);
    expect(summary.count).toBe(1);
    const detail = await voidedDeletedTransactions(bookkeeper, { detail: true });
    expect(detail.rows.map((r) => r.entityId)).toEqual([INVOICE_ID]);
    expect(JSON.stringify(detail.rows)).not.toContain('3210.98');
    expect(JSON.stringify(detail.rows)).not.toContain('Jane Payroll');
    // The Report Center's version (built on it) leaves it out too.
    const std = await voidedDeletedDetailStd(bookkeeper, {} as Parameters<typeof voidedDeletedDetailStd>[1]);
    expect(JSON.stringify(std)).not.toContain('3210.98');
    expect(JSON.stringify(std)).toContain('INV-77');
  });

  it('an Admin (and a trusted context) sees both, unchanged', async () => {
    for (const ctx of [roleCtx('admin'), owner]) {
      const res = await voidedDeletedTransactions(ctx, { detail: true });
      expect(res.rows.map((r) => r.entityType).sort()).toEqual(['invoice', 'paycheck']);
      expect(res.rows.find((r) => r.entityType === 'paycheck')!.amount).toBe('3210.98');
    }
  });

  it('the rule is per record: payroll access sees the paycheck, not the invoice', async () => {
    const res = await voidedDeletedTransactions(roleCtx('payroll_processor'));
    expect(res.rows.map((r) => r.entityType)).toEqual(['paycheck']);
  });
});

describe('Closing Date Exception report', () => {
  it("shows its exception rows only to someone who may view the closing date; an Admin's report is unchanged", async () => {
    const admin = await closingDateExceptionReport(roleCtx('admin'));
    expect(admin.rows.filter((r) => r.source === 'override').map((r) => r.entryId)).toEqual([ENTRY_ID]);
    const accountant = await closingDateExceptionReport(roleCtx('accountant'));
    expect(accountant.rows.filter((r) => r.source === 'override').map((r) => r.entryId)).toEqual([ENTRY_ID]);
    // No closing-date access and no financial reports (the report's route needs one anyway): its
    // rows are not shown. (A Bookkeeper sees them: closing kinds are covered by financial reports.)
    const sales = await closingDateExceptionReport(roleCtx('sales'));
    expect(sales.rows.filter((r) => r.source === 'override')).toEqual([]);
  });
});
