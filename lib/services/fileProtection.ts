/**
 * The password belongs to the company file (filecrypto): encryption at rest of the single company
 * file and every copy of it, with the file's own passwords.
 *
 * A protected company file is encrypted with one random 256-bit FILE KEY (electron/fileCrypto.js,
 * electron/companyFileFormat.js format 2). The key is held here, in this server's memory only —
 * never in a file, state.json, the environment, a log or a URL. The file carries KEY SLOTS: the
 * file key wrapped with a key derived from
 *   - each active user's password ('password'),
 *   - each user's challenge answer ('challenge', "I forgot my password"),
 *   - the recovery key ('recovery'), shown once when protection is turned on.
 * The slots live in this database (file_key_slots, 0077) and every save copies the valid ones
 * into the company file's plain manifest, so the file opens on any computer with a fresh install
 * for anyone who knows one of those secrets — and for nobody else.
 *
 * Keeping the slots in sync (every path that sets a secret calls in here):
 *   sign-in                       refreshSlotAtSignIn (creates a missing slot, re-wraps a stale one)
 *   password change / reset /     syncPasswordSlot (lib/services/passwordPolicy.ts storeUserPassword)
 *   Admin set-password
 *   user added                    syncPasswordSlot (lib/services/users.ts addUser)
 *   user removed / deactivated    manifestSlots() leaves inactive users out of the next save
 *   user name changed             nothing to do: the lookup tag is computed from the current name at save
 *   challenge question changed    syncChallengeSlot (app/api/auth/challenge)
 *   recovery key regenerated      regenerateRecoveryKey (Company > Security)
 * A slot records a digest of the password (or answer) hash it was made for (`secret_ref`): when the
 * user's hash changes some other way, the slot is stale and is left out until the next sign-in.
 *
 * The FILE KEY CHANGES whenever a secret stops being one that should open the file — a password
 * changed or reset, a challenge answer changed, a user deactivated, a new recovery key — or when an
 * Admin asks (Company > Security > Change the File Key). rotateFileKey wraps a new key for every
 * remaining slot without anyone's password (fileCrypto.rewrapSlot: slots hold a public key), so
 * nobody still allowed in is locked out, while an old password, a removed user or an OLD COPY of
 * the file (whose slots still open the old key) opens nothing saved after the change. The change
 * is requested where the secret changes (often inside a transaction) and made by the next save,
 * before its snapshot (applyPendingKeyRotation). Copies handed to someone else (portable files,
 * Accountant's Copy, Period Copy) never carry this file's key: they get their own (copyKeyFor).
 *
 * Opening a protected file (one sign-in, the QuickBooks way): the desktop shell locks the file and
 * works out the open plan without the key, then starts this server SEALED (lib/db/sealed.ts). The
 * sign-in unwraps the file key from the user's slot, makes the working copy (unsealCompanyFile),
 * opens the database, then signs the user in against the users table as usual.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import fileCrypto from '@/electron/fileCrypto';
import format from '@/electron/companyFileFormat';
import session from '@/electron/companySession';
import { getDb, resolveDataDir, withDamagedFileAccess, type DB } from '@/lib/db';
import { markUnsealed, sealedDataDir, sealedMode } from '@/lib/db/sealed';
import { companies, fileKeySlots, fileProtection, userCompanies, users } from '@/lib/db/schema';
import { verifyPassword } from '@/lib/auth';
import { challengeAnswerOpensFile, normalizeChallengeAnswer } from '@/lib/challengeQuestions';
import { APP_VERSION } from '@/lib/appVersion';
import { ServiceError } from './errors';
import { requireFileAdmin } from './access';
import { logTransaction } from './transactionLog';

/** A protected data folder carries this marker (no secret in it), so backups know without the database. */
export const PROTECTED_MARKER = '.ironbooks-protected';

export const KEY_MISSING_MESSAGE =
  'This company file is protected with passwords, and the password used to open it here does not unlock it yet. Sign out, then sign in again with your user name and password.';

export const NO_SLOT_MESSAGE =
  'Your password is correct, but it does not open this protected company file yet. Sign in once while an Admin has the file open, or ask an Admin to reset your password (Company > Users and Roles).';

/** The file password is asked on the sign-in screen once a protected file is open (not a /unlock redirect). */
export const FILE_PASSWORD_PROMPT = 'This company file also has a file password. Enter it to finish opening the file.';

export interface SealProtection {
  fileKey: Buffer;
  keyCheck: string;
  lookupSalt: string;
  slots: Array<Record<string, unknown>>;
}

export interface ProtectionRow {
  keyCheck: string;
  lookupSalt: string;
  protectedAt: Date;
  protectedBy: string | null;
  recoveryCreatedAt: Date | null;
  /** The key check before the last key change (the company file may still be sealed with it). */
  previousKeyCheck: string | null;
}

// ---------------------------------------------------------------------------
// The file key, in memory only
// ---------------------------------------------------------------------------

interface KeyState {
  keys: Map<string, Buffer>;
  /** The last slot set saved or built per folder (createBackup is synchronous). */
  cache: Map<string, SealProtection>;
  unseal: Promise<void> | null;
  conflictCopy: string | null;
  /** Folders whose file key is to change at the next save (requestFileKeyRotation). */
  rotate: Set<string>;
  /** Every file key held in this process by its key check (a slot made just before a key change finds the new key). */
  byCheck: Map<string, Buffer>;
}

const g = globalThis as typeof globalThis & { __ironbooksFileKeys?: KeyState };
function keyState(): KeyState {
  g.__ironbooksFileKeys ??= { keys: new Map(), cache: new Map(), unseal: null, conflictCopy: null, rotate: new Set(), byCheck: new Map() };
  g.__ironbooksFileKeys.rotate ??= new Set();
  g.__ironbooksFileKeys.byCheck ??= new Map();
  return g.__ironbooksFileKeys;
}

function dirKey(dir: string): string {
  const abs = path.resolve(dir);
  return process.platform === 'win32' || process.platform === 'darwin' ? abs.toLowerCase() : abs;
}

/** The file key held for a data folder (the open company file's working copy), or null. */
export function fileKeyFor(dataDir: string = resolveDataDir()): Buffer | null {
  return keyState().keys.get(dirKey(dataDir)) ?? null;
}

function rememberFileKey(dataDir: string, key: Buffer): void {
  keyState().keys.set(dirKey(dataDir), Buffer.from(key));
  knowKey(key);
}

function knowKey(key: Buffer): void {
  keyState().byCheck.set(fileCrypto.keyCheckOf(key), Buffer.from(key));
}

/** A file key held in this process, by its key check (null when it is not known here). */
function keyByCheck(keyCheck: string): Buffer | null {
  return keyState().byCheck.get(keyCheck) ?? null;
}

/** A sandbox or restored copy of a protected folder has the same file key. */
export function shareFileKey(fromDir: string, toDir: string): void {
  const key = fileKeyFor(fromDir);
  if (key) rememberFileKey(toDir, key);
}

/** Forget the key held for one folder (a scratch copy that is being deleted). */
export function forgetFileKey(dataDir: string): void {
  keyState().keys.delete(dirKey(dataDir));
  keyState().cache.delete(dirKey(dataDir));
}

/** Tests: forget every key. */
export function forgetFileKeys(): void {
  g.__ironbooksFileKeys = { keys: new Map(), cache: new Map(), unseal: null, conflictCopy: null, rotate: new Set(), byCheck: new Map() };
}

function writeMarker(dataDir: string, keyCheck: string): void {
  try {
    fs.writeFileSync(path.join(dataDir, PROTECTED_MARKER), JSON.stringify({ keyCheck }) + '\n');
  } catch {
    /* the database row is what counts; the marker only helps synchronous checks */
  }
}

