/**
 * Chart of Accounts service. CRUD + hierarchy for the company's accounts.
 *
 * Account types follow QuickBooks (Bank, Accounts Receivable, Other Current Asset, ... Non-Posting;
 * see lib/accountTypes.ts). Callers may pass either a QB `qbType` (preferred — what the UI picker
 * sends) or the stored (type, subtype) pair; both are validated against each other.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { accountSubtypeEnum, accounts, companies, journalEntries, journalEntryLines } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import {
  type BaseAccountType,
  type QbAccountType,
  QB_ACCOUNT_TYPES,
  baseTypeOfSubtype,
  getQbAccountTypeInfo,
  isQbAccountType,
  qbAccountTypeOf,
  resolveQbAccountType,
} from '@/lib/accountTypes';
import {
  type IncomeTaxForm,
  type TaxLine,
  getTaxLine,
  isIncomeTaxForm,
  taxLinesForForm,
} from '@/lib/taxLines';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from './_base';
import { postJournalEntry } from './posting';

type AccountType = BaseAccountType;

export interface CreateAccountInput {
  code: string;
  name: string;
  /** Base accounting class. Optional when `qbType` is given (derived from it). */
  type?: AccountType;
  /** Detail subtype; blank = the default for the type / qbType. */
  subtype?: string | null;
  /** QuickBooks account type (Bank, Other Current Asset, ...). Wins over `type` when both given. */
  qbType?: string | null;
  parentId?: string | null;
  openingBalance?: string | number | null;
  /** Entry date for the opening-balance journal entry (defaults to today). */
  openingBalanceDate?: Date;
  description?: string | null;
  /** Income-tax line key (lib/taxLines.ts), or null. */
  taxLine?: string | null;
}

const VALID_SUBTYPES = new Set<string>(accountSubtypeEnum.enumValues);

/**
 * Default subtype per base type, used when the caller gives neither subtype nor qbType.
 * QB parity: an unspecified asset is an Other Current Asset and an unspecified liability an
 * Other Current Liability — never a bank account or Accounts Payable, which would make the
 * account show up in bank registers / the A/P figure by accident.
 */
const DEFAULT_SUBTYPE: Record<AccountType, (typeof accountSubtypeEnum.enumValues)[number]> = {
  asset: 'other_current_asset',
  liability: 'other_current_liability',
  equity: 'owners_equity',
  revenue: 'sales',
  expense: 'operating_expenses',
};

/**
 * Normalize + validate a subtype against the canonical enum. A blank subtype maps to a
 * sensible per-type default; an unknown value, or a subtype that belongs to another base type
 * (e.g. an expense account with subtype "checking"), throws VALIDATION (so the API returns a
 * 400 instead of a Postgres enum error surfacing as a 500).
 */
function normalizeSubtype(subtype: string | null | undefined, type: AccountType): string {
  const cleaned = subtype?.trim().toLowerCase() ?? '';
  if (!cleaned) return DEFAULT_SUBTYPE[type];
  if (!VALID_SUBTYPES.has(cleaned)) {
    throw validation(
      `Invalid subtype "${subtype}". Valid subtypes: ${accountSubtypeEnum.enumValues.join(', ')}.`,
    );
  }
  const base = baseTypeOfSubtype(cleaned);
  if (base && base !== type) {
    throw validation(`Subtype "${cleaned}" belongs to ${base} accounts, not ${type} accounts.`);
  }
  return cleaned;
}

