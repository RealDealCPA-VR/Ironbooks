/**
 * Bookkeeping assistant — plain-language questions answered from numbers computed LOCALLY.
 *
 * The model never touches the database. It may only call the read-only tools below (each a
 * thin wrapper over an existing report/query service); the tool results are fed back to it,
 * and its final answer must cite them. Every money figure in the answer is cross-checked
 * against the tool results and anything that does not appear there is flagged
 * (`unverifiedNumbers`) so the UI can warn the user.
 *
 * Writes: the model can only PROPOSE a journal entry. A proposal is validated (accounts exist
 * and are active, amounts are well-formed, debits = credits), stored as `ai_proposals.pending`,
 * and posts only when a user approves it — via journal.createManualEntry → postJournalEntry,
 * inside the user's own permissions (viewers cannot approve; closed periods stay closed).
 *
 * Without any eligible model the assistant still works in an offline, keyword-driven mode
 * that runs the same tools and formats their results deterministically.
 */
import { and, desc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { accounts, aiProposals, customers, journalEntries, journalEntryLines, vendors } from '@/lib/db/schema';
import { Money, toAmountString, formatCurrency } from '@/lib/money';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from './_base';
import { balanceSheet, profitAndLoss, trialBalance } from './reports';
import { apAging, arAging } from './reportsExtra';
import { assertBalanced } from './posting';
import { createManualEntry, followMergedNames } from './journal';
import { buildRouter, type BuildRouterOptions } from './aiSettings';
import { companyToday } from './preferences';
import { AiError } from '@/lib/ai/types';
import { can, type Area } from '@/lib/permissions/model';
import { requirePermission } from './access';

// ---------------------------------------------------------------------------
// Read-only tools
// ---------------------------------------------------------------------------

const zDateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD')
  .refine((s) => parseDate(s) !== undefined, 'not a real calendar date');
const MAX_ROWS = 40;

function parseDate(s: string | undefined, endOfDay = false): Date | undefined {
  if (!s) return undefined;
  const d = new Date(`${s}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  // Reject impossible calendar dates ("2026-02-30" would otherwise roll over to March 2).
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return undefined;
  return d;
}

function cap<T>(rows: T[], n = MAX_ROWS): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice(0, n), truncated: rows.length > n };
}

interface ToolDef {
  description: string;
  /**
   * The report area the tool's data belongs to (the caller needs 'view' of it, like the report's own
   * route): A/R aging is Reports — Customers & Sales, A/P aging Reports — Vendors & Purchases, the
   * rest Reports — Financial. The assistant route only checks Reports — Financial.
   */
  area: Area;
  args: z.ZodType<Record<string, unknown>, z.ZodTypeDef, unknown>;
  argsHelp: string;
  run(ctx: ServiceContext, args: Record<string, unknown>): Promise<unknown>;
}

export const TOOLS: Record<string, ToolDef> = {
  profit_and_loss: {
    area: 'reports_financial',
    description: 'Profit & Loss (income, expenses, net income) for a date range.',
    argsHelp: '{"from"?: "YYYY-MM-DD", "to"?: "YYYY-MM-DD"}',
    args: z.object({ from: zDateStr.optional(), to: zDateStr.optional() }),
    async run(ctx, a) {
      const r = await profitAndLoss(ctx, { from: parseDate(a.from as string), to: parseDate(a.to as string, true) });
      return {
        from: a.from ?? null,
        to: a.to ?? null,
        income: r.income.map((l) => ({ code: l.code, name: l.name, amount: l.amount })),
        expenses: r.expenses.map((l) => ({ code: l.code, name: l.name, amount: l.amount })),
        totalIncome: r.totalIncome,
        totalExpenses: r.totalExpenses,
        netIncome: r.netIncome,
      };
    },
  },
  balance_sheet: {
    area: 'reports_financial',
    description: 'Balance Sheet (assets, liabilities, equity) as of a date.',
    argsHelp: '{"asOf"?: "YYYY-MM-DD"}',
    args: z.object({ asOf: zDateStr.optional() }),
    async run(ctx, a) {
      const r = await balanceSheet(ctx, parseDate(a.asOf as string, true));
      const pick = (ls: { code: string; name: string; amount: string }[]) => ls.map((l) => ({ code: l.code, name: l.name, amount: l.amount }));
      return {
        asOf: a.asOf ?? null,
        assets: pick(r.assets),
        liabilities: pick(r.liabilities),
        equity: pick(r.equity),
        totalAssets: r.totalAssets,
        totalLiabilities: r.totalLiabilities,
        totalEquity: r.totalEquity,
        retainedEarningsCurrent: r.retainedEarnings,
        balanced: r.balanced,
      };
    },
  },
  ar_aging: {
    area: 'reports_sales',
    description: 'Accounts receivable aging by customer (who owes us, how overdue).',
    argsHelp: '{"asOf"?: "YYYY-MM-DD"}',
    args: z.object({ asOf: zDateStr.optional() }),
    async run(ctx, a) {
      const r = await arAging(ctx, parseDate(a.asOf as string, true));
      const rows = [...r.rows].sort((x, y) => Money.of(y.total).comparedTo(Money.of(x.total)));
      const c = cap(rows.map(({ id: _id, ...rest }) => rest));
      return { asOf: r.asOf, customers: c.rows, truncated: c.truncated, totals: r.totals };
    },
  },
  ap_aging: {
    area: 'reports_purchases',
    description: 'Accounts payable aging by vendor (what we owe, how overdue).',
    argsHelp: '{"asOf"?: "YYYY-MM-DD"}',
    args: z.object({ asOf: zDateStr.optional() }),
    async run(ctx, a) {
      const r = await apAging(ctx, parseDate(a.asOf as string, true));
      const rows = [...r.rows].sort((x, y) => Money.of(y.total).comparedTo(Money.of(x.total)));
      const c = cap(rows.map(({ id: _id, ...rest }) => rest));
      return { asOf: r.asOf, vendors: c.rows, truncated: c.truncated, totals: r.totals };
    },
  },
  account_balances: {
    area: 'reports_financial',
    description: 'Account balances from the general ledger (natural sign), optionally filtered by name/code.',
    argsHelp: '{"asOf"?: "YYYY-MM-DD", "query"?: "text matching account name or code"}',
    args: z.object({ asOf: zDateStr.optional(), query: z.string().max(100).optional() }),
    async run(ctx, a) {
      const tb = await trialBalance(ctx, parseDate(a.asOf as string, true));
      const q = (a.query as string | undefined)?.toLowerCase().trim();
      const rows = tb.rows
        .filter((r) => !q || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q))
        .map((r) => {
          const net = Money.sub(r.debit, r.credit);
          const natural = r.type === 'asset' || r.type === 'expense' ? net : net.negated();
          return { code: r.code, name: r.name, type: r.type, balance: toAmountString(natural) };
        });
      const c = cap(rows, 80);
      return { asOf: a.asOf ?? null, accounts: c.rows, truncated: c.truncated };
    },
  },
  list_accounts: {
    area: 'reports_financial',
    description: 'Chart of accounts (active): code, name, type. Use before proposing an entry.',
    argsHelp: '{"query"?: "text"}',
    args: z.object({ query: z.string().max(100).optional() }),
    async run(ctx, a) {
      const q = (a.query as string | undefined)?.trim();
      const conds = [eq(accounts.companyId, ctx.companyId), eq(accounts.isActive, true)];
      if (q) conds.push(or(ilike(accounts.name, `%${q}%`), ilike(accounts.code, `%${q}%`))!);
      const rows = await ctx.db
        .select({ code: accounts.code, name: accounts.name, type: accounts.type })
        .from(accounts)
        .where(and(...conds))
        .orderBy(accounts.code);
      const c = cap(rows, 150);
      return { accounts: c.rows, truncated: c.truncated };
    },
  },
  search_transactions: {
    area: 'reports_financial',
    description: 'Search posted journal entries by text (description/reference/memo), date range, account code and amount.',
    argsHelp: '{"query"?: "text", "from"?: "YYYY-MM-DD", "to"?: "YYYY-MM-DD", "accountCode"?: "6000", "minAmount"?: number, "maxAmount"?: number, "limit"?: 1-25}',
    args: z.object({
      query: z.string().max(100).optional(),
      from: zDateStr.optional(),
      to: zDateStr.optional(),
      accountCode: z.string().max(50).optional(),
      minAmount: z.coerce.number().nonnegative().optional(),
      maxAmount: z.coerce.number().nonnegative().optional(),
      limit: z.coerce.number().int().min(1).max(25).optional(),
    }),
    async run(ctx, a) {
      return searchTransactions(ctx, a as SearchArgs);
    },
  },
};

export type ToolName = keyof typeof TOOLS;

interface SearchArgs {
  query?: string;
  from?: string;
  to?: string;
  accountCode?: string;
  minAmount?: number;
  maxAmount?: number;
  limit?: number;
}

async function searchTransactions(ctx: ServiceContext, a: SearchArgs) {
  const conds = [eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.status, 'posted')];
  const from = parseDate(a.from);
  const to = parseDate(a.to, true);
  if (from) conds.push(gte(journalEntries.date, from));
  if (to) conds.push(lte(journalEntries.date, to));
  if (a.query?.trim()) {
    const q = `%${a.query.trim()}%`;
    conds.push(or(ilike(journalEntries.description, q), ilike(journalEntries.reference, q), ilike(journalEntryLines.memo, q))!);
  }
  if (a.accountCode) conds.push(eq(accounts.code, a.accountCode));
  const amt = sql`COALESCE(${journalEntryLines.debit}, ${journalEntryLines.credit}, 0)`;
  if (a.minAmount !== undefined) conds.push(sql`${amt} >= ${toAmountString(a.minAmount)}`);
  if (a.maxAmount !== undefined) conds.push(sql`${amt} <= ${toAmountString(a.maxAmount)}`);

  const hits = await ctx.db
    .selectDistinct({ id: journalEntries.id, date: journalEntries.date, entryNumber: journalEntries.entryNumber })
    .from(journalEntries)
    .innerJoin(journalEntryLines, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(and(...conds))
    .orderBy(desc(journalEntries.date), desc(journalEntries.entryNumber))
    .limit(a.limit ?? 15);
  if (hits.length === 0) return { entries: [] };

  const ids = hits.map((h) => h.id);
  const rows = await ctx.db
    .select({
      id: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      date: journalEntries.date,
      description: journalEntries.description,
      reference: journalEntries.reference,
      code: accounts.code,
      account: accounts.name,
      debit: journalEntryLines.debit,
      credit: journalEntryLines.credit,
      memo: journalEntryLines.memo,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .innerJoin(accounts, eq(journalEntryLines.accountId, accounts.id))
    .where(sql`${journalEntries.id} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  const entries = hits.map((h) => {
    const ls = rows.filter((r) => r.id === h.id);
    return {
      entryNumber: h.entryNumber,
      date: h.date.toISOString().slice(0, 10),
      description: ls[0]?.description ?? '',
      reference: ls[0]?.reference ?? null,
      lines: ls.map((l) => ({ code: l.code, account: l.account, debit: l.debit, credit: l.credit, memo: l.memo })),
    };
  });
  return { entries };
}

/** Run one tool with validated args. */
export async function runTool(ctx: ServiceContext, name: string, rawArgs: unknown): Promise<unknown> {
  const tool = TOOLS[name];
  if (!tool) throw validation(`Unknown tool "${name}".`);
  // Same right as the report itself (e.g. A/R aging needs Reports — Customers & Sales).
  requirePermission(ctx, tool.area, 'view');
  const parsed = tool.args.safeParse(rawArgs ?? {});
  if (!parsed.success) throw validation(`Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return tool.run(ctx, parsed.data);
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

const proposalLineSchema = z.object({
  accountCode: z.string().min(1).max(50),
  debit: z.union([z.string(), z.number()]).nullish(),
  credit: z.union([z.string(), z.number()]).nullish(),
  memo: z.string().max(500).nullish(),
  /**
   * QB "Name" column: the customer (A/R lines) or vendor (A/P lines) display name. Resolved to
   * an id when the proposal is stored; A/R and A/P lines need one to be approved.
   */
  name: z.string().trim().max(200).nullish(),
});
export const journalProposalSchema = z.object({
  type: z.literal('journal_entry').default('journal_entry'),
  date: zDateStr,
  description: z.string().trim().min(1).max(500),
  reference: z.string().max(100).nullish(),
  lines: z.array(proposalLineSchema).min(2).max(30),
});
export type JournalProposal = z.infer<typeof journalProposalSchema>;

export interface ProposalView {
  id: string;
  kind: string;
  summary: string;
  status: string;
  payload: StoredJournalProposal;
  createdAt: Date;
  resultRef: string | null;
  error: string | null;
}

interface StoredJournalProposal {
  date: string;
  description: string;
  reference: string | null;
  lines: {
    accountId: string;
    accountCode: string;
    accountName: string;
    debit: string | null;
    credit: string | null;
    memo: string | null;
    /** QB "Name" column. Optional: proposals that hit A/R or A/P must carry one to be approved. */
    entityType?: 'customer' | 'vendor' | 'employee' | 'other' | null;
    entityId?: string | null;
    entityName?: string | null;
  }[];
  totalDebit: string;
  rationale: string | null;
}

const MONEY_RE = /^\d+(\.\d{1,2})?$/;

function moneyOrNull(v: string | number | null | undefined, label: string): string | null {
  if (v === null || v === undefined || v === '' || v === 0 || v === '0') return null;
  const s = typeof v === 'number' ? String(v) : v.trim().replace(/[$,]/g, '');
  if (!MONEY_RE.test(s)) throw validation(`${label}: "${v}" is not a valid amount.`);
  return Money.isZero(s) ? null : toAmountString(s);
}

/**
 * Resolve the display name a proposal line carries to a customer (A/R lines) or vendor (A/P
 * lines and, failing that, any other line), case-insensitively, within this company.
 */
async function resolveProposalName(
  ctx: ServiceContext,
  name: string,
  acct: { type: string; subtype: string },
  i: number,
): Promise<{ entityType: 'customer' | 'vendor'; entityId: string; entityName: string }> {
  const findCustomer = async () => {
    const [r] = await ctx.db
      .select({ id: customers.id, name: customers.displayName, isActive: customers.isActive })
      .from(customers)
      .where(and(eq(customers.companyId, ctx.companyId), sql`lower(${customers.displayName}) = lower(${name})`))
      .orderBy(desc(customers.isActive))
      .limit(1);
    return r ? { entityType: 'customer' as const, entityId: r.id, entityName: r.name, isActive: r.isActive } : null;
  };
  const findVendor = async () => {
    const [r] = await ctx.db
      .select({ id: vendors.id, name: vendors.displayName, isActive: vendors.isActive })
      .from(vendors)
      .where(and(eq(vendors.companyId, ctx.companyId), sql`lower(${vendors.displayName}) = lower(${name})`))
      .orderBy(desc(vendors.isActive))
      .limit(1);
    return r ? { entityType: 'vendor' as const, entityId: r.id, entityName: r.name, isActive: r.isActive } : null;
  };
  const isAR = acct.type === 'asset' && acct.subtype === 'accounts_receivable';
  const isAP = acct.type === 'liability' && acct.subtype === 'accounts_payable';
  const found = isAR ? await findCustomer() : isAP ? await findVendor() : (await findVendor()) ?? (await findCustomer());
  if (!found) {
    const kind = isAR ? 'customer' : isAP ? 'vendor' : 'customer or vendor';
    throw validation(`Line ${i + 1}: no ${kind} named "${name}" was found.`);
  }
  if (!found.isActive) {
    throw validation(`Line ${i + 1}: "${found.entityName}" is inactive. Pick an active name, or make this one active again first.`);
  }
  return { entityType: found.entityType, entityId: found.entityId, entityName: found.entityName };
}

/**
 * Validate a model-proposed journal entry against the chart of accounts and the posting
 * rules, then store it as a PENDING proposal. Nothing is posted here.
 */
export async function createJournalProposal(
  ctx: ServiceContext,
  input: unknown,
  rationale?: string | null,
): Promise<ProposalView> {
  const parsed = journalProposalSchema.safeParse(input);
  if (!parsed.success) throw validation(`Proposal is malformed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const p = parsed.data;
  if (!parseDate(p.date)) throw validation('Proposal date is invalid.');

  const acctRows = await ctx.db
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      isActive: accounts.isActive,
    })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  const byCode = new Map(acctRows.map((a) => [a.code, a]));

  const lines: StoredJournalProposal['lines'] = [];
  for (const [i, l] of p.lines.entries()) {
    const acct = byCode.get(l.accountCode.trim());
    if (!acct) throw validation(`Line ${i + 1}: account code ${l.accountCode} does not exist.`);
    if (!acct.isActive) throw validation(`Line ${i + 1}: account ${acct.code} ${acct.name} is inactive.`);
    const named = l.name ? await resolveProposalName(ctx, l.name, acct, i) : null;
    lines.push({
      accountId: acct.id,
      accountCode: acct.code,
      accountName: acct.name,
      debit: moneyOrNull(l.debit, `Line ${i + 1} debit`),
      credit: moneyOrNull(l.credit, `Line ${i + 1} credit`),
      memo: l.memo ?? null,
      entityType: named?.entityType ?? null,
      entityId: named?.entityId ?? null,
      entityName: named?.entityName ?? null,
    });
  }
  // Same rules postJournalEntry enforces — reject an unbalanced proposal up front.
  const totals = assertBalanced(lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit })));

  const payload: StoredJournalProposal = {
    date: p.date,
    description: p.description,
    reference: p.reference ?? null,
    lines,
    totalDebit: totals.totalDebit,
    rationale: rationale ?? null,
  };
  const summaryText = `Journal entry ${p.date}: ${p.description} (${formatCurrency(totals.totalDebit)})`;
  // inTransaction + writeAudit: RBAC (viewers cannot store write proposals) and audit trail.
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(aiProposals)
      .values({
        companyId: tx.companyId,
        createdBy: tx.userId,
        kind: 'journal_entry',
        summary: summaryText,
        payload: payload as unknown as Record<string, unknown>,
        status: 'pending',
      })
      .returning();
    await writeAudit(tx, {
      action: 'create',
      entityType: 'ai_proposal',
      entityId: row.id,
      newValues: { kind: row.kind, summary: row.summary, status: row.status },
      llmReasoning: rationale ?? undefined,
    });
    return toView(row);
  });
}

