/**
 * Pure tests for the QuickBooks General Ledger readers + parser + transaction rebuilder
 * (lib/services/qbGlFiles.ts, lib/services/qbGlParse.ts). Fixtures are generated from one
 * balanced model (test/fixtures/qbGlFixtures.ts) as CSV, .xlsx and PDF, so the same books must
 * come back from every format.
 */
import { describe, it, expect } from 'vitest';
import Papa from 'papaparse';
import { Money } from '@/lib/money';
import {
  columnIndex,
  decodeText,
  excelSerialToDate,
  isDateFormatCode,
  loadGrid,
  readCsv,
  readXlsx,
  sniffKind,
} from './qbGlFiles';
import {
  analyzeGl,
  parseAccountLabel,
  parseAmount,
  parseGlGrid,
  parseGlSheets,
  parsePeriodLabel,
  parseQbDate,
  parseReferenceGrid,
  parseReferenceIif,
  toBookkeeperType,
  type GlAnalysis,
} from './qbGlParse';
import {
  SAMPLE_GL,
  accountListCsv,
  fxEnding,
  fxFullName,
  glCsv,
  glPdf,
  glXlsx,
  trialBalanceCsv,
} from '@/test/fixtures/qbGlFixtures';

const enc = (s: string) => new TextEncoder().encode(s);

async function analyzeBytes(bytes: Uint8Array, name: string, ref?: string): Promise<GlAnalysis> {
  const loaded = await loadGrid(bytes, name);
  const report = parseGlSheets(loaded.sheets);
  const reference = ref ? parseReferenceGrid(readCsv(ref)) : null;
  return analyzeGl(report, { reference });
}

/** The rebuilt transactions as comparable tuples (independent of the source format). */
function txnFingerprints(a: GlAnalysis) {
  return a.transactions.map((t) => t.ref).sort();
}

function endingByNumber(a: GlAnalysis) {
  return new Map(a.accounts.map((x) => [x.number, x.ending]));
}

describe('value parsing', () => {
  it('parses QB amounts', () => {
    expect(parseAmount('1,234.56')?.toFixed(2)).toBe('1234.56');
    expect(parseAmount('(1,234.56)')?.toFixed(2)).toBe('-1234.56');
    expect(parseAmount('-50')?.toFixed(2)).toBe('-50.00');
    expect(parseAmount('75.10-')?.toFixed(2)).toBe('-75.10');
    expect(parseAmount('$5.00')?.toFixed(2)).toBe('5.00');
    expect(parseAmount('1234.5599999999999')?.toFixed(2)).toBe('1234.56');
    expect(parseAmount('4.5474735088646412E-13')?.toFixed(2)).toBe('0.00');
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('Checking')).toBeNull();
    expect(parseAmount('01/02/2024')).toBeNull();
  });

  it('parses QB dates and report periods', () => {
    expect(parseQbDate('01/15/2024')).toBe('2024-01-15');
    expect(parseQbDate('1/5/24')).toBe('2024-01-05');
    expect(parseQbDate('2024-02-29')).toBe('2024-02-29');
    expect(parseQbDate('02/30/2024')).toBeNull();
    expect(parseQbDate('Total')).toBeNull();
    expect(parsePeriodLabel('January 1 through March 31, 2024')).toEqual({ start: '2024-01-01', end: '2024-03-31' });
    expect(parsePeriodLabel('January through December 2023')).toEqual({ start: '2023-01-01', end: '2023-12-31' });
    expect(parsePeriodLabel('July 1, 2023 through June 30, 2024')).toEqual({ start: '2023-07-01', end: '2024-06-30' });
    expect(parsePeriodLabel('07/01/2024 - 12/31/2024')).toEqual({ start: '2024-07-01', end: '2024-12-31' });
    expect(parsePeriodLabel('As of December 31, 2024')).toEqual({ end: '2024-12-31' });
    expect(parsePeriodLabel('General Ledger')).toBeNull();
  });

  it('parses account labels with numbers', () => {
    expect(parseAccountLabel('10100 · Checking')).toEqual({ number: '10100', name: 'Checking' });
    expect(parseAccountLabel('10100 � Checking')).toEqual({ number: '10100', name: 'Checking' });
    expect(parseAccountLabel('1000 - Petty Cash')).toEqual({ number: '1000', name: 'Petty Cash' });
    expect(parseAccountLabel('Checking')).toEqual({ name: 'Checking' });
  });

  it('maps QB types to BookKeeper types', () => {
    expect(toBookkeeperType('Bank', 'Savings')).toEqual({ type: 'asset', subtype: 'savings' });
    expect(toBookkeeperType('Accounts Payable')).toEqual({ type: 'liability', subtype: 'accounts_payable' });
    expect(toBookkeeperType('Equity', 'Retained Earnings')).toEqual({ type: 'equity', subtype: 'retained_earnings' });
    expect(toBookkeeperType('Other Income')).toEqual({ type: 'revenue', subtype: 'other_income' });
    expect(toBookkeeperType('Cost of Goods Sold')).toEqual({ type: 'expense', subtype: 'cost_of_goods_sold' });
  });
});

