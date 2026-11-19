/**
 * Security plan 2.4 — "I forgot my password" opens a protected company file only on a computer
 * that has opened it before.
 *
 * A challenge answer is a few words to a question from a fixed list. Its key slot was written in
 * the file's plain manifest, question included, so anyone with a COPY of the file could try a
 * word list of car models or cities offline and, on a hit, get the file key. Where the app has a
 * device secret (BKA_DEVICE_VAULT, one per Windows account), the challenge slots now go into one
 * encrypted challenge set: its key is inside the encrypted books, wrapped in the manifest only for
 * each computer that has saved the file. So:
 *  (1) the manifest shows no question, no challenge lookup tag and no challenge slot;
 *  (2) the answer still opens the file on the same computer;
 *  (3) on another computer the forgot-password screen says the file opens there with a password
 *      or the recovery key — and both do;
 *  (4) once that computer has signed in with a password and saved, the answer works there too
 *      (and still on the first);
 *  (5) a changed answer reaches every computer at the next save; the old one stops everywhere;
 *  (6) a file saved by an older version (plain challenge slots) opens all three ways, and is
 *      rewritten in the new form by its next save;
 *  (7) without a device secret, everything is written exactly as before;
 *  (8) an edited or damaged set only stops the challenge route: the password and the recovery key
 *      still open the file, and nothing throws;
 *  (10) backups, copies and portable files of the file carry no plain challenge slot either, and a
 *      backup restored on the same computer keeps the challenge route.
 * Two computers are simulated by switching BKA_DEVICE_VAULT; each launch has its own user data.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { eq } from 'drizzle-orm';

vi.mock('next/headers', () => {
  const g = globalThis as typeof globalThis & { __fpJar?: { cookies: Map<string, string>; headers: Map<string, string> } };
  const j = (g.__fpJar ??= { cookies: new Map(), headers: new Map() });
  return {
    cookies: async () => ({ get: (n: string) => (j.cookies.has(n) ? { name: n, value: j.cookies.get(n)! } : undefined) }),
    headers: async () => new Headers([...j.headers.entries()]),
  };
});

process.env.BKA_TEST_FAST_KDF = '1';
delete process.env.BKA_AUTH_SECRET;
process.env.BKA_OFFLINE = '1';
const PC_A = nodeCrypto.randomBytes(32).toString('hex');
const PC_B = nodeCrypto.randomBytes(32).toString('hex');
const PC_C = nodeCrypto.randomBytes(32).toString('hex');
process.env.BKA_DEVICE_VAULT = PC_A;

import { getDb, type DB } from '@/lib/db';
import { fileSecrets } from '@/lib/db/schema';
import { fullAccess } from '@/lib/permissions/model';
import { CHALLENGE_NOT_ON_THIS_COMPUTER_TEXT, CHALLENGE_QUESTIONS } from '@/lib/challengeQuestions';
import { deviceKeyId } from '@/lib/ai/keyVault';
import { POST as signupPOST } from '@/app/api/auth/signup/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as requestResetPOST } from '@/app/api/auth/request-reset/route';
import { POST as challengePOST } from '@/app/api/auth/challenge/route';
import { saveCompanyFile, saveCopyAs } from './companyFileSave';
import { CHALLENGE_KEY_NAME, fileKeyFor, protectionForDir, sealedChallengeNotHere, sealedChallengeQuestion, unlockFromFile } from './fileProtection';
import { createBackup } from './backup';
import { createPortableCompanyFile, unlockPortableBuffer } from './portableFile';
import { apiRequest, fileCrypto, format, keepCookies, newCompanyFile, openOn, quit, resetLimiters } from './fileProtection.fixture';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-sec2-challenge-'));
const SHARE = path.join(ROOT, 'share');
const FILE = path.join(SHARE, 'Juniper Lane.ironbooks');
const OLD_FILE = path.join(SHARE, 'Older Version.ironbooks');
const PASSWORD = 'Juniper-Pass-0001';
const QUESTION = 'Make and model of your first car';
const ANSWER = 'Saab nine hundred turbo';
const NEW_QUESTION = 'Street you grew up on';
const NEW_ANSWER = 'Larkspur Crescent West';
let recoveryKey = '';
let companyId = '';
let userId = '';

const device = (secret: string) => ({ secret, keyId: deviceKeyId(secret) });
const setOf = (file: string) => fileCrypto.challengeSetOf(format.readCompanyManifest(file).encryption);

let launches = 0;
/** A fresh launch of the app on a computer (its own user data: no working copy of the file there). */
async function launchOn(secret: string | null, file = FILE) {
  if (secret) process.env.BKA_DEVICE_VAULT = secret;
  else delete process.env.BKA_DEVICE_VAULT;
  resetLimiters();
  launches++;
  return openOn(file, path.join(ROOT, `userdata-${launches}`), `launch-sec2-${launches}`);
}