function toView(row: typeof aiProposals.$inferSelect): ProposalView {
  return {
    id: row.id,
    kind: row.kind,
    summary: row.summary,
    status: row.status,
    payload: row.payload as unknown as StoredJournalProposal,
    createdAt: row.createdAt,
    resultRef: row.resultRef,
    error: row.error,
  };
}

export async function listProposals(ctx: ServiceContext, status?: string): Promise<ProposalView[]> {
  const conds = [eq(aiProposals.companyId, ctx.companyId)];
  if (status) conds.push(eq(aiProposals.status, status));
  const rows = await ctx.db.select().from(aiProposals).where(and(...conds)).orderBy(desc(aiProposals.createdAt)).limit(100);
  return rows.map(toView);
}

/**
 * Approve: post the proposed entry through the normal journal service (posting.ts enforces
 * balance, company ownership of accounts, and closed periods; inTransaction enforces RBAC).
 */
export async function approveProposal(ctx: ServiceContext, id: string): Promise<ProposalView> {
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .select()
      .from(aiProposals)
      .where(and(eq(aiProposals.id, id), eq(aiProposals.companyId, tx.companyId)))
      .for('update');
    if (!row) throw notFound('Proposal');
    if (row.status !== 'pending') throw new ServiceError('CONFLICT', `Proposal is already ${row.status}.`);
    if (row.kind !== 'journal_entry') throw validation(`Unsupported proposal kind: ${row.kind}`);
    const p = row.payload as unknown as StoredJournalProposal;
    const date = parseDate(p.date);
    if (!date) throw validation(`Proposal date ${p.date} is invalid.`);

    // Re-check the accounts at approval time: posting.ts does not look at isActive, and an
    // account may have been deactivated (or removed) since the proposal was made.
    const ids = [...new Set(p.lines.map((l) => l.accountId))];
    const live = await tx.db
      .select({ id: accounts.id, code: accounts.code, name: accounts.name, isActive: accounts.isActive })
      .from(accounts)
      .where(and(eq(accounts.companyId, tx.companyId), inArray(accounts.id, ids)));
    const liveById = new Map(live.map((a) => [a.id, a]));
    for (const l of p.lines) {
      const a = liveById.get(l.accountId);
      if (!a) throw validation(`Account ${l.accountCode} ${l.accountName} no longer exists.`);
      if (!a.isActive) throw validation(`Account ${a.code} ${a.name} is inactive; the proposal cannot be posted.`);
    }

    // The QB name rule applies to AI proposals too: an A/R line needs a customer and an A/P line
    // a vendor, otherwise A/R / A/P aging would stop matching the GL. Proposals that hit those
    // accounts without a name are refused here with a plain-language message.
    // TODO(ai team): let the assistant pick the customer / vendor so such proposals can carry it.
    // The customer / vendor named in the proposal may have been merged away since it was made:
    // follow the merge to the record that was kept. Any other inactive name is refused by the
    // name rule in createManualEntry.
    const lines = await followMergedNames(
      tx,
      p.lines.map((l) => ({
        accountId: l.accountId,
        debit: l.debit,
        credit: l.credit,
        memo: l.memo,
        entityType: l.entityType ?? null,
        entityId: l.entityId ?? null,
      })),
    );
    let entry: Awaited<ReturnType<typeof createManualEntry>>;
    try {
      entry = await createManualEntry(tx, {
        date,
        description: p.description,
        reference: p.reference,
        lines,
      });
    } catch (e) {
      if (e instanceof ServiceError && /needs a (customer|vendor) in the Name column/.test(e.message)) {
        throw validation(
          `This suggestion can't be posted as is: ${e.message} Enter it yourself in Make Journal Entries and pick the name.`,
        );
      }
      throw e;
    }
    const [updated] = await tx.db
      .update(aiProposals)
      .set({ status: 'approved', resultRef: `journal_entry:${entry.id}`, decidedBy: tx.userId, decidedAt: new Date() })
      .where(eq(aiProposals.id, id))
      .returning();
    await writeAudit(tx, {
      action: 'update',
      entityType: 'ai_proposal',
      entityId: id,
      oldValues: { status: 'pending' },
      newValues: { status: 'approved', journalEntryId: entry.id, entryNumber: entry.entryNumber },
      llmReasoning: p.rationale ?? 'Approved assistant proposal.',
    });
    return toView(updated);
  });
}

