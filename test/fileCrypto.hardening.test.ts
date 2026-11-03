/**
 * Hardening of the company file's own passwords (post-merge review of filecrypto):
 *  - the plain listing of a protected file (save ids, the training flag, the layout, the company
 *    name) is bound into its encrypted index: changed without the key, the file is refused;
 *  - entries are encrypted with a per-container subkey, never with the long-lived file key itself;
 *  - key slots wrap the file key to a per-slot public key, so a NEW file key can be wrapped for
 *    every remaining slot without anyone's password (key rotation) — and a slot pasted in from
 *    elsewhere is never re-wrapped to;
 *  - a tampered manifest can't ask for absurd scrypt costs; challenge slots cost more;
 *  - files written by the first protected layout (1) still open.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.BKA_TEST_FAST_KDF = '1';
const require = createRequire(import.meta.url);
const crypto = require('../electron/fileCrypto.js');
const format = require('../electron/companyFileFormat.js');

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-crypto-hard-'));
});
afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const COMPANY = 'Marigold Bakery LLC';
const CUSTOMER = 'Zebulon Quarterfield Holdings';

function makeSource(name: string) {
  const src = path.join(root, name);
  fs.mkdirSync(path.join(src, 'base', '1'), { recursive: true });
  fs.writeFileSync(path.join(src, 'PG_VERSION'), '17\n');
  fs.writeFileSync(path.join(src, 'base', '1', '1259'), Buffer.concat([Buffer.from(`customer=${CUSTOMER};`), Buffer.alloc(4000, 7)]));
  return src;
}

async function protection(passwords: Record<string, string>) {
  const fileKey = crypto.generateFileKey();
  const lookupSalt = crypto.newLookupSalt();
  const slots = [];
  for (const [login, pw] of Object.entries(passwords)) {
    slots.push(await crypto.makeSlot({ kind: 'password', secret: pw, fileKey, tag: crypto.lookupTag(lookupSalt, login) }));
  }
  return { fileKey, lookupSalt, keyCheck: crypto.keyCheckOf(fileKey), slots };
}

async function writeSealed(name: string, prot: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const file = path.join(root, `${name}.ironbooks`);
  await format.writeCompanyFile(file, {
    manifest: {
      formatVersion: format.COMPANY_FILE_FORMAT_VERSION,
      fileId: 'f-1',
      companyName: COMPANY,
      saveId: 's-1',
      previousSaveId: null,
      savedAt: '2026-11-01T10:00:00.000Z',
      appVersion: '1.7.0',
      dbSchema: { migrations: 80, lastMigrationAt: 1781400083000 },
      training: false,
      fingerprint: 'log:1:h1',
      ...extra,
    },
    backupManifest: { app: 'bookkeeper-ai', formatVersion: 2, kind: 'full', companyName: COMPANY, createdAt: 'now' },
    entries: format.snapshotDir(makeSource(`src-${name}`)),
    protection: prot,
  });
  return file;
}

/**
 * Change the plain manifest of a file in place, keeping its length and every zip checksum right
 * (what someone with a hex editor, or a script, but without the key would do).
 */
function patchManifest(file: string, from: string, to: string) {
  expect(to.length).toBe(from.length);
  const buf = fs.readFileSync(file);
  const at = buf.indexOf(Buffer.from(from));
  expect(at).toBeGreaterThan(0);
  expect(at).toBeLessThan(8192);
  buf.write(to, at, 'utf8');
  const dir = format.readCentralDirectory(buf);
  const e = dir.find((x: { name: string }) => x.name === 'ironbooks-company.json');
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const crc = format.crc32(buf.subarray(start, start + e.csize));
  buf.writeUInt32LE(crc, e.offset + 14);
  const cdEntry = buf.lastIndexOf(Buffer.from('ironbooks-company.json')) - 46;
  buf.writeUInt32LE(crc, cdEntry + 16);
  fs.writeFileSync(file, buf);
}

