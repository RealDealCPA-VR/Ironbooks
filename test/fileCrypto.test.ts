/**
 * The company file's own passwords (electron/fileCrypto.js + the sealed layout of
 * electron/companyFileFormat.js): a protected file keeps only its manifest readable, every other
 * entry is encrypted with the file key, and the file key opens only from a key slot — a user's
 * password, their challenge answer, or the recovery key. Wrong keys, changed bytes, swapped
 * entries and tampered slots are all refused before anything is written to disk.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import AdmZip from 'adm-zip';

process.env.BKA_TEST_FAST_KDF = '1';
const require = createRequire(import.meta.url);
const crypto = require('../electron/fileCrypto.js');
const format = require('../electron/companyFileFormat.js');

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-crypto-'));
});
afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const CUSTOMER = 'Zebulon Quarterfield Holdings';
const COMPANY = 'Marigold Bakery LLC';

/** A small "data folder" whose files name the customer, as a real database would. */
function makeSource(name: string, extra: Record<string, Buffer | string> = {}) {
  const src = path.join(root, name);
  fs.mkdirSync(path.join(src, 'base', '1'), { recursive: true });
  fs.mkdirSync(path.join(src, 'pg_tblspc'), { recursive: true });
  fs.mkdirSync(path.join(src, 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(src, 'PG_VERSION'), '17\n');
  fs.writeFileSync(path.join(src, 'base', '1', '1259'), Buffer.concat([Buffer.from(`customer=${CUSTOMER};company=${COMPANY};`), Buffer.alloc(9000, 7)]));
  fs.writeFileSync(path.join(src, 'attachments', `uuid-${CUSTOMER} invoice.pdf`), `%PDF-1.4 ${CUSTOMER}`);
  fs.writeFileSync(path.join(src, 'transactions.bktlg'), JSON.stringify({ seq: 1, hash: 'h1', summary: `Invoice for ${CUSTOMER}` }) + '\n');
  for (const [k, v] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(src, k)), { recursive: true });
    fs.writeFileSync(path.join(src, k), v);
  }
  return src;
}

async function protectionFor(passwords: Record<string, string>, opts: { recovery?: string; challenge?: { login: string; question: string; answer: string } } = {}) {
  const fileKey = crypto.generateFileKey();
  const lookupSalt = crypto.newLookupSalt();
  const slots = [];
  for (const [login, pw] of Object.entries(passwords)) {
    slots.push(await crypto.makeSlot({ kind: 'password', secret: pw, fileKey, tag: crypto.lookupTag(lookupSalt, login) }));
  }
  if (opts.challenge) {
    slots.push(
      await crypto.makeSlot({
        kind: 'challenge',
        secret: opts.challenge.answer,
        fileKey,
        tag: crypto.lookupTag(lookupSalt, opts.challenge.login),
        question: opts.challenge.question,
      }),
    );
  }
  if (opts.recovery) slots.push(await crypto.makeSlot({ kind: 'recovery', secret: crypto.normalizeRecoveryKey(opts.recovery), fileKey }));
  return { fileKey, lookupSalt, keyCheck: crypto.keyCheckOf(fileKey), slots };
}

const manifest = (extra: Record<string, unknown> = {}) => ({
  formatVersion: format.COMPANY_FILE_FORMAT_VERSION,
  fileId: 'f-1',
  companyName: COMPANY,
  saveId: 's-1',
  previousSaveId: null,
  savedAt: new Date().toISOString(),
  appVersion: '1.7.0',
  fingerprint: 'log:1:h1',
  savedBy: { computer: 'FRONT-DESK', appUser: 'mary' },
  ...extra,
});

async function writeSealed(name: string, prot: Awaited<ReturnType<typeof protectionFor>>, src = makeSource(`src-${name}`)) {
  const file = path.join(root, `${name}.ironbooks`);
  await format.writeCompanyFile(file, {
    manifest: manifest(),
    backupManifest: { app: 'bookkeeper-ai', formatVersion: 2, kind: 'full', companyName: COMPANY, createdAt: 'now' },
    entries: format.snapshotDir(src),
    protection: prot,
  });
  return file;
}

