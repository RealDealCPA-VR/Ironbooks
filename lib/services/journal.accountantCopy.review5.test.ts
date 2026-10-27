/**
 * Round-5 review regression (journal entries x Accountant's Copy):
 *  An edit that changes only a journal entry's description, line memo, Entry No. or Adjusting flag
 *  keeps the SAME entry (lib/services/journal.ts updateEntry, round 5). The Accountant's Copy
 *  changes file only spotted journal-entry edits through the void + re-post link, so such an
 *  accountant edit never reached the client: it was silently lost on import.
 *
 *  Once such edits travel, the client's conflict check (clientWork.ts editChangesLedger) must not
 *  treat them as changing the ledger: a header-only edit of an entry with a line cleared in a
 *  completed reconciliation (B), or with a customer line the client has since applied (C), is
 *  applied in place by updateEntry. Flagging it refused the WHOLE changes file and sent the
 *  client to undo months of reconciliations for a memo fix. A change of account, amount, name
 *  or date (an in-place Reclassify included) is still flagged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, asc, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, journalEntries, journalEntryLines, journalItemApplications, reconciliationItems, reconciliations, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount } from './accounts';
import { createBankAccount } from './bankAccounts';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { createManualEntry, updateEntry } from './journal';
import { applyJournalCredit } from './journalApplications';
import { completeReconciliation, listClearable, startReconciliation, toggleCleared } from './reconcile';
import { reclassifyLines } from './accountant/reclassify';
import { trialBalance } from './reports';
import { createAccountantCopy, importChangesFile, reviewChangesFile } from './accountantCopy/client';
import { accountantChanges, exportChangesFile, openAccountantCopyFile } from './accountantCopy/accountant';
import { parseChangesFile, serializeChangesFile, type ChangesFileBody } from './accountantCopy/format';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-journal-acctcopy');
const CLIENT_DIR = path.join(ROOT, 'client');
const ACCT_DIR = path.join(ROOT, 'accountant');
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

let db: DB;
let ctx: ServiceContext;
let adb: DB;
let actx: ServiceContext;
const acct: Record<string, string> = {};

async function header(c: ServiceContext, id: string) {
  const [e] = await c.db.select().from(journalEntries).where(eq(journalEntries.id, id));
  const lines = await c.db
    .select({ accountId: journalEntryLines.accountId, debit: journalEntryLines.debit, credit: journalEntryLines.credit, memo: journalEntryLines.memo })
    .from(journalEntryLines)
    .where(eq(journalEntryLines.journalEntryId, id))
    .orderBy(asc(journalEntryLines.createdAt), asc(journalEntryLines.id));
  // Debit lines first (lines inserted together share createdAt).
  lines.sort((a, b) => Number(Boolean(b.debit)) - Number(Boolean(a.debit)));
  return { status: e.status, description: e.description, reference: e.reference, isAdjusting: e.isAdjusting, lines };
}

describe("journal entries in an Accountant's Copy (review round 5)", () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(CLIENT_DIR);
    const [user] = await db.insert(users).values({ email: 'r5@je-acctcopy.test', name: 'Client Owner', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'R5 Copy Client', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
  });

  afterAll(async () => {
    for (const dir of [CLIENT_DIR, ACCT_DIR]) await closeDb(dir).catch(() => undefined);
    try {
      fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; the next run wipes it */
    }
  });

  it("A: the accountant's description / memo / Entry No. / Adjusting edit of a client entry travels and is applied on import", async () => {
    const lines = (memo: string | null) => [
      { accountId: acct['6300'], debit: '100.00', memo },
      { accountId: acct['1000'], credit: '100.00' },
    ];
    const edited = await createManualEntry(ctx, { date: d('2026-02-15'), description: 'Office supplies', reference: '12', lines: lines(null) });
    const untouched = await createManualEntry(ctx, { date: d('2026-02-20'), description: 'Postage', reference: '13', lines: lines(null) });

    const copy = await createAccountantCopy(ctx, { dividingDate: '2026-03-31', dataDir: CLIENT_DIR });
    await openAccountantCopyFile(copy.buffer, ACCT_DIR);
    adb = await getDb(ACCT_DIR);
    actx = { db: adb, companyId: ctx.companyId, userId: ctx.userId };

    // Header-only edit on the accountant side: same date, same accounts and amounts.
    const saved = await updateEntry(actx, edited.id, {
      date: d('2026-02-15'),
      description: 'Office supplies (per Staples invoice)',
      reference: '12A',
      isAdjusting: true,
      lines: lines('Staples #4411'),
    });
    expect(saved.id).toBe(edited.id); // the same entry, edited in place

    const changes = await accountantChanges(actx);
    expect(changes.transactions.map((t) => `${t.type}:${t.op}`)).toEqual(['journal_entry:edit']);
    const t = changes.transactions[0];
    expect(t.id).toBe(edited.id);
    expect(t.op === 'edit' && t.type === 'journal_entry' && t.after).toMatchObject({
      description: 'Office supplies (per Staples invoice)',
      reference: '12A',
      isAdjusting: true,
    });

    const out = await exportChangesFile(actx, { note: 'Recoded the memo.' });
    const review = await reviewChangesFile(ctx, out.buffer);
    expect(review.canImport).toBe(true);
    expect(review.counts.changed).toBe(1);

    const tbBefore = await trialBalance(ctx);
    const res = await importChangesFile(ctx, out.buffer);
    expect(res.applied.changed).toBe(1);

    // The client's entry now carries the accountant's header and memo — still the same entry.
    expect(await header(ctx, edited.id)).toEqual({
      status: 'posted',
      description: 'Office supplies (per Staples invoice)',
      reference: '12A',
      isAdjusting: true,
      lines: [
        { accountId: acct['6300'], debit: '100.00', credit: null, memo: 'Staples #4411' },
        { accountId: acct['1000'], debit: null, credit: '100.00', memo: null },
      ],
    });
    // The other entry and the balances are untouched.
    expect((await header(ctx, untouched.id)).description).toBe('Postage');
    const tbAfter = await trialBalance(ctx);
    expect(tbAfter.balanced).toBe(true);
    expect(tbAfter.rows.map((r) => [r.code, r.debit, r.credit])).toEqual(tbBefore.rows.map((r) => [r.code, r.debit, r.credit]));
  });
});

