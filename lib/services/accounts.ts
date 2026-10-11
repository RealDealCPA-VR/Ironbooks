/**
 * Chart of Accounts service. CRUD + hierarchy for the company's accounts.
 */
import { and, asc, eq } from 'drizzle-orm';
import { accountSubtypeEnum, accounts } from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { type ServiceContext, inTransaction, notFound, validation, writeAudit } from './_base';
import { postJournalEntry } from './posting';

type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface CreateAccountInput {
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  parentId?: string | null;
  openingBalance?: string | number | null;
  /** Entry date for the opening-balance journal entry (defaults to today). */
  openingBalanceDate?: Date;
  description?: string | null;
}

const VALID_SUBTYPES = new Set<string>(accountSubtypeEnum.enumValues);

/** Default subtype per account type, used when the caller leaves subtype blank. */
const DEFAULT_SUBTYPE: Record<AccountType, (typeof accountSubtypeEnum.enumValues)[number]> = {
  asset: 'checking',
  liability: 'accounts_payable',
  equity: 'owners_equity',
  revenue: 'sales',
  expense: 'operating_expenses',
};

/**
 * Normalize + validate a subtype against the canonical enum. A blank subtype maps to a
 * sensible per-type default; an unknown value throws VALIDATION (so the API returns a 400
 * instead of a Postgres enum error surfacing as a 500).
 */
function normalizeSubtype(subtype: string | null | undefined, type: AccountType): string {
  const cleaned = subtype?.trim().toLowerCase() ?? '';
  if (!cleaned) return DEFAULT_SUBTYPE[type];
  if (!VALID_SUBTYPES.has(cleaned)) {
    throw validation(
      `Invalid subtype "${subtype}". Valid subtypes: ${accountSubtypeEnum.enumValues.join(', ')}.`,
    );
  }
  return cleaned;
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
  return ctx.db.select().from(accounts).where(where).orderBy(asc(accounts.code));
}

export async function getAccount(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.companyId, ctx.companyId)));
  if (!row) throw notFound('Account');
  return row;
}

const DEBIT_NORMAL = new Set<AccountType>(['asset', 'expense']);

const OPENING_BALANCE_EQUITY_NAME = 'Opening Balance Equity';

/**
 * Find (or create) the company's "Opening Balance Equity" account — the QB-style offset
 * account for opening balances. Prefers code 3900; picks the next free code if taken.
 */
export async function findOrCreateOpeningBalanceEquity(ctx: ServiceContext) {
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
  const subtype = normalizeSubtype(input.subtype, input.type);

  // Enforce unique code per company.
  const existing = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, input.code)));
  if (existing.length) throw validation(`Account code "${input.code}" already exists.`);

  if (input.parentId) await assertValidParent(ctx, null, input.parentId);

  const openingBalance = Money.of(input.openingBalance ?? 0);

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
        type: input.type,
        subtype: subtype as never,
        parentId: input.parentId ?? null,
        balance: '0.00',
        description: input.description ?? null,
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
      const debitNew = DEBIT_NORMAL.has(input.type) !== openingBalance.isNegative();
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
    return created;
  });
}

export async function updateAccount(
  ctx: ServiceContext,
  id: string,
  patch: Partial<Pick<CreateAccountInput, 'name' | 'subtype' | 'parentId' | 'description'>> & {
    isActive?: boolean;
  },
) {
  const before = await getAccount(ctx, id);
  if (patch.parentId !== undefined && patch.parentId !== null) {
    await assertValidParent(ctx, id, patch.parentId);
  }
  const subtype =
    patch.subtype === undefined ? before.subtype : normalizeSubtype(patch.subtype, before.type);
  const [row] = await ctx.db
    .update(accounts)
    .set({
      name: patch.name ?? before.name,
      subtype: subtype as never,
      parentId: patch.parentId === undefined ? before.parentId : patch.parentId,
      description: patch.description === undefined ? before.description : patch.description,
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
  return row;
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
