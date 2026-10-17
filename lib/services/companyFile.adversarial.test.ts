/**
 * Adversarial QA for the company-file package (portable .bkp, shareable ledger, condense archive),
 * written independently of the implementation's own tests:
 *
 *  Portable file
 *   - only owner/admin may create one (accountant/viewer refused);
 *   - garbage / truncated input is refused as VALIDATION and leaves nothing on disk;
 *   - a crafted file cannot write outside the new company dir (path traversal) and cannot plant
 *     files the format never carries (e.g. the session-signing secret .auth-secret);
 *   - a manifest naming a column this app does not have is refused and cleaned up;
 *   - .bkp → restore → .bkp → restore is lossless (idempotent), incl. hostile strings;
 *   - the restored copy is a working company file: new postings get the next entry number and
 *     chain onto the restored transaction log.
 *  Shareable ledger
 *   - only the active company's data is exported (another company in the same file is not);
 *   - GL running balances are internally consistent and tie to the trial balance;
 *   - identifier-like text (an EIN with a leading zero) is not mangled into a number.
 *  Condense
 *   - if the archive copy cannot be written, nothing is condensed;
 *   - P&L for the condensed month and the balance sheet at month end are unchanged;
 *   - archive restore is owner/admin only, refuses a missing archive file, and after restoring
 *     the company file keeps working with an intact log.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { eq, sql } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { companies, journalEntries, journalEntryLines, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { postJournalEntry } from './posting';
import {
  computeLedgerChecksums,
  computeTableDigests,
  createPortableCompanyFile,
  restorePortableCompanyFile,
  PORTABLE_CHECKSUMS_ENTRY,
  PORTABLE_MANIFEST_ENTRY,
  type PortableManifest,
} from './portableFile';
import { buildShareableLedgerXlsx } from './shareableLedger';
import { condensePeriod, listCondenseArchives, restoreCondenseArchive } from './condense';
import { readAllTransactionLog, verifyTransactionLog } from './transactionLog';
import { balanceSheet, profitAndLoss, trialBalance } from './reports';
import { Money } from '@/lib/money';
import { seedRichCompany, type RichCompany } from './companyFile.fixture';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-companyfile-adversarial');
const SRC = path.join(ROOT, 'source');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Rewrite a .bkp with edits applied and the checksum list re-sealed (an attacker can do this). */
function reseal(buffer: Buffer, edit: (files: Map<string, Buffer>, m: PortableManifest) => void): Buffer {
  const src = new AdmZip(buffer);
  const files = new Map<string, Buffer>();
  for (const e of src.getEntries()) files.set(e.entryName, e.getData());
  const manifest = JSON.parse(files.get(PORTABLE_MANIFEST_ENTRY)!.toString('utf8')) as PortableManifest;
  edit(files, manifest);
  files.set(PORTABLE_MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest)));
  const lines = [...files.entries()]
    .filter(([n]) => n !== PORTABLE_CHECKSUMS_ENTRY)
    .map(([n, d]) => `${sha(d)}  ${n}`);
  files.set(PORTABLE_CHECKSUMS_ENTRY, Buffer.from(lines.join('\n') + '\n'));
  const out = new AdmZip();
  for (const [n, d] of files) out.addFile(n, d);
  return out.toBuffer();
}

