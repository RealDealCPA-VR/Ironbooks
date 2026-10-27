/**
 * QuickBooks General Ledger migration — brings a QB Desktop General Ledger report (Excel .xlsx,
 * CSV, or PDF) into the company file AS PART OF THE RECORD, reconciled to the penny.
 *
 *   previewGlImport()  parse + analyse (qbGlParse.ts) and suggest how each QB account maps onto
 *                      the chart of accounts (existing account by number/name, or create new).
 *   runGlImport()      in ONE database transaction: create accounts (numbers + 'Parent:Child'
 *                      hierarchy), classes, customers/vendors/employees; post the opening
 *                      balances as one entry dated the day before the period; post every
 *                      rebuilt transaction through postJournalEntry with sourceRef
 *                      'qbgl:<hash>:<n>' (re-importing the same report posts nothing new); then
 *                      prove the result: every mapped account's imported balance as of the period
 *                      end must equal the report's ending balance (and the optional QB Trial
 *                      Balance), and the ledger's debits must equal its credits. Any difference
 *                      rolls the whole transaction back — unless the user explicitly accepted
 *                      posting the variance to a 'QB Import Suspense' account for review.
 *                      `dryRun` performs the exact same work and always rolls back.
 *   listGlImports()    past imports with their stored proof (qb_gl_imports).
 *
 * Nothing is ever forced: transactions whose lines can't be matched into a balanced entry are
 * returned for review and never posted; they show up in the proof as differences.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, like, lte, sql } from 'drizzle-orm';
import type Decimal from 'decimal.js';
import {
  accounts,
  classes as classesTable,
  customers as customersTable,
  employees as employeesTable,
  journalEntries,
  journalEntryLines,
  qbGlImports,
  vendors as vendorsTable,
} from '@/lib/db/schema';
import { Money, toAmountString } from '@/lib/money';
import { withPlannerStats } from '@/lib/db/plannerStats';
import { type ServiceContext, ServiceError, inTransaction, validation, writeAudit } from './_base';
import { createAccount } from './accounts';
import { createCustomer } from './customers';
import { createClass } from './dimensions';
import { createEmployee } from './payroll';
import { postJournalEntry, type PostingLine } from './posting';
import { createVendor } from './vendors';
import { controlSideOfAccount, loadQbNameResolver, type QbNameRole } from './qbNameResolver';
import { loadGrid } from './qbGlFiles';
import { dataExceptionMessage, isDataException } from './qbImportErrors';
import {
  QB_ACCOUNT_TYPES,
  analyzeGl,
  dayBefore,
  parseGlSheets,
  parseReferenceIif,
  parseReferenceSheets,
  toBookkeeperType,
  type GlAccountView,
  type GlAnalysis,
  type GlReviewItem,
  type QbAccountType,
  type ReferenceData,
} from './qbGlParse';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface GlUploadFile {
  name: string;
  /** File bytes, base64-encoded. */
  data: string;
}

export interface GlAccountChoice {
  qbType?: QbAccountType;
  /** 'new' to create the account, or the id of an existing account to post into. */
  mapTo?: string;
}

export interface GlImportInput {
  file: GlUploadFile;
  /** Optional QB Account List / Trial Balance / IIF chart exports. */
  references?: GlUploadFile[];
  periodStart?: string | null;
  periodEnd?: string | null;
  accounts?: Record<string, GlAccountChoice>;
  /** Post any difference to 'QB Import Suspense' instead of rolling back. */
  acceptVariance?: boolean;
}

/** Max decoded size per file (the app is local; this only guards against mistakes). */
const MAX_FILE_BYTES = 60 * 1024 * 1024;

function decodeFile(f: GlUploadFile): Uint8Array {
  if (!f || typeof f.data !== 'string' || !f.data) throw validation(`File "${f?.name ?? ''}" is empty.`);
  const buf = Buffer.from(f.data.replace(/^data:[^,]*,/, ''), 'base64');
  if (!buf.length) throw validation(`File "${f.name}" is empty.`);
  if (buf.length > MAX_FILE_BYTES) throw validation(`File "${f.name}" is larger than 60 MB.`);
  return new Uint8Array(buf);
}

/** Read the GL report and the optional reference files. */
export async function loadGlSources(
  input: Pick<GlImportInput, 'file' | 'references'>,
): Promise<{ report: ReturnType<typeof parseGlSheets>; reference: ReferenceData | null; format: string }> {
  const glBytes = decodeFile(input.file);
  const gl = await loadGrid(glBytes, input.file.name);
  if (gl.kind === 'iif') {
    throw validation(
      'This is an IIF file. IIF lists go in step 1 ("Lists"). For the General Ledger, export the GL report to Excel, CSV, or PDF.',
    );
  }
  const report = parseGlSheets(gl.sheets);

  let reference: ReferenceData | null = null;
  for (const ref of input.references ?? []) {
    const bytes = decodeFile(ref);
    const loaded = await loadGrid(bytes, ref.name, (cells) => {
      const s = new Set(cells.map((c) => c.trim().toLowerCase()));
      return (s.has('account') && s.has('type')) || (s.has('debit') && s.has('credit'));
    });
    const parsed = loaded.kind === 'iif' ? parseReferenceIif(loaded.text ?? '') : parseReferenceSheets(loaded.sheets);
    // Merge several references (e.g. Account List for types + Trial Balance for balances).
    if (!reference) reference = parsed;
    else {
      reference = {
        kind: reference.kind === 'trial-balance' || parsed.kind === 'trial-balance' ? 'trial-balance' : reference.kind,
        asOf: reference.asOf ?? parsed.asOf,
        accounts: [...reference.accounts, ...parsed.accounts],
      };
    }
  }
  return { report, reference, format: gl.kind };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface ExistingAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  parentId: string | null;
}

