/**
 * Scanned bank statements (office feedback: a scanned PDF was not read, outflows were not
 * negative, and the beginning / ending balances had to be typed in by hand):
 *   - every scanned page is OCR'd, even when each page carries a little text (a scanner's stamp,
 *     a page number) — a scan used to be read only when the whole file had almost no text;
 *   - OCR words are rebuilt into rows with their x positions (lib/statements/ocrLines.ts), so the
 *     Withdrawals / Deposits columns and the running balance decide the signs;
 *   - amounts misread by OCR are repaired; balances are found next to their own label, in summary
 *     tables, under more wordings, or from the running balance;
 *   - a checking statement read into a credit-card account (or the reverse) is called out;
 *   - the real offline OCR engine reads a real scanned page end to end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, bankAccounts } from '@/lib/db/schema';
import { encodePng } from '@/lib/receipts/png';
import { getOcrEngine } from '@/lib/receipts/ocr';
import { fixOcrMoney, wordsToLines, type OcrWord } from '@/lib/statements/ocrLines';
import { parseStatementText } from '@/lib/statements/parse';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { assistStatement, extractBankFile, statementTypeHint } from './statementImport';
import { updateSettings } from './aiSettings';
import type { FetchLike } from '@/lib/ai/providers';
import { setHostLookup } from '@/lib/net/tailnetVerify';

/** A local Ollama stand-in that answers every chat with `content`. */
function ollama(content: string) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetch: FetchLike = async (url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen2.5:14b' }] }), { status: 200 });
    return new Response(JSON.stringify({ model: 'qwen2.5:14b', message: { role: 'assistant', content } }), { status: 200 });
  };
  return { fetch, calls };
}

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-statement-scan');
const SCAN_JPG = path.resolve(process.cwd(), 'test', 'fixtures', 'scanned-statement-page.jpg');
let db: DB;
let ctx: ServiceContext;
let checking: string;
let cardLinked: string;

/** Words of one printed line, laid out left to right at height y (x of each word given). */
function row(y: number, ...cells: Array<[number, string]>): OcrWord[] {
  return cells.flatMap(([x, text]) => text.split(' ').map((w, i) => ({ text: w, x0: x + i * 60, x1: x + i * 60 + 50, y0: y, y1: y + 22 })));
}

const PAGE_WORDS: OcrWord[] = [
  ...row(100, [120, 'FIRST COMMUNITY BANK']),
  ...row(170, [120, 'Business Checking Statement']),
  ...row(215, [120, 'Statement Period: 10/01/2026 through 10/31/2026']),
  ...row(300, [120, 'Beginning Balance'], [1300, 'S5,000.00']),
  ...row(345, [120, 'Ending Balance'], [1300, '$5,56O.65']),
  ...row(450, [120, 'Date'], [260, 'Description'], [900, 'Withdrawals'], [1130, 'Deposits'], [1370, 'Balance']),
  ...row(520, [120, '10/02'], [260, 'SHELL OIL'], [960, '42.10'], [1370, '4,957.90']),
  ...row(575, [120, '10/05'], [260, 'DEPOSIT MOBILE'], [1150, '1,250.00'], [1370, '6,207.90']),
  ...row(630, [120, '10/09'], [260, 'CHECK 1043'], [960, '600.00'], [1370, '5,607.90']),
  ...row(685, [120, '10/30'], [260, 'STRIPE TRANSFER'], [1150, '48.75'], [1370, '5,656.65']),
  ...row(740, [120, '10/31'], [260, 'SERVICE FEE'], [960, '96.00'], [1370, '5,560.65']),
];

/** A PDF of `pages` scanned pages (a grey image each), each with a scanner's stamp as text. */
async function scannedPdf(pages: number, stamp: string | null): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const png = await pdf.embedPng(encodePng(400, 520, new Uint8Array(400 * 520).fill(200), 1));
  for (let p = 1; p <= pages; p++) {
    const page = pdf.addPage([612, 792]);
    page.drawImage(png, { x: 0, y: 0, width: 612, height: 792 });
    if (stamp) page.drawText(`${stamp} - page ${p}`, { x: 20, y: 10, size: 7, font });
  }
  return pdf.save();
}

