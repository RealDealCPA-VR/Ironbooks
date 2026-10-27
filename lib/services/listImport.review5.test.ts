/**
 * Review round 5 — QuickBooks list import file reading (app/qb-import/ListImport.tsx).
 *
 * QuickBooks Desktop writes IIF (and CSV) exports in the Windows code page, not UTF-8. The list
 * import read a picked file with FileReader.readAsText (UTF-8), so "Société Générale" arrived as
 * "Soci�t� G�n�rale": the customer was created with a corrupted name that no
 * later import (the General Ledger import decodes the same bytes correctly) ever matched again.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, customers, users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { importIIF } from './qbImport';
import { readImportText } from '@/app/qb-import/ListImport';
import { decodeText } from '@/lib/textDecode';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-listimport-review5');
let db: DB;
let userId: string;

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'listimport-r5@test.local', name: 'R5', passwordHash: 'x' }).returning();
  userId = user.id;
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold a handle; the next run wipes the dir first. */
  }
});

/** An IIF file as QuickBooks Desktop writes it: Windows-1252 bytes ("é" = 0xE9, "·" = 0xB7). */
const ANSI_IIF = Buffer.from(
  [
    '!ACCNT\tNAME\tACCNTTYPE\tACCNUM',
    'ACCNT\tCaisse Populaire · Opérations\tBANK\t10100',
    '!CUST\tNAME',
    'CUST\tSociété Générale',
    '!VEND\tNAME',
    'VEND\tBäckerei Müller',
    '',
  ].join('\r\n'),
  'latin1',
);

describe('IIF files saved by QuickBooks (Windows-1252) keep their accented names', () => {
  it('the picked file is decoded as QuickBooks wrote it', async () => {
    const text = await readImportText(new Blob([ANSI_IIF]));
    expect(text).toContain('CUST\tSociété Générale');
    expect(text).not.toContain('�');
    // UTF-8 files (and UTF-8 with a BOM, UTF-16 "Unicode Text") still read as they are.
    expect(await readImportText(new Blob([Buffer.from('CUST\tSociété', 'utf8')]))).toBe('CUST\tSociété');
    expect(await readImportText(new Blob([Buffer.from('﻿CUST\tSociété', 'utf8')]))).toBe('CUST\tSociété');
    expect(decodeText(new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('CUST\tSociété', 'utf16le')])))).toBe('CUST\tSociété');
  });

  it('the import creates the names exactly as they are in QuickBooks', async () => {
    const co = await createCompany(db, { name: 'ANSI Co', ownerId: userId });
    const ctx: ServiceContext = { db, companyId: co.id, userId };
    await importIIF(ctx, await readImportText(new Blob([ANSI_IIF])));
    const custNames = (await db.select().from(customers).where(eq(customers.companyId, ctx.companyId))).map((c) => c.displayName);
    expect(custNames).toContain('Société Générale');
    const vendNames = (await db.select().from(vendors).where(eq(vendors.companyId, ctx.companyId))).map((v) => v.displayName);
    expect(vendNames).toEqual(['Bäckerei Müller']);
    const acct = (await db.select().from(accounts).where(eq(accounts.companyId, ctx.companyId))).find((a) => a.code === '10100');
    expect(acct?.name).toBe('Caisse Populaire · Opérations');
  });
});
