/**
 * Posting engine — the single, validated path that turns business events into balanced
 * double-entry journal entries. Invoices, bills, payments, deposits, payroll, etc. all post
 * through `postJournalEntry`. This is the one place that validates debits == credits up front.
 *
 * Defence in depth (drizzle/0017_team_ledger.sql): the DATABASE independently enforces the same
 * invariants, so no code path can leave the books out of balance:
 *  - a deferred constraint trigger rejects, at COMMIT, any posted entry that is unbalanced, has
 *    fewer than two lines, or has a malformed line;
 *  - `accounts.balance` is maintained ONLY by triggers from posted journal lines and entry status
 *    transitions (this module no longer applies balance deltas itself), and direct writes of it
 *    are refused unless they equal the ledger-derived value;
 *  - lines of posted/void entries are immutable except inside a sanctioned rewrite
 *    (`allowLedgerRewrite`, used only by condense, account merge and company restore).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { MAX_LEDGER_AMOUNT, Money, MoneyParseError, toAmountString } from '@/lib/money';
import {
  accounts,
  auditLogs,
  creditMemos,
  journalEntries,
  journalEntryLines,
  paymentsReceived,
  reconciliationItems,
  reconciliations,
} from '@/lib/db/schema';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { assertPeriodOpen, recordClosingDateException } from './fiscalPeriods';
import { foreignLineColumns } from './fxLines';

export interface PostingLine {
  accountId: string;
  /** Provide exactly one of debit/credit (the other 0/empty). */
  debit?: string | number | null;
  credit?: string | number | null;
  memo?: string | null;
  /** Optional class/department dimension for class-based reporting. */
  classId?: string | null;
  /**
   * QB "Name" column: the customer / vendor / employee / other name this line is for.
   * Required by manual journal entries on A/R (customer) and A/P (vendor) lines — see
   * journal.ts assertJournalNames. Both fields are set together or not at all.
   */
  entityType?: JournalEntityType | null;
  entityId?: string | null;
  /**
   * Marks THIS line as the source document's own A/R / A/P line (an invoice's A/R charge, a
   * payment's A/R relief, a bill's A/P line, ...). Only document services set it, and only on
   * the line they build from the document's own A/R / A/P account — never on a line whose account
   * the user picked (item, expense, discount, "Deposit to" / "Pay from"). Not stored; read only by
   * assertControlAccountNames (QB invariant I11).
   */
  controlLine?: boolean;
  /**
   * p1 fx: this line's amount in its account's currency (foreign-currency bank / credit-card
   * accounts). Omitted = converted from the home amount (fxLines.ts). 0 = home-only revaluation.
   */
  foreignAmount?: string | number | null;
}

