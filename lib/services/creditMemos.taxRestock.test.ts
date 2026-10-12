/**
 * Integration tests for credit memo sales tax + inventory restocking.
 *
 * Covers the audit gaps:
 *   - "Sales tax is not computed on estimates or credit memos" (credit memo half):
 *     taxable lines x rate, penny-allocated, posting Dr 2200 Sales Tax Payable
 *     (reversing the invoice's tax direction).
 *   - Inventory restocking: credit memo lines referencing inventory items put
 *     quantity back on hand and post Dr Inventory / Cr COGS at current cost
 *     (average cost or a new FIFO layer), tagged sourceRef "creditmemo-cogs:<id>".
 *   - restock:false = damaged write-off (no restock, cost stays in COGS).
 *   - voidCreditMemo reverses the GL AND the restock, and refuses when the
 *     credit was applied/refunded or the restocked stock has since been sold.
 *
 * Uses a throwaway PGlite DB; trial balance must stay balanced after every mutation.
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
  taxAgencies,
  taxRates,
  inventoryLayers,
  journalEntries,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { trialBalance } from './reports';
import { adjustInventory, recordCOGS } from './inventory';
import { receiveStock } from './fifo';
import { Money } from '@/lib/money';
import {
  createCreditMemo,
  getCreditMemo,
  refundCreditMemo,
  voidCreditMemo,
} from './creditMemos';
import { salesTaxLiabilityNet } from './salesTax';
import { creditMemos } from '@/lib/db/schema';

const TEST_DIR = path.resolve(
  process.cwd(),
  '.bookkeeper-data',
  'test-credit-memos-tax-restock-' + Date.now(),
);

let ctx: ServiceContext;
let db: DB;

const acct: Record<string, string> = {};
let customerId: string;
let taxRateId: string;
let avgItemId: string; // average-cost inventory item (10 on hand @ $6 avg)
let fifoItemId: string; // FIFO-tracked inventory item (5 @ $4 + 5 @ $5)

async function balanceOf(code: string): Promise<string> {
  const [row] = await db
    .select({ balance: accounts.balance })
    .from(accounts)
    .where(eq(accounts.id, acct[code]));
  return row?.balance ?? '0.00';
}

async function qtyOnHand(itemId: string): Promise<string> {
  const [row] = await db
    .select({ q: items.quantityOnHand })
    .from(items)
    .where(eq(items.id, itemId));
  return Money.of(row?.q ?? '0').toFixed(4);
}

async function assertBalanced() {
  const tb = await trialBalance(ctx);
  expect(tb.balanced).toBe(true);
}

describe('Credit memos — sales tax + inventory restocking', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'cm-tax@test.local', name: 'CM Tax Owner', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'CM Tax Test Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['1300', 'Inventory Asset', 'asset', 'inventory'],
      ['2200', 'Sales Tax Payable', 'liability', 'other_current_liability'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['4100', 'Service Income', 'revenue', 'service_revenue'],
      ['5000', 'Cost of Goods Sold', 'expense', 'cost_of_goods_sold'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    const [cust] = await db
      .insert(customers)
      .values({ companyId: company.id, displayName: 'Returning Customer', taxable: true })
      .returning();
    customerId = cust.id;

    // Tax agency + 10% rate (easy math).
    const [agency] = await db
      .insert(taxAgencies)
      .values({ companyId: company.id, name: 'State Board', liabilityAccountId: acct['2200'] })
      .returning();
    const [tr] = await db
      .insert(taxRates)
      .values({
        companyId: company.id,
        name: 'Tax 10%',
        rate: '0.100000',
        agencyId: agency.id,
        isActive: true,
      })
      .returning();
    taxRateId = tr.id;

    // Average-cost item: 10 on hand @ $6.
    const [avgItem] = await db
      .insert(items)
      .values({
        companyId: company.id,
        name: 'Avg Widget',
        type: 'inventory',
        salesPrice: '20.00',
        incomeAccountId: acct['4000'],
        quantityOnHand: '0',
        averageCost: '0',
      })
      .returning();
    avgItemId = avgItem.id;
    await adjustInventory(ctx, {
      itemId: avgItemId,
      quantityChange: 10,
      unitCost: 6,
      date: new Date('2025-01-01'),
    });

    // FIFO item: 5 @ $4 + 5 @ $5 (blended remaining cost $4.50).
    const [fifoItem] = await db
      .insert(items)
      .values({
        companyId: company.id,
        name: 'FIFO Gadget',
        type: 'inventory',
        salesPrice: '15.00',
        incomeAccountId: acct['4000'],
        quantityOnHand: '0',
      })
      .returning();
    fifoItemId = fifoItem.id;
    await receiveStock(ctx, { itemId: fifoItemId, quantity: 5, unitCost: 4, date: new Date('2025-01-02') });
    await receiveStock(ctx, { itemId: fifoItemId, quantity: 5, unitCost: 5, date: new Date('2025-01-03') });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Sales tax computation + GL direction
  // ---------------------------------------------------------------------------
  it('computes tax on taxable lines only and debits Sales Tax Payable', async () => {
    const taxBefore = await balanceOf('2200');
    const arBefore = await balanceOf('1200');
    const incBefore = await balanceOf('4000');

    const memo = await createCreditMemo(ctx, {
      customerId,
      date: new Date('2025-03-01'),
      taxRateId,
      lines: [
        { accountId: acct['4000'], description: 'Taxable goods return', quantity: 1, rate: 100, taxable: true },
        { accountId: acct['4100'], description: 'Exempt service credit', quantity: 1, rate: 50, taxable: false },
      ],
    });

    // taxable base 100 @ 10% = 10.00; total = 150 + 10 = 160
    expect(memo.subtotal).toBe('150.00');
    expect(memo.taxAmount).toBe('10.00');
    expect(memo.total).toBe('160.00');
    expect(memo.unapplied).toBe('160.00');
    expect(memo.postedEntryId).toBeTruthy();

    // Liability account is debited — balance drops by the tax amount
    // (the exact reverse of an invoice's Cr 2200).
    const taxAfter = await balanceOf('2200');
    expect(taxAfter).toBe(Money.of(taxBefore).minus(10).toFixed(2));

    // A/R credited for the FULL total (incl. tax), income debited by subtotal portions.
    const arAfter = await balanceOf('1200');
    expect(arAfter).toBe(Money.of(arBefore).minus(160).toFixed(2));
    const incAfter = await balanceOf('4000');
    expect(incAfter).toBe(Money.of(incBefore).minus(100).toFixed(2));

    await assertBalanced();
  });

  it('charges no tax when no taxRateId is given (back-compat)', async () => {
    const taxBefore = await balanceOf('2200');

    const memo = await createCreditMemo(ctx, {
      customerId,
      date: new Date('2025-03-02'),
      lines: [{ accountId: acct['4000'], quantity: 2, rate: '25.00' }],
    });

    expect(memo.subtotal).toBe('50.00');
    expect(memo.taxAmount).toBe('0.00');
    expect(memo.total).toBe('50.00');
    expect(await balanceOf('2200')).toBe(taxBefore);
    await assertBalanced();
  });

  it('penny-allocates tax across income accounts without unbalancing the entry', async () => {
    // Awkward amounts: 3 x 33.33 = 99.99 taxable; 10% tax = 10.00 (rounded from 9.999)
    const memo = await createCreditMemo(ctx, {
      customerId,
      date: new Date('2025-03-03'),
      taxRateId,
      lines: [
        { accountId: acct['4000'], quantity: 1, rate: '33.33' },
        { accountId: acct['4100'], quantity: 1, rate: '33.33' },
        { accountId: acct['4000'], quantity: 1, rate: '33.33' },
      ],
    });

    expect(memo.subtotal).toBe('99.99');
    expect(memo.taxAmount).toBe('10.00');
    expect(memo.total).toBe('109.99');
    await assertBalanced();
  });

  it('rejects an unknown tax rate', async () => {
    await expect(
      createCreditMemo(ctx, {
        customerId,
        date: new Date('2025-03-03'),
        taxRateId: '00000000-0000-0000-0000-000000000000',
        lines: [{ quantity: 1, rate: 10 }],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // ---------------------------------------------------------------------------
  // Inventory restocking — average cost
  // ---------------------------------------------------------------------------
  it('restocks an average-cost item and reverses COGS at average cost', async () => {
    const cogsBefore = await balanceOf('5000');
    const invBefore = await balanceOf('1300');
    expect(await qtyOnHand(avgItemId)).toBe('10.0000');

    const memo = await createCreditMemo(ctx, {
      customerId,
      date: new Date('2025-03-04'),
      lines: [{ itemId: avgItemId, description: 'Returned widgets', quantity: 2, rate: 20 }],
    });

    // Income reversal: 2 x $20 = $40; restock 2 @ avg $6 = $12 Dr Inventory / Cr COGS.
    expect(memo.total).toBe('40.00');
    expect(await qtyOnHand(avgItemId)).toBe('12.0000');
    expect(await balanceOf('5000')).toBe(Money.of(cogsBefore).minus(12).toFixed(2));
    expect(await balanceOf('1300')).toBe(Money.of(invBefore).plus(12).toFixed(2));

    // The restock entry is tagged with the creditmemo-cogs sourceRef.
    const tagged = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.sourceRef, `creditmemo-cogs:${memo.id}`),
        ),
      );
    expect(tagged.length).toBe(1);
    expect(tagged[0].status).toBe('posted');

    // Line ids are persisted with the item reference for void traceability.
    const full = await getCreditMemo(ctx, memo.id);
    expect(full.lines[0].itemId).toBe(avgItemId);
    expect(tagged[0].reference).toBe(full.lines[0].id);

    await assertBalanced();
  });

  // ---------------------------------------------------------------------------
  // Inventory restocking — FIFO layer
  // ---------------------------------------------------------------------------
  it('restocks a FIFO item with a new layer at the blended remaining cost', async () => {
    const cogsBefore = await balanceOf('5000');
    const invBefore = await balanceOf('1300');
    expect(await qtyOnHand(fifoItemId)).toBe('10.0000');

    const memo = await createCreditMemo(ctx, {
      customerId,
      date: new Date('2025-03-05'),
      lines: [{ itemId: fifoItemId, description: 'Returned gadgets', quantity: 2, rate: 15 }],
    });

    // Blended remaining cost = (5*4 + 5*5) / 10 = $4.50 → restock value $9.00.
    expect(await qtyOnHand(fifoItemId)).toBe('12.0000');
    expect(await balanceOf('5000')).toBe(Money.of(cogsBefore).minus(9).toFixed(2));
    expect(await balanceOf('1300')).toBe(Money.of(invBefore).plus(9).toFixed(2));

    // A new layer exists for the returned units at $4.50.
    const layers = await db
      .select()
      .from(inventoryLayers)
      .where(
        and(eq(inventoryLayers.companyId, ctx.companyId), eq(inventoryLayers.itemId, fifoItemId)),
      );
    const restockLayer = layers.find((l) => l.unitCost === '4.5000');
    expect(restockLayer).toBeTruthy();
    expect(Money.of(restockLayer!.quantityRemaining).toFixed(4)).toBe('2.0000');

    // Clean up: void so later tests see pristine FIFO stock.
    await voidCreditMemo(ctx, memo.id);
    expect(await qtyOnHand(fifoItemId)).toBe('10.0000');
    await assertBalanced();
  });

  // ---------------------------------------------------------------------------
  // Damaged write-off (restock: false)
  // ---------------------------------------------------------------------------
  it('skips restocking for damaged write-off lines (restock: false)', async () => {
    const cogsBefore = await balanceOf('5000');
    const invBefore = await balanceOf('1300');
    const qtyBefore = await qtyOnHand(avgItemId);

    const memo = await createCreditMemo(ctx, {
      customerId,
      date: new Date('2025-03-06'),
      lines: [
        { itemId: avgItemId, description: 'Damaged — do not restock', quantity: 1, rate: 20, restock: false },
      ],
    });

    // Revenue reversed but cost stays in COGS, stock untouched.
    expect(memo.total).toBe('20.00');
    expect(await qtyOnHand(avgItemId)).toBe(qtyBefore);
    expect(await balanceOf('5000')).toBe(cogsBefore);
    expect(await balanceOf('1300')).toBe(invBefore);

    const tagged = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.sourceRef, `creditmemo-cogs:${memo.id}`),
        ),
      );
    expect(tagged.length).toBe(0);
    await assertBalanced();
  });

  // ---------------------------------------------------------------------------
  // Void: reverses GL + restock
  // ---------------------------------------------------------------------------
  it('voidCreditMemo reverses tax, income, AND the restock', async () => {
    const taxBefore = await balanceOf('2200');
    const arBefore = await balanceOf('1200');
    const cogsBefore = await balanceOf('5000');
    const invBefore = await balanceOf('1300');
    const qtyBefore = await qtyOnHand(avgItemId);

    const memo = await createCreditMemo(ctx, {
      customerId,
      date: new Date('2025-03-07'),
      taxRateId,
      lines: [{ itemId: avgItemId, quantity: 3, rate: 20, taxable: true }],
    });
    expect(memo.taxAmount).toBe('6.00'); // 60 @ 10%
    expect(await qtyOnHand(avgItemId)).toBe(Money.of(qtyBefore).plus(3).toFixed(4));

    const voided = await voidCreditMemo(ctx, memo.id);
    expect(voided.status).toBe('void');
    expect(voided.unapplied).toBe('0.00');

    // Everything back where it started.
    expect(await balanceOf('2200')).toBe(taxBefore);
    expect(await balanceOf('1200')).toBe(arBefore);
    expect(await balanceOf('5000')).toBe(cogsBefore);
    expect(await balanceOf('1300')).toBe(invBefore);
    expect(await qtyOnHand(avgItemId)).toBe(qtyBefore);

    // Restock entry flipped to void.
    const tagged = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.sourceRef, `creditmemo-cogs:${memo.id}`),
        ),
      );
    expect(tagged.every((e) => e.status === 'void')).toBe(true);

    await assertBalanced();
  });

  // ---------------------------------------------------------------------------
  // Void guards
  // ---------------------------------------------------------------------------
  it('refuses to void a refunded credit memo', async () => {
    const memo = await createCreditMemo(ctx, {
      customerId,
      date: new Date('2025-03-08'),
      lines: [{ accountId: acct['4000'], quantity: 1, rate: 30 }],
    });
    await refundCreditMemo(ctx, {
      creditMemoId: memo.id,
      bankAccountId: acct['1000'],
      amount: '10.00',
      date: new Date('2025-03-08'),
    });

    await expect(voidCreditMemo(ctx, memo.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await assertBalanced();
  });

  it('refuses to void when the restocked stock has since been sold', async () => {
    // Start: avg item back at 10 on hand. Return 3 (restock → 13).
    const memo = await createCreditMemo(ctx, {
      customerId,
      date: new Date('2025-03-09'),
      lines: [{ itemId: avgItemId, quantity: 3, rate: 20 }],
    });
    const afterRestock = await qtyOnHand(avgItemId);

    // Sell almost everything so fewer than 3 remain on hand.
    const sellQty = Money.of(afterRestock).minus(2).toNumber();
    await recordCOGS(ctx, {
      itemId: avgItemId,
      quantity: sellQty,
      date: new Date('2025-03-10'),
    });
    expect(await qtyOnHand(avgItemId)).toBe('2.0000');

    await expect(voidCreditMemo(ctx, memo.id)).rejects.toMatchObject({ code: 'CONFLICT' });

    // Nothing was reversed by the failed void.
    expect(await qtyOnHand(avgItemId)).toBe('2.0000');
    const [m] = await db
      .select({ status: journalEntries.status })
      .from(journalEntries)
      .where(eq(journalEntries.id, memo.postedEntryId!));
    expect(m.status).toBe('posted');

    await assertBalanced();
  });

  // ---------------------------------------------------------------------------
  // salesTaxLiabilityNet — credit memo tax reduces the reported liability
  // ---------------------------------------------------------------------------
  it('salesTaxLiabilityNet nets credit-memo tax against invoice tax', async () => {
    // Expected credited tax = sum of taxAmount over all non-void memos.
    const rows = await db
      .select({ taxAmount: creditMemos.taxAmount, status: creditMemos.status })
      .from(creditMemos)
      .where(eq(creditMemos.companyId, ctx.companyId));
    const expectedCredited = rows
      .filter((r) => r.status !== 'void')
      .reduce((s, r) => s.plus(Money.of(r.taxAmount)), Money.of(0));

    const result = await salesTaxLiabilityNet(ctx);
    expect(result.taxCollected).toBe('0.00'); // no invoices in this DB
    expect(result.taxCredited).toBe(expectedCredited.toFixed(2));
    expect(result.netLiability).toBe(expectedCredited.negated().toFixed(2));
    // Sanity: this run definitely credited some tax back.
    expect(Number(result.taxCredited)).toBeGreaterThan(0);
  });
});