describe('sealed company file', () => {
  it('round-trips: only the listing fields and key slots are readable, everything else is encrypted', async () => {
    const prot = await protectionFor({ mary: 'Correct-Horse-9' });
    const file = await writeSealed('Roundtrip', prot);

    // A standard zip any tool can list — but the names say nothing.
    const zip = new AdmZip(file);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names[0]).toBe('ironbooks-company.json');
    expect(names.slice(1).every((n) => n.startsWith('sealed/'))).toBe(true);
    expect(names).toContain('sealed/index');
    expect(names).not.toContain('bookkeeper-manifest.json');

    // The manifest: what No Company Open shows, plus the key slots. No private details.
    const m = format.readCompanyManifest(file);
    expect(m).toMatchObject({ companyName: COMPANY, fileId: 'f-1', saveId: 's-1', formatVersion: 2 });
    expect(m.fingerprint).toBeUndefined();
    expect(m.savedBy).toBeUndefined();
    expect(format.isSealedManifest(m)).toBe(true);
    expect(m.encryption.slots).toHaveLength(1);
    expect(JSON.stringify(m)).not.toMatch(/mary/i);

    // The raw bytes hold no customer name anywhere (names, data, log, attachment).
    const raw = fs.readFileSync(file);
    expect(raw.includes(Buffer.from(CUSTOMER))).toBe(false);
    expect(raw.includes(Buffer.from('Zebulon'))).toBe(false);
    // The company name is only in the manifest (it is what the No Company Open list shows).
    const firstCopy = raw.indexOf(Buffer.from(COMPANY));
    expect(firstCopy).toBeGreaterThan(0);
    expect(firstCopy).toBeLessThan(4096);
    expect(raw.indexOf(Buffer.from(COMPANY), firstCopy + COMPANY.length)).toBe(-1);

    // Without the key nothing is extracted.
    const none = path.join(root, 'rt-nokey');
    await expect(format.extractCompanyFile(file, none)).rejects.toMatchObject({ code: 'SEALED' });
    expect(fs.existsSync(none) ? fs.readdirSync(none) : []).toEqual([]);

    // The user's password opens the slot; the key extracts the exact files.
    const key = await crypto.unlockWith(m.encryption, { kind: 'password', login: ' Mary ', secret: 'Correct-Horse-9' });
    expect(Buffer.isBuffer(key)).toBe(true);
    const out = path.join(root, 'rt-out');
    const opened = await format.extractCompanyFile(file, out, { fileKey: key });
    expect(opened).toMatchObject({ companyName: COMPANY, fingerprint: 'log:1:h1', savedBy: { appUser: 'mary' } });
    expect(fs.readFileSync(path.join(out, 'PG_VERSION'), 'utf8')).toBe('17\n');
    expect(fs.readFileSync(path.join(out, 'base', '1', '1259')).includes(Buffer.from(CUSTOMER))).toBe(true);
    expect(fs.readFileSync(path.join(out, 'attachments', `uuid-${CUSTOMER} invoice.pdf`), 'utf8')).toContain(CUSTOMER);
    expect(fs.existsSync(path.join(out, 'pg_tblspc'))).toBe(true); // empty folders survive
    expect(fs.existsSync(path.join(out, 'bookkeeper-manifest.json'))).toBe(false);
  });

  it('refuses a wrong password and a wrong key, and a wrong user name costs the same work', async () => {
    const prot = await protectionFor({ mary: 'Correct-Horse-9' });
    const file = await writeSealed('WrongKey', prot);
    const m = format.readCompanyManifest(file);
    expect(await crypto.unlockWith(m.encryption, { kind: 'password', login: 'mary', secret: 'correct-horse-9' })).toBeNull();
    expect(await crypto.unlockWith(m.encryption, { kind: 'password', login: 'bob', secret: 'Correct-Horse-9' })).toBeNull();
    const out = path.join(root, 'wk-out');
    await expect(format.extractCompanyFile(file, out, { fileKey: crypto.generateFileKey() })).rejects.toMatchObject({ code: 'TAMPERED' });
    expect(fs.existsSync(out) ? fs.readdirSync(out) : []).toEqual([]);
  });

  it('refuses a changed byte in an entry or in its tag, leaving nothing half-extracted', async () => {
    const prot = await protectionFor({ mary: 'pw-12345678' });
    for (const where of ['middle', 'tag'] as const) {
      const file = await writeSealed(`Tampered-${where}`, prot);
      const buf = fs.readFileSync(file);
      const dir = format.readCentralDirectory(buf);
      const e = dir.find((x: { name: string }) => x.name === 'sealed/000003') ?? dir.find((x: { name: string }) => x.name.startsWith('sealed/0'));
      const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
      const at = where === 'middle' ? start + 20 : start + e.csize - 3;
      buf[at] ^= 0x01;
      // Keep the zip CRC right, so only the authentication tag can notice.
      const data = buf.subarray(start, start + e.csize);
      const crc = format.crc32(data);
      buf.writeUInt32LE(crc, e.offset + 14);
      const cdEntry = buf.indexOf(Buffer.from(e.name), buf.length - 4096) - 46;
      buf.writeUInt32LE(crc, cdEntry + 16);
      fs.writeFileSync(file, buf);
      const out = path.join(root, `tampered-${where}`);
      await expect(format.extractCompanyFile(file, out, { fileKey: prot.fileKey })).rejects.toMatchObject({ code: 'TAMPERED' });
      expect(fs.existsSync(out) ? fs.readdirSync(out) : []).toEqual([]);
    }
  });

  it('refuses entries swapped between names or brought in from another save', async () => {
    const prot = await protectionFor({ mary: 'pw-12345678' });
    const a = await writeSealed('SwapA', prot);
    const b = await writeSealed('SwapB', prot); // same key, another save (another sealId)
    // Swap two entries of one file: the names are the additional data.
    const zipA = new AdmZip(a);
    const one = zipA.getEntry('sealed/000001')!.getData();
    const two = zipA.getEntry('sealed/000002')!.getData();
    zipA.getEntry('sealed/000001')!.setData(two);
    zipA.getEntry('sealed/000002')!.setData(one);
    const swapped = path.join(root, 'Swapped.ironbooks');
    zipA.writeZip(swapped);
    await expect(format.extractCompanyFile(swapped, path.join(root, 'swap-out'), { fileKey: prot.fileKey })).rejects.toMatchObject({ code: 'TAMPERED' });
    // An entry from another save of the same file (same key): the sealId differs.
    const zipB = new AdmZip(b);
    const zipA2 = new AdmZip(a);
    zipA2.getEntry('sealed/000002')!.setData(zipB.getEntry('sealed/000002')!.getData());
    const mixed = path.join(root, 'Mixed.ironbooks');
    zipA2.writeZip(mixed);
    await expect(format.extractCompanyFile(mixed, path.join(root, 'mixed-out'), { fileKey: prot.fileKey })).rejects.toMatchObject({ code: 'TAMPERED' });
  });

  it('a tampered key slot does not open (and a slot from another file is refused by the key check)', async () => {
    const prot = await protectionFor({ mary: 'pw-12345678' });
    const slot = prot.slots[0];
    const flipped = { ...slot, wrapped: Buffer.from(Buffer.from(slot.wrapped, 'base64url').map((b: number, i: number) => (i === 3 ? b ^ 1 : b))).toString('base64url') };
    expect(await crypto.openSlot(flipped, 'pw-12345678')).toBeNull();
    expect(await crypto.openSlot({ ...slot, kind: 'recovery' }, 'pw-12345678')).toBeNull(); // kind is authenticated
    expect(await crypto.openSlot({ ...slot, salt: crypto.newLookupSalt() }, 'pw-12345678')).toBeNull();
    expect(await crypto.openSlot({ ...slot, kdf: { name: 'scrypt', N: 1 << 30, r: 8, p: 1 } }, 'pw-12345678')).toBeNull(); // no memory bomb
    // A slot from another file pasted in: it opens to the other file's key, which the key check refuses.
    const other = await protectionFor({ mary: 'pw-12345678' });
    const enc = { lookupSalt: prot.lookupSalt, keyCheck: prot.keyCheck, slots: [{ ...other.slots[0], tag: slot.tag }] };
    expect(await crypto.unlockWith(enc, { kind: 'password', login: 'mary', secret: 'pw-12345678' })).toBeNull();
  });

  it('slots are added and removed without touching the data, and the user names stay hidden', async () => {
    const prot = await protectionFor({ mary: 'mary-pass-1' });
    const bobSlot = await crypto.makeSlot({ kind: 'password', secret: 'bob-pass-2', fileKey: prot.fileKey, tag: crypto.lookupTag(prot.lookupSalt, 'bob') });
    const withBob = { ...prot, slots: [...prot.slots, bobSlot] };
    const file = await writeSealed('Slots', withBob);
    let m = format.readCompanyManifest(file);
    expect(JSON.stringify(m)).not.toMatch(/bob|mary/i);
    expect(await crypto.unlockWith(m.encryption, { kind: 'password', login: 'bob', secret: 'bob-pass-2' })).toEqual(prot.fileKey);
    // Bob removed (deactivated): his slot is left out of the next save.
    const file2 = await writeSealed('Slots', { ...prot, slots: prot.slots });
    m = format.readCompanyManifest(file2);
    expect(await crypto.unlockWith(m.encryption, { kind: 'password', login: 'bob', secret: 'bob-pass-2' })).toBeNull();
    expect(await crypto.unlockWith(m.encryption, { kind: 'password', login: 'mary', secret: 'mary-pass-1' })).toEqual(prot.fileKey);
    // A user name change keeps the slot (only its lookup tag changes).
    const renamed = crypto.retagSlot(prot.slots[0], crypto.lookupTag(prot.lookupSalt, 'mary.smith'));
    expect(await crypto.unlockWith({ ...m.encryption, slots: [renamed] }, { kind: 'password', login: 'mary.smith', secret: 'mary-pass-1' })).toEqual(prot.fileKey);
  });

  it('the recovery key opens the file; it is 24 characters, grouped, and typed forgivingly', async () => {
    const rk = crypto.generateRecoveryKey();
    expect(rk).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
    expect(crypto.normalizeRecoveryKey(rk)).toHaveLength(24);
    const prot = await protectionFor({ mary: 'pw-12345678' }, { recovery: rk });
    const file = await writeSealed('Recovery', prot);
    const m = format.readCompanyManifest(file);
    const typed = ` ${rk.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o')} `;
    const key = await crypto.unlockWith(m.encryption, { kind: 'recovery', secret: crypto.normalizeRecoveryKey(typed) });
    expect(key).toEqual(prot.fileKey);
    expect(crypto.normalizeRecoveryKey('too-short')).toBeNull();
    const other = crypto.normalizeRecoveryKey(crypto.generateRecoveryKey());
    expect(await crypto.unlockWith(m.encryption, { kind: 'recovery', secret: other })).toBeNull();
  });

  it('the challenge answer opens its own slot, normalized, and the question is shown first', async () => {
    const prot = await protectionFor(
      { mary: 'pw-12345678' },
      { challenge: { login: 'mary', question: 'Name of your first pet', answer: 'mr whiskers' } },
    );
    const file = await writeSealed('Challenge', prot);
    const m = format.readCompanyManifest(file);
    const tag = crypto.lookupTag(m.encryption.lookupSalt, 'MARY');
    const [slot] = crypto.findSlots(m.encryption, 'challenge', tag);
    expect(slot.question).toBe('Name of your first pet');
    expect(await crypto.unlockWith(m.encryption, { kind: 'challenge', login: 'mary', secret: 'mr whiskers' })).toEqual(prot.fileKey);
    expect(await crypto.unlockWith(m.encryption, { kind: 'challenge', login: 'mary', secret: 'Mr Whisker' })).toBeNull();
    // The answer never opens the password slot, nor the password the challenge slot.
    expect(await crypto.unlockWith(m.encryption, { kind: 'password', login: 'mary', secret: 'mr whiskers' })).toBeNull();
    expect(await crypto.unlockWith(m.encryption, { kind: 'challenge', login: 'mary', secret: 'pw-12345678' })).toBeNull();
  });

  it('a big attachment goes through one entry at a time and comes back intact', async () => {
    const big = Buffer.alloc(30 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE(i, i);
    const src = makeSource('src-big', { 'attachments/scan-big.pdf': big });
    const prot = await protectionFor({ mary: 'pw-12345678' });
    const file = await writeSealed('Big', prot, src);
    const out = path.join(root, 'big-out');
    await format.extractCompanyFile(file, out, { fileKey: prot.fileKey });
    expect(fs.readFileSync(path.join(out, 'attachments', 'scan-big.pdf')).equals(big)).toBe(true);
  }, 120_000);

  it('Ironbooks 1.6 (format 1 reader) refuses a sealed file as "saved by a newer version"', async () => {
    const prot = await protectionFor({ mary: 'pw-12345678' });
    const file = await writeSealed('Newer', prot);
    const m = format.readCompanyManifest(file);
    // v1.6.0 extractCompanyFile: Number(manifest.formatVersion) > 1 -> NEWER_FORMAT.
    expect(Number(m.formatVersion)).toBeGreaterThan(1);
  });
});

