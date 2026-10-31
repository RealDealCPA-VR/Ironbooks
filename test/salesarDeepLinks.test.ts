/**
 * Team salesar — review-5 navigation leftovers:
 *  - Inventory Center, the transaction log, Home and other drill-downs link with ?focus=<id>, which
 *    only the invoices / customers / vendors / items pages honoured: every transaction page they
 *    link to now opens the record (useFocusId fetches it by id, so an older or voided one opens
 *    too; useFocusParam finds it on the loaded list).
 *  - The command bar's "Record a sale" (/sales-receipts?new=1) landed on the list: the page now
 *    honours ?new=1 (useNewParam), as do credit memos and sales orders.
 * The hooks read useSearchParams, so each page must render inside a <Suspense> boundary.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const src = (f: string) => fs.readFileSync(f, 'utf8');

const FOCUS: Array<[page: string, hook: 'useFocusId' | 'useFocusParam']> = [
  ['sales-receipts', 'useFocusId'],
  ['credit-memos', 'useFocusId'],
  ['sales-orders', 'useFocusId'],
  ['estimates', 'useFocusId'],
  ['bills', 'useFocusId'],
  ['payments', 'useFocusId'],
  ['deposits', 'useFocusId'],
  ['journal', 'useFocusId'],
  ['purchase-orders', 'useFocusParam'],
  ['item-receipts', 'useFocusParam'],
  ['vendor-credits', 'useFocusParam'],
];

describe('?focus=<id> opens the record on every transaction page drill-downs link to', () => {
  for (const [page, hook] of FOCUS) {
    it(page, () => {
      const s = src(`app/${page}/page.tsx`);
      expect(s).toMatch(new RegExp(`import \\{[^}]*\\b${hook}\\b[^}]*\\} from '@/lib/useFocusParam'`));
      expect(s).toMatch(new RegExp(`\\b${hook}\\(`));
      expect(s).toContain('<Suspense');
    });
  }

  it('useFocusId fires once, only for an id, when the page is ready', () => {
    const s = src('lib/useFocusParam.ts');
    const body = s.slice(s.indexOf('export function useFocusId'), s.indexOf('export function useNewParam'));
    expect(body).toContain("searchParams.get('focus')");
    expect(body).toContain('consumedRef.current = true');
    expect(body).toMatch(/if \(consumedRef\.current \|\| !focusId \|\| !ready\) return;/);
    expect(body).toMatch(/\[0-9a-f-\]\{36\}/);
  });
});

describe('?new=1 opens a new form', () => {
  it('"Record a sale" in the command bar targets /sales-receipts?new=1', () => {
    expect(src('lib/nav-actions.ts')).toContain("'/sales-receipts?new=1'");
  });

  for (const page of ['sales-receipts', 'credit-memos', 'sales-orders']) {
    it(page, () => {
      const s = src(`app/${page}/page.tsx`);
      expect(s).toMatch(/import \{[^}]*\buseNewParam\b[^}]*\} from '@\/lib\/useFocusParam'/);
      expect(s).toMatch(/useNewParam\(/);
    });
  }
});
