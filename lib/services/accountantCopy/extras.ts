/**
 * Accountant's Copy (PARITY I1): applications and bank reconciliations in the changes file.
 *
 * Applications made outside a payment travel on their own:
 *  - a credit memo applied to an invoice (credit_applications rows without a payment) — and the
 *    removal of one that existed when the copy was made;
 *  - a vendor credit applied to / taken off a bill (applyToBill / unapplyFromBill, read from the
 *    audit trail and netted per credit and bill);
 *  - a General Journal A/R or A/P line applied to an invoice, a bill or a General Journal charge
 *    (journal_item_applications rows without a payment) — and the removal of one.
 * Applications made inside Receive Payments / Pay Bills travel with the payment (docs.ts).
 *
 * Reconciliations: Undo Last Reconciliation of a statement that was reconciled when the copy was
 * made, and new completed reconciliations (statement, the lines cleared, the service charge /
 * interest the statement added). Only statements dated on or before the dividing date.
 */
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import {
  accountantCopyBaseline,
  auditLogs,
  bankAccounts,
  bills,
  creditApplications,
  journalEntries,
  journalEntryLines,
  journalItemApplications,
  reconciliationItems,
  reconciliations,
  vendorCreditApplications,
  vendorCredits,
} from '@/lib/db/schema';
import { Money, formatCurrency, toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError } from '../_base';
import { applyToInvoice, unapplyCreditApplication } from '../creditMemos';
import { applyToBill, unapplyFromBill } from '../vendorCredits';
import { applyJournalCredit, unapplyJournalApplication } from '../journalApplications';
import {
  addStatementAdjustments,
  completeReconciliation,
  startReconciliation,
  toggleCleared,
  undoLastReconciliation,
} from '../reconcile';
import { lineRefOf } from './lineRefs';
import type { ApplicationChange, LineRef, ReconciliationChange } from './format';
import type { Labels } from './docs';

const iso = (d: Date | string) => new Date(d).toISOString();
const ymd = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Baseline (accountant side, at open)
// ---------------------------------------------------------------------------

/** Baseline rows of the applications and reconciliations that exist when the copy is opened. */
export function extrasBaselineSql(copyId: string, companyId: string) {
  return [
    sql`INSERT INTO accountant_copy_baseline (copy_id, entity_type, entity_id, version, digest, state)
      SELECT ${copyId}::uuid, 'credit_application', a.id, a.created_at,
             jsonb_build_object('creditMemoId', a.credit_memo_id, 'invoiceId', a.invoice_id, 'amount', a.amount, 'date', a.date)::text, 'live'
        FROM credit_applications a WHERE a.company_id = ${companyId}::uuid AND a.payment_id IS NULL`,
    sql`INSERT INTO accountant_copy_baseline (copy_id, entity_type, entity_id, version, digest, state)
      SELECT ${copyId}::uuid, 'journal_application', a.id, a.created_at,
             jsonb_build_object('kind', a.kind, 'amount', a.amount, 'date', a.date, 'pairId', a.pair_id)::text, 'live'
        FROM journal_item_applications a
       WHERE a.company_id = ${companyId}::uuid AND a.payment_id IS NULL AND a.bill_payment_id IS NULL`,
    sql`INSERT INTO accountant_copy_baseline (copy_id, entity_type, entity_id, version, digest, state)
      SELECT ${copyId}::uuid, 'reconciliation', r.id, r.completed_at, NULL, r.status
        FROM reconciliations r JOIN bank_accounts b ON b.id = r.bank_account_id
       WHERE b.company_id = ${companyId}::uuid`,
  ];
}

type BaseRow = typeof accountantCopyBaseline.$inferSelect;

// ---------------------------------------------------------------------------
// Delta (accountant side)
// ---------------------------------------------------------------------------

async function ref(ctx: ServiceContext, lineId: string): Promise<LineRef> {
  const r = await lineRefOf(ctx, lineId);
  if (!r) throw new ServiceError('NOT_FOUND', 'A journal line an application uses is missing from the file.');
  return r;
}