export interface GlPreviewAccount extends GlAccountView {
  bkType: string;
  bkSubtype: string;
  /** Suggested existing account (same number+name, or same name and type). */
  match: { accountId: string; code: string; name: string; reason: string } | null;
  /** Effective choice: 'new' or an existing account id. */
  mapTo: string;
}

export interface GlPreview {
  format: string;
  meta: GlAnalysis['meta'];
  accounts: GlPreviewAccount[];
  totals: GlAnalysis['totals'];
  stats: GlAnalysis['stats'];
  review: GlReviewItem[];
  names: { customers: number; vendors: number; employees: number; other: number; list: GlAnalysis['names'] };
  classes: string[];
  reference: GlAnalysis['reference'];
  tbUnmatched: GlAnalysis['tbUnmatched'];
  errors: string[];
  warnings: string[];
  existingAccounts: ExistingAccount[];
  qbTypes: readonly string[];
  /** Posted entries already in the file that did NOT come from a GL import. */
  otherPostedEntries: number;
  /** Rebuilt transactions already imported earlier (same sourceRef). */
  alreadyImported: number;
}

async function loadExistingAccounts(ctx: ServiceContext): Promise<ExistingAccount[]> {
  const rows = await ctx.db
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      parentId: accounts.parentId,
    })
    .from(accounts)
    .where(eq(accounts.companyId, ctx.companyId));
  return rows.map((r) => ({ ...r, type: String(r.type), subtype: String(r.subtype) }));
}

/** Suggest an existing account for a QB account: same number+name, else same name and type. */
function suggestMatch(
  a: GlAccountView,
  bkType: string,
  existing: ExistingAccount[],
): GlPreviewAccount['match'] {
  const lname = a.name.trim().toLowerCase();
  const fullLower = a.fullName.toLowerCase();
  if (a.number) {
    const byNum = existing.find((e) => e.code === a.number && e.name.trim().toLowerCase() === lname);
    if (byNum) return { accountId: byNum.id, code: byNum.code, name: byNum.name, reason: 'same number and name' };
  }
  const byName = existing.filter(
    (e) => (e.name.trim().toLowerCase() === lname || e.name.trim().toLowerCase() === fullLower) && e.type === bkType,
  );
  if (byName.length === 1) {
    return { accountId: byName[0].id, code: byName[0].code, name: byName[0].name, reason: 'same name and type' };
  }
  return null;
}

interface Prepared {
  format: string;
  analysis: GlAnalysis;
  existing: ExistingAccount[];
  accounts: GlPreviewAccount[];
}

async function prepare(ctx: ServiceContext, input: GlImportInput): Promise<Prepared> {
  const { report, reference, format } = await loadGlSources(input);
  const choices = input.accounts ?? {};
  const typeOverrides: Record<string, QbAccountType> = {};
  for (const [key, c] of Object.entries(choices)) {
    if (c?.qbType) {
      if (!QB_ACCOUNT_TYPES.includes(c.qbType)) throw validation(`Unknown QuickBooks account type "${c.qbType}".`);
      typeOverrides[key] = c.qbType;
    }
  }
  const analysis = analyzeGl(report, {
    reference,
    typeOverrides,
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
  });
  const existing = await loadExistingAccounts(ctx);
  const existingIds = new Set(existing.map((e) => e.id));
  const mapped = analysis.accounts.map((a) => {
    const bk = toBookkeeperType(a.qbType, a.name);
    const match = suggestMatch(a, bk.type, existing);
    const chosen = choices[a.key]?.mapTo;
    let mapTo = match ? match.accountId : 'new';
    if (chosen === 'new') mapTo = 'new';
    else if (chosen) {
      if (!existingIds.has(chosen)) throw validation(`"${a.fullName}" is mapped to an account that doesn't exist.`);
      mapTo = chosen;
    }
    return { ...a, bkType: bk.type, bkSubtype: bk.subtype, match, mapTo };
  });
  for (const a of mapped) {
    if (a.mapTo === 'new') continue;
    const target = existing.find((e) => e.id === a.mapTo)!;
    if (target.type !== a.bkType) {
      analysis.warnings.push(
        `"${a.fullName}" (${a.qbType}) is mapped to "${target.code} ${target.name}", which is a ${target.type} account.`,
      );
    }
  }
  return { format, analysis, existing, accounts: mapped };
}

