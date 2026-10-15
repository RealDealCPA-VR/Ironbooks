/**
 * Receipt capture (integration, real PGlite company file): upload validation, local reading
 * (PDF text, scanned PDF → OCR, photo → OCR, nothing installed), suggestions (vendor match,
 * account from history, paying card by last 4), attach-on-save with record locking and the
 * closing date, permissions, and company scoping.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { attachments, expenseLines, expenses, bills, receiptScans, vendors } from '@/lib/db/schema';
import { unionRoles, type RoleDefinition } from '@/lib/permissions/model';
import { encodePng } from '@/lib/receipts/png';
import { setOcrEngineForTests } from '@/lib/receipts/ocr';
import { createCompany, setClosingDate } from './company';
import { createVendor } from './vendors';
import { createExpense } from './expenses';
import { createBankAccount } from './bankAccounts';
import { listAttachments, listUnfiledAttachments, updateAttachment } from './attachments';
import type { ServiceContext } from './_base';
import {
  deleteReceipt,
  effectiveReceiptStatus,
  extractReceipt,
  getReceipt,
  listReceipts,
  matchVendor,
  normalizeVendorName,
  receiptSuggestions,
  saveReceipt,
  uploadReceipt,
  vendorNameScore,
} from './receipts';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;

const RECEIPT_TEXT = `HOME DEPOT #4521
123 MAIN ST
SPRINGFIELD IL 62701
03/14/2026  10:42 AM
SUBTOTAL          21.45
SALES TAX 6.25%    1.34
TOTAL             22.79
VISA ************4417`;

function png(w = 4, h = 4): Buffer {
  return encodePng(w, h, new Uint8Array(w * h).fill(200), 1);
}
const jpegBytes = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const heicBytes = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(32, 0)]);

async function textPdf(lines: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((l, i) => page.drawText(l, { x: 20, y: 370 - i * 16, size: 11, font }));
  return Buffer.from(await doc.save());
}

async function scannedPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 400]);
  const img = await doc.embedPng(encodePng(40, 60, new Uint8Array(40 * 60 * 3).fill(240), 3));
  page.drawImage(img, { x: 0, y: 0, width: 300, height: 400 });
  return Buffer.from(await doc.save());
}

function restricted(ctx: ServiceContext, permissions: RoleDefinition['permissions']): ServiceContext {
  const role = { key: 'custom-test', name: 'Test', description: '', permissions } as RoleDefinition;
  return { ...ctx, access: unionRoles([role]) };
}

async function readyReceipt(text = RECEIPT_TEXT) {
  setOcrEngineForTests({ recognize: async () => text });
  const r = await uploadReceipt(t.ctx, { filename: 'photo.jpg', bytes: jpegBytes() });
  return extractReceipt(t.ctx, r.id);
}

describe('receipt capture (integration)', () => {
  beforeAll(async () => {
    t = await makeTestCompany('receipts');
  });
  afterAll(async () => {
    setOcrEngineForTests(undefined);
    await t.cleanup();
  });
  afterEach(() => setOcrEngineForTests(undefined));

  it('migration 0050 is registered as idx 50 and can be re-run safely', async () => {
    const j = JSON.parse(fs.readFileSync(path.resolve('drizzle/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(j.entries.filter((e) => e.tag === '0050_receipts')).toEqual([
      { idx: 50, version: '7', when: 1781400050000, tag: '0050_receipts', breakpoints: true },
    ]);
    const file = fs.readFileSync(path.resolve('drizzle/0050_receipts.sql'), 'utf8');
    for (const stmt of file.split('--> statement-breakpoint')) if (stmt.trim()) await t.db.execute(sql.raw(stmt));
    const cols = await t.db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'receipt_scans'`);
    const names = (cols as unknown as { rows: Array<{ column_name: string }> }).rows.map((r) => r.column_name);
    for (const c of ['attachment_id', 'version', 'total', 'tax', 'card_last4', 'txn_id']) expect(names).toContain(c);
  });

  describe('upload validation', () => {
    it('accepts a photo into the Doc Center inbox, waiting to be read', async () => {
      const r = await uploadReceipt(t.ctx, { filename: '../../evil<name>.JPG', bytes: jpegBytes() });
      expect(r).toMatchObject({ status: 'pending', source: 'desktop', mimeType: 'image/jpeg', filename: 'evilname.jpg' });
      expect((await listUnfiledAttachments(t.ctx)).map((a) => a.id)).toContain(r.attachmentId);
      expect((await listReceipts(t.ctx)).map((x) => x.id)).toContain(r.id);
    });

    it('decides the type from the bytes, not the name', async () => {
      await expect(uploadReceipt(t.ctx, { filename: 'receipt.jpg', bytes: Buffer.from('<html><script>alert(1)</script></html>') })).rejects.toMatchObject({
        code: 'VALIDATION',
      });
      const p = await uploadReceipt(t.ctx, { filename: 'scan.exe', bytes: png() });
      expect(p.filename).toBe('scan.png');
      expect(p.mimeType).toBe('image/png');
    });

    it('refuses empty and oversized files', async () => {
      await expect(uploadReceipt(t.ctx, { filename: 'a.jpg', bytes: new Uint8Array(0) })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(uploadReceipt(t.ctx, { filename: 'a.jpg', bytes: jpegBytes(), maxBytes: 10 })).rejects.toMatchObject({
        code: 'VALIDATION',
        message: expect.stringMatching(/too big/),
      });
    });

    it('stores HEIC photos but explains they must be typed in', async () => {
      const r = await uploadReceipt(t.ctx, { filename: 'IMG_0001.HEIC', bytes: heicBytes() });
      expect(r).toMatchObject({ status: 'ready', method: 'none', mimeType: 'image/heic' });
      expect(r.message).toMatch(/HEIC/);
    });

    it('view-only and no-Lists members cannot add receipts', async () => {
      await expect(uploadReceipt({ ...t.ctx, role: 'viewer' }, { filename: 'a.jpg', bytes: jpegBytes() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const noLists = restricted(t.ctx, { banking: ['view', 'create'] });
      await expect(uploadReceipt(noLists, { filename: 'a.jpg', bytes: jpegBytes() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('reading on this machine', () => {
    it('reads a photo with offline OCR and parses the fields', async () => {
      let seen: Buffer | null = null;
      setOcrEngineForTests({
        recognize: async (img) => {
          seen = img;
          return RECEIPT_TEXT;
        },
      });
      const up = await uploadReceipt(t.ctx, { filename: 'hd.jpg', bytes: jpegBytes() });
      const r = await extractReceipt(t.ctx, up.id);
      expect(seen).not.toBeNull();
      expect(r).toMatchObject({
        status: 'ready',
        method: 'ocr',
        vendorName: 'Home Depot',
        date: '2026-03-14',
        total: '22.79',
        tax: '1.34',
        subtotal: '21.45',
        cardLast4: '4417',
        cardBrand: 'Visa',
      });
      expect(r.version).toBe(up.version + 1);
      // A second read is a no-op unless forced (the row is claimed only when pending / failed).
      const again = await extractReceipt(t.ctx, up.id);
      expect(again.version).toBe(r.version);
      await expect(extractReceipt(t.ctx, up.id, { force: true, version: r.version - 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
      const forced = await extractReceipt(t.ctx, up.id, { force: true, version: r.version });
      expect(forced.version).toBe(r.version + 1);
    });

    it('reads a PDF from its text layer (no OCR needed)', async () => {
      setOcrEngineForTests({
        recognize: async () => {
          throw new Error('OCR must not run for a text PDF');
        },
      });
      const pdf = await textPdf(['Acme Office Supply', 'Invoice Date: 2026-09-02', 'Subtotal $100.00', 'Tax $8.25', 'Total $108.25']);
      const up = await uploadReceipt(t.ctx, { filename: 'acme.pdf', bytes: pdf });
      const r = await extractReceipt(t.ctx, up.id);
      expect(r).toMatchObject({ status: 'ready', method: 'pdf-text', vendorName: 'Acme Office Supply', total: '108.25', tax: '8.25', date: '2026-09-02' });
    });

    it('a scanned PDF (no text) has its page image read by OCR', async () => {
      let gotPng = false;
      setOcrEngineForTests({
        recognize: async (img) => {
          gotPng = img.subarray(1, 4).toString('ascii') === 'PNG';
          return 'CORNER CAFE\nDate: 2026-08-01\nTotal 9.50';
        },
      });
      const up = await uploadReceipt(t.ctx, { filename: 'scan.pdf', bytes: await scannedPdf() });
      const r = await extractReceipt(t.ctx, up.id);
      expect(gotPng).toBe(true);
      expect(r).toMatchObject({ method: 'ocr', vendorName: 'Corner Cafe', total: '9.50' });
    });

    it('without OCR or a local model the receipt is marked for typing in (AI is never required)', async () => {
      setOcrEngineForTests(null);
      const up = await uploadReceipt(t.ctx, { filename: 'p.png', bytes: png() });
      const r = await extractReceipt(t.ctx, up.id);
      expect(r).toMatchObject({ status: 'failed', method: 'none', total: null });
      expect(r.message).toMatch(/not installed/);
    });

    it('a read abandoned mid-way (app closed during OCR) is offered again and finishes', async () => {
      setOcrEngineForTests({ recognize: async () => RECEIPT_TEXT });
      const r = await uploadReceipt(t.ctx, { filename: 'photo.jpg', bytes: jpegBytes() });
      const old = new Date(Date.now() - 10 * 60_000);
      await t.db
        .update(receiptScans)
        .set({ status: 'processing', processingStartedAt: old, updatedAt: old })
        .where(eq(receiptScans.id, r.id));
      // Shown as waiting, so the inbox and the review page ask to read it again...
      expect((await getReceipt(t.ctx, r.id)).status).toBe('pending');
      expect((await listReceipts(t.ctx)).find((x) => x.id === r.id)?.status).toBe('pending');
      // ...and a plain (not forced) read reclaims the abandoned claim and finishes it.
      const done = await extractReceipt(t.ctx, r.id);
      expect(done.status).toBe('ready');
      expect(done.total).toBe('22.79');
    });

    it('a receipt being read right now is left alone', async () => {
      let calls = 0;
      setOcrEngineForTests({ recognize: async () => (calls++, RECEIPT_TEXT) });
      const r = await uploadReceipt(t.ctx, { filename: 'photo.jpg', bytes: jpegBytes() });
      const now = new Date();
      await t.db
        .update(receiptScans)
        .set({ status: 'processing', processingStartedAt: now, updatedAt: now })
        .where(eq(receiptScans.id, r.id));
      expect((await getReceipt(t.ctx, r.id)).status).toBe('processing');
      expect((await extractReceipt(t.ctx, r.id)).status).toBe('processing');
      expect(calls).toBe(0);
    });

    it('effectiveReceiptStatus: only a processing claim older than 3 minutes counts as abandoned', () => {
      const now = new Date('2026-10-15T12:00:00Z');
      const ago = (min: number) => new Date(now.getTime() - min * 60_000);
      expect(effectiveReceiptStatus({ status: 'processing', processingStartedAt: ago(2), updatedAt: ago(2) }, now)).toBe('processing');
      expect(effectiveReceiptStatus({ status: 'processing', processingStartedAt: ago(4), updatedAt: ago(1) }, now)).toBe('pending');
      expect(effectiveReceiptStatus({ status: 'processing', processingStartedAt: null, updatedAt: ago(5) }, now)).toBe('pending');
      expect(effectiveReceiptStatus({ status: 'ready', processingStartedAt: ago(60), updatedAt: ago(60) }, now)).toBe('ready');
    });

    it('an OCR failure is reported, not thrown', async () => {
      setOcrEngineForTests({
        recognize: async () => {
          throw new Error('engine crashed');
        },
      });
      const up = await uploadReceipt(t.ctx, { filename: 'p.png', bytes: png() });
      const r = await extractReceipt(t.ctx, up.id);
      expect(r.status).toBe('failed');
      expect(r.message).toMatch(/engine crashed/);
    });
  });

  describe('suggestions', () => {
    it('matches vendor names loosely', () => {
      expect(normalizeVendorName('The Home Depot, Inc. #4521')).toBe('home depot');
      expect(vendorNameScore('HOME DEPOT', 'The Home Depot')).toBe(1);
      expect(vendorNameScore('Homedepot', 'Home Depot')).toBeGreaterThan(0.9);
      expect(vendorNameScore('Shell', 'Shell Oil Co')).toBeGreaterThan(0.6);
      expect(vendorNameScore('Kroger', 'Home Depot')).toBe(0);
    });

    it('suggests the vendor, the account they were last paid from, and the card by last 4', async () => {
      const v = await createVendor(t.ctx, { displayName: 'The Home Depot' });
      await createExpense(t.ctx, {
        vendorId: v.id,
        date: new Date('2026-02-01T12:00:00Z'),
        method: 'cash',
        paymentAccountId: t.acct['1000'],
        lines: [{ accountId: t.acct['6300'], amount: '10.00' }],
      });
      await createBankAccount(t.ctx, { accountId: t.acct['2100'], bankName: 'Visa', accountNumber: '4111-1111-1111-4417' });
      const r = await readyReceipt();
      const s = await receiptSuggestions(t.ctx, r.id);
      expect(s.vendor).toMatchObject({ vendorId: v.id });
      expect(s.accountId).toBe(t.acct['6300']);
      expect(s.accountSource).toBe('last-used');
      expect(s.paymentAccountId).toBe(t.acct['2100']);
      expect(s.kind).toBe('credit_card');
      expect(await matchVendor(t.ctx, 'Unknown Store', 'Unknown Store\nTotal 1.00')).toBeNull();
    });
  });

  describe('save as a transaction (attach-on-save)', () => {
    it('creates a credit card charge, attaches the receipt and closes the receipt', async () => {
      const r = await readyReceipt();
      const v = (await t.db.select().from(vendors).where(eq(vendors.displayName, 'The Home Depot')))[0];
      const res = await saveReceipt(t.ctx, r.id, {
        version: r.version,
        kind: 'credit_card',
        vendorId: v.id,
        date: '2026-03-14',
        total: '22.79',
        tax: '1.34',
        taxAccountId: t.acct['6700'],
        accountId: t.acct['6300'],
        paymentAccountId: t.acct['2100'],
        memo: 'Lumber',
      });
      expect(res.txnType).toBe('expense');
      expect(res.receipt).toMatchObject({ status: 'saved', txnType: 'expense', txnId: res.txnId });
      const [exp] = await t.db.select().from(expenses).where(eq(expenses.id, res.txnId));
      expect(exp).toMatchObject({ method: 'credit_card', total: '22.79', vendorId: v.id, companyId: t.ctx.companyId });
      const lines = await t.db.select().from(expenseLines).where(eq(expenseLines.expenseId, res.txnId));
      expect(lines.map((l) => [l.accountId, l.amount]).sort()).toEqual(
        [[t.acct['6300'], '21.45'], [t.acct['6700'], '1.34']].sort(),
      );
      // The receipt is now filed to the expense and out of the inbox.
      const filed = await listAttachments(t.ctx, { entityType: 'expense', entityId: res.txnId });
      expect(filed.map((a) => a.id)).toEqual([r.attachmentId]);
      expect((await listUnfiledAttachments(t.ctx)).map((a) => a.id)).not.toContain(r.attachmentId);
      // Saving twice is refused, and a saved receipt can't be deleted from the inbox.
      await expect(
        saveReceipt(t.ctx, r.id, { version: res.receipt.version, kind: 'expense', payeeName: 'X', date: '2026-03-14', total: '1', accountId: t.acct['6300'], paymentAccountId: t.acct['1000'] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(deleteReceipt(t.ctx, r.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('a receipt filed to another record from the Doc Center leaves the inbox and is not saved twice', async () => {
      const r = await readyReceipt();
      const v = (await t.db.select().from(vendors).where(eq(vendors.displayName, 'The Home Depot')))[0];
      await updateAttachment(t.ctx, r.attachmentId, { entityType: 'vendor', entityId: v.id });
      expect((await listReceipts(t.ctx)).map((x) => x.id)).not.toContain(r.id);
      await expect(
        saveReceipt(t.ctx, r.id, { version: r.version, kind: 'expense', vendorId: v.id, date: '2026-03-14', total: '5', accountId: t.acct['6300'], paymentAccountId: t.acct['1000'] }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      const [att] = await t.db.select().from(attachments).where(eq(attachments.id, r.attachmentId));
      expect(att).toMatchObject({ entityType: 'vendor', entityId: v.id });
    });

    it('refuses a stale version (someone else re-read or saved it)', async () => {
      const r = await readyReceipt();
      await expect(
        saveReceipt(t.ctx, r.id, { version: r.version - 1, kind: 'expense', payeeName: 'Shop', date: '2026-03-14', total: '5', accountId: t.acct['6300'], paymentAccountId: t.acct['1000'] }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect((await getReceipt(t.ctx, r.id)).status).toBe('ready');
    });

    it('a bill for a new vendor creates the vendor and the bill', async () => {
      const r = await readyReceipt('BRIGHT SIGNS LLC\nInvoice No: INV-20931\nDate: 2026-06-30\nBalance Due 594.00');
      const res = await saveReceipt(t.ctx, r.id, {
        version: r.version,
        kind: 'bill',
        newVendorName: 'Bright Signs LLC',
        date: '2026-06-30',
        dueDate: '2026-07-30',
        total: '594.00',
        accountId: t.acct['6000'],
        reference: 'INV-20931',
      });
      expect(res.txnType).toBe('bill');
      const [bill] = await t.db.select().from(bills).where(eq(bills.id, res.txnId));
      expect(bill).toMatchObject({ billNumber: 'INV-20931', total: '594.00' });
      const [v] = await t.db.select().from(vendors).where(eq(vendors.id, bill.vendorId));
      expect(v.displayName).toBe('Bright Signs LLC');
      const [att] = await t.db.select().from(attachments).where(eq(attachments.id, r.attachmentId));
      expect(att).toMatchObject({ entityType: 'bill', entityId: res.txnId });
    });

    it('validates amounts and required choices', async () => {
      const r = await readyReceipt();
      const base = { version: r.version, kind: 'expense' as const, payeeName: 'Shop', date: '2026-03-14', accountId: t.acct['6300'], paymentAccountId: t.acct['1000'] };
      await expect(saveReceipt(t.ctx, r.id, { ...base, total: '0' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(saveReceipt(t.ctx, r.id, { ...base, total: '1.234' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(saveReceipt(t.ctx, r.id, { ...base, total: '5', tax: '5', taxAccountId: t.acct['6700'] })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(saveReceipt(t.ctx, r.id, { ...base, total: '5', tax: '1' })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(saveReceipt(t.ctx, r.id, { ...base, total: '5', paymentAccountId: null })).rejects.toMatchObject({ code: 'VALIDATION' });
      await expect(saveReceipt(t.ctx, r.id, { ...base, kind: 'bill', total: '5' })).rejects.toMatchObject({ code: 'VALIDATION' });
      expect((await getReceipt(t.ctx, r.id)).status).toBe('ready');
    });

    it('respects the closing date: nothing is saved or filed', async () => {
      const r = await readyReceipt();
      await setClosingDate(t.ctx, { closingDate: '2026-03-31' });
      try {
        await expect(
          saveReceipt(t.ctx, r.id, { version: r.version, kind: 'expense', payeeName: 'Shop', date: '2026-03-14', total: '22.79', accountId: t.acct['6300'], paymentAccountId: t.acct['1000'] }),
        ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
      } finally {
        await setClosingDate(t.ctx, { closingDate: null });
      }
      expect((await getReceipt(t.ctx, r.id)).status).toBe('ready');
      expect((await listUnfiledAttachments(t.ctx)).map((a) => a.id)).toContain(r.attachmentId);
    });

    it('needs Banking (expenses) or Vendors (bills) permission to save', async () => {
      const r = await readyReceipt();
      const listsOnly = restricted(t.ctx, { lists: ['view', 'create', 'modify', 'delete'] });
      await expect(
        saveReceipt(listsOnly, r.id, { version: r.version, kind: 'expense', payeeName: 'Shop', date: '2026-03-14', total: '5', accountId: t.acct['6300'], paymentAccountId: t.acct['1000'] }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const banking = restricted(t.ctx, { lists: ['view', 'create', 'modify'], banking: ['view', 'create', 'modify'] });
      await expect(
        saveReceipt(banking, r.id, { version: r.version, kind: 'bill', newVendorName: 'Nope Inc', date: '2026-03-14', total: '5', accountId: t.acct['6300'] }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect((await getReceipt(t.ctx, r.id)).status).toBe('ready');
    });
  });

  describe('company scoping', () => {
    it("another company can't see, read, save or delete this company's receipts", async () => {
      const r = await readyReceipt();
      const other = await createCompany(t.db, { name: 'Other Co', ownerId: t.ctx.userId! });
      const octx: ServiceContext = { db: t.db, companyId: other.id, userId: t.ctx.userId };
      await expect(getReceipt(octx, r.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(extractReceipt(octx, r.id, { force: true, version: r.version })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(deleteReceipt(octx, r.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await listReceipts(octx, { status: 'all' })).length).toBe(0);
      await expect(
        saveReceipt(octx, r.id, { version: r.version, kind: 'expense', payeeName: 'Shop', date: '2026-03-14', total: '5', accountId: t.acct['6300'], paymentAccountId: t.acct['1000'] }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|VALIDATION/) });
      // Saving with another company's vendor / accounts is refused.
      const otherVendor = await createVendor(octx, { displayName: 'Foreign Vendor' });
      await expect(
        saveReceipt(t.ctx, r.id, { version: r.version, kind: 'expense', vendorId: otherVendor.id, date: '2026-03-14', total: '5', accountId: t.acct['6300'], paymentAccountId: t.acct['1000'] }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|VALIDATION/) });
      expect((await getReceipt(t.ctx, r.id)).status).toBe('ready');
      // Malformed ids are NOT_FOUND, not a database error.
      await expect(getReceipt(t.ctx, 'not-a-uuid')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const rows = await t.db.select().from(receiptScans).where(eq(receiptScans.companyId, other.id));
      expect(rows).toEqual([]);
    });

    it('deleting an unsaved receipt removes its file and scan', async () => {
      const r = await uploadReceipt(t.ctx, { filename: 'x.png', bytes: png() });
      await deleteReceipt(t.ctx, r.id);
      await expect(getReceipt(t.ctx, r.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await t.db.select().from(attachments).where(eq(attachments.id, r.attachmentId))).toEqual([]);
    });
  });
});