export type JournalEntityType = 'customer' | 'vendor' | 'employee' | 'other';
export const JOURNAL_ENTITY_TYPES: readonly JournalEntityType[] = ['customer', 'vendor', 'employee', 'other'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PostJournalEntryInput {
  date: Date;
  description: string;
  reference?: string | null;
  /** 'posted' affects balances; 'draft' does not. Defaults to 'posted'. */
  status?: 'draft' | 'posted';
  lines: PostingLine[];
  /** Optional: link source document for traceability (e.g. "invoice:<id>"). */
  sourceRef?: string;
  /** QB "Adjusting Entry" flag (shown on the Adjusting Journal Entries report). */
  isAdjusting?: boolean;
  /**
   * Opt out of the A/R / A/P name check (assertControlAccountNames). Test fixtures and internal
   * repair tools only — never set it from a user-facing window.
   */
  allowUnnamedControl?: boolean;
  /** p1 fx: the transaction's currency + home units per 1 unit (see fxLines.ts). */
  currency?: string | null;
  exchangeRate?: string | number | { toString(): string } | null;
}

const DEBIT_NORMAL = new Set(['asset', 'expense']);

/** Signed change to an account's natural balance for a single line. */
export function balanceDelta(
  accountType: string,
  debit: string | number | null | undefined,
  credit: string | number | null | undefined,
) {
  const d = Money.of(debit);
  const c = Money.of(credit);
  return DEBIT_NORMAL.has(accountType) ? d.minus(c) : c.minus(d);
}

/** Validate that lines are well-formed and balanced. Throws ServiceError on failure. */
export function assertBalanced(lines: PostingLine[]): { totalDebit: string; totalCredit: string } {
  if (!lines || lines.length < 2) {
    throw validation('A journal entry needs at least two lines.');
  }
  let totalDebit = Money.zero();
  let totalCredit = Money.zero();
  for (const [i, line] of lines.entries()) {
    // Round each line to 2dp BEFORE summing — this is exactly how lines are persisted,
    // so the balance check matches the stored ledger rather than the raw inputs.
    let d: ReturnType<typeof Money.round2>;
    let c: ReturnType<typeof Money.round2>;
    try {
      d = Money.round2(line.debit);
      c = Money.round2(line.credit);
    } catch (err) {
      if (err instanceof MoneyParseError) throw validation(`Line ${i + 1}: ${err.message}`);
      throw err;
    }
    if (!d.isFinite() || !c.isFinite()) {
      throw validation(`Line ${i + 1}: the amount is not a number.`);
    }
    if (d.abs().greaterThan(MAX_LEDGER_AMOUNT) || c.abs().greaterThan(MAX_LEDGER_AMOUNT)) {
      throw validation(`Line ${i + 1}: the amount is too large for the ledger (max ${MAX_LEDGER_AMOUNT.toFixed(2)}).`);
    }
    if (d.isNegative() || c.isNegative()) {
      throw validation(`Line ${i + 1}: debit/credit cannot be negative.`);
    }
    if (d.greaterThan(0) && c.greaterThan(0)) {
      throw validation(`Line ${i + 1}: a line cannot have both a debit and a credit.`);
    }
    if (d.isZero() && c.isZero()) {
      throw validation(`Line ${i + 1}: a line must have a debit or a credit.`);
    }
    totalDebit = totalDebit.plus(d);
    totalCredit = totalCredit.plus(c);
  }
  // Exact equality of the 2dp totals (no sub-cent tolerance) — a rounded entry that does
  // not net to zero must never persist. Callers must pre-allocate pennies (see money.allocate).
  if (!Money.eq(totalDebit, totalCredit)) {
    throw new ServiceError(
      'UNBALANCED',
      `Entry is out of balance: debits ${toAmountString(totalDebit)} ≠ credits ${toAmountString(
        totalCredit,
      )}.`,
      { totalDebit: toAmountString(totalDebit), totalCredit: toAmountString(totalCredit) },
    );
  }
  return { totalDebit: toAmountString(totalDebit), totalCredit: toAmountString(totalCredit) };
}

async function nextEntryNumber(ctx: ServiceContext): Promise<number> {
  const [row] = await ctx.db
    .select({ max: sql<number>`COALESCE(MAX(${journalEntries.entryNumber}), 0)` })
    .from(journalEntries)
    .where(eq(journalEntries.companyId, ctx.companyId));
  return (row?.max ?? 0) + 1;
}

/**
 * Source documents whose own A/R / A/P line is counted by the aging subledger (the document
 * itself carries the customer / vendor), plus historical imports. Named A/R / A/P lines posted by
 * anything else (manual journal entries, checks, deposits, bank-feed lines, reversals, ...) are
 * General Journal open items in aging (journal.ts journalOpenItems) — see QB invariant I11.
 */
const SUBLEDGER_SOURCE_RE =
  /^(invoice|credit_memo|refund|payment|customer|bill|vendor|vendor_credit|salesreceipt|condense|iif|qbgl):/;

export function isSubledgerSource(sourceRef: string | null | undefined): boolean {
  return Boolean(sourceRef && SUBLEDGER_SOURCE_RE.test(sourceRef));
}

/**
 * SQL test (on journal_entries.source_ref) for postings whose named A/R / A/P lines are open
 * items in A/R / A/P aging: everything that is not a customer/vendor document or an import.
 */
export const generalJournalSourceSql = () =>
  sql`(${journalEntries.sourceRef} IS NULL OR ${journalEntries.sourceRef} !~ ${SUBLEDGER_SOURCE_RE.source})`;

/**
 * Which control account a document's own line is on. 'ar' documents may carry their own
 * (unnamed) A/R line, 'ap' documents their own A/P line, 'either' one of the two (refunds of a
 * credit memo / payment / vendor credit), 'none' neither (a Sales Receipt never touches A/R or
 * A/P in QB). Imports are not checked line by line (they are reconciled on import).
 */
const DOCUMENT_SIDE: Record<string, 'ar' | 'ap' | 'either' | 'none' | 'import'> = {
  invoice: 'ar',
  credit_memo: 'ar',
  payment: 'ar',
  customer: 'ar',
  // wave2 sales: Record Bounced Check re-charges A/R on the payment's own (unnamed) control line —
  // the reopened invoices are the subledger items, so it must not be a named GJ line.
  bounced: 'ar',
  bill: 'ap',
  vendor: 'ap',
  vendor_credit: 'ap',
  refund: 'either',
  salesreceipt: 'none',
  condense: 'import',
  iif: 'import',
  qbgl: 'import',
  // wave2 payroll/QB migration (openItemsImport.ts): the conversion offset that moves an
  // already-imported GL control balance onto the open documents — an import artifact, unnamed
  // by design (the documents carry the per-name detail).
  'qbopen-offset': 'import',
};

function documentSide(sourceRef: string | null | undefined) {
  if (!sourceRef) return undefined;
  const i = sourceRef.indexOf(':');
  return i > 0 ? DOCUMENT_SIDE[sourceRef.slice(0, i)] : undefined;
}

type ControlSide = 'ar' | 'ap';
function controlSideOf(acct: { type: string; subtype: string | null }): ControlSide | null {
  if (acct.type === 'asset' && acct.subtype === 'accounts_receivable') return 'ar';
  if (acct.type === 'liability' && acct.subtype === 'accounts_payable') return 'ap';
  return null;
}

const SIDE_LABEL: Record<ControlSide, string> = { ar: 'Accounts Receivable', ap: 'Accounts Payable' };

/**
 * QB lists only bank, Undeposited Funds and other cash-like accounts in "Deposit to" / "Pay
 * from". Refuse A/R and A/P there up front with a plain-language message (the posting guard
 * below refuses them too).
 */
export function assertNotControlAccount(
  acct: { type: string; subtype: string | null; name?: string | null },
  role: string,
): void {
  const side = controlSideOf(acct);
  if (side) {
    throw validation(
      `${acct.name ? `"${acct.name}" is an ${SIDE_LABEL[side]} account. ` : ''}${SIDE_LABEL[side]} can't be used as the "${role}" account. Pick a bank account or Undeposited Funds.`,
    );
  }
}

/**
 * QB never lists Accounts Receivable / Accounts Payable as an item's account or as a form line's
 * account (income, discount, expense lines). Refuse them up front with a plain-language message
 * (the posting guard below refuses an unmarked A/R / A/P line on a document too). `where` names
 * the place, e.g. "Line 2" or "the item's income account".
 */
export function assertNotControlLineAccount(
  acct: { type: string; subtype: string | null; name?: string | null },
  where: string,
): void {
  const side = controlSideOf(acct);
  if (side) {
    throw validation(
      `${where}: ${acct.name ? `"${acct.name}" is an ${SIDE_LABEL[side]} account. ` : ''}${SIDE_LABEL[side]} can't be used as an item or line account. Pick an income, expense or other account instead.`,
    );
  }
}

/**
 * QB invariant I11 (A/R aging == A/R balance, A/P aging == A/P balance), checked line by line on
 * every posting — the single choke point for every window, current and future:
 *  - A customer/vendor document may carry its OWN control line unnamed (the document is the
 *    subledger item): an invoice / credit memo / customer payment its A/R line, a bill / bill
 *    payment / vendor credit its A/P line, a refund the one control line of the document it
 *    refunds. The document service marks that line `controlLine: true`; every unmarked A/R / A/P
 *    line on a document is refused. Marked lines must be a single direction (an invoice only charges A/R, a payment only
 *    relieves it), so a "Deposit to" or "Pay from" or item/expense line on the same control
 *    account is refused. Any OTHER control line on a document (an A/P line on a customer form,
 *    an A/R line on a bill, any control line on a Sales Receipt) is refused, as in QB.
 *  - Every other posting (manual journal entries, checks, deposits, bank-feed lines, reversals,
 *    account opening balances, FX adjustments, postings with no source at all, ...) must name the
 *    customer on each A/R line and the vendor on each A/P line; aging shows those lines as
 *    General Journal items for that name.
 * `allowUnnamedControl` is an explicit opt-out for tests and internal repair tools only.
 */
export function assertControlAccountNames(
  input: Pick<PostJournalEntryInput, 'lines' | 'sourceRef' | 'allowUnnamedControl'>,
  accountRows: ReadonlyArray<{ id: string; type: string; subtype: string | null; name: string }>,
): void {
  if (input.allowUnnamedControl) return;
  const docSide = documentSide(input.sourceRef);
  if (docSide === 'import') return;
  const byId = new Map(accountRows.map((a) => [a.id, a]));

  if (docSide === undefined) {
    for (const l of input.lines) {
      const acct = byId.get(l.accountId);
      if (!acct) continue;
      const side = controlSideOf(acct);
      if (side === 'ar' && l.entityType !== 'customer') {
        throw validation(
          `"${acct.name}" is an Accounts Receivable account. Amounts can only go there with a customer name — use an invoice, a payment, a credit memo or a journal entry that names the customer.`,
        );
      }
      if (side === 'ap' && l.entityType !== 'vendor') {
        throw validation(
          `"${acct.name}" is an Accounts Payable account. Amounts can only go there with a vendor name — use a bill, a bill payment, a vendor credit or a journal entry that names the vendor.`,
        );
      }
    }
    return;
  }

  let ownSide: ControlSide | null = docSide === 'either' ? null : docSide === 'none' ? null : docSide;
  let direction: 'debit' | 'credit' | null = null;
  for (const l of input.lines) {
    const acct = byId.get(l.accountId);
    if (!acct) continue;
    const side = controlSideOf(acct);
    if (!side) continue;
    // Only the document's own, explicitly marked control line may sit on A/R / A/P. Any other
    // line on a control account (an item, discount, expense, "Deposit to" or "Pay from" line the
    // user pointed at A/R or A/P) is refused, whatever its direction.
    if (!l.controlLine) {
      throw validation(
        `"${acct.name}" is an ${SIDE_LABEL[side]} account and can't be used on this form as a "Deposit to", "Pay from", discount or line account. Pick a bank, Undeposited Funds, income or expense account instead.`,
      );
    }
    if (docSide === 'either' && ownSide === null) ownSide = side;
    if (side !== ownSide) {
      throw validation(
        `"${acct.name}" is an ${SIDE_LABEL[side]} account and can't be used on this form. Pick a bank, Undeposited Funds, income or expense account instead.`,
      );
    }
    const dir = l.debit != null && Money.gt(l.debit, 0) ? 'debit' : 'credit';
    if (direction && dir !== direction) {
      throw validation(
        `"${acct.name}" is this form's ${SIDE_LABEL[side]} account, so it can't also be the "Deposit to", "Pay from" or a line account. Pick a bank, Undeposited Funds, income or expense account instead.`,
      );
    }
    direction = dir;
  }
}

/** Create a balanced journal entry. If posted, the DB trigger updates cached account balances. */
export async function postJournalEntry(ctx: ServiceContext, input: PostJournalEntryInput) {
  assertBalanced(input.lines);
  const periodCheck = await assertPeriodOpen(ctx, input.date); // refuse to post into a closed period
  const status = input.status ?? 'posted';

  // Verify every referenced account belongs to this company and load its type.
  const accountIds = [...new Set(input.lines.map((l) => l.accountId))];
  const accountRows = await ctx.db
    .select({
      id: accounts.id,
      type: accounts.type,
      subtype: accounts.subtype,
      name: accounts.name,
      currency: accounts.currency,
    })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), inArray(accounts.id, accountIds)));
  const typeById = new Map(accountRows.map((a) => [a.id, a.type]));
  for (const id of accountIds) {
    if (!typeById.has(id)) throw notFound(`Account ${id}`);
  }
  // Non-posting accounts (estimates, purchase orders) never carry amounts. The database refuses
  // it too (0025 bka_jel_non_posting); this gives a friendly message up front.
  if (status === 'posted') {
    const np = accountRows.find((a) => a.subtype === 'non_posting');
    if (np) {
      throw validation(
        `"${np.name}" is a non-posting account (used for estimates and purchase orders) and cannot be used in a transaction.`,
      );
    }
  }
  for (const [i, l] of input.lines.entries()) {
    if (Boolean(l.entityType) !== Boolean(l.entityId)) {
      throw validation(`Line ${i + 1}: a name needs both its kind and its id.`);
    }
    if (l.entityType && !JOURNAL_ENTITY_TYPES.includes(l.entityType)) {
      throw validation(`Line ${i + 1}: unknown name kind "${l.entityType}".`);
    }
    if (l.entityId && !UUID_RE.test(l.entityId)) {
      throw validation(`Line ${i + 1}: that name was not found.`);
    }
  }

  assertControlAccountNames(input, accountRows);
  const fxColumns = await foreignLineColumns(
    ctx,
    {
      lines: input.lines,
      currency: input.currency ?? null,
      exchangeRate: input.exchangeRate == null ? null : String(input.exchangeRate),
    },
    new Map(accountRows.map((a) => [a.id, a.currency ?? null])),
  );

  return inTransaction(ctx, async (tx) => {
    const entryNumber = await nextEntryNumber(tx);
    const [entry] = await tx.db
      .insert(journalEntries)
      .values({
        companyId: tx.companyId,
        entryNumber,
        date: input.date,
        description: input.description,
        reference: input.reference ?? null,
        status,
        sourceRef: input.sourceRef ?? null,
        isAdjusting: input.isAdjusting ?? false,
        createdBy: tx.userId ?? '00000000-0000-0000-0000-000000000000',
      })
      .returning();

    // Canonical 2dp line values. accounts.balance is updated by the database trigger from
    // exactly these stored rows (no TypeScript-side delta, so nothing can be applied twice).
    const normalizedLines = input.lines.map((l, i) => ({
      accountId: l.accountId,
      debit: l.debit != null && Money.gt(l.debit, 0) ? toAmountString(l.debit) : null,
      credit: l.credit != null && Money.gt(l.credit, 0) ? toAmountString(l.credit) : null,
      memo: l.memo ?? null,
      classId: l.classId ?? null,
      entityType: l.entityType ?? null,
      entityId: l.entityType ? (l.entityId ?? null) : null,
      ...fxColumns[i],
    }));

    await tx.db.insert(journalEntryLines).values(
      normalizedLines.map((l) => ({ journalEntryId: entry.id, ...l })),
    );

    await writeAudit(tx, {
      action: 'create',
      entityType: 'journal_entry',
      entityId: entry.id,
      newValues: {
        entryNumber,
        description: input.description,
        lines: input.lines,
        ...(input.isAdjusting ? { isAdjusting: true } : {}),
      },
    });
    // Closing-date password override used → Closing Date Exception report (no-op otherwise).
    await recordClosingDateException(tx, periodCheck, {
      entryId: entry.id,
      operation: 'post',
      transactionDate: input.date,
      entryNumber,
      description: input.description,
      sourceRef: input.sourceRef ?? null,
    });

    return entry;
  });
}

