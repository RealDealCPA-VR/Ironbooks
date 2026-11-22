/**
 * The product knowledge base: "how do I…" articles about Ironbooks itself.
 *
 * ONE source feeds four readers, so they cannot drift apart:
 *   - Ask AI (lib/services/aiAssistant.ts) looks articles up and answers with links into the app;
 *   - the in-app Help page (app/help) lists and searches them;
 *   - the Markdown guides under docs/guide are generated from them (npm run docs);
 *   - docs/agents/kb.json gives agents the same content as data.
 *
 * Screens are NOT repeated here: they come from lib/nav.ts (menus) and lib/pageHelp.ts ("what
 * is this page"). Terms come from lib/glossary.ts. Pure data, no JSX.
 */

export type KbArea =
  | 'start'
  | 'sales'
  | 'purchases'
  | 'banking'
  | 'accounting'
  | 'payroll'
  | 'inventory'
  | 'reports'
  | 'file'
  | 'ai'
  | 'quickbooks'
  | 'fixes';

/** A place in the app: `href` is an in-app path, optionally with a query (`/invoices?new=1`). */
export interface KbLink {
  label: string;
  href: string;
}

export interface KbStep {
  text: string;
  /** The screen this step happens on. */
  link?: KbLink;
}

export interface KbArticle {
  /** Stable kebab-case id: the anchor on /help and in docs/guide. Never reuse or rename. */
  id: string;
  area: KbArea;
  /** The question, the way a person asks it. */
  title: string;
  /** The answer in one or two sentences. */
  summary: string;
  steps: KbStep[];
  /** Where to go to do it (the "take me there" button). Omitted when it happens outside a screen. */
  go?: KbLink;
  /** Other ways people ask this (lower-case phrases). */
  asks: string[];
  /** Extra search words. */
  keywords?: string;
  /** Good to know: limits, cautions, where a setting lives. */
  notes?: string[];
}

export const KB_AREAS: Record<KbArea, { title: string; blurb: string }> = {
  start: { title: 'Getting started', blurb: 'Install, make or open a company, find your way around.' },
  sales: { title: 'Customers & sales', blurb: 'Invoices, payments, estimates, statements, sales tax.' },
  purchases: { title: 'Vendors & purchases', blurb: 'Bills, checks, purchase orders, receipts, 1099s.' },
  banking: { title: 'Banking', blurb: 'Bank statements, review, rules, reconciling, deposits, transfers.' },
  accounting: { title: 'Accounting & closing', blurb: 'Accounts, journal entries, closing, your accountant.' },
  payroll: { title: 'Employees & payroll', blurb: 'Set up payroll, pay employees, pay payroll taxes.' },
  inventory: { title: 'Items & inventory', blurb: 'Products and services, stock, assemblies, pricing.' },
  reports: { title: 'Reports', blurb: 'Profit & Loss, Balance Sheet, aging, finding transactions.' },
  file: { title: 'Company file, backup & users', blurb: 'The file, backups, passwords, users, multi-user.' },
  ai: { title: 'AI & automation', blurb: 'Connect a model, Ask AI, automatic categorizing, privacy.' },
  quickbooks: { title: 'Coming from QuickBooks', blurb: 'Move your books over and find the screens you know.' },
  fixes: { title: 'Fixing things', blurb: 'Correct a mistake, undo, void, locked dates, check the data.' },
};

export const KB_AREA_ORDER: KbArea[] = [
  'start', 'sales', 'purchases', 'banking', 'accounting', 'payroll', 'inventory', 'reports', 'file', 'ai', 'quickbooks', 'fixes',
];
