/**
 * Review loop 6 fixes (receipts, reports):
 *  - a count before an amount is not read into it ("TOTAL 2 125.00" is 125.00); a dot leader
 *    before a total is not a card number;
 *  - voiding the expense a receipt was saved as puts the receipt back in the inbox;
 *  - a receipt for a charge already in the books is flagged as a possible duplicate;
 *  - one Retained Earnings account for the close and every report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { attachments, receiptScans } from '@/lib/db/schema';
import { amountsInLine, parseReceiptText } from '@/lib/receipts/parse';
import { setOcrEngineForTests } from '@/lib/receipts/ocr';
import { extractReceipt, getReceipt, receiptSuggestions, saveReceipt, uploadReceipt } from './receipts';
import { createExpense, voidExpense } from './expenses';
import { pickRetainedEarnings } from './retainedEarnings';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
const jpegBytes = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const RECEIPT = `HARDWARE PLUS
03/14/2026
LUMBER 2X4        19.99
TOTAL             19.99
VISA ************4417`;

async function readyReceipt() {
  setOcrEngineForTests({ recognize: async () => RECEIPT });
  const r = await uploadReceipt(t.ctx, { filename: 'photo.jpg', bytes: jpegBytes() });
  return extractReceipt(t.ctx, r.id);
}

beforeAll(async () => {
  t = await makeTestCompany('review6');
}, 120_000);
afterAll(async () => {
  setOcrEngineForTests(undefined);
  await t.cleanup();
});

describe('receipt text', () => {
  it('a count before an amount stays separate; space grouping only with a decimal comma', () => {
    expect(amountsInLine('TOTAL 2 125.00')).toEqual(['125.00']);
    expect(amountsInLine('Qty 1 120.00')).toEqual(['120.00']);
    expect(amountsInLine('1 234,56 €')).toEqual(['1234.56']);
    expect(amountsInLine('$1,234.56')).toEqual(['1234.56']);
    expect(amountsInLine('1.234,56')).toEqual(['1234.56']);
  });

  it('a dot leader before a total is not a card number', () => {
    const r = parseReceiptText('SHOP\nTotal ........ 1045.00\n');
    expect(r.total).toBe('1045.00');
    expect(r.cardLast4 ?? null).toBeNull();
    expect(parseReceiptText('SHOP\nTotal 9.99\nVISA ....4417\n').cardLast4).toBe('4417');
  });
});

describe('receipts and their transactions', { timeout: 120_000 }, () => {
  it('voiding the expense puts the receipt back in the inbox, ready to book again', async () => {
    const r = await readyReceipt();
    const res = await saveReceipt(t.ctx, r.id, {
      version: r.version,
      kind: 'expense',
      payeeName: 'Hardware Plus',
      date: '2026-03-14',
      total: '19.99',
      accountId: t.acct['6300'],
      paymentAccountId: t.acct['1000'],
    });
    await voidExpense(t.ctx, res.txnId);
    const after = await getReceipt(t.ctx, r.id);
    expect(after.status).toBe('ready');
    expect(after.txnId ?? null).toBeNull();
    // Back in the inbox (To review lists unfiled receipts).
    const [att] = await t.db.select().from(attachments).where(eq(attachments.id, r.attachmentId));
    expect(att.entityId ?? null).toBeNull();
    // ...and it can be saved again.
    const again = await saveReceipt(t.ctx, r.id, {
      version: after.version,
      kind: 'expense',
      payeeName: 'Hardware Plus',
      date: '2026-03-14',
      total: '19.99',
      accountId: t.acct['6300'],
      paymentAccountId: t.acct['1000'],
    });
    expect(again.txnType).toBe('expense');
    const [scan] = await t.db.select().from(receiptScans).where(eq(receiptScans.id, r.id));
    expect(scan.txnId).toBe(again.txnId);
    const [moved] = await t.db.select().from(attachments).where(eq(attachments.id, r.attachmentId));
    expect(moved.entityId).toBe(again.txnId);
  });

  it('flags a charge already in the books for the same amount', async () => {
    await createExpense(t.ctx, {
      payeeName: 'Hardware Plus',
      date: new Date('2026-03-15T12:00:00Z'),
      method: 'cash',
      paymentAccountId: t.acct['1000'],
      lines: [{ accountId: t.acct['6300'], amount: '19.99' }],
    });
    const r = await readyReceipt();
    const s = await receiptSuggestions(t.ctx, r.id);
    expect(s.possibleDuplicates.some((x) => x.txnType === 'expense' && x.amount === '19.99')).toBe(true);
  });
});

describe('Retained Earnings account', () => {
  const acct = (code: string, name: string, subtype: string | null, isActive = true) => ({ code, name, subtype, isActive, equity: true });
  it('prefers an active Retained Earnings account, 3900 first, then a legacy 3900 / named one', () => {
    expect(pickRetainedEarnings([acct('3000', 'Old RE', 'retained_earnings', false), acct('3900', 'Retained Earnings', 'retained_earnings')])?.code).toBe('3900');
    expect(pickRetainedEarnings([acct('3800', 'RE 2', 'retained_earnings'), acct('3700', 'RE 1', 'retained_earnings')])?.code).toBe('3700');
    expect(pickRetainedEarnings([acct('3000', "Owner's Equity", 'owners_equity'), acct('3900', 'Retained Earnings', 'owners_equity')])?.code).toBe('3900');
    expect(pickRetainedEarnings([acct('3000', 'Opening Balance Equity', 'owners_equity')])).toBeNull();
  });
});