export async function rejectProposal(ctx: ServiceContext, id: string): Promise<ProposalView> {
  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .select()
      .from(aiProposals)
      .where(and(eq(aiProposals.id, id), eq(aiProposals.companyId, tx.companyId)));
    if (!row) throw notFound('Proposal');
    if (row.status !== 'pending') throw new ServiceError('CONFLICT', `Proposal is already ${row.status}.`);
    const [updated] = await tx.db
      .update(aiProposals)
      .set({ status: 'rejected', decidedBy: tx.userId, decidedAt: new Date() })
      .where(eq(aiProposals.id, id))
      .returning();
    await writeAudit(tx, { action: 'update', entityType: 'ai_proposal', entityId: id, oldValues: { status: 'pending' }, newValues: { status: 'rejected' } });
    return toView(updated);
  });
}

// ---------------------------------------------------------------------------
// Conversation loop
// ---------------------------------------------------------------------------

export interface AssistantTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

export interface AssistantReply {
  answer: string;
  toolCalls: ToolCallRecord[];
  proposals: ProposalView[];
  /** Money figures in the answer that do not appear in any tool result. */
  unverifiedNumbers: string[];
  mode: 'llm' | 'offline';
  providerId?: string;
  redacted?: boolean;
  notice?: string;
}

const MAX_STEPS = 6;
const toolNames = Object.keys(TOOLS) as [string, ...string[]];

