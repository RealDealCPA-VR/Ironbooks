/**
 * Transfers service — move money between two accounts.
 *
 * A transfer from account A to account B posts a balanced journal entry:
 *   Dr  toAccount    amount   (money arrives here)
 *   Cr  fromAccount  amount   (money leaves here)
 *
 * For asset accounts (debit-normal) this means:
 *   - toAccount balance increases  (debit increases asset)
 *   - fromAccount balance decreases (credit decreases asset)
 *
 * The posted entry id is stored on the transfer row for full GL traceability.
 *
 * wave2 D1: updateTransfer edits a saved transfer (memo-only edits keep the entry, so they work on
 * reconciled transfers; anything else is void + repost in one transaction) and voidTransfer
 * reverses it.
 *
 * p1 fx — foreign-currency accounts (QB Enterprise multicurrency):
 *  - `amount` is in the FROM account's currency. Both GL lines carry ONE home amount, so the
 *    entry always balances; each line also carries its own account-currency amount.
 *  - Same currency on both sides (or both home): the to-amount equals the amount; the home
 *    amount is amount x rate (stated `exchangeRate`, else the currency list's rate).
 *  - Different currencies: the user states how much arrived (`toAmount`) or the cross rate
 *    (`exchangeRate` = to-units per 1 from-unit). The home amount is the home side's own amount
 *    when one side is in home currency, else amount x the from-currency's list rate;
 *    `homeAmount` overrides it.
 */
import { and, desc, eq } from 'drizzle-orm';
import { accounts, transfers } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { postJournalEntry, voidJournalEntry, type PostingLine } from './posting';
import { planPostedEdit, retitleEntry } from './postedEdit';
import { currencyRate, foreignCode, homeCode, parseRate, toHome } from './exchangeRates';
import Decimal from 'decimal.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateTransferInput {
  date: Date;
  fromAccountId: string;
  toAccountId: string;
  /** Decimal string or number — must be > 0. In the FROM account's currency. */
  amount: string | number;
  memo?: string | null;
  /**
   * p1 fx. Same-currency foreign transfer: home units per 1 unit (default: list rate).
   * Cross-currency transfer: units of the TO currency per 1 unit of the FROM currency.
   */
  exchangeRate?: string | number | null;
  /** p1 fx: amount that arrived in the TO account, in its currency (cross-currency transfers). */
  toAmount?: string | number | null;
  /** p1 fx: home-currency value of the transfer (overrides the computed one). */
  homeAmount?: string | number | null;
}

/** p1 fx: currencies + amounts of a transfer, all resolved. */
interface TransferFx {
  fromCurrency: string | null;
  toCurrency: string | null;
  /** FROM-currency amount. */
  amount: string;
  /** TO-currency amount. */
  toAmount: string;
  /** Home amount both GL lines carry. */
  home: string;
  /** Stored rate: home per FROM unit (null for a home-to-home transfer). */
  rate: string | null;
}

function validateTransfer(input: CreateTransferInput): string {
  if (input.fromAccountId === input.toAccountId) {
    throw validation('From account and to account must be different.');
  }
  const amount = Money.of(input.amount);
  if (!amount.greaterThan(0)) {
    throw validation('Transfer amount must be greater than zero.');
  }
  return toAmountString(amount);
}

function transferLines(input: CreateTransferInput, fx: TransferFx): PostingLine[] {
  return [
    {
      accountId: input.toAccountId,
      debit: fx.home,
      memo: input.memo ?? null,
      ...(fx.toCurrency ? { foreignAmount: fx.toAmount } : {}),
    },
    {
      accountId: input.fromAccountId,
      credit: fx.home,
      memo: input.memo ?? null,
      ...(fx.fromCurrency ? { foreignAmount: fx.amount } : {}),
    },
  ];
}

async function currencyOfAccount(ctx: ServiceContext, id: string, home: string | null) {
  const [row] = await ctx.db
    .select({ currency: accounts.currency })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, id)));
  return foreignCode(row?.currency ?? null, home);
}

/** Parse an optional stated home amount (> 0). A money amount, not a rate: no rate ceiling. */
function parseHomeAmount(v: string | number | null | undefined): Decimal | null {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  let r: Decimal;
  try {
    r = Money.of(v);
  } catch {
    throw validation('Home amount is not a number.');
  }
  if (!r.isFinite() || !r.greaterThan(0)) throw validation('Home amount must be greater than zero.');
  if (r.greaterThan('9999999999999.99')) throw validation('Home amount is too large.');
  return Money.round2(r);
}

