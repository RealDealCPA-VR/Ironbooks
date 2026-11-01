/**
 * Receive Payments — credits split across invoices (salesar C4). Pure helpers (no React), Decimal
 * money, used by app/payments/page.tsx and tested in lib/services/salesar.payments.test.ts.
 *
 * QuickBooks' "Discount and Credits" window works per invoice: for the invoice you are on you tick
 * the credits to use and how much of each. One credit can so be spread over several invoices of the
 * same payment. Here the form keeps, for every available credit, the amount used on each target:
 *
 *   use[creditId][target] = amount       target = an invoice id, or `je:<line id>` (a General
 *                                        Journal charge — General Journal credits and earlier
 *                                        payments only)
 *
 * and turns that into the four request arrays the server takes (credit memos, earlier payments,
 * General Journal credits on invoices, General Journal credits on General Journal charges). The
 * server checks every credit's parts together against what it has left, inside the transaction.
 */
import type Decimal from 'decimal.js';
import { moneyDec, sumMoney } from '@/lib/paymentApply';

/** "Apply to" targets: an invoice id, or `je:<line id>` for a General Journal charge. */
export const JE_PREFIX = 'je:';

export type CreditKind = 'credit_memo' | 'payment' | 'journal_entry';

export interface SplitCredit {
  kind: CreditKind;
  id: string;
  /** What the credit has left (with what the payment being edited used handed back). */
  available: string;
  /** The credit's currency (null / '' = home). */
  currency?: string | null;
}

/** creditId -> target -> amount typed. */
export type CreditUse = Record<string, Record<string, string>>;

export interface CreditPart {
  creditId: string;
  target: string;
  amount: string;
}

export const isChargeTarget = (target: string) => target.startsWith(JE_PREFIX);

/** A credit can go on a General Journal charge only when it is a journal credit or an earlier payment. */
export const takesCharges = (kind: CreditKind) => kind === 'journal_entry' || kind === 'payment';

/** The parts with a positive amount (optionally only of the given credits). */
export function creditParts(use: CreditUse, only?: ReadonlySet<string>): CreditPart[] {
  const out: CreditPart[] = [];
  for (const [creditId, byTarget] of Object.entries(use)) {
    if (only && !only.has(creditId)) continue;
    for (const [target, amount] of Object.entries(byTarget ?? {})) {
      if (moneyDec(amount).greaterThan(0)) out.push({ creditId, target, amount });
    }
  }
  return out;
}

/** Total of one credit used on every target, except `exceptTarget` when given. */
export function creditUsed(use: CreditUse, creditId: string, exceptTarget?: string): Decimal {
  return sumMoney(Object.entries(use[creditId] ?? {}).filter(([t]) => t !== exceptTarget).map(([, a]) => a));
}

/** What a credit still has for `target`: its available amount less what other targets use. */
export function creditLeftFor(credit: SplitCredit, use: CreditUse, target?: string): Decimal {
  const left = moneyDec(credit.available).minus(creditUsed(use, credit.id, target));
  return left.greaterThan(0) ? left : moneyDec(0);
}

/**
 * Set the part of one credit on one target, as typed (a blank amount clears it; zero or partial
 * input such as "0." is kept so the field can be typed in, and counts as nothing).
 */
export function setCreditPart(use: CreditUse, creditId: string, target: string, amount: string): CreditUse {
  const byTarget = { ...(use[creditId] ?? {}) };
  if (amount.trim() === '') delete byTarget[target];
  else byTarget[target] = amount;
  const next = { ...use };
  if (Object.keys(byTarget).length === 0) delete next[creditId];
  else next[creditId] = byTarget;
  return next;
}

/** Credits entered against one target, as typed (the fix builders sum them with Decimal). */
export function creditPartsOn(use: CreditUse, target: string, only?: ReadonlySet<string>): string[] {
  return creditParts(use, only)
    .filter((p) => p.target === target)
    .map((p) => p.amount);
}

/** Credits whose parts add up to more than they have left. */
export function overdrawnCredits<C extends SplitCredit>(credits: readonly C[], use: CreditUse): C[] {
  return credits.filter((c) => creditUsed(use, c.id).greaterThan(moneyDec(c.available)));
}