describe('sealed backups (.bka)', () => {
  it('a backup of a protected file is sealed the same way, opens with the same key and restores as a new file without being decrypted', async () => {
    const prot = await protectionFor({ mary: 'pw-12345678' });
    const src = makeSource('src-bka');
    const buf = format.buildBackupArchive({
      backupManifest: { app: 'bookkeeper-ai', formatVersion: 2, kind: 'full', companyName: COMPANY, createdAt: '2026-10-27T00:00:00Z', dbSchemaAt: 1 },
      entries: format.snapshotDir(src, { lazyPrefixes: [] }),
      protection: prot,
    });
    expect(buf.includes(Buffer.from(CUSTOMER))).toBe(false);
    const head = format.readArchiveHead(buf);
    expect(head.name).toBe('bookkeeper-manifest.json');
    expect(format.isSealedManifest(head.manifest)).toBe(true);
    // In memory (the app server's restore): every entry verified and decrypted.
    const opened = format.unsealArchiveSync(buf, prot.fileKey);
    expect(opened.entries.find((e: { name: string }) => e.name === 'PG_VERSION').data.toString()).toBe('17\n');
    expect(() => format.unsealArchiveSync(buf, crypto.generateFileKey())).toThrow(/integrity/);

    // As a new company file: copied, never decrypted, and opens with the same password.
    const bka = path.join(root, 'sealed.bka');
    fs.writeFileSync(bka, buf);
    const target = path.join(root, 'Restored.ironbooks');
    await format.sealedBackupAsCompanyFile(bka, target, {
      manifest: { fileId: 'new-id', companyName: COMPANY, saveId: 'n1', previousSaveId: null, savedAt: 'now', appVersion: '1.7.0' },
    });
    const m = format.readCompanyManifest(target);
    expect(m.fileId).toBe('new-id');
    expect(m.dbSchema).toEqual({ migrations: 0, lastMigrationAt: 1 });
    const key = await crypto.unlockWith(m.encryption, { kind: 'password', login: 'mary', secret: 'pw-12345678' });
    const out = path.join(root, 'restored-out');
    await format.extractCompanyFile(target, out, { fileKey: key });
    expect(fs.readFileSync(path.join(out, 'PG_VERSION'), 'utf8')).toBe('17\n');

    // Restored by the shell as a new file, with the key: the same files.
    const out2 = path.join(root, 'bka-out');
    await expect(format.extractBackupArchive(bka, out2)).rejects.toMatchObject({ code: 'SEALED' });
    await format.extractBackupArchive(bka, out2, { fileKey: prot.fileKey });
    expect(fs.existsSync(path.join(out2, 'base', '1', '1259'))).toBe(true);
  });

  it('a sealed company file is also a sealed full backup', async () => {
    const prot = await protectionFor({ mary: 'pw-12345678' });
    const file = await writeSealed('AsBackup', prot);
    const out = path.join(root, 'as-backup');
    const info = await format.extractBackupArchive(file, out, { fileKey: prot.fileKey });
    expect(info.companyName).toBe(COMPANY);
    expect(fs.readFileSync(path.join(out, 'PG_VERSION'), 'utf8')).toBe('17\n');
    const opened = format.unsealArchiveSync(fs.readFileSync(file), prot.fileKey);
    expect(opened.entries.some((e: { name: string }) => e.name === 'bookkeeper-manifest.json')).toBe(true);
  });
});