/** Applications made / removed in the copy since it was opened. */
export async function applicationChanges(ctx: ServiceContext, base: Map<string, Map<string, BaseRow>>, openedAt: Date | null): Promise<ApplicationChange[]> {
  const out: ApplicationChange[] = [];
  const baseOf = (t: string) => base.get(t) ?? new Map<string, BaseRow>();

  // ---- Credit memos → invoices (outside a payment): removals first, then new ones ----
  const baseCredit = baseOf('credit_application');
  const credit = await ctx.db
    .select()
    .from(creditApplications)
    .where(and(eq(creditApplications.companyId, ctx.companyId), isNull(creditApplications.paymentId)))
    .orderBy(asc(creditApplications.createdAt));
  const creditIds = new Set(credit.map((c) => c.id));
  for (const [id, b] of baseCredit) {
    if (creditIds.has(id)) continue;
    const v = JSON.parse(b.digest ?? '{}') as { creditMemoId: string; invoiceId: string; amount: string | number; date: string };
    out.push({ op: 'unapply', kind: 'credit_memo', id, creditMemoId: v.creditMemoId, invoiceId: v.invoiceId, amount: toAmountString(v.amount), date: iso(v.date) });
  }
  for (const c of credit) {
    if (baseCredit.has(c.id)) continue;
    out.push({ op: 'apply', kind: 'credit_memo', id: c.id, creditMemoId: c.creditMemoId, invoiceId: c.invoiceId, amount: toAmountString(c.amount), date: iso(c.date) });
  }

  // ---- Vendor credits → bills (net per credit and bill, from the audit trail) ----
  if (openedAt) {
    const rows = await ctx.db
      .select({ id: auditLogs.entityId, v: auditLogs.newValues, at: auditLogs.createdAt })
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, 'vendor_credit'), gt(auditLogs.createdAt, openedAt)))
      .orderBy(asc(auditLogs.createdAt));
    const net = new Map<string, { vendorCreditId: string; billId: string; amount: ReturnType<typeof Money.zero> }>();
    for (const r of rows) {
      const v = r.v as { action?: string; billId?: string; amount?: string } | null;
      if (!v?.billId || (v.action !== 'applied_to_bill' && v.action !== 'unapplied_from_bill')) continue;
      const key = `${r.id}:${v.billId}`;
      const cur = net.get(key) ?? { vendorCreditId: r.id, billId: v.billId, amount: Money.zero() };
      cur.amount = v.action === 'applied_to_bill' ? cur.amount.plus(Money.of(v.amount ?? 0)) : cur.amount.minus(Money.of(v.amount ?? 0));
      net.set(key, cur);
    }
    for (const n of net.values()) {
      if (n.amount.isZero()) continue;
      const date = await vendorCreditApplicationDay(ctx, n.vendorCreditId, n.billId);
      out.push({
        op: n.amount.greaterThan(0) ? 'apply' : 'unapply',
        kind: 'vendor_credit',
        id: n.vendorCreditId,
        vendorCreditId: n.vendorCreditId,
        billId: n.billId,
        amount: toAmountString(n.amount.abs()),
        date,
      });
    }
  }

  // ---- General Journal credits (outside a payment) ----
  const baseJournal = baseOf('journal_application');
  const journal = await ctx.db
    .select({
      id: journalItemApplications.id,
      side: journalItemApplications.side,
      kind: journalItemApplications.kind,
      journalLineId: journalItemApplications.journalLineId,
      invoiceId: journalItemApplications.invoiceId,
      billId: journalItemApplications.billId,
      amount: journalItemApplications.amount,
      date: journalItemApplications.date,
      pairId: journalItemApplications.pairId,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
    })
    .from(journalItemApplications)
    .innerJoin(journalEntryLines, eq(journalEntryLines.id, journalItemApplications.journalLineId))
    .where(
      and(
        eq(journalItemApplications.companyId, ctx.companyId),
        isNull(journalItemApplications.paymentId),
        isNull(journalItemApplications.billPaymentId),
      ),
    )
    .orderBy(asc(journalItemApplications.createdAt));
  const journalIds = new Set(journal.map((j) => j.id));
  const removedPairs = new Set<string>();
  for (const [id, b] of baseJournal) {
    if (journalIds.has(id)) continue;
    const v = JSON.parse(b.digest ?? '{}') as { amount: string | number; date: string; pairId: string | null };
    if (v.pairId) {
      if (removedPairs.has(v.pairId)) continue;
      removedPairs.add(v.pairId);
    }
    out.push({ op: 'unapply', kind: 'journal', id, amount: toAmountString(v.amount), date: iso(v.date) });
  }
  const pairs = new Map<string, typeof journal>();
  for (const j of journal) {
    if (baseJournal.has(j.id)) continue;
    if (j.kind === 'journal_offset' && j.pairId) {
      pairs.set(j.pairId, [...(pairs.get(j.pairId) ?? []), j]);
      continue;
    }
    if (j.kind !== 'invoice_credit' && j.kind !== 'bill_credit') continue;
    out.push({
      op: 'apply',
      kind: 'journal',
      id: j.id,
      line: await ref(ctx, j.journalLineId),
      invoiceId: j.kind === 'invoice_credit' ? j.invoiceId : null,
      billId: j.kind === 'bill_credit' ? j.billId : null,
      chargeLine: null,
      amount: toAmountString(j.amount),
      date: iso(j.date),
    });
  }
  for (const rows of pairs.values()) {
    // A/R: the credit line has more credit than debit; A/P: the one with more debit.
    const isCreditLine = (r: (typeof rows)[number]) => {
      const n = Money.of(r.debit ?? 0).minus(Money.of(r.credit ?? 0));
      return r.side === 'ar' ? n.lessThan(0) : n.greaterThan(0);
    };
    const c = rows.find(isCreditLine);
    const charge = rows.find((r) => !isCreditLine(r));
    if (!c || !charge) continue;
    out.push({
      op: 'apply',
      kind: 'journal',
      id: c.id,
      line: await ref(ctx, c.journalLineId),
      invoiceId: null,
      billId: null,
      chargeLine: await ref(ctx, charge.journalLineId),
      amount: toAmountString(c.amount),
      date: iso(c.date),
    });
  }
  return out;
}

