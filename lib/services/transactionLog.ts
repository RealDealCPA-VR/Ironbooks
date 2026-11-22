/**
 * Running transaction log (QuickBooks Desktop .TLG parity).
 *
 * Every committed business change — journal posts/voids/edits, document create/update/void/
 * delete, list changes, user/permission changes — is appended to an append-only, hash-chained
 * JSON Lines file that lives next to the database: `<company data dir>/transactions.bktlg`.
 *
 * Record shape (one JSON object per line):
 *   { seq, ts, userId, userName, companyId, action, entityType, entityId, summary, data,
 *     [agentId, approvedBy, agentRequestId, agentGrantId,] prevHash, hash }
 *
 *  - The bracketed fields come with agent full access (plan §7.3), each only when it has a value.
 *    They come from ServiceContext.approval, which is set in two places only: by the route bridge
 *    on every run of an agent's operation, and by the approval center on a person's decision about
 *    an agent's request (agentRequests.ts auditDecision). So:
 *      `agentId`        on every change an agent makes;
 *      `approvedBy`     on an agent's change a person approved (that very run);
 *      `agentRequestId` on that run's changes, and on the person's decision, naming the request;
 *      `agentGrantId`   on an agent's change made under standing permission, and on a decision
 *                       that gave standing permission with the approval.
 *    An agent's run on its own policy carries an approval with no ids, so only `agentId`. Any other
 *    change by a person is exactly what it always was. They are part of the record's body and so
 *    inside its hash, like every other field: who approved a change is as much a part of it as what
 *    changed. Records written before them simply lack them; their hashes and the verification are
 *    unchanged.
 *
 *  - `seq` is 1-based and gap-free; seq 1 is a `log_started` genesis record.
 *  - `hash` = SHA-256 of the record's own JSON text WITHOUT the trailing `hash` field
 *    (`prevHash` included), so altering, removing or reordering any line breaks the chain.
 *  - Records are appended only AFTER the database transaction that made the change commits
 *    (see lib/db/txHooks.ts) — rolled-back work never reaches the log.
 *
 * The hook point is `writeAudit` (lib/services/_base.ts): every audited mutation is logged.
 * A few non-audited mutation paths (company creation, sign-up, password/2FA changes, condense
 * summary entries, company restore) call `logTransaction` directly.
 *
 * `verifyTransactionLog` checks the chain AND that every posted journal entry in the database
 * is present in the log (entries that predate the log's genesis are reported separately).
 *
 * The database keeps an anchor (table transaction_log_anchor): the genesis record's hash and
 * timestamp plus the latest head seq/hash, updated right after each append. Verification trusts
 * the anchor — not the file — for the "predates the log" cutoff, so deleting the file, replacing
 * it with a fresh genesis, or cutting records off its tail is reported.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { and, eq, inArray, is, sql } from 'drizzle-orm';
import { PgTransaction } from 'drizzle-orm/pg-core';
import type { DB } from '@/lib/db';
import { agentGrants, companies, journalEntries, transactionLogAnchor, users } from '@/lib/db/schema';
import { afterCommit, dataDirOf, rootDbOf } from '@/lib/db/txHooks';
import { formatCurrency, Money } from '@/lib/money';
import { localDateTime } from '@/lib/reports/dates';

/** File name of the running transaction log inside a company data directory. */
export const TRANSACTION_LOG_FILE = 'transactions.bktlg';
export const TRANSACTION_LOG_FORMAT_VERSION = 1;
/** prevHash of the genesis record. */
export const GENESIS_PREV_HASH = '0'.repeat(64);

export interface TransactionLogRecord {
  seq: number;
  /** ISO timestamp of the commit that produced the record. */
  ts: string;
  userId: string | null;
  userName: string | null;
  companyId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  /** Plain-language one-liner, e.g. 'Created invoice #1001 "Acme" for $500.00'. */
  summary: string;
  data: unknown;
  /** The agent that made the change (agents.id). Only on an agent's records. */
  agentId?: string;
  /** The person who approved this very change. Only when one did. */
  approvedBy?: string;
  /** The agent's permission request it ran under, or that a person decided (agent_permission_requests.id). */
  agentRequestId?: string;
  /** The standing permission it ran under, or that a person's decision gave (agent_grants.id). */
  agentGrantId?: string;
  prevHash: string;
  hash: string;
}

/**
 * What a change ran under (ServiceContext.approval): on an agent's run, set by the route bridge,
 * the person who approved it and the request or standing permission it ran under; on a person's
 * decision about an agent's request, the request decided (and any standing permission it gave).
 * Stored on the audit row (audit_logs.approved_by / agent_request_id / agent_grant_id) and on the
 * log record.
 */
export interface ChangeApproval {
  approvedBy: string | null;
  requestId: string | null;
  grantId: string | null;
}