const stepSchema = z
  .object({
    action: z.enum(['tool', 'answer']),
    tool: z.enum(toolNames).optional(),
    args: z.record(z.unknown()).optional(),
    answer: z.string().max(8000).optional(),
    proposal: z.unknown().optional(),
  })
  .refine((s) => (s.action === 'tool' ? !!s.tool : typeof s.answer === 'string' && s.answer.trim().length > 0), {
    message: 'action "tool" needs "tool"; action "answer" needs a non-empty "answer"',
  });

const stepJsonSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['tool', 'answer'] },
    tool: { type: 'string', enum: toolNames },
    args: { type: 'object' },
    answer: { type: 'string' },
    proposal: { type: 'object' },
  },
  required: ['action'],
};

function systemPrompt(today: string, ctx: Pick<ServiceContext, 'access'>): string {
  // Only the tools this person may use (the others would only answer "no permission").
  const tools = Object.entries(TOOLS)
    .filter(([, t]) => !ctx.access || can(ctx.access, t.area, 'view'))
    .map(([name, t]) => `- ${name}: ${t.description} Args: ${t.argsHelp}`)
    .join('\n');
  return `You are the bookkeeping assistant inside Ironbooks, a double-entry accounting app. Today is ${today}.

You answer questions about THIS company's books using ONLY these read-only tools (computed locally from the ledger):
${tools}

Protocol — every reply is ONE JSON object, nothing else:
  To call a tool:  {"action":"tool","tool":"<name>","args":{...}}
  To answer:       {"action":"answer","answer":"<plain-language answer>"}
After each tool call you receive a message starting with TOOL_RESULT.

Rules:
- Never invent or estimate numbers. Every figure in your answer must appear in a TOOL_RESULT; cite the tool in brackets, e.g. "Net income was $4,210.00 [profit_and_loss]".
- If the tools cannot answer, say so.
- You cannot change any data. If the user asks you to record something (e.g. a journal entry), call list_accounts first, then answer with an explanation AND a "proposal" field:
  {"action":"answer","answer":"...","proposal":{"type":"journal_entry","date":"YYYY-MM-DD","description":"...","lines":[{"accountCode":"6000","debit":"100.00"},{"accountCode":"1000","credit":"100.00"}]}}
  Debits must equal credits. A line on Accounts Receivable needs "name": "<customer name>" and a line on Accounts Payable needs "name": "<vendor name>". The user reviews and approves proposals; say that it awaits their approval.
- Keep answers short and clear for a non-accountant. Use YYYY-MM-DD dates in tool args.`;
}

