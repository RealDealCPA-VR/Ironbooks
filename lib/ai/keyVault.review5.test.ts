/**
 * Review round 5 (security): AI provider keys travel with the company file.
 *
 * Keys used to be encrypted with this computer's .auth-secret, which electron/companyFileFormat.js
 * (and every backup / portable file) deliberately leaves out, so a company file opened on another
 * computer could never decrypt its own AI keys. They are now sealed with a per-file vault secret
 * stored inside the database ("v2:"), and old "v1:" keys are re-encrypted on the first open on a
 * computer that can still read them. Session signing keeps using the per-computer secret.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review5-keyvault');
const PC_A = path.join(ROOT, 'pc-a');
const PC_B = path.join(ROOT, 'pc-b');
delete process.env.BKA_AUTH_SECRET; // each "computer" uses the .auth-secret in its own folder
process.env.BKA_DATA_DIR = PC_A;

import { closeDb, getDb, type DB } from '@/lib/db';
import { aiSettings, users } from '@/lib/db/schema';
import { createCompany } from '@/lib/services/company';
import { fullAccess } from '@/lib/permissions/model';
import { buildProviders, getPublicSettings, loadSettings, updateSettings } from '@/lib/services/aiSettings';
import { createSessionToken, verifySessionToken } from '@/lib/auth';
import { dataDirSecret, encryptSecret, migrateLegacySecrets, readVaultSecret } from './keyVault';
import type { ProviderDeps } from './providers';

let companyId: string;
let userId: string;

const ctxFor = (db: DB) => ({ db, companyId, userId, access: fullAccess(), role: 'owner' as const });

/** The API key the Anthropic SDK would be built with for the company's provider. */
async function liveKey(db: DB): Promise<string | null> {
  let seen: string | null = null;
  const deps: ProviderDeps = {
    anthropicFactory: (cfg) => {
      seen = cfg.apiKey;
      return { messages: { create: async () => ({ content: [] }) }, models: { list: async () => ({ data: [] }) } };
    },
  };
  const s = await loadSettings(ctxFor(db));
  buildProviders(s.providers, ctxFor(db), deps);
  return seen;
}

/** Copy a closed company folder the way a company file travels: without .auth-secret. */
function copyFileWithoutLocalSecret(from: string, to: string) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, filter: (src) => path.basename(src) !== '.auth-secret' });
}

describe('review5: AI keys travel with the company file', () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    process.env.BKA_DATA_DIR = PC_A;
    const db = await getDb(PC_A);
    const [u] = await db.insert(users).values({ email: 'kv-owner@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    userId = u.id;
    companyId = (await createCompany(db, { name: 'Vault Co', ownerId: userId })).id;
  });

  afterAll(async () => {
    await closeDb(PC_A);
    await closeDb(PC_B);
    process.env.BKA_DATA_DIR = PC_A;
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('a key saved on one computer still works when the file is opened on another', async () => {
    process.env.BKA_DATA_DIR = PC_A;
    const dbA = await getDb(PC_A);
    await updateSettings(ctxFor(dbA), {
      providers: [{ kind: 'anthropic', label: 'Claude', model: '', enabled: true, apiKey: 'sk-ant-travels-1' }],
    });
    expect(await liveKey(dbA)).toBe('sk-ant-travels-1');
    const [row] = await dbA.select().from(aiSettings).where(eq(aiSettings.companyId, companyId));
    const blob = (row.providers[0] as { apiKeyEnc: string }).apiKeyEnc;
    expect(blob).not.toContain('sk-ant');
    await closeDb(PC_A);

    // The office file server / accountant's computer: same file, a different .auth-secret.
    copyFileWithoutLocalSecret(PC_A, PC_B);
    process.env.BKA_DATA_DIR = PC_B;
    const dbB = await getDb(PC_B);
    const view = await getPublicSettings(ctxFor(dbB));
    expect(view.providers[0].apiKeyUnreadable).toBeUndefined();
    expect(view.providers[0].hasApiKey).toBe(true);
    expect(await liveKey(dbB)).toBe('sk-ant-travels-1');
    await closeDb(PC_B);
  });

  it('session signing still uses the per-computer secret (a copied file cannot mint sessions elsewhere)', async () => {
    process.env.BKA_DATA_DIR = PC_A;
    const dbA = await getDb(PC_A);
    const tokenA = createSessionToken(userId);
    expect(verifySessionToken(tokenA)).not.toBeNull();
    const vault = await readVaultSecret(dbA);
    expect(vault).toBeTruthy();
    expect(vault).not.toBe(dataDirSecret(PC_A));
    await closeDb(PC_A);
    copyFileWithoutLocalSecret(PC_A, PC_B);
    process.env.BKA_DATA_DIR = PC_B;
    await getDb(PC_B);
    expect(dataDirSecret(PC_B)).not.toBe(dataDirSecret(PC_A));
    expect(verifySessionToken(tokenA)).toBeNull();
    await closeDb(PC_B);
  });

  it('old per-computer keys are re-encrypted when the file is opened on the computer that saved them', async () => {
    process.env.BKA_DATA_DIR = PC_A;
    let dbA = await getDb(PC_A);
    // A key as an older version stored it: encrypted with PC A's .auth-secret.
    const legacy = encryptSecret('sk-ant-legacy-2', companyId, dataDirSecret(PC_A));
    const [row] = await dbA.select().from(aiSettings).where(eq(aiSettings.companyId, companyId));
    const providers = (row.providers as Record<string, unknown>[]).map((p) => ({ ...p, apiKeyEnc: legacy }));
    await dbA.update(aiSettings).set({ providers }).where(eq(aiSettings.id, row.id));
    await closeDb(PC_A);

    // Opening the file on PC A moves the key to the file's own key…
    dbA = await getDb(PC_A);
    const [after] = await dbA.select().from(aiSettings).where(eq(aiSettings.companyId, companyId));
    expect((after.providers[0] as { apiKeyEnc: string }).apiKeyEnc.startsWith('v2:')).toBe(true);
    expect(await liveKey(dbA)).toBe('sk-ant-legacy-2');
    await closeDb(PC_A);

    // …so it keeps working on PC B.
    copyFileWithoutLocalSecret(PC_A, PC_B);
    process.env.BKA_DATA_DIR = PC_B;
    const dbB = await getDb(PC_B);
    expect(await liveKey(dbB)).toBe('sk-ant-legacy-2');
    await closeDb(PC_B);
  });

  it('a legacy key the computer cannot read is left alone and reported as needing re-entry', async () => {
    process.env.BKA_DATA_DIR = PC_B;
    const dbB = await getDb(PC_B);
    const foreign = encryptSecret('sk-ant-foreign-3', companyId, 'some-other-computer-secret');
    const [row] = await dbB.select().from(aiSettings).where(eq(aiSettings.companyId, companyId));
    const providers = (row.providers as Record<string, unknown>[]).map((p) => ({ ...p, apiKeyEnc: foreign }));
    await dbB.update(aiSettings).set({ providers }).where(eq(aiSettings.id, row.id));
    expect(await migrateLegacySecrets(dbB, { dataDir: PC_B })).toBe(0);
    const view = await getPublicSettings(ctxFor(dbB));
    expect(view.providers[0].apiKeyUnreadable).toBe(true);
    expect(view.providers[0].hasApiKey).toBe(false);
    const [still] = await dbB.select().from(aiSettings).where(eq(aiSettings.companyId, companyId));
    expect((still.providers[0] as { apiKeyEnc: string }).apiKeyEnc).toBe(foreign);
    await closeDb(PC_B);
  });
});
