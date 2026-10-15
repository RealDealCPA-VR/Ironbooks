/**
 * Enter Batch Transactions — clipboard (Excel / Google Sheets TSV) parsing and column mapping.
 */
import { describe, it, expect } from 'vitest';
import {
  applyColumnMapping,
  columnForHeader,
  guessColumnMapping,
  isBlankBatchRow,
  parseBatchPaste,
  parseClipboardGrid,
  pasteBlockAt,
} from './batchEnterParse';

describe('parseClipboardGrid', () => {
  it('reads Excel TSV with CRLF line ends and a trailing newline', () => {
    expect(parseClipboardGrid('3/5/2026\t1001\tOffice Depot\r\n3/6/2026\t1002\tAcme\r\n')).toEqual([
      ['3/5/2026', '1001', 'Office Depot'],
      ['3/6/2026', '1002', 'Acme'],
    ]);
  });

  it('keeps quoted cells that contain tabs, line breaks and quotes (Excel quoting)', () => {
    const text = '3/5/2026\t"Line one\nline two"\t"He said ""hi"""\t12.50\n';
    expect(parseClipboardGrid(text)).toEqual([['3/5/2026', 'Line one\nline two', 'He said "hi"', '12.50']]);
  });

  it('keeps empty cells in place and drops blank rows', () => {
    expect(parseClipboardGrid('a\t\tc\n\n\t\t\nd\te\t\n')).toEqual([
      ['a', '', 'c'],
      ['d', 'e', ''],
    ]);
  });

  it('falls back to CSV when there are no tabs (Google Sheets "copy as CSV", text files)', () => {
    expect(parseClipboardGrid('3/1/2026,101,"Smith, John",6300,"$1,200.00"')).toEqual([
      ['3/1/2026', '101', 'Smith, John', '6300', '$1,200.00'],
    ]);
  });
});

describe('column mapping', () => {
  it('recognises the header words people use', () => {
    expect(columnForHeader('Payee')).toBe('name');
    expect(columnForHeader('Check #')).toBe('ref');
    expect(columnForHeader('Num')).toBe('ref');
    expect(columnForHeader(' Transaction  Date ')).toBe('date');
    expect(columnForHeader('Category')).toBe('account');
    expect(columnForHeader('Description')).toBe('memo');
    expect(columnForHeader('Due Date')).toBe('dueDate');
    expect(columnForHeader('Dept')).toBe('className');
    expect(columnForHeader('Balance')).toBeNull();
  });

  it('maps a header row in any order and ignores unknown columns', () => {
    const grid = parseClipboardGrid('Amount\tPayee\tRunning Balance\tDate\tCategory\n12.50\tAcme\t900\t3/5/2026\t6300');
    const g = guessColumnMapping(grid, 'check');
    expect(g).toEqual({ hasHeader: true, mapping: ['amount', 'name', null, 'date', 'account'] });
    expect(applyColumnMapping(grid, g.mapping, { hasHeader: true, type: 'check' })).toEqual([
      { date: '3/5/2026', name: 'Acme', account: '6300', amount: '12.50' },
    ]);
  });

  it('without headers uses the grid order for the type', () => {
    const grid = parseClipboardGrid('3/5/2026\tOwner\t3000\t500');
    expect(guessColumnMapping(grid, 'deposit')).toEqual({ hasHeader: false, mapping: ['date', 'name', 'account', 'amount'] });
  });

  it('a first row that holds dates or amounts is data, even if a cell looks like a header word', () => {
    const grid = parseClipboardGrid('3/5/2026\tDeposit\t1000\t$50.00');
    expect(guessColumnMapping(grid, 'check').hasHeader).toBe(false);
  });

  it('a Debit or Credit header folds into Amount for single-amount types; duplicates are skipped', () => {
    const grid = parseClipboardGrid('Date\tVendor\tDebit\tAccount\tAccount\n3/5/2026\tAcme\t10\t6300\t6600');
    expect(guessColumnMapping(grid, 'bill').mapping).toEqual(['date', 'name', 'amount', 'account', null]);
  });

  it('journal entries: one signed Amount column becomes Debit / Credit', () => {
    const grid = parseClipboardGrid('Date\tRef\tAccount\tAmount\n3/31/2026\tJ1\t6300\t125.00\n3/31/2026\tJ1\t1000\t(125.00)');
    const g = guessColumnMapping(grid, 'journal');
    expect(g.mapping).toEqual(['date', 'ref', 'account', 'amount']);
    expect(applyColumnMapping(grid, g.mapping, { hasHeader: g.hasHeader, type: 'journal' })).toEqual([
      { date: '3/31/2026', ref: 'J1', account: '6300', debit: '125.00' },
      { date: '3/31/2026', ref: 'J1', account: '1000', credit: '125.00' },
    ]);
  });

  it('a user-changed mapping is applied; rows with nothing mapped are skipped', () => {
    const grid = [['x', '3/5/2026', '9'], ['only-skipped-col', '', '']];
    expect(applyColumnMapping(grid, [null, 'date', 'amount'], { hasHeader: false, type: 'check' })).toEqual([
      { date: '3/5/2026', account: '', amount: '9' },
    ]);
  });

  it('parseBatchPaste = parse + guess + apply', () => {
    expect(parseBatchPaste('Date\tPayee\tAccount\tAmount\n3/5/2026\tAcme\t6300\t9.99\n', 'cc_charge')).toEqual([
      { date: '3/5/2026', name: 'Acme', account: '6300', amount: '9.99' },
    ]);
  });
});

describe('pasteBlockAt (spreadsheet-style paste into a cell)', () => {
  it('fills right and down from the cell, adding rows and dropping cells past the last column', () => {
    const rows = [{ date: '3/1/2026', account: '' }, { date: '', account: '' }];
    // check columns: date, ref, name, account, amount, memo, className — start at "name" on row 2
    const out = pasteBlockAt(rows, { row: 1, col: 2 }, [['Acme', '6300', '5', 'Paper', 'Admin', 'EXTRA'], ['Beta', '6600', '7']], 'check');
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(rows[0]);
    expect(out[1]).toEqual({ date: '', account: '6300', name: 'Acme', amount: '5', memo: 'Paper', className: 'Admin' });
    expect(out[2]).toEqual({ date: '', account: '6600', name: 'Beta', amount: '7' });
    expect(rows[1]).toEqual({ date: '', account: '' }); // input untouched
  });

  it('isBlankBatchRow', () => {
    expect(isBlankBatchRow({ date: '', account: ' ' })).toBe(true);
    expect(isBlankBatchRow({ date: '', account: '', memo: 'x' })).toBe(false);
  });
});