/**
 * A customer refund (credit-memo refund or overpayment refund, sourceRef `refund:<id>`) that is
 * voided gives the customer their credit back: the memo's unapplied balance goes up and its
 * refunded amount down, or the payment's unapplied balance goes up. Without this the A/R GL
 * (where the void reverses the refund) and the open-credit subledger (aging, integrity check)
 * would disagree. The amount is the refund's own A/R debit (home currency); a foreign-currency
 * payment converts it back at the payment's rate. Vendor-credit refunds (A/P) are not touched.
 */
async function restoreRefundedCustomerCredit(
  tx: ServiceContext,
  docId: string,
  entryId: string,
  refundDate: Date,
  lines: Array<{ accountId: string; debit: string | null; credit: string | null }>,
) {
  // The refund posts Dr A/R / Cr bank: the A/R debit equals the bank credit, i.e. the entry total.
  const base = Money.round2(lines.reduce((s, l) => s.plus(Money.of(l.debit ?? '0')), Money.zero()));
  if (!base.greaterThan(0)) return;

  const [memo] = await tx.db
    .select()
    .from(creditMemos)
    .where(and(eq(creditMemos.companyId, tx.companyId), eq(creditMemos.id, docId)));
  if (memo) {
    const unapplied = Money.round2(Money.of(memo.unapplied).plus(base));
    const refunded = Money.round2(Money.of(memo.refundedAmount).minus(base));
    const status = memo.status === 'void' ? memo.status : 'open';
    await tx.db
      .update(creditMemos)
      .set({
        unapplied: toAmountString(unapplied),
        refundedAmount: toAmountString(refunded.lessThan(0) ? Money.zero() : refunded),
        status: status as never,
      })
      .where(eq(creditMemos.id, memo.id));
    await writeAudit(tx, {
      action: 'update',
      entityType: 'credit_memo',
      entityId: memo.id,
      oldValues: { unapplied: memo.unapplied, refundedAmount: memo.refundedAmount, status: memo.status },
      newValues: { action: 'refund_voided', unapplied: toAmountString(unapplied), status },
    });
    return;
  }

  const [payment] = await tx.db
    .select()
    .from(paymentsReceived)
    .where(and(eq(paymentsReceived.companyId, tx.companyId), eq(paymentsReceived.id, docId)));
  if (payment) {
    // The exact refunded amount (payment currency) is on the refund's audit row; converting the
    // base amount back can be a cent off at some exchange rates, so that is only the fallback.
    const rate = Money.of(payment.exchangeRate ?? 1);
    const [refundAudit] = await tx.db
      .select({ newValues: auditLogs.newValues })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, tx.companyId),
          eq(auditLogs.entityType, 'payment_received'),
          eq(auditLogs.entityId, payment.id),
          sql`${auditLogs.newValues}->>'action' = 'refund'`,
          sql`${auditLogs.newValues}->>'postedEntryId' = ${entryId}`,
        ),
      )
      .limit(1);
    const recorded = (refundAudit?.newValues as { amount?: string } | null)?.amount;
    const amount = recorded
      ? Money.round2(Money.of(recorded))
      : rate.greaterThan(0) && !rate.equals(1)
        ? Money.round2(Money.div(base, rate))
        : base;
    const unapplied = Money.round2(Money.of(payment.unapplied).plus(amount));
    await tx.db
      .update(paymentsReceived)
      .set({ unapplied: toAmountString(unapplied) })
      .where(eq(paymentsReceived.id, payment.id));
    // p1 fx: a refund relieved A/R by the change in the credit's home value at the time
    // (homeAt(unapplied before) - homeAt(unapplied after)), which depends on the order of refunds,
    // applies and unapplies. The void reverses exactly that posted amount, but the credit's home
    // value now grows by homeAt(unapplied after restore) - homeAt(unapplied before restore). Post
    // the (cent-level) difference to A/R against Exchange Gain/Loss so A/R stays equal to the
    // aging — at every date from the refund's date on, not just today (see postRefundVoidFxPlug).
    // sourceRef `payment:<id>`: voiding the payment voids these plugs with its other FX plugs.
    const arLine = lines.find((l) => l.debit != null && Money.gt(l.debit, 0));
    if (arLine) await postRefundVoidFxPlug(tx, {
      payment: { id: payment.id, postedEntryId: payment.postedEntryId, exchangeRate: payment.exchangeRate },
      arAccountId: arLine.accountId,
      refundDate,
      rate,
      unappliedBefore: Money.of(payment.unapplied),
      unappliedAfter: unapplied,
      reversed: base,
    });
    await writeAudit(tx, {
      action: 'update',
      entityType: 'payment_received',
      entityId: payment.id,
      oldValues: { unapplied: payment.unapplied },
      newValues: { action: 'refund_voided', unapplied: toAmountString(unapplied) },
    });
  }
}

