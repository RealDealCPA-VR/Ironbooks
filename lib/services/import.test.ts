/**
 * Integration tests for the banking-import module.
 *
 * Boots a throwaway PGlite database, seeds a user + company + bank account,
 * then exercises parseOFX, parseCSV, importTransactions (including dedupe),
 * and the categorization-rules service.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq, and } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users,
  companies,
  accounts,
  bankAccounts,
  bankTransactions,
  fileImports,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { parseOFX, parseCSV, importTransactions } from './import';
import { createRule, listRules, applyRules } from './rules';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A minimal two-transaction OFX file (SGML format, no closing tags — real-world style). */
const SAMPLE_OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:151
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>USD
<BANKTRANLIST>
<DTSTART>20240101
<DTEND>20240131
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240105120000
<TRNAMT>1500.00
<FITID>TXN001
<NAME>ACME CORP PAYROLL
<MEMO>Direct Deposit
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240110
<TRNAMT>-89.99
<FITID>TXN002
<NAME>AMAZON.COM
<MEMO>Office supplies
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

/** A minimal CSV export with header row. */
const SAMPLE_CSV = `Date,Description,Amount
2024-01-15,Stripe Payout,2500.00
2024-01-20,AWS Cloud Services,-220.50
2024-01-25,Google Ads,-150.00
`;

