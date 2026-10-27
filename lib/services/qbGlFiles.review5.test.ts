/**
 * Review round 5 — damaged Excel workbooks (lib/services/qbGlFiles.ts readXlsx).
 *
 * A workbook part that inflates past the size its zip directory declares (a zip bomb that lies
 * about its size — adm-zip stops it at the declared size), a corrupted part (bad CRC, broken
 * deflate data) made adm-zip / zlib throw a plain Error out of readXlsx: the General Ledger,
 * open-items and bank statement imports answered HTTP 500 instead of saying the file is damaged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { companies, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { readXlsx } from './qbGlFiles';
import { previewGlImport } from './qbGlImport';
import { previewOpenItems } from './openItemsImport';
import { glXlsx, upload, SAMPLE_GL } from '@/test/fixtures/qbGlFixtures';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-qbglfiles-review5');
let db: DB;
let ctx: ServiceContext;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'glfiles-r5@test.local', name: 'R5', passwordHash: 'x' }).returning();
  const [company] = await db.insert(companies).values({ name: 'Damaged Xlsx Co', ownerId: user.id }).returning();
  ctx = { db, companyId: company.id, userId: user.id };
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold a handle; the next run wipes the dir first. */
  }
});

/** Rewrite the declared uncompressed size of one zip entry (local + central headers). */
function declareSize(zipBytes: Buffer, entryName: string, size: number): Buffer {
  const out = Buffer.from(zipBytes);
  const name = Buffer.from(entryName, 'utf8');
  for (let i = 0; i < out.length - 46; i++) {
    const sig = out.readUInt32LE(i);
    if (sig === 0x04034b50) {
      const n = out.readUInt16LE(i + 26);
      if (out.subarray(i + 30, i + 30 + n).equals(name)) out.writeUInt32LE(size, i + 22);
    } else if (sig === 0x02014b50) {
      const n = out.readUInt16LE(i + 28);
      if (out.subarray(i + 46, i + 46 + n).equals(name)) out.writeUInt32LE(size, i + 24);
    }
  }
  return out;
}

/** Flip bytes in the middle of one entry's compressed data. */
function corrupt(zipBytes: Buffer, entryName: string): Buffer {
  const out = Buffer.from(zipBytes);
  const name = Buffer.from(entryName, 'utf8');
  for (let i = 0; i < out.length - 30; i++) {
    if (out.readUInt32LE(i) !== 0x04034b50) continue;
    const n = out.readUInt16LE(i + 26);
    const extra = out.readUInt16LE(i + 28);
    if (!out.subarray(i + 30, i + 30 + n).equals(name)) continue;
    const start = i + 30 + n + extra;
    const csize = out.readUInt32LE(i + 18);
    for (let k = Math.floor(csize / 3); k < Math.floor(csize / 3) + 8 && k < csize; k++) out[start + k] ^= 0xff;
  }
  return out;
}

describe('a damaged .xlsx is a plain 400, never a 500', () => {
  it('a part that inflates past its declared size, or with corrupted data, is refused as damaged', async () => {
    const good = glXlsx(SAMPLE_GL);
    for (const bad of [declareSize(good, 'xl/worksheets/sheet2.xml', 64), corrupt(good, 'xl/worksheets/sheet2.xml')]) {
      expect(() => readXlsx(bad)).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
      await expect(previewGlImport(ctx, { file: upload('gl.xlsx', bad) })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(previewOpenItems(ctx, { file: { name: 'open.xlsx', data: bad.toString('base64') } })).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    // The intact workbook still reads.
    expect(readXlsx(good).length).toBe(2);
  });
});