/**
 * "Use credits" on one target: take each credit in turn (oldest first, as listed) up to what the
 * target still owes and what the credit has left. Credits already on the target are re-spread.
 */
export function fillCreditsFor<C extends SplitCredit>(
  credits: readonly C[],
  use: CreditUse,
  target: string,
  owes: string,
): CreditUse {
  let next = use;
  for (const c of credits) next = setCreditPart(next, c.id, target, '');
  let due = moneyDec(owes);
  for (const c of credits) {
    if (!due.greaterThan(0)) break;
    if (isChargeTarget(target) && !takesCharges(c.kind)) continue;
    const left = creditLeftFor(c, next, target);
    const take = left.lessThan(due) ? left : due;
    if (take.greaterThan(0)) {
      next = setCreditPart(next, c.id, target, take.toFixed(2));
      due = due.minus(take);
    }
  }
  return next;
}

/** The request arrays for the parts of the credits shown (other credits' parts are dropped). */
export function creditRequest(
  credits: readonly SplitCredit[],
  use: CreditUse,
): {
  credits: Array<{ creditMemoId: string; invoiceId: string; amount: string }>;
  paymentCredits: Array<{ paymentId: string; invoiceId?: string; journalLineId?: string; amount: string }>;
  journalCredits: Array<{ journalLineId: string; invoiceId: string; amount: string }>;
  journalOffsets: Array<{ journalLineId: string; chargeLineId: string; amount: string }>;
} {
  const kindOf = new Map(credits.map((c) => [c.id, c.kind]));
  const out = {
    credits: [] as Array<{ creditMemoId: string; invoiceId: string; amount: string }>,
    paymentCredits: [] as Array<{ paymentId: string; invoiceId?: string; journalLineId?: string; amount: string }>,
    journalCredits: [] as Array<{ journalLineId: string; invoiceId: string; amount: string }>,
    journalOffsets: [] as Array<{ journalLineId: string; chargeLineId: string; amount: string }>,
  };
  for (const p of creditParts(use, new Set(kindOf.keys()))) {
    const kind = kindOf.get(p.creditId)!;
    const charge = isChargeTarget(p.target);
    const lineId = charge ? p.target.slice(JE_PREFIX.length) : null;
    if (kind === 'payment') {
      out.paymentCredits.push(
        lineId ? { paymentId: p.creditId, journalLineId: lineId, amount: p.amount } : { paymentId: p.creditId, invoiceId: p.target, amount: p.amount },
      );
    } else if (kind === 'journal_entry') {
      if (lineId) out.journalOffsets.push({ journalLineId: p.creditId, chargeLineId: lineId, amount: p.amount });
      else out.journalCredits.push({ journalLineId: p.creditId, invoiceId: p.target, amount: p.amount });
    } else if (!lineId) {
      out.credits.push({ creditMemoId: p.creditId, invoiceId: p.target, amount: p.amount });
    }
  }
  return out;
}

/** Add `amount` to a part (a saved payment can hold several rows for one credit and target). */
function addPart(use: CreditUse, creditId: string, target: string, amount: string | number) {
  const byTarget = (use[creditId] ??= {});
  byTarget[target] = moneyDec(byTarget[target]).plus(moneyDec(amount)).toFixed(2);
}

/** The parts a saved payment used (edit): credit memos, General Journal credits on invoices and charges. */
export function creditUseFromPayment(detail: {
  credits?: ReadonlyArray<{ creditMemoId: string; invoiceId: string; amount: string }>;
  journalApplications?: ReadonlyArray<{ kind: string; journalLineId: string; invoiceId: string | null; amount: string }>;
  journalOffsets?: ReadonlyArray<{ journalLineId: string; chargeLineId: string; amount: string }>;
}): CreditUse {
  const use: CreditUse = {};
  for (const c of detail.credits ?? []) addPart(use, c.creditMemoId, c.invoiceId, c.amount);
  for (const j of detail.journalApplications ?? []) {
    if (j.kind === 'invoice_credit' && j.invoiceId) addPart(use, j.journalLineId, j.invoiceId, j.amount);
  }
  for (const o of detail.journalOffsets ?? []) addPart(use, o.journalLineId, JE_PREFIX + o.chargeLineId, o.amount);
  return use;
}
