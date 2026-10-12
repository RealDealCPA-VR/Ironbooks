/**
 * Quick actions for the command palette (components/CommandPalette.tsx), grouped under
 * "Actions". Each entry deep-links to a page with `?new=1` so the page opens its
 * create modal on mount (pages adopt the param progressively; until then the link
 * simply lands on the page).
 *
 * Kept separate from lib/nav.ts (sidebar destinations) because actions are verbs,
 * not places — the palette merges both.
 */

export interface NavAction {
  label: string;
  href: string;
  /** Extra match terms so e.g. "check" finds Write Check. */
  keywords?: string;
}

export const navActions: NavAction[] = [
  { label: 'New Invoice', href: '/invoices?new=1', keywords: 'create invoice bill customer' },
  { label: 'Write Check', href: '/expenses?new=1', keywords: 'new check expense pay' },
  { label: 'Receive Payment', href: '/payments?new=1', keywords: 'customer payment receive' },
  { label: 'Make Deposit', href: '/deposits?new=1', keywords: 'bank deposit funds' },
  { label: 'New Journal Entry', href: '/journal?new=1', keywords: 'general journal adjust gl' },
  { label: 'Reconcile', href: '/reconcile', keywords: 'bank reconciliation statement' },
  { label: 'Run Payroll', href: '/employees?new=1', keywords: 'pay run paycheck payroll' },
];

/** Case-insensitive filter over label + keywords; empty query returns all actions. */
export function filterNavActions(query: string): NavAction[] {
  const q = query.trim().toLowerCase();
  if (!q) return navActions;
  return navActions.filter(
    (a) => a.label.toLowerCase().includes(q) || (a.keywords ?? '').toLowerCase().includes(q),
  );
}

// ---------------------------------------------------------------------------
// Plain-language intents ("I got paid", "pay a bill", "fix a mistake")
// ---------------------------------------------------------------------------

/**
 * What a non-accountant might type, mapped to the right screen. Shown in the palette's
 * "Suggested" group above exact label matches, with a one-line description so the user
 * learns the QuickBooks name for the task ("I got paid" -> Receive Payments).
 */
export interface NavIntent {
  /** The screen/task name the user lands on. */
  label: string;
  href: string;
  /** Plain-language explanation of what the screen is for. */
  description: string;
  /** Everyday phrases that mean this task (matched after normalization). */
  phrases: string[];
}

export const navIntents: NavIntent[] = [
  {
    label: 'Receive Payments',
    href: '/payments?new=1',
    description: 'A customer paid an invoice — record the money you received.',
    phrases: [
      'i got paid', 'customer paid me', 'payment received', 'received a payment',
      'received a check', 'got a check', 'customer sent money', 'collect payment',
    ],
  },
  {
    label: 'Sales Receipt',
    href: '/sales-receipts?new=1',
    description: 'You sold something and got paid on the spot — no invoice needed.',
    phrases: [
      'record a sale', 'made a sale', 'sold something', 'cash sale', 'paid on the spot',
      'ring up a sale',
    ],
  },
  {
    label: 'Create Invoice',
    href: '/invoices?new=1',
    description: 'A customer owes you — bill them now and get paid later.',
    phrases: [
      'customer owes me', 'bill a customer', 'send an invoice', 'charge a customer',
      'customer will pay later', 'invoice a customer',
    ],
  },
  {
    label: 'Who Owes You (A/R Aging)',
    href: '/reports/ar-aging',
    description: 'See which customers owe you money and how late they are.',
    phrases: ['who owes me money', 'unpaid invoices', 'overdue customers', 'late customers'],
  },
  {
    label: 'Pay Bills',
    href: '/pay-bills',
    description: 'Pay bills you already entered from vendors.',
    phrases: ['pay a bill', 'pay my bills', 'pay a vendor', 'pay a supplier'],
  },
  {
    label: 'Enter Bills',
    href: '/bills',
    description: 'You received a bill to pay later — record what you owe.',
    phrases: ['got a bill', 'received a bill', 'enter a bill', 'i owe a vendor', 'vendor invoice'],
  },
  {
    label: 'Write Checks',
    href: '/expenses?new=1',
    description: 'You paid for something right away (check, debit card or cash).',
    phrases: [
      'i spent money', 'bought something', 'record an expense', 'paid for something',
      'write a check', 'record a purchase', 'debit card purchase',
    ],
  },
  {
    label: 'Transfer Funds',
    href: '/transfers',
    description: 'Move money between your own accounts, e.g. checking to savings.',
    phrases: [
      'move money between accounts', 'transfer money', 'checking to savings',
      'savings to checking',
    ],
  },
  {
    label: 'Record Deposits',
    href: '/deposits?new=1',
    description: 'You took payments to the bank — group them into one deposit.',
    phrases: ['went to the bank', 'deposit checks', 'deposit money', 'put money in the bank'],
  },
  {
    label: 'Reconcile',
    href: '/reconcile',
    description: 'Check your books against your bank statement.',
    phrases: ['match my bank statement', 'balance my checkbook', 'does my bank match'],
  },
  {
    label: 'How to Fix a Mistake',
    href: '/help#fix-a-mistake',
    description: 'Step-by-step guidance for correcting a wrong transaction safely.',
    phrases: [
      'fix a mistake', 'i made a mistake', 'undo a transaction', 'correct a transaction',
      'wrong amount', 'delete a transaction', 'entered it wrong',
    ],
  },
  {
    label: 'Help & Glossary',
    href: '/help',
    description: 'Plain-language answers: what A/R, undeposited funds, reconciling and more mean.',
    phrases: ['help', 'what does this mean', 'glossary', 'explain a term'],
  },
];

