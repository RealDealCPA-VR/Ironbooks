/**
 * Integration tests for the journal-tools wave:
 *   - updateEntry   (edit a posted JE = void + repost atomically, period-checked)
 *   - reverseEntry  (one-click reversing entry, debits/credits swapped)
 *   - getEntry      (className via class join — Class column in EntryDetailModal)
 *   - mergeAccounts (same-type GL account merge: re-point FKs, recompute balance)
 *
 * Boots a throwaway PGlite instance and follows the journal.test.ts / merge.test.ts
 * pattern: seed user + company + chart, exercise services, assert the trial balance
 * stays balanced after every mutation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  classes,
  accounts as accountsTable,
  journalEntries,
  journalEntryLines,
  items,
  transactionRules,
  auditLogs,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount, getAccount, getAccountTree } from './accounts';
import { postJournalEntry } from './posting';
import { trialBalance } from './reports';
import {
  createManualEntry,
  getEntry,
  updateEntry,
  reverseEntry,
  defaultReversalDate,
} from './journal';
import { mergeAccounts } from './merge';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-journal-tools');
let db: DB;
let ctx: ServiceContext;
let ctx2: ServiceContext; // second company for tenancy guards
const acct: Record<string, string> = {};
let classId: string;

describe('journal tools (updateEntry / reverseEntry / mergeAccounts)', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'jt@test.local', name: 'JT', passwordHash: 'x' })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: 'Journal Tools Co', ownerId: user.id })
      .returning();
    ctx = { db, companyId: company.id, userId: user.id };

    const [company2] = await db
      .insert(companies)
      .values({ name: 'Other Co', ownerId: user.id })
      .returning();
    ctx2 = { db, companyId: company2.id, userId: user.id };

    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['3000', "Owner's Equity", 'equity', 'owners_equity'],
      ['4000', 'Sales Income', 'revenue', 'sales'],
      ['6000', 'Advertising', 'expense', 'operating_expenses'],
      ['6001', 'Advertizing (dupe)', 'expense', 'operating_expenses'],
      ['6002', 'Ads — Online', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      const row = await createAccount(ctx, { code, name, type: type as never, subtype });
      acct[code] = row.id;
    }

    const [cls] = await db
      .insert(classes)
      .values({ companyId: company.id, name: 'Marketing' })
      .returning();
    classId = cls.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // getEntry — className via class join
  // -------------------------------------------------------------------------

  it('getEntry returns classId + className for class-tagged lines', async () => {
    const entry = await createManualEntry(ctx, {
      date: new Date('2025-04-01'),
      description: 'Class-tagged spend',
      lines: [
        { accountId: acct['6000'], debit: '50.00', classId, memo: 'banner ads' },
        { accountId: acct['1000'], credit: '50.00' },
      ],
    });
    const detail = await getEntry(ctx, entry.id);
    const tagged = detail.lines.find((l) => l.debit !== null);
    expect(tagged?.classId).toBe(classId);
    expect(tagged?.className).toBe('Marketing');
    expect(tagged?.memo).toBe('banner ads');
    const untagged = detail.lines.find((l) => l.credit !== null);
    expect(untagged?.classId).toBeNull();
    expect(untagged?.className).toBeNull();
  });

  // -------------------------------------------------------------------------
  // updateEntry
  // -------------------------------------------------------------------------

  let originalId: string;
  let replacementId: string;

  it('edits a posted entry: voids original, posts replacement, balances stay correct', async () => {
    const original = await createManualEntry(ctx, {
      date: new Date('2025-05-01'),
      description: 'Owner investment',
      reference: 'OWN-1',
      lines: [
        { accountId: acct['1000'], debit: '1000.00' },
        { accountId: acct['3000'], credit: '1000.00' },
      ],
    });
    originalId = original.id;

    const replacement = await updateEntry(ctx, originalId, {
      date: new Date('2025-05-02'),
      description: 'Owner investment (corrected)',
      reference: 'OWN-1R',
      lines: [
        { accountId: acct['1000'], debit: '1500.00', memo: 'corrected amount' },
        { accountId: acct['3000'], credit: '1500.00' },
      ],
    });
    replacementId = replacement.id;

    expect(replacement.id).not.toBe(originalId);
    expect(replacement.status).toBe('posted');
    expect(replacement.description).toBe('Owner investment (corrected)');
    expect(replacement.reference).toBe('OWN-1R');

    // Original is voided, not deleted.
    const oldDetail = await getEntry(ctx, originalId);
    expect(oldDetail.status).toBe('void');

    // Cached balance reflects only the corrected amount (plus the earlier $50 credit).
    const checking = await getAccount(ctx, acct['1000']);
    expect(checking.balance).toBe('1450.00'); // -50 (class test) + 1500

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('writes an audit row linking old → new', async () => {
    const rows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, 'journal_entry'),
          eq(auditLogs.entityId, originalId),
          eq(auditLogs.action, 'update'),
        ),
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const newValues = rows[rows.length - 1].newValues as { replacedBy?: string };
    expect(newValues.replacedBy).toBe(replacementId);
  });

  it('rejects editing an already-voided entry', async () => {
    await expect(
      updateEntry(ctx, originalId, {
        date: new Date('2025-05-03'),
        description: 'No can do',
        lines: [
          { accountId: acct['1000'], debit: '1.00' },
          { accountId: acct['3000'], credit: '1.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects editing a document-sourced entry (must edit the source document)', async () => {
    const docEntry = await postJournalEntry(ctx, {
      date: new Date('2025-05-04'),
      description: 'Invoice posting',
      sourceRef: 'invoice:00000000-0000-0000-0000-00000000abcd',
      lines: [
        { accountId: acct['1000'], debit: '300.00' },
        { accountId: acct['4000'], credit: '300.00' },
      ],
    });
    await expect(
      updateEntry(ctx, docEntry.id, {
        date: new Date('2025-05-04'),
        description: 'Tamper',
        lines: [
          { accountId: acct['1000'], debit: '1.00' },
          { accountId: acct['4000'], credit: '1.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects unbalanced replacement lines (nothing is voided)', async () => {
    const entry = await createManualEntry(ctx, {
      date: new Date('2025-05-05'),
      description: 'To stay intact',
      lines: [
        { accountId: acct['6000'], debit: '20.00' },
        { accountId: acct['1000'], credit: '20.00' },
      ],
    });
    await expect(
      updateEntry(ctx, entry.id, {
        date: new Date('2025-05-05'),
        description: 'Unbalanced edit',
        lines: [
          { accountId: acct['6000'], debit: '20.00' },
          { accountId: acct['1000'], credit: '10.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'UNBALANCED' });

    // The transaction rolled back — the original is still posted.
    const detail = await getEntry(ctx, entry.id);
    expect(detail.status).toBe('posted');
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('rejects updateEntry across companies (NOT_FOUND)', async () => {
    await expect(
      updateEntry(ctx2, replacementId, {
        date: new Date('2025-05-06'),
        description: 'Cross-tenant edit',
        lines: [
          { accountId: acct['1000'], debit: '1.00' },
          { accountId: acct['3000'], credit: '1.00' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // -------------------------------------------------------------------------
  // reverseEntry
  // -------------------------------------------------------------------------

  it('defaultReversalDate is the 1st of the next month (incl. year rollover)', () => {
    // Ledger dates are calendar days at UTC midnight, so the default is UTC midnight too.
    expect(defaultReversalDate(new Date('2025-03-15T12:00:00Z'))).toEqual(new Date(Date.UTC(2025, 3, 1)));
    expect(defaultReversalDate(new Date('2025-12-31T12:00:00Z'))).toEqual(new Date(Date.UTC(2026, 0, 1)));
    // An entry dated the 1st (stored 00:00Z) must not reverse on that same day west of UTC.
    expect(defaultReversalDate(new Date('2025-03-01'))).toEqual(new Date(Date.UTC(2025, 3, 1)));
  });

  it('creates a reversing entry: swapped debits/credits, REV reference, next-month date', async () => {
    const accrual = await createManualEntry(ctx, {
      date: new Date('2025-06-30'),
      description: 'June accrued advertising',
      lines: [
        { accountId: acct['6000'], debit: '400.00', memo: 'accrual', classId },
        { accountId: acct['1000'], credit: '400.00' },
      ],
    });

    const checkingBefore = (await getAccount(ctx, acct['1000'])).balance;

    const rev = await reverseEntry(ctx, accrual.id);
    expect(rev.reference).toBe(`REV of #${accrual.entryNumber}`);
    expect(new Date(rev.date)).toEqual(new Date(Date.UTC(2025, 6, 1))); // July 1st (UTC calendar day)

    const revDetail = await getEntry(ctx, rev.id);
    const creditLine = revDetail.lines.find((l) => l.accountId === acct['6000']);
    const debitLine = revDetail.lines.find((l) => l.accountId === acct['1000']);
    // Debits and credits swapped, memo + class preserved.
    expect(creditLine?.credit).toBe('400.00');
    expect(creditLine?.debit).toBeNull();
    expect(creditLine?.memo).toBe('accrual');
    expect(creditLine?.classId).toBe(classId);
    expect(debitLine?.debit).toBe('400.00');

    // Net effect of accrual + reversal on checking is zero (was -400, now back).
    const checkingAfter = (await getAccount(ctx, acct['1000'])).balance;
    expect(Number(checkingAfter)).toBeCloseTo(Number(checkingBefore) + 400, 2);

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('honors an explicit asOfDate', async () => {
    const entry = await createManualEntry(ctx, {
      date: new Date('2025-07-10'),
      description: 'Accrue rent',
      lines: [
        { accountId: acct['6000'], debit: '90.00' },
        { accountId: acct['1000'], credit: '90.00' },
      ],
    });
    const rev = await reverseEntry(ctx, entry.id, new Date('2025-09-15'));
    expect(new Date(rev.date)).toEqual(new Date('2025-09-15'));
  });

  it('rejects reversing a voided entry', async () => {
    await expect(reverseEntry(ctx, originalId)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects reversing across companies (NOT_FOUND)', async () => {
    await expect(reverseEntry(ctx2, replacementId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  // -------------------------------------------------------------------------
  // mergeAccounts
  // -------------------------------------------------------------------------

  it('rejects self-merge, cross-type merge, and cross-company merge', async () => {
    await expect(
      mergeAccounts(ctx, { fromId: acct['6001'], toId: acct['6001'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(
      mergeAccounts(ctx, { fromId: acct['6001'], toId: acct['1000'] }), // expense → asset
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    await expect(
      mergeAccounts(ctx2, { fromId: acct['6001'], toId: acct['6000'] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('merges duplicate accounts: re-points GL + FKs, recomputes balance, deactivates source', async () => {
    const fromId = acct['6001'];
    const toId = acct['6000'];

    // Activity on the duplicate account.
    await createManualEntry(ctx, {
      date: new Date('2025-08-01'),
      description: 'Spend on dupe account',
      lines: [
        { accountId: fromId, debit: '120.00' },
        { accountId: acct['1000'], credit: '120.00' },
      ],
    });

    // FK holders pointing at the duplicate: an item mapping, a bank rule, a sub-account.
    const [item] = await db
      .insert(items)
      .values({ companyId: ctx.companyId, name: 'Ad Spend Item', expenseAccountId: fromId })
      .returning();
    const [rule] = await db
      .insert(transactionRules)
      .values({
        companyId: ctx.companyId,
        name: 'Ads rule',
        matchValue: 'ADWORDS',
        setAccountId: fromId,
      })
      .returning();
    // 6002 becomes a child of the duplicate — must be re-parented to the survivor.
    await db
      .update(accountsTable)
      .set({ parentId: fromId })
      .where(eq(accountsTable.id, acct['6002']));

    const toBalanceBefore = Number((await getAccount(ctx, toId)).balance);
    const fromBalanceBefore = Number((await getAccount(ctx, fromId)).balance);
    expect(fromBalanceBefore).toBeCloseTo(120, 2);

    const result = await mergeAccounts(ctx, { fromId, toId });

    expect(result.deactivatedId).toBe(fromId);
    expect(result.reassigned.journalEntryLines).toBeGreaterThanOrEqual(1);
    expect(result.reassigned.items).toBe(1);
    expect(result.reassigned.transactionRules).toBe(1);
    expect(result.reassigned.childAccounts).toBe(1);

    // Source: deactivated, zero balance, no remaining journal lines.
    const fromAfter = await getAccount(ctx, fromId);
    expect(fromAfter.isActive).toBe(false);
    expect(Number(fromAfter.balance)).toBe(0);
    const orphanLines = await db
      .select()
      .from(journalEntryLines)
      .where(eq(journalEntryLines.accountId, fromId));
    expect(orphanLines).toHaveLength(0);

    // Survivor: cached balance recomputed = its own activity + the duplicate's.
    const toAfter = await getAccount(ctx, toId);
    expect(Number(toAfter.balance)).toBeCloseTo(toBalanceBefore + fromBalanceBefore, 2);
    expect(result.newBalance).toBe(toAfter.balance);

    // FKs re-pointed.
    const [itemAfter] = await db.select().from(items).where(eq(items.id, item.id));
    expect(itemAfter.expenseAccountId).toBe(toId);
    const [ruleAfter] = await db
      .select()
      .from(transactionRules)
      .where(eq(transactionRules.id, rule.id));
    expect(ruleAfter.setAccountId).toBe(toId);

    // Sub-account re-parented under the survivor (visible in the tree).
    const tree = await getAccountTree(ctx);
    const flat: Array<{ id: string; parentId: string | null }> = [];
    const walk = (nodes: Array<{ id: string; parentId: string | null; children: never[] }>) => {
      for (const n of nodes) {
        flat.push({ id: n.id, parentId: n.parentId });
        walk(n.children);
      }
    };
    walk(tree as never);
    expect(flat.find((a) => a.id === acct['6002'])?.parentId).toBe(toId);

    // GL integrity: trial balance still balances; no entry got lost.
    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it('hoists the survivor when it was a child of the merged account', async () => {
    // parent (dupe) ← child (survivor): merging parent INTO child must not self-parent it.
    const parent = await createAccount(ctx, {
      code: '6100',
      name: 'Travel (old)',
      type: 'expense',
      subtype: 'operating_expenses',
    });
    const child = await createAccount(ctx, {
      code: '6110',
      name: 'Travel',
      type: 'expense',
      subtype: 'operating_expenses',
      parentId: parent.id,
    });

    await mergeAccounts(ctx, { fromId: parent.id, toId: child.id });

    const childAfter = await getAccount(ctx, child.id);
    expect(childAfter.parentId).toBeNull(); // hoisted to the old parent's level
    expect(childAfter.isActive).toBe(true);
    const parentAfter = await getAccount(ctx, parent.id);
    expect(parentAfter.isActive).toBe(false);
  });

  it('re-points accountIds embedded in journal entries history (void rows included)', async () => {
    // Every journal line that referenced a merged account — posted, draft, or void —
    // must point at the survivor so historical reports keep reconciling.
    const lines = await db
      .select({ accountId: journalEntryLines.accountId })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .where(eq(journalEntries.companyId, ctx.companyId));
    expect(lines.some((l) => l.accountId === acct['6001'])).toBe(false);
  });
});