/** True when the folder says it belongs to a protected company file (no database needed). */
export function isMarkedProtected(dataDir: string = resolveDataDir()): boolean {
  return fs.existsSync(path.join(dataDir, PROTECTED_MARKER));
}

// ---------------------------------------------------------------------------
// Protection state and slots
// ---------------------------------------------------------------------------

export async function readProtection(db: DB): Promise<ProtectionRow | null> {
  const [row] = await db.select().from(fileProtection).where(eq(fileProtection.id, 1));
  return row
    ? {
        keyCheck: row.keyCheck,
        lookupSalt: row.lookupSalt,
        protectedAt: row.protectedAt,
        protectedBy: row.protectedBy ?? null,
        recoveryCreatedAt: row.recoveryCreatedAt ?? null,
        previousKeyCheck: row.previousKeyCheck ?? null,
      }
    : null;
}

/** A digest of the hash a slot was made for (never the hash itself in a second place). */
export function secretRef(hash: string | null | undefined): string | null {
  if (!hash) return null;
  return createHash('sha256').update(`ironbooks/secret-ref/v1\n${hash}`).digest('hex').slice(0, 32);
}

/** Users who may sign in: an active membership somewhere, or a company owner without memberships. */
async function activeUserIds(db: DB): Promise<Set<string>> {
  const ms = await db.select({ userId: userCompanies.userId, isActive: userCompanies.isActive }).from(userCompanies);
  const owners = await db.select({ ownerId: companies.ownerId }).from(companies);
  const withRows = new Set(ms.map((m) => m.userId));
  const out = new Set(ms.filter((m) => m.isActive !== false).map((m) => m.userId));
  for (const o of owners) if (o.ownerId && !withRows.has(o.ownerId)) out.add(o.ownerId);
  return out;
}

interface SlotRow {
  id: string;
  kind: 'password' | 'challenge' | 'recovery';
  userId: string | null;
  secretRef: string | null;
  slot: Record<string, unknown>;
  email: string | null;
  passwordHash: string | null;
  answerHash: string | null;
  question: string | null;
}

async function slotRows(db: DB): Promise<SlotRow[]> {
  const rows = await db
    .select({
      id: fileKeySlots.id,
      kind: fileKeySlots.kind,
      userId: fileKeySlots.userId,
      secretRef: fileKeySlots.secretRef,
      slot: fileKeySlots.slot,
      email: users.email,
      passwordHash: users.passwordHash,
      answerHash: users.challengeAnswerHash,
      question: users.challengeQuestion,
    })
    .from(fileKeySlots)
    .leftJoin(users, eq(users.id, fileKeySlots.userId));
  return rows as SlotRow[];
}

type SlotHealth = 'ok' | 'stale' | 'inactive';

function healthOf(r: SlotRow, active: Set<string>): SlotHealth {
  if (r.kind === 'recovery') return 'ok';
  if (!r.userId || !active.has(r.userId)) return 'inactive';
  if (r.kind === 'password') {
    if (!r.passwordHash || r.passwordHash === 'dev') return 'inactive';
    return r.secretRef && r.secretRef === secretRef(r.passwordHash) ? 'ok' : 'stale';
  }
  if (!r.answerHash || !r.question) return 'inactive';
  return r.secretRef && r.secretRef === secretRef(r.answerHash) ? 'ok' : 'stale';
}

/**
 * The slots the company file's manifest gets on this save: active users' slots made for their
 * current password / answer, and the recovery slot. Lookup tags are computed from the current user
 * names (a renamed user keeps their slot). Deactivated or removed users are simply left out.
 */
export async function manifestSlots(db: DB, lookupSalt: string): Promise<Array<Record<string, unknown>>> {
  const active = await activeUserIds(db);
  const out: Array<Record<string, unknown>> = [];
  for (const r of await slotRows(db)) {
    if (healthOf(r, active) !== 'ok' || !fileCrypto.wellFormedSlot(r.slot)) continue;
    const base = { ...r.slot, kind: r.kind } as Record<string, unknown>;
    delete base.tag;
    delete base.question;
    if (r.kind === 'recovery') out.push(base);
    else if (r.kind === 'password') out.push({ ...base, tag: fileCrypto.lookupTag(lookupSalt, r.email ?? '') });
    else out.push({ ...base, tag: fileCrypto.lookupTag(lookupSalt, r.email ?? ''), question: r.question });
  }
  return out;
}

/**
 * What a save, a backup or a copy of this folder is sealed with: the file key and the current
 * slots — or null for a company file without passwords. A protected file whose key is not in
 * memory is refused (never written without its encryption).
 */
export async function sealProtectionFor(db: DB, dataDir: string = resolveDataDir()): Promise<SealProtection | null> {
  const prot = await readProtection(db);
  if (!prot) {
    if (isMarkedProtected(dataDir)) throw new ServiceError('FORBIDDEN', KEY_MISSING_MESSAGE, { fileKeyMissing: true });
    return null;
  }
  const key = fileKeyFor(dataDir);
  if (!key || fileCrypto.keyCheckOf(key) !== prot.keyCheck) {
    throw new ServiceError('FORBIDDEN', KEY_MISSING_MESSAGE, { fileKeyMissing: true });
  }
  const sp: SealProtection = { fileKey: key, keyCheck: prot.keyCheck, lookupSalt: prot.lookupSalt, slots: await manifestSlots(db, prot.lookupSalt) };
  keyState().cache.set(dirKey(dataDir), sp);
  return sp;
}

/**
 * The protection a synchronous backup of `dataDir` uses (lib/services/backup.ts createBackup when
 * the caller did not pass one): the last slot set built for the folder. Throws for a protected
 * folder whose key or slots are not known here; null for a folder without passwords.
 */
export function cachedSealProtection(dataDir: string = resolveDataDir()): SealProtection | null {
  const hit = keyState().cache.get(dirKey(dataDir));
  const key = fileKeyFor(dataDir);
  if (hit && key && key.equals(hit.fileKey)) return hit;
  if (isMarkedProtected(dataDir)) throw new ServiceError('FORBIDDEN', KEY_MISSING_MESSAGE, { fileKeyMissing: true });
  return null;
}

async function upsertSlot(
  db: DB,
  row: { kind: 'password' | 'challenge' | 'recovery'; userId: string | null; tag?: string | null; question?: string | null; secretRef: string | null; slot: Record<string, unknown> },
): Promise<void> {
  const where =
    row.kind === 'recovery'
      ? eq(fileKeySlots.kind, 'recovery')
      : and(eq(fileKeySlots.kind, row.kind), eq(fileKeySlots.userId, row.userId as string));
  const now = new Date();
  const updated = await db
    .update(fileKeySlots)
    .set({ tag: row.tag ?? null, question: row.question ?? null, secretRef: row.secretRef, slot: row.slot, updatedAt: now })
    .where(where)
    .returning({ id: fileKeySlots.id });
  if (!updated.length) {
    await db.insert(fileKeySlots).values({
      kind: row.kind,
      userId: row.userId,
      tag: row.tag ?? null,
      question: row.question ?? null,
      secretRef: row.secretRef,
      slot: row.slot,
    });
  }
}

/**
 * Write a slot made (for a few hundred milliseconds of scrypt) with `madeWith`, for the file key the
 * database names NOW: in one transaction with re-reading the protection record, so it can't
 * interleave with a key change (rotateFileKey runs in its own transaction). When the key changed
 * while the slot was being made, the slot is re-wrapped for the new key (it was made for the old
 * one, whose MAC vouches for it). Returns false when the current key is not known here.
 */
async function upsertSlotForKey(db: DB, madeWith: Buffer, row: Parameters<typeof upsertSlot>[1]): Promise<boolean> {
  let written = false;
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    const prot = await readProtection(tx);
    if (!prot) return;
    let slot: Record<string, unknown> | null = row.slot;
    if (fileCrypto.keyCheckOf(madeWith) !== prot.keyCheck) {
      const current = keyByCheck(prot.keyCheck);
      slot = current ? fileCrypto.rewrapSlot(row.slot, madeWith, current) : null;
    }
    if (!slot) return;
    await upsertSlot(tx, { ...row, slot });
    written = true;
  });
  return written;
}