// ---------------------------------------------------------------------------
// B / C: the client's conflict check for an accountant's in-place journal-entry edit
// ---------------------------------------------------------------------------

const ROOT_B = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-journal-acctcopy-b');
const CLIENT_B = path.join(ROOT_B, 'client');
const ACCT_B = path.join(ROOT_B, 'accountant');

describe("journal entries in an Accountant's Copy: the client's reconciliations and applications (review round 5)", () => {
  let cctx: ServiceContext;
  let bctx: ServiceContext;
  const A: Record<string, string> = {};
  const R: Record<string, string> = {};
  let changes: Buffer;

  type Body = ChangesFileBody;
  /** The changes file cut down to the journal-entry changes `keep` picks (each one passed to `edit`). */
  const only = (keep: (t: Body['transactions'][number]) => boolean, edit?: (t: Body['transactions'][number]) => void): Buffer => {
    const { sha256: _s, ...body } = parseChangesFile(changes);
    const b = JSON.parse(JSON.stringify(body)) as Body;
    b.transactions = b.transactions.filter(keep);
    if (edit) b.transactions.forEach(edit);
    return serializeChangesFile(b);
  };
  const lineOf = async (c: ServiceContext, entryId: string, accountId: string) => {
    const [l] = await c.db
      .select()
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, entryId), eq(journalEntryLines.accountId, accountId)));
    return l;
  };

  beforeAll(async () => {
    fs.rmSync(ROOT_B, { recursive: true, force: true });
    const cdb = await getDb(CLIENT_B);
    const [user] = await cdb.insert(users).values({ email: 'r5b@je-acctcopy.test', name: 'Client Owner', passwordHash: 'x' }).returning();
    const company = await createCompany(cdb, { name: 'R5 Copy Client B', ownerId: user.id });
    cctx = { db: cdb, companyId: company.id, userId: user.id };
    for (const a of await cdb.select().from(accounts).where(eq(accounts.companyId, company.id))) A[a.code] = a.id;
    A['6400'] ??= (await createAccount(cctx, { code: '6400', name: 'Repairs', type: 'expense' as never, subtype: 'operating_expenses' })).id;
    R.acme = (await createCustomer(cctx, { displayName: 'Acme Corp' })).id;
    R.bank = (await createBankAccount(cctx, { accountId: A['1000'], bankName: 'First Bank', accountNumber: '555555555' })).id;

    // Two January expenses paid from the bank, both cleared in the January statement.
    R.e1 = (
      await createManualEntry(cctx, {
        date: d('2026-01-10'),
        description: 'Supplies',
        reference: 'J-1',
        lines: [{ accountId: A['6300'], debit: '40.00' }, { accountId: A['1000'], credit: '40.00' }],
      })
    ).id;
    R.e2 = (
      await createManualEntry(cctx, {
        date: d('2026-01-12'),
        description: 'Fix the door',
        reference: 'J-2',
        lines: [{ accountId: A['6300'], debit: '25.00' }, { accountId: A['1000'], credit: '25.00' }],
      })
    ).id;
    const jan = await startReconciliation(cctx, { bankAccountId: R.bank, statementDate: d('2026-01-31'), statementBalance: '-65.00' });
    for (const l of await listClearable(cctx, R.bank, new Date('2026-01-31T23:59:59.999Z'), jan.id)) {
      await toggleCleared(cctx, jan.id, l.journalEntryLineId, true);
    }
    R.jan = (await completeReconciliation(cctx, jan.id)).id;
    // A February courtesy credit on Acme's receivable line.
    R.e3 = (
      await createManualEntry(cctx, {
        date: d('2026-02-05'),
        description: 'Courtesy credit',
        reference: 'J-3',
        lines: [{ accountId: A['4100'], debit: '30.00' }, { accountId: A['1200'], credit: '30.00', entityType: 'customer', entityId: R.acme }],
      })
    ).id;

    const copy = await createAccountantCopy(cctx, { dividingDate: '2026-03-31', dataDir: CLIENT_B });
    await openAccountantCopyFile(copy.buffer, ACCT_B);
    bctx = { db: await getDb(ACCT_B), companyId: cctx.companyId, userId: cctx.userId };

    // ---- The client keeps working in April: the courtesy credit is applied to an April invoice ----
    const inv = await createInvoice(cctx, {
      customerId: R.acme,
      date: d('2026-04-02'),
      refNumber: 'A-02',
      lines: [{ description: 'April work', quantity: 1, rate: '100', accountId: A['4100'] }],
    });
    await applyJournalCredit(cctx, { journalLineId: (await lineOf(cctx, R.e3, A['1200'])).id, invoiceId: inv.id, amount: '30', date: d('2026-04-05') });

    // ---- The accountant ----
    // E1 (reconciled): header-only — description, Entry No., a line memo, Adjusting.
    const e1 = await updateEntry(bctx, R.e1, {
      date: d('2026-01-10'),
      description: 'Supplies (per Staples receipt)',
      reference: 'X1',
      isAdjusting: true,
      lines: [{ accountId: A['6300'], debit: '40.00', memo: 'Staples #88' }, { accountId: A['1000'], credit: '40.00' }],
    });
    expect(e1.id).toBe(R.e1);
    // E2 (reconciled): Reclassify its expense line to Repairs — in place, only the account changes.
    await reclassifyLines(bctx, { lineIds: [(await lineOf(bctx, R.e2, A['6300'])).id], newAccountId: A['6400'] });
    // E3 (applied by the client since): header-only.
    const e3 = await updateEntry(bctx, R.e3, {
      date: d('2026-02-05'),
      description: 'Courtesy credit (late delivery)',
      reference: 'J-3',
      lines: [{ accountId: A['4100'], debit: '30.00', memo: 'Per owner' }, { accountId: A['1200'], credit: '30.00', entityType: 'customer', entityId: R.acme }],
    });
    expect(e3.id).toBe(R.e3);

    const ac = await accountantChanges(bctx);
    expect(ac.transactions.map((t) => `${t.type}:${t.op}:${t.id}`).sort()).toEqual(
      [`journal_entry:edit:${R.e1}`, `journal_entry:edit:${R.e2}`, `journal_entry:edit:${R.e3}`].sort(),
    );
    changes = (await exportChangesFile(bctx, {})).buffer;
  }, 240_000);

  afterAll(async () => {
    for (const dir of [CLIENT_B, ACCT_B]) await closeDb(dir).catch(() => undefined);
    try {
      fs.rmSync(ROOT_B, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; the next run wipes it */
    }
  });

  it('B: a header-only edit of a reconciled entry is not flagged; the in-place Reclassify of one still is', async () => {
    const review = await reviewChangesFile(cctx, changes);
    const problem = (id: string) => review.items.find((i) => i.key === `journal_entry:edit:${id}`)?.problem ?? null;
    expect(problem(R.e1)).toBeNull();
    expect(problem(R.e2)).toMatch(
      /This journal entry was cleared in your reconciliation of 1000 · .+ for the statement ending 2026-01-31, so your accountant's change to it \(more than a memo, payee or number\) can't be made/,
    );
    expect(review.canImport).toBe(false);

    // A date change of the reconciled entry is flagged too.
    const moved = only(
      (t) => t.id === R.e1,
      (t) => {
        if (t.op === 'edit' && t.type === 'journal_entry') t.after.date = '2026-01-11T12:00:00.000Z';
      },
    );
    const r2 = await reviewChangesFile(cctx, moved);
    expect(r2.items.find((i) => i.key === `journal_entry:edit:${R.e1}`)?.problem ?? '').toMatch(/cleared in your reconciliation/);
  });

  it('C: a header-only edit of an entry whose customer line the client has since applied is not flagged; an amount change is', async () => {
    const review = await reviewChangesFile(cctx, changes);
    expect(review.items.find((i) => i.key === `journal_entry:edit:${R.e3}`)?.problem ?? null).toBeNull();

    const bigger = only(
      (t) => t.id === R.e3,
      (t) => {
        if (t.op === 'edit' && t.type === 'journal_entry') {
          t.after.lines = t.after.lines.map((l) => ({ ...l, debit: l.debit && '35.00', credit: l.credit && '35.00' }));
        }
      },
    );
    const r2 = await reviewChangesFile(cctx, bigger);
    expect(r2.canImport).toBe(false);
    expect(r2.items.find((i) => i.key === `journal_entry:edit:${R.e3}`)?.problem ?? '').toMatch(
      /Your file has \$30\.00 of your General Journal #\d+ applied on your invoice #A-02 .*so this journal entry can't be changed/,
    );
  });

  it('B / C: the header-only edits import in place; the reconciliation and the application stay', async () => {
    const buf = only((t) => t.id === R.e1 || t.id === R.e3);
    const review = await reviewChangesFile(cctx, buf);
    expect(review.items.filter((i) => i.problem).map((i) => i.problem)).toEqual([]);
    expect(review.canImport).toBe(true);

    const tbBefore = await trialBalance(cctx);
    const res = await importChangesFile(cctx, buf);
    expect(res.applied.changed).toBe(2);

    const [e1] = await cctx.db.select().from(journalEntries).where(eq(journalEntries.id, R.e1));
    expect({ status: e1.status, description: e1.description, reference: e1.reference, isAdjusting: e1.isAdjusting }).toEqual({
      status: 'posted',
      description: 'Supplies (per Staples receipt)',
      reference: 'X1',
      isAdjusting: true,
    });
    expect((await lineOf(cctx, R.e1, A['6300'])).memo).toBe('Staples #88');
    // Still cleared in the completed January reconciliation.
    const bankLine = await lineOf(cctx, R.e1, A['1000']);
    const [item] = await cctx.db.select().from(reconciliationItems).where(eq(reconciliationItems.journalEntryLineId, bankLine.id));
    expect(item.isCleared).toBe(true);
    const [jan] = await cctx.db.select().from(reconciliations).where(eq(reconciliations.id, R.jan));
    expect(jan.status).toBe('completed');

    const [e3] = await cctx.db.select().from(journalEntries).where(eq(journalEntries.id, R.e3));
    expect({ status: e3.status, description: e3.description }).toEqual({ status: 'posted', description: 'Courtesy credit (late delivery)' });
    const apps = await cctx.db.select().from(journalItemApplications).where(eq(journalItemApplications.journalEntryId, R.e3));
    expect(apps.map((a) => a.amount)).toEqual(['30.00']);

    const tbAfter = await trialBalance(cctx);
    expect(tbAfter.balanced).toBe(true);
    expect(tbAfter.rows.map((r) => [r.code, r.debit, r.credit])).toEqual(tbBefore.rows.map((r) => [r.code, r.debit, r.credit]));
  });
});