/** The date a vendor credit application is recorded with (foreign credits keep theirs). */
async function vendorCreditApplicationDay(ctx: ServiceContext, vendorCreditId: string, billId: string): Promise<string> {
  const [last] = await ctx.db
    .select({ date: vendorCreditApplications.date })
    .from(vendorCreditApplications)
    .where(
      and(
        eq(vendorCreditApplications.companyId, ctx.companyId),
        eq(vendorCreditApplications.vendorCreditId, vendorCreditId),
        eq(vendorCreditApplications.billId, billId),
      ),
    )
    .orderBy(sql`${vendorCreditApplications.createdAt} DESC`)
    .limit(1);
  if (last) return iso(last.date);
  const [c] = await ctx.db.select({ date: vendorCredits.date }).from(vendorCredits).where(eq(vendorCredits.id, vendorCreditId));
  const [b] = await ctx.db.select({ date: bills.date }).from(bills).where(eq(bills.id, billId));
  const later = [c?.date, b?.date].filter((d): d is Date => !!d).sort((x, y) => y.getTime() - x.getTime())[0];
  return iso(later ?? new Date());
}

/** Reconciliations undone / completed in the copy since it was opened. */
export async function reconciliationChanges(
  ctx: ServiceContext,
  base: Map<string, Map<string, BaseRow>>,
): Promise<{ changes: ReconciliationChange[]; warnings: string[] }> {
  const baseRecon = base.get('reconciliation') ?? new Map<string, BaseRow>();
  const rows = await ctx.db
    .select({
      id: reconciliations.id,
      status: reconciliations.status,
      statementDate: reconciliations.statementDate,
      statementBalance: reconciliations.statementBalance,
      completedAt: reconciliations.completedAt,
      glAccountId: bankAccounts.accountId,
    })
    .from(reconciliations)
    .innerJoin(bankAccounts, eq(bankAccounts.id, reconciliations.bankAccountId))
    .where(eq(bankAccounts.companyId, ctx.companyId));
  const undos: ReconciliationChange[] = [];
  const done: Array<{ at: number; change: ReconciliationChange }> = [];
  const warnings: string[] = [];
  for (const r of rows) {
    const b = baseRecon.get(r.id);
    if (b) {
      if (b.state === 'completed' && r.status === 'undone') {
        undos.push({ op: 'undo', id: r.id, accountId: r.glAccountId, statementDate: iso(r.statementDate), statementBalance: toAmountString(r.statementBalance) });
      } else if (b.state === 'in_progress' && r.status === 'completed') {
        // The client's own unfinished reconciliation, finished here: the client's file still has it
        // open with the client's marks, so it can't be finished from the changes file.
        warnings.push(
          `The reconciliation of the statement ending ${ymd(r.statementDate)} that was already in progress when this copy was made was finished in this copy. It can't be sent back: tell your client which transactions to clear, and they will finish it in their file.`,
        );
      }
      continue;
    }
    if (r.status === 'in_progress') {
      // Started here but not finished: only completed reconciliations travel.
      warnings.push(
        `The reconciliation of the statement ending ${ymd(r.statementDate)} is still in progress in this copy. Finish it before saving the changes file, or its cleared marks (and any service charge or interest it entered) won't be sent to your client.`,
      );
      continue;
    }
    if (r.status !== 'completed') {
      // Abandoned / undone again in the copy: nothing to send, but its statement adjustments are.
      const [adj] = await ctx.db
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, `reconciliation:${r.id}`), eq(journalEntries.status, 'posted')))
        .limit(1);
      if (adj) {
        warnings.push(
          `A reconciliation of the statement ending ${ymd(r.statementDate)} that was undone in this copy added a service charge or interest entry, which can't be sent back on its own. Tell your client about it.`,
        );
      }
      continue;
    }
    const items = await ctx.db
      .select({ lineId: reconciliationItems.journalEntryLineId, sourceRef: journalEntries.sourceRef })
      .from(reconciliationItems)
      .innerJoin(journalEntryLines, eq(journalEntryLines.id, reconciliationItems.journalEntryLineId))
      .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
      .where(and(eq(reconciliationItems.reconciliationId, r.id), eq(reconciliationItems.isCleared, true)))
      .orderBy(asc(journalEntries.date), asc(reconciliationItems.journalEntryLineId));
    const cleared: LineRef[] = [];
    for (const i of items) {
      if (i.sourceRef === `reconciliation:${r.id}`) continue; // the statement's own adjustments (re-made on import)
      cleared.push(await ref(ctx, i.lineId));
    }
    const adjustments = await ctx.db
      .select({ id: journalEntries.id, description: journalEntries.description })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.sourceRef, `reconciliation:${r.id}`), eq(journalEntries.status, 'posted')));
    let serviceCharge: { amount: string; accountId: string } | null = null;
    let interestEarned: { amount: string; accountId: string } | null = null;
    for (const a of adjustments) {
      const lines = await ctx.db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, a.id));
      const other = lines.find((l) => l.accountId !== r.glAccountId);
      const bank = lines.find((l) => l.accountId === r.glAccountId);
      if (!other || !bank) continue;
      const amount = toAmountString(bank.foreignAmount ?? (bank.debit && Number(bank.debit) !== 0 ? bank.debit : bank.credit) ?? 0);
      if (Number(bank.credit ?? 0) > 0) serviceCharge = { amount, accountId: other.accountId };
      else interestEarned = { amount, accountId: other.accountId };
    }
    done.push({
      at: (r.completedAt ?? r.statementDate).getTime(),
      change: {
        op: 'reconcile',
        id: r.id,
        accountId: r.glAccountId,
        statementDate: iso(r.statementDate),
        statementBalance: toAmountString(r.statementBalance),
        cleared,
        serviceCharge,
        interestEarned,
      },
    });
  }
  // Undo newest first (Undo LAST Reconciliation), then the new ones in the order they were done.
  undos.sort((a, b) => b.statementDate.localeCompare(a.statementDate));
  done.sort((a, b) => a.at - b.at);
  return { changes: [...undos, ...done.map((d) => d.change)], warnings };
}