export async function previewGlImport(ctx: ServiceContext, input: GlImportInput): Promise<GlPreview> {
  const p = await prepare(ctx, input);
  const { analysis } = p;
  const [other] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        sql`(${journalEntries.sourceRef} IS NULL OR ${journalEntries.sourceRef} NOT LIKE 'qbgl:%')`,
      ),
    );
  const already = await existingRefs(ctx, analysis.transactions.map((t) => t.ref));
  const count = (role: string) => analysis.names.filter((n) => n.role === role).length;
  if ((other?.n ?? 0) > 0) {
    analysis.warnings.push(
      `This company file already has ${other!.n} posted transaction(s) that did not come from a General Ledger import. The proof only checks what this import brings in; if those transactions cover the same period, balances will be counted twice.`,
    );
  }
  return {
    format: p.format,
    meta: analysis.meta,
    accounts: p.accounts,
    totals: analysis.totals,
    stats: analysis.stats,
    review: analysis.review,
    names: {
      customers: count('customer'),
      vendors: count('vendor'),
      employees: count('employee'),
      other: count('other'),
      list: analysis.names,
    },
    classes: analysis.classes,
    reference: analysis.reference,
    tbUnmatched: analysis.tbUnmatched,
    errors: analysis.errors,
    warnings: analysis.warnings,
    existingAccounts: p.existing,
    qbTypes: QB_ACCOUNT_TYPES,
    otherPostedEntries: other?.n ?? 0,
    alreadyImported: already.size,
  };
}

/** sourceRefs (of non-void entries) that already exist in this company. */
async function existingRefs(ctx: ServiceContext, refs: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < refs.length; i += 500) {
    const chunk = refs.slice(i, i + 500);
    if (!chunk.length) continue;
    const rows = await ctx.db
      .select({ ref: journalEntries.sourceRef })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          inArray(journalEntries.sourceRef, chunk),
          sql`${journalEntries.status} <> 'void'`,
        ),
      );
    for (const r of rows) if (r.ref) found.add(r.ref);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface GlProofRow {
  accountId: string;
  code: string;
  name: string;
  /** QB accounts (full names) mapped into this account. */
  qbAccounts: string[];
  /** Report ending balance (debit-positive). */
  expected: string;
  /** Balance of everything imported from QB GL reports, as of the period end. */
  actual: string;
  difference: string;
  /** QB Trial Balance figure, when a TB export was supplied. */
  trialBalance: string | null;
  trialBalanceDifference: string | null;
}

export interface GlProof {
  asOf: string;
  rows: GlProofRow[];
  allMatch: boolean;
  mismatches: number;
  trialBalanceCompared: boolean;
  trialBalanceMatches: boolean;
  /** Whole company ledger as of the period end. */
  ledger: { debits: string; credits: string; balanced: boolean };
  /** Balance of 'QB Import Suspense' (debit-positive), when it exists. */
  suspense: string | null;
  tbUnmatched: GlAnalysis['tbUnmatched'];
}

export interface GlImportResult {
  ok: boolean;
  dryRun: boolean;
  rolledBack: boolean;
  message: string;
  proof: GlProof;
  counts: {
    accountsCreated: number;
    accountsMapped: number;
    classesCreated: number;
    customersCreated: number;
    vendorsCreated: number;
    employeesCreated: number;
    entriesPosted: number;
    entriesAlreadyImported: number;
    openingEntryPosted: boolean;
    reviewItems: number;
  };
  review: GlReviewItem[];
  /** Amount moved to 'QB Import Suspense' (absolute total of the variance lines), if any. */
  variancePosted: string | null;
  importId: string | null;
  warnings: string[];
}

/** Thrown inside the import transaction to roll it back while returning a result. */
class Rollback extends Error {
  constructor(public result: GlImportResult) {
    super('rollback');
  }
}

export const QB_SUSPENSE = { code: 'QB-SUSPENSE', name: 'QB Import Suspense' } as const;

const utcDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const endOfDay = (iso: string) => new Date(`${iso}T23:59:59.999Z`);

function sanitiseCode(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .toUpperCase()
    .slice(0, 20);
}

function splitPersonName(raw: string): { firstName: string; lastName: string } {
  // Same convention as the IIF importer: QB writes "Last, First" (or "First Last").
  if (raw.includes(',')) {
    const [last, first] = raw.split(',').map((s) => s.trim());
    return { firstName: first || last, lastName: last };
  }
  const parts = raw.trim().split(/\s+/);
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') || parts[0] };
}

/** Sum of imported (qbgl:*) postings per account, debit-positive, up to `asOf` inclusive. */
async function importedBalances(ctx: ServiceContext, asOf: Date, onlyImported = true): Promise<Map<string, Decimal>> {
  const rows = await ctx.db
    .select({
      accountId: journalEntryLines.accountId,
      dr: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      cr: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        onlyImported ? like(journalEntries.sourceRef, 'qbgl:%') : undefined,
        lte(journalEntries.date, asOf),
      ),
    )
    .groupBy(journalEntryLines.accountId);
  return new Map(rows.map((r) => [r.accountId, Money.of(r.dr).minus(Money.of(r.cr))]));
}

