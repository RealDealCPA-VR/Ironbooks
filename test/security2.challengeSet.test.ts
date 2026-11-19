/**
 * Security plan 2.4 — the challenge set (electron/fileCrypto.js sealChallengeSet): a protected
 * company file's challenge slots, written where the computer has a device secret, are one
 * encrypted entry of the manifest's slot list that only the computers that have opened the file
 * can read. These are the building blocks; lib/services/security2.challengeSlots.test.ts runs the
 * whole thing (two computers, the forgot-password screen, copies, old files, tampering).
 *  - the box opens only with an entry for this computer's device secret, and only unchanged;
 *  - each computer refreshes its own entry and keeps the others verbatim (at most 16, oldest out);
 *  - its length does not tell one question from another, or none from one;
 *  - a crafted set (huge box, huge device list, wrong types) is refused quickly, never thrown;
 *  - a manifest never carries plain challenge slots next to a set or where a device secret
 *    exists; without one, exactly what it was given (as before).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nodeCrypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.BKA_TEST_FAST_KDF = '1';
delete process.env.BKA_DEVICE_VAULT;
const require = createRequire(import.meta.url);
const fc = require('../electron/fileCrypto.js');
const format = require('../electron/companyFileFormat.js');

/** A computer's device key, the way lib/ai/keyVault.ts deviceKey() gives it. */
function computer(): { secret: string; keyId: string } {
  const secret = nodeCrypto.randomBytes(32).toString('hex');
  const keyId = nodeCrypto.createHash('sha256').update(`ironbooks/device-vault/key-id\n${secret}`).digest('hex').slice(0, 8);
  return { secret, keyId };
}