describe('the plain listing of a protected file is bound to its encrypted contents', () => {
  const cases: Array<[string, string, string]> = [
    ['the training flag', '"training": false', '"training": true '],
    ['the save id (the open plan)', '"saveId": "s-1"', '"saveId": "s-9"'],
    ['the company name', `"companyName": "${COMPANY}"`, `"companyName": "${COMPANY.replace('LLC', 'LTD')}"`],
    ['the database layout', '"lastMigrationAt": 1781400083000', '"lastMigrationAt": 1781400099000'],
    ['the encryption layout', '"v": 2,', '"v": 1,'],
  ];
  for (const [what, from, to] of cases) {
    it(`a changed ${what} is refused once the key is known, before anything is written`, async () => {
      const prot = await protection({ mary: 'pw-12345678' });
      const file = await writeSealed(`Listing-${what.replace(/\W+/g, '-')}`, prot);
      // Untouched, it opens and verifies.
      expect(await format.verifySealedCompanyFile(file, prot.fileKey)).toMatchObject({ fingerprint: 'log:1:h1' });
      patchManifest(file, from, to);
      // The No Company Open list still reads it (no key needed)...
      expect(format.readCompanyManifest(file).fileId).toBe('f-1');
      // ...but with the key it is refused, and nothing is extracted.
      const out = path.join(root, `listing-out-${what.replace(/\W+/g, '-')}`);
      await expect(format.extractCompanyFile(file, out, { fileKey: prot.fileKey })).rejects.toMatchObject({ code: 'TAMPERED' });
      expect(fs.existsSync(out) ? fs.readdirSync(out) : []).toEqual([]);
      await expect(format.verifySealedCompanyFile(file, prot.fileKey)).rejects.toMatchObject({ code: 'TAMPERED' });
      await expect(format.extractBackupArchive(file, `${out}-bka`, { fileKey: prot.fileKey })).rejects.toMatchObject({ code: 'TAMPERED' });
      expect(() => format.unsealArchiveSync(fs.readFileSync(file), prot.fileKey)).toThrow(/integrity/);
    });
  }

  it('the key slots are not part of the listing (they are rewritten in place and authenticated themselves)', async () => {
    const prot = await protection({ mary: 'pw-12345678' });
    const file = await writeSealed('SlotsFree', prot);
    const m = format.readCompanyManifest(file);
    const bob = await crypto.makeSlot({ kind: 'password', secret: 'bob-pass-22', fileKey: prot.fileKey, tag: crypto.lookupTag(prot.lookupSalt, 'bob') });
    // Rewrite the file with one more slot but the same listing: still verifies.
    const file2 = await writeSealed('SlotsFree2', { ...prot, slots: [...prot.slots, bob] });
    expect(format.readCompanyManifest(file2).encryption.slots).toHaveLength(2);
    expect(await format.verifySealedCompanyFile(file2, prot.fileKey)).toBeTruthy();
    expect(m.encryption.slots).toHaveLength(1);
  });

  it('a backup bound to its own listing, and a company file made from it without decrypting it, both open', async () => {
    const prot = await protection({ mary: 'pw-12345678' });
    const buf = format.buildBackupArchive({
      backupManifest: { app: 'bookkeeper-ai', formatVersion: 2, kind: 'full', companyName: COMPANY, createdAt: '2026-11-01T00:00:00Z', dbSchemaAt: 7 },
      entries: format.snapshotDir(makeSource('src-bound-bka'), { lazyPrefixes: [] }),
      protection: prot,
    });
    expect(format.unsealArchiveSync(buf, prot.fileKey).entries.length).toBeGreaterThan(0);
    const bka = path.join(root, 'bound.bka');
    fs.writeFileSync(bka, buf);
    const target = path.join(root, 'FromBackup.ironbooks');
    await format.sealedBackupAsCompanyFile(bka, target, {
      manifest: { fileId: 'new-id', companyName: COMPANY, saveId: 'n1', previousSaveId: null, savedAt: 'now', appVersion: '1.7.0' },
    });
    await format.extractCompanyFile(target, path.join(root, 'from-backup-out'), { fileKey: prot.fileKey });
    // Made a training file by editing its listing: refused.
    const tampered = path.join(root, 'FromBackupTraining.ironbooks');
    await format.sealedBackupAsCompanyFile(bka, tampered, {
      manifest: { fileId: 'new-id', companyName: COMPANY, saveId: 'n1', previousSaveId: null, savedAt: 'now', appVersion: '1.7.0', training: true },
    });
    await expect(format.extractCompanyFile(tampered, path.join(root, 'from-backup-tr'), { fileKey: prot.fileKey })).rejects.toMatchObject({ code: 'TAMPERED' });
  });

  it('a file of the first protected layout (1: no bound listing, the file key itself) still opens', async () => {
    const prot = await protection({ mary: 'pw-12345678' });
    const file = await writeSealed('Layout1', { ...prot, sealV: 1 });
    const m = format.readCompanyManifest(file);
    expect(m.encryption.v).toBe(1);
    const out = path.join(root, 'layout1-out');
    await format.extractCompanyFile(file, out, { fileKey: prot.fileKey });
    expect(fs.readFileSync(path.join(out, 'PG_VERSION'), 'utf8')).toBe('17\n');
  });
});

