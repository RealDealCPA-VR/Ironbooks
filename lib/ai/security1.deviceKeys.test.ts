/**
 * Security plan 1.3 — saved keys of outside services belong to the computer that entered them.
 *
 * AI provider keys, the "Continue with ChatGPT" sign-in and the mail server password were sealed
 * with the company file's vault secret, stored in plain text in the same database: anyone with a
 * copy of an unprotected company file, a backup or a portable file could open them. They are now
 * sealed with this computer's device secret (electron/deviceVault.js → BKA_DEVICE_VAULT, "v3:"),
 * one entry per computer when several computers open the same file ("v3m:"); the file's vault
 * secret is deleted once this computer has moved every value it can read. A file protected with
 * passwords keeps the in-file secret (the whole file and its copies are encrypted), and without a
 * device secret (tests, `next dev`) everything works exactly as before.
 *
 * Two "computers" are simulated by switching BKA_DEVICE_VAULT, and each re-opens the same data
 * folder (the shared company file) like a new launch would.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { eq, sql } from 'drizzle-orm';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-security1-device-keys');
const FILE = path.join(ROOT, 'shared-file');
const OLD_RESTORED = path.join(ROOT, 'restored-old-backup');
const NEW_RESTORED = path.join(ROOT, 'restored-new-backup');
const PORTABLE_RESTORED = path.join(ROOT, 'restored-portable');
const PORTABLE_ON_B = path.join(ROOT, 'restored-portable-on-b');
const PROTECTED = path.join(ROOT, 'protected-file');
delete process.env.BKA_AUTH_SECRET;
delete process.env.BKA_DEVICE_VAULT;
process.env.BKA_DATA_DIR = FILE;

import { closeDb, getDb, type DB } from '@/lib/db';
import { aiSettings, auditLogs, companyEmailSettings, fileProtection, fileSecrets, users } from '@/lib/db/schema';
import { createCompany } from '@/lib/services/company';
import { fullAccess } from '@/lib/permissions/model';
import { buildProviders, getPublicSettings, loadSettings, updateSettings } from '@/lib/services/aiSettings';
import { getEmailSetup, resolveMailConfig, saveEmailSetup, PASSWORD_NOT_HERE_MESSAGE } from '@/lib/services/emailSettings';
import { persistChatGptCredentials, saveChatGptConnection } from '@/lib/services/chatgptSignIn';
import { createBackup, restoreBackup } from '@/lib/services/backup';
import { createPortableCompanyFile, restorePortableCompanyFile } from '@/lib/services/portableFile';
import { PROTECTED_MARKER } from '@/lib/services/fileProtection';
import { parseCredentials, type ChatGptCredentials } from './chatgpt';
import type { ProviderDeps } from './providers';
import type { ServiceContext } from '@/lib/services/_base';
import {
  DEVICE_VAULT_ENV,
  MAX_COMPUTERS,
  PROTECTED_MARKER_NAME,
  decryptSecret,
  deviceKeyId,
  migrateStoredSecrets,
  openStoredSecret,
  readVaultSecret,
  sealStoredSecret,
} from './keyVault';

/** Each step re-opens, restores or copies a whole company file (slow when the suite runs in parallel). */
const SLOW = 240_000;

const PC_A = 'a1'.repeat(32);
const PC_B = 'b2'.repeat(32);
const KEY_1 = 'sk-ant-first-key-0123456789abcdef';
const KEY_2 = 'sk-ant-second-key-fedcba9876543210';
const MAIL_PW = 'Mailbox-Pass-77';
const SERVER = { host: '127.0.0.1', port: 2525, security: 'starttls' as const, username: 'billing@acme.test', fromEmail: 'billing@acme.test' };

let companyId: string;
let userId: string;
/** The vault secret the file had before this computer moved its keys (must be gone afterwards). */
let oldVault: string;
/** A full backup made by the previous version (v2 values + vault secret). */
let oldBackup: Buffer;