/** Minimal worksheet reader: rows of { columnLetter: text }. */
function readSheet(xml: string): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  for (const m of xml.matchAll(/<row r="\d+">([\s\S]*?)<\/row>/g)) {
    const row: Record<string, string> = {};
    for (const c of m[1].matchAll(/<c r="([A-Z]+)\d+"[^>]*>(?:<v>([^<]*)<\/v>|<is><t[^>]*>([^<]*)<\/t><\/is>)<\/c>/g)) {
      row[c[1]] = c[2] ?? c[3] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

let db: DB;
let rich: RichCompany;
let good: Buffer;
const NASTY = 'Ünï "quoted" \\ back\nslash\ttab \u{1F4B8} 9999999999999.99';

describe('portable company file — adversarial', () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(SRC);
    rich = await seedRichCompany(db, SRC, 'Adversarial Co');
    await createCustomer(rich.ctx, { displayName: NASTY });
    // Largest-magnitude + smallest amounts survive (numeric text, never JS floats).
    await postJournalEntry(rich.ctx, {
      date: new Date('2025-02-03'),
      description: NASTY,
      lines: [
        { accountId: rich.acct['1000'], debit: '9999999999.99' },
        { accountId: rich.acct['3000'], credit: '9999999999.98' },
        { accountId: rich.acct['3000'], credit: '0.01' },
      ],
    });
    // A second company in the SAME company file, with data that must not leak into A's ledger export.
    const [other] = await db
      .insert(users)
      .values({ email: 'other@adv.test', name: 'Other Owner', passwordHash: 'other-hash' })
      .returning();
    const otherCo = await createCompany(db, { name: 'Other Co', ownerId: other.id });
    await createCustomer({ db, companyId: otherCo.id, userId: other.id }, { displayName: 'SECRET-OTHER-CUSTOMER' });
    // Identifier with a leading zero in company preferences.
    const [co] = await db.select().from(companies).where(eq(companies.id, rich.ctx.companyId));
    await db
      .update(companies)
      .set({ settings: { ...((co.settings ?? {}) as Record<string, unknown>), ein: '012345678' } })
      .where(eq(companies.id, rich.ctx.companyId));
    good = (await createPortableCompanyFile(rich.ctx, { dataDir: SRC })).buffer;
  }, 240_000);

  afterAll(async () => {
    for (const d of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : []) await closeDb(path.join(ROOT, d)).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('only the owner or an admin can create a portable file', async () => {
    for (const role of ['accountant', 'viewer'] as const) {
      await expect(createPortableCompanyFile({ ...rich.ctx, role }, { dataDir: SRC })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
    const asAdmin = await createPortableCompanyFile({ ...rich.ctx, role: 'admin' }, { dataDir: SRC });
    expect(asAdmin.manifest.companyName).toBe('Adversarial Co');
  });

  it('garbage and truncated input is refused as VALIDATION and leaves nothing on disk', async () => {
    const target = path.join(ROOT, 'garbage');
    for (const bad of [
      Buffer.from('definitely not a zip'),
      Buffer.alloc(0),
      good.subarray(0, Math.floor(good.length / 2)),
      good.subarray(0, good.length - 10),
    ]) {
      await expect(restorePortableCompanyFile(bad, target)).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(fs.existsSync(target)).toBe(false);
    }
  });

  it('a crafted file cannot write outside the new company folder (path traversal)', async () => {
    const target = path.join(ROOT, 'traversal');
    const escapee = path.join(ROOT, 'escaped.txt');
    const leftBehind: string[] = [];
    for (const rel of ['attachments/../../escaped.txt', '../escaped.txt', 'attachments\\..\\..\\escaped.txt']) {
      const bad = reseal(good, (files, m) => {
        const bytes = Buffer.from('pwned');
        files.set(`files/${rel}`, bytes);
        m.files[rel] = { bytes: bytes.length, sha256: sha(bytes) };
      });
      await expect(restorePortableCompanyFile(bad, target)).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(fs.existsSync(escapee)).toBe(false);
      // "Any mismatch removes the new directory" — a refused restore must not leave a
      // half-restored company file (with an open database handle) behind.
      if (fs.existsSync(target)) {
        leftBehind.push(rel);
        await closeDb(target).catch(() => undefined);
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
    expect(leftBehind).toEqual([]);
  });

  it('a crafted file cannot plant a session-signing secret (.auth-secret) in the restored company file', async () => {
    const target = path.join(ROOT, 'planted-secret');
    const bad = reseal(good, (files, m) => {
      const bytes = Buffer.from('attacker-known-secret');
      files.set('files/.auth-secret', bytes);
      m.files['.auth-secret'] = { bytes: bytes.length, sha256: sha(bytes) };
    });
    let restored = false;
    try {
      await restorePortableCompanyFile(bad, target);
      restored = true;
    } catch (err) {
      expect(err).toMatchObject({ code: 'VALIDATION' });
    }
    // Either refused outright, or the planted secret was not written. A known secret would let
    // whoever crafted the file forge sign-in sessions for the restored company file.
    const secretFile = path.join(target, '.auth-secret');
    const planted = fs.existsSync(secretFile) && fs.readFileSync(secretFile, 'utf8') === 'attacker-known-secret';
    expect({ restored, planted }).toMatchObject({ planted: false });
    await closeDb(target).catch(() => undefined);
  });

  it('a manifest naming a column this app does not have is refused and cleaned up', async () => {
    const target = path.join(ROOT, 'bad-column');
    const bad = reseal(good, (_files, m) => {
      m.tables.customers.columns = [...m.tables.customers.columns, 'not_a_real_column'];
    });
    await expect(restorePortableCompanyFile(bad, target)).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/not_a_real_column/),
    });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('.bkp → restore → .bkp → restore is lossless (hostile strings, extreme amounts)', async () => {
    const digests = await computeTableDigests(db);
    const ledger = await computeLedgerChecksums(db);
    const a = path.join(ROOT, 'copy-a');
    const b = path.join(ROOT, 'copy-b');
    await restorePortableCompanyFile(good, a);
    const dbA = await getDb(a);
    expect(await computeTableDigests(dbA)).toEqual(digests);
    const second = await createPortableCompanyFile({ ...rich.ctx, db: dbA }, { dataDir: a });
    expect(second.manifest.tables).toEqual(
      (JSON.parse(new AdmZip(good).readAsText(PORTABLE_MANIFEST_ENTRY)) as PortableManifest).tables,
    );
    await restorePortableCompanyFile(second.buffer, b);
    const dbB = await getDb(b);
    expect(await computeTableDigests(dbB)).toEqual(digests);
    expect(await computeLedgerChecksums(dbB)).toEqual(ledger);
    const [nasty] = await dbB.select().from(journalEntries).where(eq(journalEntries.description, NASTY));
    expect(nasty).toBeTruthy();
    const amounts = await dbB
      .select({ debit: journalEntryLines.debit, credit: journalEntryLines.credit })
      .from(journalEntryLines)
      .where(eq(journalEntryLines.journalEntryId, nasty.id));
    expect(amounts.map((x) => x.debit ?? x.credit).sort()).toEqual(['0.01', '9999999999.98', '9999999999.99'].sort());
  }, 240_000);

  it('the restored copy is a working company file (next entry number, log chain continues)', async () => {
    const dir = path.join(ROOT, 'copy-a');
    const dbA = await getDb(dir);
    const ctxA: ServiceContext = { ...rich.ctx, db: dbA };
    const [{ max }] = await dbA
      .select({ max: sql<number>`MAX(${journalEntries.entryNumber})::int` })
      .from(journalEntries)
      .where(eq(journalEntries.companyId, ctxA.companyId));
    const head = readAllTransactionLog(dir).records.at(-1)!;
    const e = await postJournalEntry(ctxA, {
      date: new Date('2025-03-01'),
      description: 'First entry in the restored copy',
      lines: [
        { accountId: rich.acct['6000'], debit: '12.34' },
        { accountId: rich.acct['1000'], credit: '12.34' },
      ],
    });
    expect(e.entryNumber).toBe(max + 1);
    const rec = readAllTransactionLog(dir).records.find((r) => r.entityId === e.id)!;
    expect(rec.prevHash).toBe(head.hash);
    expect(rec.seq).toBe(head.seq + 1);
    const v = await verifyTransactionLog(dbA, dir);
    expect(v.ok).toBe(true);
    expect((await trialBalance(ctxA)).balanced).toBe(true);
  });

  describe('shareable ledger', () => {
    let zip: AdmZip;
    beforeAll(async () => {
      zip = new AdmZip((await buildShareableLedgerXlsx(rich.ctx)).buffer);
    });

    it('exports only the active company (not another company in the same file)', () => {
      for (const e of zip.getEntries()) {
        expect(e.getData().toString('utf8'), e.entryName).not.toContain('SECRET-OTHER-CUSTOMER');
        expect(e.getData().toString('utf8'), e.entryName).not.toContain('Other Co');
      }
    });

    it('GL running balances are consistent and closing balances tie to the trial balance', async () => {
      // Columns: A Account, B Date, C Entry #, D Description, E Reference, F Name (customer/vendor,
      // added so the GL re-imports through the QB GL import), G Debit, H Credit, I Balance.
      const rows = readSheet(zip.readAsText('xl/worksheets/sheet4.xml'));
      const headerIdx = rows.findIndex((r) => r.A === 'Account' && r.I === 'Balance');
      expect(headerIdx).toBeGreaterThanOrEqual(0);
      const byAcct = new Map<string, Array<Record<string, string>>>();
      for (const r of rows.slice(headerIdx + 1)) {
        const list = byAcct.get(r.A) ?? [];
        list.push(r);
        byAcct.set(r.A, list);
      }
      const tb = await trialBalance(rich.ctx);
      const tbNet = new Map(tb.rows.map((r) => [r.code, Money.sub(r.debit, r.credit)]));
      const glCodes = new Set([...byAcct.keys()].map((l) => l.split(' · ')[0]));
      for (const r of tb.rows) {
        if (!Money.sub(r.debit, r.credit).isZero()) expect(glCodes.has(r.code), `TB account ${r.code} missing from GL`).toBe(true);
      }
      for (const [label, list] of byAcct) {
        expect(list[0].D, label).toBe('Opening balance');
        expect(list.at(-1)!.D, label).toBe('Closing balance');
        let bal = Money.of(list[0].I ?? '0');
        let sign: number | null = null;
        for (const l of list.slice(1, -1)) {
          const delta = Money.sub(l.I ?? '0', bal);
          const dc = Money.sub(l.G || '0', l.H || '0');
          if (!dc.isZero()) {
            const s = delta.equals(dc) ? 1 : delta.equals(dc.negated()) ? -1 : 0;
            expect(s, `${label}: running balance step ${delta} vs debit-credit ${dc}`).not.toBe(0);
            if (sign === null) sign = s;
            expect(s, `${label}: inconsistent sign`).toBe(sign);
          }
          bal = Money.of(l.I ?? '0');
        }
        expect(Money.of(list.at(-1)!.I ?? '0').equals(bal), `${label}: closing != last running`).toBe(true);
        const code = label.split(' · ')[0];
        // The TB omits accounts whose activity nets to zero.
        const net = tbNet.get(code) ?? Money.zero();
        expect(bal.times(sign ?? 1).equals(net), `${label}: GL ${bal} vs TB net ${net}`).toBe(true);
      }
    });

    it('does not turn an EIN with a leading zero into a number', () => {
      const info = readSheet(zip.readAsText('xl/worksheets/sheet1.xml'));
      const ein = info.find((r) => r.A === 'EIN');
      expect(ein?.B).toBe('012345678');
    });
  });
});

// ---------------------------------------------------------------------------
// Condense + archive copy
// ---------------------------------------------------------------------------

const CROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-condense-adversarial');
const CDIR = path.join(CROOT, 'data');

async function entryCounts(d: DB) {
  const [e] = await d.select({ n: sql<number>`COUNT(*)::int` }).from(journalEntries);
  const [l] = await d.select({ n: sql<number>`COUNT(*)::int` }).from(journalEntryLines);
  return { entries: e.n, lines: l.n };
}

describe('condense archive — adversarial', () => {
  let cdb: DB;
  let cctx: ServiceContext;
  let before: {
    counts: { entries: number; lines: number };
    tb: Awaited<ReturnType<typeof trialBalance>>;
    pl: Awaited<ReturnType<typeof profitAndLoss>>;
    bs: Awaited<ReturnType<typeof balanceSheet>>;
  };
  let runId: string;
  const archiveRoot = path.join(CROOT, 'archives');

  beforeAll(async () => {
    fs.rmSync(CROOT, { recursive: true, force: true });
    cdb = await getDb(CDIR);
    ({ ctx: cctx } = await seedRichCompany(cdb, CDIR, 'Condense Adv Co'));
    await cdb.update(companies).set({ settings: { closingDate: '2025-01-31' } }).where(eq(companies.id, cctx.companyId));
    before = {
      counts: await entryCounts(cdb),
      tb: await trialBalance(cctx),
      pl: await profitAndLoss(cctx, { from: new Date('2025-01-01T00:00:00Z'), to: new Date('2025-01-31T23:59:59Z') }),
      bs: await balanceSheet(cctx, new Date('2025-01-31T23:59:59Z')),
    };
  }, 240_000);

  afterAll(async () => {
    await closeDb(CDIR).catch(() => undefined);
    fs.rmSync(CROOT, { recursive: true, force: true });
  });

  it('if the archive copy cannot be written, nothing is condensed', async () => {
    // Squat the archives folder path with a plain file so the archive cannot be created.
    fs.mkdirSync(CROOT, { recursive: true });
    fs.writeFileSync(archiveRoot, 'not a folder');
    try {
      await expect(condensePeriod(cctx, { beforeDate: new Date('2025-02-01T00:00:00Z'), dataDir: CDIR })).rejects.toBeTruthy();
    } finally {
      fs.rmSync(archiveRoot, { force: true });
    }
    expect(await entryCounts(cdb)).toEqual(before.counts);
    expect((await trialBalance(cctx)).rows).toEqual(before.tb.rows);
    expect(listCondenseArchives(CDIR)).toHaveLength(0);
  }, 120_000);

  it('condense keeps the January P&L, the month-end balance sheet and the TB identical', async () => {
    const res = await condensePeriod(cctx, { beforeDate: new Date('2025-02-01T00:00:00Z'), dataDir: CDIR });
    runId = res.runId!;
    expect((await entryCounts(cdb)).entries).toBeLessThan(before.counts.entries);
    expect((await trialBalance(cctx)).rows).toEqual(before.tb.rows);
    const pl = await profitAndLoss(cctx, { from: new Date('2025-01-01T00:00:00Z'), to: new Date('2025-01-31T23:59:59Z') });
    expect(pl.netIncome).toBe(before.pl.netIncome);
    expect(pl.totalIncome).toBe(before.pl.totalIncome);
    expect(pl.totalExpenses).toBe(before.pl.totalExpenses);
    const bs = await balanceSheet(cctx, new Date('2025-01-31T23:59:59Z'));
    expect(bs.totalAssets).toBe(before.bs.totalAssets);
    expect(bs.totalLiabilities).toBe(before.bs.totalLiabilities);
    expect(bs.totalEquity).toBe(before.bs.totalEquity);
    expect((await verifyTransactionLog(cdb, CDIR)).ok).toBe(true);
  }, 120_000);

  it('archive restore is owner/admin only and refuses a missing archive file', async () => {
    for (const role of ['accountant', 'viewer'] as const) {
      await expect(restoreCondenseArchive({ ...cctx, role }, runId, CDIR)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    // An archive recorded for a different company file is not offered here.
    expect(listCondenseArchives(path.join(CROOT, 'some-other-file')).length).toBe(0);

    const [archive] = listCondenseArchives(CDIR);
    const aside = `${archive.path}.aside`;
    fs.renameSync(archive.path, aside);
    try {
      expect(listCondenseArchives(CDIR)[0].available).toBe(false);
      await expect(restoreCondenseArchive(cctx, runId, CDIR)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      fs.renameSync(aside, archive.path);
    }
    // Nothing was restored by the refused attempts.
    expect((await entryCounts(cdb)).entries).toBeLessThan(before.counts.entries);
  }, 120_000);

  it('after restoring the archive the file keeps working: new posting chains and verifies', async () => {
    await restoreCondenseArchive({ ...cctx, role: 'admin' }, runId, CDIR);
    cdb = await getDb(CDIR);
    cctx = { ...cctx, db: cdb };
    expect(await entryCounts(cdb)).toEqual(before.counts);
    const [cash] = before.tb.rows.filter((r) => r.code === '1000');
    expect(cash).toBeTruthy();
    const acctIds = await cdb.execute(sql`SELECT id, code FROM accounts WHERE company_id = ${cctx.companyId}`);
    const byCode = new Map((acctIds.rows as Array<{ id: string; code: string }>).map((r) => [r.code, r.id]));
    await postJournalEntry(cctx, {
      date: new Date('2025-03-05'),
      description: 'After archive restore',
      lines: [
        { accountId: byCode.get('6000')!, debit: '5.00' },
        { accountId: byCode.get('1000')!, credit: '5.00' },
      ],
    });
    const v = await verifyTransactionLog(cdb, CDIR);
    expect(v.chainIntact).toBe(true);
    expect(v.ok).toBe(true);
    expect((await trialBalance(cctx)).balanced).toBe(true);
  }, 120_000);
});