/** The protection row and the key in memory, when both are there (else null: nothing can be wrapped). */
async function keyAndProtection(db: DB): Promise<{ prot: ProtectionRow; key: Buffer } | null> {
  const prot = await readProtection(db);
  if (!prot) return null;
  const key = fileKeyFor();
  if (!key || fileCrypto.keyCheckOf(key) !== prot.keyCheck) return null;
  return { prot, key };
}

/**
 * The user's password slot, made (or re-made) for `password` — called whenever a password is set:
 * changed, reset, set by an Admin, or a new user added. No-op for a file without passwords, or
 * when the file key is not known here (the user then needs to sign in once while it is).
 */
export async function syncPasswordSlot(db: DB, userId: string, password: string, opts: { rotate?: boolean } = {}): Promise<boolean> {
  const kp = await keyAndProtection(db);
  if (!kp) return false;
  const [u] = await db.select({ email: users.email, hash: users.passwordHash }).from(users).where(eq(users.id, userId));
  if (!u || !u.hash || u.hash === 'dev') return false;
  const tag = fileCrypto.lookupTag(kp.prot.lookupSalt, u.email);
  const slot = await fileCrypto.makeSlot({ kind: 'password', secret: password, fileKey: kp.key, tag });
  if (!(await upsertSlotForKey(db, kp.key, { kind: 'password', userId, tag, secretRef: secretRef(u.hash), slot }))) return false;
  // A replaced password (changed, reset, set by an Admin): the old one must not open anything
  // saved from now on — not even through an older copy of the file, whose slot still holds it.
  if (opts.rotate) requestFileKeyRotation();
  return true;
}

/**
 * The user's challenge slot for their (new) question and answer — only for an answer strong
 * enough to guard the whole file (lib/challengeQuestions.ts challengeAnswerOpensFile): a shorter
 * one still resets the password while the file is open, but its slot is removed (it never opens
 * the encrypted file). Returns whether the answer opens the file now.
 */
export async function syncChallengeSlot(db: DB, userId: string, question: string, answer: string): Promise<boolean> {
  const kp = await keyAndProtection(db);
  if (!kp) return false;
  const [u] = await db.select({ email: users.email, hash: users.challengeAnswerHash }).from(users).where(eq(users.id, userId));
  if (!u || !u.hash) return false;
  // The old answer must not open anything saved from now on.
  requestFileKeyRotation();
  if (!challengeAnswerOpensFile(answer)) {
    await db.delete(fileKeySlots).where(and(eq(fileKeySlots.kind, 'challenge'), eq(fileKeySlots.userId, userId)));
    return false;
  }
  const tag = fileCrypto.lookupTag(kp.prot.lookupSalt, u.email);
  const slot = await fileCrypto.makeSlot({ kind: 'challenge', secret: normalizeChallengeAnswer(answer), fileKey: kp.key, tag, question });
  return upsertSlotForKey(db, kp.key, { kind: 'challenge', userId, tag, question, secretRef: secretRef(u.hash), slot });
}

/**
 * After a successful sign-in (the password was checked against the users table): make sure the
 * user's slot opens the file with this password — create it when missing, re-wrap it when it is
 * stale (made for another password, or with a weaker cost than today's). Also used for teammates
 * signing in to a hosted file from another computer: they can open the file themselves later.
 * Returns whether the user's slot is good now (false: no key here, or a file without passwords).
 */
export async function refreshSlotAtSignIn(db: DB, user: { id: string; passwordHash: string }, password: string): Promise<boolean> {
  const kp = await keyAndProtection(db);
  if (!kp) return false;
  const [row] = await db
    .select({ secretRef: fileKeySlots.secretRef, slot: fileKeySlots.slot })
    .from(fileKeySlots)
    .where(and(eq(fileKeySlots.kind, 'password'), eq(fileKeySlots.userId, user.id)));
  // Fresh: made for this password, at today's cost, and re-wrappable (a slot of the first layout
  // has no public key, so a key change could not keep it: re-made now, while the password is here).
  const fresh =
    row &&
    row.secretRef === secretRef(user.passwordHash) &&
    fileCrypto.wellFormedSlot(row.slot) &&
    fileCrypto.kdfIsCurrent((row.slot as { kdf?: unknown }).kdf, 'password') &&
    fileCrypto.slotMacOk(kp.key, row.slot);
  if (fresh) return true;
  return syncPasswordSlot(db, user.id, password);
}

/**
 * Sign-in to a protected database whose file key is not in memory yet (the working copy that was
 * already on this computer; a sandbox or training copy): unwrap it from the user's own slot.
 * Returns true when the key is now known.
 */
export async function loadKeyFromPassword(db: DB, dataDir: string, userId: string, password: string): Promise<boolean> {
  const prot = await readProtection(db);
  if (!prot) return false;
  const have = fileKeyFor(dataDir);
  if (have && fileCrypto.keyCheckOf(have) === prot.keyCheck) return true;
  const rows = await db.select({ slot: fileKeySlots.slot }).from(fileKeySlots).where(and(eq(fileKeySlots.kind, 'password'), eq(fileKeySlots.userId, userId)));
  if (!rows.length) {
    await fileCrypto.burnKdf(password);
    return false;
  }
  for (const r of rows) {
    const key = await fileCrypto.openSlot(r.slot, password);
    if (key && fileCrypto.keyCheckOf(key) === prot.keyCheck) {
      rememberFileKey(dataDir, key);
      writeMarker(dataDir, prot.keyCheck);
      return true;
    }
  }
  return false;
}

/** The same with the user's challenge answer (sealed 'key' mode, "I forgot my password"). */
export async function loadKeyFromChallenge(db: DB, dataDir: string, userId: string, answer: string): Promise<boolean> {
  const prot = await readProtection(db);
  if (!prot) return false;
  const rows = await db.select({ slot: fileKeySlots.slot }).from(fileKeySlots).where(and(eq(fileKeySlots.kind, 'challenge'), eq(fileKeySlots.userId, userId)));
  for (const r of rows) {
    const key = await fileCrypto.openSlot(r.slot, normalizeChallengeAnswer(answer));
    if (key && fileCrypto.keyCheckOf(key) === prot.keyCheck) {
      rememberFileKey(dataDir, key);
      writeMarker(dataDir, prot.keyCheck);
      return true;
    }
  }
  if (!rows.length) await fileCrypto.burnKdf(answer, 'challenge');
  return false;
}

/** The same with the recovery key. */
export async function loadKeyFromRecovery(db: DB, dataDir: string, recoveryKey: string): Promise<boolean> {
  const prot = await readProtection(db);
  const normalized = fileCrypto.normalizeRecoveryKey(recoveryKey);
  if (!prot || !normalized) {
    await fileCrypto.burnKdf(recoveryKey);
    return false;
  }
  const [r] = await db.select({ slot: fileKeySlots.slot }).from(fileKeySlots).where(eq(fileKeySlots.kind, 'recovery'));
  if (!r) {
    await fileCrypto.burnKdf(recoveryKey);
    return false;
  }
  const key = await fileCrypto.openSlot(r.slot, normalized);
  if (!key || fileCrypto.keyCheckOf(key) !== prot.keyCheck) return false;
  rememberFileKey(dataDir, key);
  writeMarker(dataDir, prot.keyCheck);
  return true;
}

// ---------------------------------------------------------------------------
// Turning protection on, the recovery key
// ---------------------------------------------------------------------------

/** The open company file (desktop): only a single company file can be protected. */
export function companyFileForProtection(): string | null {
  const f = process.env.BKA_COMPANY_FILE;
  return f ? path.resolve(f) : null;
}