/** Resolve (type, subtype) from a create/update input that may carry a QB type. */
function resolveTypeAndSubtype(input: {
  type?: string | null;
  subtype?: string | null;
  qbType?: string | null;
}): { type: AccountType; subtype: string } {
  const qb = input.qbType?.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (qb) {
    if (!isQbAccountType(qb)) {
      throw validation(
        `Invalid account type "${input.qbType}". Valid types: ${QB_ACCOUNT_TYPES.map((t) => t.label).join(', ')}.`,
      );
    }
    const info = getQbAccountTypeInfo(qb)!;
    if (input.type && input.type !== info.baseType) {
      throw validation(`Account type ${info.label} is a ${info.baseType} type, not ${input.type}.`);
    }
    const sub = input.subtype?.trim().toLowerCase();
    if (sub && !(info.subtypes as string[]).includes(sub)) {
      throw validation(`Subtype "${sub}" does not belong to account type ${info.label}.`);
    }
    return resolveQbAccountType(qb, sub);
  }
  if (!input.type) throw validation('Account type is required.');
  if (!['asset', 'liability', 'equity', 'revenue', 'expense'].includes(input.type)) {
    throw validation(`Invalid account type "${input.type}".`);
  }
  return { type: input.type as AccountType, subtype: normalizeSubtype(input.subtype, input.type as AccountType) };
}

/** Validate a tax-line key ('' / null clears it). */
function normalizeTaxLine(taxLine: string | null | undefined): string | null {
  const v = taxLine?.trim();
  if (!v) return null;
  if (!getTaxLine(v)) throw validation(`Unknown tax line "${v}".`);
  return v;
}

/** Decorate an account row with its derived QuickBooks account type. */
export function withQbType<T extends { type: string; subtype: string }>(row: T): T & { qbType: QbAccountType } {
  return { ...row, qbType: qbAccountTypeOf(row) };
}

/**
 * Validate a proposed parentId for `accountId` (null when creating a new account):
 *  - the parent must exist and belong to this company (tenancy),
 *  - the parent cannot be the account itself,
 *  - the parent cannot be a descendant of the account (cycle).
 */
async function assertValidParent(
  ctx: ServiceContext,
  accountId: string | null,
  parentId: string,
): Promise<void> {
  if (accountId !== null && parentId === accountId) {
    throw validation('An account cannot be its own parent.');
  }
  const rows = await ctx.db
    .select({ id: accounts.id, parentId: accounts.parentId })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (!byId.has(parentId)) throw notFound('Parent account');
  // Walk the ancestor chain of the proposed parent; cap at row count to guard bad data.
  let cur: string | null = parentId;
  for (let steps = 0; cur && steps <= byId.size; steps++) {
    if (cur === accountId) {
      throw validation('Cannot move an account under its own descendant.');
    }
    cur = byId.get(cur)?.parentId ?? null;
  }
}

export async function listAccounts(ctx: ServiceContext, opts?: { includeInactive?: boolean }) {
  const where = opts?.includeInactive
    ? eq(accounts.companyId, ctx.companyId)
    : and(eq(accounts.companyId, ctx.companyId), eq(accounts.isActive, true));
  const rows = await ctx.db.select().from(accounts).where(where).orderBy(asc(accounts.code));
  return rows.map(withQbType);
}

export async function getAccount(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.companyId, ctx.companyId)));
  if (!row) throw notFound('Account');
  return withQbType(row);
}

const DEBIT_NORMAL = new Set<AccountType>(['asset', 'expense']);

const OPENING_BALANCE_EQUITY_NAME = 'Opening Balance Equity';

/**
 * Find (or create) the company's "Opening Balance Equity" account — the QB-style offset
 * account for opening balances. Prefers code 3900; picks the next free code if taken.
 */
async function findOrCreateOpeningBalanceEquity(ctx: ServiceContext) {
  const [existing] = await ctx.db
    .select()
    .from(accounts)
    .where(
      and(eq(accounts.companyId, ctx.companyId), eq(accounts.name, OPENING_BALANCE_EQUITY_NAME)),
    );
  if (existing) return existing;

  const codeRows = await ctx.db
    .select({ code: accounts.code })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const taken = new Set(codeRows.map((r) => r.code));
  let code = 3900;
  while (taken.has(String(code))) code++;

  const [row] = await ctx.db
    .insert(accounts)
    .values({
      companyId: ctx.companyId,
      code: String(code),
      name: OPENING_BALANCE_EQUITY_NAME,
      type: 'equity',
      subtype: 'owners_equity',
      balance: '0.00',
      description: 'Offset account for account opening balances.',
    })
    .returning();
  await writeAudit(ctx, {
    action: 'create',
    entityType: 'account',
    entityId: row.id,
    newValues: row,
  });
  return row;
}

