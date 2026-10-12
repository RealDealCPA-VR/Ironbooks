/**
 * Recurring template integration tests.
 *
 * Creates a monthly invoice template due today, runs runDue, asserts:
 *   1. An invoice was created.
 *   2. nextRunDate advanced by one month.
 *   3. The trial balance remains balanced.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, accounts, customers, invoices, recurringTemplates } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createTemplate, runDue, runTemplateNow, listTemplates } from './recurring';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-recurring-templates');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let customerId: string;

describe('Recurring templates service', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    // Seed user + company
    const [user] = await db
      .insert(users)
      .values({ email: 'recurring-owner@test.local', name: 'Recurring Owner', passwordHash: 'x' })
      .returning();

    const [company] = await db
      .insert(companies)
      .values({ name: 'Recurring Co', ownerId: user.id })
      .returning();

    ctx = { db, companyId: company.id, userId: user.id };

    // Seed accounts (matching COA codes used by createInvoice)
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Cash', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2000', 'Accounts Payable', 'liability', 'accounts_payable'],
      ['2200', 'Sales Tax Payable', 'liability', 'accounts_payable'],
      ['3000', 'Owner Equity', 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['5000', 'Office Expense', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    // Seed a customer
    const [cust] = await db
      .insert(customers)
      .values({
        companyId: company.id,
        displayName: 'Recurring Customer',
        balance: '0.00',
        taxable: false,
      })
      .returning();
    customerId = cust.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates a recurring template', async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tpl = await createTemplate(ctx, {
      name: 'Monthly Retainer',
      docType: 'invoice',
      frequency: 'monthly',
      nextRunDate: today,
      template: {
        customerId,
        date: today.toISOString(),
        lines: [
          {
            description: 'Monthly retainer fee',
            quantity: '1',
            rate: '500.00',
          },
        ],
      },
    });

    expect(tpl.id).toBeTruthy();
    expect(tpl.name).toBe('Monthly Retainer');
    expect(tpl.docType).toBe('invoice');
    expect(tpl.frequency).toBe('monthly');
  });

  it('listTemplates returns the created template', async () => {
    const list = await listTemplates(ctx);
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((t) => t.name === 'Monthly Retainer')).toBe(true);
  });

  it('runDue generates an invoice and advances nextRunDate', async () => {
    // Run with asOf = today (so the template is due)
    const today = new Date();
    const { generated } = await runDue(ctx, today);

    expect(generated.length).toBe(1);
    expect(generated[0].docType).toBe('invoice');
    expect(generated[0].docId).toBeTruthy();

    // Verify the invoice actually exists
    const [inv] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.id, generated[0].docId));
    expect(inv).toBeTruthy();
    expect(inv.total).toBe('500.00');

    // Verify nextRunDate was advanced by ~1 month
    const [tpl] = await db
      .select()
      .from(recurringTemplates)
      .where(eq(recurringTemplates.companyId, ctx.companyId));

    const nextRun = tpl.nextRunDate!;
    const expectedNext = new Date(today);
    expectedNext.setMonth(expectedNext.getMonth() + 1);

    // Allow same day (month boundary)
    expect(nextRun.getMonth()).toBe(expectedNext.getMonth());
    expect(nextRun.getFullYear()).toBe(expectedNext.getFullYear());
  });

  it('trial balance remains balanced after generating recurring invoice', async () => {
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it('runDue does not generate again when nextRunDate is in the future', async () => {
    const today = new Date();
    const { generated } = await runDue(ctx, today);
    // Template's nextRunDate is now ~1 month ahead; should not be due again today
    expect(generated.length).toBe(0);
  });

  it('runTemplateNow generates immediately and advances nextRunDate again', async () => {
    const list = await listTemplates(ctx);
    const tpl = list[0];
    const prevNextRun = tpl.nextRunDate!;

    const doc = await runTemplateNow(ctx, tpl.id);
    expect(doc.docId).toBeTruthy();
    expect(doc.docType).toBe('invoice');

    // nextRunDate should have advanced again
    const [updated] = await db
      .select()
      .from(recurringTemplates)
      .where(eq(recurringTemplates.id, tpl.id));
    expect(updated.nextRunDate!.getTime()).toBeGreaterThan(prevNextRun.getTime());

    // Trial balance still balanced
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('createTemplate rejects unknown docType', async () => {
    await expect(
      createTemplate(ctx, {
        name: 'Bad',
        docType: 'wire_transfer' as never,
        frequency: 'monthly',
        nextRunDate: new Date(),
        template: {},
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('createTemplate rejects unknown frequency', async () => {
    await expect(
      createTemplate(ctx, {
        name: 'Bad2',
        docType: 'bill',
        frequency: 'hourly' as never,
        nextRunDate: new Date(),
        template: {},
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
