/**
 * Shareable ledger export: an .xlsx workbook with the eight expected sheets (TB ties to the
 * trial balance service, GL carries running balances, journal includes voided entries) and a
 * multi-page PDF summary — both readable without the app.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import AdmZip from 'adm-zip';
import { PDFDocument } from 'pdf-lib';
import { getDb, closeDb } from '@/lib/db';
import { buildXlsxWorkbook } from '@/lib/export/xlsx';
import { buildShareableLedgerPdf, buildShareableLedgerXlsx } from './shareableLedger';
import { trialBalance } from './reports';
import { seedRichCompany, type RichCompany } from './companyFile.fixture';

const DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-shareable-ledger');
let rich: RichCompany;

function sheetXml(zip: AdmZip, index: number): string {
  return zip.readAsText(`xl/worksheets/sheet${index}.xml`);
}

describe('shareable ledger', () => {
  beforeAll(async () => {
    fs.rmSync(DIR, { recursive: true, force: true });
    const db = await getDb(DIR);
    rich = await seedRichCompany(db, DIR, 'Share & Co');
  }, 180_000);

  afterAll(async () => {
    await closeDb(DIR);
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  it('builds a workbook with every sheet, tied to the trial balance', async () => {
    const { buffer, filename, contentType } = await buildShareableLedgerXlsx(rich.ctx);
    expect(filename).toMatch(/^share-co-ledger-\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(contentType).toContain('spreadsheetml');
    const zip = new AdmZip(buffer);
    const workbook = zip.readAsText('xl/workbook.xml');
    const names = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual([
      'Company Info', 'Chart of Accounts', 'Trial Balance', 'General Ledger', 'Journal',
      'Customers', 'Vendors', 'Items',
    ]);
    expect(zip.readAsText('[Content_Types].xml')).toContain('/xl/worksheets/sheet8.xml');

    const tb = await trialBalance(rich.ctx);
    const tbXml = sheetXml(zip, 3);
    expect(tbXml).toContain('TOTAL');
    expect(tbXml).toContain(`<v>${Number(tb.totalDebit)}</v>`);
    expect(sheetXml(zip, 1)).toContain('Share &amp; Co');
    expect(sheetXml(zip, 4)).toContain('Closing balance');
    expect(sheetXml(zip, 5)).toContain('>void<'); // the voided entry is listed and flagged
    expect(sheetXml(zip, 6)).toContain('Acme &quot;Quoted&quot; Corp');
    expect(sheetXml(zip, 6)).toContain('1 Main St, Springfield, IL, 62701');
    expect(sheetXml(zip, 7)).toContain('Paper Supply Co');
    expect(sheetXml(zip, 8)).toContain('Consulting');
  });

  it('builds a multi-page PDF summary', async () => {
    const { buffer, filename } = await buildShareableLedgerPdf(rich.ctx);
    expect(filename).toMatch(/\.pdf$/);
    const doc = await PDFDocument.load(buffer);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(3);
    expect(doc.getTitle()).toContain('Share & Co');
  });

  it('de-duplicates sheet names', () => {
    const buf = buildXlsxWorkbook([
      { sheetName: 'Data', columns: [{ header: 'A' }], rows: [['1']] },
      { sheetName: 'data', columns: [{ header: 'A' }], rows: [['2']] },
    ]);
    const names = [...new AdmZip(buf).readAsText('xl/workbook.xml').matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(['Data', 'data (2)']);
  });
});
