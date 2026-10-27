/**
 * Review round 5 — AI account suggestions on a large company file (failed before the fix): the
 * learned categorizer trains on every bank-feed line the user categorized. It looked up their
 * journal lines with one bound parameter per line (`IN ($1 … $n)`), which the database refuses
 * past 65,535 parameters — so on a file with that much bank history every suggestion request
 * (and "Retrain now") failed. The lines are now joined in SQL, with no per-line parameters.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { aiAutoApplied, bankAccounts, bankTransactions } from '@/lib/db/schema';
import { postJournalEntry } from './posting';
import { syncModel } from './aiCategorizer';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;

beforeAll(async () => {
  t = await makeTestCompany('r5-aicat');
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('learned categorizer on a large bank history', () => {
  it('trains on more categorized bank lines than the database allows parameters', async () => {
    const [ba] = await t.db
      .insert(bankAccounts)
      .values({ companyId: t.ctx.companyId, accountId: t.acct['1000'], bankName: 'R5 Bank', accountNumber: '000999' })
      .returning();
    const entry = await postJournalEntry(t.ctx, {
      date: new Date('2026-03-01T00:00:00Z'),
      description: 'Bank feed: Coffee',
      sourceRef: 'bank_transaction:r5',
      lines: [
        { accountId: t.acct['6300'], debit: '4.50' },
        { accountId: t.acct['1000'], credit: '4.50' },
      ],
    });
    // 66,000 feed lines matched to categorized entries (a few years of a busy account; here they
    // all point at one entry, which is enough to need one parameter per line).
    await t.db.execute(sql`
      INSERT INTO bank_transactions (company_id, bank_account_id, date, description, payee, amount, matched, matched_entry_id)
      SELECT ${t.ctx.companyId}::uuid, ${ba.id}::uuid, '2026-03-01'::timestamp, 'COFFEE #' || g, 'Coffee Shop', '-4.50', true, ${entry.id}::uuid
      FROM generate_series(1, 66000) AS g`);
    const { learned, state } = await syncModel(t.ctx, { full: true });
    expect(learned).toBeGreaterThanOrEqual(1);
    expect(state.docs).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it('learns the category of a categorized bank line (not the bank side), and skips AI auto-applied ones', async () => {
    const [ba] = await t.db
      .insert(bankAccounts)
      .values({ companyId: t.ctx.companyId, accountId: t.acct['1000'], bankName: 'R5 Bank 2', accountNumber: '000998' })
      .returning();
    const mk = async (payee: string, account: string) => {
      const e = await postJournalEntry(t.ctx, {
        date: new Date('2026-04-01T00:00:00Z'),
        description: `Bank feed: ${payee}`,
        sourceRef: `bank_transaction:${payee}`,
        lines: [
          { accountId: t.acct['1000'], credit: '20.00' },
          { accountId: t.acct[account], debit: '20.00' },
        ],
      });
      await t.db.insert(bankTransactions).values({
        companyId: t.ctx.companyId,
        bankAccountId: ba.id,
        date: new Date('2026-04-01T00:00:00Z'),
        payee,
        description: payee,
        amount: '-20.00',
        matched: true,
        matchedEntryId: e.id,
      });
      return e;
    };
    await mk('R5 Hardware Barn', '6600');
    const auto = await mk('R5 Robot Picked', '6300');
    const [btx] = await t.db.select().from(bankTransactions).where(eq(bankTransactions.matchedEntryId, auto.id));
    await t.db.insert(aiAutoApplied).values({
      companyId: t.ctx.companyId,
      bankTransactionId: btx.id,
      journalEntryId: auto.id,
      accountId: t.acct['6300'],
      confidence: '0.9900',
    });
    const { state } = await syncModel(t.ctx, { full: true });
    // The hardware purchase was learned under its category (6600), never under the bank (1000).
    expect(Object.keys(state.heads.account.docs)).toContain(t.acct['6600']);
    expect(Object.keys(state.heads.account.docs)).not.toContain(t.acct['1000']);
    // The AI's own pick was not learned (its payee words are unknown to the model).
    expect(JSON.stringify(state.vocab)).toMatch(/hardware/i);
    expect(JSON.stringify(state.vocab)).not.toMatch(/robot/i);
  });
});
