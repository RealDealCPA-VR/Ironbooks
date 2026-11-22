/**
 * The product knowledge base (lib/kb): the articles are well-formed, every link is a real
 * screen, and a question finds its guide.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  KB_AREAS, KB_AREA_ORDER, KB_ARTICLES, KB_CONFIDENT, KB_ROUTES, KB_SCREENS,
  basePath, isKnownRoute, linksOf, looksLikeHowTo, menuPath, searchArticles, searchKb, searchTerms,
} from './index';
import { navGroups, simpleNavGroups } from '@/lib/nav';
import { navIntents } from '@/lib/nav-actions';

const ROOT = process.cwd();
const pageExists = (route: string) => fs.existsSync(path.join(ROOT, 'app', ...route.split('/').filter(Boolean), 'page.tsx'));

describe('knowledge base articles', () => {
  it('have unique kebab-case ids and the fields every reader needs', () => {
    const ids = KB_ARTICLES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of KB_ARTICLES) {
      expect(a.id, a.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(KB_AREAS[a.area], `${a.id} area`).toBeTruthy();
      expect(a.title.length, `${a.id} title`).toBeGreaterThan(8);
      expect(a.summary.length, `${a.id} summary`).toBeGreaterThan(30);
      expect(a.steps.length, `${a.id} steps`).toBeGreaterThanOrEqual(2);
      expect(a.asks.length, `${a.id} asks`).toBeGreaterThanOrEqual(3);
      for (const ask of a.asks) expect(ask, `${a.id} ask`).toBe(ask.toLowerCase());
    }
  });

  it('cover every area', () => {
    for (const area of KB_AREA_ORDER) expect(KB_ARTICLES.some((a) => a.area === area), area).toBe(true);
    expect(KB_ARTICLES.length).toBeGreaterThanOrEqual(70);
  });

  it('keep the ids older links point at', () => {
    // /help#… anchors used by the command palette, tooltips and earlier versions of the Help page.
    const ids = new Set(KB_ARTICLES.map((a) => a.id));
    for (const id of ['fix-a-mistake', 'got-paid', 'paying-bills', 'reconcile-monthly', 'company-file', 'file-server', 'try-it-on-a-copy']) {
      expect(ids.has(id), id).toBe(true);
    }
    for (const i of navIntents) {
      const anchor = i.href.startsWith('/help#') ? i.href.slice('/help#'.length) : null;
      if (anchor && !anchor.startsWith('term-')) expect(ids.has(anchor), i.href).toBe(true);
    }
  });

  it('link only to screens that exist', () => {
    for (const a of KB_ARTICLES) {
      for (const l of linksOf(a)) {
        expect(l.href.startsWith('/'), `${a.id}: ${l.href}`).toBe(true);
        expect(pageExists(basePath(l.href)), `${a.id}: no page for ${l.href}`).toBe(true);
        expect(l.label.trim().length, `${a.id}: label for ${l.href}`).toBeGreaterThan(2);
      }
    }
  });

  it('use ?new=1 only on pages that open their form from it', () => {
    for (const a of KB_ARTICLES) {
      for (const l of linksOf(a)) {
        if (!l.href.includes('?new=1')) continue;
        const src = fs.readFileSync(path.join(ROOT, 'app', ...basePath(l.href).split('/').filter(Boolean), 'page.tsx'), 'utf8');
        expect(/['"]new['"]|useNewParam|\?new=1/.test(src), `${a.id}: ${l.href}`).toBe(true);
      }
    }
  });
});

describe('knowledge base screens', () => {
  it('every known route is a real page', () => {
    for (const route of KB_ROUTES) expect(pageExists(route), route).toBe(true);
  });

  it('include every menu link, with its help text where the page has some', () => {
    const paths = new Set(KB_SCREENS.map((s) => s.path));
    for (const g of [...navGroups, ...simpleNavGroups]) for (const l of g.links) expect(paths.has(l.path), l.path).toBe(true);
    const inv = KB_SCREENS.find((s) => s.path === '/invoices')!;
    expect(inv).toMatchObject({ label: 'Invoices', group: 'Sales', qb: 'Create Invoices', simpleLabel: 'Create Invoice' });
    expect(inv.what).toMatch(/Bill a customer/);
    expect(menuPath('/invoices?new=1')).toBe('Sales › Invoices');
    expect(menuPath('/dashboard')).toBe('Home');
    expect(menuPath('/login')).toBeNull();
  });

  it('isKnownRoute accepts in-app screens only', () => {
    expect(isKnownRoute('/reconcile')).toBe(true);
    expect(isKnownRoute('/invoices?new=1')).toBe(true);
    expect(isKnownRoute('/help#fix-a-mistake')).toBe(true);
    expect(isKnownRoute('/invoices/new')).toBe(false);
    expect(isKnownRoute('/api/companies')).toBe(false);
    expect(isKnownRoute('//evil.example/x')).toBe(false);
    expect(isKnownRoute('https://example.com')).toBe(false);
  });
});

describe('knowledge base search', () => {
  const top = (q: string) => searchArticles(q)[0]?.article.id;

  it('finds the guide for a question, however it is asked', () => {
    const cases: [string, string][] = [
      ['How do I reconcile my bank account?', 'reconcile-monthly'],
      ['how to reconcile a credit card', 'reconcile-monthly'],
      ['my reconciliation is off, how do I undo it', 'undo-reconciliation'],
      ['Where do I enter a bill?', 'paying-bills'],
      ['how do i pay a vendor', 'paying-bills'],
      ['How do I create an invoice?', 'create-invoice'],
      ['I need to bill a customer', 'create-invoice'],
      ['A customer paid me, what now?', 'got-paid'],
      ['how do I record a deposit', 'make-deposit'],
      ['How do I import my bank statement?', 'import-bank-statement'],
      ['how can i connect my bank', 'import-bank-statement'],
      ['how do I categorize bank transactions', 'review-bank-transactions'],
      ['How do I back up my books?', 'back-up'],
      ['how do i restore a backup', 'restore-backup'],
      ['How do I connect an AI model?', 'connect-ai'],
      ['how do I set up ChatGPT', 'connect-ai'],
      ['How do I move from QuickBooks?', 'migrate-from-quickbooks'],
      ['import an IIF file', 'migrate-from-quickbooks'],
      ['How do I add a user?', 'users-and-roles'],
      ['how do i run payroll', 'run-payroll'],
      ['how do I pay payroll taxes', 'pay-payroll-taxes'],
      ['How do I close the month?', 'close-month'],
      ['how do I make a journal entry', 'journal-entry'],
      ['how do I add an account', 'chart-of-accounts'],
      ['how do I print checks', 'print-checks'],
      ['how do i write a check', 'write-check'],
      ['I made a mistake, how do I fix it', 'fix-a-mistake'],
      ['how do I void a check', 'fix-a-mistake'],
      ['how do I send a statement to a customer', 'customer-statement'],
      ['how do I prepare 1099s', 'form-1099'],
      ['how do I scan a receipt', 'capture-receipts'],
      ['how do I set up sales tax', 'sales-tax'],
      ['can two people use it at the same time', 'file-server'],
      ['I forgot my password', 'forgot-password'],
      ['how do I install Ironbooks', 'install-ironbooks'],
      ['how do I create a new company', 'create-company'],
      ['how do I send my books to my accountant', 'accountants-copy'],
      ['how do I find a transaction', 'find-transaction'],
      ['how do I transfer money between accounts', 'transfer-funds'],
      ['how do I adjust inventory', 'adjust-inventory'],
      ['can I try something without changing my books', 'try-it-on-a-copy'],
      ['why can I not change an old transaction, the period is closed', 'closed-period'],
      ['where are the settings', 'preferences'],
      ['how do i make a budget', 'budgets'],
      ['how do I merge duplicate customers', 'merge-duplicates'],
    ];
    const wrong = cases.filter(([q, id]) => top(q) !== id).map(([q, id]) => `${q} -> ${top(q)} (wanted ${id})`);
    expect(wrong).toEqual([]);
    for (const [q] of cases) expect(searchArticles(q)[0].score, q).toBeGreaterThanOrEqual(KB_CONFIDENT);
  });

  it('finds every article by its own title and by each way of asking it', () => {
    const missed: string[] = [];
    for (const a of KB_ARTICLES) {
      for (const q of [a.title, ...a.asks]) {
        const hits = searchArticles(q, 3).map((h) => h.article.id);
        if (!hits.includes(a.id)) missed.push(`${a.id}: "${q}" -> ${hits.join(', ')}`);
      }
      if (top(a.title) !== a.id) missed.push(`${a.id}: title is not its own top hit (${top(a.title)})`);
    }
    expect(missed).toEqual([]);
  });

  it('does not answer nonsense or questions about numbers with a confident guide', () => {
    for (const q of ['asdf qwerty', 'the', '', 'purple elephants dancing']) {
      expect((searchArticles(q)[0]?.score ?? 0) >= KB_CONFIDENT, q).toBe(false);
    }
  });

  it('searchKb also returns screens (by name or QuickBooks name) and glossary terms', () => {
    const fc = searchKb('finance charges');
    expect(fc.screens[0]).toMatchObject({ href: '/finance-charges', menu: 'Sales › Late-payment charges' });
    expect(searchKb('what does undeposited funds mean').terms[0]?.key).toBe('undeposited-funds');
    expect(searchTerms('what is A/R?')[0]?.key).toBe('ar');
    expect(searchTerms('how are you')).toEqual([]);
    // Screens a role may not open are left out.
    expect(searchKb('finance charges', { canOpen: (p) => p !== '/finance-charges' }).screens.some((s) => s.href === '/finance-charges')).toBe(false);
  });
});

describe('looksLikeHowTo', () => {
  it('is true for how / where / can-I questions about the app', () => {
    for (const q of [
      'How do I reconcile?', 'how to pay a bill', 'Where do I enter a bill?', 'Can I undo a reconciliation?', 'Show me how to back up',
      'What does undeposited funds mean?', 'What is a credit memo?', 'I want to add a user', 'Set up payroll', 'Is there a way to print checks?',
      'How can I import a bank statement', 'Where is the reconcile screen?',
    ]) {
      expect(looksLikeHowTo(q), q).toBe(true);
    }
  });

  it('is false for questions about the numbers', () => {
    for (const q of [
      'How did we do this month?', 'What is our cash balance?', 'Who owes us money?', 'Which bills are overdue?', 'How much did we spend on fuel?',
      'What were our biggest expenses last month?', 'Show me the open invoices', 'Top customers this year', 'What was our cash flow this year?',
      'Where is my money going?',
    ]) {
      expect(looksLikeHowTo(q), q).toBe(false);
    }
  });
});