async function makeRecoverySlot(db: DB, key: Buffer): Promise<string> {
  const recoveryKey = fileCrypto.generateRecoveryKey();
  const slot = await fileCrypto.makeSlot({ kind: 'recovery', secret: fileCrypto.normalizeRecoveryKey(recoveryKey) as string, fileKey: key });
  knowKey(key);
  if (!(await upsertSlotForKey(db, key, { kind: 'recovery', userId: null, secretRef: null, slot }))) {
    throw new ServiceError('FORBIDDEN', KEY_MISSING_MESSAGE, { fileKeyMissing: true });
  }
  await db.update(fileProtection).set({ recoveryCreatedAt: new Date() }).where(eq(fileProtection.id, 1));
  return recoveryKey;
}

/** A new file key for protecting the open company file, held in this server's memory from now on. */
export interface PendingProtection {
  key: Buffer;
  keyCheck: string;
  lookupSalt: string;
  dataDir: string;
}

const ONLY_SINGLE_FILE_MESSAGE =
  'Only a single company file (.ironbooks) can be protected with passwords. Save it as a single company file first (File > Save as a Single Company File).';

/** Start protecting the open company file: a fresh random file key (never written anywhere). */
export function newFileProtection(dataDir: string = resolveDataDir()): PendingProtection {
  if (!companyFileForProtection()) throw new ServiceError('VALIDATION', ONLY_SINGLE_FILE_MESSAGE);
  const key = fileCrypto.generateFileKey();
  rememberFileKey(dataDir, key);
  return { key, keyCheck: fileCrypto.keyCheckOf(key), lookupSalt: fileCrypto.newLookupSalt(), dataDir };
}

/** The protection was never written (its transaction failed): forget its key again. */
export function abandonFileProtection(p: PendingProtection): void {
  const held = keyState().keys.get(dirKey(p.dataDir));
  if (held && held.equals(p.key)) keyState().keys.delete(dirKey(p.dataDir));
}

/**
 * Write the protection of the company file inside the caller's transaction: the protection row,
 * the user's password slot (and challenge slot when the answer is given) and the recovery slot.
 * Returns the recovery key — ONCE, to be shown, printed or saved; it is never stored readable.
 * Called in the same transaction as a new file's first Admin (app/api/auth/signup), so no save
 * can ever hold that Admin without the protection that seals it.
 */
export async function writeFileProtection(
  tx: DB,
  p: PendingProtection,
  input: { userId: string; password: string; challenge?: { question: string; answer: string } | null },
): Promise<string> {
  await tx.insert(fileProtection).values({ id: 1, keyCheck: p.keyCheck, lookupSalt: p.lookupSalt, protectedBy: input.userId });
  const [u] = await tx.select({ email: users.email, hash: users.passwordHash, answerHash: users.challengeAnswerHash }).from(users).where(eq(users.id, input.userId));
  if (!u) throw new ServiceError('NOT_FOUND', 'User not found.');
  const tag = fileCrypto.lookupTag(p.lookupSalt, u.email);
  await upsertSlot(tx, {
    kind: 'password',
    userId: input.userId,
    tag,
    secretRef: secretRef(u.hash),
    slot: await fileCrypto.makeSlot({ kind: 'password', secret: input.password, fileKey: p.key, tag }),
  });
  // A challenge answer guards the whole file only when it is long enough (challengeAnswerOpensFile).
  if (input.challenge && u.answerHash && challengeAnswerOpensFile(input.challenge.answer)) {
    await upsertSlot(tx, {
      kind: 'challenge',
      userId: input.userId,
      tag,
      question: input.challenge.question,
      secretRef: secretRef(u.answerHash),
      slot: await fileCrypto.makeSlot({ kind: 'challenge', secret: normalizeChallengeAnswer(input.challenge.answer), fileKey: p.key, tag, question: input.challenge.question }),
    });
  }
  const recoveryKey = await makeRecoverySlot(tx, p.key);
  await logTransaction(tx, {
    userId: input.userId,
    action: 'update',
    entityType: 'company_file',
    entityId: null,
    summary: 'Protected the company file with passwords (encrypted)',
    data: { new: { protected: true } }, // never a key or a password
  });
  return recoveryKey;
}

/** After the protection's transaction committed: the folder's marker and the slot set for saves. */
export async function fileProtectionWritten(db: DB, p: PendingProtection): Promise<void> {
  writeMarker(p.dataDir, p.keyCheck);
  await sealProtectionFor(db, p.dataDir).catch(() => null);
}

/**
 * Protect the company file with passwords: a new file key, the caller's password slot (and their
 * challenge slot when the answer is given), a recovery key (returned ONCE — shown to be printed or
 * saved) and the protection row. The next save writes the file encrypted (the change moves the
 * transaction log, so the autosave writes it within seconds). Other users get their slot the next
 * time they sign in while the file is open, or when an Admin sets their password.
 */
export async function protectCompanyFile(
  db: DB,
  input: { userId: string; password: string; challenge?: { question: string; answer: string } | null },
): Promise<{ recoveryKey: string }> {
  if (!companyFileForProtection()) throw new ServiceError('VALIDATION', ONLY_SINGLE_FILE_MESSAGE);
  if (await readProtection(db)) throw new ServiceError('CONFLICT', 'This company file is already protected with passwords.');
  const p = newFileProtection();
  let recoveryKey = '';
  try {
    await db.transaction(async (txRaw) => {
      recoveryKey = await writeFileProtection(txRaw as unknown as DB, p, input);
    });
  } catch (err) {
    abandonFileProtection(p);
    throw err;
  }
  await fileProtectionWritten(db, p);
  return { recoveryKey };
}

/**
 * What a backup or copy of the company folder `dataDir` is sealed with (lib/services/backup.ts and
 * friends): its protection, or null for a file without passwords. Throws for a protected folder
 * whose key is not known here (never written in plain text).
 */
export async function protectionForDir(dataDir?: string): Promise<SealProtection | null> {
  const dir = resolveDataDir(dataDir);
  // No database there (nothing to back up yet): never create one just to ask.
  if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) {
    if (isMarkedProtected(dir)) throw new ServiceError('FORBIDDEN', KEY_MISSING_MESSAGE, { fileKeyMissing: true });
    return null;
  }
  let db: DB;
  try {
    db = await withDamagedFileAccess(() => getDb(dir));
  } catch (err) {
    // The database there cannot be opened at all (a damaged file, or a folder that only looks
    // like one): the backup still goes out for a file without passwords. A marked protected
    // file is refused, never written in plain text.
    if (isMarkedProtected(dir)) throw err;
    return null;
  }
  return sealProtectionFor(db, dir);
}

/** Company > Security: Protect this company file (an Admin of every company, with their password). */
export async function enableProtection(
  ctx: { db: DB; userId: string | null },
  input: { password: string },
): Promise<{ recoveryKey: string }> {
  await requireFileAdmin(ctx);
  const userId = ctx.userId as string;
  const [u] = await ctx.db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, userId));
  if (!u || typeof input.password !== 'string' || !(await verifyPassword(input.password, u.hash))) {
    throw new ServiceError('FORBIDDEN', 'Your password is not correct.', { wrongPassword: true });
  }
  return protectCompanyFile(ctx.db, { userId, password: input.password });
}

/**
 * A new recovery key (the old one stops opening the file from its next save). Needs an Admin of
 * every company and their password. Returned once.
 */
