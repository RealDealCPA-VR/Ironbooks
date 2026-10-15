/**
 * Check printing on any check stock — printer setup storage / validation (drizzle/0047) and the
 * batch mode of POST /api/checks/pdf (several queued checks in ONE PDF).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, checkPrintSettings, paymentChecks, users, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { checkPrintData, getCheckPrintSettings, saveCheckPrintSettings } from './printQueue';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { POST as pdfPOST } from '@/app/api/checks/pdf/route';
import { PUT as settingsPUT } from '@/app/api/checks/settings/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-check-layouts');
let db: DB;
let bank: string;
let vendorId: string;
const checkIds: string[] = [];

function req(url: string, method: string, body: unknown) {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as never;
}
async function pages(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/pdf');
  return (await PDFDocument.load(new Uint8Array(await res.arrayBuffer()))).getPageCount();
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'layouts@test.local', name: 'Lee', passwordHash: 'x' }).returning();
  const company = await createCompany(db, { name: 'Layouts Co', ownerId: user.id });
  ctx = { db, companyId: company.id, userId: user.id };
  const [acct] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, '1000')));
  bank = acct.id;
  vendorId = (
    await db
      .insert(vendors)
      .values({
        companyId: ctx.companyId,
        displayName: 'Window Envelope Supply',
        address: { line1: '9 Paper Way', city: 'Dayton', state: 'OH', zip: '45402' },
      })
      .returning()
  )[0].id;
  for (let i = 0; i < 5; i++) {
    const [c] = await db
      .insert(paymentChecks)
      .values({
        companyId: ctx.companyId,
        kind: 'customer_refund',
        vendorId,
        payeeName: `Payee ${i + 1}`,
        paymentAccountId: bank,
        date: new Date('2026-10-01T12:00:00Z'),
        amount: `${100 + i}.00`,
        toPrint: true,
      })
      .returning();
    checkIds.push(c.id);
  }
}, 180_000);

afterAll(async () => {
  await closeDb(TEST_DIR);
  fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('printer setup storage (0047)', () => {
  it('migration is registered as idx 47 and adds the columns with defaults', async () => {
    const j = JSON.parse(fs.readFileSync(path.resolve('drizzle/meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string; version: string; when: number }>;
    };
    expect(j.entries.filter((e) => e.tag === '0047_check_layouts')).toEqual([
      { idx: 47, version: '7', when: 1781400047000, tag: '0047_check_layouts', breakpoints: true },
    ]);
    const cols = await db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'check_print_settings'`,
    );
    const names = (cols as unknown as { rows: Array<{ column_name: string }> }).rows.map((r) => r.column_name);
    for (const c of ['check_position', 'layout', 'first_sheet_remaining', 'page_size', 'check_height']) expect(names).toContain(c);
    // Re-running the migration is harmless (IF NOT EXISTS).
    const file = fs.readFileSync(path.resolve('drizzle/0047_check_layouts.sql'), 'utf8');
    for (const stmt of file.split('--> statement-breakpoint')) if (stmt.trim()) await db.execute(sql.raw(stmt));
  });

  it('defaults for a company with no setup (and for an old row) print exactly as before', async () => {
    expect(await getCheckPrintSettings(ctx)).toEqual({
      style: 'voucher',
      stock: 'preprinted',
      offsetX: '0.00',
      offsetY: '0.00',
      position: 'top',
      layout: null,
      firstSheetRemaining: 3,
      pageSize: 'letter',
      checkHeight: '3.50',
    });
    // Saving without the new fields (old clients) keeps the defaults.
    const s = await saveCheckPrintSettings(ctx, { style: 'voucher', offsetX: '0', offsetY: '0' });
    expect(s).toMatchObject({ position: 'top', layout: null, firstSheetRemaining: 3, pageSize: 'letter', checkHeight: '3.50' });
  });

  it('saves position, paper, height, first-sheet count and only the moved fields', async () => {
    const s = await saveCheckPrintSettings(ctx, {
      style: 'standard',
      offsetX: '0',
      offsetY: '0',
      position: 'middle',
      pageSize: 'legal',
      checkHeight: '3.25',
      firstSheetRemaining: 2,
      layout: {
        date: { x: '6.65', y: '0.82', size: '10' }, // unchanged → not stored
        payee: { x: '1.1', y: '1.3' },
        address: { show: true },
        checkNumber: { show: false },
      },
    });
    expect(s).toMatchObject({
      style: 'standard',
      position: 'middle',
      pageSize: 'legal',
      checkHeight: '3.25',
      firstSheetRemaining: 2,
      layout: { payee: { x: 1.1, y: 1.3 }, address: { show: true } },
    });
    const [row] = await db.select().from(checkPrintSettings).where(eq(checkPrintSettings.companyId, ctx.companyId));
    expect(row.layout).toEqual({ payee: { x: 1.1, y: 1.3 }, address: { show: true } });

    // Leaving layout out keeps it; null resets to the standard positions.
    expect((await saveCheckPrintSettings(ctx, { style: 'standard', offsetX: '0', offsetY: '0' })).layout).toEqual(s.layout);
    expect((await saveCheckPrintSettings(ctx, { style: 'standard', offsetX: '0', offsetY: '0', layout: null })).layout).toBeNull();
  });

  it.each([
    [{ layout: { signature: { x: 1 } } }, /Unknown check field/],
    [{ layout: { payee: { x: 1, font: 'Courier' } } }, /unknown setting/],
    [{ layout: { payee: { x: 12 } } }, /between/],
    [{ layout: { memo: { size: 2 } } }, /between/],
    [{ layout: { amount: { show: false } } }, /always printed/],
    [{ layout: 'top-left' }, /object/],
    [{ layout: { memo: { y: 3.2 } }, checkHeight: '2.75' }, /within the check height/],
    [{ layout: { date: { x: 7 } }, style: 'wallet' }, /within the check width/],
    [{ position: 'left' }, /top, middle or bottom/],
    [{ pageSize: 'a4' }, /Letter or Legal/],
    [{ checkHeight: '4' }, /between 2.75 and 3.67/],
    [{ checkHeight: 'tall' }, /between 2.75 and 3.67/],
    [{ firstSheetRemaining: 4 }, /1, 2 or 3/],
  ])('rejects %j and keeps the last good setup', async (patch, msg) => {
    const before = await getCheckPrintSettings(ctx);
    await expect(
      saveCheckPrintSettings(ctx, { style: 'standard', offsetX: '0', offsetY: '0', ...(patch as object) }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(msg) });
    expect(await getCheckPrintSettings(ctx)).toEqual(before);
  });

  it('PUT /api/checks/settings passes the new fields through and answers 400 on a bad layout', async () => {
    const ok = await settingsPUT(
      req('/api/checks/settings', 'PUT', {
        style: 'voucher',
        offsetX: '0',
        offsetY: '0',
        position: 'bottom',
        layout: { memo: { x: 0.6 } },
      }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ position: 'bottom', layout: { memo: { x: 0.6 } } });
    const bad = await settingsPUT(
      req('/api/checks/settings', 'PUT', { style: 'voucher', offsetX: '0', offsetY: '0', layout: { memo: { x: 99 } } }),
    );
    expect(bad.status).toBe(400);
    const badPos = await settingsPUT(req('/api/checks/settings', 'PUT', { style: 'voucher', offsetX: '0', offsetY: '0', position: 'side' }));
    expect(badPos.status).toBe(400);
  });

  it('checkPrintData carries the payee address for window envelopes', async () => {
    const d = await checkPrintData(ctx, 'payment_check', checkIds[0]);
    expect(d.payeeAddress).toEqual(['9 Paper Way', 'Dayton, OH 45402']);
  });
});

describe('POST /api/checks/pdf — batch mode', () => {
  const items = (n: number) => checkIds.slice(0, n).map((id, i) => ({ source: 'payment_check', id, checkNumber: String(5001 + i) }));

  it('standard checks: several queued checks in ONE PDF, three per sheet, honouring the first sheet', async () => {
    await saveCheckPrintSettings(ctx, { style: 'standard', offsetX: '0', offsetY: '0', pageSize: 'letter', firstSheetRemaining: 3, layout: null });
    expect(await pages(await pdfPOST(req('/api/checks/pdf', 'POST', { items: items(5) })))).toBe(2);
    expect(await pages(await pdfPOST(req('/api/checks/pdf', 'POST', { items: items(3) })))).toBe(1);
    // One check left on the first sheet: 1 + 3 + 1.
    expect(await pages(await pdfPOST(req('/api/checks/pdf', 'POST', { items: items(5), firstSheetRemaining: 1 })))).toBe(3);
    // The saved setting is the default for the run.
    await saveCheckPrintSettings(ctx, { style: 'standard', offsetX: '0', offsetY: '0', firstSheetRemaining: 2 });
    expect(await pages(await pdfPOST(req('/api/checks/pdf', 'POST', { items: items(3) })))).toBe(2);
    const res = await pdfPOST(req('/api/checks/pdf', 'POST', { items: items(2) }));
    expect(res.headers.get('content-disposition')).toContain('checks-5001-5002.pdf');
  });

  it('voucher checks: one per sheet', async () => {
    await saveCheckPrintSettings(ctx, { style: 'voucher', offsetX: '0', offsetY: '0', position: 'middle' });
    expect(await pages(await pdfPOST(req('/api/checks/pdf', 'POST', { items: items(4) })))).toBe(4);
  });

  it('refuses an empty batch, a malformed item, a bad first-sheet count and checks of another company', async () => {
    expect((await pdfPOST(req('/api/checks/pdf', 'POST', { items: [] }))).status).toBe(400);
    expect((await pdfPOST(req('/api/checks/pdf', 'POST', { items: [{ source: 'cash', id: checkIds[0] }] }))).status).toBe(400);
    expect((await pdfPOST(req('/api/checks/pdf', 'POST', { items: items(1), firstSheetRemaining: 5 }))).status).toBe(400);
    expect(
      (await pdfPOST(req('/api/checks/pdf', 'POST', { items: [{ source: 'payment_check', id: '00000000-0000-0000-0000-000000000000' }] }))).status,
    ).toBe(404);
  });

  it('single-check and alignment-test modes still work; the test page uses the unsaved setup', async () => {
    expect(await pages(await pdfPOST(req('/api/checks/pdf', 'POST', { source: 'payment_check', id: checkIds[0], checkNumber: '6001' })))).toBe(1);
    // Unsaved: standard style with two checks left → two sample checks on one sheet.
    expect(
      await pages(
        await pdfPOST(
          req('/api/checks/pdf', 'POST', {
            alignmentTest: true,
            style: 'standard',
            firstSheetRemaining: 2,
            layout: { address: { show: true } },
            pageSize: 'legal',
          }),
        ),
      ),
    ).toBe(1);
    const bad = await pdfPOST(req('/api/checks/pdf', 'POST', { alignmentTest: true, layout: { payee: { x: -3 } } }));
    expect(bad.status).toBe(400);
    // Nothing was saved by the test page.
    expect((await getCheckPrintSettings(ctx)).pageSize).toBe('letter');
  });
});
