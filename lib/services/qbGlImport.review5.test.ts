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
import { getDb, closeDb, type DB } from '@/lib/db';
import { companies, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { previewGlImport, runGlImport } from './qbGlImport';
import { previewOpenItems } from './openItemsImport';
import { parseAmount } from './qbGlParse';
import { glGrid, upload, SAMPLE_GL } from '@/test/fixtures/qbGlFixtures';

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