export async function regenerateRecoveryKey(
  ctx: { db: DB; userId: string | null },
  input: { password: string },
): Promise<{ recoveryKey: string }> {
  await requireFileAdmin(ctx);
  const userId = ctx.userId as string;
  const [u] = await ctx.db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, userId));
  if (!u || typeof input.password !== 'string' || !(await verifyPassword(input.password, u.hash))) {
    throw new ServiceError('FORBIDDEN', 'Your password is not correct.', { wrongPassword: true });
  }
  const kp = await keyAndProtection(ctx.db);
  if (!kp) {
    if (await readProtection(ctx.db)) throw new ServiceError('FORBIDDEN', KEY_MISSING_MESSAGE, { fileKeyMissing: true });
    throw new ServiceError('VALIDATION', 'This company file is not protected with passwords yet.');
  }
  let recoveryKey = '';
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    recoveryKey = await makeRecoverySlot(tx, kp.key);
    await logTransaction(tx, {
      userId,
      action: 'update',
      entityType: 'company_file',
      entityId: null,
      summary: 'Made a new recovery key for the company file (the old one no longer opens it)',
      data: { new: { recoveryKeyReplaced: true } },
    });
  });
  // The old recovery key still opens older copies of the file: a new file key, so it opens
  // nothing saved from now on.
  const r = await rotateFileKey(ctx.db, { userId, reason: 'new recovery key' });
  // Waiting for slots of the first protected build to be re-made: made by a later save.
  if (r.deferredForOldSlots) requestFileKeyRotation();
  return { recoveryKey };
}

// ---------------------------------------------------------------------------
// Changing the file key
// ---------------------------------------------------------------------------

/** Ask for a new file key at the next save of `dataDir` (a secret was replaced or a user removed). */
export function requestFileKeyRotation(dataDir: string = resolveDataDir()): void {
  keyState().rotate.add(dirKey(dataDir));
}

/** True when a key change waits for the next save of `dataDir`. */
export function fileKeyRotationPending(dataDir: string = resolveDataDir()): boolean {
  return keyState().rotate.has(dirKey(dataDir));
}

export interface KeyRotationResult {
  rotated: boolean;
  /** Slots re-wrapped for the new key (users who still open the file, the recovery key). */
  kept: number;
  /** Slots dropped: removed users, replaced secrets, and slots of the first layout (no public key). */
  dropped: number;
  /** The recovery key still opens the file (false: an Admin should make a new one). */
  recoveryKept: boolean;
  /** Not changed yet: this many slots of the first protected build would be dropped (they are re-made first). */
  deferredForOldSlots?: number;
}

/**
 * Give the company file a NEW file key (in the caller's absence of a transaction — it opens its
 * own): every slot that should still open the file is re-wrapped for the new key without its
 * secret (fileCrypto.rewrapSlot), every other slot is dropped, and the protection record names the
 * new key. From the next save on, the file — and every backup or copy made from it — opens only
 * with the remaining secrets; an old password, a removed user, an old recovery key or anyone who
 * held the old key (an old copy of the file) can't open it. Users whose slot could not be kept
 * (made by the first protected version) are listed as "needs to sign in once" until they do.
 * No-op for a file without passwords or whose key is not known here.
 */
export async function rotateFileKey(
  db: DB,
  opts: { dataDir?: string; userId?: string | null; reason?: string; force?: boolean } = {},
): Promise<KeyRotationResult> {
  const dataDir = resolveDataDir(opts.dataDir);
  const none: KeyRotationResult = { rotated: false, kept: 0, dropped: 0, recoveryKept: false };
  const next = fileCrypto.generateFileKey();
  const nextCheck = fileCrypto.keyCheckOf(next);
  // Known before the change commits: a slot being made meanwhile (upsertSlotForKey) finds it.
  knowKey(next);
  let kept = 0;
  let dropped = 0;
  let recoveryKept = false;
  let deferred = 0;
  const st: { key: Buffer | null } = { key: null };
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    // Read inside the transaction: no slot write (upsertSlotForKey) can interleave.
    const prot = await readProtection(tx);
    const key = prot ? keyByCheck(prot.keyCheck) : null;
    st.key = key;
    const held = fileKeyFor(dataDir);
    if (!prot || !key || !held || !held.equals(key)) return;
    const active = await activeUserIds(tx);
    const rows = await slotRows(tx);
    // Slots made by the first protected build have no public key: a key change would drop them
    // (their user could no longer open the file elsewhere; a recovery key would stop working). An
    // automatic change waits until they are re-made — each user's next sign-in does it, a new
    // recovery key replaces the old one. "Change the File Key" (force) goes ahead and says so.
    deferred = rows.filter((r) => healthOf(r, active) === 'ok' && !fileCrypto.isRewrappable(r.slot)).length;
    if (deferred && !opts.force) return;
    for (const r of rows) {
      // A deactivated user's slot is kept for the new key INSIDE the encrypted database only (it is
      // left out of every save's manifest while they are inactive), so reactivating them lets them
      // in again; it can't be reached without the new key. A slot made for a replaced secret goes.
      const h = healthOf(r, active);
      const re = h === 'ok' || h === 'inactive' ? fileCrypto.rewrapSlot(r.slot, key, next) : null;
      if (re) {
        await tx.update(fileKeySlots).set({ slot: re, updatedAt: new Date() }).where(eq(fileKeySlots.id, r.id));
        kept++;
        if (r.kind === 'recovery') recoveryKept = true;
      } else {
        await tx.delete(fileKeySlots).where(eq(fileKeySlots.id, r.id));
        dropped++;
      }
    }
    await tx
      .update(fileProtection)
      .set({ keyCheck: nextCheck, previousKeyCheck: prot.keyCheck, ...(recoveryKept ? {} : { recoveryCreatedAt: null }) })
      .where(eq(fileProtection.id, 1));
    await logTransaction(tx, {
      userId: opts.userId ?? null,
      action: 'update',
      entityType: 'company_file',
      entityId: null,
      summary: `Changed the file key of the company file${opts.reason ? ` (${opts.reason})` : ''}: older copies and replaced passwords no longer open what is saved from now on`,
      data: { new: { fileKeyChanged: true, slotsKept: kept, slotsDropped: dropped } }, // never a key
    });
    st.key = next; // committed below
  });
  if (!st.key || !st.key.equals(next)) {
    keyState().byCheck.delete(nextCheck);
    return { ...none, ...(deferred ? { deferredForOldSlots: deferred } : {}) };
  }
  rememberFileKey(dataDir, next);
  writeMarker(dataDir, nextCheck);
  keyState().rotate.delete(dirKey(dataDir));
  await sealProtectionFor(db, dataDir).catch(() => null);
  return { rotated: true, kept, dropped, recoveryKept };
}

/**
 * The next save: make the key change asked for since the last one (companyFileSave doSave). One
 * waiting for slots of the first protected build to be re-made stays asked for.
 */
export async function applyPendingKeyRotation(db: DB, dataDir: string = resolveDataDir()): Promise<KeyRotationResult | null> {
  if (!fileKeyRotationPending(dataDir)) return null;
  const res = await rotateFileKey(db, { dataDir, reason: 'a password, challenge answer or user changed' });
  if (!res.deferredForOldSlots) keyState().rotate.delete(dirKey(dataDir));
  return res;
}

/**
 * Company > Security: "Change the File Key" (an Admin of every company, with their password) —
 * locks out removed users and old copies of the file right away. Everyone who opens the file now
 * keeps opening it; the recovery key stays the same.
 */
export async function changeFileKey(ctx: { db: DB; userId: string | null }, input: { password: string }): Promise<KeyRotationResult> {
  await requireFileAdmin(ctx);
  const userId = ctx.userId as string;
  const [u] = await ctx.db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, userId));
  if (!u || typeof input.password !== 'string' || !(await verifyPassword(input.password, u.hash))) {
    throw new ServiceError('FORBIDDEN', 'Your password is not correct.', { wrongPassword: true });
  }
  if (!(await keyAndProtection(ctx.db))) {
    if (await readProtection(ctx.db)) throw new ServiceError('FORBIDDEN', KEY_MISSING_MESSAGE, { fileKeyMissing: true });
    throw new ServiceError('VALIDATION', 'This company file is not protected with passwords yet.');
  }
  // Your own slot is made fresh first, so you keep opening the file whatever layout it had.
  await syncPasswordSlot(ctx.db, userId, input.password);
  return rotateFileKey(ctx.db, { userId, reason: 'asked for by an Admin', force: true });
}

