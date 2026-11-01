/**
 * prefsperms (review 5 leftover, approved P2): every Accountant's Copy transfer file (.ibac, built
 * from the Portable Company File engine, which dumps every table) carried data/file_secrets.jsonl
 * — the company file's plaintext vault secret — next to the sealed AI provider keys (and, with
 * Send Forms, the sealed mail server password). Whoever held the transfer file, such as the
 * external accountant, could recover the client's paid API keys offline with the HKDF / AES-GCM
 * steps in lib/ai/keyVault.ts, although the External Accountant role cannot even open AI settings.
 *
 * Files handed to someone OUTSIDE the company — the Accountant's Copy and the Period Copy — now
 * leave the file's secrets out: the sealed values in them can't be opened anywhere. The owner's
 * own Portable Company File (.bkp, Admin only, with every user and password hash) keeps them, so
 * a restore on a new computer keeps its AI keys and mail settings working.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { eq } from 'drizzle-orm';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-prefsperms-acctsecrets');
const CLIENT_DIR = path.join(ROOT, 'client');
const ACCT_DIR = path.join(ROOT, 'accountant');
process.env.BKA_DATA_DIR = CLIENT_DIR;

import { closeDb, getDb, type DB } from '@/lib/db';
import { aiSettings, fileSecrets, users } from '@/lib/db/schema';
import { decryptSecret, readVaultSecret, sealForFile } from '@/lib/ai/keyVault';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createPortableCompanyFile } from '../portableFile';
import { createPeriodCopy } from '../periodCopy';
import { createAccountantCopy } from './client';
import { openAccountantCopyFile } from './accountant';

let db: DB;
let ctx: ServiceContext;
let blob: string;
const API_KEY = 'sk-ant-client-paid-key-0123456789';

function tableRows(buffer: Buffer, table: string): string[] {
  const entry = new AdmZip(buffer).getEntry(`data/${table}.jsonl`);
  const text = entry ? entry.getData().toString('utf8') : '';
  return text ? text.split('\n').filter(Boolean) : [];
}

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  db = await getDb(CLIENT_DIR);
  const [user] = await db.insert(users).values({ email: 'owner-secrets@test.local', name: 'Client Owner', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Secrets Client Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  blob = await sealForFile(db, API_KEY, company.id);
  await db.insert(aiSettings).values({ companyId: company.id, providers: [{ id: 'p1', kind: 'anthropic', apiKeyEnc: blob }] });
});

afterAll(async () => {
  await closeDb(CLIENT_DIR);
  await closeDb(ACCT_DIR).catch(() => undefined);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('files for outsiders leave the company file secrets out', () => {
  it("the Accountant's Copy has no vault secret, and the accountant's file cannot open the client's key", async () => {
    const secret = await readVaultSecret(db);
    expect(secret).toBeTruthy();
    const transfer = await createAccountantCopy(ctx, { dividingDate: '2026-03-31', dataDir: CLIENT_DIR });
    expect(tableRows(transfer.buffer, 'file_secrets')).toEqual([]);
    expect(transfer.buffer.includes(Buffer.from(secret!))).toBe(false);

    const opened = await openAccountantCopyFile(transfer.buffer, ACCT_DIR);
    const adb = await getDb(opened.dataDir ?? ACCT_DIR);
    const rows = await adb.select().from(fileSecrets);
    expect(rows).toEqual([]);
    const [ai] = await adb.select().from(aiSettings).where(eq(aiSettings.companyId, ctx.companyId));
    const stored = (ai.providers as Array<{ apiKeyEnc?: string }>)[0].apiKeyEnc;
    // Nothing in the accountant's file opens it (a new vault secret there is a different key).
    expect(decryptSecret(stored, ctx.companyId, (await readVaultSecret(adb)) ?? 'none')).toBeNull();
  });

  it('the Period Copy (for an auditor or lender) leaves them out too', async () => {
    const copy = await createPeriodCopy(ctx, { from: '2026-01-01', to: '2026-03-31', dataDir: CLIENT_DIR });
    expect(tableRows(copy.buffer, 'file_secrets')).toEqual([]);
  });

  it("the owner's own Portable Company File keeps them (a restore keeps its AI keys working)", async () => {
    const own = await createPortableCompanyFile(ctx, { dataDir: CLIENT_DIR });
    expect(tableRows(own.buffer, 'file_secrets')).toHaveLength(1);
  });
});
