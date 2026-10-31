/**
 * Feature round (team purchbank): purchases and banking pages.
 *
 *  - "Today" worked out once, when the page's code first loaded: the desktop app stays open for
 *    days, so a form default computed at module load dates new entries with the day the app was
 *    started (FIFO's Receive / Consume forms did). Defaults are worked out when a form opens.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** Purchases and banking pages. */
const OWNED = [
  'app/fifo', 'app/print-checks', 'app/loans', 'app/purchase-orders', 'app/banking', 'app/bills', 'app/pay-bills',
  'app/expenses', 'app/deposits', 'app/transfers', 'app/reconcile', 'app/item-receipts', 'app/vendor-credits',
  'app/registers', 'app/receiving', 'app/bank-review', 'app/credit-cards',
];

function files(p: string): string[] {
  if (!fs.existsSync(p)) return [];
  if (fs.statSync(p).isFile()) return /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  return fs.readdirSync(p).flatMap((e) => files(path.join(p, e)));
}

/** Module-level `const X = todayISO()|new Date(…` or a module-level object literal using them. */
function moduleLevelToday(file: string): string[] {
  const hits: string[] = [];
  let inTop: number | null = null;
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((l, i) => {
      if (/^(export )?const [A-Za-z_$][\w$]*(: [^=]+)? = (\{|\[)\s*$/.test(l)) inTop = i;
      else if (inTop !== null && /^[}\]]/.test(l)) inTop = null;
      if (/^(export )?const [A-Za-z_$][\w$]*(: [^=]+)? = (todayISO\(\)|new Date\()/.test(l) || (inTop !== null && /todayISO\(\)|new Date\(\)/.test(l))) {
        hits.push(`${file.split(path.sep).join('/')}:${i + 1}: ${l.trim()}`);
      }
    });
  return hits;
}

describe('date defaults are worked out when a form opens', () => {
  it('no purchases / banking page keeps "today" from when its code was loaded', () => {
    expect(OWNED.flatMap(files).flatMap(moduleLevelToday)).toEqual([]);
  });
});

describe('Enter Bills: the due date follows the bill date and terms (D5)', () => {
  it('changing the bill date works the due date out again unless one was typed', () => {
    const src = fs.readFileSync('app/bills/page.tsx', 'utf8');
    const handler = src.slice(src.indexOf('function handleDateChange'), src.indexOf('function handleTermsChange'));
    expect(handler).toContain('if (dueTyped.current || !value) return;');
    expect(handler).toContain('fetchDueDateForTerms(value, ref)');
    expect(src).toContain('onChange={(e) => handleDateChange(e.target.value)}');
    expect(src).toContain('dueTyped.current = Boolean(e.target.value);');
  });
});

describe('Pay Bills: the payment method follows the pay-from account', () => {
  it('Edit Payment has a Method field and sends it (it always resent the saved method)', () => {
    const src = fs.readFileSync('app/pay-bills/page.tsx', 'utf8');
    expect(src).toContain('method: editMethod,');
    expect(src).not.toContain('method: editPay.method,');
    expect(src).toContain('id="ep-method"');
    // Picking an account sets the matching method, on the Pay Bills form and in Edit Payment.
    expect(src.match(/methodForAccount\(accounts\.find/g)?.length).toBe(2);
  });
});