/**
 * A copy of this file for someone else (a portable file, an Accountant's Copy, a Period Copy):
 * its OWN new file key, with every slot that opens this file re-wrapped for it — so the restored
 * copy opens with the same user names, passwords and recovery key, while the copy (and whoever
 * holds its password) never learns this file's key. `userId` (who makes the copy) must keep
 * opening it. Null for a file without passwords.
 */
export async function copyKeyFor(db: DB, dataDir: string, userId: string | null): Promise<CarriedCopyKey | null> {
  // One consistent read (a key change can't land between the protection record and the slots).
  const snap = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    const prot = await readProtection(tx);
    if (!prot) return null;
    return { prot, active: await activeUserIds(tx), rows: await slotRows(tx) };
  });
  if (!snap) return null;
  const key = keyByCheck(snap.prot.keyCheck);
  if (!key || !fileKeyFor(dataDir)) throw new ServiceError('FORBIDDEN', KEY_MISSING_MESSAGE, { fileKeyMissing: true });
  const next = fileCrypto.generateFileKey();
  const active = snap.active;
  const slots: CarriedCopyKey['slots'] = [];
  let mine = false;
  for (const r of snap.rows) {
    if (healthOf(r, active) !== 'ok') continue;
    const re = fileCrypto.rewrapSlot(r.slot, key, next);
    if (!re) continue;
    slots.push({ id: r.id, slot: re });
    if (r.kind === 'password' && r.userId === userId) mine = true;
  }
  if (userId && !mine) {
    throw new ServiceError('VALIDATION', 'Sign out and sign in again first, so your password opens the copy too. Then make the copy again.');
  }
  return { v: 2, keyCheck: fileCrypto.keyCheckOf(next), fileKey: next.toString('base64'), slots };
}

/** What travels inside an encrypted copy (portableFile PORTABLE_KEY_ENTRY): the copy's own key and slots. */
export interface CarriedCopyKey {
  v: 2;
  keyCheck: string;
  fileKey: string;
  slots: Array<{ id: string; slot: Record<string, unknown> }>;
}

/**
 * A restored copy whose own key travelled with it (copyKeyFor): its protection record names that
 * key, its slots are the re-wrapped ones (any other slot is dropped), and the key is known here —
 * the restored books are written encrypted with it, and open with the same secrets as the file
 * they were copied from.
 */
export async function adoptCopyKey(db: DB, dataDir: string, carried: CarriedCopyKey): Promise<boolean> {
  const key = Buffer.from(String(carried.fileKey), 'base64');
  if (key.length !== fileCrypto.KEY_BYTES || fileCrypto.keyCheckOf(key) !== carried.keyCheck || !(await readProtection(db))) return false;
  const keep = new Map((Array.isArray(carried.slots) ? carried.slots : []).filter((s) => s && typeof s.id === 'string' && fileCrypto.slotMacOk(key, s.slot)).map((s) => [s.id, s.slot]));
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    for (const r of await tx.select({ id: fileKeySlots.id }).from(fileKeySlots)) {
      const slot = keep.get(r.id);
      if (slot) await tx.update(fileKeySlots).set({ slot, updatedAt: new Date() }).where(eq(fileKeySlots.id, r.id));
      else await tx.delete(fileKeySlots).where(eq(fileKeySlots.id, r.id));
    }
    await tx.update(fileProtection).set({ keyCheck: carried.keyCheck }).where(eq(fileProtection.id, 1));
  });
  return adoptCarriedKey(db, dataDir, key);
}

/**
 * Copies of a protected company file are protected too (never plain-text books on disk): a
 * portable file, an Accountant's Copy or a Period Copy of it must be given a password.
 */
export async function assertCopyPasswordGiven(db: DB, password: string | null | undefined): Promise<void> {
  if (password) return;
  if (await readProtection(db)) {
    throw new ServiceError(
      'VALIDATION',
      'This company file is protected with passwords, so its copies are too: give the file a password of at least 8 characters.',
    );
  }
}

export interface ProtectionUserStatus {
  userId: string;
  name: string;
  login: string;
  /** Their password opens the file. */
  canOpen: boolean;
  /** Their access was made by the first protected build: it is re-made at their next sign-in (until then the file key can't change). */
  oldLayout?: boolean;
  /** 'ok' their answer opens it too; 'missing' a question is set but has no slot; 'none' no question. */
  challenge: 'ok' | 'missing' | 'none';
}

export interface ProtectionStatus {
  /** A single company file (only those can be protected). */
  singleFile: boolean;
  protected: boolean;
  /** The file key is known here (saves and backups can be encrypted). */
  keyAvailable: boolean;
  protectedAt: string | null;
  recoveryCreatedAt: string | null;
  /** A recovery key opens the file (false: an Admin should make one). */
  hasRecoveryKey: boolean;
  /** The recovery key was made by the first protected build: make a new one (until then the file key can't change by itself). */
  oldRecoveryKey?: boolean;
  /** The caller may turn protection on / make a new recovery key (Admin of every company). */
  canManage: boolean;
  /** Your own password opens the file. */
  self: { canOpen: boolean; challenge: 'ok' | 'missing' | 'none' } | null;
  /** Every active user (Admins only). */
  users: ProtectionUserStatus[] | null;
}

/** Company > Security and Users & Roles: who can open the protected file. */
export async function protectionStatus(ctx: { db: DB; userId: string | null }): Promise<ProtectionStatus> {
  const prot = await readProtection(ctx.db);
  let canManage = false;
  try {
    await requireFileAdmin(ctx);
    canManage = true;
  } catch {
    canManage = false;
  }
  const active = await activeUserIds(ctx.db);
  const rows = prot ? await slotRows(ctx.db) : [];
  const people = await ctx.db
    .select({ id: users.id, name: users.name, login: users.email, hash: users.passwordHash, q: users.challengeQuestion, a: users.challengeAnswerHash })
    .from(users);
  const statusOf = (p: (typeof people)[number]): ProtectionUserStatus => {
    const pw = rows.find((r) => r.kind === 'password' && r.userId === p.id);
    const ch = rows.find((r) => r.kind === 'challenge' && r.userId === p.id);
    return {
      userId: p.id,
      name: p.name,
      login: p.login,
      canOpen: Boolean(pw && healthOf(pw, active) === 'ok'),
      ...(pw && healthOf(pw, active) === 'ok' && !fileCrypto.isRewrappable(pw.slot) ? { oldLayout: true } : {}),
      challenge: !p.q || !p.a ? 'none' : ch && healthOf(ch, active) === 'ok' ? 'ok' : 'missing',
    };
  };
  const me = ctx.userId ? people.find((p) => p.id === ctx.userId) : undefined;
  const key = fileKeyFor();
  return {
    singleFile: Boolean(companyFileForProtection()),
    protected: Boolean(prot),
    keyAvailable: Boolean(prot && key && fileCrypto.keyCheckOf(key) === prot.keyCheck),
    protectedAt: prot?.protectedAt ? new Date(prot.protectedAt).toISOString() : null,
    recoveryCreatedAt: prot?.recoveryCreatedAt ? new Date(prot.recoveryCreatedAt).toISOString() : null,
    hasRecoveryKey: rows.some((r) => r.kind === 'recovery' && fileCrypto.wellFormedSlot(r.slot)),
    oldRecoveryKey: rows.some((r) => r.kind === 'recovery' && fileCrypto.wellFormedSlot(r.slot) && !fileCrypto.isRewrappable(r.slot)),
    canManage,
    self: me && prot ? (({ canOpen, challenge }) => ({ canOpen, challenge }))(statusOf(me)) : null,
    users:
      canManage && prot
        ? people.filter((p) => active.has(p.id) && p.hash && p.hash !== 'dev').map(statusOf).sort((a, b) => a.name.localeCompare(b.name))
        : null,
  };
}

