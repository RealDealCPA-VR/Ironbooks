/**
 * Review round 3 — cross-cutting guards (closed periods / permissions):
 *  1. Entering a memorized transaction needs the document's own create permission (the trusted
 *     launch-time run, which has no `access`, is unrestricted).
 *  2. Payment applications of a payment dated in a closed period can't be removed.
 *  3. Credit-memo applications can't be back-dated into, or removed from, a closed period.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, invoices } from '@/lib/db/schema';
import { builtinRole, unionRoles } from '@/lib/permissions/model';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createTemplate, runDue, runGroup, runTemplateNow } from './recurring';
import { accounts } from '@/lib/db/schema';
import { createInvoice } from './invoices';
import { receivePayment, unapplyFromInvoice } from './payments';
import { createCreditMemo, applyToInvoice, unapplyCreditApplication } from './creditMemos';
import { closePeriod } from './fiscalPeriods';
import { creditApplications } from '@/lib/db/schema';

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review3-guards');
let db: DB;
let owner: ServiceContext;
let customerId: string;

function asRole(role: string): ServiceContext {
  return { ...owner, role: 'accountant', access: unionRoles([builtinRole(role)!]) };
}

describe('review3 guards', () => {
  beforeAll(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'r3-owner@test.local', name: 'Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db.insert(companies).values({ name: 'R3 Co', ownerId: user.id }).returning();
    owner = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Cash', 'asset', 'checking'],
      ['1050', 'Undeposited Funds', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2200', 'Sales Tax Payable', 'liability', 'accounts_payable'],
      ['3000', 'Owner Equity', 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['5000', 'Office Expense', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      await createAccount(owner, { code, name, type: type as never, subtype });
    }
    const [cust] = await db
      .insert(customers)
      .values({ companyId: company.id, displayName: 'R3 Customer', balance: '0.00', taxable: false })
      .returning();
    customerId = cust.id;
    // Books for January 2026 are closed.
    await closePeriod(owner, { periodStart: D('2026-01-01'), periodEnd: D('2026-01-31') });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('Enter Now on a memorized invoice needs Customers create (Banking role has only Customers view)', async () => {
    const tpl = await createTemplate(owner, {
      name: 'Remind invoice',
      docType: 'invoice',
      frequency: 'monthly',
      mode: 'remind',
      nextRunDate: new Date(),
      template: { customerId, lines: [{ description: 'Fee', quantity: '1', rate: '250.00' }] },
    });
    const banking = asRole('banking');
    // Precondition: the route gate (/api/recurring/run → accounting:create) lets this user in.
    expect(banking.access!.permissions.accounting).toContain('create');
    expect(banking.access!.permissions.customers).not.toContain('create');

    await expect(runTemplateNow(banking, tpl.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const rows = await db.select().from(invoices).where(eq(invoices.companyId, owner.companyId));
    expect(rows.length).toBe(0);

    // A user who also holds Customers create (A/R Clerk + Banking roles) may enter it.
    const arWithAccounting: ServiceContext = {
      ...owner,
      role: 'accountant',
      access: unionRoles([builtinRole('ar_clerk')!, builtinRole('banking')!]),
    };
    const doc = await runTemplateNow(arWithAccounting, tpl.id);
    expect(doc.docType).toBe('invoice');
  });

  it('the trusted launch-time run (context without access) still enters automatic templates', async () => {
    const tpl = await createTemplate(owner, {
      name: 'Auto invoice',
      docType: 'invoice',
      frequency: 'monthly',
      mode: 'automatic',
      nextRunDate: new Date(),
      template: { customerId, lines: [{ description: 'Auto', quantity: '1', rate: '40.00' }] },
    });
    const { generated, failed } = await runDue(owner, new Date());
    expect(failed).toEqual([]);
    expect(generated.map((g) => g.templateId)).toContain(tpl.id);
  });

  it('Run due / Enter Group skip (and report) templates the user may not create, and enter the rest', async () => {
    const acctRows = await db.select().from(accounts).where(eq(accounts.companyId, owner.companyId));
    const id = (code: string) => acctRows.find((a) => a.code === code)!.id;
    const inv = await createTemplate(owner, {
      name: 'Grp invoice',
      docType: 'invoice',
      frequency: 'monthly',
      mode: 'automatic',
      groupName: 'Month end',
      nextRunDate: new Date(),
      template: { customerId, lines: [{ description: 'Fee', quantity: '1', rate: '75.00' }] },
    });
    const je = await createTemplate(owner, {
      name: 'Grp accrual',
      docType: 'journal_entry',
      frequency: 'monthly',
      mode: 'automatic',
      groupName: 'Month end',
      nextRunDate: new Date(),
      template: {
        description: 'Accrual',
        lines: [
          { accountId: id('5000'), debit: '20.00' },
          { accountId: id('3000'), credit: '20.00' },
        ],
      },
    });
    const banking = asRole('banking'); // accounting create, customers view only

    const due = await runDue(banking, new Date());
    expect(due.generated.map((g) => g.templateId)).toEqual([je.id]);
    expect(due.failed).toEqual([
      { templateId: inv.id, templateName: 'Grp invoice', error: "You don't have permission to create invoices." },
    ]);

    const grp = await runGroup(banking, 'Month end');
    expect(grp.generated.map((g) => g.templateId)).toEqual([je.id]);
    expect(grp.failed.map((f) => [f.templateId, f.error])).toEqual([
      [inv.id, "You don't have permission to create invoices."],
    ]);
    const invRows = await db.select().from(invoices).where(eq(invoices.companyId, owner.companyId));
    expect(invRows.some((r) => r.total === '75.00')).toBe(false);
  });

  it('unapplying a payment dated in a closed period is refused (changes closed-period A/R aging)', async () => {
    // Invoice + payment entered in February, then February is closed.
    const inv = await createInvoice(owner, {
      customerId,
      date: D('2026-02-03'),
      lines: [{ description: 'Work', quantity: '1', rate: '100.00' }],
    } as never);
    const { payment } = await receivePayment(owner, {
      customerId,
      date: D('2026-02-10'),
      method: 'check',
      amount: '100.00',
      applications: [{ invoiceId: inv.id, amountApplied: '100.00' }],
    } as never);
    await closePeriod(owner, { periodStart: D('2026-02-01'), periodEnd: D('2026-02-28') });

    await expect(unapplyFromInvoice(owner, { paymentId: payment.id, invoiceId: inv.id })).rejects.toMatchObject({
      code: 'PERIOD_CLOSED',
    });
    const [row] = await db.select().from(invoices).where(eq(invoices.id, inv.id));
    expect(row.balanceDue).toBe('0.00');
  });

  it('applying / unapplying a credit memo application dated in a closed period is refused', async () => {
    const inv = await createInvoice(owner, {
      customerId,
      date: D('2026-03-02'),
      lines: [{ description: 'Work', quantity: '1', rate: '80.00' }],
    } as never);
    const memo = await createCreditMemo(owner, {
      customerId,
      date: D('2026-03-03'),
      lines: [{ description: 'Credit', quantity: 1, rate: '30.00' }],
    } as never);
    await applyToInvoice(owner, { creditMemoId: memo.id, invoiceId: inv.id, amount: '10.00', date: D('2026-03-04') });
    await closePeriod(owner, { periodStart: D('2026-03-01'), periodEnd: D('2026-03-31') });

    // New application back-dated into the closed month.
    await expect(
      applyToInvoice(owner, { creditMemoId: memo.id, invoiceId: inv.id, amount: '5.00', date: D('2026-03-20') }),
    ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });

    // Removing the March application.
    const [app] = await db.select().from(creditApplications).where(eq(creditApplications.creditMemoId, memo.id));
    await expect(unapplyCreditApplication(owner, app.id)).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
  });
});
