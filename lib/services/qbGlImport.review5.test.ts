/**
 * Review round 5 — QuickBooks reports re-saved with a decimal comma.
 *
 * A QuickBooks CSV export opened and saved again by Excel in a French-Canadian or European locale
 * comes back with ";" separators and amounts like "2 700,00". parseAmount dropped every comma and
 * space, so "2 700,00" was read as 270000.00 — and because the report's own Total and Balance
 * columns were misread the same way, the General Ledger "proof" passed: every balance went into
 * the books 100 times too large. The open-items report had the same reading. Such a report is
 * now refused with a plain message.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import Papa from 'papaparse';
import { and, eq, like } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, companies, customers, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { previewGlImport, runGlImport } from './qbGlImport';
import { importOpenItems, previewOpenItems } from './openItemsImport';
import { importIIF } from './qbImport';
import { parseAmount } from './qbGlParse';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { glCsv, glGrid, upload, SAMPLE_GL, type GlFixture } from '@/test/fixtures/qbGlFixtures';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-qbglimport-review5');
let db: DB;
let ctx: ServiceContext;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'glimport-r5@test.local', name: 'R5', passwordHash: 'x' }).returning();
  const [company] = await db.insert(companies).values({ name: 'Decimal Comma GL Co', ownerId: user.id }).returning();
  ctx = { db, companyId: company.id, userId: user.id };
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold a handle; the next run wipes the dir first. */
  }
});

/** "2,700.00" → "2 700,00" (what a French-Canadian Excel writes). */
const commaDecimal = (cell: string) => (/^-?[\d,]+\.\d{2}$/.test(cell) ? cell.replace(/,/g, ' ').replace('.', ',') : cell);

describe('jobs set up in Ironbooks before the General Ledger import', () => {
  it('"Acme Corp:Job 1" on an A/R line is the existing job — no duplicate customer, the line keeps its name', async () => {
    const co = await createCompany(db, { name: 'Existing Job Co', ownerId: ctx.userId! });
    const c: ServiceContext = { db, companyId: co.id, userId: ctx.userId };
    const parent = await createCustomer(c, { displayName: 'Acme Corp' });
    const job = await createCustomer(c, { displayName: 'Job 1', parentId: parent.id });
    const fx: GlFixture = {
      company: 'Existing Job Co',
      periodLabel: 'January 1 through January 31, 2024',
      accounts: [
        { number: '11000', name: 'Accounts Receivable', type: 'Accounts Receivable', begin: '0.00' },
        { number: '40000', name: 'Sales', type: 'Income', begin: '0.00' },
      ],
      txns: [
        { type: 'Invoice', date: '01/05/2024', num: '10', name: 'Acme Corp:Job 1', lines: [
          { acct: '11000', amount: '110.00' },
          { acct: '40000', amount: '-110.00' },
        ] },
      ],
    };
    const r = await runGlImport(c, { file: upload('gl.csv', glCsv(fx)) });
    expect(r.ok).toBe(true);
    expect(r.counts.customersCreated).toBe(0);
    expect((await db.select().from(customers).where(eq(customers.companyId, c.companyId))).length).toBe(2);
    const [arLine] = await db
      .select({ entityType: journalEntryLines.entityType, entityId: journalEntryLines.entityId })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
      .innerJoin(accounts, eq(accounts.id, journalEntryLines.accountId))
      .where(and(eq(journalEntries.companyId, c.companyId), eq(accounts.subtype, 'accounts_receivable'), like(journalEntries.sourceRef, 'qbgl:%')));
    expect(arLine).toEqual({ entityType: 'customer', entityId: job.id });
  });

  it('the IIF and open-items imports find the existing job by its full name too', async () => {
    const co = await createCompany(db, { name: 'Existing Job IIF Co', ownerId: ctx.userId! });
    const c: ServiceContext = { db, companyId: co.id, userId: ctx.userId };
    const parent = await createCustomer(c, { displayName: 'Acme Corp' });
    await createCustomer(c, { displayName: 'Job 1', parentId: parent.id });
    const iif = await importIIF(c, ['!CUST\tNAME', 'CUST\tAcme Corp:Job 1'].join('\r\n'));
    expect(iif.customers).toBe(0);
    const oi = await importOpenItems(c, { side: 'ar', alreadyInGl: false, items: [{ kind: 'invoice', name: 'Acme Corp:Job 1', date: '2024-02-01', openBalance: '50.00' }] });
    expect(oi.invoices).toBe(1);
    expect((await db.select().from(customers).where(eq(customers.companyId, c.companyId))).length).toBe(2);
  });
});

describe('reports re-saved with a decimal comma', () => {
  it('parseAmount never reads "2 700,00" as 270000', () => {
    expect(parseAmount('2 700,00')).toBeNull();
    expect(parseAmount('12,50')).toBeNull();
    expect(parseAmount('1,234.56')?.toFixed(2)).toBe('1234.56');
    expect(parseAmount('(1,234.56)')?.toFixed(2)).toBe('-1234.56');
    expect(parseAmount('1,234')?.toFixed(2)).toBe('1234.00');
  });

  it('the General Ledger import refuses the report instead of importing every balance 100 times over', async () => {
    // As Google Sheets (or another tool) in a French-Canadian locale writes it: "," between the
    // fields, the amounts quoted with their decimal comma.
    const grid = glGrid(SAMPLE_GL).map((r) => r.map(commaDecimal));
    const csv = Papa.unparse(grid);
    expect(csv).toContain('2 700,00');
    const file = upload('gl.csv', csv);
    const preview = await previewGlImport(ctx, { file });
    expect(preview.errors.some((e) => /decimal comma/.test(e))).toBe(true);
    await expect(runGlImport(ctx, { file })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('the Open Invoices report is refused too', async () => {
    const csv = ['"Open Invoices"', ',Type,Date,Num,Due Date,Open Balance', 'Acme,,,,,', ',Invoice,12/05/2025,1001,01/04/2026,"1 250,00"', 'Total Acme,,,,,"1 250,00"'].join('\r\n');
    await expect(previewOpenItems(ctx, { file: { name: 'open.csv', data: Buffer.from(csv).toString('base64') } })).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/decimal comma/),
    });
  });
});
