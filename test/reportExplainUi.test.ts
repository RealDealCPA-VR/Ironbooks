/**
 * Report explanations UI (reportexplain): rendered with react-dom/server (no DOM needed).
 *
 *  - An explained amount keeps the amount in its accessible name (label + amount + action),
 *    instead of an aria-label that would replace the number.
 *  - The drill-down footer tells "only the first N are listed" apart from "too many to add up".
 *  - A failed "Say it in plain words" request is shown, not swallowed.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AmountExplain from '@/app/reports/_components/AmountExplain';
import { DrilldownListNotes } from '@/app/reports/_components/DrilldownView';
import { ReportSummaryContent } from '@/app/reports/_components/ReportSummaryBar';
import type { DrillTransaction, ReportSummaryResult } from '@/lib/reports/drilldown';

/** Text a screen reader takes as the element's name: its text content (no aria-label present). */
const textOf = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

describe('AmountExplain accessible name', () => {
  it('a drill-down link reads the label, the amount and the action', () => {
    const html = renderToStaticMarkup(createElement(AmountExplain, { href: '/reports/drilldown?x=1', label: 'Rent, Total', children: '$1,700.00' }));
    expect(html).toMatch(/^<a /);
    expect(html).not.toContain('aria-label');
    expect(textOf(html)).toBe('Rent, Total: $1,700.00. See the transactions behind this amount');
    expect(html).toContain('<span class="sr-only">Rent, Total: </span>$1,700.00<span class="sr-only">. See the transactions behind this amount</span>');
  });

  it('a single-transaction button reads the label, the amount and the action', () => {
    const html = renderToStaticMarkup(createElement(AmountExplain, { onActivate: () => {}, label: 'Invoice', children: '$250.00' }));
    expect(html).toMatch(/^<button /);
    expect(html).not.toContain('aria-label');
    expect(textOf(html)).toBe('Invoice: $250.00. Open this transaction');
  });

  it('without a label the amount still leads the name', () => {
    const html = renderToStaticMarkup(createElement(AmountExplain, { href: '/x', children: '-$12.50' }));
    expect(textOf(html)).toBe('-$12.50. See the transactions behind this amount');
  });
});

describe('drill-down footer', () => {
  const txns = [{ key: 'a' }, { key: 'b' }] as DrillTransaction[];

  it('a list cut by the limit says the total covers all', () => {
    const html = renderToStaticMarkup(createElement(DrilldownListNotes, { data: { listTruncated: true, incomplete: false, transactions: txns } }));
    expect(textOf(html)).toBe('Only the first 2 transactions are listed; the total and count cover all of them. Narrow the report dates to see fewer.');
  });

  it('a capped ledger read says the total does not cover everything', () => {
    const html = renderToStaticMarkup(createElement(DrilldownListNotes, { data: { listTruncated: true, incomplete: true, transactions: txns } }));
    expect(textOf(html)).toMatch(/^Too many transactions to add up: the total and count above cover only part of them\. Narrow the report dates/);
    expect(textOf(html)).not.toMatch(/cover all of them/);
  });

  it('nothing to say when the list is whole', () => {
    expect(renderToStaticMarkup(createElement(DrilldownListNotes, { data: { listTruncated: false, incomplete: false, transactions: txns } }))).toBe('');
  });
});

describe('summary bar AI failure', () => {
  const data: ReportSummaryResult = {
    facts: {} as ReportSummaryResult['facts'],
    text: 'Net income is $1,100.00 for February 2026, up 10.0% (+$100.00) from the previous period ($1,000.00).',
    aiAvailable: true,
  };
  const render = (aiError: string | null) =>
    renderToStaticMarkup(
      createElement(ReportSummaryContent, { data, vs: 'prior_period', onVsChange: () => {}, onPhrase: () => {}, aiBusy: false, aiError }),
    );

  it('a failed "Say it in plain words" request is shown under the sentence', () => {
    const html = render('The AI model could not answer.');
    expect(html).toContain(data.text);
    expect(html).toContain('role="alert"');
    expect(textOf(html)).toContain('Could not word it in plain words: The AI model could not answer.');
    expect(textOf(html)).toContain('Say it in plain words'); // the button stays, so it can be tried again
  });

  it('no error line when nothing failed', () => {
    const html = render(null);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('Could not word it');
  });
});