// ---------------------------------------------------------------------------
// Apply (client import)
// ---------------------------------------------------------------------------

export interface ApplyHelpers {
  mapId: (id: string) => string;
  toDate: (iso: string) => Date;
  line: (ref: LineRef) => Promise<string>;
}

export async function applyApplication(tx: ServiceContext, a: ApplicationChange, h: ApplyHelpers): Promise<void> {
  if (a.kind === 'credit_memo') {
    if (a.op === 'apply') {
      await applyToInvoice(tx, { creditMemoId: h.mapId(a.creditMemoId), invoiceId: h.mapId(a.invoiceId), amount: a.amount, date: h.toDate(a.date) });
      return;
    }
    const [row] = await tx.db
      .select()
      .from(creditApplications)
      .where(and(eq(creditApplications.id, a.id), eq(creditApplications.companyId, tx.companyId)));
    if (!row || row.creditMemoId !== a.creditMemoId || row.invoiceId !== a.invoiceId || !Money.of(row.amount).equals(Money.of(a.amount))) {
      throw new ServiceError('CONFLICT', 'That credit is no longer applied to that invoice the same way in your file.');
    }
    await unapplyCreditApplication(tx, a.id);
    return;
  }
  if (a.kind === 'vendor_credit') {
    const input = { vendorCreditId: h.mapId(a.vendorCreditId), billId: h.mapId(a.billId), amount: a.amount, date: h.toDate(a.date) };
    if (a.op === 'apply') await applyToBill(tx, input);
    else await unapplyFromBill(tx, input);
    return;
  }
  if (a.op === 'unapply') {
    const [row] = await tx.db
      .select({ id: journalItemApplications.id })
      .from(journalItemApplications)
      .where(and(eq(journalItemApplications.id, a.id), eq(journalItemApplications.companyId, tx.companyId)));
    if (!row) throw new ServiceError('CONFLICT', 'That journal entry credit is no longer applied in your file.');
    await unapplyJournalApplication(tx, a.id);
    return;
  }
  await applyJournalCredit(tx, {
    journalLineId: await h.line(a.line),
    invoiceId: a.invoiceId ? h.mapId(a.invoiceId) : null,
    billId: a.billId ? h.mapId(a.billId) : null,
    chargeLineId: a.chargeLine ? await h.line(a.chargeLine) : null,
    amount: a.amount,
    date: h.toDate(a.date),
  });
}

