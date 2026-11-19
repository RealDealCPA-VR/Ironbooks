/**
 * Security plan 1.3 — an Accountant's Copy of a company file protected with passwords.
 *
 * Its transfer file carried the file's key slots table as it is in the database: the slots of
 * THIS file's key (every user's password slot, the challenge-answer slots, the recovery slot), next
 * to the copy's own re-wrapped ones. Whoever had the transfer password and one user password (the
 * accountant) could unwrap the client's real file key from it, and a challenge-answer slot could be
 * guessed offline. The copy now carries only its own key's slots — the password and recovery
 * slots, never a challenge slot — and its own key check.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

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
delete process.env.BKA_DEVICE_VAULT;
process.env.BKA_OFFLINE = '1';

import { getDb, resolveDataDir, type DB } from '@/lib/db';
import { fileKeySlots } from '@/lib/db/schema';
import { fullAccess } from '@/lib/permissions/model';
import { POST as signupPOST } from '@/app/api/auth/signup/route';
import { saveCompanyFile } from './companyFileSave';
import { fileKeyFor, loadKeyFromPassword } from './fileProtection';
import { PORTABLE_KEY_ENTRY, unlockPortableBuffer } from './portableFile';
import { cancelAccountantCopy, createAccountantCopy } from './accountantCopy/client';
import { openAccountantCopyFile } from './accountantCopy/accountant';
import { apiRequest, fileCrypto, keepCookies, newCompanyFile, openOn, quit } from './fileProtection.fixture';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-sec1-outsider-prot-'));
const FILE = path.join(ROOT, 'share', 'Hazel Row.ironbooks');
const PASSWORD = 'Hazel-Row-Pass-1';
const ANSWER = 'bartholomew the gray cat';
let db: DB;
let companyId = '';
let admin = '';
const ctx = () => ({ db, companyId, userId: admin, role: 'owner' as const, access: fullAccess() });

function rows(zipBuffer: Buffer, table: string): Array<Record<string, unknown>> {
  const text = new AdmZip(zipBuffer).getEntry(`data/${table}.jsonl`)?.getData().toString('utf8') ?? '';
  return text ? text.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

beforeAll(async () => {
  await newCompanyFile(FILE, 'Hazel Row');
  await openOn(FILE, path.join(ROOT, 'pc'), 'launch-sec1-outsider');
  const res = await signupPOST(
    apiRequest('POST', '/api/auth/signup', {
      name: 'Hal Admin',
      email: 'hal',
      password: PASSWORD,
      companyName: 'Hazel Row',
      challengeQuestion: 'Name of your first pet',
      challengeAnswer: ANSWER,
    }),
  );
  expect(res.status).toBe(201);
  keepCookies(res);
  const body = await res.json();
  companyId = body.companyId;
  admin = body.id;
  db = await getDb();
  expect((await saveCompanyFile({ force: true })).encrypted).toBe(true);
}, 180_000);

afterAll(async () => {
  await quit();
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("an Accountant's Copy of a protected company file", () => {
  it('carries only its own key slots (password and recovery, no challenge) and never a slot of this file key', async () => {
    const realKey = fileKeyFor(resolveDataDir())!;
    expect(realKey).toBeTruthy();
    const own = await db.select().from(fileKeySlots);
    expect(own.some((s) => s.kind === 'challenge')).toBe(true); // the client's file has one

    const t = await createAccountantCopy(ctx(), { dividingDate: '2026-06-30', password: 'Transfer-Pw-2026' });
    const plain = await unlockPortableBuffer(t.buffer, 'Transfer-Pw-2026');
    const carried = JSON.parse(new AdmZip(plain).readAsText(PORTABLE_KEY_ENTRY)) as { keyCheck: string; fileKey: string; slots: Array<{ id: string }> };
    const copyKey = Buffer.from(carried.fileKey, 'base64');
    expect(copyKey.equals(realKey)).toBe(false);

    const slots = rows(plain, 'file_key_slots');
    expect(slots.map((s) => s.kind).sort()).toEqual(['password', 'recovery']);
    expect(carried.slots.map((s) => s.id).sort()).toEqual(slots.map((s) => s.id).sort());
    for (const s of slots) {
      expect(fileCrypto.slotMacOk(copyKey, s.slot)).toBe(true);
      expect(fileCrypto.slotMacOk(realKey, s.slot)).toBe(false);
    }
    // The accountant's password opens the COPY's key only.
    const opened = await fileCrypto.openSlot(slots.find((s) => s.kind === 'password')!.slot, PASSWORD);
    expect(opened && fileCrypto.keyCheckOf(opened)).toBe(carried.keyCheck);
    expect(opened!.equals(realKey)).toBe(false);
    expect(rows(plain, 'file_protection')[0]).toMatchObject({ key_check: carried.keyCheck, previous_key_check: null });
    // No challenge question or answer in the copy, nor the file key itself.
    expect(plain.includes(Buffer.from('Name of your first pet'))).toBe(false);
    expect(plain.includes(Buffer.from(realKey.toString('base64')))).toBe(false);
    expect(plain.includes(Buffer.from(realKey.toString('hex')))).toBe(false);

    // It still opens on the accountant's side, protected with the copy's key and the same password.
    const target = path.join(ROOT, 'accountant', 'data');
    const restored = await openAccountantCopyFile(plain, target);
    expect(restored.protected).toBe(true);
    const adb = await getDb(restored.dataDir);
    const kept = await adb.select().from(fileKeySlots);
    expect(kept.map((s) => s.kind).sort()).toEqual(['password', 'recovery']);
    expect(await loadKeyFromPassword(adb, restored.dataDir, admin, PASSWORD)).toBe(true);
    await cancelAccountantCopy(ctx());
  }, 180_000);
});
