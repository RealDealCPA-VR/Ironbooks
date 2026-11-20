/**
 * Knowledge base lookups: the how-to articles (./articles.ts) joined with what the app already
 * knows about itself: the menus (lib/nav.ts), the "what is this page" help (lib/pageHelp.ts) and
 * the glossary (lib/glossary.ts).
 *
 * Used by Ask AI (server), the Help page (client) and the docs generator (scripts/gen-docs.ts).
 * Pure functions over static data: no database, no network, no AI model.
 */
import { EXTRA_DESTINATIONS, navGroups, searchPages, simpleNavGroups } from '@/lib/nav';
import { PAGE_HELP } from '@/lib/pageHelp';
import { GLOSSARY, GLOSSARY_KEYS, glossaryAnchor, type GlossaryEntry, type GlossaryKey } from '@/lib/glossary';
import { KB_ARTICLES } from './articles';
import type { KbArticle, KbLink } from './types';

export { KB_ARTICLES } from './articles';
export * from './types';

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

export interface KbScreen {
  /** The page path, e.g. '/invoices'. */
  path: string;
  /** Name in the Advanced menu (or the page-help title for pages outside the menu). */
  label: string;
  /** Advanced-menu group ('Sales', 'Banking', …; 'Home' for the top links, 'Other' off-menu). */
  group: string;
  /** The QuickBooks Desktop name, when there is one. */
  qb?: string;
  /** What the page is for. */
  what?: string;
  /** What to do first on it. */
  first?: string;
  /** Also in the Simple menu, under this name. */
  simpleLabel?: string;
}

function buildScreens(): KbScreen[] {
  const byPath = new Map<string, KbScreen>();
  for (const g of navGroups) {
    for (const l of g.links) {
      if (byPath.has(l.path)) continue;
      const help = PAGE_HELP[l.path];
      byPath.set(l.path, { path: l.path, label: l.label, group: g.heading || 'Home', qb: l.qb ?? help?.qb, what: help?.what, first: help?.first });
    }
  }
  for (const g of simpleNavGroups) {
    for (const l of g.links) {
      const s = byPath.get(l.path);
      if (s) s.simpleLabel = l.label;
      else {
        const help = PAGE_HELP[l.path];
        byPath.set(l.path, { path: l.path, label: l.label, group: g.heading || 'Home', qb: l.qb ?? help?.qb, what: help?.what, first: help?.first, simpleLabel: l.label });
      }
    }
  }
  for (const [path, help] of Object.entries(PAGE_HELP)) {
    if (!byPath.has(path)) byPath.set(path, { path, label: help.title, group: 'Other', qb: help.qb, what: help.what, first: help.first });
  }
  for (const d of EXTRA_DESTINATIONS) {
    if (!byPath.has(d.href)) byPath.set(d.href, { path: d.href, label: d.label, group: 'Other' });
  }
  if (!byPath.has('/help')) {
    byPath.set('/help', { path: '/help', label: 'Help & Glossary', group: 'Other', what: 'Plain-language guides for common tasks and a glossary of accounting terms.', first: 'Type what you want to do in the search box.' });
  }
  return [...byPath.values()];
}

/** Every screen the knowledge base knows, menu order first. */
export const KB_SCREENS: KbScreen[] = buildScreens();

const SCREEN_BY_PATH = new Map(KB_SCREENS.map((s) => [s.path, s]));

/** Path without its query or anchor. */
export function basePath(href: string): string {
  return href.split('?')[0].split('#')[0];
}

export function screenFor(href: string): KbScreen | undefined {
  return SCREEN_BY_PATH.get(basePath(href));
}

/** "Sales › Invoices": where a screen sits in the Advanced menu. Null for off-menu pages. */
export function menuPath(href: string): string | null {
  const s = screenFor(href);
  if (!s || s.group === 'Other') return null;
  return s.group === 'Home' ? s.label : `${s.group} › ${s.label}`;
}

function articleLinks(a: KbArticle): KbLink[] {
  const out: KbLink[] = [];
  const seen = new Set<string>();
  for (const l of [a.go, ...a.steps.map((s) => s.link)]) {
    if (!l || seen.has(l.href)) continue;
    seen.add(l.href);
    out.push(l);
  }
  return out;
}

/** The screens an article sends you to: its `go` link first, then the step links, no repeats. */
export function linksOf(a: KbArticle): KbLink[] {
  return articleLinks(a);
}

