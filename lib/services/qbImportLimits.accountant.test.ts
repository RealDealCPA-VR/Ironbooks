/**
 * Feature round (accountant team) — review round 5 leftovers (imports):
 *  - no size cap on IIF / CSV text sent to /api/import/qb and /api/qb-import: the other import
 *    paths refuse files over 60 MB, these read any size into memory. The import services now
 *    refuse them before parsing.
 *  - a PDF page that pdf.js can't read (past getDocument) escaped qbGlFiles.readPdfLines as an
 *    unexpected error (a 500) instead of a plain "this PDF could not be read" message.
 *  - a General Ledger CSV saved with ';' separators (European Excel) was not recognised.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { ServiceContext } from './_base';
import { MAX_QB_IMPORT_BODY_BYTES, MAX_QB_IMPORT_BYTES, importBodyTooLarge, importCustomersCSV, importIIF, importListXlsx } from './qbImport';
import { loadGrid, readPdfLines } from './qbGlFiles';
import { SAMPLE_GL, glCsv } from '@/test/fixtures/qbGlFixtures';

// The size check runs before anything touches the database.
const ctx = { db: {} as never, companyId: '00000000-0000-4000-8000-000000000001', userId: null } as unknown as ServiceContext;

describe('QuickBooks list / IIF imports refuse files over 60 MB', () => {
  it('the routes refuse a declared body over the cap before reading it (review P2)', () => {
    const h = (v: string | null) => ({ get: (n: string) => (n === 'content-length' ? v : null) });
    expect(importBodyTooLarge(h(String(MAX_QB_IMPORT_BODY_BYTES + 1)))).toBe(true);
    expect(importBodyTooLarge(h(String(MAX_QB_IMPORT_BODY_BYTES)))).toBe(false);
    expect(importBodyTooLarge(h(null))).toBe(false);
    // A 60 MB xlsx sent as base64 in JSON still fits.
    expect(MAX_QB_IMPORT_BODY_BYTES).toBeGreaterThan(Math.ceil((MAX_QB_IMPORT_BYTES * 4) / 3));
  });

  const big = 'x'.repeat(MAX_QB_IMPORT_BYTES + 1);
  it('IIF', async () => {
    await expect(importIIF(ctx, big)).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/60 MB/) });
  });
  it('CSV', async () => {
    await expect(importCustomersCSV(ctx, big, {} as never)).rejects.toMatchObject({ code: 'VALIDATION' });
  });
  it('Excel', async () => {
    await expect(importListXlsx(ctx, 'customers', new Uint8Array(MAX_QB_IMPORT_BYTES + 1), {})).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('a PDF page that cannot be read is a plain message, not a crash', () => {
  it('a page tree that names a page that is not there', async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    page.drawText('General Ledger', { x: 50, y: 700, size: 12, font: await pdf.embedFont(StandardFonts.Helvetica) });
    const bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
    // Claim two pages and point the second at an object that is not a page.
    const broken = Buffer.from(bytes.toString('latin1').replace(/\/Count 1/, '/Count 2').replace(/\/Kids \[ (\d+) 0 R \]/, '/Kids [ $1 0 R 1 0 R ]'), 'latin1');
    const err = await readPdfLines(new Uint8Array(broken)).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).not.toBeNull();
    expect(err).toMatchObject({ code: 'VALIDATION' });
  });
});

describe('a General Ledger CSV with semicolons', () => {
  it('is read like the comma one', async () => {
    const comma = glCsv(SAMPLE_GL);
    const a = await loadGrid(Buffer.from(comma, 'utf8'), 'gl.csv');
    // Excel with ';' as the list separator: ';' between cells, and a cell is only quoted when it
    // holds a ';' — so names and memos like "Smith, John" carry bare commas.
    const cellsOf = a.sheets[0].rows.map((r) => r.cells.map((c) => c.replace(/^(-?)([\d,]+\.\d{2})$/, (_m, s: string, n: string) => s + n.replace(/,/g, ''))));
    const semi = cellsOf.map((cells) => cells.join(';')).join('\r\n');
    expect(semi).toMatch(/Smith, John/);
    const b = await loadGrid(Buffer.from(semi, 'utf8'), 'gl.csv');
    expect(b.sheets[0].rows.map((r) => r.cells)).toEqual(cellsOf);
  });
});