const CSV_MAPPING = {
  dateCol: 'Date',
  descriptionCol: 'Description',
  amountCol: 'Amount',
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-import');
let ctx: ServiceContext;
let db: DB;
let bankAccountId: string;
let checkingAccountId: string;

describe('Banking import module', () => {
  beforeAll(async () => {
    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'importer@test.local', name: 'Importer', passwordHash: 'x' })
      .returning();

    const [company] = await db
      .insert(companies)
      .values({ name: 'Import Test Co', ownerId: user.id })
      .returning();

    ctx = { db, companyId: company.id, userId: user.id };

    // Seed a checking account (GL account) + an expense account for rules.
    const [checkingGL] = await db
      .insert(accounts)
      .values({
        companyId: company.id,
        code: '1000',
        name: 'Checking',
        type: 'asset',
        subtype: 'checking',
      })
      .returning();
    checkingAccountId = checkingGL.id;

    const [expenseAcct] = await db
      .insert(accounts)
      .values({
        companyId: company.id,
        code: '6000',
        name: 'Advertising',
        type: 'expense',
        subtype: 'operating_expenses',
      })
      .returning();

    // Bank account record that links the GL account to a real bank.
    const [bankAcct] = await db
      .insert(bankAccounts)
      .values({
        companyId: company.id,
        accountId: checkingGL.id,
        bankName: 'First National',
        accountNumber: '****1234',
      })
      .returning();
    bankAccountId = bankAcct.id;

    // Seed a categorization rule: description contains "google ads" → Advertising.
    await createRule(ctx, {
      name: 'Google Ads → Advertising',
      matchField: 'description',
      matchOperator: 'contains',
      matchValue: 'google ads',
      setAccountId: expenseAcct.id,
      priority: 10,
    });
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Unit-level parser tests (no DB needed, but DB is available)
  // -------------------------------------------------------------------------

  describe('parseOFX', () => {
    it('parses two transactions from SGML OFX with header lines', () => {
      const txns = parseOFX(SAMPLE_OFX);
      expect(txns).toHaveLength(2);
    });

    it('extracts FITID, date, description, and amount correctly', () => {
      const txns = parseOFX(SAMPLE_OFX);
      const [t1, t2] = txns;

      expect(t1.fitId).toBe('TXN001');
      // DTPOSTED 20240105120000: the posting DAY at UTC midnight (the time of day is dropped so
      // the line counts in "as of Jan 5" reports and reconciliations — review3).
      expect(t1.date).toEqual(new Date('2024-01-05T00:00:00Z'));
      expect(t1.amount).toBe('1500.00');
      expect(t1.description).toContain('ACME CORP PAYROLL');

      expect(t2.fitId).toBe('TXN002');
      expect(t2.date).toEqual(new Date('2024-01-10T00:00:00Z'));
      expect(t2.amount).toBe('-89.99');
      expect(t2.description).toContain('AMAZON.COM');
    });

    it('handles OFX without header lines', () => {
      const noHeader = SAMPLE_OFX.replace(/^[\s\S]*?(?=<OFX>)/i, '');
      const txns = parseOFX(noHeader);
      expect(txns).toHaveLength(2);
    });
  });

  describe('parseCSV', () => {
    it('parses three CSV rows', () => {
      const txns = parseCSV(SAMPLE_CSV, CSV_MAPPING);
      expect(txns).toHaveLength(3);
    });

    it('maps columns and converts amounts', () => {
      const txns = parseCSV(SAMPLE_CSV, CSV_MAPPING);
      expect(txns[0].amount).toBe('2500.00');
      expect(txns[1].amount).toBe('-220.50');
      expect(txns[0].description).toBe('Stripe Payout');
    });

    it('handles debit/credit split columns', () => {
      const splitCsv = `Date,Desc,Debit,Credit\n2024-02-01,Payment,100.00,\n2024-02-02,Deposit,,500.00\n`;
      const txns = parseCSV(splitCsv, {
        dateCol: 'Date',
        descriptionCol: 'Desc',
        amountCol: 'Debit', // ignored when debitCol/creditCol present
        debitCol: 'Debit',
        creditCol: 'Credit',
      });
      expect(txns[0].amount).toBe('-100.00'); // debit = outflow
      expect(txns[1].amount).toBe('500.00');  // credit = inflow
    });
  });

  // -------------------------------------------------------------------------
  // importTransactions integration tests
  // -------------------------------------------------------------------------

  describe('importTransactions (OFX)', () => {
    it('creates a fileImports row and stages bank_transactions', async () => {
      const summary = await importTransactions(ctx, {
        bankAccountId,
        fileType: 'ofx',
        content: SAMPLE_OFX,
        filename: 'jan2024.ofx',
      });

      expect(summary.parsed).toBe(2);
      expect(summary.imported).toBe(2);
      expect(summary.skippedDupes).toBe(0);
      expect(summary.errors).toBe(0);

      // Verify fileImports row.
      const [importRow] = await db
        .select()
        .from(fileImports)
        .where(eq(fileImports.id, summary.fileImportId));
      expect(importRow.status).toBe('completed');
      expect(importRow.totalTransactions).toBe(2);
      expect(importRow.importedTransactions).toBe(2);

      // Verify staged transactions.
      const staged = await db
        .select()
        .from(bankTransactions)
        .where(
          and(
            eq(bankTransactions.companyId, ctx.companyId),
            eq(bankTransactions.fileImportId, summary.fileImportId),
          ),
        );
      expect(staged).toHaveLength(2);
      expect(staged.every((t) => t.matched === false)).toBe(true);
      // fitIds preserved.
      const fitIds = staged.map((t) => t.fitId);
      expect(fitIds).toContain('TXN001');
      expect(fitIds).toContain('TXN002');
    });

    it('deduplicates transactions by fitId on re-import', async () => {
      // Import the same OFX again — both fitIds already exist.
      const summary = await importTransactions(ctx, {
        bankAccountId,
        fileType: 'ofx',
        content: SAMPLE_OFX,
        filename: 'jan2024_retry.ofx',
      });

      expect(summary.parsed).toBe(2);
      expect(summary.imported).toBe(0);
      expect(summary.skippedDupes).toBe(2);
    });
  });

  describe('importTransactions (CSV)', () => {
    it('imports CSV rows and sets suggestedAccountId via rules', async () => {
      const summary = await importTransactions(ctx, {
        bankAccountId,
        fileType: 'csv',
        content: SAMPLE_CSV,
        csvMapping: CSV_MAPPING,
        filename: 'jan2024.csv',
      });

      expect(summary.parsed).toBe(3);
      expect(summary.imported).toBe(3);

      // Fetch staged rows.
      const staged = await db
        .select()
        .from(bankTransactions)
        .where(
          and(
            eq(bankTransactions.companyId, ctx.companyId),
            eq(bankTransactions.fileImportId, summary.fileImportId),
          ),
        );
      expect(staged).toHaveLength(3);

      // "Google Ads" should have a suggestedAccountId set by the rule.
      const googleRow = staged.find((t) => t.description?.toLowerCase().includes('google ads'));
      expect(googleRow).toBeDefined();
      expect(googleRow!.suggestedAccountId).not.toBeNull();

      // "Stripe Payout" and "AWS Cloud Services" should have no suggestion (no matching rule).
      const stripeRow = staged.find((t) => t.description?.includes('Stripe'));
      expect(stripeRow!.suggestedAccountId).toBeNull();
    });

    it('rejects CSV import without mapping', async () => {
      await expect(
        importTransactions(ctx, {
          bankAccountId,
          fileType: 'csv',
          content: SAMPLE_CSV,
          // csvMapping intentionally omitted
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });
  });

  // -------------------------------------------------------------------------
  // Categorization rules
  // -------------------------------------------------------------------------

  describe('categorization rules', () => {
    it('createRule validates account belongs to company', async () => {
      await expect(
        createRule(ctx, {
          name: 'Bad rule',
          matchField: 'description',
          matchOperator: 'contains',
          matchValue: 'test',
          setAccountId: '00000000-0000-0000-0000-000000000000', // non-existent
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('listRules returns active rules ordered by priority', async () => {
      const rules = await listRules(ctx);
      expect(rules.length).toBeGreaterThanOrEqual(1);
      // Priority should be descending (highest first).
      for (let i = 1; i < rules.length; i++) {
        expect(rules[i - 1].priority).toBeGreaterThanOrEqual(rules[i].priority);
      }
    });

    it('applyRules matches contains operator case-insensitively', async () => {
      const accountId = await applyRules(ctx, {
        description: 'GOOGLE ADS CAMPAIGN',
        amount: '-150.00',
      });
      expect(accountId).not.toBeNull();
    });

    it('applyRules returns null when no rule matches', async () => {
      const accountId = await applyRules(ctx, {
        description: 'RANDOM UNKNOWN VENDOR',
        amount: '-50.00',
      });
      expect(accountId).toBeNull();
    });

    it('applyRules respects equals operator', async () => {
      // Seed an exact-match rule.
      const accountId2 = await createRule(ctx, {
        name: 'Exact payroll',
        matchField: 'description',
        matchOperator: 'equals',
        matchValue: 'payroll run',
        setAccountId: checkingAccountId,
        priority: 5,
      });

      const hit = await applyRules(ctx, { description: 'payroll run', amount: '-5000.00' });
      expect(hit).toBe(checkingAccountId);

      const miss = await applyRules(ctx, { description: 'payroll run extra', amount: '-5000.00' });
      // "equals" should NOT match a longer string.
      expect(miss === checkingAccountId).toBe(false);
    });
  });
});
