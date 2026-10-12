/**
 * Estimate sales tax + progress invoicing — integration tests.
 *
 * Verifies:
 *  - createEstimate computes sales tax on taxable lines with the same math as
 *    invoices (taxableSubtotal * rate) and persists taxAmount/total.
 *  - createProgressInvoice({ percent }) bills a % of the ENTIRE estimate on
 *    every line (pro-rated quantities, sales tax computed on the invoice),
 *    accumulates estimates.amount_invoiced, and flips status to 'partial'.
 *  - createProgressInvoice({ lineAmounts }) bills explicit per-line amounts.
 *  - Billing over 100% of a line is a confirmable warning; the estimate closes when
 *    fully invoiced (convertedInvoiceId = final progress invoice).
 *  - convertToInvoice is blocked once progress billing has started; rejected
 *    estimates can't be progress-invoiced; partial estimates can't change status.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, taxRates, estimates } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { getInvoice } from './invoices';
import {
  createEstimate,
  getEstimate,
  createProgressInvoice,
  convertToInvoice,
  updateEstimateStatus,
} from './estimates';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-estimates-progress');

let ctx: ServiceContext;
let db: DB;
let customerId: string;
let taxRateId: string;

describe('Estimate tax + progress invoicing', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'owner@progress.test', name: 'Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Progress Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
    ];
    for (const [code, name, type, subtype] of defs) {
      await createAccount(ctx, { code, name, type: type as never, subtype });
    }

    const [cust] = await db
      .insert(customers)
      .values({ companyId: company.id, displayName: 'Progress Customer', taxable: true })
      .returning();
    customerId = cust.id;

    const [rate] = await db
      .insert(taxRates)
      .values({ companyId: company.id, name: 'Tax 10%', rate: '0.100000' })
      .returning();
    taxRateId = rate.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('computes sales tax on estimates using invoice math', async () => {
    const est = await createEstimate(ctx, {
      customerId,
      date: new Date('2025-05-01'),
      taxRateId,
      lines: [
        { description: 'Taxable labor', quantity: 10, rate: 10, taxable: true },  // 100
        { description: 'Untaxed permit', quantity: 1, rate: 50, taxable: false }, // 50
      ],
    });
    expect(est.subtotal).toBe('150.00');
    expect(est.taxAmount).toBe('10.00'); // 100 * 10%
    expect(est.total).toBe('160.00');
  });

  it('estimates without a tax rate still quote $0 tax', async () => {
    const est = await createEstimate(ctx, {
      customerId,
      date: new Date('2025-05-01'),
      lines: [{ description: 'No tax', quantity: 1, rate: 100 }],
    });
    expect(est.taxAmount).toBe('0.00');
    expect(est.total).toBe('100.00');
  });

  it('bills 50% of the entire estimate line by line, taxing the invoice normally', async () => {
    const est = await createEstimate(ctx, {
      customerId,
      date: new Date('2025-05-02'),
      taxRateId,
      lines: [
        { description: 'Phase A', quantity: 1, rate: 100, taxable: true },  // 100
        { description: 'Phase B', quantity: 1, rate: 50, taxable: false },  // 50
      ],
    });
    // total = 150 + 10 tax = 160
    expect(est.total).toBe('160.00');

    const { invoice, estimate: updated } = await createProgressInvoice(ctx, est.id, {
      percent: 50,
      date: new Date('2025-05-03'),
    });

    // 50% of each line: 50 (taxable) + 25 (not taxable); tax 10% of 50 = 5 → 80.
    expect(invoice.subtotal).toBe('75.00');
    expect(invoice.taxAmount).toBe('5.00');
    expect(invoice.total).toBe('80.00');
    expect(updated.amountInvoiced).toBe('80.00');
    expect(updated.status).toBe('partial');
    expect(updated.convertedInvoiceId).toBeNull();

    const inv = await getInvoice(ctx, invoice.id);
    expect(inv.lines).toHaveLength(2);
    expect(inv.lines.map((l) => l.amount).sort()).toEqual(['25.00', '50.00']);
    expect(inv.lines.map((l) => l.quantity).sort()).toEqual(['0.5000', '0.5000']);
    expect(inv.lines.find((l) => l.description === 'Phase A')!.taxable).toBe(true);
    expect(inv.lines.find((l) => l.description === 'Phase B')!.taxable).toBe(false);
    expect(inv.memo).toContain(`Estimate #${est.estimateNumber}`);

    // Second pass: bill an explicit amount on Phase A only.
    const full = await getEstimate(ctx, est.id);
    const phaseA = full.lines.find((l) => l.description === 'Phase A')!;
    expect(phaseA.amountInvoiced).toBe('50.00');
    expect(phaseA.percentInvoiced).toBe('50.00');
    const { invoice: inv2, estimate: afterSecond } = await createProgressInvoice(ctx, est.id, {
      lineAmounts: [{ lineId: phaseA.id, amount: '30.00' }],
      date: new Date('2025-05-04'),
    });
    expect(inv2.total).toBe('33.00'); // 30 + 10% tax
    expect(afterSecond.amountInvoiced).toBe('113.00');
    expect(afterSecond.status).toBe('partial');

    // Billing past 100% of Phase A (50 + 30 + 60 > 100) is a warning the user must confirm.
    await expect(
      createProgressInvoice(ctx, est.id, {
        lineAmounts: [{ lineId: phaseA.id, amount: '60.00' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { warning: 'PROGRESS_OVERBILL' } });

    // convertToInvoice is blocked once progress billing started.
    await expect(convertToInvoice(ctx, est.id)).rejects.toMatchObject({ code: 'CONFLICT' });

    // Partial estimates can't have their status flipped.
    await expect(updateEstimateStatus(ctx, est.id, 'rejected')).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    // Bill everything that is left (A: 20 taxable, B: 25) → estimate closes.
    const { invoice: finalInv, estimate: closed } = await createProgressInvoice(ctx, est.id, {
      remaining: true,
      date: new Date('2025-05-05'),
    });
    expect(finalInv.total).toBe('47.00');
    expect(closed.amountInvoiced).toBe('160.00');
    expect(closed.status).toBe('closed');
    expect(closed.convertedInvoiceId).toBe(finalInv.id);

    // No further billing.
    await expect(createProgressInvoice(ctx, est.id, { percent: 10 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const tb = await trialBalance(ctx, new Date('2025-12-31'));
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it('validates percent bounds and requires a mode', async () => {
    const est = await createEstimate(ctx, {
      customerId,
      date: new Date('2025-05-06'),
      lines: [{ description: 'Work', quantity: 1, rate: 100 }],
    });
    await expect(createProgressInvoice(ctx, est.id, { percent: 0 })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(createProgressInvoice(ctx, est.id, { percent: 101 })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(createProgressInvoice(ctx, est.id, {})).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('cannot progress-invoice a rejected estimate', async () => {
    const est = await createEstimate(ctx, {
      customerId,
      date: new Date('2025-05-07'),
      lines: [{ description: 'Nope', quantity: 1, rate: 10 }],
    });
    await updateEstimateStatus(ctx, est.id, 'rejected');
    await expect(createProgressInvoice(ctx, est.id, { percent: 50 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('full conversion stamps amountInvoiced to the estimate total', async () => {
    const est = await createEstimate(ctx, {
      customerId,
      date: new Date('2025-05-08'),
      lines: [{ description: 'One-shot', quantity: 1, rate: 250 }],
    });
    await convertToInvoice(ctx, est.id);
    const [row] = await db.select().from(estimates).where(eq(estimates.id, est.id));
    expect(row.status).toBe('closed');
    expect(row.amountInvoiced).toBe('250.00');
  });
});
