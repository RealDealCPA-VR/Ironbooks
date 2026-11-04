/**
 * Accountant fix round — I6 Batch Delete/Void: transfers, item receipts, inventory adjustments,
 * estimates, sales orders and purchase orders; deleting posted General Journal entries where QB
 * allows it; restoring deleted transactions. Symmetric (delete then restore gives the original
 * balances), audited, closing-date and record-lock aware.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { accounts, auditLogs, estimates, items, journalEntries, journalEntryLines, purchaseOrders, salesOrders } from '@/lib/db/schema';
import { createAccount } from '../accounts';
import { setAccountCurrency, upsertCurrency } from '../currencies';
import { updateCompany } from '../company';
import { updateEstimateStatus } from '../estimates';
import { setClosingDate } from '../company';
import { createCustomer } from '../customers';
import { createVendor } from '../vendors';
import { createItem } from '../items';
import { createTransfer } from '../transfers';
import { createItemReceipt } from '../itemReceipts';
import { adjustInventory } from '../inventory';
import { createEstimate } from '../estimates';
import { createSalesOrder } from '../salesOrders';
import { createPurchaseOrder } from '../purchaseOrders';
import { createInvoice } from '../invoices';
import { createManualEntry, listEntries } from '../journal';
import { trialBalance } from '../reports';
import {
  batchVoidTransactions,
  listBatchTransactions,
  listDeletedTransactions,
  restoreDeletedTransactions,
} from './batchVoid';
import { makeTestCompany, type TestCompany } from '../testkit.prefs';

let t: TestCompany;
let customerId: string;
let vendorId: string;
let stockItem: string;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const bal = async (code: string) => (await t.db.select().from(accounts).where(eq(accounts.id, t.acct[code])))[0].balance;
const keysOf = async (type?: string) =>
  (await listBatchTransactions(t.ctx, { from: d('2026-01-01'), to: d('2026-12-31'), type: (type ?? null) as never })).map((r) => r.key);

describe('I6 Batch Delete/Void', () => {
  beforeAll(async () => {
    t = await makeTestCompany('i6batch');
    customerId = (await createCustomer(t.ctx, { displayName: 'Delta Diner' })).id;
    vendorId = (await createVendor(t.ctx, { displayName: 'Parts Plus' })).id;
    stockItem = (
      await createItem(t.ctx, {
        name: 'Bolt',
        type: 'inventory',
        salesPrice: '2.00',
        purchaseCost: '1.00',
        incomeAccountId: t.acct['4000'],
      } as never)
    ).id;
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('voids a transfer', async () => {
    const savings = t.acct['1010'] ?? t.acct['1050'];
    const before = await bal('1000');
    const tr = await createTransfer(t.ctx, { date: d('2026-02-01'), fromAccountId: t.acct['1000'], toAccountId: savings, amount: '300.00' });
    expect(await keysOf('transfer')).toContain(`transfer:${(tr as { id: string }).id}`);
    const res = await batchVoidTransactions(t.ctx, [`transfer:${(tr as { id: string }).id}`]);
    expect(res.results[0]).toMatchObject({ ok: true, action: 'void' });
    expect(await bal('1000')).toBe(before);
  });

  it('voids an item receipt and an inventory adjustment (quantity and value go back)', async () => {
    const rc = await createItemReceipt(t.ctx, { vendorId, date: d('2026-02-02'), lines: [{ itemId: stockItem, quantity: '10', unitCost: '1.00' }] });
    const rid = (rc as { id: string }).id;
    expect(await keysOf('item_receipt')).toContain(`item_receipt:${rid}`);
    expect((await batchVoidTransactions(t.ctx, [`item_receipt:${rid}`])).results[0].ok).toBe(true);
    let [it] = await t.db.select().from(items).where(eq(items.id, stockItem));
    expect(Number(it.quantityOnHand)).toBe(0);

    const adj = await adjustInventory(t.ctx, { itemId: stockItem, quantityChange: '5', unitCost: '3.00', date: d('2026-02-03'), memo: 'Count' });
    const entryId = adj.entry!.id;
    expect(await keysOf('inventory_adjustment')).toContain(`inventory_adjustment:${entryId}`);
    const invBefore = await t.db.select().from(accounts).where(and(eq(accounts.companyId, t.ctx.companyId), eq(accounts.subtype, 'inventory' as never)));
    expect(invBefore.some((a) => a.balance === '15.00')).toBe(true);
    const res = await batchVoidTransactions(t.ctx, [`inventory_adjustment:${entryId}`]);
    expect(res.results[0]).toMatchObject({ ok: true });
    [it] = await t.db.select().from(items).where(eq(items.id, stockItem));
    expect(Number(it.quantityOnHand)).toBe(0);
    const invAfter = await t.db.select().from(accounts).where(and(eq(accounts.companyId, t.ctx.companyId), eq(accounts.subtype, 'inventory' as never)));
    expect(invAfter.every((a) => Number(a.balance) === 0)).toBe(true);
    expect((await trialBalance(t.ctx)).balanced).toBe(true);
  });

  it('voids and deletes estimates, sales orders and purchase orders; a deleted one can be restored', async () => {
    const est = (await createEstimate(t.ctx, { customerId, date: d('2026-03-01'), lines: [{ description: 'Quote', quantity: 2, rate: '50.00', taxable: false }] })) as { id: string };
    const so = (await createSalesOrder(t.ctx, { customerId, date: d('2026-03-01'), lines: [{ itemId: stockItem, quantity: 3, rate: '2.00', taxable: false }], taxRateId: null })) as { id: string };
    const po = (await createPurchaseOrder(t.ctx, { vendorId, date: d('2026-03-01'), lines: [{ itemId: stockItem, quantity: 4, rate: '1.00' }] })) as { id: string };
    const keys = await keysOf();
    expect(keys).toEqual(expect.arrayContaining([`estimate:${est.id}`, `sales_order:${so.id}`, `purchase_order:${po.id}`]));

    // Void the sales order; delete the estimate and the purchase order.
    expect((await batchVoidTransactions(t.ctx, [`sales_order:${so.id}`])).results[0].ok).toBe(true);
    expect((await t.db.select().from(salesOrders).where(eq(salesOrders.id, so.id)))[0].status).toBe('void');
    const del = await batchVoidTransactions(t.ctx, [`estimate:${est.id}`, `purchase_order:${po.id}`], { action: 'delete' });
    expect(del.results.every((r) => r.ok && r.action === 'delete')).toBe(true);
    expect(await t.db.select().from(estimates).where(eq(estimates.id, est.id))).toHaveLength(0);
    expect(await t.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, po.id))).toHaveLength(0);

    const deleted = await listDeletedTransactions(t.ctx);
    expect(deleted.map((x) => x.type).sort()).toEqual(['estimate', 'purchase_order']);
    const res = await restoreDeletedTransactions(t.ctx, deleted.map((x) => x.id));
    expect(res.restored).toBe(2);
    const newEst = await t.db.select().from(estimates).where(eq(estimates.id, res.results.find((r) => deleted.find((x) => x.id === r.id)!.type === 'estimate')!.newId!));
    expect(newEst[0].total).toBe('100.00');
    const newPo = await t.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, res.results.find((r) => deleted.find((x) => x.id === r.id)!.type === 'purchase_order')!.newId!));
    expect(newPo[0].total).toBe('4.00');
    // Restored once: gone from the list, and a second restore is refused.
    expect(await listDeletedTransactions(t.ctx)).toHaveLength(0);
    const again = await restoreDeletedTransactions(t.ctx, [deleted[0].id]);
    expect(again.results[0].ok).toBe(false);
  });

  it('deletes a posted General Journal entry (balances back, hidden from the Journal), and restore gives the original balances', async () => {
    const before6600 = await bal('6600');
    const je = (await createManualEntry(t.ctx, {
      date: d('2026-04-01'),
      description: 'Accrue rent',
      reference: 'ADJ-1',
      lines: [
        { accountId: t.acct['6600'], debit: '700.00', credit: null, memo: 'Rent' },
        { accountId: t.acct['1000'], debit: null, credit: '700.00', memo: 'Rent' },
      ],
    } as never)) as { id: string };
    const withJe6600 = await bal('6600');
    const withJe1000 = await bal('1000');
    const row = (await listBatchTransactions(t.ctx, { from: d('2026-04-01'), to: d('2026-04-01'), type: 'journal' })).find((r) => r.docId === je.id)!;
    expect(row.canDelete).toBe(true);
    const res = await batchVoidTransactions(t.ctx, [row.key], { action: 'delete', versions: { [row.key]: row.version } });
    expect(res.results[0]).toMatchObject({ ok: true, action: 'delete' });
    expect(await bal('6600')).toBe(before6600);
    expect((await listEntries(t.ctx, { limit: 500 })).some((e) => e.id === je.id)).toBe(false);
    const audit = await t.db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'journal_entry'), eq(auditLogs.entityId, je.id), eq(auditLogs.action, 'delete')));
    expect(audit).toHaveLength(1);

    const [snap] = (await listDeletedTransactions(t.ctx)).filter((x) => x.type === 'journal');
    expect(snap.amount).toBe('700.00');
    const restored = await restoreDeletedTransactions(t.ctx, [snap.id]);
    expect(restored.results[0].ok).toBe(true);
    expect(await bal('6600')).toBe(withJe6600);
    expect(await bal('1000')).toBe(withJe1000);
    const [newJe] = await t.db.select().from(journalEntries).where(eq(journalEntries.id, restored.results[0].newId!));
    expect(newJe.reference).toBe('ADJ-1');
    expect(newJe.date.toISOString().slice(0, 10)).toBe('2026-04-01');
    expect((await trialBalance(t.ctx)).balanced).toBe(true);
  });

  it('documents are voided, not deleted; record locking and the closing date are respected', async () => {
    const inv = (await createInvoice(t.ctx, { customerId, date: d('2026-05-01'), lines: [{ description: 'Meal', quantity: 1, rate: '10.00', taxable: false }] })) as { id: string };
    const r1 = await batchVoidTransactions(t.ctx, [`invoice:${inv.id}`], { action: 'delete' });
    expect(r1.results[0].ok).toBe(false);
    expect(r1.results[0].error).toMatch(/can't be deleted in a batch/);
    // A stale version (someone changed it since it was listed) is refused.
    const r2 = await batchVoidTransactions(t.ctx, [`invoice:${inv.id}`], { versions: { [`invoice:${inv.id}`]: '2001-01-01T00:00:00.000Z' } });
    expect(r2.results[0].ok).toBe(false);
    expect(r2.results[0].error).toMatch(/changed by/);

    const je = (await createManualEntry(t.ctx, {
      date: d('2026-01-15'),
      description: 'Old entry',
      lines: [
        { accountId: t.acct['6600'], debit: '5.00', credit: null },
        { accountId: t.acct['1000'], debit: null, credit: '5.00' },
      ],
    } as never)) as { id: string };
    await setClosingDate(t.ctx, { closingDate: '2026-01-31', password: 'pw' });
    const r3 = await batchVoidTransactions(t.ctx, [`journal:${je.id}`], { action: 'delete' });
    expect(r3.results[0].ok).toBe(false);
    const [still] = await t.db.select().from(journalEntries).where(eq(journalEntries.id, je.id));
    expect(still.status).toBe('posted');
    expect(still.deletedAt).toBeNull();
  });
  it('voiding an inventory adjustment keeps the item value equal to the GL when its asset account is not an "inventory" subtype (round 2)', async () => {
    const asset = (await createAccount(t.ctx, { code: '1390', name: 'Stock Held', type: 'asset', subtype: 'other_current_asset' } as never)).id;
    const nut = (await createItem(t.ctx, { name: 'Nut', type: 'inventory', salesPrice: '1.00', purchaseCost: '1.00', incomeAccountId: t.acct['4000'], assetAccountId: asset } as never)).id;
    const a1 = await adjustInventory(t.ctx, { itemId: nut, quantityChange: '4', unitCost: '2.50', date: d('2026-06-01') });
    await adjustInventory(t.ctx, { itemId: nut, quantityChange: '2', unitCost: '4.00', date: d('2026-06-02') });
    const res = await batchVoidTransactions(t.ctx, [`inventory_adjustment:${a1.entry!.id}`]);
    expect(res.results[0].ok).toBe(true);
    const [it] = await t.db.select().from(items).where(eq(items.id, nut));
    const [gl] = await t.db.select().from(accounts).where(eq(accounts.id, asset));
    expect(Number(it.quantityOnHand)).toBe(2);
    expect(gl.balance).toBe('8.00');
    // Item value (qty x average cost) equals the GL balance.
    expect((Number(it.quantityOnHand) * Number(it.averageCost)).toFixed(2)).toBe(gl.balance);
  });

  it('restore keeps a foreign-currency journal entry and an estimate status (round 2)', async () => {
    await updateCompany(t.ctx, { settings: { multiCurrencyEnabled: true } });
    await upsertCurrency(t.ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.20' });
    const eurBank = (await createAccount(t.ctx, { code: '1025', name: 'Euro Bank', type: 'asset', subtype: 'checking' } as never)).id;
    await setAccountCurrency(t.ctx, eurBank, 'EUR');
    const je = (await createManualEntry(t.ctx, {
      date: d('2026-07-01'),
      description: 'EUR capital',
      currency: 'EUR',
      exchangeRate: '1.25',
      lines: [
        { accountId: eurBank, debit: '125.00', foreignAmount: '100.00' },
        { accountId: t.acct['3000'], credit: '125.00' },
      ],
    } as never)) as { id: string };
    const before = await t.db.select().from(journalEntryLines).where(and(eq(journalEntryLines.journalEntryId, je.id), eq(journalEntryLines.accountId, eurBank)));
    expect(before[0].foreignAmount).toBe('100.00');
    expect((await batchVoidTransactions(t.ctx, [`journal:${je.id}`], { action: 'delete' })).results[0].ok).toBe(true);

    const est = (await createEstimate(t.ctx, { customerId, date: d('2026-07-02'), lines: [{ description: 'Quote', quantity: 1, rate: '30.00', taxable: false }] })) as { id: string };
    await updateEstimateStatus(t.ctx, est.id, 'accepted');
    expect((await batchVoidTransactions(t.ctx, [`estimate:${est.id}`], { action: 'delete' })).results[0].ok).toBe(true);

    const deleted = await listDeletedTransactions(t.ctx);
    const res = await restoreDeletedTransactions(t.ctx, deleted.map((x) => x.id));
    expect(res.results.every((r) => r.ok)).toBe(true);
    const newJe = res.results.find((r) => deleted.find((x) => x.id === r.id)!.type === 'journal')!.newId!;
    const after = await t.db.select().from(journalEntryLines).where(and(eq(journalEntryLines.journalEntryId, newJe), eq(journalEntryLines.accountId, eurBank)));
    expect(after[0]).toMatchObject({ debit: '125.00', currency: 'EUR', foreignAmount: '100.00' });
    expect(Number(after[0].exchangeRate)).toBe(1.25);
    const newEst = res.results.find((r) => deleted.find((x) => x.id === r.id)!.type === 'estimate')!.newId!;
    expect((await t.db.select().from(estimates).where(eq(estimates.id, newEst)))[0].status).toBe('accepted');
  });
});