/**
 * Every in-app path the knowledge base may link to. Ask AI drops any link a model writes that
 * is not in here, so an answer can never send someone to a page that does not exist. A test
 * checks each one against app/…/page.tsx.
 */
export const KB_ROUTES: ReadonlySet<string> = new Set([
  ...KB_SCREENS.map((s) => s.path),
  ...KB_ARTICLES.flatMap((a) => articleLinks(a).map((l) => basePath(l.href))),
]);

/** True for an in-app link the knowledge base knows ('/invoices?new=1', '/help#fix-a-mistake'). */
export function isKnownRoute(href: string): boolean {
  if (!href.startsWith('/') || href.startsWith('//')) return false;
  return KB_ROUTES.has(basePath(href));
}

export function articleById(id: string): KbArticle | undefined {
  return KB_ARTICLES.find((a) => a.id === id);
}

/** The Help page anchor for an article. */
export function articleHref(a: Pick<KbArticle, 'id'>): string {
  return `/help#${a.id}`;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const STOP = new Set([
  'i', 'a', 'an', 'the', 'my', 'me', 'to', 'for', 'of', 'from', 'how', 'do', 'does', 'did', 'want', 'need', 'some',
  'just', 'please', 'can', 'could', 'should', 'would', 'is', 'are', 'was', 'it', 'on', 'in', 'at', 'and', 'or', 'with',
  'have', 'has', 'where', 'what', 'which', 'when', 'we', 'you', 'our', 'your', 'this', 'that', 'there', 'be', 'way',
  'go', 'get', 'about', 'into', 'so', 'if', 'as', 'by', 'will', 'ironbooks', 'app', 'thing', 'something', 'up',
]);

const IRREGULAR: Record<string, string> = {
  paid: 'pay', paying: 'pay', pays: 'pay',
  got: 'get', gotten: 'get',
  sold: 'sell', spent: 'spend', bought: 'buy', owes: 'owe', owed: 'owe', made: 'make', went: 'go',
  reconciliation: 'reconcile', reconciliations: 'reconcile', reconciling: 'reconcile', reconciled: 'reconcile',
  categories: 'category', categorize: 'category', categorise: 'category', categorizing: 'category', categorized: 'category',
  cheque: 'check', cheques: 'check', checks: 'check',
  bookkeeper: 'accountant', cpa: 'accountant',
  backup: 'back', backups: 'back',
  quickbooks: 'qb', qbw: 'qb',
  clients: 'customer', client: 'customer', suppliers: 'vendor', supplier: 'vendor',
  employees: 'employee', staff: 'employee',
  payments: 'payment',
};

function stem(t: string): string {
  const irr = IRREGULAR[t];
  if (irr) return irr;
  if (t.length <= 3) return t;
  return t.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '') || t;
}

/** Search words of a text: lower-case, no stop words, loosely stemmed. */
export function kbTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9/ ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t))
    .map(stem)
    .filter((t) => !STOP.has(t));
}

interface IndexedArticle {
  article: KbArticle;
  phrases: string[][];
  bag: Set<string>;
}

const INDEX: IndexedArticle[] = KB_ARTICLES.map((article) => ({
  article,
  phrases: [article.title, ...article.asks].map(kbTokens).filter((p) => p.length > 0),
  bag: new Set(kbTokens([article.title, ...article.asks, article.keywords ?? '', article.summary].join(' '))),
}));

function scoreArticle(q: string[], a: IndexedArticle): number {
  let best = 0;
  for (const p of a.phrases) {
    const matched = p.filter((w) => q.includes(w)).length;
    if (matched === p.length) {
      // The whole phrase was typed. Longer phrases are more specific; extra query words that the
      // article does not know about at all count a little against it. A one-word phrase ('reconcile',
      // 'what changed' -> 'chang') inside a longer question is only a hint, not the question.
      const stray = q.filter((w) => !p.includes(w) && !a.bag.has(w)).length;
      best = Math.max(best, p.length === 1 && q.length > 2 ? 45 : 100 + 4 * p.length - 3 * stray);
      continue;
    }
    const qMatched = q.filter((w) => p.includes(w)).length;
    const ratio = qMatched / q.length;
    if (ratio >= 0.5) best = Math.max(best, Math.round(40 * ratio + 30 * (matched / p.length)));
  }
  const inBag = q.filter((w) => a.bag.has(w)).length;
  const share = inBag / q.length;
  if (share >= 0.6) best = Math.max(best, Math.round(35 * share + (share === 1 ? 12 : 0) + Math.min(inBag, 4)));
  return best;
}

