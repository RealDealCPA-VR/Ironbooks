/**
 * Register entry — save a transaction typed straight into an account register (QB "Use
 * Register" blank row).
 *
 * lib/registerEntryPlan.ts decides what the row saves as; this service checks the accounts
 * belong to the company and hands the row to the service that owns that document (Write Checks,
 * Make Deposits, Transfer Funds, credit card charges or the general journal). Every rule of those
 * forms (closing date, check numbers and duplicates, currencies, audit trail) therefore applies
 * unchanged, and the entry opens later on its own form like any other.
 *
 * Permissions follow the document saved: checks, card charges / credits and deposits need
 * Banking, transfers and journal entries need Accounting (the same as their own routes).
 */
import { and, eq, sql } from 'drizzle-orm';
import { accounts, otherNames, vendors } from '@/lib/db/schema';
import { Money } from '@/lib/money';
import { planRegisterEntry, type RegisterEntryKind, type RegisterSide } from '@/lib/registerEntryPlan';
import { notFound, validation, type ServiceContext } from './_base';
import { requirePermission } from './access';
import { createExpense } from './expenses';
import { createDeposit } from './deposits';
import { createTransfer } from './transfers';
import { createManualEntry, resolveEntityNames } from './journal';
import type { JournalEntityType } from './posting';

export interface RegisterEntryInput {
  date: Date;
  /** Number column: the check number (blank = next number), card ref or journal entry number. */
  number?: string | null;
  /** Payee / description. On checks and card entries a vendor or Other Name with this exact name is linked. */
  payee?: string | null;
  /**
   * The payee picked from the name list (or just created from the row's "new name" prompt).
   * Takes precedence over matching the typed text.
   */
  name?: { type: JournalEntityType; id: string } | null;
  /** The account on the other side of the entry (the register's Account column). */
  otherAccountId: string;
  memo?: string | null;
  /** Which amount column was filled in, as the change to THIS register's account. */
  side: RegisterSide;
  /** Positive amount. */
  amount: string | number;
  /** Duplicate check numbers are refused (409) unless the user confirmed them. */
  checkDuplicateNumber?: boolean;
}

export interface RegisterEntryResult {
  kind: RegisterEntryKind;
  /** Id of the saved document (expense, deposit, transfer or journal entry). */
  id: string;
}

const KIND_AREA: Record<RegisterEntryKind, 'banking' | 'accounting'> = {
  check: 'banking',
  deposit: 'banking',
  card_charge: 'banking',
  card_credit: 'banking',
  transfer: 'accounting',
  journal: 'accounting',
};

async function loadAccount(ctx: ServiceContext, id: string, what: string) {
  const [row] = await ctx.db
    .select({
      id: accounts.id,
      type: accounts.type,
      subtype: accounts.subtype,
      isActive: accounts.isActive,
      currency: accounts.currency,
    })
    .from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.companyId, ctx.companyId)));
  if (!row) throw notFound(what);
  return row;
}

/** An active vendor or Other Name whose name is exactly the typed payee (case-insensitive). */
async function resolvePayee(ctx: ServiceContext, payee: string) {
  const key = payee.trim().toLowerCase();
  if (!key) return {};
  const [vendor] = await ctx.db
    .select({ id: vendors.id })
    .from(vendors)
    .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.isActive, true), sql`lower(${vendors.displayName}) = ${key}`))
    .limit(1);
  if (vendor) return { vendorId: vendor.id };
  const [other] = await ctx.db
    .select({ id: otherNames.id })
    .from(otherNames)
    .where(and(eq(otherNames.companyId, ctx.companyId), eq(otherNames.isActive, true), sql`lower(${otherNames.name}) = ${key}`))
    .limit(1);
  if (other) return { otherNameId: other.id };
  return { payeeName: payee.trim() };
}

export async function enterRegisterTransaction(
  ctx: ServiceContext,
  registerAccountId: string,
  input: RegisterEntryInput,
): Promise<RegisterEntryResult> {
  if (!input.date || isNaN(input.date.getTime())) throw validation('A valid date is required.');
  let amountStr: string;
  try {
    amountStr = Money.round2(input.amount).toFixed(2);
  } catch {
    throw validation('Enter the amount as a number.');
  }
  if (!Money.isPositive(amountStr)) throw validation('The amount must be more than zero.');

  const register = await loadAccount(ctx, registerAccountId, 'Account');
  const other = await loadAccount(ctx, input.otherAccountId, 'Account');
  const plan = planRegisterEntry(register, other, input.side);
  if (!plan.ok) throw validation(plan.message);
  requirePermission(ctx, KIND_AREA[plan.kind], 'create');

  let payee = input.payee?.trim() || '';
  // A picked name must belong to this company; its display name is the payee text.
  let picked: { type: JournalEntityType; id: string } | null = null;
  if (input.name) {
    const label = (await resolveEntityNames(ctx, [{ entityType: input.name.type, entityId: input.name.id }])).get(
      `${input.name.type}:${input.name.id}`,
    );
    if (!label) throw notFound('Name');
    picked = input.name;
    payee = label;
  }
  const memo = input.memo?.trim() || null;
  const number = input.number?.trim() || null;

  switch (plan.kind) {
    case 'check':
    case 'card_charge':
    case 'card_credit': {
      // Checks and card entries link vendors and Other Names; a customer or employee payee is
      // printed by name (Write Checks has no customer / employee payee link).
      const names =
        picked?.type === 'vendor'
          ? { vendorId: picked.id }
          : picked?.type === 'other'
            ? { otherNameId: picked.id }
            : picked
              ? { payeeName: payee }
              : await resolvePayee(ctx, payee);
      if (!names.vendorId && !names.otherNameId && !names.payeeName) {
        throw validation(plan.kind === 'check' ? 'Enter who the check is to (Payee).' : 'Enter the payee.');
      }
      const expense = await createExpense(ctx, {
        ...names,
        date: input.date,
        method: plan.kind === 'check' ? 'check' : 'credit_card',
        reference: number,
        paymentAccountId: plan.paymentAccountId!,
        memo,
        lines: [{ accountId: plan.lineAccountId!, amount: amountStr, description: memo }],
        isRefund: plan.kind === 'card_credit',
        checkDuplicateNumber: input.checkDuplicateNumber,
      });
      return { kind: plan.kind, id: expense.id };
    }
    case 'deposit': {
      const deposit = await createDeposit(ctx, {
        depositAccountId: plan.debitAccountId,
        date: input.date,
        extraLines: [{ accountId: plan.lineAccountId!, amount: amountStr, description: payee || memo }],
        memo: memo ?? (payee || null),
      });
      return { kind: 'deposit', id: deposit.id };
    }
    case 'transfer': {
      const transfer = await createTransfer(ctx, {
        date: input.date,
        fromAccountId: plan.creditAccountId,
        toAccountId: plan.debitAccountId,
        amount: amountStr,
        memo: [payee, memo].filter(Boolean).join(' — ') || null,
      });
      return { kind: 'transfer', id: transfer.id };
    }
    case 'journal': {
      const entry = await createManualEntry(ctx, {
        date: input.date,
        description: payee || memo || 'Register entry',
        reference: number,
        // The name goes on the other account's line (QB puts the register's name there).
        lines: [plan.debitAccountId, plan.creditAccountId].map((accountId) => ({
          accountId,
          ...(accountId === plan.debitAccountId ? { debit: amountStr } : { credit: amountStr }),
          memo,
          ...(picked && accountId === input.otherAccountId ? { entityType: picked.type, entityId: picked.id } : {}),
        })),
      });
      return { kind: 'journal', id: entry.id };
    }
  }
}
