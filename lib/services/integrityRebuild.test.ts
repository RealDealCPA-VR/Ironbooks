/**
 * Tests for the Rebuild Data utility (lib/services/integrity.ts).
 *
 * Seeds a company, deliberately corrupts each class of cached value, then
 * asserts that:
 *   - previewRebuild is a true dry-run (reports the drift, writes nothing)
 *   - applyRebuild repairs the drift, is idempotent, and is audited
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  auditLogs,
  bills,
  companies,
  customers,
  inventoryLayers,
  invoices,
  items,
  users,
  vendors,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { writeAudit } from './_base';
import { createAccount } from './accounts';
import { postJournalEntry } from './posting';
import { applyRebuild, previewRebuild, verifyIntegrity } from './integrity';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-integrity-rebuild');

let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};

describe('integrity — Rebuild Data', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db
      .insert(users)
      .values({ email: 'rebuild@test.local', name: 'Rebuild', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Rebuild Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1200', 'Accounts Receivable', 'asset', 'accounts_receivable'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    await postJournalEntry(ctx, {
      date: new Date('2026-01-10'),
      description: 'Cash sale',
      lines: [
        { accountId: acct['1000'], debit: '500.00' },
        { accountId: acct['4000'], credit: '500.00' },
      ],
    });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // account_balances
  // -------------------------------------------------------------------------

  it('account_balances: preview reports drift without writing, apply repairs it', async () => {
    // Since 0017 the database refuses a corrupted cached balance outright…
    await expect(
      db.update(accounts).set({ balance: '123.45' }).where(eq(accounts.id, acct['1000'])),
    ).rejects.toThrow(/derived from the ledger/);

    // …so simulate LEGACY drift (a file written before the guard existed) by bypassing
    // triggers for one transaction (replica mode — test-only; the app never does this).
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.update(accounts).set({ balance: '123.45' }).where(eq(accounts.id, acct['1000']));
    });

    const preview = await previewRebuild(ctx, 'account_balances');
    expect(preview.count).toBe(1);
    expect(preview.fixes[0].label).toBe('Account 1000');
    expect(preview.fixes[0].expected).toContain('500.00');

    // Preview wrote nothing.
    const [stillBad] = await db.select().from(accounts).where(eq(accounts.id, acct['1000']));
    expect(stillBad.balance).toBe('123.45');

    const result = await applyRebuild(ctx, 'account_balances');
    expect(result.fixed).toBe(1);

    const [fixed] = await db.select().from(accounts).where(eq(accounts.id, acct['1000']));
    expect(fixed.balance).toBe('500.00');

    // Idempotent: second apply finds nothing.
    const again = await applyRebuild(ctx, 'account_balances');
    expect(again.fixed).toBe(0);

    // The verify check now passes.
    const verify = await verifyIntegrity(ctx);
    const balCheck = verify.checks.find((c) => c.name === 'Cached account balances match GL')!;
    expect(balCheck.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // document_balances
  // -------------------------------------------------------------------------

  it('document_balances: recomputes invoice balanceDue and bill amountPaid/balanceDue', async () => {
    const [customer] = await db
      .insert(customers)
      .values({ companyId: ctx.companyId, displayName: 'Drift Customer' })
      .returning();
    // Invoice with a corrupted balanceDue (should be total - amountPaid = 100).
    const [invoice] = await db
      .insert(invoices)
      .values({
        companyId: ctx.companyId,
        customerId: customer.id,
        invoiceNumber: 77,
        date: new Date('2026-02-01'),
        status: 'open',
        subtotal: '100.00',
        total: '100.00',
        amountPaid: '0.00',
        balanceDue: '40.00', // drift
      })
      .returning();

    const [vendor] = await db
      .insert(vendors)
      .values({ companyId: ctx.companyId, displayName: 'Drift Vendor' })
      .returning();
    // Bill claims 50.00 paid but has NO payment applications → truth is 0 paid.
    const [bill] = await db
      .insert(bills)
      .values({
        companyId: ctx.companyId,
        vendorId: vendor.id,
        billNumber: 'B-9',
        date: new Date('2026-02-02'),
        status: 'partial',
        total: '200.00',
        amountPaid: '50.00', // drift
        balanceDue: '150.00', // drift
      })
      .returning();

    const preview = await previewRebuild(ctx, 'document_balances');
    expect(preview.count).toBe(2);
    expect(preview.fixes.some((f) => f.label === 'Invoice #77')).toBe(true);
    expect(preview.fixes.some((f) => f.label === 'Bill B-9')).toBe(true);

    const result = await applyRebuild(ctx, 'document_balances');
    expect(result.fixed).toBe(2);

    const [fixedInvoice] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(fixedInvoice.balanceDue).toBe('100.00');
    expect(fixedInvoice.status).toBe('open');

    const [fixedBill] = await db.select().from(bills).where(eq(bills.id, bill.id));
    expect(fixedBill.amountPaid).toBe('0.00');
    expect(fixedBill.balanceDue).toBe('200.00');
    expect(fixedBill.status).toBe('open');

    // Idempotent.
    const again = await applyRebuild(ctx, 'document_balances');
    expect(again.fixed).toBe(0);
  });

  // -------------------------------------------------------------------------
  // item_quantities
  // -------------------------------------------------------------------------

  it('item_quantities: resets quantityOnHand to the sum of FIFO layers', async () => {
    const [item] = await db
      .insert(items)
      .values({
        companyId: ctx.companyId,
        name: 'Drift Widget',
        type: 'inventory',
        quantityOnHand: '5', // drift — layers below sum to 3
      })
      .returning();
    await db.insert(inventoryLayers).values([
      {
        companyId: ctx.companyId,
        itemId: item.id,
        date: new Date('2026-01-05'),
        quantityRemaining: '2',
        unitCost: '10.0000',
      },
      {
        companyId: ctx.companyId,
        itemId: item.id,
        date: new Date('2026-01-06'),
        quantityRemaining: '1',
        unitCost: '11.0000',
      },
    ]);

    const preview = await previewRebuild(ctx, 'item_quantities');
    expect(preview.count).toBe(1);
    expect(preview.fixes[0].label).toBe('Item Drift Widget');
    expect(preview.fixes[0].expected).toContain('3.0000');

    const result = await applyRebuild(ctx, 'item_quantities');
    expect(result.fixed).toBe(1);

    const [fixed] = await db.select().from(items).where(eq(items.id, item.id));
    expect(Number(fixed.quantityOnHand)).toBe(3);

    const again = await applyRebuild(ctx, 'item_quantities');
    expect(again.fixed).toBe(0);
  });

  // -------------------------------------------------------------------------
  // orphaned_audit_refs
  // -------------------------------------------------------------------------

  it('orphaned_audit_refs: deletes dangling refs but keeps legitimate deletion history', async () => {
    // Orphan: a 'create' audit row for a customer that does not exist and was
    // never recorded as deleted — genuine data damage.
    const orphanEntityId = randomUUID();
    await writeAudit(ctx, {
      action: 'create',
      entityType: 'customer',
      entityId: orphanEntityId,
      newValues: { displayName: 'Ghost' },
    });

    // Legitimate history: an entity that is gone but HAS a delete record — both
    // its create and delete rows must be preserved (that IS the audit trail).
    const deletedEntityId = randomUUID();
    await writeAudit(ctx, {
      action: 'create',
      entityType: 'customer',
      entityId: deletedEntityId,
      newValues: { displayName: 'Was Here' },
    });
    await writeAudit(ctx, {
      action: 'delete',
      entityType: 'customer',
      entityId: deletedEntityId,
      oldValues: { displayName: 'Was Here' },
    });

    const preview = await previewRebuild(ctx, 'orphaned_audit_refs');
    expect(preview.count).toBe(1);
    expect(preview.fixes[0].current).toContain(orphanEntityId);

    const result = await applyRebuild(ctx, 'orphaned_audit_refs');
    expect(result.fixed).toBe(1);

    // Orphan gone; deletion history intact.
    const remaining = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'customer')));
    expect(remaining.some((r) => r.entityId === orphanEntityId)).toBe(false);
    expect(remaining.filter((r) => r.entityId === deletedEntityId)).toHaveLength(2);

    const again = await applyRebuild(ctx, 'orphaned_audit_refs');
    expect(again.fixed).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Audit trail of the rebuild itself
  // -------------------------------------------------------------------------

  it('every applied rebuild batch is recorded in the audit trail', async () => {
    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'data_rebuild')));
    // One audit row per rebuild batch that actually fixed something (4 actions above).
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const actions = rows.map((r) => (r.newValues as { rebuildAction?: string })?.rebuildAction);
    expect(actions).toContain('account_balances');
    expect(actions).toContain('document_balances');
    expect(actions).toContain('item_quantities');
    expect(actions).toContain('orphaned_audit_refs');
  });
});