/**
 * p1 fx: Exchange Gain/Loss plug(s) posted when a foreign-currency payment refund is voided (see
 * restoreRefundedCustomerCredit). Every A/R posting of the credit moved A/R by the change in the
 * credit's home value at the time, in the order they were entered. Removing a refund from the
 * middle changes the home value of every later step by a cent here and there, and the voided
 * refund's date is not where that cent belongs: it belongs to the later refund / apply whose
 * home value changed. So, walking the dates from the voided refund's date on (the dates the credit
 * or its A/R changed), the credit's home amount on the ledger (customerCredits.ts
 * paymentCreditLedger) is compared with round2(unapplied as of that date x rate) and the
 * difference is posted ON THAT DATE. A/R then equals the aging as of every date, today included.
 *
 * Safety net: the plugs must add up to the change today, homeAt(after) - homeAt(before) - the
 * reversed A/R. If they do not (a ledger shape this walk does not model, e.g. data from before
 * relief records existed), one plug of exactly that change is posted on the latest date the
 * credit changed instead, which keeps today's A/R equal to the aging as before.
 */
async function postRefundVoidFxPlug(
  tx: ServiceContext,
  p: {
    payment: { id: string; postedEntryId: string | null; exchangeRate: string | null };
    /** The A/R account the refund debited (the void reverses that line). */
    arAccountId: string;
    refundDate: Date;
    rate: ReturnType<typeof Money.of>;
    unappliedBefore: ReturnType<typeof Money.of>;
    unappliedAfter: ReturnType<typeof Money.of>;
    reversed: ReturnType<typeof Money.of>;
  },
) {
  const { paymentCreditEvents, paymentCreditLedger, ledgerCreditAsOf, unappliedAsOf, paymentCreditHome } =
    await import('./customerCredits');
  const homeAt = (v: ReturnType<typeof Money.of>) => paymentCreditHome(v, p.rate);
  const total = Money.round2(homeAt(p.unappliedAfter).minus(homeAt(p.unappliedBefore)).minus(p.reversed));
  if (p.rate.equals(1)) {
    if (!total.isZero()) await postOneRefundVoidPlug(tx, p.payment.id, p.arAccountId, p.refundDate, total);
    return;
  }

  // State after the void (the refund entry is already void, the unapplied credit restored).
  const events = (await paymentCreditEvents(tx, [p.payment])).get(p.payment.id) ?? [];
  const ledger = await paymentCreditLedger(tx, p.payment);
  const from = p.refundDate.getTime();
  const times = [...new Set([from, ...events.map((e) => e.date.getTime()), ...ledger.map((l) => l.date.getTime())])]
    .filter((t) => t >= from)
    .sort((a, b) => a - b);
  const plugs: Array<{ date: Date; amount: ReturnType<typeof Money.of> }> = [];
  for (const t of times) {
    const at = new Date(t);
    const target = homeAt(unappliedAsOf(p.unappliedAfter, events, at));
    const diff = Money.round2(target.minus(ledgerCreditAsOf(ledger, at)));
    if (diff.isZero()) continue;
    plugs.push({ date: at, amount: diff });
    // A plug of +diff credits A/R (the credit grows): arNet -diff from this date on.
    ledger.push({ date: at, arNet: diff.negated() });
  }
  const sum = plugs.reduce((s, x) => s.plus(x.amount), Money.zero());
  if (!Money.round2(sum).equals(total)) {
    if (total.isZero()) return;
    const latest = Math.max(from, ...events.map((e) => e.date.getTime()));
    await postOneRefundVoidPlug(tx, p.payment.id, p.arAccountId, new Date(latest), total);
    return;
  }
  for (const x of plugs) await postOneRefundVoidPlug(tx, p.payment.id, p.arAccountId, x.date, x.amount);
}

