/**
 * Review round 5 — Condense Data's archive copy for a SINGLE company file.
 *
 * A single company file ("Acme.ironbooks" on the office file server) runs on a private working
 * copy in each computer's local app data. The archive copy Condense Data writes first — the only
 * way back to the condensed detail — went next to that hidden working copy, and was found again
 * only by that computer-specific path: invisible to the person, missing on every other computer
 * that opens the file, and lost with this computer. Like QuickBooks' "Archive Copy" next to the
 * .QBW, it now goes next to the company file and is found by the file's own identity.
 *
 * Archive copies v1.6.0 already wrote beside the working copy must not vanish from the list (nor
 * be refused as "not found") after the update: they are the only way back from those condenses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, type DB } from '@/lib/db';
import { companies } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { condenseArchiveDir, condensePeriod, listCondenseArchives, restoreCondenseArchive } from './condense';
import { seedRichCompany } from './companyFile.fixture';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-condense-r5');
const SHARE = path.join(ROOT, 'share');
const FILE = path.join(SHARE, 'Acme.ironbooks');
const PC_A = path.join(ROOT, 'pc-a', 'Working', 'acme-aaaaaaaaaaaa');
const PC_B = path.join(ROOT, 'pc-b', 'Working', 'acme-bbbbbbbbbbbb');

let db: DB;
let ctx: ServiceContext;
const saved: Record<string, string | undefined> = {};

function openedOn(workDir: string) {
  process.env.BKA_COMPANY_FILE = FILE;
  process.env.BKA_COMPANY_STATE = path.join(workDir, 'state.json');
}

beforeAll(async () => {
  for (const k of ['BKA_COMPANY_FILE', 'BKA_COMPANY_STATE']) saved[k] = process.env[k];
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(SHARE, { recursive: true });
  openedOn(PC_A);
  db = await getDb(path.join(PC_A, 'data'));
  ({ ctx } = await seedRichCompany(db, path.join(PC_A, 'data'), 'Acme'));
  await db.update(companies).set({ settings: { closingDate: '2025-01-31' } }).where(eq(companies.id, ctx.companyId));
}, 180_000);

afterAll(async () => {
  await closeDb(path.join(PC_A, 'data')).catch(() => undefined);
  await closeDb(path.join(PC_B, 'data')).catch(() => undefined);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('condensing a single company file', () => {
  it('writes the archive copy next to the company file, where every computer that opens it finds it', async () => {
    const dataA = path.join(PC_A, 'data');
    const result = await condensePeriod(ctx, { beforeDate: new Date('2025-02-01T00:00:00Z'), dataDir: dataA });
    expect(path.dirname(result.archivePath!)).toBe(path.join(SHARE, 'archives'));
    expect(fs.existsSync(result.archivePath!)).toBe(true);
    expect(condenseArchiveDir(dataA)).toBe(path.join(SHARE, 'archives'));
    expect(listCondenseArchives(dataA).map((a) => a.id)).toEqual([result.runId]);

    // The same company file opened on another computer (its own working copy, another path).
    await closeDb(dataA);
    fs.cpSync(dataA, path.join(PC_B, 'data'), { recursive: true });
    openedOn(PC_B);
    const dataB = path.join(PC_B, 'data');
    const there = listCondenseArchives(dataB);
    expect(there).toHaveLength(1);
    expect(there[0]).toMatchObject({ id: result.runId, available: true });

    const dbB = await getDb(dataB);
    const res = await restoreCondenseArchive({ ...ctx, db: dbB }, result.runId!, dataB);
    expect(res.restored).toBe(true);
  }, 240_000);

  it('archive copies made by v1.6.0 (beside the working copy) are still listed and can be restored', async () => {
    // v1.6.0 wrote a single company file's archive copy and its index into <working copy>/archives.
    openedOn(PC_B);
    const dataB = path.join(PC_B, 'data');
    const current = listCondenseArchives(dataB);
    expect(current).toHaveLength(1);
    const legacyDir = path.join(PC_B, 'archives');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyFile = path.join(legacyDir, 'condense-archive-acme-2025-06-30.bka');
    fs.copyFileSync(current[0].path, legacyFile);
    const legacyEntry = {
      id: 'legacy-run-1',
      path: legacyFile,
      filename: path.basename(legacyFile),
      createdAt: '2025-07-01T10:00:00.000Z',
      dataDir: dataB,
      companyId: ctx.companyId,
      companyName: 'Acme',
      beforeDate: '2025-01-01',
      entriesCondensed: 3,
      sizeBytes: fs.statSync(legacyFile).size,
    };
    const otherFiles = { ...legacyEntry, id: 'someone-elses', dataDir: path.join(ROOT, 'pc-b', 'Working', 'other-cccccccccccc', 'data') };
    // The same run recorded in both places is listed once.
    const both = { ...current[0], available: undefined };
    fs.writeFileSync(path.join(legacyDir, 'condense-archives.json'), JSON.stringify([legacyEntry, otherFiles, both], null, 2));

    const listed = listCondenseArchives(dataB);
    expect(listed.map((a) => a.id).sort()).toEqual([current[0].id, 'legacy-run-1'].sort());
    expect(listed.find((a) => a.id === 'legacy-run-1')).toMatchObject({ available: true, path: legacyFile });

    const dbB = await getDb(dataB);
    const res = await restoreCondenseArchive({ ...ctx, db: dbB }, 'legacy-run-1', dataB);
    expect(res.restored).toBe(true);
    await expect(restoreCondenseArchive({ ...ctx, db: dbB }, 'someone-elses', dataB)).rejects.toThrow(/not found/i);
  }, 240_000);

  it('a company folder (older format) keeps its archive copies beside the folder, as before', () => {
    delete process.env.BKA_COMPANY_FILE;
    delete process.env.BKA_COMPANY_STATE;
    const folder = path.join(ROOT, 'companies', 'Old Co.ironbooks');
    expect(condenseArchiveDir(folder)).toBe(path.join(ROOT, 'companies', 'archives'));
  });
});