function onComputer(secret: string | null) {
  if (secret) process.env[DEVICE_VAULT_ENV] = secret;
  else delete process.env[DEVICE_VAULT_ENV];
}

/** Open the shared company file on a computer, as a new launch does (migration runs at open). */
async function openOn(secret: string | null, dir = FILE): Promise<DB> {
  await closeDb(dir);
  onComputer(secret);
  process.env.BKA_DATA_DIR = dir;
  return getDb(dir);
}

const ctxFor = (db: DB): ServiceContext => ({ db, companyId, userId, access: fullAccess(), role: 'owner' });

/** The key the Anthropic client would be built with on this computer (null: none readable). */
async function liveKey(db: DB): Promise<string | null> {
  let seen: string | null = null;
  const deps: ProviderDeps = {
    anthropicFactory: (cfg) => {
      seen = cfg.apiKey;
      return { messages: { create: async () => ({ content: [] }) }, models: { list: async () => ({ data: [] }) } };
    },
  };
  const s = await loadSettings(ctxFor(db));
  buildProviders(s.providers.filter((p) => p.kind === 'anthropic'), ctxFor(db), deps);
  return seen;
}

async function stored(db: DB) {
  const [ai] = await db.select().from(aiSettings).where(eq(aiSettings.companyId, companyId));
  const [mail] = await db.select().from(companyEmailSettings).where(eq(companyEmailSettings.companyId, companyId));
  const providers = (ai?.providers ?? []) as Array<{ kind: string; apiKeyEnc?: string | null }>;
  return {
    anthropic: providers.find((p) => p.kind === 'anthropic')?.apiKeyEnc ?? null,
    chatgpt: providers.find((p) => p.kind === 'chatgpt')?.apiKeyEnc ?? null,
    mail: mail?.passwordEnc ?? null,
  };
}

const creds = (accessToken: string, expiresAt: number): ChatGptCredentials => ({
  v: 1,
  clientId: 'app_ironbooks_test',
  accessToken,
  refreshToken: `${accessToken}-refresh`,
  expiresAt,
  scopes: ['openid', 'api.connectors.read'],
  subject: 'user-123',
  email: 'owner@acme.test',
});

/** Every file under a folder, as one buffer per file. */
function filesUnder(dir: string): Array<[string, Buffer]> {
  const out: Array<[string, Buffer]> = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile()) out.push([p, fs.readFileSync(p)]);
  }
  return out;
}

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  // (viii) The previous version, or no device secret: values sealed with the file's vault secret.
  const db = await openOn(null);
  const [u] = await db.insert(users).values({ email: 'owner-device@test.local', name: 'Owner', passwordHash: 'x' }).returning();
  userId = u.id;
  companyId = (await createCompany(db, { name: 'Device Keys Co', ownerId: userId })).id;
  await updateSettings(ctxFor(db), { providers: [{ kind: 'anthropic', label: 'Claude', model: '', enabled: true, apiKey: KEY_1 }] });
  await saveEmailSetup(ctxFor(db), { ...SERVER, password: MAIL_PW });
  await saveChatGptConnection(ctxFor(db), creds('tok-old-version', 1_000), 'gpt-test');
}, 120_000);