describe('file readers', () => {
  it('xlsx helpers', () => {
    expect(columnIndex('A')).toBe(0);
    expect(columnIndex('Z')).toBe(25);
    expect(columnIndex('AA')).toBe(26);
    expect(columnIndex('BC')).toBe(54);
    expect(excelSerialToDate(45306)).toBe('01/15/2024');
    expect(excelSerialToDate(45306, true)).toBe('01/16/2028');
    expect(isDateFormatCode('mm/dd/yyyy')).toBe(true);
    expect(isDateFormatCode('#,##0.00;\\(#,##0.00\\)')).toBe(false);
    expect(isDateFormatCode('"Day" 0')).toBe(false);
  });

  it('decodes Windows-1252 CSV (QB writes the "·" separator as byte 0xB7)', () => {
    const bytes = new Uint8Array([0x31, 0x30, 0x20, 0xb7, 0x20, 0x43, 0x61, 0x73, 0x68]);
    expect(decodeText(bytes)).toBe('10 · Cash');
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toBe('A');
    const utf16 = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]);
    expect(decodeText(utf16)).toBe('AB');
  });

  it('sniffs formats and rejects legacy .xls', () => {
    expect(sniffKind(enc('%PDF-1.7'))).toBe('pdf');
    expect(sniffKind(enc('!ACCNT\tNAME'))).toBe('iif');
    expect(sniffKind(enc('a,b'))).toBe('csv');
    expect(() => sniffKind(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toThrow(/\.xlsx/);
  });

  it('reads an xlsx: shared/rich/inline strings, numbers, date serials, sparse cells, sheet choice', () => {
    const sheets = readXlsx(glXlsx(SAMPLE_GL));
    expect(sheets.map((s) => s.name)).toEqual(['QuickBooks Export Tips', 'Sheet1']);
    const rows = sheets[1].rows;
    expect(rows[0].cells[0]).toBe('Rock Castle Test Co'); // rich-text runs joined
    const header = rows[4].cells;
    expect(header.slice(0, 3)).toEqual(['', '', '']); // indentation columns
    expect(header[3]).toBe('Type');
    const firstLine = rows.find((r) => r.cells.includes('Invoice'))!;
    expect(firstLine.cells).toContain('01/05/2024'); // serial 45296 with a date style
    expect(firstLine.cells).toContain('2700'); // numeric cell kept as decimal text
    const memoRow = rows.find((r) => r.cells.includes('Consulting - January'));
    expect(memoRow).toBeTruthy(); // inline string
  });

  it('reads a QB-style PDF: rows rebuilt from x/y, headers/footers stripped, columns placed', async () => {
    const loaded = await loadGrid(await glPdf(SAMPLE_GL), 'gl.pdf');
    const rows = loaded.sheets[0].rows;
    const texts = rows.map((r) => r.cells.join('|'));
    expect(texts.filter((t) => t.includes('Page '))).toHaveLength(0);
    expect(rows.filter((r) => r.cells.includes('Type') && r.cells.includes('Debit'))).toHaveLength(1);
    const header = rows.find((r) => r.cells.includes('Type'))!.cells;
    const bal = header.indexOf('Balance');
    const ap = rows.find((r) => r.cells[0] === '20000 · Accounts Payable')!;
    expect(ap.cells[bal]).toBe('1,800.00'); // credit-normal: natural sign
    const accum = rows.find((r) => r.cells[0] === '17000 · Accumulated Depreciation')!;
    expect(accum.cells[bal]).toBe('(2,400.00)');
    // The long memo wrapped onto its own line is re-attached by the parser.
    expect(rows.some((r) => r.cells.every((c, i) => (i === header.indexOf('Memo') ? !!c : !c)))).toBe(true);
  });
});

