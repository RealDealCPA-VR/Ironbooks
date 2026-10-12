/**
 * updateInvoice — integration tests.
 *
 * Verifies the QB-style "edit a saved invoice" flow:
 *  - Header + lines are replaced and totals recomputed; invoiceNumber and
 *    createdAt are preserved (the document keeps its identity).
 *  - The old journal entry is voided and a new one posted (GL stays balanced,
 *    A/R reflects only the new total).
 *  - Inventory (COGS) entries tagged invoice-cogs:<id> are voided, stock is
 *    restored, then re-consumed from the new lines.
 *  - Edits are blocked once payments are applied and on voided invoices.
 *  - The audit trail records old AND new values.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  customers,
  items,
  taxRates,
  auditLogs,
  journalEntries,
  invoiceLines,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { createInvoice, updateInvoice, getInvoice, voidInvoice, markPaidAmount } from './invoices';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-invoice-update');

let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let customerId: string;
let taxRateId: string;
let widgetId: string; // average-cost inventory item

async function balanceOf(code: string): Promise<string> {
  const [row] = await db.select().from(accounts).where(eq(accounts.id, acct[code]));
  return row.balance;
}

describe('updateInvoice', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'owner@invupd.test', name: 'Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Invoice Update Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['2200', 'Sales Tax Payable', 'liability', 'long_term_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    const [cust] = await db
      .insert(customers)
      .values({ companyId: company.id, displayName: 'Edit Me Inc', taxable: true })
      .returning();
    customerId = cust.id;

    const [rate] = await db
      .insert(taxRates)
      .values({ companyId: company.id, name: 'Tax 10%', rate: '0.100000' })
      .returning();
    taxRateId = rate.id;

    // Average-cost inventory item: 10 on hand at $5.
    const [widget] = await db
      .insert(items)
      .values({
        companyId: company.id,
        name: 'Widget',
        type: 'inventory',
        salesPrice: '25.00',
        incomeAccountId: acct['4000'],
        assetAccountId: acct['1300'],
        quantityOnHand: '10.0000',
        averageCost: '5.0000',
      })
      .returning();
    widgetId = widget.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('replaces lines + totals, preserves invoiceNumber/createdAt, and re-posts the GL', async () => {
    const created = await createInvoice(ctx, {
      customerId,
      date: new Date('2025-04-01'),
      taxRateId,
      lines: [
        { description: 'Design work', quantity: 10, rate: 100, taxable: true }, // 1000
        { description: 'Hosting', quantity: 1, rate: 50, taxable: false },      // 50
      ],
    });
    expect(created.total).toBe('1150.00'); // 1050 + 100 tax (on 1000)
    const oldEntryId = created.postedEntryId!;
    const arBefore = await balanceOf('1200');

    const updated = await updateInvoice(ctx, created.id, {
      customerId,
      date: new Date('2025-04-02'),
      taxRateId,
      memo: 'corrected quantities',
      lines: [
        { description: 'Design work (corrected)', quantity: 8, rate: 100, taxable: true }, // 800
      ],
    });

    // Identity preserved.
    expect(updated.invoiceNumber).toBe(created.invoiceNumber);
    expect(updated.createdAt.toISOString()).toBe(created.createdAt.toISOString());
    // Totals recomputed: 800 + 80 tax.
    expect(updated.subtotal).toBe('800.00');
    expect(updated.taxAmount).toBe('80.00');
    expect(updated.total).toBe('880.00');
    expect(updated.balanceDue).toBe('880.00');
    expect(updated.status).toBe('open');
    expect(updated.memo).toBe('corrected quantities');

    // Old entry voided, new entry posted.
    expect(updated.postedEntryId).not.toBe(oldEntryId);
    const [oldEntry] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, oldEntryId));
    expect(oldEntry.status).toBe('void');

    // A/R net change: -1150 (void) + 880 (repost) = -270.
    const arAfter = await balanceOf('1200');
    expect((Number(arAfter) - Number(arBefore)).toFixed(2)).toBe('-270.00');

    // Lines fully replaced.
    const fetched = await getInvoice(ctx, created.id);
    expect(fetched.lines).toHaveLength(1);
    expect(fetched.lines[0].description).toBe('Design work (corrected)');

    // Ledger still balanced.
    const tb = await trialBalance(ctx, new Date('2025-12-31'));
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it('reverses and re-posts COGS, restoring then re-consuming stock', async () => {
    // Sell 2 widgets @ $25 (COGS 2 * $5 = $10).
    const inv = await createInvoice(ctx, {
      customerId,
      date: new Date('2025-04-05'),
      lines: [{ itemId: widgetId, description: 'Widget', quantity: 2, rate: 25 }],
    });
    let [widget] = await db.select().from(items).where(eq(items.id, widgetId));
    expect(Number(widget.quantityOnHand)).toBe(8);
    const cogsAfterCreate = Number(await balanceOf('5000'));

    // Edit: now sell 5 widgets.
    await updateInvoice(ctx, inv.id, {
      customerId,
      date: new Date('2025-04-05'),
      lines: [{ itemId: widgetId, description: 'Widget', quantity: 5, rate: 25 }],
    });

    // Stock restored (+2) then re-consumed (-5): 10 - 5 = 5.
    [widget] = await db.select().from(items).where(eq(items.id, widgetId));
    expect(Number(widget.quantityOnHand)).toBe(5);

    // COGS net effect: -10 (void) + 25 (5 * $5) = +15 vs after create.
    const cogsAfterUpdate = Number(await balanceOf('5000'));
    expect((cogsAfterUpdate - cogsAfterCreate).toFixed(2)).toBe('15.00');

    // Exactly one POSTED cogs entry remains for this invoice.
    const cogsEntries = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.sourceRef, `invoice-cogs:${inv.id}`),
          eq(journalEntries.status, 'posted'),
        ),
      );
    expect(cogsEntries).toHaveLength(1);

    const tb = await trialBalance(ctx, new Date('2025-12-31'));
    expect(tb.totalDebit).toBe(tb.totalCredit);
  });

  it('edits a partly paid invoice but never below what has been applied (wave2 sales C1)', async () => {
    const inv = await createInvoice(ctx, {
      customerId,
      date: new Date('2025-04-10'),
      lines: [{ description: 'Service', quantity: 1, rate: 200 }],
    });
    await markPaidAmount(ctx, inv.id, '50.00');

    // Raising the invoice keeps the $50 applied and re-opens the rest.
    const edited = await updateInvoice(ctx, inv.id, {
      customerId,
      date: new Date('2025-04-10'),
      lines: [{ description: 'Service', quantity: 1, rate: 300 }],
    });
    expect(edited.total).toBe('300.00');
    expect(edited.amountPaid).toBe('50.00');
    expect(edited.balanceDue).toBe('250.00');
    expect(edited.status).toBe('partial');

    // Shrinking it below the applied $50 would break the payment — refused in plain language.
    await expect(
      updateInvoice(ctx, inv.id, {
        customerId,
        date: new Date('2025-04-10'),
        lines: [{ description: 'Service', quantity: 1, rate: 40 }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/cannot be less than that/) });
  });

  it('rejects edits to a voided invoice', async () => {
    const inv = await createInvoice(ctx, {
      customerId,
      date: new Date('2025-04-11'),
      lines: [{ description: 'Service', quantity: 1, rate: 75 }],
    });
    await voidInvoice(ctx, inv.id);

    await expect(
      updateInvoice(ctx, inv.id, {
        customerId,
        date: new Date('2025-04-11'),
        lines: [{ description: 'Service', quantity: 1, rate: 80 }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects a non-existent invoice', async () => {
    await expect(
      updateInvoice(ctx, '00000000-0000-0000-0000-000000000000', {
        customerId,
        date: new Date('2025-04-12'),
        lines: [{ description: 'x', quantity: 1, rate: 1 }],
      }),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it('writes an audit row carrying old and new values', async () => {
    const inv = await createInvoice(ctx, {
      customerId,
      date: new Date('2025-04-15'),
      lines: [{ description: 'Before', quantity: 1, rate: 100 }],
    });
    await updateInvoice(ctx, inv.id, {
      customerId,
      date: new Date('2025-04-16'),
      lines: [{ description: 'After', quantity: 2, rate: 150 }],
    });

    const logs = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, ctx.companyId),
          eq(auditLogs.entityType, 'invoice'),
          eq(auditLogs.entityId, inv.id),
          eq(auditLogs.action, 'update'),
        ),
      );
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const log = logs[logs.length - 1];
    const oldValues = log.oldValues as { total: string; lines: Array<{ description: string }> };
    const newValues = log.newValues as { total: string; lines: Array<{ description: string }> };
    expect(oldValues.total).toBe('100.00');
    expect(newValues.total).toBe('300.00');
    expect(oldValues.lines[0].description).toBe('Before');
    expect(newValues.lines[0].description).toBe('After');
  });

  it('still inserts replaced lines correctly (lineOrder + amounts)', async () => {
    const inv = await createInvoice(ctx, {
      customerId,
      date: new Date('2025-04-20'),
      lines: [{ description: 'one', quantity: 1, rate: 10 }],
    });
    await updateInvoice(ctx, inv.id, {
      customerId,
      date: new Date('2025-04-20'),
      lines: [
        { description: 'first', quantity: 1, rate: 10 },
        { description: 'second', quantity: 3, rate: 7 },
      ],
    });
    const lines = await db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, inv.id))
      .orderBy(invoiceLines.lineOrder);
    expect(lines).toHaveLength(2);
    expect(lines[0].amount).toBe('10.00');
    expect(lines[1].amount).toBe('21.00');
  });
});