/** A change to be logged (seq/ts/hashes are assigned at append time). */
export interface TransactionLogChange {
  companyId?: string | null;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  summary?: string;
  data?: unknown;
  /**
   * The agent behind the change (lib/services/_base.ts writeAudit), as agentLabel() words it:
   * named in the record's existing `userName`, followed by how the change was allowed
   * (agentActorName).
   */
  actorName?: string;
  /** The agent's id, recorded on the record (`agentId`). */
  agentId?: string | null;
  /**
   * What the change ran under; recorded on the record. On an agent's change (`actorName` set) it is
   * also named in `userName`.
   */
  approval?: ChangeApproval | null;
}

type PendingRecord = Omit<TransactionLogRecord, 'seq' | 'ts' | 'prevHash' | 'hash'>;

export function transactionLogPath(dataDir: string): string {
  return path.join(dataDir, TRANSACTION_LOG_FILE);
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Marker that separates a record's hashed body from its trailing hash field. */
const HASH_MARKER = ',"hash":"';

/** Serialize a record: hash its JSON body, then append the hash as the final field. */
function sealRecord(rec: Omit<TransactionLogRecord, 'hash'>): { line: string; hash: string } {
  const body = JSON.stringify(rec);
  const hash = sha256(body);
  return { line: `${body.slice(0, -1)}${HASH_MARKER}${hash}"}\n`, hash };
}

/** Recompute the hash of a stored line; null when the line is malformed. */
function lineBodyHash(line: string): string | null {
  const idx = line.lastIndexOf(HASH_MARKER);
  if (idx < 0 || !line.endsWith('"}')) return null;
  return sha256(`${line.slice(0, idx)}}`);
}

function parseLine(line: string): TransactionLogRecord | null {
  try {
    const rec = JSON.parse(line) as TransactionLogRecord;
    return rec && typeof rec.seq === 'number' && typeof rec.hash === 'string' ? rec : null;
  } catch {
    return null;
  }
}

/** JSON-safe copy of arbitrary audit values (Dates → ISO, Decimals → string, no cycles). */
function toJsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  } catch {
    return { unserializable: true };
  }
}

// ---------------------------------------------------------------------------
// Plain-language summaries
// ---------------------------------------------------------------------------

const VERBS: Record<string, string> = {
  create: 'Created',
  update: 'Changed',
  delete: 'Deleted',
  void: 'Voided',
  llm_correction: 'Applied an AI correction to',
  restore: 'Restored',
  log_started: 'Started',
};

const ENTITY_LABELS: Record<string, string> = {
  journal_entry: 'journal entry',
  payment_received: 'customer payment',
  bill_payment: 'bill payment',
  sales_receipt: 'sales receipt',
  credit_memo: 'credit memo',
  vendor_credit: 'vendor credit',
  purchase_order: 'purchase order',
  sales_order: 'sales order',
  item_receipt: 'item receipt',
  expense: 'check / expense',
  user_company: 'user permission',
  company_settings: 'company preferences',
  company_restore: 'company (restored from backup)',
  condense: 'condensed history',
  transaction_log: 'transaction log',
  bank_transaction: 'bank feed transaction',
  recurring_template: 'memorized transaction',
  file_import: 'file import',
  error_correction: 'AI correction',
  data_rebuild: 'data rebuild',
};

export function entityLabel(entityType: string): string {
  return ENTITY_LABELS[entityType] ?? entityType.replace(/_/g, ' ');
}