describe('scanned bank statements', () => {
  beforeAll(async () => {
    setHostLookup(async () => []);
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'scan@test.local', name: 'S', passwordHash: 'x' }).returning();
    const [c] = await db.insert(companies).values({ name: 'Scan Co', ownerId: u.id }).returning();
    ctx = { db, companyId: c.id, userId: u.id };
    const chk = await createAccount(ctx, { code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' });
    const card = await createAccount(ctx, { code: '2100', name: 'Credit Card', type: 'liability', subtype: 'credit_card' });
    [{ id: checking }] = await db.insert(bankAccounts).values({ companyId: c.id, accountId: chk.id, bankName: 'Sample', accountNumber: '0000' }).returning();
    [{ id: cardLinked }] = await db.insert(bankAccounts).values({ companyId: c.id, accountId: card.id, bankName: 'Chase', accountNumber: '1110' }).returning();
  });
  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  describe('OCR words → rows', () => {
    it('repairs OCR misreads in amounts, and leaves other text alone', () => {
      expect(fixOcrMoney('Beginning Balance S5,000.00')).toBe('Beginning Balance $5,000.00');
      expect(fixOcrMoney('Ending Balance $5,56O.65')).toBe('Ending Balance $5,560.65');
      expect(fixOcrMoney('10/02 SHELL 1,2l0.00 4, 957.90')).toBe('10/02 SHELL 1,210.00 4,957.90');
      expect(fixOcrMoney('FEE 42 .10')).toBe('FEE 42.10');
      expect(fixOcrMoney('FEE 42,10')).toBe('FEE 42.10');
      expect(fixOcrMoney('$ 300.00')).toBe('$300.00');
      expect(fixOcrMoney('Period October 1, 2026 to October 31, 2026')).toBe('Period October 1, 2026 to October 31, 2026');
      expect(fixOcrMoney('SHELL OIL 57444 HOUSTON TX')).toBe('SHELL OIL 57444 HOUSTON TX');
    });

    it('rebuilds table rows when OCR returns the columns one after another, and on a crooked scan', () => {
      // Column by column, as Tesseract's blocks often come for a table.
      const shuffled = [...PAGE_WORDS].sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0);
      const lines = wordsToLines(shuffled).map((l) => l.text);
      expect(lines).toContain('10/02 SHELL OIL 42.10 4,957.90');
      expect(lines).toContain('Beginning Balance $5,000.00');
      // Tilted about 1°: each word sits a little lower than the one to its left.
      const tilted = PAGE_WORDS.map((w) => ({ ...w, y0: w.y0 + w.x0 * 0.017, y1: w.y1 + w.x0 * 0.017 }));
      expect(wordsToLines(tilted).map((l) => l.text)).toContain('10/05 DEPOSIT MOBILE 1,250.00 6,207.90');
    });

    it('signs, balances and tie-out come out right from OCR rows (columns + running balance)', () => {
      const parsed = parseStatementText(wordsToLines(PAGE_WORDS), { kind: 'bank', fallbackYear: 2026 });
      expect(parsed.openingBalance).toBe('5000.00');
      expect(parsed.closingBalance).toBe('5560.65');
      expect(parsed.rows.map((r) => r.amount)).toEqual(['-42.10', '1250.00', '-600.00', '48.75', '-96.00']);
    });
  });

  describe('balances', () => {
    const kind = { kind: 'bank' as const, fallbackYear: 2026 };
    const rows = ['10/02 SHELL OIL 42.10 4,957.90', '10/05 DEPOSIT MOBILE 1,250.00 6,207.90'];
    const parse = (head: string[], body = rows) => parseStatementText([...head, ...body].map((text) => ({ text })), kind);

    it('both balances on one line: each takes the amount after its own label', () => {
      const p = parse(['Beginning Balance $5,000.00 Ending Balance $6,207.90']);
      expect([p.openingBalance, p.closingBalance]).toEqual(['5000.00', '6207.90']);
    });

    it('an account summary table: the amounts on the next line follow the column labels', () => {
      const p = parse(['Beginning Balance Deposits Withdrawals Ending Balance', '$5,000.00 $1,250.00 $42.10 $6,207.90']);
      expect([p.openingBalance, p.closingBalance]).toEqual(['5000.00', '6207.90']);
      const q = parse(['Deposits Beginning Balance Withdrawals Ending Balance', '1,250.00 5,000.00 42.10 6,207.90']);
      expect([q.openingBalance, q.closingBalance]).toEqual(['5000.00', '6207.90']);
    });

    it('"Balance Forward" and "Balance this statement" wordings', () => {
      const p = parse(['10/01 BALANCE FORWARD 5,000.00'], [...rows, 'BALANCE THIS STATEMENT 6,207.90']);
      expect([p.openingBalance, p.closingBalance]).toEqual(['5000.00', '6207.90']);
      expect(p.rows).toHaveLength(2); // the balance-forward line is not a transaction
    });

    it('no balances printed: the running balance column gives them (and says so)', () => {
      const p = parseStatementText(
        ['Date Description Withdrawals Deposits Balance', ...rows].map((text, i) => ({
          text,
          cells: i === 0 ? [{ x: 0, str: 'Date' }, { x: 100, str: 'Description' }, { x: 900, str: 'Withdrawals' }, { x: 1130, str: 'Deposits' }, { x: 1370, str: 'Balance' }] : undefined,
        })),
        kind,
      );
      expect(p.closingBalance).toBe('6207.90');
      expect(p.warnings.join(' ')).toMatch(/ending balance was taken from the last running balance/);
    });
  });

  it('tells a checking statement from a credit card statement', () => {
    expect(statementTypeHint('Business Checking Statement\nBeginning Balance\nDeposits and Other Credits\nWithdrawals')).toBe('bank');
    expect(statementTypeHint('Payment Due Date 11/25\nMinimum Payment Due\nCredit Limit\nNew Balance')).toBe('card');
    expect(statementTypeHint('Invoice 1001')).toBeNull();
  });

  describe('scanned PDFs, end to end', () => {
    const fakeOcr = () => {
      const calls: number[] = [];
      return {
        calls,
        engine: {
          recognize: async () => '',
          recognizeWords: async (img: Buffer) => {
            calls.push(img.length);
            return PAGE_WORDS;
          },
        },
      };
    };

    it('reads every scanned page even when each page carries a scanner stamp', async () => {
      const ocr = fakeOcr();
      const bytes = await scannedPdf(6, 'Scanned with OfficeJet Pro 9015 on 11/17/2026');
      const r = await extractBankFile(ctx, { bankAccountId: checking, filename: 'scan.pdf', bytes }, { ocr: ocr.engine });
      expect(ocr.calls).toHaveLength(6); // used to be 0: six stamp lines counted as a text layer
      if (r.kind !== 'statement') throw new Error('expected a statement');
      expect(r.method).toBe('ocr');
      expect(r.text).toContain('SHELL OIL');
      expect(r.rows[0]).toMatchObject({ description: 'SHELL OIL', amount: '-42.10' });
    });

    it('a checking statement read into an account linked to a credit card is called out', async () => {
      const ocr = fakeOcr();
      const r = await extractBankFile(ctx, { bankAccountId: cardLinked, filename: 'scan.pdf', bytes: await scannedPdf(1, null) }, { ocr: ocr.engine });
      if (r.kind !== 'statement') throw new Error('expected a statement');
      expect(r.warnings[0]).toMatch(/looks like a CHECKING or SAVINGS statement, but this bank account is linked to a credit card/);
    });

    it('without the OCR engine, a scan says what is missing', async () => {
      await expect(
        extractBankFile(ctx, { bankAccountId: checking, filename: 'scan.pdf', bytes: await scannedPdf(1, null) }, { ocr: null }),
      ).rejects.toThrow(/offline text reader is not installed/);
    });

    it('the real offline OCR reads a real scanned statement page: rows, signs, balances, tie-out', async () => {
      const engine = await getOcrEngine();
      expect(engine).not.toBeNull();
      const pdf = await PDFDocument.create();
      const img = await pdf.embedJpg(fs.readFileSync(SCAN_JPG));
      pdf.addPage([612, 792]).drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
      const r = await extractBankFile(ctx, { bankAccountId: checking, filename: 'october.pdf', bytes: await pdf.save() }, { ocr: engine });
      if (r.kind !== 'statement') throw new Error('expected a statement');
      expect(r.method).toBe('ocr');
      expect([r.openingBalance, r.closingBalance]).toEqual(['5000.00', '5560.65']);
      expect(r.rows.map((x) => x.amount)).toEqual(['-42.10', '1250.00', '-600.00', '-312.25', '480.00', '-15.00', '-200.00']);
      expect(r.tieOut.ok).toBe(true);
    }, 120_000);
  });
  describe('Fix with AI on the review screen', () => {
    const rowsNow = [
      { date: '2026-10-02', description: 'SHELL OIL', amount: '42.10' }, // OCR lost the sign
      { date: '2026-10-05', description: 'DEPOSIT MOBILE', amount: '1250.00' },
    ];

    it('without an AI set up, says so plainly', async () => {
      await expect(
        assistStatement(ctx, { bankAccountId: checking, text: 'x', rows: rowsNow, openingBalance: '5000.00', closingBalance: '6165.80' }),
      ).rejects.toThrow(/No AI is set up|could not help/);
    });

    it("sends the rows, balances, statement text and the person's note; returns the corrected list and tie-out", async () => {
      await updateSettings(ctx, { providers: [{ kind: 'ollama', label: 'GPU', baseUrl: 'http://100.80.1.2:11434', model: 'qwen2.5:14b', enabled: true }] });
      const m = ollama(
        JSON.stringify({
          openingBalance: '5000.00',
          closingBalance: '6207.90',
          rows: [
            { date: '2026-10-02', description: 'SHELL OIL', amount: '-42.10' },
            { date: '2026-10-05', description: 'DEPOSIT MOBILE', amount: '1250.00' },
          ],
          notes: 'Row 1 is a withdrawal, so it is negative; the ending balance is 6,207.90.',
        }),
      );
      const r = await assistStatement(
        ctx,
        {
          bankAccountId: checking,
          text: ['Beginning Balance $5,000.00', '10/02 SHELL OIL 42.10 4,957.90', '10/05 DEPOSIT MOBILE 1,250.00 6,207.90', 'Ending Balance $6,207.90'].join('\n'),
          rows: rowsNow,
          openingBalance: '5000.00',
          closingBalance: null,
          instruction: 'the shell row is money out',
        },
        { routerOpts: { deps: { fetch: m.fetch } } },
      );
      expect(r.rows.map((x) => x.amount)).toEqual(['-42.10', '1250.00']);
      expect(r.rows.every((x) => x.signFrom === 'ai')).toBe(true);
      expect(r.closingBalance).toBe('6207.90');
      expect(r.tieOut.ok).toBe(true);
      expect(r.notes).toMatch(/withdrawal/);
      const prompt: string = m.calls.find((c) => c.url.endsWith('/api/chat'))!.body.messages.at(-1).content;
      expect(prompt).toContain('This is a BANK account');
      expect(prompt).toContain('"the shell row is money out"');
      expect(prompt).toContain('1. 2026-10-02 | SHELL OIL | 42.10');
      expect(prompt).toContain('Ending Balance $6,207.90');
    });

    it("another company's bank account is not found", async () => {
      await expect(
        assistStatement({ ...ctx, companyId: '00000000-0000-0000-0000-000000000000' }, { bankAccountId: checking, text: 'x', rows: [], openingBalance: null, closingBalance: null }),
      ).rejects.toThrow(/not found/i);
    });
  });
});