afterAll(async () => {
  for (const dir of [FILE, OLD_RESTORED, NEW_RESTORED, PORTABLE_RESTORED, PORTABLE_ON_B, PROTECTED]) await closeDb(dir).catch(() => undefined);
  onComputer(null);
  process.env.BKA_DATA_DIR = FILE;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('(viii) without a device secret: exactly as before', () => {
  it('values are sealed with the file vault secret, which stays in the file', async () => {
    const db = await getDb(FILE);
    const s = await stored(db);
    for (const blob of [s.anthropic, s.chatgpt, s.mail]) expect(blob).toMatch(/^v2:/);
    oldVault = (await readVaultSecret(db))!;
    expect(oldVault).toMatch(/^[0-9a-f]{64}$/);
    expect(await migrateStoredSecrets(db)).toBe(0);
    expect(await readVaultSecret(db)).toBe(oldVault);
    expect(await liveKey(db)).toBe(KEY_1);
    // A backup made now is "a backup from before this version" for (iv).
    await closeDb(FILE);
    oldBackup = createBackup('Device Keys Co', FILE).buffer;
  }, SLOW);

  it('the marker name matches the one fileProtection writes', () => {
    expect(PROTECTED_MARKER_NAME).toBe(PROTECTED_MARKER);
  }, SLOW);
});

describe('(i) opened on computer A: moved to A, the file keeps nothing that opens them', () => {
  it('every readable value is resealed for A in one go, and the vault secret is deleted', async () => {
    const db = await openOn(PC_A);
    const s = await stored(db);
    const tag = `v3:${deviceKeyId(PC_A)}:`;
    expect(s.anthropic?.startsWith(tag)).toBe(true);
    expect(s.chatgpt?.startsWith(tag)).toBe(true);
    expect(s.mail?.startsWith(tag)).toBe(true);
    expect(await db.select().from(fileSecrets)).toEqual([]);
    // The old vault secret opens none of them.
    for (const blob of [s.anthropic, s.chatgpt, s.mail]) expect(decryptSecret(blob, companyId, oldVault)).toBeNull();
    // AI, ChatGPT and email work on A.
    expect(await liveKey(db)).toBe(KEY_1);
    expect(parseCredentials(openStoredSecret(s.chatgpt, companyId, null))?.accessToken).toBe('tok-old-version');
    expect((await resolveMailConfig(ctxFor(db)))?.password).toBe(MAIL_PW);
    expect((await getEmailSetup(ctxFor(db))).passwordReadable).toBe(true);
    // Idempotent: nothing left to move, nothing written.
    expect(await migrateStoredSecrets(db)).toBe(0);
    expect(await stored(db)).toEqual(s);
  }, SLOW);

  it('never leaks: no API answer, audit row or transaction log carries a key or the device secret', async () => {
    const db = await getDb(FILE);
    const view = JSON.stringify(await getPublicSettings(ctxFor(db))) + JSON.stringify(await getEmailSetup(ctxFor(db)));
    for (const secret of [KEY_1, MAIL_PW, PC_A, 'tok-old-version', oldVault]) expect(view).not.toContain(secret);
    const audit = JSON.stringify(await db.select().from(auditLogs));
    for (const secret of [KEY_1, MAIL_PW, PC_A, 'tok-old-version']) expect(audit).not.toContain(secret);
  }, SLOW);

  it('the data folder, a full backup and a portable file of the moved file hold no vault secret and nothing it opens', async () => {
    const db = await getDb(FILE);
    const portable = (await createPortableCompanyFile(ctxFor(db), { dataDir: FILE })).buffer;
    await closeDb(FILE);
    const backup = createBackup('Device Keys Co', FILE).buffer;
    const needles = [oldVault, KEY_1, MAIL_PW, PC_A, 'tok-old-version'].map((s) => Buffer.from(s));
    const portableEntries = new AdmZip(portable).getEntries().map((e) => [e.entryName, e.getData()] as const);
    expect(new AdmZip(portable).readAsText('data/file_secrets.jsonl')).toBe('');
    const backupEntries = new AdmZip(backup).getEntries().map((e) => [e.entryName, e.getData()] as const);
    for (const [name, bytes] of [...portableEntries, ...backupEntries, ...filesUnder(FILE)]) {
      for (const n of needles) expect(bytes.includes(n), `${name} holds a secret`).toBe(false);
    }
  }, SLOW);
});

describe('(ii) the same file opened on computer B', () => {
  it('B is asked to set the keys up once; nothing is broken on A', async () => {
    const db = await openOn(PC_B);
    const view = await getPublicSettings(ctxFor(db));
    const claude = view.providers.find((p) => p.kind === 'anthropic')!;
    expect(claude).toMatchObject({ hasApiKey: false, apiKeyUnreadable: true });
    expect(view.providers.find((p) => p.kind === 'chatgpt')).toMatchObject({ hasApiKey: false, apiKeyUnreadable: true });
    expect(await liveKey(db)).toBeNull();
    expect(await getEmailSetup(ctxFor(db))).toMatchObject({ hasPassword: true, passwordReadable: false, configured: false });
    await expect(resolveMailConfig(ctxFor(db))).rejects.toMatchObject({ message: PASSWORD_NOT_HERE_MESSAGE });
  }, SLOW);

  it("B sets them up for the first time: B's entry is added and A keeps its own", async () => {
    let db = await getDb(FILE);
    const [claude] = (await loadSettings(ctxFor(db))).providers.filter((p) => p.kind === 'anthropic');
    await updateSettings(ctxFor(db), {
      providers: [{ id: claude.id, kind: 'anthropic', label: 'Claude', model: claude.model, enabled: true, apiKey: KEY_1 }],
    });
    await saveEmailSetup(ctxFor(db), { ...SERVER, password: MAIL_PW });
    const s = await stored(db);
    expect(s.anthropic).toMatch(/^v3m:/);
    expect(s.mail).toMatch(/^v3m:/);
    expect(await liveKey(db)).toBe(KEY_1);
    expect((await resolveMailConfig(ctxFor(db)))?.password).toBe(MAIL_PW);
    // Back on A: still works (two office PCs sharing one file don't knock each other out).
    db = await openOn(PC_A);
    expect(await liveKey(db)).toBe(KEY_1);
    expect((await resolveMailConfig(ctxFor(db)))?.password).toBe(MAIL_PW);
  }, SLOW);

  it("a key CHANGED on A (where it was readable) drops B's stale copy: B is asked again, never uses the old key", async () => {
    let db = await getDb(FILE);
    const [claude] = (await loadSettings(ctxFor(db))).providers.filter((p) => p.kind === 'anthropic');
    await updateSettings(ctxFor(db), {
      providers: [{ id: claude.id, kind: 'anthropic', label: 'Claude', model: claude.model, enabled: true, apiKey: KEY_2 }],
    });
    await saveEmailSetup(ctxFor(db), { ...SERVER, password: 'Changed-Pass-88' });
    const s = await stored(db);
    expect(s.anthropic?.startsWith(`v3:${deviceKeyId(PC_A)}:`)).toBe(true);
    expect(s.mail?.startsWith(`v3:${deviceKeyId(PC_A)}:`)).toBe(true);
    expect(await liveKey(db)).toBe(KEY_2);
    db = await openOn(PC_B);
    expect(await liveKey(db)).toBeNull();
    expect((await getEmailSetup(ctxFor(db))).passwordReadable).toBe(false);
    // Removing the key removes every computer's copy.
    const [c2] = (await loadSettings(ctxFor(db))).providers.filter((p) => p.kind === 'anthropic');
    await updateSettings(ctxFor(db), { providers: [{ id: c2.id, kind: 'anthropic', label: 'Claude', model: c2.model, enabled: false, clearApiKey: true }] });
    expect((await stored(db)).anthropic).toBeNull();
    // Set up again on A for the next steps.
    db = await openOn(PC_A);
    await updateSettings(ctxFor(db), { providers: [{ id: c2.id, kind: 'anthropic', label: 'Claude', model: c2.model, enabled: true, apiKey: KEY_2 }] });
    expect(await liveKey(db)).toBe(KEY_2);
  }, SLOW);
});

describe('(iii) ChatGPT: each computer keeps its own token chain', () => {
  it("a token refresh on A changes only A's entry; B's stays byte for byte", async () => {
    let db = await openOn(PC_B);
    // B signs in for the first time (A's sign-in is kept beside it).
    await saveChatGptConnection(ctxFor(db), creds('tok-b-1', 5_000), 'gpt-test');
    const afterB = (await stored(db)).chatgpt!;
    expect(afterB).toMatch(/^v3m:/);
    const entryOf = (blob: string, secret: string) =>
      (JSON.parse(blob.slice(4)) as string[]).find((b) => b.startsWith(`v3:${deviceKeyId(secret)}:`));
    const bEntry = entryOf(afterB, PC_B);

    db = await openOn(PC_A);
    const [p] = (await loadSettings(ctxFor(db))).providers.filter((x) => x.kind === 'chatgpt');
    expect(parseCredentials(openStoredSecret(p.apiKeyEnc, companyId, null))?.accessToken).toBe('tok-old-version');
    await persistChatGptCredentials(ctxFor(db), p.id, creds('tok-a-2', 9_000));
    const afterRefresh = (await stored(db)).chatgpt!;
    expect(entryOf(afterRefresh, PC_B)).toBe(bEntry);
    expect(parseCredentials(openStoredSecret(afterRefresh, companyId, null))?.accessToken).toBe('tok-a-2');

    db = await openOn(PC_B);
    expect(parseCredentials(openStoredSecret((await stored(db)).chatgpt, companyId, null))?.accessToken).toBe('tok-b-1');
    // A fresh sign-in on B, where B was signed in: a change — A signs in again.
    await saveChatGptConnection(ctxFor(db), creds('tok-b-new', 20_000), 'gpt-test');
    const afterNew = (await stored(db)).chatgpt!;
    expect(afterNew.startsWith(`v3:${deviceKeyId(PC_B)}:`)).toBe(true);
    db = await openOn(PC_A);
    expect(openStoredSecret((await stored(db)).chatgpt, companyId, null)).toBeNull();
  }, SLOW);

  it(`at most ${MAX_COMPUTERS} computers per value: the oldest set-up is dropped`, async () => {
    const db = await openOn(PC_A);
    let blob: string | null = null;
    const secrets = Array.from({ length: MAX_COMPUTERS + 1 }, (_, i) => (i + 1).toString(16).padStart(2, '0').repeat(32));
    for (const s of secrets) {
      onComputer(s);
      blob = await sealStoredSecret(db, 'k', companyId, { entered: blob });
    }
    const list = JSON.parse(blob!.slice(4)) as string[];
    expect(list).toHaveLength(MAX_COMPUTERS);
    onComputer(secrets[0]);
    expect(openStoredSecret(blob, companyId, null)).toBeNull();
    onComputer(secrets[MAX_COMPUTERS]);
    expect(openStoredSecret(blob, companyId, null)).toBe('k');
    onComputer(PC_A);
  }, SLOW);
});

describe('(iv)(v) backups and portable files', () => {
  it('(iv) a backup from before this version, restored on this computer, is moved the same way', async () => {
    onComputer(PC_A);
    await restoreBackup(oldBackup, OLD_RESTORED);
    const db = await getDb(OLD_RESTORED);
    const s = await stored(db);
    expect(s.anthropic?.startsWith(`v3:${deviceKeyId(PC_A)}:`)).toBe(true);
    expect(s.mail?.startsWith(`v3:${deviceKeyId(PC_A)}:`)).toBe(true);
    expect(await db.select().from(fileSecrets)).toEqual([]);
    expect(openStoredSecret(s.anthropic, companyId, null)).toBe(KEY_1);
    await closeDb(OLD_RESTORED);
  }, SLOW);

  it('(v) a backup or portable file made after the move works when restored on the same computer (same company id), not elsewhere', async () => {
    let db = await openOn(PC_A);
    const portable = (await createPortableCompanyFile(ctxFor(db), { dataDir: FILE })).buffer;
    await closeDb(FILE);
    const backup = createBackup('Device Keys Co', FILE).buffer;

    await restoreBackup(backup, NEW_RESTORED);
    db = await getDb(NEW_RESTORED);
    expect(openStoredSecret((await stored(db)).anthropic, companyId, null)).toBe(KEY_2);
    await closeDb(NEW_RESTORED);

    await restorePortableCompanyFile(portable, PORTABLE_RESTORED);
    db = await getDb(PORTABLE_RESTORED);
    expect(openStoredSecret((await stored(db)).anthropic, companyId, null)).toBe(KEY_2);
    await closeDb(PORTABLE_RESTORED);

    onComputer(PC_B);
    await restorePortableCompanyFile(portable, PORTABLE_ON_B);
    db = await getDb(PORTABLE_ON_B);
    expect(openStoredSecret((await stored(db)).anthropic, companyId, null)).toBeNull();
    await closeDb(PORTABLE_ON_B);
    onComputer(PC_A);
  }, SLOW);
});

describe('(vi)(vii) a company file protected with passwords', () => {
  let pdb: DB;
  const protect = async (db: DB) => {
    await db.insert(fileProtection).values({ id: 1, keyCheck: 'test-key-check', lookupSalt: 'test-salt' });
  };

  it('(vi) protected: values stay sealed in the (encrypted) file and its vault secret is kept, on every computer', async () => {
    // A protected file from before this version: v2 values + vault secret.
    fs.rmSync(PROTECTED, { recursive: true, force: true });
    fs.cpSync(OLD_RESTORED, PROTECTED, { recursive: true });
    pdb = await openOn(null, PROTECTED);
    await protect(pdb);
    // The working copy gets the old v2 values back (copied from the old backup's restore, already moved): reseal in-file.
    await pdb.delete(fileSecrets);
    const [claude] = (await loadSettings(ctxFor(pdb))).providers.filter((p) => p.kind === 'anthropic');
    await updateSettings(ctxFor(pdb), { providers: [{ id: claude.id, kind: 'anthropic', label: 'Claude', model: claude.model, enabled: true, apiKey: KEY_1 }] });
    expect((await stored(pdb)).anthropic).toMatch(/^v2:/);
    const vault = await readVaultSecret(pdb);

    for (const pc of [PC_A, PC_B]) {
      pdb = await openOn(pc, PROTECTED);
      expect((await stored(pdb)).anthropic).toMatch(/^v2:/);
      expect(await readVaultSecret(pdb)).toBe(vault);
      expect(await liveKey(pdb)).toBe(KEY_1);
    }
    // A key entered on a computer with a device secret is still sealed in the file.
    const [c] = (await loadSettings(ctxFor(pdb))).providers.filter((p) => p.kind === 'anthropic');
    await updateSettings(ctxFor(pdb), { providers: [{ id: c.id, kind: 'anthropic', label: 'Claude', model: c.model, enabled: true, apiKey: KEY_2 }] });
    expect((await stored(pdb)).anthropic).toMatch(/^v2:/);
  }, SLOW);

  it('(vi) the folder marker alone (the database not yet knowing) also counts as protected', async () => {
    await pdb.delete(fileProtection);
    fs.writeFileSync(path.join(PROTECTED, PROTECTED_MARKER), '{}\n');
    expect(await migrateStoredSecrets(pdb, { dataDir: PROTECTED })).toBe(0);
    expect(await readVaultSecret(pdb)).not.toBeNull();
    fs.rmSync(path.join(PROTECTED, PROTECTED_MARKER));
    await protect(pdb);
  }, SLOW);

  it('(vii) protection turned ON over device-sealed values, then OFF: readable here throughout', async () => {
    // A file whose values were moved to A, then protected.
    pdb = await openOn(PC_A, PROTECTED);
    await pdb.delete(fileProtection);
    await closeDb(PROTECTED);
    pdb = await openOn(PC_A, PROTECTED); // unprotected now: moved to A
    expect((await stored(pdb)).anthropic?.startsWith(`v3:${deviceKeyId(PC_A)}:`)).toBe(true);
    expect((await stored(pdb)).mail?.startsWith(`v3:${deviceKeyId(PC_A)}:`)).toBe(true);
    await protect(pdb); // ON
    pdb = await openOn(PC_A, PROTECTED);
    // Left as they are, still readable on A.
    expect(await liveKey(pdb)).toBe(KEY_2);
    expect((await resolveMailConfig(ctxFor(pdb)))?.password).toBe(MAIL_PW);
    // A new mail password while protected: sealed in the file.
    await saveEmailSetup(ctxFor(pdb), { ...SERVER, password: 'While-Protected-1' });
    expect((await stored(pdb)).mail).toMatch(/^v2:/);
    expect((await resolveMailConfig(ctxFor(pdb)))?.password).toBe('While-Protected-1');
    // OFF again: the next open moves the in-file value to A; everything still readable.
    await pdb.delete(fileProtection);
    pdb = await openOn(PC_A, PROTECTED);
    expect((await stored(pdb)).mail?.startsWith(`v3:${deviceKeyId(PC_A)}:`)).toBe(true);
    expect((await resolveMailConfig(ctxFor(pdb)))?.password).toBe('While-Protected-1');
    expect(await liveKey(pdb)).toBe(KEY_2);
    expect(await pdb.select().from(fileSecrets)).toEqual([]);
    await closeDb(PROTECTED);
  }, SLOW);
});

describe('(viii) a value sealed for a computer, opened where there is no device secret', () => {
  it('is unreadable (set up again), and a new key falls back to the file secret as before', async () => {
    const db = await openOn(null);
    expect(await liveKey(db)).toBeNull();
    const [c] = (await loadSettings(ctxFor(db))).providers.filter((p) => p.kind === 'anthropic');
    await updateSettings(ctxFor(db), { providers: [{ id: c.id, kind: 'anthropic', label: 'Claude', model: c.model, enabled: true, apiKey: KEY_1 }] });
    expect((await stored(db)).anthropic).toMatch(/^v2:/);
    expect(await liveKey(db)).toBe(KEY_1);
    // ...and the next open on A moves it again.
    const dbA = await openOn(PC_A);
    expect((await stored(dbA)).anthropic?.startsWith(`v3:${deviceKeyId(PC_A)}:`)).toBe(true);
    expect(await liveKey(dbA)).toBe(KEY_1);
    expect(await dbA.select().from(fileSecrets)).toEqual([]);
  }, SLOW);
});

describe('a copy that came without the vault secret (an older version\'s Accountant\'s Copy)', () => {
  it('its unreadable "v2:" values are left alone, and nothing is written at each open', async () => {
    let db = await openOn(null);
    const [c] = (await loadSettings(ctxFor(db))).providers.filter((p) => p.kind === 'anthropic');
    await updateSettings(ctxFor(db), { providers: [{ id: c.id, kind: 'anthropic', label: 'Claude', model: c.model, enabled: true, apiKey: KEY_2 }] });
    const blob = (await stored(db)).anthropic;
    expect(blob).toMatch(/^v2:/);
    await db.delete(fileSecrets);
    db = await openOn(PC_A);
    expect((await stored(db)).anthropic).toBe(blob);
    const lsn = async () => ((await db.execute(sql`select pg_current_wal_lsn()::text as l`)) as unknown as { rows: Array<{ l: string }> }).rows[0].l;
    const before = await lsn();
    expect(await migrateStoredSecrets(db)).toBe(0);
    await loadSettings(ctxFor(db));
    expect(await lsn()).toBe(before);
    expect(await liveKey(db)).toBeNull();
    // Opening it again compacts nothing (no new log segment: the file is not rewritten and saved).
    const segments = () => fs.readdirSync(path.join(FILE, 'pg_wal')).filter((f) => /^[0-9A-F]{24}$/.test(f)).sort();
    const walBefore = segments();
    db = await openOn(PC_A);
    expect(segments()).toEqual(walBefore);
    expect((await stored(db)).anthropic).toBe(blob);
  }, SLOW);
});