describe('a whole file under one password (portable .bkp, Accountant’s Copy .ibac)', () => {
  it('round-trips; a wrong password, a changed byte or a changed header never opens it', async () => {
    const plain = Buffer.from(`PK fake zip naming ${CUSTOMER} of ${COMPANY}`.repeat(50), 'utf8');
    const sealed = await crypto.sealWithPassword(plain, 'Portable-Pass-9', { kind: 'portable' });
    expect(crypto.isPasswordSealed(sealed)).toBe(true);
    expect(crypto.isPasswordSealed(plain)).toBe(false);
    expect(crypto.passwordEnvelopeInfo(sealed)).toEqual({ kind: 'portable' });
    expect(sealed.includes(Buffer.from(CUSTOMER))).toBe(false);
    expect((await crypto.openWithPassword(sealed, 'Portable-Pass-9'))?.equals(plain)).toBe(true);
    expect(await crypto.openWithPassword(sealed, 'portable-pass-9')).toBeNull();
    expect(await crypto.openWithPassword(sealed, '')).toBeNull();
    const body = Buffer.from(sealed);
    body[body.length - 40] ^= 1;
    expect(await crypto.openWithPassword(body, 'Portable-Pass-9')).toBeNull();
    const tag = Buffer.from(sealed);
    tag[tag.length - 1] ^= 1;
    expect(await crypto.openWithPassword(tag, 'Portable-Pass-9')).toBeNull();
    // The header (kind, cost, salt, nonce) is authenticated too.
    const header = Buffer.from(sealed.toString('latin1').replace('"kind":"portable"', '"kind":"portablx"'), 'latin1');
    expect(header.length).toBe(sealed.length);
    expect(await crypto.openWithPassword(header, 'Portable-Pass-9')).toBeNull();
  });
});