/** "I forgot my password" on the sign-in screen. */
async function ask(email: string, challengeAnswer?: string) {
  resetLimiters();
  const res = await requestResetPOST(apiRequest('POST', '/api/auth/request-reset', { email, ...(challengeAnswer ? { challengeAnswer } : {}) }));
  return { status: res.status, body: (await res.json()) as { error?: string; challengeQuestion?: string; token?: string } };
}

async function signIn(email: string, password: string) {
  resetLimiters();
  const res = await loginPOST(apiRequest('POST', '/api/auth/login', { email, password }));
  keepCookies(res);
  return res.status;
}

async function opensWith(kind: 'password' | 'challenge' | 'recovery', secret: string, login: string | null = 'jo') {
  return Boolean(await unlockFromFile({ kind, login, secret }));
}

async function challengeKeyRows(db: DB) {
  return db.select({ name: fileSecrets.name }).from(fileSecrets).where(eq(fileSecrets.name, CHALLENGE_KEY_NAME));
}

/** The company file's plain manifest changed by someone without any key (the zip rewritten around it). */
async function tamperedCopy(name: string, mutate: (m: Record<string, any>) => void): Promise<string> {
  const buf = fs.readFileSync(FILE);
  const entries = format.readCentralDirectory(buf).map((e: { name: string; method: number; offset: number; csize: number }) => {
    const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
    expect(e.method).toBe(0); // a sealed file stores every entry as it is
    return { name: e.name, data: Buffer.from(buf.subarray(start, start + e.csize)), store: true };
  });
  const head = entries.find((e: { name: string }) => e.name === format.COMPANY_MANIFEST_ENTRY);
  const m = JSON.parse(head.data.toString('utf8'));
  mutate(m);
  head.data = Buffer.from(JSON.stringify(m, null, 2), 'utf8');
  const target = path.join(SHARE, `${name}.ironbooks`);
  await format.writeZip(target, [head, ...entries.filter((e: { name: string }) => e !== head)]);
  return target;
}

beforeAll(async () => {
  await newCompanyFile(FILE, 'Juniper Lane');
  await launchOn(PC_A);
  const res = await signupPOST(
    apiRequest('POST', '/api/auth/signup', { name: 'Jo Owner', email: 'jo', password: PASSWORD, companyName: 'Juniper Lane', challengeQuestion: QUESTION, challengeAnswer: ANSWER }),
  );
  expect(res.status).toBe(201);
  const body = await res.json();
  recoveryKey = body.recoveryKey;
  companyId = body.companyId;
  userId = body.id;
  expect((await saveCompanyFile({ force: true })).encrypted).toBe(true);
}, 180_000);

afterAll(async () => {
  await quit();
  delete process.env.BKA_DEVICE_VAULT;
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort on Windows */
  }
});

