/**
 * Statement text → rows + balances + tie-out (lib/statements/parse.ts), on synthetic statements
 * in the common layouts: running balance, sectioned with a Checks Paid table and a Dec–Jan
 * period, credit card (two dates, payments as negatives), and debit / credit columns.
 */
import { describe, it, expect } from 'vitest';
import { parseMoney, parseStatementText, tieOut, type StatementLine } from './parse';

const lines = (text: string): StatementLine[] => text.split('\n').map((t) => ({ text: t }));

describe('parseMoney', () => {
  it.each([
    ['1,234.56', 123456, false],
    ['$1,234.56', 123456, false],
    ['(12.00)', -1200, true],
    ['-12.00', -1200, true],
    ['12.00-', -1200, true],
    ['12.00 CR', 1200, true],
    ['12.00 DR', -1200, true],
    ['0.42', 42, false],
  ])('%s', (tok, cents, marker) => {
    expect(parseMoney(tok)).toEqual({ cents, marker });
  });
  it.each(['12', '1,23.00', 'abc', '12.3', '1.234'])('not money: %s', (tok) => {
    expect(parseMoney(tok)).toBeNull();
  });
});

describe('running-balance bank statement', () => {
  const text = `First Community Bank
Statement Period: 01/01/2026 through 01/31/2026
Account Number: ****1234
Beginning Balance $2,500.00
Date Description Amount Balance
01/03 DEPOSIT MOBILE 1,200.00 3,700.00
01/05 CHECK 1043 150.00 3,550.00
01/09 SHELL OIL 57442191 45.10 3,504.90
   HOUSTON TX
01/15 ONLINE TRANSFER TO SAVINGS 500.00 3,004.90
01/28 INTEREST PAID 0.42 3,005.32
Ending Balance $3,005.32`;
  const p = parseStatementText(lines(text), { kind: 'bank' });

  it('reads every row with its sign from the running balance', () => {
    expect(p.rows.map((r) => [r.date, r.amount, r.signFrom])).toEqual([
      ['2026-01-03', '1200.00', 'balance'],
      ['2026-01-05', '-150.00', 'balance'],
      ['2026-01-09', '-45.10', 'balance'],
      ['2026-01-15', '-500.00', 'balance'],
      ['2026-01-28', '0.42', 'balance'],
    ]);
    expect(p.rows[1].checkNumber).toBe('1043');
    expect(p.rows[2].description).toBe('SHELL OIL 57442191 HOUSTON TX'); // wrapped line joined
  });

  it('finds the period and balances, and ties out', () => {
    expect(p.period).toEqual({ start: '2026-01-01', end: '2026-01-31' });
    expect([p.openingBalance, p.closingBalance]).toEqual(['2500.00', '3005.32']);
    expect(tieOut(p.rows, p.openingBalance, p.closingBalance, 'bank')).toEqual({ expected: '505.32', extracted: '505.32', difference: '0.00', ok: true });
  });

  it('a missed row shows up as a difference, never as a tie', () => {
    const t = tieOut(p.rows.filter((r) => r.date !== '2026-01-09'), p.openingBalance, p.closingBalance, 'bank');
    expect(t).toMatchObject({ ok: false, difference: '-45.10' });
  });
});

describe('sectioned bank statement across December and January', () => {
  const text = `CHECKING SUMMARY
December 15, 2025 through January 14, 2026
Beginning Balance $1,000.00
Deposits and Additions 2,050.00
Checks Paid -300.00
Electronic Withdrawals -250.00
Ending Balance $2,500.00
DEPOSITS AND ADDITIONS
DATE DESCRIPTION AMOUNT
12/20 Payroll Direct Dep Acme Corp 2,000.00
01/02 Interest Payment 50.00
Total Deposits and Additions $2,050.00
CHECKS PAID
CHECK NO. DATE PAID AMOUNT
1001 12/22 100.00 1002 * 12/30 200.00
Total Checks Paid $300.00
ELECTRONIC WITHDRAWALS
12/28 Card Purchase 12/27 Amazon Mktp 4111 150.00
01/05 Online Payment To Visa 100.00
Total Electronic Withdrawals $250.00
DAILY ENDING BALANCE
12/20 3,000.00 12/22 2,900.00`;
  const p = parseStatementText(lines(text), { kind: 'bank' });

  it('signs rows by section, reads the Checks Paid table, and puts each date in the right year', () => {
    expect(p.rows.map((r) => [r.date, r.description, r.amount])).toEqual([
      ['2025-12-20', 'Payroll Direct Dep Acme Corp', '2000.00'],
      ['2026-01-02', 'Interest Payment', '50.00'],
      ['2025-12-22', 'Check #1001', '-100.00'],
      ['2025-12-30', 'Check #1002', '-200.00'],
      ['2025-12-28', 'Card Purchase 12/27 Amazon Mktp 4111', '-150.00'],
      ['2026-01-05', 'Online Payment To Visa', '-100.00'],
    ]);
    expect(p.rows.filter((r) => r.checkNumber).map((r) => r.checkNumber)).toEqual(['1001', '1002']);
  });

  it('skips summary and daily-balance lines, and ties out', () => {
    expect(p.closingBalance).toBe('2500.00');
    expect(tieOut(p.rows, p.openingBalance, p.closingBalance, 'bank').ok).toBe(true);
  });
});