/**
 * One refund-void plug: `diff` > 0 needs an extra A/R credit (loss), < 0 an A/R debit (gain).
 */
async function postOneRefundVoidPlug(
  tx: ServiceContext,
  paymentId: string,
  arAccountId: string,
  date: Date,
  diff: ReturnType<typeof Money.of>,
) {
  // Dynamic import: currencies.ts imports this module.
  const { getOrCreateExchangeGainLossAccount } = await import('./currencies');
  const fxAccountId = await getOrCreateExchangeGainLossAccount(tx);
  const amt = toAmountString(Money.abs(diff));
  await postJournalEntry(tx, {
    date,
    description: 'Exchange rounding on voided refund of a foreign-currency payment',
    sourceRef: `payment:${paymentId}`,
    lines: diff.greaterThan(0)
      ? [
          { accountId: fxAccountId, debit: amt, memo: 'Realized exchange loss' },
          { accountId: arAccountId, credit: amt, memo: 'A/R FX adjustment', controlLine: true },
        ]
      : [
          { accountId: arAccountId, debit: amt, memo: 'A/R FX adjustment', controlLine: true },
          { accountId: fxAccountId, credit: amt, memo: 'Realized exchange gain' },
        ],
  });
}

/** Void a posted entry: mark void (the DB trigger reverses its balance impact). */
export async function voidJournalEntry(ctx: ServiceContext, entryId: string) {
  return inTransaction(ctx, async (tx) => {
    const [entry] = await tx.db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.id, entryId), eq(journalEntries.companyId, tx.companyId)));
    if (!entry) throw notFound('Journal entry');
    if (entry.status === 'void') return entry;
    const periodCheck = await assertPeriodOpen(tx, entry.date); // cannot void an entry in a closed period

    const lines = await tx.db
      .select()
      .from(journalEntryLines)
      .where(eq(journalEntryLines.journalEntryId, entryId));

    // Guard: a line that was cleared in a COMPLETED reconciliation must not be voided.
    // The next reconciliation seeds its opening from bankAccounts.lastReconciledBalance,
    // which still includes the line — voiding it would silently corrupt that opening
    // balance with no detection or repair path.
    const lineIds = lines.map((l) => l.id);
    if (lineIds.length > 0) {
      const [reconciled] = await tx.db
        .select({ id: reconciliationItems.id })
        .from(reconciliationItems)
        .innerJoin(
          reconciliations,
          eq(reconciliationItems.reconciliationId, reconciliations.id),
        )
        .where(
          and(
            inArray(reconciliationItems.journalEntryLineId, lineIds),
            eq(reconciliationItems.isCleared, true),
            eq(reconciliations.status, 'completed'),
          ),
        )
        .limit(1);
      if (reconciled) {
        throw new ServiceError(
          'CONFLICT',
          'This entry contains lines cleared in a completed bank reconciliation and cannot be voided. Undo the reconciliation first.',
        );
      }
    }

    // Flipping the status to 'void' reverses the entry's balance impact via the database
    // trigger (bka_je_sync_balances) — no TypeScript balance arithmetic here.
    const [updated] = await tx.db
      .update(journalEntries)
      .set({ status: 'void', voidedAt: new Date(), updatedAt: new Date() })
      .where(eq(journalEntries.id, entryId))
      .returning();

    await writeAudit(tx, {
      action: 'void',
      entityType: 'journal_entry',
      entityId: entryId,
      oldValues: { status: entry.status },
      newValues: { status: 'void' },
    });
    if (entry.sourceRef?.startsWith('refund:')) {
      await restoreRefundedCustomerCredit(tx, entry.sourceRef.slice('refund:'.length), entryId, entry.date, lines);
    }
    await recordClosingDateException(tx, periodCheck, {
      entryId,
      operation: 'void',
      transactionDate: entry.date,
      entryNumber: entry.entryNumber,
      description: entry.description,
      sourceRef: entry.sourceRef,
    });
    return updated;
  });
}

