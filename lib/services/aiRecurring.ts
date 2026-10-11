/**
 * Recurring-transaction detection — "you pay this every month; memorize it?" (QB memorized
 * transactions). Pure local statistics over the company's own bills and expenses; no LLM.
 *
 * A payee qualifies when, over the last 18 months, it has ≥3 non-void documents whose
 * spacing fits a weekly / monthly / quarterly / yearly cadence (≥75% of gaps within the
 * cadence's tolerance), whose amounts are stable (coefficient of variation ≤ 25%), and
 * whose last occurrence is recent enough that the pattern is still alive. Payees that are
 * already memorized (an active recurring template with the same vendor) are skipped.
 *
 * Memorizing builds a template from the most recent document and hands it to the normal
 * recurring.createTemplate service — default remind-only, so nothing posts without the user.
 */
import { and, eq, gte, isNull, ne } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { bills, expenses, recurringTemplates, vendors } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, validation } from './_base';
import { createTemplate, type Frequency } from './recurring';
import { getBill } from './bills';
import { getExpense } from './expenses';
import { payeeKey } from '@/lib/ai/categorizer';

const DAY = 86_400_000;

const CADENCES: { frequency: Frequency; nominal: number; tol: number }[] = [
  { frequency: 'weekly', nominal: 7, tol: 2 },
  { frequency: 'monthly', nominal: 30.4, tol: 4 },
  { frequency: 'quarterly', nominal: 91.3, tol: 8 },
  { frequency: 'yearly', nominal: 365.25, tol: 12 },
];

export interface RecurringSuggestion {
  key: string;
  vendorId: string | null;
  payee: string;
  docType: 'bill' | 'expense';
  /** Most recent document — the template is built from it. */
  sourceDocId: string;
  frequency: Frequency;
  occurrences: number;
  lastDate: string;
  nextDate: string;
  typicalAmount: string;
  amountVaries: boolean;
  confidence: number;
  suggestedName: string;
}