describe('entries are encrypted with a per-container subkey', () => {
  it('no entry of a layout-2 file opens with the file key itself; each container has its own subkey', async () => {
    const prot = await protection({ mary: 'pw-12345678' });
    const a = await writeSealed('SubkeyA', prot);
    const b = await writeSealed('SubkeyB', prot);
    const ma = format.readCompanyManifest(a);
    const mb = format.readCompanyManifest(b);
    expect(ma.encryption.v).toBe(2);
    const ka = crypto.containerKey(prot.fileKey, ma.encryption.sealId, 2);
    const kb = crypto.containerKey(prot.fileKey, mb.encryption.sealId, 2);
    expect(ka.equals(prot.fileKey)).toBe(false);
    expect(ka.equals(kb)).toBe(false);
    const buf = fs.readFileSync(a);
    const dir = format.readCentralDirectory(buf);
    const e = dir.find((x: { name: string }) => x.name === 'sealed/index');
    const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
    const sealed = buf.subarray(start, start + e.csize);
    const aad = crypto.entryAad(ma.encryption.sealId, 'sealed/index', 'sealed/index');
    expect(() => crypto.openBytes(prot.fileKey, sealed, aad)).toThrow(/integrity/);
    expect(JSON.parse(crypto.openBytes(ka, sealed, aad).toString('utf8')).sealId).toBe(ma.encryption.sealId);
  });
});

