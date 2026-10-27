/**
 * Review round 5 — bank file / statement import (lib/services/import.ts, POST /api/import).
 *
 *  A. Amounts the file cannot really hold are refused, never staged as NaN: a "-" placeholder in
 *     an empty Debit / Credit cell, "(25.00)" or "-25.00" in a Debit column, "NaN" / "abc" in the
 *     Amount column, an OFX TRNAMT of NaN, a reviewed statement row "NaN".
 *  B. An impossible calendar date (Feb 30 from an OCR misread, 31/04 with a DD/MM format) is a
 *     400, never silently moved into the next month.
 *  C. A reviewed-rows request with a row that is not an object is a 400, not a 500.
 *  D. The same file imported twice at once (double click, two windows) stages every line once.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, bankTransactions, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createBankAccount } from './bankAccounts';
import { importTransactions, parseCSV, parseOFX, parseRows } from './import';

let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));
import { POST as importPOST } from '@/app/api/import/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-import-review5');
let db: DB;
let userId: string;

async function bankCo(name: string, acctNo: string) {
  const co = await createCompany(db, { name, ownerId: userId });
  const ctx: ServiceContext = { db, companyId: co.id, userId };
  const [checking] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.subtype, 'checking')));
  const ba = await createBankAccount(ctx, { accountId: checking.id, bankName: 'Bank', accountNumber: acctNo });
  return { ctx, ba };
}

const staged = (bankAccountId: string) =>
  db
    .select({ date: bankTransactions.date, amount: bankTransactions.amount, description: bankTransactions.description })
    .from(bankTransactions)
    .where(eq(bankTransactions.bankAccountId, bankAccountId));

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'import-r5@test.local', name: 'R5', passwordHash: 'x' }).returning();
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

const SPLIT = { dateCol: 'Date', descriptionCol: 'Description', amountCol: 'Amount', debitCol: 'Debit', creditCol: 'Credit' };
const SINGLE = { dateCol: 'Date', descriptionCol: 'Description', amountCol: 'Amount' };

describe('A. amounts are read as money or refused — never NaN', () => {
  it('Debit / Credit columns: "-" placeholders are blank, a signed or bracketed debit is still money out', () => {
    const csv = [
      'Date,Description,Debit,Credit',
      '01/05/2026,Coffee,5.00,-',
      '01/06/2026,Deposit,-,100.00',
      '01/07/2026,Signed debit,-25.00,',
      '01/08/2026,Bracketed debit,(30.00),',
      '01/09/2026,Dollar credit,,"$1,250.50"',
    ].join('\n');
    expect(parseCSV(csv, SPLIT).map((t) => t.amount)).toEqual(['-5.00', '100.00', '-25.00', '-30.00', '1250.50']);
  });

  it('Amount column: "(12.50)" is a withdrawal; "NaN", "abc" and "Infinity" refuse the file with the row number', () => {
    const ok = ['Date,Description,Amount', '01/05/2026,Fee,(12.50)', '01/06/2026,Pay,"1,000.00"', '01/07/2026,Back,12.50-'].join('\n');
    expect(parseCSV(ok, SINGLE).map((t) => t.amount)).toEqual(['-12.50', '1000.00', '-12.50']);
    for (const bad of ['NaN', 'abc', 'Infinity', '12..5']) {
      expect(() => parseCSV(`Date,Description,Amount\n01/05/2026,X,${bad}\n`, SINGLE)).toThrow(/row 1.*not an amount/i);
    }
    // Garbage in a Debit / Credit cell (digits it cannot read) is refused too.
    expect(() => parseCSV('Date,Description,Debit,Credit\n01/05/2026,X,12.3.4,\n', SPLIT)).toThrow(/row 1.*not an amount/i);
  });

  it('OFX TRNAMT and reviewed statement rows must be numbers', () => {
    const ofx = '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260105<TRNAMT>NaN<FITID>1<NAME>X</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
    expect(() => parseOFX(ofx)).toThrow(/not an amount/i);
    expect(() => parseRows([{ date: '2026-01-05', description: 'x', amount: 'NaN' }])).toThrow(/not an amount/);
    expect(() => parseRows([{ date: '2026-01-05', description: 'x', amount: 'Infinity' }])).toThrow(/not an amount/);
  });

  it('nothing is staged from a file with an unreadable amount', async () => {
    const { ctx, ba } = await bankCo('NaN Co', '111111111');
    const csv = ['Date,Description,Amount', '01/05/2026,Good,10.00', '01/06/2026,Bad,NaN'].join('\n');
    await expect(importTransactions(ctx, { bankAccountId: ba.id, fileType: 'csv', content: csv, csvMapping: SINGLE })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    await expect(
      importTransactions(ctx, { bankAccountId: ba.id, fileType: 'rows', content: '', rows: [{ date: '2026-01-05', description: 'x', amount: 'NaN' }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await staged(ba.id)).toEqual([]);
  });
});

describe('B. impossible calendar dates are refused', () => {
  it('a reviewed row dated 2026-02-30 and a 31/04 DD/MM date are 400s, not March 2 / May 1', async () => {
    expect(() => parseRows([{ date: '2026-02-30', description: 'OCR misread', amount: '5.00' }])).toThrow(/Row 1/);
    expect(() => parseRows([{ date: '2026-13-01', description: 'x', amount: '5.00' }])).toThrow(/Row 1/);
    expect(parseRows([{ date: '2024-02-29', description: 'leap day', amount: '5.00' }])[0].date.toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(() => parseCSV('Date,Description,Amount\n31/04/2026,X,1.00\n', { ...SINGLE, dateFormat: 'DD/MM/YYYY' })).toThrow(/cannot parse date/);
    expect(() => parseCSV('Date,Description,Amount\n02/30/2026,X,1.00\n', SINGLE)).toThrow(/cannot parse date/);
    expect(parseCSV('Date,Description,Amount\n30/04/2026,X,1.00\n', { ...SINGLE, dateFormat: 'DD/MM/YYYY' })[0].date.toISOString()).toBe('2026-04-30T00:00:00.000Z');
    const { ctx, ba } = await bankCo('Date Co', '222222222');
    await expect(
      importTransactions(ctx, { bankAccountId: ba.id, fileType: 'rows', content: '', rows: [{ date: '2026-02-30', description: 'x', amount: '5.00' }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await staged(ba.id)).toEqual([]);
  });
});

describe('C. POST /api/import with reviewed rows', () => {
  const post = (body: unknown) => {
    const u = new URL('http://localhost/api/import');
    return Object.assign(new Request(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { nextUrl: u }) as never;
  };
  it('a row that is not an object is a plain 400', async () => {
    const { ctx, ba } = await bankCo('Route Co', '333333333');
    routeCtx = ctx;
    for (const rows of [[null], ['5.00'], [{ date: '2026-01-05', description: 'x', amount: '5.00' }, 7]]) {
      const res = await importPOST(post({ bankAccountId: ba.id, fileType: 'rows', statement: { kind: 'bank', openingBalance: '0.00', closingBalance: '5.00' }, rows }));
      expect([JSON.stringify(rows), res.status]).toEqual([JSON.stringify(rows), 400]);
      expect((await res.json()).error).not.toMatch(/internal/i);
    }
    expect(await staged(ba.id)).toEqual([]);
  });
});

describe('D. the same file imported twice at once', () => {
  it('stages each line once', async () => {
    const { ctx, ba } = await bankCo('Double Co', '444444444');
    const csv = ['Date,Description,Amount', '01/05/2026,Coffee,-5.00', '01/06/2026,Deposit,100.00', '01/06/2026,Deposit,100.00'].join('\n');
    const runs = await Promise.all([1, 2, 3].map(() => importTransactions(ctx, { bankAccountId: ba.id, fileType: 'csv', content: csv, csvMapping: SINGLE })));
    expect(runs.reduce((n, r) => n + r.imported, 0)).toBe(3);
    expect(runs.reduce((n, r) => n + r.skippedDupes, 0)).toBe(6);
    expect((await staged(ba.id)).length).toBe(3);
  });
});