describe('parseGlGrid + analyzeGl', () => {
  it('reads accounts, hierarchy, beginning balances and lines from CSV', () => {
    const report = parseGlGrid(readCsv(glCsv(SAMPLE_GL)));
    expect(report.errors).toEqual([]);
    expect(report.period).toMatchObject({ start: '2024-01-01', end: '2024-03-31' });
    expect(report.accounts).toHaveLength(SAMPLE_GL.accounts.length);
    const fuel = report.accounts.find((a) => a.number === '60100')!;
    expect(fuel.fullName).toBe('Automobile:Fuel');
    expect(fuel.depth).toBe(1);
    expect(report.accounts.find((a) => a.number === '10100')!.headerBalance).toBe('25000.00');
    const totalLines = report.accounts.reduce((n, a) => n + a.lines.length, 0);
    expect(totalLines).toBe(SAMPLE_GL.txns.reduce((n, t) => n + t.lines.length, 0));
    expect(report.grandTotal?.debit).toBe(report.grandTotal?.credit);
  });

  it('rebuilds every transaction as a balanced entry and reconciles each account', async () => {
    const a = await analyzeBytes(enc(glCsv(SAMPLE_GL)), 'gl.csv');
    expect(a.errors).toEqual([]);
    expect(a.review).toEqual([]);
    expect(a.transactions).toHaveLength(SAMPLE_GL.txns.length);
    for (const t of a.transactions) {
      const dr = t.lines.reduce((s, l) => s.plus(l.debit), Money.zero());
      const cr = t.lines.reduce((s, l) => s.plus(l.credit), Money.zero());
      expect(dr.equals(cr)).toBe(true);
    }
    // The two same-day, no-number checks stay separate.
    const sameDay = a.transactions.filter((t) => t.date === '2024-02-20');
    expect(sameDay.map((t) => t.name).sort()).toEqual(["Joe's Garage", 'Office Depot']);
    // Every account's ending balance equals the model's.
    const expected = fxEnding(SAMPLE_GL);
    for (const acct of a.accounts) {
      expect([acct.number, acct.ending]).toEqual([acct.number, expected.get(acct.number!)!.toFixed(2)]);
    }
    expect(a.totals.beginningSum).toBe('0.00');
    expect(a.totals.endingSum).toBe('0.00');
    expect(a.meta.convention).toBe('natural');
    // Names by transaction type, classes from the Class column.
    const role = (n: string) => a.names.find((x) => x.name === n)?.role;
    expect(role('Acme Corp')).toBe('customer');
    expect(role('Acme Corp:Kitchen Remodel')).toBe('customer');
    expect(role('Shell Oil')).toBe('vendor');
    expect(role('Smith, John')).toBe('employee');
    expect(a.classes).toEqual(['Admin', 'Admin:Payroll', 'East', 'West']);
  });

  it('infers QB account types from the GL alone (sections, numbers, names, balances)', async () => {
    const a = await analyzeBytes(enc(glCsv(SAMPLE_GL)), 'gl.csv');
    const wrong = a.accounts
      .map((x) => ({ n: x.fullName, got: x.qbType, want: SAMPLE_GL.accounts.find((f) => f.number === x.number)!.type }))
      .filter((x) => x.got !== x.want);
    expect(wrong).toEqual([]);
  });

  it('uses an Account List export for exact types and a Trial Balance for proof figures', async () => {
    const withList = await analyzeBytes(enc(glCsv(SAMPLE_GL)), 'gl.csv', accountListCsv(SAMPLE_GL));
    expect(withList.accounts.every((x) => x.typeSource === 'reference' || x.typeSource === 'parent')).toBe(true);
    expect(withList.reference).toMatchObject({ kind: 'account-list', unmatched: [] });

    const tb = parseReferenceGrid(readCsv(trialBalanceCsv(SAMPLE_GL)));
    expect(tb.kind).toBe('trial-balance');
    expect(tb.asOf).toBe('2024-03-31');
    const withTb = analyzeGl(parseGlGrid(readCsv(glCsv(SAMPLE_GL))), { reference: tb });
    for (const acct of withTb.accounts) expect(acct.tbBalance).toBe(acct.ending);
  });

  it('reads IIF chart-of-accounts types as a reference', () => {
    const ref = parseReferenceIif('!ACCNT\tNAME\tACCNTTYPE\tACCNUM\nACCNT\tAutomobile:Fuel\tEXP\t60100\nACCNT\tChecking\tBANK\t10100\n');
    expect(ref.accounts.map((r) => [r.segments.map((s) => s.name).join(':'), r.qbType, r.segments.at(-1)!.number])).toEqual([
      ['Automobile:Fuel', 'Expense', '60100'],
      ['Checking', 'Bank', '10100'],
    ]);
  });

  it('CSV, xlsx and PDF exports of the same books produce identical transactions and balances', async () => {
    const csv = await analyzeBytes(enc(glCsv(SAMPLE_GL)), 'gl.csv');
    const xlsx = await analyzeBytes(new Uint8Array(glXlsx(SAMPLE_GL)), 'gl.xlsx');
    const pdf = await analyzeBytes(await glPdf(SAMPLE_GL), 'gl.pdf');
    for (const x of [xlsx, pdf]) {
      expect(x.errors).toEqual([]);
      expect(x.review).toEqual([]);
      expect(txnFingerprints(x)).toEqual(txnFingerprints(csv));
      expect(endingByNumber(x)).toEqual(endingByNumber(csv));
    }
    // The wrapped PDF memo was re-joined.
    const inv = pdf.transactions.find((t) => t.num === '1002' && t.type === 'Invoice')!;
    expect(inv.lines.some((l) => l.memo === 'Quarterly service agreement for kitchen remodel project phase two')).toBe(true);
  });

  it('reads a Windows-1252 CSV export (QB Desktop default encoding)', async () => {
    const text = glCsv(SAMPLE_GL);
    const bytes = new Uint8Array([...text].map((ch) => (ch === '·' ? 0xb7 : ch.charCodeAt(0))));
    const a = await analyzeBytes(bytes, 'gl.csv');
    const base = await analyzeBytes(enc(text), 'gl.csv');
    expect(a.errors).toEqual([]);
    expect(a.accounts.find((x) => x.number === '10100')?.name).toBe('Checking');
    expect(txnFingerprints(a)).toEqual(txnFingerprints(base));
  });

  it('treats an account named "Total …" as an account, not a Total row', () => {
    const csv = Papa.unparse([
      ['General Ledger'],
      ['January 1 through January 31, 2024'],
      ['', 'Type', 'Date', 'Num', 'Name', 'Memo', 'Split', 'Debit', 'Credit', 'Balance'],
      ['Checking', '', '', '', '', '', '', '', '', '0.00'],
      ['', 'Check', '01/03/2024', '7', 'Wine Co', '', 'Total Wine Expense', '', '40.00', '-40.00'],
      ['Total Checking', '', '', '', '', '', '', '0.00', '40.00', '-40.00'],
      ['Total Wine Expense', '', '', '', '', '', '', '', '', '0.00'],
      ['', 'Check', '01/03/2024', '7', 'Wine Co', '', 'Checking', '40.00', '', '40.00'],
      ['Total Total Wine Expense', '', '', '', '', '', '', '40.00', '0.00', '40.00'],
      ['TOTAL', '', '', '', '', '', '', '40.00', '40.00', '0.00'],
    ]);
    const a = analyzeGl(parseGlGrid(readCsv(csv)));
    expect(a.errors).toEqual([]);
    expect(a.accounts.map((x) => x.name)).toEqual(['Checking', 'Total Wine Expense']);
    expect(a.transactions).toHaveLength(1);
  });

  it('handles the single Amount column, Beginning Balance rows, Trans # and unnumbered accounts', async () => {
    const base = await analyzeBytes(enc(glCsv(SAMPLE_GL)), 'gl.csv');
    const amount = await analyzeBytes(enc(glCsv(SAMPLE_GL, { amountColumn: true })), 'gl.csv');
    expect(amount.errors).toEqual([]);
    expect(amount.meta.convention).toBe('natural');
    expect(txnFingerprints(amount)).toEqual(txnFingerprints(base));
    expect(endingByNumber(amount)).toEqual(endingByNumber(base));

    const begRows = await analyzeBytes(enc(glCsv(SAMPLE_GL, { beginningRows: true, transIds: true })), 'gl.csv');
    expect(begRows.errors).toEqual([]);
    expect(txnFingerprints(begRows)).toEqual(txnFingerprints(base));

    const noNums = await analyzeBytes(enc(glCsv(SAMPLE_GL, { numbers: false })), 'gl.csv');
    expect(noNums.errors).toEqual([]);
    expect(noNums.review).toEqual([]);
    expect(noNums.accounts.find((x) => x.fullName === 'Automobile:Repairs and Maintenance')).toBeTruthy();
    expect(noNums.transactions).toHaveLength(SAMPLE_GL.txns.length);
  });

  it('reads a debit-positive report (all balances printed debit-positive)', () => {
    // Re-sign the Balance column so every account prints debit-positive balances.
    const grid = readCsv(glCsv(SAMPLE_GL));
    const header = grid.findIndex((r) => r.cells.includes('Balance'));
    const bal = grid[header].cells.indexOf('Balance');
    const creditNormal = new Set(SAMPLE_GL.accounts.filter((x) => ['Accounts Payable', 'Credit Card', 'Other Current Liability', 'Equity', 'Income', 'Other Income'].includes(x.type)).map((x) => x.number));
    let current = '';
    for (const r of grid.slice(header + 1)) {
      const label = r.cells.slice(0, 3).find((c) => c.trim()) ?? '';
      if (label && !label.startsWith('Total')) current = label.split(' ')[0];
      const num = label.startsWith('Total') ? label.split(' ')[1] : current;
      const own = SAMPLE_GL.accounts.find((x) => x.number === num);
      const parentNum = own?.parent ?? num;
      if ((creditNormal.has(num) || creditNormal.has(parentNum)) && r.cells[bal]) {
        r.cells[bal] = Money.of(parseAmount(r.cells[bal])).negated().toFixed(2);
      }
    }
    const a = analyzeGl(parseGlGrid(grid));
    expect(a.meta.convention).toBe('debit-positive');
    expect(a.errors).toEqual([]);
    const expected = fxEnding(SAMPLE_GL);
    for (const acct of a.accounts) expect(acct.ending).toBe(expected.get(acct.number!)!.toFixed(2));
  });

  it('sends an unbalanced transaction to review instead of posting it', async () => {
    // Leave the Interest Income side of the 03/10 interest deposit out of the report.
    const idx = SAMPLE_GL.txns.findIndex((t) => t.memo === 'Interest');
    const a = await analyzeBytes(enc(glCsv(SAMPLE_GL, { dropLine: { txn: idx, line: 1 } })), 'gl.csv');
    expect(a.errors).toEqual([]);
    expect(a.review).toHaveLength(1);
    expect(a.review[0]).toMatchObject({ type: 'Deposit', date: '2024-03-10', difference: '12.34' });
    expect(a.transactions).toHaveLength(SAMPLE_GL.txns.length - 1);
    expect(a.warnings.join(' ')).toMatch(/review/);
  });

  it('flags a report whose rows do not add up to an account Total', () => {
    const grid = readCsv(glCsv(SAMPLE_GL));
    // Delete one Checking transaction row (but keep the Total row as printed).
    const i = grid.findIndex((r) => r.cells.includes('Landlord LLC') && r.cells.includes('-SPLIT-') === false && r.cells.some((c) => c === '1,500.00'));
    grid.splice(i, 1);
    const a = analyzeGl(parseGlGrid(grid));
    expect(a.errors.length).toBeGreaterThan(0);
  });

  it('fails clearly when beginning balances do not net to zero', () => {
    const grid = readCsv(glCsv(SAMPLE_GL));
    const row = grid.find((r) => r.cells[0] === '10200 · Savings')!;
    const bal = grid.find((r) => r.cells.includes('Balance'))!.cells.indexOf('Balance');
    row.cells[bal] = '10,500.00';
    const a = analyzeGl(parseGlGrid(grid));
    expect(a.errors.join(' ')).toMatch(/beginning/i);
  });

  it('rejects a file that is not a General Ledger', () => {
    expect(() => parseGlGrid(readCsv('a,b\n1,2'))).toThrow(/General Ledger/);
  });

  it('accepts flat "Parent:Child" account labels', () => {
    const csv = Papa.unparse([
      ['Co'],
      ['General Ledger'],
      ['January 1 through January 31, 2024'],
      ['', 'Type', 'Date', 'Num', 'Name', 'Memo', 'Split', 'Debit', 'Credit', 'Balance'],
      ['Checking', '', '', '', '', '', '', '', '', '100.00'],
      ['', 'Check', '01/03/2024', '7', 'Gas Co', '', 'Automobile:Fuel', '', '40.00', '60.00'],
      ['Total Checking', '', '', '', '', '', '', '0.00', '40.00', '60.00'],
      ['Automobile:Fuel', '', '', '', '', '', '', '', '', '0.00'],
      ['', 'Check', '01/03/2024', '7', 'Gas Co', '', 'Checking', '40.00', '', '40.00'],
      ['Total Automobile:Fuel', '', '', '', '', '', '', '40.00', '0.00', '40.00'],
      ['Opening Balance Equity', '', '', '', '', '', '', '', '', '100.00'],
      ['Total Opening Balance Equity', '', '', '', '', '', '', '0.00', '0.00', '100.00'],
      ['TOTAL', '', '', '', '', '', '', '40.00', '40.00', '0.00'],
    ]);
    const a = analyzeGl(parseGlGrid(readCsv(csv)));
    expect(a.errors).toEqual([]);
    expect(a.accounts.map((x) => x.fullName)).toEqual(['Checking', 'Automobile', 'Automobile:Fuel', 'Opening Balance Equity']);
    expect(a.transactions).toHaveLength(1);
    expect(a.accounts.find((x) => x.fullName === 'Opening Balance Equity')!.ending).toBe('-100.00');
    expect(fxFullName(SAMPLE_GL, '60100')).toBe('Automobile:Fuel');
  });
});