describe('key slots can be re-wrapped to a new file key without anyone’s password', () => {
  it('a re-wrapped slot opens with the same password to the NEW key, never the old one', async () => {
    const prot = await protection({ mary: 'mary-pass-1' });
    const [slot] = prot.slots;
    expect(slot.v).toBe(2);
    expect(crypto.isRewrappable(slot)).toBe(true);
    expect(crypto.slotMacOk(prot.fileKey, slot)).toBe(true);
    const newKey = crypto.generateFileKey();
    const next = crypto.rewrapSlot(slot, prot.fileKey, newKey);
    expect(next).toBeTruthy();
    expect(crypto.slotMacOk(newKey, next)).toBe(true);
    expect(crypto.slotMacOk(prot.fileKey, next)).toBe(false);
    expect((await crypto.openSlot(next, 'mary-pass-1')).equals(newKey)).toBe(true);
    expect(await crypto.openSlot(next, 'wrong-pass')).toBeNull();
    // The old slot still opens only the old key (an old copy of the file keeps its old key).
    expect((await crypto.openSlot(slot, 'mary-pass-1')).equals(prot.fileKey)).toBe(true);
  });

  it('a slot pasted in with someone else’s public key is never re-wrapped to (its MAC does not check out)', async () => {
    const prot = await protection({ mary: 'mary-pass-1' });
    const attacker = await crypto.makeSlot({ kind: 'password', secret: 'mine', fileKey: crypto.generateFileKey() });
    const pasted = { ...prot.slots[0], pub: attacker.pub, sk: attacker.sk };
    expect(crypto.rewrapSlot(pasted, prot.fileKey, crypto.generateFileKey())).toBeNull();
    expect(crypto.rewrapSlot(attacker, prot.fileKey, crypto.generateFileKey())).toBeNull();
    // Its private key is bound to its public key: swapping one does not open either.
    expect(await crypto.openSlot(pasted, 'mary-pass-1')).toBeNull();
  });

  it('a slot of the first layout (no public key) opens, but can only be re-made with its secret', async () => {
    // What makeSlot wrote before: the file key wrapped directly by the secret's key.
    const nodeCrypto = require('node:crypto');
    const fileKey = crypto.generateFileKey();
    const salt = nodeCrypto.randomBytes(16).toString('base64url');
    const kdf = crypto.currentKdf();
    const kek = nodeCrypto.scryptSync('old-pass-1', Buffer.from(salt, 'base64url'), 32, { N: kdf.N, r: kdf.r, p: kdf.p });
    const nonce = nodeCrypto.randomBytes(12);
    const c = nodeCrypto.createCipheriv('aes-256-gcm', kek, nonce);
    c.setAAD(Buffer.from(`ironbooks-slot/v1\npassword\n${salt}`, 'utf8'));
    const wrapped = Buffer.concat([c.update(fileKey), c.final(), c.getAuthTag()]);
    const v1 = { kind: 'password', kdf: { ...kdf }, salt, nonce: nonce.toString('base64url'), wrapped: wrapped.toString('base64url') };
    expect(crypto.wellFormedSlot(v1)).toBe(true);
    expect((await crypto.openSlot(v1, 'old-pass-1')).equals(fileKey)).toBe(true);
    expect(crypto.isRewrappable(v1)).toBe(false);
    expect(crypto.rewrapSlot(v1, fileKey, crypto.generateFileKey())).toBeNull();
  });
});

describe('scrypt costs', () => {
  it('a tampered slot can not ask for more than N=2^18, r=16, p=4', () => {
    expect(crypto.validKdf({ name: 'scrypt', N: 1 << 18, r: 16, p: 4 })).toBe(true);
    expect(crypto.validKdf({ name: 'scrypt', N: 1 << 19, r: 8, p: 1 })).toBe(false);
    expect(crypto.validKdf({ name: 'scrypt', N: 1 << 16, r: 17, p: 1 })).toBe(false);
    expect(crypto.validKdf({ name: 'scrypt', N: 1 << 16, r: 8, p: 5 })).toBe(false);
  });

  it('challenge slots cost more than password slots (outside the fast test mode)', () => {
    expect(crypto.CHALLENGE_KDF.N).toBeGreaterThan(crypto.DEFAULT_KDF.N);
    expect(crypto.validKdf(crypto.CHALLENGE_KDF)).toBe(true);
    const env = process.env.BKA_TEST_FAST_KDF;
    delete process.env.BKA_TEST_FAST_KDF;
    try {
      expect(crypto.kdfFor('challenge')).toEqual(crypto.CHALLENGE_KDF);
      expect(crypto.kdfFor('password')).toEqual(crypto.DEFAULT_KDF);
      // A challenge slot made with the password cost is re-made at the next chance.
      expect(crypto.kdfIsCurrent(crypto.DEFAULT_KDF, 'challenge')).toBe(false);
      expect(crypto.kdfIsCurrent(crypto.CHALLENGE_KDF, 'challenge')).toBe(true);
    } finally {
      process.env.BKA_TEST_FAST_KDF = env;
    }
  });
});