/** Resolve currencies and the home / to amounts of a transfer (see the header). */
async function resolveTransferFx(ctx: ServiceContext, input: CreateTransferInput, amountStr: string): Promise<TransferFx> {
  const home = await homeCode(ctx);
  const fromCurrency = await currencyOfAccount(ctx, input.fromAccountId, home);
  const toCurrency = await currencyOfAccount(ctx, input.toAccountId, home);
  const amount = Money.of(amountStr);
  const homeOverride = parseHomeAmount(input.homeAmount);
  const homeLabel = home ?? 'home currency';

  if (!fromCurrency && !toCurrency) {
    return { fromCurrency, toCurrency, amount: amountStr, toAmount: amountStr, home: amountStr, rate: null };
  }

  let toAmount: Decimal;
  let homeAmt: Decimal;
  if (fromCurrency === toCurrency) {
    // Same foreign currency on both sides.
    const fx = await currencyRate(ctx, fromCurrency, input.exchangeRate);
    toAmount = amount;
    homeAmt = homeOverride ? Money.round2(homeOverride) : toHome(amount, fx.rate);
  } else {
    const statedTo = input.toAmount != null && String(input.toAmount).trim() !== '' ? Money.round2(input.toAmount) : null;
    const cross = parseRate(input.exchangeRate);
    if (!statedTo && !cross) {
      throw validation(
        `This transfer moves money from ${fromCurrency ?? homeLabel} to ${toCurrency ?? homeLabel}. Enter the amount that arrived in ${toCurrency ?? homeLabel} (or the exchange rate).`,
      );
    }
    toAmount = statedTo ?? Money.round2(amount.times(cross!));
    if (!toAmount.greaterThan(0)) throw validation('The amount that arrived must be greater than zero.');
    if (homeOverride) homeAmt = Money.round2(homeOverride);
    else if (!fromCurrency) homeAmt = amount; // home -> foreign: the home side is the home value
    else if (!toCurrency) homeAmt = toAmount; // foreign -> home: what arrived is the home value
    else homeAmt = toHome(amount, (await currencyRate(ctx, fromCurrency)).rate);
  }
  if (!homeAmt.greaterThan(0)) throw validation('The transfer is too small to convert to your home currency.');
  const rate = fromCurrency ? homeAmt.dividedBy(amount) : Money.of(1);
  return {
    fromCurrency,
    toCurrency,
    amount: amountStr,
    toAmount: toAmountString(toAmount),
    home: toAmountString(homeAmt),
    rate: rate.toFixed(8),
  };
}

function fxColumns(fx: TransferFx) {
  return {
    currency: fx.fromCurrency,
    exchangeRate: fx.fromCurrency || fx.toCurrency ? fx.rate : null,
    toCurrency: fx.toCurrency,
    toAmount: fx.fromCurrency || fx.toCurrency ? fx.toAmount : null,
    homeAmount: fx.fromCurrency || fx.toCurrency ? fx.home : null,
  };
}

function transferDescription(input: CreateTransferInput): string {
  return input.memo ? `Transfer: ${input.memo}` : 'Transfer between accounts';
}

/** Both accounts must belong to this company. */
async function assertAccountsOwned(ctx: ServiceContext, input: CreateTransferInput) {
  for (const id of [input.fromAccountId, input.toAccountId]) {
    const [row] = await ctx.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.id, id)));
    if (!row) throw notFound('Account');
  }
}

// ---------------------------------------------------------------------------
// createTransfer
// ---------------------------------------------------------------------------

export async function createTransfer(ctx: ServiceContext, input: CreateTransferInput) {
  const amountStr = validateTransfer(input);
  await assertAccountsOwned(ctx, input);
  const fx = await resolveTransferFx(ctx, input, amountStr);

  return inTransaction(ctx, async (tx) => {
    // Insert the transfer record first, so its entry can carry `transfer:<id>` as its source:
    // reports label it "Transfer", QuickZoom opens the transfer, and the Journal screen refuses
    // to edit / void / reverse it on its own (which would leave the transfer row pointing at a
    // void entry and a later edit of the transfer posting the money a second time).
    const [inserted] = await tx.db
      .insert(transfers)
      .values({
        companyId: tx.companyId,
        date: input.date,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        amount: amountStr,
        memo: input.memo ?? null,
        ...fxColumns(fx),
      })
      .returning();

    // Post the journal entry: Dr toAccount, Cr fromAccount.
    const entry = await postJournalEntry(tx, {
      date: input.date,
      description: transferDescription(input),
      sourceRef: `transfer:${inserted.id}`,
      lines: transferLines(input, fx),
    });
    const [transfer] = await tx.db
      .update(transfers)
      .set({ postedEntryId: entry.id })
      .where(eq(transfers.id, inserted.id))
      .returning();

    await writeAudit(tx, {
      action: 'create',
      entityType: 'transfer',
      entityId: transfer.id,
      newValues: {
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        amount: amountStr,
        postedEntryId: entry.id,
        ...fxColumns(fx),
      },
    });

    return transfer;
  });
}

