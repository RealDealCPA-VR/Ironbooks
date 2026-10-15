/**
 * Sandbox mode ("Try it on a copy", lib/services/sandbox.ts):
 *  - the copy is an independent database (writes in the sandbox never reach the real file);
 *  - the banner flag is exposed by GET /api/sandbox/status;
 *  - emails, bank-feed sync, scheduled reports and auto-backups are blocked in the sandbox;
 *  - PDFs printed from the sandbox (checks, invoices) are stamped SANDBOX;
 *  - discard deletes the copy and returns to the real file; keep moves it to a training file;
 *  - copies left over after a restart can be resumed or deleted;
 *  - backups never carry the sandbox marker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import AdmZip from 'adm-zip';
import { PDFDocument } from 'pdf-lib';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, resolveDataDir } from '@/lib/db';
import { auditLogs, customers, users } from '@/lib/db/schema';
import { createCompany } from './company';
import { createCustomer } from './customers';
import type { ServiceContext } from './_base';
import {
  SANDBOX_CONTAINER_MARKER,
  discardLeftoverSandbox,
  discardSandbox,
  getSandboxStatus,
  keepSandboxAsTraining,
  listLeftoverSandboxes,
  readSandboxMarker,
  resumeSandbox,
  startSandbox,
  switchActiveDataDir,
  SANDBOX_MARKER,
} from './sandbox';
import { isSandboxActive } from './sandboxState';
import { sendMail, emailInvoice } from './email';
import { syncTransactions } from './plaid';
import { runDueSchedules } from './memorizedReports';
import { createBackup } from './backup';
import { checkOutbound } from '@/lib/net/guard';
import { renderCheckPdf } from '@/lib/pdf/check';
import { renderFormPdf, sampleFormDocument } from '@/lib/pdf/template';
import { GET as statusGET } from '@/app/api/sandbox/status/route';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', `test-sandbox-${process.pid}`);
const REAL = path.join(ROOT, 'Real Co.ironbooks');
const SANDBOXES = path.join(ROOT, 'sandboxes');

let ownerId: string;
let companyId: string;
const realCtx = async (): Promise<ServiceContext> => ({ db: await getDb(REAL), companyId, userId: ownerId });
const activeCtx = async (): Promise<ServiceContext> => ({ db: await getDb(), companyId, userId: ownerId });

const SMTP = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const;

async function pdfIsStamped(bytes: Uint8Array): Promise<boolean> {
  const doc = await PDFDocument.load(bytes);
  return (doc.getKeywords() ?? '').includes('SANDBOX');
}

describe('sandbox mode', () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    process.env.BKA_DATA_DIR = REAL;
    process.env.BKA_SANDBOX_ROOT = SANDBOXES;
    const db = await getDb();
    const [owner] = await db
      .insert(users)
      .values({ email: 'owner@sandbox.test', name: 'Sandbox Owner', passwordHash: 'hash' })
      .returning();
    ownerId = owner.id;
    const company = await createCompany(db, { name: 'Real Co', ownerId });
    companyId = company.id;
    await createCustomer({ db, companyId, userId: ownerId }, { displayName: 'Real Customer' });
    // The file id sessions are bound to (lib/auth.ts companyFileId writes it on first sign-in).
    fs.writeFileSync(path.join(REAL, '.file-id'), 'real-file-id');
  }, 180_000);

  afterAll(async () => {
    switchActiveDataDir(REAL);
    await closeDb(REAL).catch(() => undefined);
    for (const root of [SANDBOXES, ROOT]) {
      for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) {
        const p = path.join(root, d);
        await closeDb(p).catch(() => undefined);
        for (const inner of fs.existsSync(p) && fs.statSync(p).isDirectory() ? fs.readdirSync(p) : []) {
          await closeDb(path.join(p, inner)).catch(() => undefined);
        }
      }
    }
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    delete process.env.BKA_DATA_DIR;
    delete process.env.BKA_SANDBOX_ROOT;
    delete process.env.BKA_SANDBOX;
    for (const k of SMTP) delete process.env[k];
  });

  it('is off in the real file', async () => {
    expect(isSandboxActive()).toBe(false);
    expect(getSandboxStatus()).toMatchObject({ active: false, kind: null, leftovers: [] });
    const body = await (await statusGET()).json();
    expect(body).toEqual({ active: false, kind: null, text: null });
    expect(await pdfIsStamped(await renderCheckPdf({ company: { name: 'Real Co' }, payee: 'X', amountNumeric: '1.00', date: '2026-01-01' }))).toBe(false);
  });

  it('copies the whole file into an independent database and switches to it', async () => {
    const r = await startSandbox(await realCtx());
    expect(r.realDir).toBe(path.resolve(REAL));
    expect(r.dir.startsWith(SANDBOXES + path.sep)).toBe(true);
    expect(resolveDataDir()).toBe(path.resolve(r.dir));
    expect(fs.existsSync(path.join(path.dirname(r.dir), SANDBOX_CONTAINER_MARKER))).toBe(true);
    expect(readSandboxMarker(r.dir)).toMatchObject({ kind: 'sandbox', realDataDir: path.resolve(REAL), sourceName: 'Real Co' });
    // The real file never gets a marker; the copy keeps the file id so the user stays signed in.
    expect(fs.existsSync(path.join(REAL, SANDBOX_MARKER))).toBe(false);
    expect(fs.readFileSync(path.join(r.dir, '.file-id'), 'utf8')).toBe(fs.readFileSync(path.join(REAL, '.file-id'), 'utf8'));

    // Everything that was in the real file is in the copy.
    const ctx = await activeCtx();
    const inCopy = await ctx.db.select().from(customers).where(eq(customers.companyId, companyId));
    expect(inCopy.map((c) => c.displayName)).toEqual(['Real Customer']);

    // Writes go to the copy only.
    await createCustomer(ctx, { displayName: 'Sandbox Only Customer' });
    expect((await ctx.db.select().from(customers).where(eq(customers.companyId, companyId))).length).toBe(2);

    // Starting again while in the sandbox is refused.
    await expect(startSandbox(ctx)).rejects.toThrow(/already working in the sandbox/);
  }, 180_000);

  it('exposes the banner flag through the API', async () => {
    const res = await statusGET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({ active: true, kind: 'sandbox' });
    expect(body.text).toMatch(/^SANDBOX/);
    expect(body.text).toMatch(/don't affect your real books/);
    expect(getSandboxStatus()).toMatchObject({ active: true, kind: 'sandbox', sourceName: 'Real Co', realFileFound: true });
  });

  it('blocks emails, bank feeds, scheduled reports and the auto-backup', async () => {
    const ctx = await activeCtx();
    // Even with SMTP fully configured, nothing is sent.
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '2525';
    process.env.SMTP_USER = 'u';
    process.env.SMTP_PASS = 'p';
    process.env.SMTP_FROM = 'books@sandbox.test';
    await expect(sendMail({ to: 'a@b.test', subject: 's', text: 't' }, ctx)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringMatching(/Email is turned off in the sandbox/),
    });
    await expect(emailInvoice(ctx, '00000000-0000-0000-0000-000000000000', 'a@b.test')).rejects.toThrow(/turned off in the sandbox/);
    // The network guard refuses email / bank feeds / updates (AI help still follows the policy).
    expect((await checkOutbound('smtp://127.0.0.1:2525', 'email', ctx)).allowed).toBe(false);
    expect((await checkOutbound('http://127.0.0.1:9/', 'bank-feeds', ctx)).allowed).toBe(false);
    expect((await checkOutbound('http://127.0.0.1:9/', 'updates', ctx)).allowed).toBe(false);
    expect((await checkOutbound('http://127.0.0.1:9/', 'ai', ctx)).allowed).toBe(true);
    await expect(syncTransactions(ctx, { accessToken: 'x', bankAccountId: 'y' })).rejects.toThrow(/Bank feed sync is turned off/);
    await expect(runDueSchedules(ctx)).rejects.toThrow(/Scheduled reports is turned off/);
  });

  it('stamps checks and invoices printed from the sandbox', async () => {
    const check = await renderCheckPdf({ company: { name: 'Real Co' }, payee: 'Paper Supply', amountNumeric: '12.34', date: '2026-01-01' });
    expect(await pdfIsStamped(check)).toBe(true);
    const invoice = await renderFormPdf(sampleFormDocument('invoice', 'Real Co'), null, null);
    expect(await pdfIsStamped(invoice)).toBe(true);
  });

  it('never puts the sandbox marker in a backup', () => {
    const zip = new AdmZip(createBackup('Real Co').buffer);
    expect(zip.getEntry(SANDBOX_MARKER)).toBeNull();
  });

  it('discard deletes the copy and returns to the untouched real file', async () => {
    const dir = resolveDataDir();
    const container = path.dirname(dir);
    const r = await discardSandbox(await activeCtx());
    expect(r.realDir).toBe(path.resolve(REAL));
    expect(resolveDataDir()).toBe(path.resolve(REAL));
    expect(fs.existsSync(container)).toBe(false);
    expect(isSandboxActive()).toBe(false);
    expect(process.env.BKA_SANDBOX).toBeUndefined();

    const db = await getDb();
    const real = await db.select().from(customers).where(eq(customers.companyId, companyId));
    expect(real.map((c) => c.displayName)).toEqual(['Real Customer']);
    // The real file's audit trail records the sandbox being made and discarded.
    const events = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, companyId), eq(auditLogs.entityType, 'sandbox')));
    expect(events.map((e) => e.action).sort()).toEqual(['create', 'delete']);
    expect(getSandboxStatus().leftovers).toEqual([]);
    // Back in the real books, printing is unstamped again.
    expect(await pdfIsStamped(await renderCheckPdf({ company: { name: 'Real Co' }, payee: 'X', amountNumeric: '1.00', date: '2026-01-01' }))).toBe(false);
    await expect(discardSandbox(await activeCtx())).rejects.toThrow(/not working in the sandbox/);
  }, 180_000);

  it('keep as a training file moves the copy next to the real file and never merges back', async () => {
    const started = await startSandbox(await realCtx());
    const ctx = await activeCtx();
    await createCustomer(ctx, { displayName: 'Training Customer' });
    await expect(keepSandboxAsTraining(ctx, '   ')).rejects.toThrow(/Give the training file a name/);
    await expect(keepSandboxAsTraining(ctx, 'Real Co')).rejects.toThrow(/real company file/);
    fs.mkdirSync(path.join(ROOT, 'Taken.ironbooks'));
    await expect(keepSandboxAsTraining(ctx, 'Taken')).rejects.toThrow(/already exists/);
    // Still in the sandbox after a refused name.
    expect(resolveDataDir()).toBe(path.resolve(started.dir));

    const kept = await keepSandboxAsTraining(ctx, 'Practice: Year End');
    expect(kept.name).toBe('Practice- Year End');
    expect(kept.trainingDir).toBe(path.join(ROOT, 'Practice- Year End.ironbooks'));
    expect(resolveDataDir()).toBe(path.resolve(REAL));
    expect(fs.existsSync(path.dirname(started.dir))).toBe(false);
    expect(readSandboxMarker(kept.trainingDir)).toMatchObject({ kind: 'training', trainingName: 'Practice- Year End' });
    // Its own file id: a session from the training file is never valid on the real file.
    expect(fs.readFileSync(path.join(kept.trainingDir, '.file-id'), 'utf8')).not.toBe(
      fs.readFileSync(path.join(REAL, '.file-id'), 'utf8'),
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(kept.trainingDir, 'bookkeeper-company.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'Practice- Year End', training: true });

    const realNames = (await (await getDb()).select().from(customers).where(eq(customers.companyId, companyId))).map((c) => c.displayName);
    expect(realNames).toEqual(['Real Customer']);
    const trainingDb = await getDb(kept.trainingDir);
    const trainingNames = (await trainingDb.select().from(customers).where(eq(customers.companyId, companyId)))
      .map((c) => c.displayName)
      .sort();
    expect(trainingNames).toEqual(['Real Customer', 'Training Customer']);
    await closeDb(kept.trainingDir);
  }, 180_000);

  it('lists, resumes and deletes copies left over after a restart', async () => {
    const first = await startSandbox(await realCtx());
    // A web server restart comes back on the real file.
    await closeDb(first.dir);
    switchActiveDataDir(REAL);
    const left = listLeftoverSandboxes();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ id: path.basename(path.dirname(first.dir)), sourceName: 'Real Co' });
    await expect(resumeSandbox(await realCtx(), '../escape')).rejects.toThrow(/not found/);

    const resumed = await resumeSandbox(await realCtx(), left[0].id);
    expect(resolveDataDir()).toBe(path.resolve(first.dir));
    expect(resumed.dir).toBe(first.dir);
    await expect(discardLeftoverSandbox(await activeCtx(), left[0].id)).rejects.toThrow(/Leave the sandbox first/);

    // Back to the real file again, then delete the copy from the list.
    await closeDb(first.dir);
    switchActiveDataDir(REAL);
    await discardLeftoverSandbox(await realCtx(), left[0].id);
    expect(fs.existsSync(path.dirname(first.dir))).toBe(false);
    expect(listLeftoverSandboxes()).toEqual([]);
  }, 180_000);
});