const A = computer();
const B = computer();
const fileKey = fc.generateFileKey();
const lookupSalt = fc.newLookupSalt();
const QUESTION = 'Make and model of your first car';
let challengeSlot: Record<string, unknown>;
let passwordSlot: Record<string, unknown>;
let root = '';

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-challenge-set-'));
  const tag = fc.lookupTag(lookupSalt, 'jo');
  challengeSlot = await fc.makeSlot({ kind: 'challenge', secret: 'saab nine hundred turbo', fileKey, tag, question: QUESTION });
  passwordSlot = await fc.makeSlot({ kind: 'password', secret: 'Jo-Pass-0001', fileKey, tag });
});
afterEach(() => {
  delete process.env.BKA_DEVICE_VAULT;
});
afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('a challenge set opens only on the computers it was made for', () => {
  it('this computer reads the challenge slots; another computer reads nothing', async () => {
    const kc = fc.newChallengeKey();
    const set = fc.sealChallengeSet({ challengeKey: kc, slots: [challengeSlot, passwordSlot], device: A });
    expect(set).toMatchObject({ kind: fc.CHALLENGE_SET_KIND, v: 1, id: fc.challengeKeyId(kc) });
    expect(set.devices.map((d: { id: string }) => d.id)).toEqual([A.keyId]);
    // Only challenge slots go in, and nothing readable comes out.
    const text = JSON.stringify(set);
    expect(text).not.toContain(QUESTION);
    expect(text).not.toContain(String(challengeSlot.tag));
    const opened = fc.openChallengeSet(set, A);
    expect(opened).toEqual([challengeSlot]);
    expect(fc.openChallengeSet(set, B)).toBeNull();
    expect(fc.openChallengeSet(set, null)).toBeNull();
    // The slot inside opens the file key exactly as a plain one did.
    const enc = { lookupSalt, keyCheck: fc.keyCheckOf(fileKey), slots: opened };
    expect((await fc.unlockWith(enc, { kind: 'challenge', login: 'jo', secret: 'saab nine hundred turbo' }))?.equals(fileKey)).toBe(true);
  });

  it('every part is authenticated: a changed box, entry or id opens nothing (and never throws)', () => {
    const kc = fc.newChallengeKey();
    const set = fc.sealChallengeSet({ challengeKey: kc, slots: [challengeSlot], device: A });
    const flip = (s: string, at: number) => s.slice(0, at) + (s[at] === 'A' ? 'B' : 'A') + s.slice(at + 1);
    const variants = [
      { ...set, box: flip(set.box, Math.floor(set.box.length / 2)) },
      { ...set, box: set.box.slice(0, Math.floor(set.box.length / 2)) },
      { ...set, box: '' },
      { ...set, devices: [{ ...set.devices[0], key: flip(set.devices[0].key, 20) }] },
      { ...set, devices: [{ ...set.devices[0], key: set.devices[0].key.slice(0, 30) }] },
      { ...set, devices: [] },
      { ...set, devices: 'nope' },
      { ...set, id: fc.challengeKeyId(fc.newChallengeKey()) },
      { ...set, v: 2 },
      { ...set, kind: 'challenge' },
      { ...set, box: 42 },
      { kind: fc.CHALLENGE_SET_KIND },
      null,
    ];
    for (const v of variants) expect(fc.openChallengeSet(v, A)).toBeNull();
    // An entry for this computer under another challenge key (pasted from another file) neither.
    const other = fc.sealChallengeSet({ challengeKey: fc.newChallengeKey(), slots: [challengeSlot], device: A });
    expect(fc.openChallengeSet({ ...set, devices: other.devices }, A)).toBeNull();
    // A bogus entry with this computer's id before the real one does not hide it.
    const bogus = { id: A.keyId, key: Buffer.alloc(60, 1).toString('base64url') };
    expect(fc.openChallengeSet({ ...set, devices: [bogus, ...set.devices] }, A)).toEqual([challengeSlot]);
  });

  it('a crafted set is refused quickly: a huge box, a huge device list', () => {
    const kc = fc.newChallengeKey();
    const set = fc.sealChallengeSet({ challengeKey: kc, slots: [challengeSlot], device: A });
    const started = Date.now();
    expect(fc.openChallengeSet({ ...set, box: 'A'.repeat(4 * fc.MAX_CHALLENGE_BOX_BYTES) }, A)).toBeNull();
    const junk = Array.from({ length: 200_000 }, (_, i) => ({ id: (i % 2 ? A.keyId : B.keyId), key: 'x' }));
    expect(fc.openChallengeSet({ ...set, devices: junk }, A)).toBeNull();
    expect(fc.challengeSetOf({ slots: Array.from({ length: fc.MAX_SLOTS + 10 }, () => ({ kind: 'password' })).concat([set]) })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('each computer keeps its own entry; the others are kept as they are', () => {
  it('B adds its entry next to A; A refreshes its own and keeps B', () => {
    const kc = fc.newChallengeKey();
    const onA = fc.sealChallengeSet({ challengeKey: kc, slots: [challengeSlot], device: A });
    const onB = fc.sealChallengeSet({ challengeKey: kc, slots: [challengeSlot], device: B, keep: onA });
    expect(onB.devices.map((d: { id: string }) => d.id)).toEqual([A.keyId, B.keyId]);
    expect(onB.devices[0]).toEqual(onA.devices[0]); // verbatim
    expect(fc.openChallengeSet(onB, A)).toEqual([challengeSlot]);
    expect(fc.openChallengeSet(onB, B)).toEqual([challengeSlot]);
    const againOnA = fc.sealChallengeSet({ challengeKey: kc, slots: [], device: A, keep: onB });
    expect(againOnA.devices.map((d: { id: string }) => d.id)).toEqual([B.keyId, A.keyId]);
    expect(againOnA.devices[0]).toEqual(onB.devices[1]);
    expect(againOnA.devices[1]).not.toEqual(onA.devices[0]); // refreshed
    // A change made on A (no challenge slot any more) reaches B: the box is under the file's key.
    expect(fc.openChallengeSet(againOnA, B)).toEqual([]);
  });

  it('a set made for another challenge key keeps nothing', () => {
    const onA = fc.sealChallengeSet({ challengeKey: fc.newChallengeKey(), slots: [], device: A });
    const fresh = fc.sealChallengeSet({ challengeKey: fc.newChallengeKey(), slots: [], device: B, keep: onA });
    expect(fresh.devices.map((d: { id: string }) => d.id)).toEqual([B.keyId]);
  });

  it(`at most ${16} computers: the one that saved longest ago is dropped`, () => {
    expect(fc.MAX_CHALLENGE_DEVICES).toBe(16);
    const kc = fc.newChallengeKey();
    const pcs = Array.from({ length: 20 }, computer);
    let set = null;
    for (const pc of pcs) set = fc.sealChallengeSet({ challengeKey: kc, slots: [], device: pc, keep: set });
    expect(set.devices.map((d: { id: string }) => d.id)).toEqual(pcs.slice(-16).map((p) => p.keyId));
    expect(fc.openChallengeSet(set, pcs[0])).toBeNull();
    expect(fc.openChallengeSet(set, pcs[19])).toEqual([]);
  });
});

describe('the length of a set says little', () => {
  it('no slot, one slot, a short or a long question: the same box length', async () => {
    const kc = fc.newChallengeKey();
    const tag = fc.lookupTag(lookupSalt, 'jo');
    const short = await fc.makeSlot({ kind: 'challenge', secret: 'rex the brown dog', fileKey, tag, question: 'Name of your first pet' });
    const long = await fc.makeSlot({ kind: 'challenge', secret: 'rex the brown dog', fileKey, tag, question: "Your best friend's first name in school" });
    const lengths = [[], [short], [long]].map((slots) => fc.sealChallengeSet({ challengeKey: kc, slots, device: A }).box.length);
    expect(new Set(lengths).size).toBe(1);
  });
});

describe('what a manifest is written with', () => {
  async function writeWith(slots: unknown[]) {
    const file = path.join(root, `m-${nodeCrypto.randomBytes(4).toString('hex')}.ironbooks`);
    await format.writeCompanyFile(file, {
      manifest: { formatVersion: format.COMPANY_FILE_FORMAT_VERSION, fileId: 'f', companyName: 'Juniper Lane', saveId: 's', previousSaveId: null, savedAt: new Date().toISOString() },
      entries: [{ name: 'PG_VERSION', data: Buffer.from('17\n') }],
      protection: { fileKey, keyCheck: fc.keyCheckOf(fileKey), lookupSalt, slots },
    });
    return format.readCompanyManifest(file).encryption.slots as Array<{ kind: string }>;
  }

  it('without a device secret: exactly the slots given, plain challenge slots included (as before)', async () => {
    const slots = [passwordSlot, challengeSlot];
    expect(fc.slotsForManifest(slots)).toBe(slots);
    expect(await writeWith(slots)).toEqual(slots);
  });

  it('next to a challenge set: never a plain challenge slot', async () => {
    const set = fc.sealChallengeSet({ challengeKey: fc.newChallengeKey(), slots: [challengeSlot], device: A });
    expect((await writeWith([passwordSlot, challengeSlot, set])).map((s) => s.kind)).toEqual(['password', fc.CHALLENGE_SET_KIND]);
  });

  it('where a device secret exists: never a plain challenge slot (a copy of an older file has no challenge route)', async () => {
    process.env.BKA_DEVICE_VAULT = A.secret;
    expect(fc.deviceSecretPresent()).toBe(true);
    expect((await writeWith([passwordSlot, challengeSlot])).map((s) => s.kind)).toEqual(['password']);
    process.env.BKA_DEVICE_VAULT = 'not-a-secret';
    expect(fc.deviceSecretPresent()).toBe(false);
  });

  it('the slot list stays outside the listing bound into the index: an edited set does not refuse the file', async () => {
    const set = fc.sealChallengeSet({ challengeKey: fc.newChallengeKey(), slots: [challengeSlot], device: A });
    const file = path.join(root, 'bound.ironbooks');
    await format.writeCompanyFile(file, {
      manifest: { formatVersion: format.COMPANY_FILE_FORMAT_VERSION, fileId: 'f', companyName: 'Juniper Lane', saveId: 's', previousSaveId: null, savedAt: new Date().toISOString() },
      entries: [{ name: 'PG_VERSION', data: Buffer.from('17\n') }],
      protection: { fileKey, keyCheck: fc.keyCheckOf(fileKey), lookupSalt, slots: [passwordSlot, set] },
    });
    // Same length, every zip checksum right: what someone without the key could do.
    const buf = fs.readFileSync(file);
    const at = buf.indexOf(Buffer.from(set.box.slice(10, 40)));
    expect(at).toBeGreaterThan(0);
    buf.write('A'.repeat(30), at, 'utf8');
    const dir = format.readCentralDirectory(buf);
    const e = dir.find((x: { name: string }) => x.name === 'ironbooks-company.json');
    const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
    const crc = format.crc32(buf.subarray(start, start + e.csize));
    buf.writeUInt32LE(crc, e.offset + 14);
    buf.writeUInt32LE(crc, buf.lastIndexOf(Buffer.from('ironbooks-company.json')) - 46 + 16);
    fs.writeFileSync(file, buf);
    const m = format.readCompanyManifest(file);
    expect(fc.openChallengeSet(fc.challengeSetOf(m.encryption), A)).toBeNull();
    // The password still opens the file, and the file checks out with its key.
    const key = await fc.unlockWith(m.encryption, { kind: 'password', login: 'jo', secret: 'Jo-Pass-0001' });
    expect(key?.equals(fileKey)).toBe(true);
    expect(await format.verifySealedCompanyFile(file, key)).not.toBeNull();
  });
});