/** Normalized 2dp strings for every number appearing in a JSON value. */
function collectNumbers(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.add(Money.abs(value).toFixed(2));
  } else if (typeof value === 'string') {
    const s = value.replace(/[$,]/g, '').trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) out.add(Money.abs(s).toFixed(2));
  } else if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectNumbers(v, out);
  }
  return out;
}

/** Money-looking figures in prose: "$1,234.56", "1234.56", "(500.00)". */
export function findUnverifiedNumbers(answer: string, toolResults: unknown[], extra: unknown[] = []): string[] {
  const known = collectNumbers([...toolResults, ...extra]);
  const out: string[] = [];
  for (const m of answer.matchAll(/\$?\(?-?\d{1,3}(?:,\d{3})+(?:\.\d{2})?\)?|\$?\(?-?\d+\.\d{2}\)?|\$\d+/g)) {
    const norm = Money.abs(m[0].replace(/[$,()]/g, '')).toFixed(2);
    if (!known.has(norm) && !out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

export interface AskOptions extends BuildRouterOptions {
  today?: Date;
}

/** Answer one user message given prior turns. */
export async function ask(
  ctx: ServiceContext,
  history: AssistantTurn[],
  message: string,
  opts: AskOptions = {},
): Promise<AssistantReply> {
  const question = message.trim();
  if (!question) throw validation('Ask a question.');
  if (question.length > 4000) throw validation('Question is too long (4,000 characters max).');
  // The company's calendar day (its time zone), not the UTC one — see companyToday.
  const todayDate = opts.today ?? (await companyToday(ctx));
  const today = todayDate.toISOString().slice(0, 10);

  const router = await buildRouter(ctx, opts);
  if (!router.isAvailable('assistant')) {
    const reply = await offlineAnswer(ctx, question, todayDate);
    return { ...reply, notice: router.unavailableReason('assistant') ?? undefined };
  }

  const convo = [
    { role: 'system' as const, content: systemPrompt(today, ctx) },
    ...history.slice(-10).map((t) => ({ role: t.role, content: t.content.slice(0, 4000) })),
    { role: 'user' as const, content: question },
  ];
  const toolCalls: ToolCallRecord[] = [];
  let providerId: string | undefined;
  let redacted = false;

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const forceAnswer = step === MAX_STEPS - 1;
      if (forceAnswer) convo.push({ role: 'user', content: 'Answer now with {"action":"answer",...} using the results you have.' });
      const res = await router.chatJson('assistant', convo, stepSchema, { jsonSchema: stepJsonSchema, temperature: 0.1, maxTokens: 1500 });
      providerId = res.providerId;
      redacted = redacted || res.redacted;
      const s = res.data;

      if (s.action === 'tool' && !forceAnswer) {
        const call: ToolCallRecord = { tool: s.tool!, args: s.args ?? {} };
        try {
          call.result = await runTool(ctx, s.tool!, s.args ?? {});
        } catch (err) {
          call.error = err instanceof Error ? err.message : String(err);
        }
        toolCalls.push(call);
        convo.push({ role: 'assistant', content: JSON.stringify({ action: 'tool', tool: s.tool, args: s.args ?? {} }) });
        convo.push({
          role: 'user',
          content: call.error
            ? `TOOL_RESULT ${s.tool} ERROR: ${call.error}`
            : `TOOL_RESULT ${s.tool}: ${JSON.stringify(call.result)}`,
        });
        continue;
      }

      let answer = (s.answer ?? '').trim();
      const proposals: ProposalView[] = [];
      if (s.proposal !== undefined && s.proposal !== null && ctx.role === 'viewer') {
        answer += '\n\n(Your role is view-only, so the proposed entry was not saved for approval.)';
      } else if (s.proposal !== undefined && s.proposal !== null) {
        try {
          proposals.push(await createJournalProposal(ctx, s.proposal, `Assistant proposal for: "${question.slice(0, 300)}"`));
        } catch (err) {
          answer += `\n\n(The proposed entry could not be prepared: ${err instanceof Error ? err.message : String(err)})`;
        }
      }
      const results = toolCalls.map((c) => c.result).filter((r) => r !== undefined);
      return {
        answer,
        toolCalls,
        proposals,
        unverifiedNumbers: findUnverifiedNumbers(answer, results, [proposals.map((p) => p.payload), question]),
        mode: 'llm',
        providerId,
        redacted,
      };
    }
  } catch (err) {
    if (!(err instanceof AiError)) throw err;
    // Model failed mid-conversation — fall back to the deterministic answer.
    const reply = await offlineAnswer(ctx, question, todayDate);
    return { ...reply, notice: `AI model unavailable (${err.message}). Showing a basic answer instead.` };
  }
  throw new ServiceError('INTERNAL', 'Assistant did not produce an answer.');
}

// ---------------------------------------------------------------------------
// Offline (no model) mode
// ---------------------------------------------------------------------------

function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}