// ---------------------------------------------------------------------------
// The sealed server: unlock the file key from the company file's slots, make the working copy
// ---------------------------------------------------------------------------

/** The company file's plain manifest (sealed: its encryption block holds the slots). */
function sealedManifest(): Record<string, any> | null {
  const file = companyFileForProtection();
  if (!file) return null;
  const m = format.readCompanyManifest(file) as Record<string, any> | null;
  return m && format.isSealedManifest(m) ? m : null;
}

/** What the sign-in screen shows about a sealed company file (company-file/info). */
export function sealedFileInfo(): { companyName: string | null; fileId: string | null } | null {
  const m = sealedManifest();
  return m ? { companyName: typeof m.companyName === 'string' ? m.companyName : null, fileId: typeof m.fileId === 'string' ? m.fileId : null } : null;
}

/**
 * Try a secret on the company file's own slots (before the working copy exists): the file key or
 * null. Costs the same whether or not the user exists (fileCrypto.unlockWith).
 */
export async function unlockFromFile(input: { kind: 'password' | 'challenge' | 'recovery'; login?: string | null; secret: string }): Promise<Buffer | null> {
  const m = sealedManifest();
  const secret = input.kind === 'challenge' ? normalizeChallengeAnswer(input.secret) : input.kind === 'recovery' ? fileCrypto.normalizeRecoveryKey(input.secret) : input.secret;
  if (!m || !secret) {
    await fileCrypto.burnKdf(input.secret);
    return null;
  }
  return fileCrypto.unlockWith(m.encryption, { kind: input.kind, login: input.login ?? null, secret });
}

/** The challenge question of a user, from the sealed file's slots (null when they have none). */
export function sealedChallengeQuestion(login: string): string | null {
  const m = sealedManifest();
  if (!m) return null;
  const tag = fileCrypto.lookupTag(m.encryption.lookupSalt, login);
  const [slot] = fileCrypto.findSlots(m.encryption, 'challenge', tag);
  return slot && typeof slot.question === 'string' ? slot.question : null;
}

/**
 * The "unsaved changes" copy made when the file was opened (sealed conflict plan), for the answer
 * of the sign-in that made it — reported once, to the person on this computer.
 */
export function takeUnsealedConflictCopy(): string | null {
  const copy = keyState().conflictCopy;
  keyState().conflictCopy = null;
  return copy;
}

function statePathOf(): string | null {
  return process.env.BKA_COMPANY_STATE ? path.resolve(process.env.BKA_COMPANY_STATE) : null;
}

/**
 * Make the working copy of the sealed company file with its key, then let the database open:
 *   'conflict'  first keep the working copy's unsaved changes as a separate, protected company file
 *               next to the company file ("… (unsaved changes from PC, date).ironbooks");
 *   'extract' / 'conflict'  decrypt the company file into a fresh folder (every entry verified
 *               before it is written), then swap it in as the working copy;
 *   'key'       the working copy is already here: only the key is needed.
 * The database's own protection record is checked against the key. One unseal at a time; later
 * callers wait for it.
 */
export async function unsealCompanyFile(fileKey: Buffer): Promise<void> {
  const st = keyState();
  if (st.unseal) return st.unseal;
  if (!sealedMode()) return;
  st.unseal = doUnseal(fileKey).finally(() => {
    st.unseal = null;
  });
  return st.unseal;
}