export async function createAccount(ctx: ServiceContext, input: CreateAccountInput) {
  if (!input.code?.trim()) throw validation('Account code is required.');
  if (!input.name?.trim()) throw validation('Account name is required.');
  const { type, subtype } = resolveTypeAndSubtype(input);
  const taxLine = normalizeTaxLine(input.taxLine);

  // Enforce unique code per company.
  const existing = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, input.code)));
  if (existing.length) throw validation(`Account code "${input.code}" already exists.`);

  if (input.parentId) await assertValidParent(ctx, null, input.parentId);

  const openingBalance = Money.of(input.openingBalance ?? 0);
  if (subtype === 'non_posting' && !openingBalance.isZero()) {
    throw validation('A non-posting account (estimates, purchase orders) cannot have an opening balance.');
  }

  // Insert the account with a zero cached balance, then post the opening balance through the
  // posting engine against Opening Balance Equity — all in one transaction — so the cached
  // balance, GL, reports, and the integrity checker stay in agreement (double-entry).
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(accounts)
      .values({
        companyId: tx.companyId,
        code: input.code.trim(),
        name: input.name.trim(),
        type,
        subtype: subtype as never,
        parentId: input.parentId ?? null,
        balance: '0.00',
        description: input.description ?? null,
        taxLine,
      })
      .returning();

    if (!openingBalance.isZero()) {
      const obe = await findOrCreateOpeningBalanceEquity(tx);
      if (obe.id === row.id) {
        throw validation('Cannot set an opening balance on the Opening Balance Equity account.');
      }
      const amount = toAmountString(openingBalance.abs());
      // A positive opening balance increases the account's natural balance: debit the new
      // account when it is debit-normal (asset/expense), credit it otherwise. A negative
      // opening balance flips the direction. Opening Balance Equity takes the offset.
      const debitNew = DEBIT_NORMAL.has(type) !== openingBalance.isNegative();
      await postJournalEntry(tx, {
        date: input.openingBalanceDate ?? new Date(),
        description: `Opening balance for ${row.code} ${row.name}`,
        status: 'posted',
        sourceRef: `account:${row.id}`,
        lines: debitNew
          ? [
              { accountId: row.id, debit: amount, memo: 'Opening balance' },
              { accountId: obe.id, credit: amount, memo: 'Opening balance offset' },
            ]
          : [
              { accountId: row.id, credit: amount, memo: 'Opening balance' },
              { accountId: obe.id, debit: amount, memo: 'Opening balance offset' },
            ],
      });
    }

    // Re-read so the returned row reflects the posted opening balance.
    const [created] = await tx.db.select().from(accounts).where(eq(accounts.id, row.id));

    await writeAudit(tx, {
      action: 'create',
      entityType: 'account',
      entityId: created.id,
      newValues: created,
    });
    return withQbType(created);
  });
}

