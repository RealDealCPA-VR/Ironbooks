/**
 * Statement files without a bank connection (lib/services/statementImport.ts), end to end:
 * a real PDF (text layer) is read, parsed and tied out; a scan goes through OCR; an .xlsx
 * becomes CSV for the column mapper; an unrecognized layout falls back to the company's AI;
 * reviewed rows import with payee and dedupe; the import route refuses rows that do not tie out
 * unless the person acknowledged the difference.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, bankAccounts, bankTransactions, auditLogs } from '@/lib/db/schema';
import { buildXlsx } from '@/lib/export/xlsx';
import type { FetchLike } from '@/lib/ai/providers';
import type { ServiceContext } from './_base';
import { createAccount } from './accounts';
import { updateSettings } from './aiSettings';
import { extractBankFile } from './statementImport';
import { importTransactions, parseCSV } from './import';
import { setHostLookup } from '@/lib/net/tailnetVerify';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { POST as importPOST } from '@/app/api/import/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-statement-import');
let db: DB;
let checking: string; // bank_accounts.id
let visa: string;

const STATEMENT = [
  'First Community Bank',
  'Statement Period: 01/01/2026 through 01/31/2026',
  'Beginning Balance $2,500.00',
  'Date Description Amount Balance',
  '01/03 DEPOSIT MOBILE 1,200.00 3,700.00',
  '01/05 CHECK 1043 150.00 3,550.00',
  '01/09 SHELL OIL 57442191 45.10 3,504.90',
  '01/15 ONLINE TRANSFER TO SAVINGS 500.00 3,004.90',
  '01/28 INTEREST PAID 0.42 3,005.32',
  'Ending Balance $3,005.32',
];

async function statementPdf(lines: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  lines.forEach((t, i) => page.drawText(t, { x: 40, y: 740 - i * 18, size: 10, font }));
  return pdf.save();
}

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

describe('bank statement files', () => {
  beforeAll(async () => {
    setHostLookup(async () => []);
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    db = await getDb(TEST_DIR);
    const [u] = await db.insert(users).values({ email: 'stmt@test.local', name: 'S', passwordHash: 'x' }).returning();
    const [c] = await db.insert(companies).values({ name: 'Statement Co', ownerId: u.id }).returning();
    ctx = { db, companyId: c.id, userId: u.id };
    const chk = await createAccount(ctx, { code: '1000', name: 'Checking', type: 'asset', subtype: 'checking' });
    const card = await createAccount(ctx, { code: '2100', name: 'Visa', type: 'liability', subtype: 'credit_card' });
    [{ id: checking }] = await db.insert(bankAccounts).values({ companyId: c.id, accountId: chk.id, bankName: 'First Community', accountNumber: '1234' }).returning();
    [{ id: visa }] = await db.insert(bankAccounts).values({ companyId: c.id, accountId: card.id, bankName: 'Visa', accountNumber: '9999' }).returning();
  });
  afterAll(async () => {
    await closeDb();
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Windows may hold a handle; next run wipes it. */
    }
  });

  it('a PDF statement is read from its text layer, parsed and tied out', async () => {
    const r = await extractBankFile(ctx, { bankAccountId: checking, filename: 'jan.pdf', bytes: await statementPdf(STATEMENT) }, { ocr: null });
    expect(r.kind).toBe('statement');
    if (r.kind !== 'statement') return;
    expect(r.method).toBe('text');
    expect(r.rows.map((x) => x.amount)).toEqual(['1200.00', '-150.00', '-45.10', '-500.00', '0.42']);
    expect(r.tieOut).toMatchObject({ ok: true, difference: '0.00' });
    expect(r.statementKind).toBe('bank');
  });

  it('a photo or scan goes through the offline OCR engine', async () => {
    const ocr = { recognize: vi.fn(async () => STATEMENT.join('\n')) };
    const r = await extractBankFile(ctx, { bankAccountId: checking, filename: 'page1.jpg', bytes: new Uint8Array([1, 2, 3]) }, { ocr });
    expect(ocr.recognize).toHaveBeenCalledTimes(1);
    expect(r.kind === 'statement' && r.method).toBe('ocr');
    expect(r.kind === 'statement' && r.tieOut.ok).toBe(true);
    await expect(
      extractBankFile(ctx, { bankAccountId: checking, filename: 'page1.jpg', bytes: new Uint8Array([1]) }, { ocr: null }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/offline text reader is not installed/) });
  });

  it('an Excel statement becomes CSV text for the column mapper', async () => {
    const xlsx = buildXlsx({
      columns: [{ header: 'Date' }, { header: 'Description' }, { header: 'Payee' }, { header: 'Amount', numeric: true }],
      rows: [
        ['01/03/2026', 'Mobile deposit, branch 4', 'Jane Customer', 1200],
        ['01/05/2026', 'Check 1043', 'City Water', -150],
      ],
    });
    const r = await extractBankFile(ctx, { bankAccountId: checking, filename: 'jan.xlsx', bytes: xlsx });
    expect(r.kind).toBe('csv');
    if (r.kind !== 'csv') return;
    const parsed = parseCSV(r.csv, { dateCol: 'Date', descriptionCol: 'Description', amountCol: 'Amount', payeeCol: 'Payee' });
    expect(parsed.map((p) => [p.description, p.amount, p.payee])).toEqual([
      ['Mobile deposit, branch 4', '1200.00', 'Jane Customer'],
      ['Check 1043', '-150.00', 'City Water'],
    ]);
  });

  it('a layout the parser cannot tie is read by the company AI, used only because it ties', async () => {
    await updateSettings(ctx, { providers: [{ kind: 'ollama', label: 'GPU', baseUrl: 'http://100.80.1.2:11434', model: 'qwen2.5:14b', enabled: true }] });
    const odd = ['ACME CREDIT UNION', 'Balance forward 100.00', 'Txn: Payroll deposit .... +900.00 on Feb 2', 'Txn: Corner store .... -12.00 on Feb 3', 'Closing balance 988.00'];
    const m = ollama(JSON.stringify({
      openingBalance: '100.00',
      closingBalance: '988.00',
      rows: [
        { date: '2026-02-02', description: 'Payroll deposit', amount: '900.00' },
        { date: '2026-02-03', description: 'Corner store', amount: '-12.00' },
      ],
    }));
    const r = await extractBankFile(
      ctx,
      { bankAccountId: checking, filename: 'odd.pdf', bytes: await statementPdf(odd) },
      { ocr: null, routerOpts: { deps: { fetch: m.fetch } } },
    );
    expect(r.kind === 'statement' && r.method).toBe('ai');
    expect(r.kind === 'statement' && r.tieOut.ok).toBe(true);
    expect(r.kind === 'statement' && r.rows.every((x) => x.signFrom === 'ai')).toBe(true);
    expect(r.kind === 'statement' && r.warnings[0]).toMatch(/read by your AI/);
    const prompt: string = m.calls.find((c) => c.url.endsWith('/api/chat'))!.body.messages.at(-1).content;
    expect(prompt).toContain('This is a BANK statement');
  });

  it('reviewed rows import with their payee, and re-importing adds nothing', async () => {
    const rows = [
      { date: '2026-03-01', description: 'Mobile deposit', amount: '500.00', payee: 'Jane Customer' },
      { date: '2026-03-02', description: 'Check #1044', amount: '-75.00' },
    ];
    const first = await importTransactions(ctx, { bankAccountId: checking, fileType: 'rows', content: '', rows, filename: 'mar.pdf' });
    expect(first).toMatchObject({ imported: 2, skippedDupes: 0 });
    const again = await importTransactions(ctx, { bankAccountId: checking, fileType: 'rows', content: '', rows, filename: 'mar.pdf' });
    expect(again).toMatchObject({ imported: 0, skippedDupes: 2 });
    const staged = await db.select().from(bankTransactions).where(eq(bankTransactions.fileImportId, first.fileImportId));
    expect(staged.find((s) => s.amount === '500.00')?.payee).toBe('Jane Customer');
    await expect(
      importTransactions(ctx, { bankAccountId: checking, fileType: 'rows', content: '', rows: [{ date: '03/04/2026', description: 'x', amount: '1' }] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('the import route refuses statement rows that do not tie out unless acknowledged, and audits it', async () => {
    const post = (body: unknown) =>
      importPOST(new NextRequest('http://127.0.0.1/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const rows = [
      { date: '2026-04-02', description: 'Card payment', amount: '200.00' },
      { date: '2026-04-05', description: 'Hardware store', amount: '-80.00' },
    ];
    // Card: owed 500 → 380 needs +200 −80 = +120 ✓; claim 400 closing to force a difference.
    const off = await post({ bankAccountId: visa, fileType: 'rows', rows, statement: { kind: 'card', openingBalance: '500.00', closingBalance: '400.00' } });
    expect(off.status).toBe(400);
    expect((await off.json()).details.tieOut).toMatchObject({ ok: false, difference: '-20.00' });

    const ack = await post({ bankAccountId: visa, fileType: 'rows', rows, filename: 'apr.pdf', statement: { kind: 'card', openingBalance: '500.00', closingBalance: '400.00', acknowledgeDifference: true } });
    expect(ack.status).toBe(201);
    const { fileImportId } = await ack.json();
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, fileImportId));
    expect(audit.newValues).toMatchObject({ tiedOut: false, difference: '-20.00', acknowledgedDifference: true });

    const tied = await post({ bankAccountId: visa, fileType: 'rows', rows: [{ date: '2026-04-09', description: 'Coffee', amount: '-5.00' }], statement: { kind: 'card', openingBalance: '0.00', closingBalance: '5.00' } });
    expect(tied.status).toBe(201);
  });
});
