/**
 * Security 1.4 — a protected company file listing hundreds of key slots (electron/fileCrypto.js).
 *
 * Signing in tried every slot carrying the user's lookup tag, and each try is a scrypt run of up
 * to half a GiB and seconds (the manifest names the cost, up to N=2^18, r=16, p=4). A real file
 * has one password slot and at most one challenge slot per user, and one recovery slot, so at most
 * MAX_SLOT_TRIES slots are tried per kind and user name, and a manifest's list is read no further
 * than MAX_SLOTS. The slot format and its cost are unchanged: a real file opens as before.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fileCrypto from '@/electron/fileCrypto';

const require = createRequire(import.meta.url);
const nodeCrypto = require('node:crypto') as typeof import('node:crypto');

beforeAll(() => {
  // The cheap test cost (N=1024): the same code paths, milliseconds per slot.
  process.env.BKA_TEST_FAST_KDF = '1';
});
afterEach(() => vi.restoreAllMocks());

async function block(opts: { decoys: number; realFirst?: boolean }) {
  const fileKey = fileCrypto.generateFileKey();
  const lookupSalt = fileCrypto.newLookupSalt();
  const tag = fileCrypto.lookupTag(lookupSalt, 'owner@example.com');
  const real = await fileCrypto.makeSlot({ kind: 'password', secret: 'right password', fileKey, tag });
  const decoy = await fileCrypto.makeSlot({ kind: 'password', secret: 'something else', fileKey: fileCrypto.generateFileKey(), tag });
  const decoys = Array.from({ length: opts.decoys }, () => ({ ...decoy }));
  const recovery = await fileCrypto.makeSlot({ kind: 'recovery', secret: 'RECOVERYKEY', fileKey });
  const challenge = await fileCrypto.makeSlot({ kind: 'challenge', secret: 'rex the dog', fileKey, tag, question: 'First pet?' });
  return {
    fileKey,
    encryption: {
      sealId: 'test',
      keyCheck: fileCrypto.keyCheckOf(fileKey),
      lookupSalt,
      slots: opts.realFirst === false ? [...decoys, real, challenge, recovery] : [real, challenge, recovery, ...decoys],
    },
  };
}

describe('key slots tried at sign-in are capped', () => {
  it('a manifest with 50 slots under one user name costs at most MAX_SLOT_TRIES derivations', async () => {
    const { encryption } = await block({ decoys: 50 });
    const scrypt = vi.spyOn(nodeCrypto, 'scrypt');
    const key = await fileCrypto.unlockWith(encryption, { kind: 'password', login: 'owner@example.com', secret: 'a wrong guess' });
    expect(key).toBeNull();
    expect(scrypt.mock.calls.length).toBeLessThanOrEqual(4);
    expect(fileCrypto.MAX_SLOT_TRIES).toBe(4);
  });

  it('a real file (one slot of each kind) opens exactly as before, with password, answer or recovery key', async () => {
    const { encryption, fileKey } = await block({ decoys: 0 });
    const scrypt = vi.spyOn(nodeCrypto, 'scrypt');
    expect((await fileCrypto.unlockWith(encryption, { kind: 'password', login: 'Owner@Example.com', secret: 'right password' }))?.equals(fileKey)).toBe(true);
    expect((await fileCrypto.unlockWith(encryption, { kind: 'challenge', login: 'owner@example.com', secret: 'rex the dog' }))?.equals(fileKey)).toBe(true);
    expect((await fileCrypto.unlockWith(encryption, { kind: 'recovery', secret: 'RECOVERYKEY' }))?.equals(fileKey)).toBe(true);
    expect(await fileCrypto.unlockWith(encryption, { kind: 'password', login: 'owner@example.com', secret: 'wrong' })).toBeNull();
    // An unknown user name still costs one derivation (no way to tell which names exist).
    scrypt.mockClear();
    expect(await fileCrypto.unlockWith(encryption, { kind: 'password', login: 'nobody@example.com', secret: 'x' })).toBeNull();
    expect(scrypt.mock.calls.length).toBe(1);
  });

  it('the real slot is still found among a few extra slots of the same user', async () => {
    const { encryption, fileKey } = await block({ decoys: fileCrypto.MAX_SLOT_TRIES - 1, realFirst: false });
    expect((await fileCrypto.unlockWith(encryption, { kind: 'password', login: 'owner@example.com', secret: 'right password' }))?.equals(fileKey)).toBe(true);
  });

  it('a manifest slot list is read no further than MAX_SLOTS entries', async () => {
    const { encryption } = await block({ decoys: 0 });
    const filler = { kind: 'password', tag: 'someone-else' };
    const huge = { ...encryption, slots: [...Array.from({ length: fileCrypto.MAX_SLOTS }, () => filler), ...encryption.slots] };
    expect(fileCrypto.findSlots(huge, 'recovery')).toEqual([]);
    expect(fileCrypto.findSlots(encryption, 'recovery')).toHaveLength(1);
  });
});