const NUMBER_KEYS = [
  'entryNumber', 'refNumber', 'invoiceNumber', 'billNumber', 'receiptNumber', 'memoNumber', 'creditNumber',
  'poNumber', 'orderNumber', 'estimateNumber', 'checkNumber', 'paymentNumber', 'number',
];
const AMOUNT_KEYS = ['total', 'amount', 'totalAmount', 'netPay', 'grossPay'];

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/** Build a short human sentence for a change from its audit values. */
export function describeChange(
  action: string,
  entityType: string,
  data: unknown,
): string {
  const verb = VERBS[action] ?? action.replace(/_/g, ' ');
  const d = (data ?? {}) as { new?: unknown; old?: unknown };
  const src = ((d.new ?? d.old) ?? {}) as Record<string, unknown>;
  const parts: string[] = [`${verb} ${entityLabel(entityType)}`];
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    const numKey = NUMBER_KEYS.find((k) => src[k] !== undefined && src[k] !== null && src[k] !== '');
    if (numKey) parts.push(`#${str(src[numKey])}`);
    const person = [str(src.firstName), str(src.lastName)].filter(Boolean).join(' ');
    const name = str(src.displayName) || str(src.name) || person || str(src.description) || str(src.email);
    if (name) parts.push(`"${name.length > 60 ? `${name.slice(0, 57)}...` : name}"`);
    const amtKey = AMOUNT_KEYS.find((k) => src[k] !== undefined && src[k] !== null && src[k] !== '');
    let amount: string | null = null;
    if (amtKey) {
      try {
        amount = formatCurrency(Money.of(src[amtKey] as string));
      } catch {
        amount = null;
      }
    } else if (Array.isArray(src.lines)) {
      // Journal entries: total of the debit column.
      try {
        const total = Money.add(
          ...(src.lines as Array<{ debit?: string | number | null }>).map((l) => l?.debit ?? 0),
        );
        if (!total.isZero()) amount = formatCurrency(total);
      } catch {
        amount = null;
      }
    }
    if (amount) parts.push(`for ${amount}`);
    if (action === 'update' && d.old && d.new && typeof d.old === 'object' && typeof d.new === 'object') {
      const changed = Object.keys(d.new as object).filter(
        (k) => JSON.stringify((d.old as Record<string, unknown>)[k]) !== JSON.stringify((d.new as Record<string, unknown>)[k]),
      );
      if (changed.length && changed.length <= 4) parts.push(`(changed: ${changed.join(', ')})`);
    }
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// User names (resolved once per user, inside the caller's transaction)
// ---------------------------------------------------------------------------

const userNames = new Map<string, string>();

/** Drop a cached user name (call after renaming a user). */
export function forgetUserName(userId: string): void {
  userNames.delete(userId);
}

async function resolveUserName(db: DB, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const cached = userNames.get(userId);
  if (cached !== undefined) return cached;
  const [row] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  const name = row ? row.name || row.email : null;
  if (name) userNames.set(userId, name);
  return name;
}

// ---------------------------------------------------------------------------
// How an agent's change is named (plan §7.3). The audit trail (auditTrail.ts) uses the same
// functions, so both records always say the same thing.
// ---------------------------------------------------------------------------

/** "<Agent> (agent)": how the records name an agent. */
export function agentLabel(agentName: string): string {
  return `${agentName} (agent)`;
}

/** The standing permission a change ran under: who gave it and until when (already worded). */
export interface StandingPermissionWords {
  /** The person who gave it; null when that is not on file (see giverRemoved). */
  givenBy: string | null;
  /** When it ends, on the company's clock ("2026-11-20 17:00"); null when not on file. */
  until: string | null;
  /** The grant is on file but the person who gave it is not: their user was removed. */
  giverRemoved?: boolean;
}

/** Said of a person no longer on file (their user was removed, or this is a copy without them). */
export const REMOVED_PERSON = 'a removed user';

/**
 * The full actor of an agent's change, from `actor` (agentLabel's words):
 *  - "<Agent> (agent), approved by <person>" when a person approved this very change;
 *  - "<Agent> (agent), under permission from <person> until <time>" when it ran under standing
 *    permission; "..., under standing permission from a removed user until <time>" when the
 *    grant is on file but its giver is not (a person did give it, as "approved by a removed user"
 *    says of an approval); "..., under standing permission" when the grant is not on file at all;
 *  - "<Agent> (agent)" when it ran on the agent's own policy.
 * A direct approval wins over a grant: a person said yes to this change itself.
 */
export function agentActorName(
  actor: string,
  how: { approvedBy?: string | null; grant?: StandingPermissionWords | null } = {},
): string {
  if (how.approvedBy) return `${actor}, approved by ${how.approvedBy}`;
  if (how.grant) {
    const { givenBy, until, giverRemoved } = how.grant;
    if (givenBy) return until ? `${actor}, under permission from ${givenBy} until ${until}` : `${actor}, under permission from ${givenBy}`;
    const standing = giverRemoved ? `under standing permission from ${REMOVED_PERSON}` : 'under standing permission';
    return until ? `${actor}, ${standing} until ${until}` : `${actor}, ${standing}`;
  }
  return actor;
}

/** The company's Preferences time zone, or null for this computer's clock (as resolveCompanyPreferences does). */
async function companyTimeZone(db: DB, companyId: string): Promise<string | null> {
  const [row] = await db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
  const tz = (row?.settings as { timezone?: unknown } | null)?.timezone;
  return typeof tz === 'string' && tz.trim() ? tz : null;
}

/**
 * Who gave each standing permission and until when, worded for agentActorName, by grant id.
 * A grant that is not on file (or belongs to another company) is left out of the map: the caller
 * then says "under standing permission". Grants never travel with a copy of the company, so in a
 * restored copy every one is missing. A grant still on file whose giver was removed says so
 * ("under standing permission from a removed user until ..."), as an approval by a removed person
 * does: a person did give it. One query for the grants and one for the time zone, however many ids.
 */
export async function standingPermissionWords(
  db: DB,
  companyId: string,
  grantIds: readonly string[],
): Promise<Map<string, StandingPermissionWords>> {
  const out = new Map<string, StandingPermissionWords>();
  const ids = [...new Set(grantIds.filter(Boolean))];
  if (!ids.length) return out;
  const rows = await db
    .select({ id: agentGrants.id, expiresAt: agentGrants.expiresAt, name: users.name, email: users.email })
    .from(agentGrants)
    .leftJoin(users, eq(agentGrants.givenBy, users.id))
    .where(and(eq(agentGrants.companyId, companyId), inArray(agentGrants.id, ids)));
  if (!rows.length) return out;
  const tz = await companyTimeZone(db, companyId);
  for (const r of rows) {
    // given_by is required, so a grant whose giver has no user row lost that person.
    const givenBy = r.name || r.email || null;
    out.set(r.id, { givenBy, until: localDateTime(r.expiresAt, tz) || null, ...(givenBy ? {} : { giverRemoved: true }) });
  }
  return out;
}

// A run under one standing permission can write hundreds of records in one database transaction,
// each naming the same grant: it is worded once per transaction (two queries) and reused for the
// rest of it, never looked up again for each record. Kept per transaction, not for the process, so
// it is never older than the transaction that uses it: the next one words the grant afresh, and a
// rename or a new time zone saved meanwhile shows at once. A change inside the same transaction to
// a user, the company (its Preferences hold the time zone) or a grant drops that transaction's words
// (logTransaction). Held weakly by the transaction, so the words go with it, committed or rolled back.
// A write outside a transaction (autocommit) is a transaction of its own: it looks the grant up.
// The audit trail reads the grants as they are now (standingPermissionWords, once per page).
const grantWordsByTransaction = new WeakMap<object, Map<string, StandingPermissionWords | null>>();

/**
 * What identifies the transaction `db` belongs to, or null outside one. A service's own
 * inTransaction inside the run opens a savepoint: a new handle on the same database session, so
 * the session is the key and the savepoint shares the words of the transaction around it. Should a
 * driver ever hand a transaction the root's own session, the handle itself is the key (a savepoint
 * then words the grant once more, which is only slower).
 */
function transactionKey(db: DB): object | null {
  if (!is(db, PgTransaction)) return null;
  const session = (db as unknown as { session?: unknown }).session;
  const rootSession = (rootDbOf(db) as { session?: unknown } | null)?.session;
  return session && typeof session === 'object' && session !== rootSession ? session : db;
}

/** One grant's words for a record about to be logged: looked up once per transaction. */
async function grantWordsForLog(db: DB, companyId: string, grantId: string): Promise<StandingPermissionWords | undefined> {
  const key = transactionKey(db);
  const known = key ? grantWordsByTransaction.get(key) : undefined;
  const cacheKey = `${companyId}\u0000${grantId}`;
  if (known?.has(cacheKey)) return known.get(cacheKey) ?? undefined;
  const words = (await standingPermissionWords(db, companyId, [grantId])).get(grantId);
  if (key) {
    const map = known ?? new Map<string, StandingPermissionWords | null>();
    // A grant not on file is remembered as such for this transaction too: the run names it the
    // same way on every record.
    map.set(cacheKey, words ?? null);
    if (!known) grantWordsByTransaction.set(key, map);
  }
  return words;
}

/** Drop the grant words remembered for the transaction `db` belongs to (see grantWordsByTransaction). */
function forgetGrantWords(db: DB): void {
  const key = transactionKey(db);
  if (key) grantWordsByTransaction.delete(key);
}

/** The full actor name of an agent's change at the time it is logged (see agentActorName). */
async function agentActorAtWrite(
  db: DB,
  change: TransactionLogChange & { actorName: string },
  person: string | null,
): Promise<string> {
  const ap = change.approval;
  if (ap?.approvedBy) {
    return agentActorName(change.actorName, { approvedBy: (await resolveUserName(db, ap.approvedBy)) ?? REMOVED_PERSON });
  }
  if (ap?.grantId) {
    const words = change.companyId ? await grantWordsForLog(db, change.companyId, ap.grantId) : undefined;
    return agentActorName(change.actorName, { grant: words ?? { givenBy: null, until: null } });
  }
  // Before agent full access a person approved an agent's proposal in their own context: the
  // person in `userId` is the approver.
  return agentActorName(change.actorName, { approvedBy: person });
}

// ---------------------------------------------------------------------------
// Append (chain head cached per file; re-read when the file changes underneath us,
// e.g. after a restore swapped the data directory)
// ---------------------------------------------------------------------------

interface ChainHead {
  seq: number;
  hash: string;
  size: number;
  mtimeMs: number;
}

const heads = new Map<string, ChainHead>();

/** Read the last valid record of a log file without loading the whole file. */
function readLastRecord(file: string): { rec: TransactionLogRecord | null; endsWithNewline: boolean } {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return { rec: null, endsWithNewline: true };
    const lastByte = Buffer.alloc(1);
    fs.readSync(fd, lastByte, 0, 1, size - 1);
    const endsWithNewline = lastByte[0] === 0x0a;
    let chunkSize = 64 * 1024;
    for (;;) {
      const start = Math.max(0, size - chunkSize);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      // When we did not read from the start, the first fragment may be partial — skip it.
      const candidates = start === 0 ? lines : lines.slice(1);
      for (let i = candidates.length - 1; i >= 0; i--) {
        const line = candidates[i].trim();
        if (!line) continue;
        const rec = parseLine(line);
        if (rec) return { rec, endsWithNewline };
      }
      if (start === 0) return { rec: null, endsWithNewline };
      chunkSize *= 4;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Append records to a data directory's log, assigning seq/ts/prevHash/hash. Creates the file
 * with a genesis record first when it does not exist yet. Synchronous so that concurrent
 * commits in the same process can never interleave a chain.
 */
export function appendTransactionLog(dataDir: string, pending: PendingRecord[]): TransactionLogRecord[] {
  if (!pending.length) return [];
  const file = transactionLogPath(dataDir);
  let head: ChainHead | null = null;
  let prefix = '';
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(file);
  } catch {
    stat = null;
  }

  if (stat && stat.size > 0) {
    const cached = heads.get(file);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      head = cached;
    } else {
      const { rec, endsWithNewline } = readLastRecord(file);
      if (!endsWithNewline) prefix = '\n'; // never glue a new record onto a torn line
      if (rec) head = { seq: rec.seq, hash: rec.hash, size: stat.size, mtimeMs: stat.mtimeMs };
    }
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const ts = new Date().toISOString();
  const lines: string[] = [];
  const written: TransactionLogRecord[] = [];
  if (!head) {
    const genesis = {
      seq: 1,
      ts,
      userId: null,
      userName: null,
      companyId: null,
      action: 'log_started',
      entityType: 'transaction_log',
      entityId: null,
      summary: 'Started the running transaction log',
      data: { app: 'bookkeeper-ai', formatVersion: TRANSACTION_LOG_FORMAT_VERSION },
      prevHash: GENESIS_PREV_HASH,
    };
    const sealed = sealRecord(genesis);
    lines.push(sealed.line);
    written.push({ ...genesis, hash: sealed.hash });
    head = { seq: 1, hash: sealed.hash, size: 0, mtimeMs: 0 };
  }

  let { seq, hash } = head;
  for (const p of pending) {
    seq += 1;
    const rec = { seq, ts, ...p, prevHash: hash };
    const sealed = sealRecord(rec);
    lines.push(sealed.line);
    written.push({ ...rec, hash: sealed.hash });
    hash = sealed.hash;
  }

  fs.appendFileSync(file, prefix + lines.join(''), 'utf8');
  const after = fs.statSync(file);
  heads.set(file, { seq, hash, size: after.size, mtimeMs: after.mtimeMs });
  return written;
}

/**
 * Forget cached chain heads / parsed records for a data dir (call after the directory's files
 * were replaced wholesale, e.g. by a restore). The caches also self-invalidate on size/mtime.
 */
export function resetTransactionLogCache(dataDir: string): void {
  const file = transactionLogPath(dataDir);
  heads.delete(file);
  parsedCache.delete(file);
}

/**
 * Log a business change. Resolves the acting user's name now (inside the caller's
 * transaction) and appends once the enclosing transaction commits. No-op for database
 * handles that are not tied to a company data directory.
 */
export async function logTransaction(db: DB, change: TransactionLogChange): Promise<void> {
  const dir = dataDirOf(db);
  if (!dir) return;
  const person = await resolveUserName(db, change.userId);
  // An agent's change names the agent and how it was allowed (approved by a person, or under
  // standing permission).
  const userName = change.actorName
    ? (await agentActorAtWrite(db, { ...change, actorName: change.actorName }, person)).slice(0, 200)
    : person;
  const data = toJsonSafe(change.data);
  const ap = change.approval;
  const record: PendingRecord = {
    userId: change.userId ?? null,
    userName,
    companyId: change.companyId ?? null,
    action: change.action,
    entityType: change.entityType,
    entityId: change.entityId ?? null,
    summary: change.summary ?? describeChange(change.action, change.entityType, data),
    data,
    // Agent full access: each only present when set (see the header for which change carries
    // which): agentId on an agent's change, the ids of ServiceContext.approval on an agent's run
    // and on a person's decision about its request. Any other change keeps its old shape. Inside
    // the hash like every field.
    ...(change.agentId ? { agentId: change.agentId } : {}),
    ...(ap?.approvedBy ? { approvedBy: ap.approvedBy } : {}),
    ...(ap?.requestId ? { agentRequestId: ap.requestId } : {}),
    ...(ap?.grantId ? { agentGrantId: ap.grantId } : {}),
  };
  if (change.entityType === 'user' && change.entityId) forgetUserName(change.entityId);
  // A grant's words name its giver on the company's clock (see grantWordsByTransaction).
  if (change.entityType === 'user' || change.entityType === 'company' || change.entityType === 'agent_grant') {
    forgetGrantWords(db);
  }
  const root = rootDbOf(db) as DB | null;
  await afterCommit(db, async () => {
    const written = appendTransactionLog(dir, [record]);
    if (root) await anchorTransactionLog(root, dir, written);
  });
}

/** First (genesis) record of a log file, or null when missing/unreadable. */
function readFirstRecord(file: string): TransactionLogRecord | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    let len = 4096;
    for (;;) {
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, 0);
      const text = buf.subarray(0, n).toString('utf8');
      const nl = text.indexOf('\n');
      if (nl >= 0 || n < len) return parseLine((nl >= 0 ? text.slice(0, nl) : text).trim());
      len *= 4;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Does the log file still hold the anchored head (same hash at the same seq)? Cheap when the
 * just-written batch chains straight off it (the usual case); otherwise re-reads the file from
 * scratch (never trusting the incremental parse cache, which assumes an untouched prefix).
 */
function fileHoldsAnchoredHead(dir: string, written: TransactionLogRecord[], seq: number, hash: string): boolean {
  for (const r of written) {
    if (r.seq === seq) return r.hash === hash;
    if (r.seq === seq + 1 && r.prevHash === hash) return true;
  }
  parsedCache.delete(transactionLogPath(dir));
  const rec = readAllTransactionLog(dir).records.find((r) => r.seq === seq);
  return !!rec && rec.hash === hash;
}

/**
 * Record the log's genesis and newest head in the database. Monotonic and descent-checked: the
 * head only moves forward, only while the file's genesis matches the anchored one (a replaced
 * log never re-anchors itself), and only while the file still holds the anchored head record.
 * A log whose tail was cut and then re-grown therefore never re-anchors onto the rewritten
 * tail — the anchor stays put and verification keeps reporting the missing records for good.
 */
async function anchorTransactionLog(root: DB, dir: string, written: TransactionLogRecord[]): Promise<void> {
  const head = written[written.length - 1];
  if (!head) return;
  const genesis = readFirstRecord(transactionLogPath(dir));
  if (!genesis) return;
  // A failed compare-and-set means another commit moved the anchor first, so every retry makes
  // progress; the bound only guards against a pathological loop.
  for (let attempt = 0; attempt < 1000; attempt++) {
    const [anchor] = await root.select().from(transactionLogAnchor).where(eq(transactionLogAnchor.id, 'log'));
    if (!anchor) {
      const res = await root.execute(sql`
        INSERT INTO transaction_log_anchor (id, genesis_hash, genesis_ts, head_seq, head_hash)
        VALUES ('log', ${genesis.hash}, ${genesis.ts}, ${head.seq}, ${head.hash})
        ON CONFLICT (id) DO NOTHING`);
      if ((res as { affectedRows?: number }).affectedRows !== 0) return;
      continue; // another commit anchored first — re-check against its row
    }
    if (anchor.genesisHash !== genesis.hash) return;
    if (anchor.headSeq >= head.seq) return;
    if (!fileHoldsAnchoredHead(dir, written, anchor.headSeq, anchor.headHash)) return;
    // Compare-and-set so a concurrent anchor move is never overwritten with a stale check.
    const res = await root.execute(sql`
      UPDATE transaction_log_anchor
         SET head_seq = ${head.seq}, head_hash = ${head.hash}, updated_at = now()
       WHERE id = 'log' AND head_seq = ${anchor.headSeq} AND head_hash = ${anchor.headHash}
         AND genesis_hash = ${genesis.hash}`);
    if ((res as { affectedRows?: number }).affectedRows !== 0) return;
  }
}

// ---------------------------------------------------------------------------
// Read (parsed records cached per file; appended bytes parsed incrementally)
// ---------------------------------------------------------------------------

interface ParsedCache {
  size: number;
  mtimeMs: number;
  records: TransactionLogRecord[];
  /** Lines that could not be parsed (torn writes / tampering), by 1-based line number. */
  badLines: number[];
  lineCount: number;
}

const parsedCache = new Map<string, ParsedCache>();

/** All parseable records in file order (cached; incremental on append). */
export function readAllTransactionLog(dataDir: string): ParsedCache {
  const file = transactionLogPath(dataDir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { size: 0, mtimeMs: 0, records: [], badLines: [], lineCount: 0 };
  }
  const cached = parsedCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;

  let base: ParsedCache = { size: 0, mtimeMs: 0, records: [], badLines: [], lineCount: 0 };
  let start = 0;
  // Append-only fast path: parse only the new tail when the file grew past a clean boundary.
  if (cached && stat.size > cached.size && cached.size > 0) {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, cached.size - 1);
      if (b[0] === 0x0a) {
        base = { ...cached, records: cached.records.slice(), badLines: cached.badLines.slice() };
        start = cached.size;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  const fd = fs.openSync(file, 'r');
  let text: string;
  try {
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    text = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let lineNo = base.lineCount;
  for (const line of lines) {
    lineNo += 1;
    const rec = line.trim() ? parseLine(line) : null;
    if (rec) base.records.push(rec);
    else base.badLines.push(lineNo);
  }
  const result = { ...base, size: stat.size, mtimeMs: stat.mtimeMs, lineCount: lineNo };
  parsedCache.set(file, result);
  return result;
}

export interface TransactionLogFilter {
  companyId?: string | null;
  from?: Date;
  to?: Date;
  userId?: string;
  entityType?: string;
  action?: string;
  entityId?: string;
  /** Only one agent's changes (the record's `agentId`). */
  agentId?: string;
  search?: string;
  /** Include the log_started/system records (default true). */
  includeSystem?: boolean;
  /**
   * The records the reader may see (lib/services/auditVisibility.ts canSeeLogRecord). The others
   * are left out before anything is counted: rows, total, and the user and type lists.
   */
  visible?: (record: TransactionLogRecord) => boolean;
  limit?: number;
  offset?: number;
}

export interface TransactionLogPage {
  rows: TransactionLogRecord[];
  total: number;
  users: Array<{ userId: string; userName: string }>;
  entityTypes: string[];
}

/**
 * Every record matching the filter (limit / offset ignored), newest first. When `companyId` is
 * set, records of other companies sharing the data dir are left out (records without a company —
 * users, the genesis record — are always in). The array is a snapshot: records appended later
 * are not in it (the CSV export pages through it, so rows never shift or repeat).
 */
export function matchTransactionLog(dataDir: string, filter: TransactionLogFilter = {}): TransactionLogRecord[] {
  return matchRecords(scopeRecords(readAllTransactionLog(dataDir).records, filter), filter);
}

/** The records a filter's reader may see at all: their company's (or none) and `visible`. */
function scopeRecords(records: TransactionLogRecord[], filter: TransactionLogFilter): TransactionLogRecord[] {
  const visible = filter.visible;
  return records.filter(
    (r) => (!filter.companyId || !r.companyId || r.companyId === filter.companyId) && (!visible || visible(r)),
  );
}

function matchRecords(scoped: TransactionLogRecord[], filter: TransactionLogFilter): TransactionLogRecord[] {
  const fromIso = filter.from?.toISOString();
  const toIso = filter.to?.toISOString();
  const q = filter.search?.trim().toLowerCase();
  const matches = scoped.filter((r) => {
    if (fromIso && r.ts < fromIso) return false;
    if (toIso && r.ts > toIso) return false;
    if (filter.userId && r.userId !== filter.userId) return false;
    if (filter.entityType && r.entityType !== filter.entityType) return false;
    if (filter.action && r.action !== filter.action) return false;
    if (filter.entityId && r.entityId !== filter.entityId) return false;
    if (filter.agentId && r.agentId !== filter.agentId) return false;
    if (filter.includeSystem === false && r.entityType === 'transaction_log') return false;
    if (q && !`${r.summary} ${r.userName ?? ''} ${r.entityType} ${r.entityId ?? ''}`.toLowerCase().includes(q)) {
      return false;
    }
    return true;
  });
  return matches.reverse(); // newest first
}

/**
 * Filtered, newest-first view of the log. When `companyId` is set, records of other
 * companies sharing the data dir are hidden (records without a company — users, the
 * genesis record — are always shown).
 */
export function queryTransactionLog(dataDir: string, filter: TransactionLogFilter = {}): TransactionLogPage {
  const scoped = scopeRecords(readAllTransactionLog(dataDir).records, filter);
  const matches = matchRecords(scoped, filter);
  const offset = Math.max(0, filter.offset ?? 0);
  const limit = Math.max(1, Math.min(filter.limit ?? 100, 50_000));

  const usersSeen = new Map<string, string>();
  const types = new Set<string>();
  for (const r of scoped) {
    if (r.userId) usersSeen.set(r.userId, r.userName ?? r.userId);
    types.add(r.entityType);
  }
  return {
    rows: matches.slice(offset, offset + limit),
    total: matches.length,
    users: [...usersSeen].map(([userId, userName]) => ({ userId, userName })),
    entityTypes: [...types].sort(),
  };
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export interface TransactionLogVerification {
  /** Chain intact AND no posted journal entry missing from the log. */
  ok: boolean;
  exists: boolean;
  records: number;
  chainIntact: boolean;
  /** First problem found in the chain, if any. */
  chainError: { line: number; seq: number | null; reason: string } | null;
  headHash: string | null;
  /** When the log started (genesis ts, from the database anchor when present). */
  startedAt: string | null;
  /** The database holds an anchor for this log (genesis + head). */
  anchored: boolean;
  postedEntries: number;
  /** Posted entries created after the log started that have no log record. */
  missingEntries: Array<{ id: string; entryNumber: number; companyId: string }>;
  /** Posted entries that predate the log (not expected to be in it). */
  preLogEntries: number;
}

/**
 * Verify a data directory's transaction log:
 *  1. every line parses, seq runs 1..n without gaps, each prevHash equals the previous
 *     record's hash, and every hash matches its record's content;
 *  2. every POSTED journal entry in the database (created after the log started) has at
 *     least one log record (entityType 'journal_entry', or a bulk record listing it in
 *     data.journalEntryIds).
 */
export async function verifyTransactionLog(db: DB, dataDir?: string): Promise<TransactionLogVerification> {
  const dir = dataDir ?? dataDirOf(db);
  if (!dir) throw new Error('verifyTransactionLog: unknown data directory for this database handle.');
  const file = transactionLogPath(dir);
  const exists = fs.existsSync(file);

  let chainError: TransactionLogVerification['chainError'] = null;
  let records = 0;
  let prevHash = GENESIS_PREV_HASH;
  let startedAt: string | null = null;
  let genesisHash: string | null = null;
  const hashBySeq = new Map<number, string>();
  const loggedEntryIds = new Set<string>();

  if (exists) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const rec = parseLine(line);
      if (!rec) {
        chainError ??= { line: i + 1, seq: null, reason: 'Record is unreadable (damaged or partially written).' };
        continue;
      }
      records += 1;
      hashBySeq.set(rec.seq, rec.hash);
      if (rec.entityType === 'journal_entry' && rec.entityId) loggedEntryIds.add(rec.entityId);
      const bulk = (rec.data as { journalEntryIds?: unknown } | null)?.journalEntryIds;
      if (Array.isArray(bulk)) for (const id of bulk) if (typeof id === 'string') loggedEntryIds.add(id);
      if (chainError) continue;
      if (rec.seq !== i + 1) {
        chainError = { line: i + 1, seq: rec.seq, reason: `Expected record #${i + 1} but found #${rec.seq} (records missing or out of order).` };
      } else if (rec.prevHash !== prevHash) {
        chainError = { line: i + 1, seq: rec.seq, reason: 'Link to the previous record is broken (a record was changed, removed or inserted).' };
      } else if (lineBodyHash(line) !== rec.hash) {
        chainError = { line: i + 1, seq: rec.seq, reason: 'Record content does not match its fingerprint (it was altered).' };
      }
      if (i === 0) {
        startedAt = rec.ts;
        genesisHash = rec.hash;
        if (!chainError && rec.action !== 'log_started') {
          chainError = { line: 1, seq: rec.seq, reason: 'The log does not begin with its start record.' };
        }
      }
      prevHash = rec.hash;
    }
  }

  // The database anchor is authoritative for when the log started and how far it reached; a
  // file that is missing, restarted or cut short is a broken log, not a "new" one.
  const [anchor] = await db.select().from(transactionLogAnchor).where(eq(transactionLogAnchor.id, 'log'));
  if (anchor) {
    startedAt = anchor.genesisTs;
    if (!chainError) {
      if (!exists || records === 0) {
        chainError = {
          line: 0,
          seq: null,
          reason: `The transaction log file is missing or empty, but this company file recorded a log started ${anchor.genesisTs}.`,
        };
      } else if (genesisHash !== anchor.genesisHash) {
        chainError = {
          line: 1,
          seq: 1,
          reason: 'The log was replaced: its start record does not match the one recorded in the company file.',
        };
      } else if (hashBySeq.get(anchor.headSeq) !== anchor.headHash) {
        chainError = {
          line: records,
          seq: anchor.headSeq,
          reason: `Records are missing from the end of the log (the company file recorded record #${anchor.headSeq}).`,
        };
      }
    }
  }

  // Posted journal entries vs. the log. `created_at` is a timestamp WITHOUT time zone holding
  // the session's local wall time, so the "predates the log" comparison is done in SQL with the
  // genesis instant converted the same way (never compare it to a JS Date directly).
  const preLogExpr = startedAt
    ? sql<boolean>`${journalEntries.createdAt} < (${startedAt}::timestamptz)::timestamp`
    : sql<boolean>`true`;
  const posted = await db
    .select({
      id: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      companyId: journalEntries.companyId,
      preLog: preLogExpr,
    })
    .from(journalEntries)
    .where(eq(journalEntries.status, 'posted'));
  const missingEntries: TransactionLogVerification['missingEntries'] = [];
  let preLogEntries = 0;
  for (const e of posted) {
    if (loggedEntryIds.has(e.id)) continue;
    if (e.preLog === true || (e.preLog as unknown) === 't') {
      preLogEntries += 1;
      continue;
    }
    missingEntries.push({ id: e.id, entryNumber: e.entryNumber, companyId: e.companyId });
  }

  if (!anchor && !exists && posted.length > 0) {
    chainError ??= {
      line: 0,
      seq: null,
      reason: 'There is no transaction log for this company file, although it has posted transactions.',
    };
  }

  const chainIntact = chainError === null;
  return {
    ok: chainIntact && missingEntries.length === 0,
    exists,
    records,
    chainIntact,
    chainError,
    headHash: records ? prevHash : null,
    startedAt,
    anchored: !!anchor,
    postedEntries: posted.length,
    missingEntries,
    preLogEntries,
  };
}