export interface KbArticleHit {
  article: KbArticle;
  /** 100+ = a whole way of asking it was typed; 60+ is a confident match; below 35 is dropped. */
  score: number;
}

/** A score at which the top article can be given as THE answer without a model reading it. */
export const KB_CONFIDENT = 60;
const KB_MIN = 35;

/** The how-to articles that answer a question, best first. */
export function searchArticles(query: string, limit = 3): KbArticleHit[] {
  const q = [...new Set(kbTokens(query))];
  if (!q.length) return [];
  return INDEX.map((a, order) => ({ article: a.article, order, score: scoreArticle(q, a) }))
    .filter((h) => h.score >= KB_MIN)
    .sort((x, y) => y.score - x.score || x.order - y.order)
    .slice(0, limit)
    .map(({ article, score }) => ({ article, score }));
}

export interface KbTermHit {
  key: GlossaryKey;
  term: string;
  short: string;
  href: string;
}

/** Glossary terms named in a question ("what is undeposited funds", "what does A/R mean"). */
export function searchTerms(query: string, limit = 2): KbTermHit[] {
  const q = ` ${query.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9/& ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const out: KbTermHit[] = [];
  for (const key of GLOSSARY_KEYS) {
    const e: GlossaryEntry = GLOSSARY[key];
    const names = [e.term.replace(/\s*\(.*\)\s*$/, ''), ...(e.aliases ?? [])].map((n) => n.toLowerCase().replace(/[’']/g, ''));
    // Short aliases ("ar", "ap") only count as whole words; all names match as whole phrases.
    if (names.some((n) => n.length >= 2 && q.includes(` ${n} `))) {
      out.push({ key, term: e.term, short: e.short, href: `/help#${glossaryAnchor(key)}` });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export interface KbSearchResult {
  articles: KbArticleHit[];
  /** Screens whose name, QuickBooks name or keywords match. */
  screens: { label: string; href: string; what?: string; menu: string | null }[];
  terms: KbTermHit[];
}

/**
 * Everything the knowledge base has on a question: how-to articles, matching screens and
 * glossary terms. `canOpen` hides screens and article links a person's role may not open.
 */
export function searchKb(query: string, opts: { canOpen?: (path: string) => boolean; articleLimit?: number; screenLimit?: number } = {}): KbSearchResult {
  const canOpen = opts.canOpen ?? (() => true);
  const articles = searchArticles(query, opts.articleLimit ?? 3);
  const screens = searchPages(query, { limit: 8 })
    .filter((p) => isKnownRoute(p.href) && canOpen(basePath(p.href)))
    .slice(0, opts.screenLimit ?? 4)
    .map((p) => ({ label: p.label, href: p.href, what: screenFor(p.href)?.what, menu: menuPath(p.href) }));
  return { articles, screens, terms: searchTerms(query) };
}

/**
 * True when a message asks HOW or WHERE to do something in the app (or what a term means),
 * rather than for a number from the books. "How did we do this month?" and "What is our cash
 * balance?" are not; "How do I reconcile?" and "Where do I enter a bill?" are.
 */
export function looksLikeHowTo(message: string): boolean {
  const t = message.toLowerCase().trim();
  return (
    /\bhow (do|can|should|would|could|does) (i|we|you|one|it|ironbooks)\b/.test(t) ||
    /\bhow to\b/.test(t) ||
    /\bwhere (do|can|should|would) (i|we|you)\b/.test(t) ||
    /\bwhere(s| is| are)? (the|my|a) [a-z /&-]+ (screen|page|menu|report|setting|settings|button|option|list|center|form|window)\b/.test(t) ||
    /\b(can|could|may) (i|we|you|ironbooks)\b/.test(t) ||
    /\b(show|tell|teach) me how\b/.test(t) ||
    /\b(walk me through|steps? (to|for)|help me (to )?|i (want|need|would like) to|is there a way to|what(s| is) the (best |right |easiest )?way to)\b/.test(t) ||
    /\bwhat (does|do) .+ mean\b/.test(t) ||
    /\bwhat(s| is| are) (an?|the difference between) \b/.test(t) ||
    /\b(set ?up|setup|install|configure|connect|import|export|migrate|restore)\b/.test(t)
  );
}