describe('a protected file saved on a computer with a device secret', () => {
  it('(1) its plain manifest shows no question, no challenge lookup tag and no challenge slot', async () => {
    const m = format.readCompanyManifest(FILE);
    const slots = m.encryption.slots as Array<Record<string, any>>;
    expect(slots.some((s) => s.kind === 'challenge')).toBe(false);
    expect(slots.map((s) => s.kind).sort()).toEqual(['challenge-set', 'password', 'recovery']);
    const raw = fs.readFileSync(FILE);
    for (const q of CHALLENGE_QUESTIONS) expect(raw.includes(Buffer.from(q)), q).toBe(false);
    // The user's lookup tag is on their password slot only: nothing says they have a question.
    const tag = fileCrypto.lookupTag(m.encryption.lookupSalt, 'jo');
    expect(JSON.stringify(m).split(tag).length - 1).toBe(1);
    expect(slots.filter((s) => s.tag === tag).map((s) => s.kind)).toEqual(['password']);
    // The set: one entry for this computer, and only its device secret opens it.
    const set = setOf(FILE);
    expect(set.devices.map((d: { id: string }) => d.id)).toEqual([deviceKeyId(PC_A)]);
    expect(fileCrypto.openChallengeSet(set, device(PC_A))).toEqual([expect.objectContaining({ kind: 'challenge', question: QUESTION, tag })]);
    expect(fileCrypto.openChallengeSet(set, device(PC_B))).toBeNull();
    // Its key travels inside the encrypted books.
    expect(await challengeKeyRows(await getDb())).toHaveLength(1);
    await quit();
  }, 60_000);

  it('(2) the answer still opens the file on the same computer', async () => {
    const prep = await launchOn(PC_A);
    expect(prep.sealed).toBe('extract');
    expect(sealedChallengeNotHere()).toBe(false);
    // A teammate's device (multi-user hosting) learns nothing, as before: not even the question.
    resetLimiters();
    const remote = await requestResetPOST(apiRequest('POST', '/api/auth/request-reset', { email: 'jo' }, { remoteAddr: '100.101.102.103' }));
    expect(remote.status).toBe(200);
    expect(await remote.json()).toEqual({ ok: true, message: expect.any(String) });
    expect((await ask('jo')).body).toMatchObject({ challengeQuestion: QUESTION });
    const wrong = await ask('jo', 'Volvo two forty wagon');
    expect(wrong.status).toBe(403);
    expect(wrong.body.challengeQuestion).toBe(QUESTION);
    expect(fs.existsSync(path.join(prep.dataDir, 'PG_VERSION'))).toBe(false);
    const right = await ask('jo', ANSWER);
    expect(right.status).toBe(200);
    expect(right.body.token).toBeTruthy();
    expect(fs.existsSync(path.join(prep.dataDir, 'PG_VERSION'))).toBe(true);
    await quit();
  }, 120_000);

  it('(3) another computer: the challenge route says to use the password or the recovery key — and both open the file', async () => {
    const prep = await launchOn(PC_B);
    expect(prep.sealed).toBe('extract');
    expect(sealedChallengeNotHere()).toBe(true);
    for (const [who, answer] of [['jo', undefined], ['jo', ANSWER], ['nobody', undefined], ['nobody', ANSWER]] as const) {
      const r = await ask(who, answer);
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(CHALLENGE_NOT_ON_THIS_COMPUTER_TEXT);
      expect(r.body.challengeQuestion).toBeUndefined();
    }
    expect(sealedChallengeQuestion('jo')).toBeNull();
    resetLimiters();
    const remote = await requestResetPOST(apiRequest('POST', '/api/auth/request-reset', { email: 'jo', challengeAnswer: ANSWER }, { remoteAddr: '100.101.102.103' }));
    expect(await remote.json()).toEqual({ ok: true, message: expect.any(String) });
    expect(await opensWith('challenge', ANSWER)).toBe(false);
    expect(fs.existsSync(path.join(prep.dataDir, 'PG_VERSION'))).toBe(false); // nothing decrypted
    expect(await opensWith('recovery', recoveryKey, null)).toBe(true);
    expect(await opensWith('password', PASSWORD)).toBe(true);
    // The password signs in and opens the books, exactly as before.
    expect(await signIn('jo', PASSWORD)).toBe(200);
    expect(fs.existsSync(path.join(prep.dataDir, 'PG_VERSION'))).toBe(true);
  }, 120_000);

  it('(4) once that computer has saved the file, the answer works there too, and still on the first', async () => {
    expect((await saveCompanyFile({ force: true })).encrypted).toBe(true);
    const set = setOf(FILE);
    expect(set.devices.map((d: { id: string }) => d.id)).toEqual([deviceKeyId(PC_A), deviceKeyId(PC_B)]);
    await quit();
    for (const pc of [PC_B, PC_A]) {
      await launchOn(pc);
      expect(sealedChallengeNotHere()).toBe(false);
      expect((await ask('jo')).body).toMatchObject({ challengeQuestion: QUESTION });
      expect(await opensWith('challenge', ANSWER)).toBe(true);
      await quit();
    }
    // A third computer that never opened it: not there.
    await launchOn(PC_C);
    expect((await ask('jo')).body.error).toBe(CHALLENGE_NOT_ON_THIS_COMPUTER_TEXT);
    await quit();
  }, 180_000);

  it('(5) a changed answer reaches every computer at the next save; the old one stops working everywhere', async () => {
    await launchOn(PC_B);
    expect(await signIn('jo', PASSWORD)).toBe(200);
    const changed = await challengePOST(apiRequest('POST', '/api/auth/challenge', { currentPassword: PASSWORD, question: NEW_QUESTION, answer: NEW_ANSWER }));
    expect(changed.status).toBe(200);
    expect((await changed.json()).opensFile).toBe(true);
    expect((await saveCompanyFile({ force: true })).encrypted).toBe(true);
    expect(setOf(FILE).devices.map((d: { id: string }) => d.id)).toEqual([deviceKeyId(PC_A), deviceKeyId(PC_B)]);
    await quit();
    for (const pc of [PC_A, PC_B]) {
      await launchOn(pc);
      expect((await ask('jo')).body).toMatchObject({ challengeQuestion: NEW_QUESTION });
      expect(await opensWith('challenge', ANSWER)).toBe(false);
      expect(await opensWith('challenge', NEW_ANSWER)).toBe(true);
      const old = await ask('jo', ANSWER);
      expect(old.status).toBe(403);
      expect(old.body.challengeQuestion).toBe(NEW_QUESTION);
      await quit();
    }
    const raw = fs.readFileSync(FILE);
    expect(raw.includes(Buffer.from(NEW_QUESTION))).toBe(false);
  }, 240_000);
});