/** Interpret simple period phrases; default year-to-date. */
export function periodFromText(text: string, today: Date): { from: string; to: string; label: string } {
  const t = text.toLowerCase();
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  if (/last\s+year|prior\s+year/.test(t)) return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, label: `${y - 1}` };
  if (/last\s+month|previous\s+month/.test(t)) {
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 0));
    return { from: iso(start), to: iso(end), label: 'last month' };
  }
  if (/this\s+month|month\s+to\s+date|mtd/.test(t)) return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(today), label: 'this month' };
  if (/last\s+quarter/.test(t)) {
    const q = Math.floor(m / 3);
    const start = new Date(Date.UTC(y, (q - 1) * 3, 1));
    const end = new Date(Date.UTC(y, q * 3, 0));
    return { from: iso(start), to: iso(end), label: 'last quarter' };
  }
  if (/this\s+quarter|qtd/.test(t)) {
    const q = Math.floor(m / 3);
    return { from: iso(new Date(Date.UTC(y, q * 3, 1))), to: iso(today), label: 'this quarter' };
  }
  return { from: `${y}-01-01`, to: iso(today), label: 'year to date' };
}

async function offlineAnswer(ctx: ServiceContext, q: string, today: Date): Promise<AssistantReply> {
  try {
    return await offlineAnswerInner(ctx, q, today);
  } catch (err) {
    // A question about a report this member may not open: say so instead of failing the request.
    if (err instanceof ServiceError && err.code === 'FORBIDDEN') {
      return { answer: err.message, toolCalls: [], proposals: [], unverifiedNumbers: [], mode: 'offline' };
    }
    throw err;
  }
}

