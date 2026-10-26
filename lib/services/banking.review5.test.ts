/**
 * Review round 5 (team banking) — regression tests for defects found in banking, registers,
 * reconciliation, statement import, bank rules and the bank feed. Each test failed on the code
 * before its fix.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, bankAccounts, bankTransactions, journalEntries, reconciliationItems, users } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { ServiceError, type ServiceContext } from './_base';
import { createCompany } from './company';
import { createTransfer, getTransfer, updateTransfer } from './transfers';
import { updateEntry, voidEntry, reverseEntry } from './journal';
import { trialBalance } from './reports';
import { categorize } from './bankCategorize';
import { createBankRule } from './bankRules';
import { runAutoRules } from './bankSuggest';
import { addStatementAdjustments, startReconciliation, toggleCleared, completeReconciliation, listClearable } from './reconcile';
import { importTransactions, parseCSV, parseRows } from './import';
import { enterRegisterTransaction } from './registerEntry';
import { postJournalEntry } from './posting';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-banking-review5');
let db: DB;
let ctx: ServiceContext;
let userId: string;
let acct: Record<string, string> = {};
let seq = 0;
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function gl(code: string): Promise<string> {
  const row = (await trialBalance(ctx, d('2099-12-31'))).rows.find((r) => r.code === code);
  return row ? Money.sub(row.debit, row.credit).toFixed(2) : '0.00';
}

async function linkBank(code: string): Promise<string> {
  const [ba] = await db
    .insert(bankAccounts)
    .values({ companyId: ctx.companyId, accountId: acct[code], bankName: `Bank ${code}`, accountNumber: '000123456789' })
    .returning();
  return ba.id;
}

async function feedLine(bankAccountId: string, amount: string, description = 'SHELL OIL 1234', date = '2026-03-10') {
  const [row] = await db
    .insert(bankTransactions)
    .values({ companyId: ctx.companyId, bankAccountId, date: d(date), description, amount })
    .returning();
  return row;
}

async function expectCode(p: Promise<unknown>, code: string, msg?: RegExp) {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected the call to fail').toBeInstanceOf(ServiceError);
  expect((caught as ServiceError).code).toBe(code);
  if (msg) expect((caught as Error).message).toMatch(msg);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  db = await getDb(TEST_DIR);
  const [u] = await db.insert(users).values({ email: 'banking-r5@test.local', name: 'R5', passwordHash: 'x' }).returning();
  userId = u.id;
});

beforeEach(async () => {
  seq += 1;
  const company = await createCompany(db, { name: `Banking R5 ${seq}`, ownerId: userId });
  ctx = { db, companyId: company.id, userId };
  acct = {};
  for (const r of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[r.code] = r.id;
});

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Transfers are a source document, not a General Journal entry
// ---------------------------------------------------------------------------

describe('transfers carry their own source', () => {
  it('a transfer entry is linked to the transfer and cannot be edited, voided or reversed from the Journal screen', async () => {
    const t = await createTransfer(ctx, { date: d('2026-03-02'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '100.00' });
    const [entry] = await db.select().from(journalEntries).where(eq(journalEntries.id, t.postedEntryId!));
    expect(entry.sourceRef).toBe(`transfer:${t.id}`);

    const lines = [
      { accountId: acct['1010'], debit: '100.00' },
      { accountId: acct['1000'], credit: '100.00' },
    ];
    await expectCode(updateEntry(ctx, t.postedEntryId!, { date: d('2026-03-02'), description: 'edited', lines } as never), 'CONFLICT');
    await expectCode(voidEntry(ctx, t.postedEntryId!), 'CONFLICT');
    await expectCode(reverseEntry(ctx, t.postedEntryId!), 'CONFLICT');

    // Editing the transfer itself still works and keeps one posting.
    const edited = await updateTransfer(ctx, t.id, { date: d('2026-03-03'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '120.00' });
    const [e2] = await db.select().from(journalEntries).where(eq(journalEntries.id, edited.postedEntryId!));
    expect(e2.sourceRef).toBe(`transfer:${t.id}`);
    expect(await gl('1000')).toBe('-120.00');
    expect(await gl('1010')).toBe('120.00');
    expect((await getTransfer(ctx, t.id)).voidedAt).toBeNull();
  });

  it('migration 0066 links the entries of transfers saved before the fix (current and edited-away ones)', async () => {
    const t = await createTransfer(ctx, { date: d('2026-03-02'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '100.00' });
    const first = t.postedEntryId!;
    const edited = await updateTransfer(ctx, t.id, { date: d('2026-03-04'), fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '150.00' });
    // Simulate a file from before the fix: transfer entries had no source.
    await db.update(journalEntries).set({ sourceRef: null }).where(eq(journalEntries.id, first));
    await db.update(journalEntries).set({ sourceRef: null }).where(eq(journalEntries.id, edited.postedEntryId!));
    const sqlText = fs.readFileSync(path.resolve(process.cwd(), 'drizzle', '0066_r5_banking.sql'), 'utf8');
    const { sql } = await import('drizzle-orm');
    for (const stmt of sqlText.split('--> statement-breakpoint')) {
      const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
      if (body) await db.execute(sql.raw(body));
    }
    const rows = await db.select().from(journalEntries).where(eq(journalEntries.companyId, ctx.companyId));
    expect(rows.find((r) => r.id === first)?.sourceRef).toBe(`transfer:${t.id}`);
    expect(rows.find((r) => r.id === edited.postedEntryId)?.sourceRef).toBe(`transfer:${t.id}`);
    expect(await gl('1000')).toBe('-150.00');
  });
});

// ---------------------------------------------------------------------------
// Bank feed: memo / payee lengths
// ---------------------------------------------------------------------------

describe('bank feed categorize: long memo', () => {
  it('a memo longer than the 100-character reference column still posts', async () => {
    const ba = await linkBank('1000');
    const line = await feedLine(ba, '-45.00');
    const memo = 'Fuel for the delivery van, receipts in the glovebox folder, split with the warehouse truck later on.'.repeat(2);
    expect(memo.length).toBeGreaterThan(100);
    const res = await categorize(ctx, { bankTransactionId: line.id, accountId: acct['6300'], memo });
    expect(res.entry.status).toBe('posted');
    expect(await gl('1000')).toBe('-45.00');
  });

  it('an auto rule whose memo is longer than 100 characters posts its lines', async () => {
    const ba = await linkBank('1000');
    await feedLine(ba, '-45.00', 'SHELL OIL 57444 HOUSTON TX');
    await createBankRule(ctx, {
      name: 'Shell',
      matchField: 'description',
      matchOperator: 'contains',
      matchValue: 'SHELL',
      setAccountId: acct['6300'],
      setMemo: 'M'.repeat(200),
      mode: 'auto',
    });
    const res = await runAutoRules(ctx, ba);
    expect(res.skipped).toEqual([]);
    expect(res.applied).toHaveLength(1);
  });

  it('a feed line cannot be added to the bank account it came from (Dr Checking / Cr Checking posts nothing)', async () => {
    const ba = await linkBank('1000');
    const line = await feedLine(ba, '-45.00');
    await expectCode(categorize(ctx, { bankTransactionId: line.id, accountId: acct['1000'] }), 'VALIDATION', /same account|this bank account/i);
    await expectCode(
      categorize(ctx, {
        bankTransactionId: line.id,
        accountId: acct['6300'],
        splits: [
          { accountId: acct['6300'], percent: '50' },
          { accountId: acct['1000'], percent: '50' },
        ],
      }),
      'VALIDATION',
      /same account|this bank account/i,
    );
    const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, line.id));
    expect(row.matched).toBe(false);
  });

  it('a payee longer than 255 characters is refused with a plain message (not a database error)', async () => {
    const ba = await linkBank('1000');
    const line = await feedLine(ba, '-45.00');
    await expectCode(categorize(ctx, { bankTransactionId: line.id, accountId: acct['6300'], payee: 'P'.repeat(300) }), 'VALIDATION', /payee/i);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation: statement adjustments are all-or-nothing
// ---------------------------------------------------------------------------

describe('reconciliation statement adjustments', () => {
  it('a bad interest line does not leave the service charge posted', async () => {
    const ba = await linkBank('1000');
    const recon = await startReconciliation(ctx, { bankAccountId: ba, statementDate: d('2026-03-31'), statementBalance: '0.00' });
    await expectCode(
      addStatementAdjustments(ctx, recon.id, {
        serviceCharge: { amount: '12.00', accountId: acct['6100'] },
        interestEarned: { amount: '0', accountId: acct['4900'] },
      }),
      'VALIDATION',
    );
    const posted = await db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, `reconciliation:${recon.id}`)));
    expect(posted).toHaveLength(0);
    expect(await gl('1000')).toBe('0.00');
  });

  it('a non-numeric adjustment amount is a VALIDATION error', async () => {
    const ba = await linkBank('1000');
    const recon = await startReconciliation(ctx, { bankAccountId: ba, statementDate: d('2026-03-31'), statementBalance: '0.00' });
    await expectCode(addStatementAdjustments(ctx, recon.id, { serviceCharge: { amount: 'twelve', accountId: acct['6100'] } }), 'VALIDATION');
  });

  it('starting a reconciliation with a non-numeric statement balance is a VALIDATION error', async () => {
    const ba = await linkBank('1000');
    await expectCode(startReconciliation(ctx, { bankAccountId: ba, statementDate: d('2026-03-31'), statementBalance: '12,34x' }), 'VALIDATION');
    await expectCode(startReconciliation(ctx, { bankAccountId: ba, statementDate: new Date('garbage'), statementBalance: '1.00' }), 'VALIDATION');
  });
});

// ---------------------------------------------------------------------------
// Statement / CSV import robustness
// ---------------------------------------------------------------------------

describe('statement and CSV import', () => {
  it('a reviewed statement row whose amount is not a number is refused (never stored as NaN)', () => {
    expect(() => parseRows([{ date: '2026-03-02', description: 'x', amount: 'NaN' }])).toThrow(/not an amount/);
    expect(() => parseRows([{ date: '2026-03-02', description: 'x', amount: 'Infinity' }])).toThrow(/not an amount/);
  });

  it('a reviewed statement row dated on a day that does not exist is refused (not rolled into the next month)', () => {
    expect(() => parseRows([{ date: '2026-02-30', description: 'x', amount: '-5.00' }])).toThrow(/date/);
    expect(parseRows([{ date: '2028-02-29', description: 'x', amount: '-5.00' }])[0].date.toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it('CSV debit / credit columns: a debit printed as a negative number is still money out', () => {
    const csv = 'Date,Description,Debit,Credit\n2026-03-02,Fuel,-45.00,\n2026-03-03,Deposit,,200.00\n';
    const rows = parseCSV(csv, { dateCol: 'Date', descriptionCol: 'Description', amountCol: 'Debit', debitCol: 'Debit', creditCol: 'Credit' });
    expect(rows.map((r) => r.amount)).toEqual(['-45.00', '200.00']);
  });

  it('CSV debit / credit columns: an amount that is not a number fails the import instead of staging NaN', async () => {
    const ba = await linkBank('1000');
    const csv = 'Date,Description,Debit,Credit\n2026-03-02,Fuel,N/A,\n';
    await expectCode(
      importTransactions(ctx, {
        bankAccountId: ba,
        fileType: 'csv',
        content: csv,
        csvMapping: { dateCol: 'Date', descriptionCol: 'Description', amountCol: 'Debit', debitCol: 'Debit', creditCol: 'Credit' },
      }),
      'VALIDATION',
    );
    const staged = await db.select().from(bankTransactions).where(eq(bankTransactions.bankAccountId, ba));
    expect(staged).toHaveLength(0);
  });

  it('CSV debit / credit columns accept accounting-style (12.50) and 1,234.56 amounts', () => {
    const csv = 'Date,Description,Debit,Credit\n2026-03-02,Fuel,(12.50),\n2026-03-03,Deposit,,"1,234.56"\n';
    const rows = parseCSV(csv, { dateCol: 'Date', descriptionCol: 'Description', amountCol: 'Debit', debitCol: 'Debit', creditCol: 'Credit' });
    expect(rows.map((r) => r.amount)).toEqual(['-12.50', '1234.56']);
  });
});

// ---------------------------------------------------------------------------
// Registers: Undeposited Funds
// ---------------------------------------------------------------------------

describe('register entry and Undeposited Funds', () => {
  it('typing an amount into Undeposited Funds from another register is refused (it could never be deposited)', async () => {
    // Money into Undeposited Funds from the income register would be a journal entry the Make
    // Deposits window never lists — the balance could not be deposited or cleared.
    await expectCode(
      enterRegisterTransaction(ctx, acct['4000'], { date: d('2026-03-02'), payee: 'Cash sale', otherAccountId: acct['1050'], side: 'increase', amount: '50.00' }),
      'VALIDATION',
      /Undeposited Funds/,
    );
    await expectCode(
      enterRegisterTransaction(ctx, acct['1050'], { date: d('2026-03-02'), payee: 'Cash sale', otherAccountId: acct['4000'], side: 'increase', amount: '50.00' }),
      'VALIDATION',
      /Undeposited Funds/,
    );
    await expectCode(
      enterRegisterTransaction(ctx, acct['1000'], { date: d('2026-03-02'), payee: 'Cash', otherAccountId: acct['1050'], side: 'decrease', amount: '50.00' }),
      'VALIDATION',
      /Undeposited Funds/,
    );
    expect(await gl('1050')).toBe('0.00');
  });
});

// ---------------------------------------------------------------------------
// Reconciliation: what can be cleared
// ---------------------------------------------------------------------------

describe('reconciliation: clearing lines', () => {
  it('a line already reconciled in a completed session cannot be cleared again (it would count twice)', async () => {
    const ba = await linkBank('1000');
    const e = await postJournalEntry(ctx, {
      date: d('2026-03-05'),
      description: 'Owner money',
      lines: [
        { accountId: acct['1000'], debit: '500.00' },
        { accountId: acct['3000'], credit: '500.00' },
      ],
    });
    const r1 = await startReconciliation(ctx, { bankAccountId: ba, statementDate: d('2026-03-31'), statementBalance: '500.00' });
    const [line] = (await listClearable(ctx, ba, d('2026-03-31'), r1.id)).filter((l) => l.journalEntryId === e.id);
    await toggleCleared(ctx, r1.id, line.journalEntryLineId, true);
    await completeReconciliation(ctx, r1.id);

    const r2 = await startReconciliation(ctx, { bankAccountId: ba, statementDate: d('2026-04-30'), statementBalance: '1000.00' });
    await expectCode(toggleCleared(ctx, r2.id, line.journalEntryLineId, true), 'CONFLICT', /already reconciled/i);
    const items = await db.select().from(reconciliationItems).where(eq(reconciliationItems.reconciliationId, r2.id));
    expect(items).toHaveLength(0);
  });

  it('a line dated after the statement date cannot be cleared', async () => {
    const ba = await linkBank('1000');
    const e = await postJournalEntry(ctx, {
      date: d('2026-04-05'),
      description: 'Owner money',
      lines: [
        { accountId: acct['1000'], debit: '500.00' },
        { accountId: acct['3000'], credit: '500.00' },
      ],
    });
    const r1 = await startReconciliation(ctx, { bankAccountId: ba, statementDate: d('2026-03-31'), statementBalance: '500.00' });
    const [row] = await db.select().from(journalEntries).where(eq(journalEntries.id, e.id));
    expect(row).toBeTruthy();
    const { journalEntryLines } = await import('@/lib/db/schema');
    const [bankLine] = await db
      .select()
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, e.id), eq(journalEntryLines.accountId, acct['1000'])));
    await expectCode(toggleCleared(ctx, r1.id, bankLine.id, true), 'VALIDATION', /statement date/i);
  });
});

// ---------------------------------------------------------------------------
// Make Deposits on a large company file
// ---------------------------------------------------------------------------

describe('Make Deposits on a large file', () => {
  it('lists what is waiting in Undeposited Funds when more than 65,535 payments were deposited over the years', async () => {
    const { createCustomer } = await import('./customers');
    const { listUndepositedPayments } = await import('./deposits');
    const { sql } = await import('drizzle-orm');
    const c = await createCustomer(ctx, { displayName: 'Walk-in' } as never);
    const N = 66_000;
    // Years of history: N payments, all deposited by one (old) deposit.
    await db.execute(sql`
      INSERT INTO payments_received (company_id, customer_id, date, method, amount, unapplied, deposit_account_id)
      SELECT ${ctx.companyId}::uuid, ${c.id}::uuid, '2020-01-01'::timestamp, 'check', 1.00, 0, ${acct['1050']}::uuid
      FROM generate_series(1, ${N})`);
    const [dep] = (
      await db.execute(sql`
        INSERT INTO deposits (company_id, deposit_account_id, date, total)
        VALUES (${ctx.companyId}::uuid, ${acct['1000']}::uuid, '2020-01-02'::timestamp, ${N})
        RETURNING id`)
    ).rows as Array<{ id: string }>;
    await db.execute(sql`
      INSERT INTO deposit_lines (deposit_id, payment_id, amount)
      SELECT ${dep.id}::uuid, p.id, 1.00 FROM payments_received p WHERE p.company_id = ${ctx.companyId}::uuid`);
    // The app refreshes planner statistics when a company file is opened (lib/db/index.ts).
    const { refreshPlannerStats } = await import('@/lib/db/plannerStats');
    await refreshPlannerStats(db, 'test: reopen');
    // One payment still waiting.
    const [waiting] = (
      await db.execute(sql`
        INSERT INTO payments_received (company_id, customer_id, date, method, amount, unapplied, deposit_account_id)
        VALUES (${ctx.companyId}::uuid, ${c.id}::uuid, '2026-03-01'::timestamp, 'check', 25.00, 0, ${acct['1050']}::uuid)
        RETURNING id`)
    ).rows as Array<{ id: string }>;
    const list = await listUndepositedPayments(ctx);
    expect(list.map((x) => x.id)).toEqual([waiting.id]);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Reconcile on a large company file
// ---------------------------------------------------------------------------

describe('Reconcile on a large file', () => {
  it('lists the lines to clear when the bank account has more than 65,535 lines of history', async () => {
    const { sql } = await import('drizzle-orm');
    const ba = await linkBank('1000');
    const N = 33_000; // entries of 2 lines each on the bank account = 66,000 lines
    // Bulk-load years of already-reconciled history directly. Test-only shortcut: the ledger
    // triggers are switched off for the load (the lines are balanced pairs on the same account,
    // so every entry balances and the cached balance does not change) and back on before COMMIT.
    await db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE journal_entries DISABLE TRIGGER ALL`);
      await tx.execute(sql`ALTER TABLE journal_entry_lines DISABLE TRIGGER ALL`);
      await tx.execute(sql`
        INSERT INTO journal_entries (company_id, entry_number, date, description, status, created_by)
        SELECT ${ctx.companyId}::uuid, 100000 + g, '2019-06-01'::timestamp, 'History', 'posted', ${userId}::uuid
        FROM generate_series(1, ${N}) g`);
      await tx.execute(sql`
        INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit)
        SELECT e.id, ${acct['1000']}::uuid, 1.00, NULL FROM journal_entries e
        WHERE e.company_id = ${ctx.companyId}::uuid AND e.description = 'History'
        UNION ALL
        SELECT e.id, ${acct['1000']}::uuid, NULL, 1.00 FROM journal_entries e
        WHERE e.company_id = ${ctx.companyId}::uuid AND e.description = 'History'`);
      await tx.execute(sql`ALTER TABLE journal_entries ENABLE TRIGGER ALL`);
      await tx.execute(sql`ALTER TABLE journal_entry_lines ENABLE TRIGGER ALL`);
      const [old] = (
        await tx.execute(sql`
          INSERT INTO reconciliations (bank_account_id, statement_date, statement_balance, reconciled_balance, status, created_by, completed_at)
          VALUES (${ba}::uuid, '2019-06-30'::timestamp, 0, 0, 'completed', ${userId}::uuid, now())
          RETURNING id`)
      ).rows as Array<{ id: string }>;
      await tx.execute(sql`
        INSERT INTO reconciliation_items (reconciliation_id, journal_entry_line_id, is_cleared, cleared_date)
        SELECT ${old.id}::uuid, l.id, true, now() FROM journal_entry_lines l
        JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE e.company_id = ${ctx.companyId}::uuid AND e.description = 'History'`);
    });
    // The app refreshes planner statistics when a company file is opened (lib/db/index.ts).
    const { refreshPlannerStats } = await import('@/lib/db/plannerStats');
    await refreshPlannerStats(db, 'test: reopen');
    await db.update(bankAccounts).set({ lastReconciledDate: d('2019-06-30'), lastReconciledBalance: '0.00' }).where(eq(bankAccounts.id, ba));

    const fresh = await postJournalEntry(ctx, {
      date: d('2026-03-05'),
      description: 'Owner money',
      lines: [
        { accountId: acct['1000'], debit: '500.00' },
        { accountId: acct['3000'], credit: '500.00' },
      ],
    });
    const recon = await startReconciliation(ctx, { bankAccountId: ba, statementDate: d('2026-03-31'), statementBalance: '500.00' });
    const lines = await listClearable(ctx, ba, d('2026-03-31'), recon.id);
    expect(lines.map((l) => l.journalEntryId)).toEqual([fresh.id]);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Bank account links
// ---------------------------------------------------------------------------

describe('linking a bank account', () => {
  it('a GL account can be linked once (a double-clicked Add Account made two reconcile histories)', async () => {
    const { createBankAccount } = await import('./bankAccounts');
    await createBankAccount(ctx, { accountId: acct['1000'], bankName: 'First Bank', accountNumber: '1234' });
    await expectCode(createBankAccount(ctx, { accountId: acct['1000'], bankName: 'First Bank', accountNumber: '1234' }), 'CONFLICT', /already linked/i);
    const rows = await db.select().from(bankAccounts).where(eq(bankAccounts.accountId, acct['1000']));
    expect(rows).toHaveLength(1);
  });

  it('a bank name that is not text is a VALIDATION error, not a crash', async () => {
    const { createBankAccount } = await import('./bankAccounts');
    await expectCode(createBankAccount(ctx, { accountId: acct['1000'], bankName: 123 as never, accountNumber: '1234' }), 'VALIDATION');
    await expectCode(createBankAccount(ctx, { accountId: acct['1000'], bankName: 'B'.repeat(300), accountNumber: '1234' }), 'VALIDATION');
  });
});

// ---------------------------------------------------------------------------
// Web Connect / OFX files with several accounts
// ---------------------------------------------------------------------------

describe('OFX file with several accounts', () => {
  const stmt = (acctId: string, fit: string, amt: string) => `<STMTTRNRS>
<TRNUID>1
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<BANKID>021000021
<ACCTID>${acctId}
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260301
<DTEND>20260331
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260305
<TRNAMT>${amt}
<FITID>${fit}
<NAME>SHELL OIL
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>`;
  const file = (...parts: string[]) => `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX>\n<BANKMSGSRSV1>\n${parts.join('\n')}\n</BANKMSGSRSV1>\n</OFX>`;

  it('imports the statement of the account being imported into (matched by account number)', async () => {
    const ba = await linkBank('1000'); // account number 000123456789
    const content = file(stmt('999988887777', 'A1', '-10.00'), stmt('000123456789', 'B1', '-45.00'));
    const res = await importTransactions(ctx, { bankAccountId: ba, fileType: 'ofx', content });
    expect(res.imported).toBe(1);
    const staged = await db.select().from(bankTransactions).where(eq(bankTransactions.bankAccountId, ba));
    expect(staged.map((s) => s.amount)).toEqual(['-45.00']);
  });

  it('refuses a file with several accounts when none matches, instead of importing nothing silently', async () => {
    const ba = await linkBank('1000');
    const content = file(stmt('999988887777', 'A1', '-10.00'), stmt('555544443333', 'B1', '-45.00'));
    await expectCode(importTransactions(ctx, { bankAccountId: ba, fileType: 'ofx', content }), 'VALIDATION', /7777.*3333|accounts/);
  });
});

// ---------------------------------------------------------------------------
// Editing a foreign-currency deposit / transfer keeps its exchange rate
// ---------------------------------------------------------------------------

describe('editing a foreign-currency deposit or transfer keeps its rate', () => {
  async function eurSetup() {
    const { setAccountCurrency, setBaseCurrency, upsertCurrency } = await import('./currencies');
    const { createAccount } = await import('./accounts');
    await setBaseCurrency(ctx, { code: 'USD', name: 'US Dollar' });
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.10' });
    const eurBank = (await createAccount(ctx, { code: '1020', name: 'Euro Bank', type: 'asset' as never, subtype: 'checking' })).id;
    const eurSave = (await createAccount(ctx, { code: '1021', name: 'Euro Savings', type: 'asset' as never, subtype: 'savings' })).id;
    await setAccountCurrency(ctx, eurBank, 'EUR');
    await setAccountCurrency(ctx, eurSave, 'EUR');
    return { eurBank, eurSave, upsertCurrency };
  }

  it('a memo-only edit of a EUR deposit (the form sends no rate) keeps its home value and its entry', async () => {
    const { eurBank, upsertCurrency } = await eurSetup();
    const { createDeposit, updateDeposit } = await import('./deposits');
    const dep = await createDeposit(ctx, { depositAccountId: eurBank, date: d('2026-03-02'), extraLines: [{ accountId: acct['3000'], amount: '100.00' }] });
    expect(dep.homeTotal).toBe('110.00');
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.25' }); // the list rate moved since
    const edited = await updateDeposit(ctx, dep.id, {
      depositAccountId: eurBank,
      date: d('2026-03-02'),
      extraLines: [{ accountId: acct['3000'], amount: '100.00' }],
      memo: 'March owner money',
    });
    expect(edited.homeTotal).toBe('110.00');
    expect(edited.postedEntryId).toBe(dep.postedEntryId);
    expect(await gl('1020')).toBe('110.00');
  });

  it('a memo-only edit of a EUR to EUR transfer keeps its home value and its entry', async () => {
    const { eurBank, eurSave, upsertCurrency } = await eurSetup();
    const t = await createTransfer(ctx, { date: d('2026-03-02'), fromAccountId: eurBank, toAccountId: eurSave, amount: '100.00' });
    expect(t.homeAmount).toBe('110.00');
    await upsertCurrency(ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.25' });
    const edited = await updateTransfer(ctx, t.id, { date: d('2026-03-02'), fromAccountId: eurBank, toAccountId: eurSave, amount: '100.00', memo: 'Sweep' });
    expect(edited.homeAmount).toBe('110.00');
    expect(edited.postedEntryId).toBe(t.postedEntryId);
  });
});

// ---------------------------------------------------------------------------
// Statement PDFs longer than the page limit
// ---------------------------------------------------------------------------

describe('statement PDF longer than the pages read', () => {
  it('says that pages were left out instead of silently reading only the first ones', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const { extractBankFile } = await import('./statementImport');
    const ba = await linkBank('1000');
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const N = 42;
    for (let p = 1; p <= N; p++) {
      const page = pdf.addPage([612, 792]);
      const lines =
        p === 1
          ? ['First Community Bank', 'Statement Period: 01/01/2026 through 01/31/2026', 'Beginning Balance $1,000.00', '01/02 SHELL OIL 10.00 990.00']
          : p === N
            ? ['01/30 SHELL OIL 10.00 580.00', 'Ending Balance $580.00']
            : [`01/${String(2 + (p % 27)).padStart(2, '0')} SHELL OIL 10.00 ${(1000 - p * 10).toFixed(2)}`];
      lines.forEach((t, i) => page.drawText(t, { x: 40, y: 740 - i * 18, size: 10, font }));
    }
    const r = await extractBankFile(ctx, { bankAccountId: ba, filename: 'long.pdf', bytes: await pdf.save() }, { ocr: null, routerOpts: {} });
    expect(r.kind).toBe('statement');
    if (r.kind !== 'statement') return;
    expect(r.pages).toBe(N);
    expect(r.warnings.join(' ')).toMatch(/first 40 of 42 pages/);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Legacy categorization rules (Banking page "Add rule")
// ---------------------------------------------------------------------------

describe('legacy rules', () => {
  it('over-long rule text is a VALIDATION error, not a database error', async () => {
    const { createRule } = await import('./rules');
    const base = { name: 'Fuel', matchField: 'description' as const, matchOperator: 'contains' as const, matchValue: 'SHELL', setAccountId: acct['6300'] };
    await expectCode(createRule(ctx, { ...base, name: 'N'.repeat(300) }), 'VALIDATION');
    await expectCode(createRule(ctx, { ...base, matchValue: 'V'.repeat(300) }), 'VALIDATION');
    await expectCode(createRule(ctx, { ...base, setPayee: 'P'.repeat(300) }), 'VALIDATION');
    await expectCode(createRule(ctx, { ...base, priority: 1.5 }), 'VALIDATION');
  });
});

// ---------------------------------------------------------------------------
// Bank feed matches follow the transaction they were matched to
// ---------------------------------------------------------------------------

describe('a matched feed line whose transaction is voided or edited', () => {
  async function matchedCheck() {
    const { createExpense } = await import('./expenses');
    const { matchTransaction } = await import('./bankCategorize');
    const ba = await linkBank('1000');
    const exp = await createExpense(ctx, {
      payeeName: 'Shell',
      date: d('2026-03-09'),
      method: 'check',
      reference: '1043',
      paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6300'], amount: '45.00' }],
    });
    const line = await feedLine(ba, '-45.00', 'CHECK 1043', '2026-03-10');
    await matchTransaction(ctx, line.id, exp.postedEntryId!);
    return { ba, exp, line };
  }

  it('voiding the check returns the bank line to review (it used to stay "added" with nothing in the books)', async () => {
    const { voidExpense } = await import('./expenses');
    const { resyncFeedMatches, listStaged } = await import('./bankCategorize');
    const { ba, exp, line } = await matchedCheck();
    await voidExpense(ctx, exp.id);
    await resyncFeedMatches(ctx, ba);
    const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, line.id));
    expect(row).toMatchObject({ matched: false, matchedEntryId: null });
    expect((await listStaged(ctx, ba, { filter: 'unreviewed' })).map((r) => r.id)).toEqual([line.id]);
  });

  it('editing the check (re-posted) keeps the bank line matched to the check', async () => {
    const { updateExpense, getExpense } = await import('./expenses');
    const { resyncFeedMatches } = await import('./bankCategorize');
    const { ba, exp, line } = await matchedCheck();
    await updateExpense(ctx, exp.id, {
      payeeName: 'Shell',
      date: d('2026-03-09'),
      method: 'check',
      reference: '1043',
      paymentAccountId: acct['1000'],
      lines: [
        { accountId: acct['6300'], amount: '30.00' },
        { accountId: acct['6100'], amount: '15.00' },
      ],
    });
    const now = await getExpense(ctx, exp.id);
    expect(now.postedEntryId).not.toBe(exp.postedEntryId);
    await resyncFeedMatches(ctx, ba);
    const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, line.id));
    expect(row).toMatchObject({ matched: true, matchedEntryId: now.postedEntryId });
  });

  it('runs when the bank feed is opened (with the automatic rules)', async () => {
    const { voidExpense } = await import('./expenses');
    const { ba, exp, line } = await matchedCheck();
    await voidExpense(ctx, exp.id);
    await runAutoRules(ctx, ba);
    const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, line.id));
    expect(row.matched).toBe(false);
  });
});
