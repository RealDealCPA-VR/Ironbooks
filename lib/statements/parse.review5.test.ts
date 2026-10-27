/**
 * Review round 5 (team banking) — statement parser regressions.
 */
import { describe, it, expect } from 'vitest';
import { parseStatementText, tieOut } from './parse';

const lines = (text: string) => text.split('\n').map((t) => ({ text: t }));

describe('credit card statements: CR / DR markers', () => {
  // On a card statement "CR" marks a payment or credit (the balance owed goes DOWN: money into the
  // card account, a positive row) and "DR" a charge (money out, negative).
  const text = `ACME BANK VISA
Statement period 03/01/2026 through 03/31/2026
Previous Balance 500.00
03/05 SHELL OIL 57444 45.00 DR
03/10 PAYMENT THANK YOU 200.00 CR
03/12 RETURN HOME DEPOT 20.00 CR
New Balance 325.00`;

  it('a CR amount is a payment / credit (positive) and a DR amount a charge (negative)', () => {
    const p = parseStatementText(lines(text), { kind: 'card', fallbackYear: 2026 });
    expect(p.rows.map((r) => [r.description, r.amount])).toEqual([
      ['SHELL OIL 57444', '-45.00'],
      ['PAYMENT THANK YOU', '200.00'],
      ['RETURN HOME DEPOT', '20.00'],
    ]);
    expect(tieOut(p.rows, p.openingBalance, p.closingBalance, 'card').ok).toBe(true);
  });
});

describe('Checks Paid tables that mark imaged checks with "^"', () => {
  // Chase-style: "^" after the check number means an image of the check is available.
  const text = `Statement period 03/01/2026 through 03/31/2026
Beginning Balance $1,000.00
CHECKS PAID
CHECK NO. DATE PAID AMOUNT
1003 ^ 03/07 150.00 1004 ^ 03/09 $1,200.00
Total Checks Paid $1,350.00
Ending Balance -$350.00`;

  it('reads each check (they were dropped, so the statement could not tie out)', () => {
    const p = parseStatementText(lines(text), { kind: 'bank' });
    expect(p.rows.map((r) => [r.date, r.description, r.amount])).toEqual([
      ['2026-03-07', 'Check #1003', '-150.00'],
      ['2026-03-09', 'Check #1004', '-1200.00'],
    ]);
    expect(tieOut(p.rows, p.openingBalance, p.closingBalance, 'bank').ok).toBe(true);
  });
});