async function bankAccountFor(tx: ServiceContext, glAccountId: string): Promise<string> {
  const [ba] = await tx.db
    .select({ id: bankAccounts.id })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.companyId, tx.companyId), eq(bankAccounts.accountId, glAccountId)));
  if (!ba) throw new ServiceError('NOT_FOUND', 'That account is not set up for reconciling in your file.');
  return ba.id;
}

export async function applyReconciliation(tx: ServiceContext, r: ReconciliationChange, h: ApplyHelpers): Promise<void> {
  const bankAccountId = await bankAccountFor(tx, h.mapId(r.accountId));
  if (r.op === 'undo') {
    const [latest] = await tx.db
      .select({ id: reconciliations.id })
      .from(reconciliations)
      .where(and(eq(reconciliations.bankAccountId, bankAccountId), eq(reconciliations.status, 'completed')))
      .orderBy(sql`${reconciliations.completedAt} DESC`)
      .limit(1);
    if (!latest || latest.id !== r.id) {
      throw new ServiceError('CONFLICT', 'It is no longer the last reconciliation of that account in your file.');
    }
    await undoLastReconciliation(tx, bankAccountId);
    return;
  }
  const recon = await startReconciliation(tx, { bankAccountId, statementDate: h.toDate(r.statementDate), statementBalance: r.statementBalance });
  for (const c of r.cleared) {
    await toggleCleared(tx, recon.id, await h.line(c), true);
  }
  if (r.serviceCharge || r.interestEarned) {
    await addStatementAdjustments(tx, recon.id, {
      serviceCharge: r.serviceCharge ? { amount: r.serviceCharge.amount, accountId: h.mapId(r.serviceCharge.accountId) } : null,
      interestEarned: r.interestEarned ? { amount: r.interestEarned.amount, accountId: h.mapId(r.interestEarned.accountId) } : null,
    });
  }
  await completeReconciliation(tx, recon.id);
}

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