export async function updateAccount(
  ctx: ServiceContext,
  id: string,
  patch: Partial<Pick<CreateAccountInput, 'name' | 'subtype' | 'qbType' | 'parentId' | 'description' | 'taxLine'>> & {
    isActive?: boolean;
  },
) {
  const before = await getAccount(ctx, id);
  if (patch.parentId !== undefined && patch.parentId !== null) {
    await assertValidParent(ctx, id, patch.parentId);
  }
  let type: AccountType = before.type;
  let subtype: string = before.subtype;
  if (patch.qbType) {
    const resolved = resolveTypeAndSubtype({ qbType: patch.qbType, subtype: patch.subtype });
    type = resolved.type;
    subtype = resolved.subtype;
  } else if (patch.subtype !== undefined && patch.subtype !== null) {
    subtype = normalizeSubtype(patch.subtype, before.type);
  }
  // A/R and A/P are subledger control accounts: every line on them carries a customer/vendor
  // name. Turning an account with history into (or out of) A/R or A/P would leave unnamed
  // amounts in the control account (or orphan the named open items), so aging would stop
  // matching the GL. QB refuses this for accounts with transactions; so do we.
  const isSubledger = (s: string) => s === 'accounts_receivable' || s === 'accounts_payable';
  const subledgerChange =
    subtype !== before.subtype && (isSubledger(subtype) || isSubledger(before.subtype));
  if (
    type !== before.type ||
    subledgerChange ||
    (subtype === 'non_posting') !== (before.subtype === 'non_posting')
  ) {
    // Moving between debit- and credit-normal classes (or in/out of non-posting) changes how
    // every posted line is read. QB refuses it for accounts with history; so do we.
    const [used] = await ctx.db
      .select({ id: journalEntryLines.id })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
      .where(and(eq(journalEntryLines.accountId, id), eq(journalEntries.status, 'posted')))
      .limit(1);
    if (used) {
      throw new ServiceError(
        'CONFLICT',
        'This account already has transactions, so it cannot be changed to that account type. Create a new account and move the transactions instead.',
      );
    }
  }
  const [row] = await ctx.db
    .update(accounts)
    .set({
      name: patch.name ?? before.name,
      type,
      subtype: subtype as never,
      parentId: patch.parentId === undefined ? before.parentId : patch.parentId,
      description: patch.description === undefined ? before.description : patch.description,
      taxLine: patch.taxLine === undefined ? before.taxLine : normalizeTaxLine(patch.taxLine),
      isActive: patch.isActive === undefined ? before.isActive : patch.isActive,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, id))
    .returning();

  await writeAudit(ctx, {
    action: 'update',
    entityType: 'account',
    entityId: id,
    oldValues: before,
    newValues: row,
  });
  return withQbType(row);
}

/** Soft-delete: deactivate. Refuses to deactivate an account that still has a balance. */
export async function deactivateAccount(
  ctx: ServiceContext,
  id: string,
  opts?: { force?: boolean },
) {
  const acct = await getAccount(ctx, id);
  if (!opts?.force && !Money.of(acct.balance).isZero()) {
    throw validation(
      'Cannot deactivate an account with a non-zero balance. Reclassify or zero it out first.',
    );
  }
  return updateAccount(ctx, id, { isActive: false });
}

/** Build a parent→children tree for UI rendering. */
export async function getAccountTree(ctx: ServiceContext) {
  const rows = await listAccounts(ctx, { includeInactive: true });
  type Node = (typeof rows)[number] & { children: Node[] };
  const byId = new Map<string, Node>(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots: Node[] = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) byId.get(node.parentId)!.children.push(node);
    else roots.push(node);
  }
  // Defensive: nodes trapped in a parent cycle (legacy bad data) are unreachable from roots.
  // Promote one node per cycle to a root so accounts never silently vanish from the UI.
  const reachable = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const node = stack.pop()!;
    if (reachable.has(node.id)) continue;
    reachable.add(node.id);
    stack.push(...node.children);
  }
  if (reachable.size < byId.size) {
    for (const node of byId.values()) {
      if (reachable.has(node.id)) continue;
      roots.push(node);
      // Mark the subtree under the promoted node as reachable, snipping any child link
      // that would close the cycle so the emitted tree is always acyclic.
      const sub = [node];
      while (sub.length) {
        const n = sub.pop()!;
        if (reachable.has(n.id)) continue;
        reachable.add(n.id);
        n.children = n.children.filter((c) => !reachable.has(c.id));
        sub.push(...n.children);
      }
    }
  }
  return roots;
}

// ---------------------------------------------------------------------------
// Income-tax line mapping (QB "Tax-Line Mapping" + Income Tax Summary data)
// ---------------------------------------------------------------------------