async function doUnseal(fileKey: Buffer): Promise<void> {
  const mode = sealedMode();
  const dataDir = sealedDataDir();
  const file = companyFileForProtection();
  const m = sealedManifest();
  if (!mode || !dataDir || !file || !m) return;
  if (fileCrypto.keyCheckOf(fileKey) !== m.encryption.keyCheck) throw new ServiceError('FORBIDDEN', 'Invalid email or password.');
  const statePath = statePathOf();
  const workDir = path.dirname(dataDir);
  const protection: SealProtection = {
    fileKey,
    keyCheck: m.encryption.keyCheck,
    lookupSalt: m.encryption.lookupSalt,
    slots: Array.isArray(m.encryption.slots) ? m.encryption.slots : [],
  };
  if (mode === 'conflict' && session.hasData(workDir)) {
    const target = session.conflictCopyPath(file, os.hostname());
    try {
      await session.writeWorkingCopyAs(workDir, target, {
        companyName: `${m.companyName || format.companyFileBaseName(file)} (unsaved changes)`,
        appVersion: APP_VERSION,
        protection,
      });
      keyState().conflictCopy = target;
    } catch (err) {
      if ((err as { code?: string })?.code !== 'DAMAGED') throw err;
      // The unsaved changes are in books that would not start: no "(unsaved changes)" file that
      // will not open either. Kept on this computer for support, encrypted like the file.
      const secretFile = path.join(dataDir, '.auth-secret');
      const secret = fs.existsSync(secretFile) ? fs.readFileSync(secretFile) : null;
      const kept = await session.keepDamagedCopy(workDir, dataDir, { protection, companyName: m.companyName, appVersion: APP_VERSION });
      if (secret) {
        // This computer's session-signing key stays with the working copy (copied in below).
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(secretFile, secret);
      }
      const { noteDamagedUnsavedChanges } = await import('./workingCopyRecovery');
      noteDamagedUnsavedChanges(m.savedAt ?? null, kept);
    }
  }
  if (mode === 'extract' || mode === 'conflict') {
    const tmp = `${dataDir}.unseal-${Date.now()}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    let opened: Record<string, any>;
    try {
      opened = await format.extractCompanyFile(file, tmp, { fileKey });
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      if ((err as { code?: string })?.code === 'TAMPERED') {
        throw new ServiceError('CONFLICT', `${(err as Error).message} Open an earlier backup of it instead (File > Open or Restore Company).`);
      }
      throw err;
    }
    // This computer's session-signing key (never in the company file) stays with the working copy.
    const secret = path.join(dataDir, '.auth-secret');
    if (fs.existsSync(secret)) fs.copyFileSync(secret, path.join(tmp, '.auth-secret'));
    // A protected training file (lib/services/sandbox.ts keepSandboxAsTraining) carries its
    // training marker inside its encrypted details: the working copy is a training file again.
    if (opened.sandboxMarker && typeof opened.sandboxMarker === 'object' && m.training === true) {
      fs.writeFileSync(path.join(tmp, '.ironbooks-sandbox.json'), JSON.stringify(opened.sandboxMarker, null, 2));
    }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await format.renameWithRetry(tmp, dataDir);
    if (statePath) {
      session.writeState(workDir, {
        base: { saveId: m.saveId ?? null, savedAt: m.savedAt ?? null, fingerprint: opened.fingerprint ?? null },
        unsavedSince: null,
        conflictFingerprint: null,
        closedCleanly: false,
        ...(keyState().conflictCopy ? { conflictCopy: keyState().conflictCopy } : {}),
      });
    }
  }
  rememberFileKey(dataDir, fileKey);
  writeMarker(dataDir, protection.keyCheck);
  markUnsealed();
  // The save logic started before the working copy existed: let it read the new state.
  try {
    const save = await import('./companyFileSave');
    save.resetCompanyFileSaveState();
  } catch {
    /* not loaded */
  }
  const db = await getDb(dataDir);
  await adoptManifestProtection(db, protection);
  await sealProtectionFor(db, dataDir).catch(() => null);
  // Damaged copies of these books that had to be kept in plain text (nobody had signed in yet):
  // encrypted now that the key is known (lib/services/workingCopyRecovery.ts).
  const { sealKeptDamagedCopies } = await import('./workingCopyRecovery');
  await sealKeptDamagedCopies(dataDir, protection, m.companyName);
}

/**
 * The database must describe the same protection as the company file it came from. When it does
 * not (an "unsaved changes" copy made from a working copy older than the protection, a restore),
 * take the file's: its key check and lookup salt, and its slots matched to users by their lookup
 * tags (a user whose slot is not matched signs in once while the file is open).
 */
async function adoptManifestProtection(db: DB, protection: SealProtection): Promise<void> {
  const cur = await readProtection(db);
  if (cur && cur.keyCheck === protection.keyCheck) return;
  const people = await db.select({ id: users.id, email: users.email, hash: users.passwordHash, a: users.challengeAnswerHash }).from(users);
  const byTag = new Map(people.map((p) => [fileCrypto.lookupTag(protection.lookupSalt, p.email), p]));
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    await tx.delete(fileKeySlots);
    await tx.delete(fileProtection);
    await tx.insert(fileProtection).values({ id: 1, keyCheck: protection.keyCheck, lookupSalt: protection.lookupSalt });
    for (const s of protection.slots) {
      if (!fileCrypto.wellFormedSlot(s)) continue;
      // A re-wrappable slot must have been made for this key (its public key bound by the MAC):
      // a slot pasted into the plain manifest is never adopted, so never re-wrapped to later.
      if (fileCrypto.isRewrappable(s) && !fileCrypto.slotMacOk(protection.fileKey, s)) continue;
      const kind = s.kind as 'password' | 'challenge' | 'recovery';
      const clean = { ...s } as Record<string, unknown>;
      delete clean.tag;
      delete clean.question;
      if (kind === 'recovery') {
        await upsertSlot(tx, { kind, userId: null, secretRef: null, slot: clean });
        continue;
      }
      const p = typeof s.tag === 'string' ? byTag.get(s.tag) : undefined;
      if (!p) continue;
      await upsertSlot(tx, {
        kind,
        userId: p.id,
        tag: s.tag as string,
        question: kind === 'challenge' ? (s.question as string) ?? null : null,
        secretRef: secretRef(kind === 'password' ? p.hash : p.a),
        slot: clean,
      });
    }
  });
}

/**
 * Sealed 'key' plan (the working copy is already on this computer): a sign-in that unlocked the
 * key from the working copy's own slots lets the database open for everyone.
 */
export async function finishKeyUnseal(db?: DB): Promise<void> {
  if (sealedMode() !== 'key') return;
  // The open plan (reuse this working copy) was worked out from the company file's plain listing
  // before anyone signed in: check that listing against the file's encrypted contents now. A file
  // still sealed with the key used just before this working copy's last key change (the change was
  // not saved yet) can't be checked with this key: accepted only for exactly that previous key —
  // any other key check in the plain listing was edited, and is refused like any other change.
  const file = companyFileForProtection();
  const key = fileKeyFor();
  if (file && key) {
    const tampered = (message: string) =>
      new ServiceError('CONFLICT', `${message} Open an earlier backup of it instead (File > Open or Restore Company).`);
    try {
      const checked = await format.verifySealedCompanyFile(file, key);
      if (checked === null) {
        const m = format.readCompanyManifest(file) as Record<string, any> | null;
        if (m && format.isSealedManifest(m)) {
          const prot = db ? await readProtection(db) : null;
          if (!prot || !prot.previousKeyCheck || m.encryption.keyCheck !== prot.previousKeyCheck) {
            throw tampered(new fileCrypto.TamperedError('The details of the company file (its name, save or layout)').message);
          }
        }
      }
    } catch (err) {
      if ((err as { code?: string })?.code === 'TAMPERED') throw tampered((err as Error).message);
      throw err;
    }
  }
  markUnsealed();
  try {
    const save = await import('./companyFileSave');
    save.resetCompanyFileSaveState();
  } catch {
    /* not loaded */
  }
}

/**
 * Restoring a backup into a protected company file (lib/services/backup.ts): the restored books
 * keep the file protected. A backup sealed with this file's key carries its own slots; a backup
 * without passwords (made before protection) gets this file's protection and slots copied in; a
 * backup of ANOTHER protected file, opened with its own credentials, brings its key and slots —
 * the file is saved with that key from now on.
 */
export async function carryProtectionIntoRestore(db: DB, dataDir: string, before: { protection: ProtectionRow; slots: Array<typeof fileKeySlots.$inferSelect> } | null, restoredKey: Buffer | null): Promise<void> {
  const restored = await readProtection(db);
  if (restored) {
    if (restoredKey && fileCrypto.keyCheckOf(restoredKey) === restored.keyCheck) {
      rememberFileKey(dataDir, restoredKey);
      writeMarker(dataDir, restored.keyCheck);
      // An older key came back with the backup (made before a key change, or of another file):
      // whoever held that key must not open what is saved from now on — a new key at the next save.
      if (before && before.protection.keyCheck !== restored.keyCheck) requestFileKeyRotation(dataDir);
    }
    return;
  }
  if (!before) return;
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as DB;
    await tx.insert(fileProtection).values({
      id: 1,
      keyCheck: before.protection.keyCheck,
      lookupSalt: before.protection.lookupSalt,
      protectedAt: before.protection.protectedAt,
      protectedBy: null,
      recoveryCreatedAt: before.protection.recoveryCreatedAt,
    });
    const ids = new Set((await tx.select({ id: users.id }).from(users)).map((u) => u.id));
    for (const s of before.slots) {
      if (s.userId && !ids.has(s.userId)) continue;
      await tx.insert(fileKeySlots).values({ ...s });
    }
  });
  writeMarker(dataDir, before.protection.keyCheck);
}

/**
 * A restored copy whose file key travelled with it (inside a password-protected portable or
 * transfer file): when the key is the one its protection record names, it is known here from now
 * on — the restored books are written encrypted with it, and its slots open it as before.
 */
export async function adoptCarriedKey(db: DB, dataDir: string, key: Buffer): Promise<boolean> {
  const prot = await readProtection(db);
  if (!prot || fileCrypto.keyCheckOf(key) !== prot.keyCheck) return false;
  rememberFileKey(dataDir, key);
  writeMarker(dataDir, prot.keyCheck);
  await sealProtectionFor(db, dataDir).catch(() => null);
  return true;
}

/** The protection rows of a database, to carry into a restore (null for a file without passwords). */
export async function snapshotProtection(db: DB): Promise<{ protection: ProtectionRow; slots: Array<typeof fileKeySlots.$inferSelect> } | null> {
  const protection = await readProtection(db);
  if (!protection) return null;
  return { protection, slots: await db.select().from(fileKeySlots) };
}

/**
 * The key that opens a sealed backup or copy: this file's own key when it was made with it, else
 * the credentials given (a user name + password from that file, or its recovery key). Null when
 * nothing given opens it.
 */
export async function keyForSealedArchive(
  encryption: Record<string, any>,
  credentials?: { login?: string | null; password?: string | null; recoveryKey?: string | null } | null,
  dataDir: string = resolveDataDir(),
): Promise<Buffer | null> {
  const own = fileKeyFor(dataDir);
  if (own && encryption && fileCrypto.keyCheckOf(own) === encryption.keyCheck) return own;
  if (credentials?.recoveryKey) {
    const rk = fileCrypto.normalizeRecoveryKey(credentials.recoveryKey);
    if (!rk) return fileCrypto.burnKdf(credentials.recoveryKey);
    return fileCrypto.unlockWith(encryption, { kind: 'recovery', secret: rk });
  }
  if (credentials?.login && credentials?.password) {
    return fileCrypto.unlockWith(encryption, { kind: 'password', login: credentials.login, secret: credentials.password });
  }
  return null;
}
