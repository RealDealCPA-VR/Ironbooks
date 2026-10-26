/**
 * Round-5 review regression (ledger guards): the database guard that refuses to void (or edit,
 * which voids) a journal entry whose customer / vendor lines have payments or credits applied
 * (0037) is a maintained ledger guard like the others:
 *  - it fires whatever `session_replication_role` says (ENABLE ALWAYS),
 *  - a file where it was dropped or switched off is reported by the ledger health check, and
 *  - opening the file (ensureLedgerGuards) puts it back.
 * It used to be named bk_*, so none of the three applied: raw SQL with the replication role set
 * to replica, or a file edited offline, could void such an entry and leave the applications
 * pointing at a dead entry (aging no longer matching A/R).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb, openDb, MIGRATIONS_FOLDER, type DB } from '@/lib/db';
import { companies, users } from '@/lib/db/schema';
import type { ServiceContext } from '@/lib/services/_base';
import { createAccount } from '@/lib/services/accounts';
import { createCustomer } from '@/lib/services/customers';
import { createManualEntry } from '@/lib/services/journal';
import { createInvoice } from '@/lib/services/invoices';
import { applyJournalCredit } from '@/lib/services/journalApplications';
import { verifyIntegrity } from '@/lib/services/integrity';
import { checkLedgerHealth, ensureLedgerGuards } from './ledgerGuards';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bka-ledger-r5-'));
const dir = path.join(ROOT, 'file');
let db: DB;
let ctx: ServiceContext;
let entryId: string;

const raw = async <T,>(text: string) => (await openDb(dir).client.query<T>(text)).rows;
/** The trigger(s) on journal_entries that run the journal-application void guard. */
const guardTriggers = () =>
  raw<{ tgname: string; tgenabled: string }>(
    `SELECT t.tgname, t.tgenabled FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = 'journal_entries'::regclass AND NOT t.tgisinternal
        AND p.proname LIKE '%guard_journal_item_applications%'`,
  );
const voidRaw = () => raw(`UPDATE journal_entries SET status = 'void' WHERE id = '${entryId}'`);

afterAll(async () => {
  await closeDb(dir).catch(() => undefined);
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('journal-application void guard is a maintained ledger guard (review round 5)', () => {
  beforeAll(async () => {
    db = await getDb(dir);
    const [user] = await db.insert(users).values({ email: 'r5@guards.test', name: 'Gus', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'Guards Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const ar = await createAccount(ctx, { code: '1200', name: 'Accounts Receivable', type: 'asset', subtype: 'accounts_receivable' });
    const sales = await createAccount(ctx, { code: '4000', name: 'Sales', type: 'revenue', subtype: 'sales' });
    await createAccount(ctx, { code: '2200', name: 'Sales Tax Payable', type: 'liability', subtype: 'other_current_liability' });
    const cust = await createCustomer(ctx, { displayName: 'Credit Co' } as never);
    // A General Journal credit to the customer, applied to one of their invoices.
    const je = await createManualEntry(ctx, {
      date: new Date('2026-02-01T00:00:00Z'),
      description: 'Goodwill credit',
      lines: [
        { accountId: sales.id, debit: '25.00' },
        { accountId: ar.id, credit: '25.00', entityType: 'customer', entityId: cust.id },
      ],
    });
    entryId = je.id;
    const inv = await createInvoice(ctx, {
      customerId: cust.id,
      date: new Date('2026-02-02T00:00:00Z'),
      lines: [{ accountId: sales.id, quantity: 1, rate: '100.00' }],
    } as never);
    const line = (await raw<{ id: string }>(`SELECT id FROM journal_entry_lines WHERE journal_entry_id = '${je.id}' AND credit IS NOT NULL`))[0];
    await applyJournalCredit(ctx, { journalLineId: line.id, invoiceId: inv.id, amount: '25.00', date: new Date('2026-02-02T00:00:00Z') });
  });

  it('is installed ENABLE ALWAYS and refuses the void even with session_replication_role = replica', async () => {
    const triggers = await guardTriggers();
    expect(triggers.length).toBe(1);
    expect(triggers[0].tgname.startsWith('bka_')).toBe(true);
    expect(triggers[0].tgenabled).toBe('A');
    await raw(`SET session_replication_role = replica`);
    try {
      await expect(voidRaw()).rejects.toThrow(/applied/);
    } finally {
      await raw(`SET session_replication_role = origin`);
    }
  });

  it('a file where it was dropped is reported (health check + Verify Data) and repaired on open', async () => {
    for (const t of await guardTriggers()) await raw(`DROP TRIGGER "${t.tgname}" ON journal_entries`);
    expect(await guardTriggers()).toEqual([]);

    const client = openDb(dir).client;
    const health = await checkLedgerHealth(client, MIGRATIONS_FOLDER);
    expect(health.problems.some((p) => p.kind === 'guards')).toBe(true);
    const verify = await verifyIntegrity(ctx);
    expect(verify.checks.find((c) => c.name === 'Database ledger guards active')?.ok).toBe(false);

    await ensureLedgerGuards(client, MIGRATIONS_FOLDER);
    expect((await guardTriggers()).map((t) => t.tgenabled)).toEqual(['A']);
    await expect(voidRaw()).rejects.toThrow(/applied/);
    expect((await checkLedgerHealth(client, MIGRATIONS_FOLDER)).problems).toEqual([]);
  });
});