/** Total debits and credits of the whole ledger (all posted entries) up to `asOf`. */
async function ledgerTotals(ctx: ServiceContext, asOf: Date) {
  const [row] = await ctx.db
    .select({
      dr: sql<string>`COALESCE(SUM(${journalEntryLines.debit}), 0)`,
      cr: sql<string>`COALESCE(SUM(${journalEntryLines.credit}), 0)`,
    })
    .from(journalEntryLines)
    .innerJoin(journalEntries, eq(journalEntryLines.journalEntryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        eq(journalEntries.status, 'posted'),
        lte(journalEntries.date, asOf),
      ),
    );
  return { dr: Money.of(row?.dr), cr: Money.of(row?.cr) };
}

export async function runGlImport(
  ctx: ServiceContext,
  input: GlImportInput,
  opts: { dryRun?: boolean } = {},
): Promise<GlImportResult> {
  if (opts.dryRun) return runGlImportUnanalyzed(ctx, input, opts);
  // A bulk load: fresh planner statistics afterwards (PGlite has no autovacuum; best-effort).
  return withPlannerStats(ctx.db, 'GL import', () => runGlImportUnanalyzed(ctx, input, opts));
}

async function runGlImportUnanalyzed(
  ctx: ServiceContext,
  input: GlImportInput,
  opts: { dryRun?: boolean },
): Promise<GlImportResult> {
  const dryRun = !!opts.dryRun;
  const p = await prepare(ctx, input);
  const { analysis } = p;
  if (analysis.errors.length) {
    throw new ServiceError(
      'VALIDATION',
      `The report can't be imported yet: ${analysis.errors[0]}${analysis.errors.length > 1 ? ` (and ${analysis.errors.length - 1} more problem(s))` : ''}`,
      { errors: analysis.errors },
    );
  }
  const periodEnd = analysis.meta.periodEnd;
  const periodStart = analysis.meta.periodStart;
  if (!periodEnd) throw validation('The report period end date is unknown. Enter it and try again.');

  try {
    return await inTransaction(ctx, async (tx) => {
      const warnings = [...analysis.warnings];
      const counts: GlImportResult['counts'] = {
        accountsCreated: 0,
        accountsMapped: 0,
        classesCreated: 0,
        customersCreated: 0,
        vendorsCreated: 0,
        employeesCreated: 0,
        entriesPosted: 0,
        entriesAlreadyImported: 0,
        openingEntryPosted: false,
        reviewItems: analysis.review.length,
      };

      // ---- 1. Chart of accounts ------------------------------------------------
      const bkIdOf = new Map<string, string>(); // GL key → Ironbooks account id
      const bkTypeOf = new Map<string, string>();
      const takenCodes = new Set(p.existing.map((e) => e.code));
      const typeById = new Map(p.existing.map((e) => [e.id, e.type]));
      const pickCode = (a: GlPreviewAccount): string => {
        const candidates = [a.number, a.number ? `${a.number}-QB` : null, sanitiseCode(a.name) || 'QB-ACCT'];
        for (const c of candidates) if (c && !takenCodes.has(c)) return c;
        const base = (a.number ?? sanitiseCode(a.name) ?? 'QB').slice(0, 16) || 'QB';
        for (let n = 2; n < 10000; n++) if (!takenCodes.has(`${base}-${n}`)) return `${base}-${n}`;
        throw validation(`No free account code for "${a.fullName}".`);
      };
      const ordered = [...p.accounts].sort((x, y) => x.depth - y.depth || x.order - y.order);
      for (const a of ordered) {
        if (a.mapTo !== 'new') {
          bkIdOf.set(a.key, a.mapTo);
          bkTypeOf.set(a.key, typeById.get(a.mapTo) ?? a.bkType);
          counts.accountsMapped++;
          continue;
        }
        const code = pickCode(a);
        if (a.number && code !== a.number) {
          warnings.push(`Account number ${a.number} is already used, so "${a.fullName}" was created as ${code}.`);
        }
        const parentId = a.parentKey ? bkIdOf.get(a.parentKey) ?? null : null;
        const parentOk = parentId && (bkTypeOf.get(a.parentKey!) ?? '') === a.bkType;
        if (parentId && !parentOk) {
          warnings.push(`"${a.fullName}" was created at the top level because its parent is a different account type.`);
        }
        const row = await createAccount(tx, {
          code,
          name: a.name,
          type: a.bkType as never,
          subtype: a.bkSubtype,
          parentId: parentOk ? parentId : null,
          description: `Imported from QuickBooks (${a.qbType}: ${a.label})`,
        });
        takenCodes.add(code);
        bkIdOf.set(a.key, row.id);
        bkTypeOf.set(a.key, a.bkType);
        counts.accountsCreated++;
      }

      // ---- 2. Classes ('Parent:Child') -----------------------------------------
      const classRows = await tx.db
        .select({ id: classesTable.id, name: classesTable.name, parentId: classesTable.parentId })
        .from(classesTable)
        .where(eq(classesTable.companyId, tx.companyId));
      const classIdOf = new Map<string, string>(); // full path (lowercase) → id
      const pathOfClass = (id: string, seen = new Set<string>()): string => {
        const c = classRows.find((r) => r.id === id);
        if (!c || seen.has(id)) return '';
        seen.add(id);
        return c.parentId ? `${pathOfClass(c.parentId, seen)}:${c.name}` : c.name;
      };
      for (const c of classRows) classIdOf.set(pathOfClass(c.id).toLowerCase(), c.id);
      for (const full of analysis.classes) {
        const segs = full.split(':').map((s) => s.trim()).filter(Boolean);
        let path = '';
        let parentId: string | null = null;
        for (const seg of segs) {
          path = path ? `${path}:${seg}` : seg;
          let id = classIdOf.get(path.toLowerCase());
          if (!id) {
            const created = await createClass(tx, { name: seg, parentId });
            id = created.id;
            classIdOf.set(path.toLowerCase(), id);
            classRows.push({ id, name: seg, parentId });
            counts.classesCreated++;
          }
          parentId = id;
        }
      }
      const classIdFor = (name: string) =>
        name ? classIdOf.get(name.split(':').map((s) => s.trim()).join(':').toLowerCase()) ?? null : null;

      // ---- 3. Names → customers / vendors / employees ----------------------------
      const custRows = await tx.db
        .select({ id: customersTable.id, name: customersTable.displayName })
        .from(customersTable)
        .where(eq(customersTable.companyId, tx.companyId));
      const vendRows = await tx.db
        .select({ name: vendorsTable.displayName })
        .from(vendorsTable)
        .where(eq(vendorsTable.companyId, tx.companyId));
      const empRows = await tx.db
        .select({ first: employeesTable.firstName, last: employeesTable.lastName })
        .from(employeesTable)
        .where(eq(employeesTable.companyId, tx.companyId));
      const custByName = new Map(custRows.map((c) => [c.name.toLowerCase(), c.id]));
      const vendSet = new Set(vendRows.map((v) => v.name.toLowerCase()));
      const anyList = new Set([...custRows.map((c) => c.name.toLowerCase()), ...vendSet]);
      const empKey = (f: string, l: string) => `${f} ${l}`.toLowerCase();
      const empSet = new Set(empRows.map((e) => empKey(e.first, e.last)));
      const tryCreate = async (label: string, fn: () => Promise<unknown>): Promise<boolean> => {
        try {
          await fn();
          return true;
        } catch (err) {
          if (err instanceof ServiceError && err.code === 'VALIDATION') {
            warnings.push(`${label} was not added to your lists: ${err.message}`);
            return false;
          }
          throw err;
        }
      };
      const ensureCustomer = async (full: string): Promise<string | null> => {
        const existingId = custByName.get(full.toLowerCase());
        if (existingId) return existingId;
        const segs = full.split(':').map((s) => s.trim()).filter(Boolean);
        const parentId = segs.length > 1 ? await ensureCustomer(segs.slice(0, -1).join(':')) : null;
        let id: string | null = null;
        const ok = await tryCreate(`Customer "${full}"`, async () => {
          const row = await createCustomer(tx, { displayName: full, parentId });
          id = row.id;
        });
        if (ok && id) {
          custByName.set(full.toLowerCase(), id);
          anyList.add(full.toLowerCase());
          counts.customersCreated++;
        }
        return id;
      };
      const ensureVendor = async (name: string) => {
        const lower = name.toLowerCase();
        if (vendSet.has(lower)) return;
        if (await tryCreate(`Vendor "${name}"`, () => createVendor(tx, { displayName: name }))) {
          vendSet.add(lower);
          anyList.add(lower);
          counts.vendorsCreated++;
        }
      };
      // Every A/R line carries a customer and every A/P line a vendor (QB's rule, and what aging,
      // statements and QuickReports read). The list a name goes to is decided by the account it
      // sits on in THIS file (after the mapping step), not by a guess from transaction types: a
      // customer that only appears on General Journal or refund-check lines, or a name that
      // already exists on the other list, still gets the customer / vendor record its line needs.
      const controlKind = new Map<string, 'ar' | 'ap' | null>();
      for (const a of p.accounts) {
        const id = bkIdOf.get(a.key)!;
        const ex = p.existing.find((e) => e.id === id);
        controlKind.set(a.key, controlSideOfAccount(ex ?? { type: a.bkType, subtype: a.bkSubtype }));
      }
      const controlNames = new Map<string, { name: string; ar: boolean; ap: boolean }>();
      for (const t of analysis.transactions) {
        for (const l of t.lines) {
          const side = controlKind.get(l.accountKey);
          const raw = side ? (l.name || t.name).trim() : '';
          if (!raw) continue;
          const c = controlNames.get(raw.toLowerCase()) ?? { name: raw, ar: false, ap: false };
          c[side!] = true;
          controlNames.set(raw.toLowerCase(), c);
        }
      }
      for (const c of controlNames.values()) {
        if (c.ar && !custByName.has(c.name.toLowerCase())) await ensureCustomer(c.name);
        if (c.ap) await ensureVendor(c.name);
      }
      for (const n of analysis.names) {
        const lower = n.name.toLowerCase();
        if (controlNames.has(lower)) continue; // handled above
        if (n.role === 'customer') {
          if (!anyList.has(lower)) await ensureCustomer(n.name);
        } else if (n.role === 'vendor') {
          if (!anyList.has(lower)) await ensureVendor(n.name);
        } else if (n.role === 'employee') {
          const { firstName, lastName } = splitPersonName(n.name);
          if (!empSet.has(empKey(firstName, lastName))) {
            if (
              await tryCreate(`Employee "${n.name}"`, () =>
                createEmployee(tx, { firstName, lastName, payType: 'hourly', payRate: 0 }),
              )
            ) {
              empSet.add(empKey(firstName, lastName));
              counts.employeesCreated++;
            }
          }
        }
      }

      // ---- 4. Opening balances ---------------------------------------------------
      // Post only what is not already in the books from an earlier GL import (so importing
      // consecutive periods — or the same report twice — never doubles a balance).
      const expectedBegin = new Map<string, Decimal>();
      const expectedEnd = new Map<string, Decimal>();
      const qbNamesOf = new Map<string, string[]>();
      for (const a of p.accounts) {
        const id = bkIdOf.get(a.key)!;
        expectedBegin.set(id, (expectedBegin.get(id) ?? Money.zero()).plus(a.beginning));
        expectedEnd.set(id, (expectedEnd.get(id) ?? Money.zero()).plus(a.ending));
        qbNamesOf.set(id, [...(qbNamesOf.get(id) ?? []), a.fullName]);
      }
      const anyBeginning = [...expectedBegin.values()].some((v) => !v.isZero());
      if (anyBeginning) {
        if (!periodStart) throw validation('Enter the report start date so the opening balances can be dated.');
        const openDate = dayBefore(periodStart);
        const before = await importedBalances(tx, endOfDay(openDate));
        const lines: PostingLine[] = [];
        let net = Money.zero();
        for (const [id, target] of expectedBegin) {
          const delta = target.minus(before.get(id) ?? 0);
          if (delta.isZero()) continue;
          net = net.plus(delta);
          lines.push({
            accountId: id,
            debit: delta.isPositive() ? toAmountString(delta) : null,
            credit: delta.isNegative() ? toAmountString(delta.negated()) : null,
            memo: 'QuickBooks beginning balance',
          });
        }
        if (!net.isZero()) {
          throw new ServiceError(
            'UNBALANCED',
            `The opening balances would be out of balance by ${toAmountString(net)}. The books may already contain a General Ledger import that overlaps this period — import periods in date order, starting with the earliest.`,
          );
        }
        if (lines.length) {
          const ref = `qbgl:open:${openDate}:${lines.map((l) => `${l.accountId}=${l.debit ?? `-${l.credit}`}`).sort().join(',')}`;
          const sourceRef = `qbgl:open:${openDate}:${hashShort(ref)}`;
          await postJournalEntry(tx, {
            date: utcDate(openDate),
            description: `QuickBooks opening balances as of ${openDate}`,
            reference: 'QB-OPEN',
            lines,
            sourceRef,
          });
          counts.openingEntryPosted = true;
        }
      }

      // ---- 5. Transactions ---------------------------------------------------------
      // Each line carries its QB Name as the journal line's customer / vendor / employee / other
      // name (QB GL "Name" column), so Sales by Customer, Expenses by Vendor and QuickReports work
      // for migrated periods. A/R lines only take a customer, A/P lines only a vendor; an A/R or
      // A/P row without its own name takes the transaction's name.
      const names = await loadQbNameResolver(tx);
      const roleOf = new Map(analysis.names.map((n) => [n.name.toLowerCase(), n.role as QbNameRole]));
      const acctById = new Map((await loadExistingAccounts(tx)).map((a) => [a.id, a]));
      const nameFor = (accountId: string, lineName: string, txnName: string) => {
        const side = controlSideOfAccount(acctById.get(accountId));
        const raw = lineName || (side ? txnName : '');
        if (!raw) return {};
        const r = names.resolve(raw, { side, prefer: roleOf.get(raw.toLowerCase()) ?? null });
        return r ? { entityType: r.entityType, entityId: r.entityId } : {};
      };
      const already = await existingRefs(tx, analysis.transactions.map((t) => t.ref));
      for (const t of analysis.transactions) {
        if (already.has(t.ref)) {
          counts.entriesAlreadyImported++;
          continue;
        }
        const description = [
          `${t.type || 'Transaction'}${t.num ? ` #${t.num}` : ''}`,
          t.name ? ` — ${t.name}` : '',
          t.memo ? `: ${t.memo}` : '',
        ].join('');
        await postJournalEntry(tx, {
          date: utcDate(t.date),
          description,
          reference: t.num ? t.num.slice(0, 100) : null,
          sourceRef: t.ref,
          lines: t.lines.map((l) => ({
            accountId: bkIdOf.get(l.accountKey)!,
            ...nameFor(bkIdOf.get(l.accountKey)!, l.name, t.name),
            debit: Money.isZero(l.debit) ? null : l.debit,
            credit: Money.isZero(l.credit) ? null : l.credit,
            memo: [l.name && l.name !== t.name ? l.name : '', l.memo].filter(Boolean).join(' — ') || null,
            classId: classIdFor(l.className),
          })),
        });
        counts.entriesPosted++;
      }

      // ---- 6. Proof ------------------------------------------------------------------
      const asOf = endOfDay(periodEnd);
      const allBk = new Map((await loadExistingAccounts(tx)).map((a) => [a.id, a]));
      const tbOf = new Map<string, Decimal>();
      const tbCompared = analysis.reference?.kind === 'trial-balance';
      if (tbCompared) {
        for (const a of p.accounts) {
          const id = bkIdOf.get(a.key)!;
          tbOf.set(id, (tbOf.get(id) ?? Money.zero()).plus(a.tbBalance ?? 0));
        }
      }
      const buildProof = async (): Promise<GlProof> => {
        const actual = await importedBalances(tx, asOf);
        const rows: GlProofRow[] = [...expectedEnd.entries()].map(([id, exp]) => {
          const act = actual.get(id) ?? Money.zero();
          const acct = allBk.get(id)!;
          const tb = tbCompared ? tbOf.get(id) ?? Money.zero() : null;
          return {
            accountId: id,
            code: acct.code,
            name: acct.name,
            qbAccounts: qbNamesOf.get(id) ?? [],
            expected: toAmountString(exp),
            actual: toAmountString(act),
            difference: toAmountString(exp.minus(act)),
            trialBalance: tb ? toAmountString(tb) : null,
            trialBalanceDifference: tb ? toAmountString(tb.minus(act)) : null,
          };
        });
        rows.sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));
        const mismatches = rows.filter((r) => !Money.isZero(r.difference)).length;
        const tbMismatch =
          rows.some((r) => r.trialBalanceDifference !== null && !Money.isZero(r.trialBalanceDifference)) ||
          analysis.tbUnmatched.length > 0;
        const ledger = await ledgerTotals(tx, asOf);
        const suspenseRow = [...allBk.values()].find((a) => a.code === QB_SUSPENSE.code);
        const suspense = suspenseRow ? actual.get(suspenseRow.id) ?? Money.zero() : null;
        return {
          asOf: periodEnd,
          rows,
          allMatch: mismatches === 0,
          mismatches,
          trialBalanceCompared: tbCompared,
          trialBalanceMatches: tbCompared ? !tbMismatch : true,
          ledger: {
            debits: toAmountString(ledger.dr),
            credits: toAmountString(ledger.cr),
            balanced: ledger.dr.equals(ledger.cr),
          },
          suspense: suspense ? toAmountString(suspense) : null,
          tbUnmatched: analysis.tbUnmatched,
        };
      };
      let proof = await buildProof();
      let variancePosted: string | null = null;

      // A Trial Balance difference can't be "accepted": the ledger already equals the GL report, so a
      // TB that disagrees means the two exports don't describe the same books (date, basis, filters).
      const tbRollback = (): Rollback =>
        new Rollback({
          ok: false,
          dryRun,
          rolledBack: true,
          message: `Nothing was saved: your QuickBooks Trial Balance doesn't agree with the General Ledger report${proof.allMatch ? ', even though every account matches the General Ledger' : ''}. Make sure both reports are for the same date and the same basis (accrual or cash), with no filters, then try again — or import without the Trial Balance.`,
          proof,
          counts,
          review: analysis.review,
          variancePosted: null,
          importId: null,
          warnings,
        });

      if (!proof.allMatch && !input.acceptVariance) {
        const what = `${proof.mismatches} account(s) don't match the report`;
        throw new Rollback({
          ok: false,
          dryRun,
          rolledBack: true,
          message: `Nothing was saved: ${what}. Review the differences${analysis.review.length ? ` and the ${analysis.review.length} transaction(s) that couldn't be matched` : ''}, or choose to post the difference to "${QB_SUSPENSE.name}" so you can sort it out later.`,
          proof,
          counts,
          review: analysis.review,
          variancePosted: null,
          importId: null,
          warnings,
        });
      }
      if (!proof.allMatch && input.acceptVariance) {
        // The user explicitly accepted: move each difference to the suspense account.
        let suspense = [...allBk.values()].find((a) => a.code === QB_SUSPENSE.code);
        if (!suspense) {
          const created = await createAccount(tx, {
            code: QB_SUSPENSE.code,
            name: QB_SUSPENSE.name,
            type: 'equity',
            subtype: 'owners_equity',
            description: 'Differences accepted during a QuickBooks General Ledger import. Review and reclassify.',
          });
          suspense = { ...created, type: String(created.type), subtype: String(created.subtype) };
          allBk.set(created.id, suspense);
        }
        const lines: PostingLine[] = [];
        let offset = Money.zero();
        let gross = Money.zero();
        for (const r of proof.rows) {
          const d = Money.of(r.difference);
          if (d.isZero()) continue;
          offset = offset.plus(d);
          gross = gross.plus(d.abs());
          lines.push({
            accountId: r.accountId,
            debit: d.isPositive() ? toAmountString(d) : null,
            credit: d.isNegative() ? toAmountString(d.negated()) : null,
            memo: 'Difference vs QuickBooks report (accepted for review)',
          });
        }
        if (!offset.isZero()) {
          lines.push({
            accountId: suspense.id,
            debit: offset.isNegative() ? toAmountString(offset.negated()) : null,
            credit: offset.isPositive() ? toAmountString(offset) : null,
            memo: 'QuickBooks import difference — review',
          });
        }
        if (lines.length >= 2) {
          await postJournalEntry(tx, {
            date: utcDate(periodEnd),
            description: `QuickBooks import differences moved to ${QB_SUSPENSE.name}`,
            reference: 'QB-VARIANCE',
            lines,
            sourceRef: `qbgl:variance:${periodEnd}:${hashShort(JSON.stringify(lines))}`,
          });
          variancePosted = toAmountString(gross);
        }
        proof = await buildProof();
      }
      if (!proof.trialBalanceMatches) throw tbRollback();
      // The proof counts imported entries only. Say so plainly when other postings in the same
      // accounts make the account's real balance differ from QuickBooks.
      const full = await importedBalances(tx, asOf, false);
      const drifted = proof.rows.filter((r) => !Money.of(r.actual).equals(full.get(r.accountId) ?? Money.zero()));
      if (drifted.length) {
        warnings.push(
          `${drifted.length} account(s) also hold entries that weren't part of this import, so their balance in Ironbooks differs from QuickBooks: ${drifted
            .slice(0, 5)
            .map((r) => `${r.code} ${r.name} (${toAmountString(full.get(r.accountId) ?? 0)} here vs ${r.expected} in QuickBooks)`)
            .join('; ')}${drifted.length > 5 ? '; …' : ''}.`,
        );
      }
      if (!proof.ledger.balanced) {
        // Impossible through postJournalEntry — refuse loudly rather than save a broken ledger.
        throw new ServiceError('UNBALANCED', 'The ledger would be out of balance after this import. Nothing was saved.');
      }

      const result: GlImportResult = {
        ok: true,
        dryRun,
        rolledBack: dryRun,
        message: dryRun
          ? `Dry run passed: every account matches${variancePosted ? ` after moving ${variancePosted} to ${QB_SUSPENSE.name}` : ''}. Nothing was saved yet.`
          : `Imported ${counts.entriesPosted} transaction(s). Every account matches the QuickBooks report${variancePosted ? ` after moving ${variancePosted} to ${QB_SUSPENSE.name}` : ''}.`,
        proof,
        counts,
        review: analysis.review,
        variancePosted,
        importId: null,
        warnings,
      };
      if (dryRun) throw new Rollback(result);

      const [rec] = await tx.db
        .insert(qbGlImports)
        .values({
          companyId: tx.companyId,
          fileName: input.file.name.slice(0, 255) || 'General Ledger',
          periodStart: periodStart ? utcDate(periodStart) : null,
          periodEnd: utcDate(periodEnd),
          entriesPosted: counts.entriesPosted,
          entriesSkipped: counts.entriesAlreadyImported,
          accountsCreated: counts.accountsCreated,
          varianceAmount: variancePosted,
          proof: { proof, counts, review: analysis.review.slice(0, 200) } as unknown as Record<string, unknown>,
          createdBy: tx.userId,
        })
        .returning();
      await writeAudit(tx, {
        action: 'create',
        entityType: 'qb_gl_import',
        entityId: rec.id,
        newValues: { file: input.file.name, periodStart, periodEnd, counts, variancePosted },
      });
      result.importId = rec.id;
      return result;
    });
  } catch (err) {
    if (err instanceof Rollback) return err.result;
    // A value the books cannot hold (a 300-character account or class name, an amount past the
    // ledger's limit): the transaction rolled back — say so plainly instead of answering 500.
    if (isDataException(err)) {
      throw validation(`Nothing was saved: ${dataExceptionMessage(err)} Check the account, class and name columns of the report.`);
    }
    throw err;
  }
}

/** Short stable hash for sourceRef suffixes (per-company, so 96 bits is plenty). */
function hashShort(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 24);
}

export async function listGlImports(ctx: ServiceContext) {
  return ctx.db
    .select()
    .from(qbGlImports)
    .where(eq(qbGlImports.companyId, ctx.companyId))
    .orderBy(desc(qbGlImports.createdAt));
}
