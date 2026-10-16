/**
 * Regression tests from the second data in/out review.
 *
 *  1. Condense releases EVERY foreign key to the entries / lines it removes (found from the
 *     database catalogue): a Sales Tax Payment check keeps its row with the GL link cleared, and
 *     the AI auto-apply undo record of a condensed entry is removed with its bank-feed row.
 *  2. A per-company restore gives the restored company its own copy of every attachment file,
 *     so deleting a document in one company never deletes the other's file; deleteAttachment
 *     also keeps a file another row still names.
 *  3. Stored attachment paths must resolve inside <dataDir>/attachments on read, delete and
 *     restore (no "../" traversal from a crafted backup).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import AdmZip from 'adm-zip';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  users, companies, accounts, paymentChecks, journalEntries, attachments, bankAccounts,
  bankTransactions, aiAutoApplied, taxAgencies, journalEntryLines, salesTaxLineLinks,
} from '@/lib/db/schema';
import { linkSalesTaxLine } from './accountant/salesTaxTools';
import { salesTaxLiabilityReport } from './accountant/salesTaxLedger';
import type { ServiceContext } from './_base';
import { postJournalEntry } from './posting';
import { condensePeriod } from './condense';
import { paySalesTax } from './liabilityPayments';
import {
  saveAttachment, deleteAttachment, getAttachmentFile, safeAttachmentPath, attachmentAbsolutePath,
} from './attachments';
import { COMPANY_DATA_ENTRY, createCompanyBackup, restoreCompanyBackup } from './backup';

const TEST_ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review2-data');
const TEST_DIR = path.join(TEST_ROOT, 'data');

let db: DB;

beforeAll(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  process.env.BKA_DATA_DIR = TEST_DIR;
  db = await getDb(TEST_DIR);
}, 120_000);

afterAll(async () => {
  delete process.env.BKA_DATA_DIR;
  await closeDb(TEST_DIR).catch(() => undefined);
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

async function newCompany(name: string) {
  const [user] = await db
    .insert(users)
    .values({ email: `${name.replace(/\W/g, '')}@review2.local`, name, passwordHash: 'x' })
    .returning();
  const [company] = await db.insert(companies).values({ name, ownerId: user.id }).returning();
  const c: ServiceContext = { db, companyId: company.id, userId: user.id };
  const mk = async (code: string, n: string, type: string, subtype: string) => {
    const [a] = await db
      .insert(accounts)
      .values({ companyId: company.id, code, name: n, type: type as never, subtype: subtype as never })
      .returning();
    return a.id;
  };
  return { c, company, mk };
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('condense releases every foreign key to the removed entries', () => {
  it('keeps a Sales Tax Payment check (link cleared) and removes the AI auto-apply record of a condensed entry', async () => {
    const { c: ctx, company, mk } = await newCompany('Condense STax Co');
    const bank = await mk('1000', 'Checking', 'asset', 'checking');
    const rev = await mk('4000', 'Sales', 'revenue', 'sales');
    const exp = await mk('6000', 'Supplies', 'expense', 'operating_expenses');
    await mk('2200', 'Sales Tax Payable', 'liability', 'other_current_liability');

    await postJournalEntry(ctx, {
      date: new Date('2024-01-10T00:00:00Z'),
      description: 'Cash sale',
      lines: [
        { accountId: bank, debit: '500.00' },
        { accountId: rev, credit: '500.00' },
      ],
    });
    const taxEntry = await paySalesTax(ctx, {
      amount: '25.00',
      date: new Date('2024-01-31T00:00:00Z'),
      paymentAccountId: bank,
      checkNumber: '101',
    });

    // A bank-feed line the AI auto-applied to an expense entry.
    const aiEntry = await postJournalEntry(ctx, {
      date: new Date('2024-02-03T00:00:00Z'),
      description: 'Office supplies (bank feed)',
      lines: [
        { accountId: exp, debit: '40.00' },
        { accountId: bank, credit: '40.00' },
      ],
    });
    const [ba] = await db
      .insert(bankAccounts)
      .values({ companyId: company.id, accountId: bank, bankName: 'Test Bank', accountNumber: '1234' })
      .returning();
    const [feed] = await db
      .insert(bankTransactions)
      .values({
        companyId: company.id, bankAccountId: ba.id, date: new Date('2024-02-03T00:00:00Z'),
        amount: '-40.00', matched: true, matchedEntryId: aiEntry.id,
      })
      .returning();
    await db.insert(aiAutoApplied).values({
      companyId: company.id, bankTransactionId: feed.id, journalEntryId: aiEntry.id, accountId: exp, confidence: '0.9500',
    });

    await db
      .update(companies)
      .set({ settings: { closingDate: '2024-12-31' } as never })
      .where(eq(companies.id, company.id));

    const result = await condensePeriod(ctx, { beforeDate: new Date('2025-01-01T00:00:00Z'), dataDir: TEST_DIR });
    expect(result.entriesToCondense).toBeGreaterThan(0);

    const checks = await db.select().from(paymentChecks).where(eq(paymentChecks.companyId, company.id));
    expect(checks).toHaveLength(1);
    expect(checks[0].postedEntryId).toBeNull();
    expect(await db.select().from(journalEntries).where(eq(journalEntries.id, taxEntry.id))).toHaveLength(0);
    expect(await db.select().from(aiAutoApplied).where(eq(aiAutoApplied.companyId, company.id))).toHaveLength(0);
    expect(await db.select().from(bankTransactions).where(eq(bankTransactions.id, feed.id))).toHaveLength(0);
  }, 120_000);
});

describe('condense keeps sales-tax-agency-linked entries in detail', () => {
  it('a Fix-Sales-Tax linked line stays, its link survives and the agency liability is unchanged', async () => {
    const { c: ctx, company, mk } = await newCompany('Condense Tax Link Co');
    const bank = await mk('1000', 'Checking', 'asset', 'checking');
    const rev = await mk('4000', 'Sales', 'revenue', 'sales');
    const stp = await mk('2200', 'Sales Tax Payable', 'liability', 'other_current_liability');
    const [agency] = await db
      .insert(taxAgencies)
      .values({ companyId: company.id, name: 'State DOR', liabilityAccountId: stp })
      .returning();

    // Plain activity that IS condensed.
    await postJournalEntry(ctx, {
      date: new Date('2024-01-05T00:00:00Z'),
      description: 'Cash sale',
      lines: [
        { accountId: bank, debit: '300.00' },
        { accountId: rev, credit: '300.00' },
      ],
    });
    // Tax recorded by hand on a General Journal entry, then attributed to the agency.
    const linked = await postJournalEntry(ctx, {
      date: new Date('2024-01-20T00:00:00Z'),
      description: 'Sales tax recorded by hand',
      lines: [
        { accountId: bank, debit: '8.00' },
        { accountId: stp, credit: '8.00' },
      ],
    });
    const [taxLine] = await db
      .select()
      .from(journalEntryLines)
      .where(and(eq(journalEntryLines.journalEntryId, linked.id), eq(journalEntryLines.accountId, stp)));
    await linkSalesTaxLine(ctx, { lineId: taxLine.id, agencyId: agency.id, kind: 'collected' });

    const before = await salesTaxLiabilityReport(ctx, { to: new Date('2025-06-30T00:00:00Z') });

    await db
      .update(companies)
      .set({ settings: { closingDate: '2024-12-31' } as never })
      .where(eq(companies.id, company.id));
    const result = await condensePeriod(ctx, { beforeDate: new Date('2025-01-01T00:00:00Z'), dataDir: TEST_DIR });
    expect(result.entriesToCondense).toBe(1);

    expect(await db.select().from(journalEntries).where(eq(journalEntries.id, linked.id))).toHaveLength(1);
    expect(await db.select().from(salesTaxLineLinks).where(eq(salesTaxLineLinks.journalEntryLineId, taxLine.id))).toHaveLength(1);
    const after = await salesTaxLiabilityReport(ctx, { to: new Date('2025-06-30T00:00:00Z') });
    expect(after.agencies).toEqual(before.agencies);
    expect(after.totals).toEqual(before.totals);
    const agencyRow = after.agencies.find((a) => a.agencyId === agency.id);
    expect(agencyRow).toBeTruthy();
  }, 120_000);
});

describe('condense refuses unknown NOT NULL referrers instead of deleting them', () => {
  it('throws VALIDATION and changes nothing', async () => {
    const { c: ctx, company, mk } = await newCompany('Condense Unknown Ref Co');
    const bank = await mk('1000', 'Checking', 'asset', 'checking');
    const rev = await mk('4000', 'Sales', 'revenue', 'sales');
    const e = await postJournalEntry(ctx, {
      date: new Date('2024-03-05T00:00:00Z'),
      description: 'Cash sale',
      lines: [
        { accountId: bank, debit: '50.00' },
        { accountId: rev, credit: '50.00' },
      ],
    });
    await db.execute(sql`CREATE TABLE review2_required_ref (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entry_id uuid NOT NULL REFERENCES journal_entries(id))`);
    try {
      await db.execute(sql`INSERT INTO review2_required_ref (entry_id) VALUES (${e.id})`);
      await db
        .update(companies)
        .set({ settings: { closingDate: '2024-12-31' } as never })
        .where(eq(companies.id, company.id));
      await expect(
        condensePeriod(ctx, { beforeDate: new Date('2025-01-01T00:00:00Z'), dataDir: TEST_DIR }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(await db.select().from(journalEntries).where(eq(journalEntries.id, e.id))).toHaveLength(1);
      const left = await db.execute(sql`SELECT count(*)::int AS n FROM review2_required_ref`);
      expect(((left as unknown as { rows: Array<{ n: number }> }).rows)[0].n).toBe(1);
    } finally {
      await db.execute(sql`DROP TABLE review2_required_ref`);
    }
  }, 120_000);
});

describe('per-company restore and attachment files', () => {
  it('gives the restored company its own file: deleting either document keeps the other', async () => {
    const { c } = await newCompany('Attach Source Co');
    const att = await saveAttachment(c, { filename: 'receipt.txt', mimeType: 'text/plain', base64: b64('original receipt') } as never);
    const backup = await createCompanyBackup(db, c.companyId);
    const restored = await restoreCompanyBackup(db, backup.buffer, { ownerId: c.userId!, name: 'Attach Restored Co' });
    const rctx: ServiceContext = { db, companyId: restored.companyId, userId: c.userId };
    const [copy] = await db.select().from(attachments).where(eq(attachments.companyId, restored.companyId));
    expect(copy).toBeTruthy();
    expect(copy.storagePath).not.toBe(att.storagePath);
    expect((await getAttachmentFile(rctx, copy.id)).buffer.toString()).toBe('original receipt');

    await deleteAttachment(rctx, copy.id);
    expect((await getAttachmentFile(c, att.id)).buffer.toString()).toBe('original receipt');
  }, 120_000);

  it('deleteAttachment keeps a file another row still names (rows restored by older builds)', async () => {
    const { c } = await newCompany('Attach Shared Co');
    const { c: other } = await newCompany('Attach Shared Other Co');
    const att = await saveAttachment(c, { filename: 'shared.txt', mimeType: 'text/plain', base64: b64('shared') } as never);
    const [twin] = await db
      .insert(attachments)
      .values({
        companyId: other.companyId,
        filename: 'shared.txt',
        // Same file, older Windows spelling.
        storagePath: att.storagePath.replace(/\//g, '\\'),
      })
      .returning();
    await deleteAttachment(other, twin.id);
    expect((await getAttachmentFile(c, att.id)).buffer.toString()).toBe('shared');
  }, 120_000);
});

describe('attachment paths cannot leave the attachments folder', () => {
  it('safeAttachmentPath accepts the store and refuses traversal / other folders', () => {
    expect(safeAttachmentPath(TEST_DIR, 'attachments/a-b.txt')).toBe(attachmentAbsolutePath(TEST_DIR, 'attachments/a-b.txt'));
    expect(safeAttachmentPath(TEST_DIR, 'attachments\\a-b.txt')).not.toBeNull();
    expect(safeAttachmentPath(TEST_DIR, 'attachments/../../secret.txt')).toBeNull();
    expect(safeAttachmentPath(TEST_DIR, '..\\outside.txt')).toBeNull();
    expect(safeAttachmentPath(TEST_DIR, '.auth-secret')).toBeNull();
    expect(safeAttachmentPath(TEST_DIR, 'attachments')).toBeNull();
    expect(safeAttachmentPath(TEST_DIR, '')).toBeNull();
  });

  it('read and delete refuse a traversal path and never touch the outside file', async () => {
    const { c } = await newCompany('Attach Traversal Co');
    const outside = path.join(TEST_ROOT, 'outside.txt');
    fs.writeFileSync(outside, 'do not touch');
    const [row] = await db
      .insert(attachments)
      .values({ companyId: c.companyId, filename: 'x.txt', storagePath: 'attachments/../../outside.txt' })
      .returning();
    await expect(getAttachmentFile(c, row.id)).rejects.toThrow(/not found/i);
    await deleteAttachment(c, row.id);
    expect(fs.readFileSync(outside, 'utf8')).toBe('do not touch');
  }, 120_000);

  it('restore refuses a backup whose attachment path leaves the store', async () => {
    const { c } = await newCompany('Attach Crafted Co');
    await saveAttachment(c, { filename: 'ok.txt', mimeType: 'text/plain', base64: b64('ok') } as never);
    const backup = await createCompanyBackup(db, c.companyId);
    const zip = new AdmZip(backup.buffer);
    const data = JSON.parse(zip.readAsText(COMPANY_DATA_ENTRY));
    data.tables.attachments[0].storagePath = 'attachments/../../outside.txt';
    zip.updateFile(COMPANY_DATA_ENTRY, Buffer.from(JSON.stringify(data), 'utf8'));
    const before = (await db.select().from(companies)).length;
    await expect(
      restoreCompanyBackup(db, zip.toBuffer(), { ownerId: c.userId!, name: 'Attach Crafted Restored' }),
    ).rejects.toThrow(/outside the attachments folder/);
    expect((await db.select().from(companies)).length).toBe(before);
  }, 120_000);
});
