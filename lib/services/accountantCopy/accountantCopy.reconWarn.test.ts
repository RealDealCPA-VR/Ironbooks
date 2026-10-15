/**
 * Accountant's Copy (PARITY I1): reconciliations the CLIENT had already started when the copy was
 * made. Their session stays in the client's file, so what the accountant does to them in the copy
 * can't travel — it must not be dropped silently either:
 *  - cleared / uncleared marks (or the statement) changed in the copy → a warning;
 *  - cancelled in the copy → a warning;
 *  - left untouched → no warning.
 * The warnings are shown on the accountant's export and in the client's review.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, users } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createBankAccount } from '../bankAccounts';
import { createManualEntry } from '../journal';
import { cancelReconciliation, listClearable, startReconciliation, toggleCleared } from '../reconcile';
import { trialBalance } from '../reports';
import { createAccountantCopy, importChangesFile, reviewChangesFile } from './client';
import { accountantChanges, exportChangesFile, openAccountantCopyFile } from './accountant';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-acctcopy-reconwarn');
const CLIENT_DIR = path.join(ROOT, 'client');
const ACCT_DIR = path.join(ROOT, 'accountant');
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

let db: DB;
let ctx: ServiceContext;
let actx: ServiceContext;
const acct: Record<string, string> = {};
const bank: Record<string, string> = {};
const recon: Record<string, string> = {};
let changes: Buffer;

describe("Accountant's Copy — the client's unfinished reconciliations", () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(CLIENT_DIR);
    const [user] = await db.insert(users).values({ email: 'reconwarn@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Recon Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
    bank.checking = (await createBankAccount(ctx, { accountId: acct['1000'], bankName: 'First Bank', accountNumber: '111111111' })).id;
    bank.savings = (await createBankAccount(ctx, { accountId: acct['1010'], bankName: 'First Bank', accountNumber: '222222222' })).id;
    await createManualEntry(ctx, {
      date: d('2026-01-05'),
      description: 'Owner investment',
      lines: [{ accountId: acct['1000'], debit: '1000.00' }, { accountId: acct['1010'], debit: '500.00' }, { accountId: acct['3000'], credit: '1500.00' }],
    });
    // Both started by the client, neither finished.
    recon.checking = (await startReconciliation(ctx, { bankAccountId: bank.checking, statementDate: d('2026-01-31'), statementBalance: '1000.00' })).id;
    recon.savings = (await startReconciliation(ctx, { bankAccountId: bank.savings, statementDate: d('2026-01-31'), statementBalance: '500.00' })).id;
  }, 120_000);

  afterAll(async () => {
    for (const dir of [CLIENT_DIR, ACCT_DIR]) await closeDb(dir).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('accountant: untouched in-progress reconciliations raise no warning', async () => {
    const transfer = (await createAccountantCopy(ctx, { dividingDate: '2026-03-31', dataDir: CLIENT_DIR })).buffer;
    await openAccountantCopyFile(transfer, ACCT_DIR);
    actx = { db: await getDb(ACCT_DIR), companyId: ctx.companyId, userId: ctx.userId };
    const c = await accountantChanges(actx);
    expect(c.reconciliations).toEqual([]);
    expect(c.warnings.filter((w) => /reconciliation/i.test(w))).toEqual([]);
  });

  it('accountant: marks cleared in one and the other cancelled are both reported, on export and in the review', async () => {
    const [line] = await listClearable(actx, bank.checking, d('2026-01-31'), recon.checking);
    await toggleCleared(actx, recon.checking, line.journalEntryLineId, true);
    await cancelReconciliation(actx, recon.savings);

    const c = await accountantChanges(actx);
    expect(c.reconciliations).toEqual([]);
    const text = c.warnings.join(' ');
    expect(text).toMatch(/statement ending 2026-01-31 that was already in progress when this copy was made had transactions cleared or uncleared/);
    expect(text).toMatch(/statement ending 2026-01-31 that was already in progress when this copy was made was cancelled in this copy/);

    changes = (await exportChangesFile(actx, { note: 'See the reconciliation notes.' })).buffer;
    const review = await reviewChangesFile(ctx, changes);
    expect(review.warnings.join(' ')).toMatch(/had transactions cleared or uncleared/);
    expect(review.warnings.join(' ')).toMatch(/was cancelled in this copy/);
  });

  it('accountant: unclearing the mark again (back to the client’s state) clears the warning', async () => {
    const [line] = await listClearable(actx, bank.checking, d('2026-01-31'), recon.checking);
    await toggleCleared(actx, recon.checking, line.journalEntryLineId, false);
    const c = await accountantChanges(actx);
    expect(c.warnings.join(' ')).not.toMatch(/cleared or uncleared/);
    expect(c.warnings.join(' ')).toMatch(/was cancelled in this copy/);
  });

  it('client: the import leaves both of the client’s reconciliations in progress and the books balanced', async () => {
    const res = await importChangesFile(ctx, changes);
    expect(res.trialBalance.balanced).toBe(true);
    const tb = await trialBalance(ctx);
    expect(tb.rows.find((r) => r.code === '1000')?.debit).toBe('1000.00');
    expect(tb.rows.find((r) => r.code === '3000')?.credit).toBe('1500.00');
  });
});