describe('(8) an edited or damaged challenge set only stops the challenge route', () => {
  const flip = (s: string) => {
    const at = Math.floor(s.length / 2);
    return s.slice(0, at) + (s[at] === 'A' ? 'B' : 'A') + s.slice(at + 1);
  };
  const setIn = (m: Record<string, any>) => m.encryption.slots.find((s: { kind: string }) => s.kind === 'challenge-set');
  const cases: Array<[string, (m: Record<string, any>) => void, boolean]> = [
    // [what, edit, whether the route still counts as "here" (no set at all reads as no question)]
    ['the set deleted', (m) => (m.encryption.slots = m.encryption.slots.filter((s: { kind: string }) => s.kind !== 'challenge-set')), false],
    ['the box truncated', (m) => (setIn(m).box = setIn(m).box.slice(0, 40)), true],
    ['the box bit-flipped', (m) => (setIn(m).box = flip(setIn(m).box)), true],
    ["this computer's entry bit-flipped", (m) => (setIn(m).devices[0].key = flip(setIn(m).devices[0].key)), true],
    ["this computer's entry deleted", (m) => (setIn(m).devices = setIn(m).devices.slice(1)), true],
    ['the device list replaced by junk', (m) => (setIn(m).devices = Array.from({ length: 50_000 }, () => ({ id: 'zz', key: 7 }))), true],
    ['an oversized box', (m) => (setIn(m).box = 'A'.repeat(3 * 1024 * 1024)), true],
    ['the set replaced by garbage', (m) => (m.encryption.slots = [...m.encryption.slots.filter((s: { kind: string }) => s.kind !== 'challenge-set'), { kind: 'challenge-set', v: 1, id: 7, box: null, devices: {} }]), true],
  ];
  for (const [what, edit, notHere] of cases) {
    it(`${what}: the password and the recovery key still open it; the answer does not`, async () => {
      const file = await tamperedCopy(`tampered ${what.replace(/[^a-z ]/gi, '')}`, edit);
      process.env.BKA_COMPANY_FILE = file;
      process.env.BKA_DEVICE_VAULT = PC_A;
      expect(sealedChallengeNotHere()).toBe(notHere);
      expect(sealedChallengeQuestion('jo')).toBeNull();
      expect(await opensWith('challenge', NEW_ANSWER)).toBe(false);
      expect(await opensWith('password', PASSWORD)).toBe(true);
      expect(await opensWith('recovery', recoveryKey, null)).toBe(true);
      delete process.env.BKA_COMPANY_FILE;
    });
  }

  it('a file with a damaged set opens with the password, its contents check out, and its next save mends the set', async () => {
    const file = await tamperedCopy('tampered then opened', (m) => (setIn(m).box = flip(setIn(m).box)));
    const prep = await launchOn(PC_A, file);
    expect(prep.sealed).toBe('extract');
    expect((await ask('jo')).body.error).toBe(CHALLENGE_NOT_ON_THIS_COMPUTER_TEXT);
    expect(await signIn('jo', PASSWORD)).toBe(200);
    expect(fs.existsSync(path.join(prep.dataDir, 'PG_VERSION'))).toBe(true);
    expect((await saveCompanyFile({ force: true })).encrypted).toBe(true);
    expect(fileCrypto.openChallengeSet(setOf(file), device(PC_A))).toHaveLength(1);
    await quit();
  }, 120_000);
});