interface Doc {
  id: string;
  docType: 'bill' | 'expense';
  vendorId: string | null;
  payee: string;
  date: Date;
  total: string;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function addFrequency(d: Date, f: Frequency): Date {
  const n = new Date(d);
  if (f === 'weekly') n.setDate(n.getDate() + 7);
  else if (f === 'monthly') n.setMonth(n.getMonth() + 1);
  else if (f === 'quarterly') n.setMonth(n.getMonth() + 3);
  else n.setFullYear(n.getFullYear() + 1);
  return n;
}

/** Pure detector over a list of documents — exported for unit tests. */
export function detectPatterns(docs: Doc[], asOf: Date): RecurringSuggestion[] {
  const groups = new Map<string, Doc[]>();
  for (const d of docs) {
    if (!Money.isPositive(d.total)) continue;
    const key = d.vendorId ? `vendor:${d.vendorId}` : `payee:${payeeKey(d.payee) ?? ''}`;
    if (key === 'payee:') continue;
    const g = groups.get(key) ?? [];
    g.push(d);
    groups.set(key, g);
  }

  const out: RecurringSuggestion[] = [];
  for (const [key, g] of groups) {
    if (g.length < 3) continue;
    g.sort((a, b) => a.date.getTime() - b.date.getTime());
    const gaps: number[] = [];
    for (let i = 1; i < g.length; i++) gaps.push((g[i].date.getTime() - g[i - 1].date.getTime()) / DAY);
    // Same-day duplicates (e.g. split payments) aren't a cadence.
    const realGaps = gaps.filter((x) => x >= 1);
    if (realGaps.length < 2) continue;
    const med = median(realGaps);
    const cadence = CADENCES.find((c) => Math.abs(med - c.nominal) <= c.tol);
    if (!cadence) continue;
    const regular = realGaps.filter((x) => Math.abs(x - cadence.nominal) <= cadence.tol).length / realGaps.length;
    if (regular < 0.75) continue;

    const amounts = g.map((d) => new Decimal(d.total));
    const mean = amounts.reduce((a, b) => a.plus(b), new Decimal(0)).dividedBy(amounts.length);
    const variance = amounts.reduce((a, b) => a.plus(b.minus(mean).pow(2)), new Decimal(0)).dividedBy(amounts.length);
    const cv = mean.isZero() ? 1 : variance.sqrt().dividedBy(mean).toNumber();
    if (cv > 0.25) continue;

    const last = g[g.length - 1];
    // Still alive: the next occurrence is not long overdue.
    if (asOf.getTime() - last.date.getTime() > cadence.nominal * 1.6 * DAY) continue;

    const medianAmount = new Decimal(median(amounts.map((a) => a.toNumber())));
    const confidence = Math.min(1, regular * (1 - cv) * Math.min(1, g.length / 6));
    out.push({
      key,
      vendorId: last.vendorId,
      payee: last.payee,
      docType: last.docType,
      sourceDocId: last.id,
      frequency: cadence.frequency,
      occurrences: g.length,
      lastDate: last.date.toISOString(),
      nextDate: addFrequency(last.date, cadence.frequency).toISOString(),
      typicalAmount: toAmountString(medianAmount),
      amountVaries: cv > 0.01,
      confidence: Math.round(confidence * 1000) / 1000,
      suggestedName: `${last.payee} (${cadence.frequency})`,
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

/** Recurring patterns in this company's bills/expenses that are not memorized yet. */
export async function detectRecurring(ctx: ServiceContext, asOf: Date = new Date()): Promise<RecurringSuggestion[]> {
  const since = new Date(asOf.getTime() - 548 * DAY);
  const [billRows, expRows, templates] = await Promise.all([
    ctx.db
      .select({ id: bills.id, vendorId: bills.vendorId, payee: vendors.displayName, date: bills.date, total: bills.total })
      .from(bills)
      .innerJoin(vendors, eq(bills.vendorId, vendors.id))
      .where(and(eq(bills.companyId, ctx.companyId), ne(bills.status, 'void'), gte(bills.date, since))),
    ctx.db
      .select({ id: expenses.id, vendorId: expenses.vendorId, vendorName: vendors.displayName, payeeName: expenses.payeeName, date: expenses.date, total: expenses.total })
      .from(expenses)
      .leftJoin(vendors, eq(expenses.vendorId, vendors.id))
      .where(and(eq(expenses.companyId, ctx.companyId), isNull(expenses.voidedAt), gte(expenses.date, since))),
    ctx.db
      .select({ template: recurringTemplates.template })
      .from(recurringTemplates)
      .where(and(eq(recurringTemplates.companyId, ctx.companyId), eq(recurringTemplates.isActive, true))),
  ]);

  const memorizedVendors = new Set<string>();
  const memorizedPayees = new Set<string>();
  for (const t of templates) {
    const tpl = t.template as Record<string, unknown>;
    if (typeof tpl.vendorId === 'string') memorizedVendors.add(tpl.vendorId);
    if (typeof tpl.payeeName === 'string') {
      const k = payeeKey(tpl.payeeName);
      if (k) memorizedPayees.add(k);
    }
  }

  const docs: Doc[] = [
    ...billRows.map((b) => ({ id: b.id, docType: 'bill' as const, vendorId: b.vendorId, payee: b.payee, date: b.date, total: b.total })),
    ...expRows.map((e) => ({
      id: e.id,
      docType: 'expense' as const,
      vendorId: e.vendorId,
      payee: e.vendorName ?? e.payeeName ?? '',
      date: e.date,
      total: e.total,
    })),
  ];
  return detectPatterns(docs, asOf).filter((s) => {
    if (s.vendorId) return !memorizedVendors.has(s.vendorId);
    const k = payeeKey(s.payee);
    return !k || !memorizedPayees.has(k);
  });
}

export interface MemorizeInput {
  docType: 'bill' | 'expense';
  sourceDocId: string;
  frequency: Frequency;
  nextRunDate: string | Date;
  name: string;
  /** Default false → "Remind Me" (QB): nothing posts without the user. */
  autoEnter?: boolean;
}

/** Memorize a detected pattern via the normal recurring-template service. */
export async function memorizeSuggestion(ctx: ServiceContext, input: MemorizeInput) {
  if (!input.name?.trim()) throw validation('A name is required.');
  let template: Record<string, unknown>;
  if (input.docType === 'bill') {
    const b = await getBill(ctx, input.sourceDocId);
    if (b.status === 'void') throw validation('Cannot memorize a voided bill.');
    template = {
      vendorId: b.vendorId,
      memo: b.memo,
      classId: b.classId,
      // date/dueDate carry the terms offset forward (see recurring.recurrenceDueDate).
      date: b.date.toISOString(),
      dueDate: b.dueDate ? b.dueDate.toISOString() : null,
      lines: b.lines.map((l) => ({
        accountId: l.itemId ? null : l.accountId,
        itemId: l.itemId,
        description: l.description,
        quantity: l.quantity,
        amount: l.amount,
        classId: l.classId,
        customerId: l.customerId,
        jobId: l.jobId,
      })),
    };
  } else {
    const e = await getExpense(ctx, input.sourceDocId);
    if (e.voidedAt) throw validation('Cannot memorize a voided expense.');
    template = {
      vendorId: e.vendorId,
      payeeName: e.payeeName,
      method: e.method,
      paymentAccountId: e.paymentAccountId,
      memo: e.memo,
      // Check numbers come from the sequence at run time — never reuse the old one.
      lines: e.lines.map((l) => ({
        accountId: l.accountId,
        description: l.description,
        amount: l.amount,
        classId: l.classId,
        customerId: l.customerId,
        jobId: l.jobId,
      })),
    };
  }
  return createTemplate(ctx, {
    name: input.name.trim(),
    docType: input.docType,
    frequency: input.frequency,
    nextRunDate: input.nextRunDate,
    template,
    autoEnter: input.autoEnter ?? false,
  });
}