// ---------------------------------------------------------------------------
// updateTransfer / voidTransfer (D1)
// ---------------------------------------------------------------------------

export async function updateTransfer(ctx: ServiceContext, id: string, input: CreateTransferInput) {
  const amountStr = validateTransfer(input);
  await assertAccountsOwned(ctx, input);
  const fx = await resolveTransferFx(ctx, input, amountStr);
  const [existing] = await ctx.db
    .select()
    .from(transfers)
    .where(and(eq(transfers.companyId, ctx.companyId), eq(transfers.id, id)));
  if (!existing) throw notFound('Transfer');
  if (existing.voidedAt) throw new ServiceError('CONFLICT', 'This transfer is void and cannot be edited.');

  return inTransaction(ctx, async (tx) => {
    const lines = transferLines(input, fx);
    let plan = await planPostedEdit(tx, {
      entryId: existing.postedEntryId,
      date: input.date,
      lines,
      what: 'transfer',
    });
    // p1 fx: a change of the account-currency amount alone (same home value) still re-posts.
    if (plan === 'unchanged' && (fx.amount !== toAmountString(existing.amount) || fx.toAmount !== toAmountString(existing.toAmount ?? existing.amount))) {
      plan = 'repost';
    }
    let entryId = existing.postedEntryId;
    if (plan === 'repost') {
      if (existing.postedEntryId) await voidJournalEntry(tx, existing.postedEntryId);
      const entry = await postJournalEntry(tx, {
        date: input.date,
        description: transferDescription(input),
        sourceRef: `transfer:${id}`,
        lines,
      });
      entryId = entry.id;
    } else {
      await retitleEntry(tx, entryId, { description: transferDescription(input) });
    }
    const [updated] = await tx.db
      .update(transfers)
      .set({
        date: input.date,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        amount: amountStr,
        memo: input.memo ?? null,
        postedEntryId: entryId,
        ...fxColumns(fx),
      })
      .where(eq(transfers.id, id))
      .returning();
    await writeAudit(tx, {
      action: 'update',
      entityType: 'transfer',
      entityId: id,
      oldValues: {
        date: existing.date,
        fromAccountId: existing.fromAccountId,
        toAccountId: existing.toAccountId,
        amount: existing.amount,
        memo: existing.memo,
        postedEntryId: existing.postedEntryId,
      },
      newValues: {
        date: input.date,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        amount: amountStr,
        memo: input.memo ?? null,
        ledger: plan === 'unchanged' ? 'unchanged' : 'reposted',
        postedEntryId: entryId,
      },
    });
    return updated;
  });
}

export async function voidTransfer(ctx: ServiceContext, id: string) {
  const [existing] = await ctx.db
    .select()
    .from(transfers)
    .where(and(eq(transfers.companyId, ctx.companyId), eq(transfers.id, id)));
  if (!existing) throw notFound('Transfer');
  if (existing.voidedAt) return existing; // idempotent
  return inTransaction(ctx, async (tx) => {
    if (existing.postedEntryId) await voidJournalEntry(tx, existing.postedEntryId);
    const [updated] = await tx.db
      .update(transfers)
      .set({ voidedAt: new Date() })
      .where(eq(transfers.id, id))
      .returning();
    await writeAudit(tx, {
      action: 'void',
      entityType: 'transfer',
      entityId: id,
      oldValues: { amount: existing.amount, postedEntryId: existing.postedEntryId },
      newValues: { voided: true },
    });
    return updated;
  });
}

// ---------------------------------------------------------------------------
// listTransfers
// ---------------------------------------------------------------------------

export async function listTransfers(ctx: ServiceContext) {
  return ctx.db
    .select()
    .from(transfers)
    .where(eq(transfers.companyId, ctx.companyId))
    .orderBy(desc(transfers.date), desc(transfers.createdAt));
}

// ---------------------------------------------------------------------------
// getTransfer
// ---------------------------------------------------------------------------

export async function getTransfer(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select()
    .from(transfers)
    .where(and(eq(transfers.companyId, ctx.companyId), eq(transfers.id, id)));
  if (!row) throw notFound('Transfer');
  return row;
}
