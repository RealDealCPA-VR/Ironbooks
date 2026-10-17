/**
 * Review round 3 (payroll / reports / banking business logic) — regression tests.
 *
 *  - A transfer between two feed-connected accounts can be matched on BOTH feeds, and the
 *    categorized side cannot be unmatched (voided) while the other feed still links it.
 *  - OFX lines posted with a time of day land on their own calendar day; as-of reports and the
 *    reconciliation statement date cover the whole day (incl. 23:59:59Z postings).
 *  - CSV dates without an explicit format do not shift a day east of UTC.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, bankTransactions, journalEntries } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { createBankAccount } from './bankAccounts';
import { createTransfer } from './transfers';
import { categorize, suggestMatches, matchTransaction, unmatch } from './bankCategorize';
import { importTransactions, parseCSV } from './import';
import { balanceSheet, trialBalance } from './reports';
import { balanceSheetClassified } from './balanceSheetClassified';
import { listClearable, startReconciliation } from './reconcile';
import { postJournalEntry } from './posting';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review3-prb');
let ctx: ServiceContext;
let db: DB;
const acct: Record<string, string> = {};
let checkingBa: string;
let savingsBa: string;

describe('review3: banking dates and transfer matching', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'r3prb@test.local', name: 'R3', passwordHash: 'x' }).returning();
    const [company] = await db.insert(companies).values({ name: 'R3 PRB Co', ownerId: user.id }).returning();
    ctx = { db, companyId: company.id, userId: user.id };
    const defs: Array<[string, string, string, string]> = [
      ['1000', 'Checking', 'asset', 'checking'],
      ['1010', 'Savings', 'asset', 'savings'],
      ['1500', 'Equipment', 'asset', 'fixed_assets'],
      ['3000', 'Owner Equity', 'equity', 'owners_equity'],
      ['4000', 'Sales', 'revenue', 'sales'],
      ['6000', 'Office', 'expense', 'operating_expenses'],
    ];
    for (const [code, name, type, subtype] of defs) {
      acct[code] = (await createAccount(ctx, { code, name, type: type as never, subtype })).id;
    }
    checkingBa = (await createBankAccount(ctx, { accountId: acct['1000'], bankName: 'Bank', accountNumber: '1111' })).id;
    savingsBa = (await createBankAccount(ctx, { accountId: acct['1010'], bankName: 'Bank', accountNumber: '2222' })).id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('a transfer between two feed-connected accounts can be matched on BOTH feeds', async () => {
    const day = new Date(Date.UTC(2024, 4, 10));
    const transfer = await createTransfer(ctx, { date: day, fromAccountId: acct['1000'], toAccountId: acct['1010'], amount: '500.00' });
    const [outLine] = await db.insert(bankTransactions).values({
      companyId: ctx.companyId, bankAccountId: checkingBa, date: day, description: 'TRANSFER TO SAV', amount: '-500.00',
    }).returning();
    const [inLine] = await db.insert(bankTransactions).values({
      companyId: ctx.companyId, bankAccountId: savingsBa, date: day, description: 'TRANSFER FROM CHK', amount: '500.00',
    }).returning();
    const [dupLine] = await db.insert(bankTransactions).values({
      companyId: ctx.companyId, bankAccountId: checkingBa, date: day, description: 'TRANSFER TO SAV', amount: '-500.00',
    }).returning();

    await matchTransaction(ctx, outLine.id, transfer.postedEntryId!);
    const cands = await suggestMatches(ctx, inLine.id);
    expect(cands.map((c) => c.entryId)).toContain(transfer.postedEntryId);
    await expect(matchTransaction(ctx, inLine.id, transfer.postedEntryId!)).resolves.toBeTruthy();

    // Still once per bank account: a second Checking feed line cannot take the same entry.
    expect((await suggestMatches(ctx, dupLine.id)).map((c) => c.entryId)).not.toContain(transfer.postedEntryId);
    await expect(matchTransaction(ctx, dupLine.id, transfer.postedEntryId!)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('a categorized transfer matched on the other feed cannot be unmatched (voided) first', async () => {
    const day = new Date(Date.UTC(2024, 5, 3));
    const [outLine] = await db.insert(bankTransactions).values({
      companyId: ctx.companyId, bankAccountId: checkingBa, date: day, description: 'XFER OUT', amount: '-75.00',
    }).returning();
    const [inLine] = await db.insert(bankTransactions).values({
      companyId: ctx.companyId, bankAccountId: savingsBa, date: day, description: 'XFER IN', amount: '75.00',
    }).returning();
    const { entry } = await categorize(ctx, { bankTransactionId: outLine.id, accountId: acct['1010'] });
    await matchTransaction(ctx, inLine.id, entry.id);

    await expect(unmatch(ctx, outLine.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    const [still] = await db.select().from(journalEntries).where(eq(journalEntries.id, entry.id));
    expect(still.status).toBe('posted');

    await unmatch(ctx, inLine.id);
    await unmatch(ctx, outLine.id);
    const [voided] = await db.select().from(journalEntries).where(eq(journalEntries.id, entry.id));
    expect(voided.status).toBe('void');
  });

  it('an OFX line posted with a time of day counts on its own day (TB as of / reconciliation)', async () => {
    const ofx = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240131120000[0:GMT]<TRNAMT>250.00<FITID>R3-1<NAME>DEPOSIT</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240201<TRNAMT>10.00<FITID>R3-2<NAME>DEPOSIT</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    await importTransactions(ctx, { bankAccountId: checkingBa, fileType: 'ofx', content: ofx });
    const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.fitId, 'R3-1'));
    expect(row.date.toISOString()).toBe('2024-01-31T00:00:00.000Z');
    const { entry } = await categorize(ctx, { bankTransactionId: row.id, accountId: acct['4000'] });
    expect(entry.date.toISOString()).toBe('2024-01-31T00:00:00.000Z');
    const [feb] = await db.select().from(bankTransactions).where(eq(bankTransactions.fitId, 'R3-2'));
    await categorize(ctx, { bankTransactionId: feb.id, accountId: acct['4000'] });

    const jan31 = new Date('2024-01-31'); // how report routes / reconcile parse a YYYY-MM-DD date
    const tb = await trialBalance(ctx, jan31);
    expect(tb.rows.find((r) => r.code === '4000')?.credit).toBe('250.00'); // Feb 1 excluded

    const recon = await startReconciliation(ctx, { bankAccountId: checkingBa, statementDate: jan31, statementBalance: '250.00' });
    const lines = await listClearable(ctx, checkingBa, recon.statementDate, recon.id);
    expect(lines.length).toBe(1);
  });

  it('as-of reports include an entry posted at 23:59:59Z on the as-of day', async () => {
    await postJournalEntry(ctx, {
      date: new Date('2024-03-31T23:59:59Z'),
      description: 'Late-day posting',
      lines: [
        { accountId: acct['1500'], debit: '40.00' },
        { accountId: acct['3000'], credit: '40.00' },
      ],
    });
    const mar31 = new Date('2024-03-31');
    const tb = await trialBalance(ctx, mar31);
    expect(tb.rows.find((r) => r.code === '1500')?.debit).toBe('40.00');
    const bs = await balanceSheet(ctx, mar31);
    expect(bs.assets.find((l) => l.code === '1500')?.amount).toBe('40.00');
    const cbs = await balanceSheetClassified(ctx, mar31);
    expect(cbs.nonCurrentAssets.lines.find((l) => l.code === '1500')?.amount).toBe('40.00');
    // The day before still excludes it.
    const tbBefore = await trialBalance(ctx, new Date('2024-03-30'));
    expect(tbBefore.rows.find((r) => r.code === '1500')).toBeUndefined();
  });

  /** The fallback dedupe key earlier versions stored (import.ts hashFitId over the stored date). */
  const oldHash = (date: Date, description: string, amount: string, occurrence = 0) =>
    'csv-hash:' + createHash('sha256').update(`${date.toISOString()}|${description}|${amount}|${occurrence}`).digest('hex').slice(0, 32);

  async function freshFeed(code: string) {
    const gl = (await createAccount(ctx, { code, name: `Feed ${code}`, type: 'asset' as never, subtype: 'checking' })).id;
    return (await createBankAccount(ctx, { accountId: gl, bankName: 'Bank', accountNumber: code })).id;
  }

  it('re-importing a format-less CSV staged before the date fix adds no duplicates (Berlin / LA)', async () => {
    const prev = process.env.TZ;
    const csv = 'Date,Description,Amount\n01/31/2024,Coffee,-5.00\n01/31/2024,Coffee,-5.00\n02/01/2024,Rent,-900.00\n';
    const map = { dateCol: 'Date', descriptionCol: 'Description', amountCol: 'Amount' } as never;
    try {
      for (const [tz, code] of [['Europe/Berlin', '1101'], ['America/Los_Angeles', '1102']] as const) {
        process.env.TZ = tz;
        const ba = await freshFeed(code);
        // What the old code stored: the engine's local-midnight date and the hash over it.
        for (const [raw, desc, amt, occ] of [['01/31/2024', 'Coffee', '-5.00', 0], ['01/31/2024', 'Coffee', '-5.00', 1], ['02/01/2024', 'Rent', '-900.00', 0]] as const) {
          const oldDate = new Date(raw);
          await db.insert(bankTransactions).values({
            companyId: ctx.companyId, bankAccountId: ba, date: oldDate, description: desc, amount: amt, fitId: oldHash(oldDate, desc, amt, occ),
          });
        }
        const again = await importTransactions(ctx, { bankAccountId: ba, fileType: 'csv', content: csv, csvMapping: map });
        expect([tz, again.imported, again.skippedDupes]).toEqual([tz, 0, 3]);
        // A new line in the same file still comes in, and re-importing after the fix stays idempotent.
        const more = await importTransactions(ctx, { bankAccountId: ba, fileType: 'csv', content: `${csv}02/02/2024,Tea,-3.00\n`, csvMapping: map });
        expect([tz, more.imported, more.skippedDupes]).toEqual([tz, 1, 3]);
        const twice = await importTransactions(ctx, { bankAccountId: ba, fileType: 'csv', content: `${csv}02/02/2024,Tea,-3.00\n`, csvMapping: map });
        expect([tz, twice.imported]).toEqual([tz, 0]);
      }
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  it('re-importing an OFX without FITIDs (times of day) staged before the date fix adds no duplicates', async () => {
    const ba = await freshFeed('1103');
    const ofx = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240305083000[0:GMT]<TRNAMT>-20.00<NAME>SHOP</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240305170000<TRNAMT>-20.00<NAME>SHOP</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    for (const iso of ['2024-03-05T08:30:00Z', '2024-03-05T17:00:00Z']) {
      const oldDate = new Date(iso);
      await db.insert(bankTransactions).values({
        companyId: ctx.companyId, bankAccountId: ba, date: oldDate, description: 'SHOP', amount: '-20.00', fitId: oldHash(oldDate, 'SHOP', '-20.00', 0),
      });
    }
    const again = await importTransactions(ctx, { bankAccountId: ba, fileType: 'ofx', content: ofx });
    expect([again.imported, again.skippedDupes]).toEqual([0, 2]);
  });

  it('CSV dates without an explicit format do not shift a day east or west of UTC', () => {
    const prev = process.env.TZ;
    const map = { dateCol: 'Date', descriptionCol: 'Description', amountCol: 'Amount' } as never;
    try {
      for (const tz of ['Europe/Berlin', 'America/Los_Angeles']) {
        process.env.TZ = tz;
        const rows = parseCSV('Date,Description,Amount\n01/31/2024,Coffee,-5.00\n2024-02-29,Tea,-3.00\n', map);
        expect(rows[0].date.toISOString(), tz).toBe('2024-01-31T00:00:00.000Z');
        expect(rows[1].date.toISOString(), tz).toBe('2024-02-29T00:00:00.000Z');
      }
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });
});