const money = (v: string | number) => formatCurrency(String(v));

function lineText(L: Labels, r: LineRef): string {
  const side = r.debit ? `${money(r.debit)} in` : `${money(r.credit ?? '0')} out`;
  return `${ymd(r.date)} — ${L.account(r.accountId)} ${side}${r.entityId ? ` (${L.name(r.entityId)})` : ''}`;
}

export function describeApplication(a: ApplicationChange, L: Labels): { title: string; lines: string[] } {
  if (a.kind === 'credit_memo') {
    return a.op === 'apply'
      ? { title: `Apply ${L.doc(a.creditMemoId)} to ${L.doc(a.invoiceId)}`, lines: [`${money(a.amount)} of the credit applied, ${ymd(a.date)}`] }
      : { title: `Take ${L.doc(a.creditMemoId)} off ${L.doc(a.invoiceId)}`, lines: [`${money(a.amount)} goes back to the credit memo`] };
  }
  if (a.kind === 'vendor_credit') {
    return a.op === 'apply'
      ? { title: `Apply ${L.doc(a.vendorCreditId)} to ${L.doc(a.billId)}`, lines: [`${money(a.amount)} of the credit applied`] }
      : { title: `Take ${L.doc(a.vendorCreditId)} off ${L.doc(a.billId)}`, lines: [`${money(a.amount)} goes back to the vendor credit`] };
  }
  if (a.op === 'unapply') {
    return { title: 'Remove a journal entry credit application', lines: [`${money(a.amount)} applied on ${ymd(a.date)} is removed`] };
  }
  const target = a.invoiceId ? L.doc(a.invoiceId) : a.billId ? L.doc(a.billId) : 'a journal entry charge';
  return {
    title: `Apply a journal entry credit to ${target}`,
    lines: [`Credit: ${lineText(L, a.line)}`, ...(a.chargeLine ? [`Charge: ${lineText(L, a.chargeLine)}`] : []), `${money(a.amount)} applied, ${ymd(a.date)}`],
  };
}

export function describeReconciliation(r: ReconciliationChange, L: Labels): { title: string; lines: string[] } {
  if (r.op === 'undo') {
    return {
      title: `Undo the reconciliation of ${L.account(r.accountId)} for the statement ending ${ymd(r.statementDate)}`,
      lines: [`Statement balance ${money(r.statementBalance)}: its transactions become uncleared again`],
    };
  }
  return {
    title: `Reconcile ${L.account(r.accountId)}, statement ending ${ymd(r.statementDate)}`,
    lines: [
      `Ending balance ${money(r.statementBalance)}; ${r.cleared.length} transaction(s) cleared`,
      ...r.cleared.map((c) => lineText(L, c)),
      ...(r.serviceCharge ? [`Service charge ${money(r.serviceCharge.amount)} to ${L.account(r.serviceCharge.accountId)}`] : []),
      ...(r.interestEarned ? [`Interest earned ${money(r.interestEarned.amount)} to ${L.account(r.interestEarned.accountId)}`] : []),
    ],
  };
}

/** Ids of the client's records an application change names (for the dividing-date check). */
export function applicationTargets(a: ApplicationChange): Array<{ type: 'invoice' | 'bill' | 'credit_memo' | 'vendor_credit'; id: string }> {
  if (a.kind === 'credit_memo') return [{ type: 'credit_memo', id: a.creditMemoId }, { type: 'invoice', id: a.invoiceId }];
  if (a.kind === 'vendor_credit') return [{ type: 'vendor_credit', id: a.vendorCreditId }, { type: 'bill', id: a.billId }];
  if (a.op === 'unapply') return [];
  return [
    ...(a.invoiceId ? [{ type: 'invoice' as const, id: a.invoiceId }] : []),
    ...(a.billId ? [{ type: 'bill' as const, id: a.billId }] : []),
  ];
}