/** The company's income-tax form (companies.settings.incomeTaxForm), or null when unset. */
export async function getIncomeTaxForm(ctx: ServiceContext): Promise<IncomeTaxForm | null> {
  const [row] = await ctx.db
    .select({ settings: companies.settings })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));
  const v = (row?.settings as Record<string, unknown> | null)?.incomeTaxForm;
  return isIncomeTaxForm(v) ? v : null;
}

/** Set the company's income-tax form (JSONB merge so other settings are untouched). */
export async function setIncomeTaxForm(ctx: ServiceContext, form: IncomeTaxForm | null) {
  if (form !== null && !isIncomeTaxForm(form)) throw validation(`Unknown tax form "${form}".`);
  const before = await getIncomeTaxForm(ctx);
  await ctx.db
    .update(companies)
    .set({
      settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object('incomeTaxForm', ${form}::text)`,
      updatedAt: new Date(),
    })
    .where(eq(companies.id, ctx.companyId));
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'company',
    entityId: ctx.companyId,
    oldValues: { incomeTaxForm: before },
    newValues: { incomeTaxForm: form },
  });
  return form;
}

export interface TaxLineMappingAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  qbType: QbAccountType;
  balance: string;
}

export interface TaxLineMapping {
  form: IncomeTaxForm | null;
  /** Tax lines of the form (all of them, in form order) with the accounts mapped to each. */
  lines: Array<TaxLine & { accounts: TaxLineMappingAccount[] }>;
  /** Accounts mapped to a line of ANOTHER form (e.g. after changing the company's form). */
  otherFormAccounts: Array<TaxLineMappingAccount & { taxLine: string }>;
  /** Active posting accounts with no tax line ("<Unassigned>" in QB). */
  unassigned: TaxLineMappingAccount[];
}

/**
 * Account -> tax-line mapping for income-tax reports (Income Tax Preparation / Summary / Detail).
 * Balances are the cached natural balances; period figures come from the reports engine, which
 * can group its own per-account totals with this mapping (`accountTaxLines` gives a flat map).
 */
export async function getTaxLineMapping(ctx: ServiceContext): Promise<TaxLineMapping> {
  const form = await getIncomeTaxForm(ctx);
  const rows = await listAccounts(ctx, { includeInactive: true });
  const toItem = (a: (typeof rows)[number]): TaxLineMappingAccount => ({
    id: a.id,
    code: a.code,
    name: a.name,
    type: a.type,
    qbType: a.qbType,
    balance: toAmountString(a.balance),
  });
  const byLine = new Map<string, TaxLineMappingAccount[]>();
  const otherFormAccounts: TaxLineMapping['otherFormAccounts'] = [];
  const unassigned: TaxLineMappingAccount[] = [];
  for (const a of rows) {
    if (a.subtype === 'non_posting') continue;
    const line = getTaxLine(a.taxLine);
    if (!line) {
      if (a.isActive) unassigned.push(toItem(a));
    } else if (form && line.form !== form) {
      otherFormAccounts.push({ ...toItem(a), taxLine: line.key });
    } else {
      const list = byLine.get(line.key) ?? [];
      list.push(toItem(a));
      byLine.set(line.key, list);
    }
  }
  const formLines: TaxLine[] = form
    ? taxLinesForForm(form)
    : [...byLine.keys()].map((k) => getTaxLine(k)).filter((l): l is TaxLine => Boolean(l));
  return {
    form,
    lines: formLines.map((l) => ({ ...l, accounts: byLine.get(l.key) ?? [] })),
    otherFormAccounts,
    unassigned,
  };
}

/** Flat accountId -> tax-line key map (only mapped accounts). */
export async function accountTaxLines(ctx: ServiceContext): Promise<Map<string, string>> {
  const rows = await ctx.db
    .select({ id: accounts.id, taxLine: accounts.taxLine })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  return new Map(rows.filter((r) => r.taxLine).map((r) => [r.id, r.taxLine!]));
}