/**
 * Sanctioned ledger rewrite. Sets the transaction-local flag `bka.allow_ledger_rewrite` that
 * lets the current transaction delete / re-point / back-fill lines of posted entries (see the
 * immutability guards in drizzle/0017_team_ledger.sql). The deferred balance check still runs
 * at COMMIT for every entry whose header or lines the rewrite touched, so a rewrite can never
 * leave an unbalanced entry behind. It does NOT exempt moving an account with journal lines to
 * another company (that is refused unconditionally, since it touches no entry).
 *
 * WHITELIST — only these flows may call it: condense (summarize closed history), account merge
 * (re-point lines between same-type accounts), company restore (re-insert a backup's ledger) and
 * Reclassify Transactions (lib/services/accountant/reclassify.ts: re-point selected posted lines
 * to another account, each change audited; debits/credits are never altered).
 * Must be called inside a transaction (`SET LOCAL` semantics: it ends with the transaction).
 */
export async function allowLedgerRewrite(
  ctx: Pick<ServiceContext, 'db'>,
  reason: 'condense' | 'merge' | 'restore' | 'reclassify',
): Promise<void> {
  await ctx.db.execute(
    // The txid binds the flag to THIS transaction: the guards ignore it anywhere else, even if a
    // session-level set_config were left behind.
    sql`SELECT set_config('bka.allow_ledger_rewrite', 'on', true),
               set_config('bka.ledger_rewrite_txid', txid_current()::text, true),
               set_config('bka.ledger_rewrite_reason', ${reason}, true)`,
  );
}

/**
 * `allowLedgerRewrite` for code that runs on the raw PGlite transaction instead of Drizzle
 * (the portable .bkp restore loads tables with raw SQL). Same flag, same txid binding, same
 * whitelist of reasons — 'restore' here means "re-insert a backup's ledger verbatim".
 */
export async function allowLedgerRewriteRaw(
  q: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  reason: 'condense' | 'merge' | 'restore',
): Promise<void> {
  await q.query(
    `SELECT set_config('bka.allow_ledger_rewrite', 'on', true),
            set_config('bka.ledger_rewrite_txid', txid_current()::text, true),
            set_config('bka.ledger_rewrite_reason', $1, true)`,
    [reason],
  );
}