describe('(10) copies of the file made with a device secret', () => {
  it('a backup, a copy and a portable file carry no plain challenge slot; a backup restored here keeps the route', async () => {
    await launchOn(PC_A);
    expect(await signIn('jo', PASSWORD)).toBe(200);
    const db = await getDb();
    const fileSet = setOf(FILE);

    // A full backup (.bka).
    const { buffer } = createBackup(undefined, undefined, { protection: await protectionForDir() });
    const head = format.readArchiveHead(buffer);
    const slots = head.manifest.encryption.slots as Array<Record<string, any>>;
    expect(slots.some((s) => s.kind === 'challenge')).toBe(false);
    const set = fileCrypto.challengeSetOf(head.manifest.encryption);
    const ids = (s: { devices: Array<{ id: string }> }) => s.devices.map((d) => d.id).sort();
    expect(ids(set)).toEqual(ids(fileSet)); // the same computers as the file itself
    for (const q of CHALLENGE_QUESTIONS) expect(buffer.includes(Buffer.from(q)), q).toBe(false);
    expect(fileCrypto.openChallengeSet(set, device(PC_A))).toHaveLength(1);
    expect(fileCrypto.openChallengeSet(set, device(PC_C))).toBeNull();

    // Restored as a company file (never decrypted on the way): the answer opens it on this computer.
    const bka = path.join(ROOT, 'backup.bka');
    fs.writeFileSync(bka, buffer);
    const restored = path.join(SHARE, 'Restored.ironbooks');
    await format.sealedBackupAsCompanyFile(bka, restored, {
      manifest: { fileId: 'restored-file', companyName: 'Juniper Lane', saveId: 'r', previousSaveId: null, savedAt: new Date().toISOString() },
    });
    const own = process.env.BKA_COMPANY_FILE;
    process.env.BKA_COMPANY_FILE = restored;
    expect(await opensWith('challenge', NEW_ANSWER)).toBe(true);
    process.env.BKA_DEVICE_VAULT = PC_C;
    expect(sealedChallengeNotHere()).toBe(true);
    expect(await opensWith('password', PASSWORD)).toBe(true);
    process.env.BKA_DEVICE_VAULT = PC_A;
    process.env.BKA_COMPANY_FILE = own;

    // Save Copy As.
    const copy = path.join(SHARE, 'Copy of Juniper Lane.ironbooks');
    expect((await saveCopyAs(copy)).encrypted).toBe(true);
    const cm = format.readCompanyManifest(copy);
    expect(cm.encryption.slots.some((s: { kind: string }) => s.kind === 'challenge')).toBe(false);
    expect(fileCrypto.openChallengeSet(fileCrypto.challengeSetOf(cm.encryption), device(PC_A))).toHaveLength(1);
    for (const q of CHALLENGE_QUESTIONS) expect(fs.readFileSync(copy).includes(Buffer.from(q)), q).toBe(false);

    // The owner's portable file: sealed as a whole; inside, the challenge key travels with the books.
    const ctx = { db, companyId, userId, access: fullAccess(), role: 'owner' as const };
    const portable = await createPortableCompanyFile(ctx, { password: 'Portable-Pass-0001' });
    for (const q of CHALLENGE_QUESTIONS) expect(portable.buffer.includes(Buffer.from(q)), q).toBe(false);
    expect(portable.buffer.includes(Buffer.from('"challenge"'))).toBe(false);
    const inner = new AdmZip(await unlockPortableBuffer(portable.buffer, 'Portable-Pass-0001'));
    const secrets = (inner.getEntry('data/file_secrets.jsonl')?.getData().toString('utf8') ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(secrets.map((r: { name: string }) => r.name)).toContain(CHALLENGE_KEY_NAME);
    expect(fileKeyFor()).not.toBeNull();
    await quit();
  }, 240_000);
});

describe('(6)(7) a file saved without a device secret (an older version, Linux without a keyring)', () => {
  it('(7) is written exactly as before: plain challenge slots, no challenge set, no challenge key', async () => {
    delete process.env.BKA_DEVICE_VAULT;
    await newCompanyFile(OLD_FILE, 'Older Version');
    await launchOn(null, OLD_FILE);
    const res = await signupPOST(
      apiRequest('POST', '/api/auth/signup', { name: 'Ola Owner', email: 'ola', password: PASSWORD, companyName: 'Older Version', challengeQuestion: QUESTION, challengeAnswer: ANSWER }),
    );
    expect(res.status).toBe(201);
    recoveryKey = (await res.json()).recoveryKey;
    expect((await saveCompanyFile({ force: true })).encrypted).toBe(true);
    const m = format.readCompanyManifest(OLD_FILE);
    expect(Object.keys(m.encryption).sort()).toEqual(['cipher', 'kdf', 'keyCheck', 'lookupSalt', 'sealId', 'slots', 'v']);
    const slots = m.encryption.slots as Array<Record<string, any>>;
    expect(slots.map((s) => s.kind).sort()).toEqual(['challenge', 'password', 'recovery']);
    expect(slots.find((s) => s.kind === 'challenge')).toMatchObject({ question: QUESTION, tag: fileCrypto.lookupTag(m.encryption.lookupSalt, 'ola') });
    expect(await challengeKeyRows(await getDb())).toEqual([]);
    await quit();
  }, 180_000);

  it('(6) opens all three ways on a computer with a device secret, and its next save writes the new form', async () => {
    await launchOn(PC_A, OLD_FILE);
    expect(sealedChallengeNotHere()).toBe(false);
    expect((await ask('ola')).body).toMatchObject({ challengeQuestion: QUESTION });
    expect(await opensWith('challenge', ANSWER, 'ola')).toBe(true);
    expect(await opensWith('password', PASSWORD, 'ola')).toBe(true);
    expect(await opensWith('recovery', recoveryKey, null)).toBe(true);
    // Still unchanged on disk until a save.
    expect(format.readCompanyManifest(OLD_FILE).encryption.slots.some((s: { kind: string }) => s.kind === 'challenge')).toBe(true);
    // The answer opens the books, then the next save rewrites the manifest.
    const right = await ask('ola', ANSWER);
    expect(right.status).toBe(200);
    expect((await saveCompanyFile({ force: true })).encrypted).toBe(true);
    const m = format.readCompanyManifest(OLD_FILE);
    expect(m.encryption.slots.some((s: { kind: string }) => s.kind === 'challenge')).toBe(false);
    for (const q of CHALLENGE_QUESTIONS) expect(fs.readFileSync(OLD_FILE).includes(Buffer.from(q)), q).toBe(false);
    expect(await challengeKeyRows(await getDb())).toHaveLength(1);
    await quit();

    await launchOn(PC_A, OLD_FILE);
    expect(await opensWith('challenge', ANSWER, 'ola')).toBe(true);
    await quit();
    await launchOn(PC_B, OLD_FILE);
    expect((await ask('ola', ANSWER)).body.error).toBe(CHALLENGE_NOT_ON_THIS_COMPUTER_TEXT);
    expect(await opensWith('password', PASSWORD, 'ola')).toBe(true);
    expect(await opensWith('recovery', recoveryKey, null)).toBe(true);
    await quit();
  }, 240_000);
});