async function offlineAnswerInner(ctx: ServiceContext, q: string, today: Date): Promise<AssistantReply> {
  const t = q.toLowerCase();
  const toolCalls: ToolCallRecord[] = [];
  const call = async (tool: string, args: Record<string, unknown>) => {
    const result = await runTool(ctx, tool, args);
    toolCalls.push({ tool, args, result });
    return result as Record<string, unknown>;
  };
  const fc = (v: string) => formatCurrency(v);
  let answer: string;

  if (/receivable|\bar\b|owe[s]? (us|me)|outstanding invoices|overdue invoices/.test(t)) {
    const r = (await call('ar_aging', {})) as { customers: { name: string; total: string }[]; totals: { total: string; current: string } };
    const top = r.customers.slice(0, 5).map((c) => `${c.name} ${fc(c.total)}`).join(', ');
    answer = `Customers owe ${fc(r.totals.total)} in total (${fc(r.totals.current)} not yet due) [ar_aging].${top ? ` Largest balances: ${top}.` : ''}`;
  } else if (/payable|\bap\b|we owe|bills (due|outstanding)|unpaid bills/.test(t)) {
    const r = (await call('ap_aging', {})) as { vendors: { name: string; total: string }[]; totals: { total: string; current: string } };
    const top = r.vendors.slice(0, 5).map((c) => `${c.name} ${fc(c.total)}`).join(', ');
    answer = `You owe vendors ${fc(r.totals.total)} in total (${fc(r.totals.current)} not yet due) [ap_aging].${top ? ` Largest: ${top}.` : ''}`;
  } else if (/balance sheet|assets|liabilit|equity|net worth/.test(t)) {
    const r = (await call('balance_sheet', { asOf: iso(today) })) as { totalAssets: string; totalLiabilities: string; totalEquity: string };
    answer = `As of ${iso(today)}: total assets ${fc(r.totalAssets)}, total liabilities ${fc(r.totalLiabilities)}, total equity ${fc(r.totalEquity)} [balance_sheet].`;
  } else if (/profit|loss|p&l|p ?and ?l|net income|revenue|income|sales|expenses|spend/.test(t)) {
    const p = periodFromText(t, today);
    const r = (await call('profit_and_loss', { from: p.from, to: p.to })) as {
      totalIncome: string; totalExpenses: string; netIncome: string; expenses: { name: string; amount: string }[];
    };
    const topExp = [...r.expenses].sort((a, b) => Money.of(b.amount).comparedTo(Money.of(a.amount))).slice(0, 3);
    answer =
      `For ${p.label} (${p.from} to ${p.to}): income ${fc(r.totalIncome)}, expenses ${fc(r.totalExpenses)}, net income ${fc(r.netIncome)} [profit_and_loss].` +
      (topExp.length ? ` Biggest expenses: ${topExp.map((e) => `${e.name} ${fc(e.amount)}`).join(', ')}.` : '');
  } else if (/cash|bank|balance of|how much (is|do we have) in/.test(t)) {
    const r = (await call('account_balances', {})) as { accounts: { code: string; name: string; type: string; balance: string }[] };
    const cashish = r.accounts.filter((a) => a.type === 'asset' && /cash|check|saving|bank|money market|petty/i.test(a.name));
    const list = (cashish.length ? cashish : r.accounts.filter((a) => a.type === 'asset')).slice(0, 8);
    answer = list.length
      ? `Current balances: ${list.map((a) => `${a.code} ${a.name} ${fc(a.balance)}`).join('; ')} [account_balances].`
      : 'No asset account activity yet [account_balances].';
  } else {
    const words = q.replace(/[^\w\s.-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !/^(what|show|find|the|and|for|with|from|did|was|were|how|much|many|our|any|all)$/i.test(w));
    const r = (await call('search_transactions', { query: words.slice(0, 3).join(' ') || undefined, limit: 10 })) as {
      entries: { entryNumber: number; date: string; description: string; lines: { debit: string | null }[] }[];
    };
    answer = r.entries.length
      ? `Found ${r.entries.length} matching transaction(s) [search_transactions]: ` +
        r.entries
          .slice(0, 10)
          .map((e) => `#${e.entryNumber} ${e.date} ${e.description} (${fc(toAmountString(Money.add(...e.lines.map((l) => l.debit))))})`)
          .join('; ') + '.'
      : 'I could not find matching transactions. Try asking about profit & loss, balance sheet, receivables, payables, or cash balances.';
  }
  return { answer, toolCalls, proposals: [], unverifiedNumbers: [], mode: 'offline' };
}