describe('credit card statement', () => {
  const text = `Visa Signature Statement
Opening/Closing Date 01/08/26 - 02/07/26
Previous Balance $1,250.00
Payments and Credits
01/15 01/15 PAYMENT THANK YOU -1,250.00
Purchases
01/10 01/11 STARBUCKS #1234 5.75
01/20 01/21 HOME DEPOT 4521 230.10
Fees Charged
02/01 02/01 LATE FEE 25.00
New Balance $260.85`;
  const p = parseStatementText(lines(text), { kind: 'card' });

  it('payments are money in, purchases and fees money out; the posting date is skipped', () => {
    expect(p.rows.map((r) => [r.date, r.description, r.amount])).toEqual([
      ['2026-01-15', 'PAYMENT THANK YOU', '1250.00'],
      ['2026-01-10', 'STARBUCKS #1234', '-5.75'],
      ['2026-01-20', 'HOME DEPOT 4521', '-230.10'],
      ['2026-02-01', 'LATE FEE', '-25.00'],
    ]);
  });

  it('ties out the way a card balance works (what you owe)', () => {
    expect([p.openingBalance, p.closingBalance]).toEqual(['1250.00', '260.85']);
    expect(tieOut(p.rows, p.openingBalance, p.closingBalance, 'card')).toMatchObject({ ok: true, expected: '989.15' });
  });
});

describe('debit / credit columns (PDF positions)', () => {
  const row = (x: Array<[number, string]>): StatementLine => ({ text: x.map(([, s]) => s).join('  '), cells: x.map(([px, str]) => ({ x: px, str })) });
  const statement: StatementLine[] = [
    { text: 'Statement period 03/01/2026 to 03/31/2026' },
    { text: 'Beginning balance 400.00' },
    row([[0, 'Date'], [60, 'Description'], [300, 'Withdrawals'], [400, 'Deposits']]),
    row([[0, '03/04'], [60, 'ATM WITHDRAWAL'], [302, '60.00']]),
    row([[0, '03/06'], [60, 'MOBILE CHECK DEPOSIT'], [401, '800.00']]),
    { text: 'Ending balance 1,140.00' },
  ];
  it('reads the sign from the column the amount sits in', () => {
    const p = parseStatementText(statement, { kind: 'bank' });
    expect(p.rows.map((r) => [r.amount, r.signFrom])).toEqual([
      ['-60.00', 'column'],
      ['800.00', 'column'],
    ]);
    expect(tieOut(p.rows, p.openingBalance, p.closingBalance, 'bank').ok).toBe(true);
  });
});

describe('when there is nothing to go on', () => {
  it('guesses from the words, says so, and cannot tie without balances', () => {
    const p = parseStatementText(lines('03/02 ACME PAYROLL DIRECT DEPOSIT 900.00\n03/03 CORNER STORE 12.00'), { kind: 'bank', fallbackYear: 2026 });
    expect(p.rows.map((r) => [r.amount, r.signFrom])).toEqual([
      ['900.00', 'guess'],
      ['-12.00', 'guess'],
    ]);
    expect(p.warnings.join(' ')).toMatch(/check the highlighted signs/);
    expect(p.warnings.join(' ')).toMatch(/No beginning balance/);
    expect(tieOut(p.rows, p.openingBalance, p.closingBalance, 'bank')).toMatchObject({ ok: false, expected: null });
  });
});