const STOP_WORDS = new Set([
  'i', 'a', 'an', 'the', 'my', 'me', 'to', 'for', 'of', 'from', 'how', 'do', 'want', 'need',
  'some', 'just', 'please', 'can', 'is', 'it', 'on', 'in', 'and', 'with', 'did', 'have', 'has',
]);

function intentTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9/ ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOP_WORDS.has(t));
}

/** Loose stem so "paid"/"pay", "bills"/"bill", "moving"/"move" meet. */
const IRREGULAR: Record<string, string> = {
  paid: 'pay',
  got: 'get',
  gotten: 'get',
  sold: 'sell',
  spent: 'spend',
  bought: 'buy',
  owes: 'owe',
  made: 'make',
  went: 'go',
};
function stem(t: string): string {
  if (IRREGULAR[t]) return IRREGULAR[t];
  if (t.length <= 3) return t;
  return t.replace(/(ing|ed|es|s)$/, '') || t;
}

/**
 * Score how well the query expresses a phrase: 100+ when every phrase word is present,
 * otherwise the share of query words that match a phrase word (the last, still-being-typed
 * word may match as a prefix), scaled to 0-80. 0 when fewer than half the query words match.
 */
function scorePhrase(qTokens: string[], phrase: string): number {
  const pStems = intentTokens(phrase).map(stem);
  if (!pStems.length || !qTokens.length) return 0;
  const qStems = qTokens.map(stem);
  if (pStems.every((p) => qStems.includes(p))) return 100 + pStems.length;
  const matched = qStems.filter((q, i) =>
    pStems.some(
      (p) =>
        p === q ||
        (i === qStems.length - 1 && qTokens[i].length >= 3 && p.startsWith(stem(qTokens[i]))),
    ),
  ).length;
  const ratio = matched / qStems.length;
  // Weight by phrase coverage too, so "pay" prefers "pay a bill" over a long phrase.
  const coverage = matched / pStems.length;
  return ratio >= 0.5 ? Math.round(ratio * 60 + coverage * 20) : 0;
}

/**
 * Match a free-text query against the plain-language intents, best first. The intent label
 * counts as a phrase too, so "transfer" finds Transfer Funds. Blank queries return [].
 */
export function matchIntents(query: string, limit = 3): NavIntent[] {
  const qTokens = intentTokens(query);
  if (!qTokens.length) return [];
  return navIntents
    .map((intent, order) => ({
      intent,
      order,
      score: Math.max(...[intent.label, ...intent.phrases].map((p) => scorePhrase(qTokens, p))),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map((s) => s.intent);
}
