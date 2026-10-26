/**
 * Review round 5 (team banking) — receipt capture regressions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { attachments, expenses } from '@/lib/db/schema';
import { ServiceError } from './_base';
import { createVendor } from './vendors';
import { updateAttachment } from './attachments';
import { deleteReceipt, getReceipt, saveReceipt, uploadReceipt } from './receipts';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
const jpegBytes = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);

async function expectCode(p: Promise<unknown>, code: string, msg?: RegExp) {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'expected the call to fail').toBeInstanceOf(ServiceError);
  expect((caught as ServiceError).code).toBe(code);
  if (msg) expect((caught as Error).message).toMatch(msg);
}

beforeAll(async () => {
  t = await makeTestCompany('receipts-r5');
});
afterAll(async () => {
  await t.cleanup();
});

describe('receipt capture (review 5)', () => {
  it('saving a receipt dated on a day that does not exist is refused (not rolled into the next month)', async () => {
    const r = await uploadReceipt(t.ctx, { filename: 'a.jpg', bytes: jpegBytes() });
    await expectCode(
      saveReceipt(t.ctx, r.id, {
        version: r.version,
        kind: 'expense',
        payeeName: 'Shop',
        date: '2026-02-30',
        total: '5.00',
        accountId: t.acct['6300'],
        paymentAccountId: t.acct['1000'],
      }),
      'VALIDATION',
      /date/i,
    );
    const made = await t.db.select().from(expenses).where(eq(expenses.companyId, t.ctx.companyId));
    expect(made).toHaveLength(0);
  });

  it('deleting a receipt that was filed to a record in the Doc Center does not delete that record’s document', async () => {
    const r = await uploadReceipt(t.ctx, { filename: 'b.jpg', bytes: jpegBytes() });
    const v = await createVendor(t.ctx, { displayName: 'Filed Vendor' });
    await updateAttachment(t.ctx, r.attachmentId, { entityType: 'vendor', entityId: v.id });
    await expectCode(deleteReceipt(t.ctx, r.id), 'VALIDATION', /Doc Center/);
    const [att] = await t.db.select().from(attachments).where(eq(attachments.id, r.attachmentId));
    expect(att?.entityId).toBe(v.id);
    expect((await getReceipt(t.ctx, r.id)).id).toBe(r.id);
  });
});

describe('reading a receipt whose text has an impossible amount', () => {
  it('an amount too large for the books (an OCR misread) is left blank instead of failing the read for good', async () => {
    const { extractReceipt } = await import('./receipts');
    const { setOcrEngineForTests } = await import('@/lib/receipts/ocr');
    setOcrEngineForTests({ recognize: async () => 'CORNER STORE\n03/14/2026\nTOTAL 123456789012345.67\nVISA ****4417' });
    try {
      const r = await uploadReceipt(t.ctx, { filename: 'c.jpg', bytes: jpegBytes() });
      const read = await extractReceipt(t.ctx, r.id);
      expect(read.status).toBe('ready');
      expect(read.total).toBeNull();
      expect(read.date).toBe('2026-03-14');
      expect(read.cardLast4).toBe('4417');
    } finally {
      setOcrEngineForTests(undefined);
    }
  });
});
