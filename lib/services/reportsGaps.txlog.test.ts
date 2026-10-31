/**
 * Report gaps round — the transaction log leaves the app: the raw `.bktlg` downloads byte for
 * byte with a verification report for exactly those bytes, and the CSV export of the filtered
 * log has no row cap (it stopped at the page's 5,000 rows) — streamed in batches.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { closeDb, getDb, type DB } from '@/lib/db';
import { companies, userCompanies, users } from '@/lib/db/schema';
import { writeAudit, type ServiceContext } from './_base';
import { appendTransactionLog, transactionLogPath } from './transactionLog';
import { prepareRawLogDownload, sha256OfPrefix, streamTransactionLogCsv, transactionLogVerificationReport } from './transactionLogExport';

let ctx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => ctx) }));
import { GET as downloadGET } from '@/app/api/transaction-log/download/route';
import { GET as exportGET } from '@/app/api/transaction-log/export/route';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-reports-gaps-txlog');
let db: DB;
let owner: ServiceContext;
let otherOwnerId: string;
let otherCompanyId: string;

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

beforeAll(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = await getDb(TEST_DIR);
  const [user] = await db.insert(users).values({ email: 'txlog-dl@test.local', name: 'Olive', passwordHash: 'x' }).returning();
  const [company] = await db.insert(companies).values({ name: 'Ølive’s Shop', ownerId: user.id }).returning();
  owner = { db, companyId: company.id, userId: user.id, role: 'owner' };
  ctx = owner;
  for (let i = 0; i < 3; i++) {
    await writeAudit(owner, { action: 'create', entityType: 'customer', entityId: `00000000-0000-4000-8000-00000000000${i}`, newValues: { displayName: `Cust ${i}` } });
  }
  const [other] = await db.insert(users).values({ email: 'txlog-other@test.local', name: 'Otto', passwordHash: 'x' }).returning();
  otherOwnerId = other.id;
  const [c2] = await db.insert(companies).values({ name: 'Otto Co', ownerId: other.id }).returning();
  otherCompanyId = c2.id;
});

afterAll(async () => {
  await closeDb();
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* Windows may hold a handle */
  }
});

describe('raw .bktlg download with its verification report', () => {
  it('streams the log byte for byte; the report fingerprints exactly those bytes and verifies', async () => {
    const file = transactionLogPath(TEST_DIR);
    const onDisk = fs.readFileSync(file);
    const res = await downloadGET(new NextRequest('http://localhost/api/transaction-log/download'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/filename\*=UTF-8''.*\.bktlg/);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(onDisk)).toBe(true);

    const rep = await downloadGET(new NextRequest('http://localhost/api/transaction-log/download?part=verification'));
    expect(rep.status).toBe(200);
    const report = await rep.json();
    expect(report.bytes).toBe(onDisk.length);
    expect(report.sha256).toBe(createHash('sha256').update(onDisk).digest('hex'));
    expect(report.verification.ok).toBe(true);
    expect(report.verification.chainIntact).toBe(true);
    expect(report.verification.records).toBeGreaterThanOrEqual(4);
    expect(report.file).toMatch(/transactions\.bktlg$/);
  });

  it('a later download still starts with the reported bytes (append-only)', async () => {
    const { report } = await transactionLogVerificationReport(owner);
    await writeAudit(owner, { action: 'update', entityType: 'customer', entityId: '00000000-0000-4000-8000-000000000009', newValues: { displayName: 'Later' } });
    const raw = await prepareRawLogDownload(owner);
    expect(raw.bytes).toBeGreaterThan(report.bytes);
    expect(sha256OfPrefix(raw.file, report.bytes)).toBe(report.sha256);
  });

  it('is refused to a viewer, and while the log records a company the caller does not manage', async () => {
    ctx = { ...owner, role: 'viewer' };
    expect((await downloadGET(new NextRequest('http://localhost/api/transaction-log/download'))).status).toBe(403);
    ctx = owner;
    // Otto's company writes to the same log.
    await writeAudit({ db, companyId: otherCompanyId, userId: otherOwnerId, role: 'owner' }, { action: 'create', entityType: 'vendor', entityId: '00000000-0000-4000-8000-0000000000aa', newValues: { displayName: 'Otto vendor' } });
    await expect(prepareRawLogDownload(owner)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Made an admin of Otto's company: allowed.
    await db.insert(userCompanies).values({ userId: owner.userId!, companyId: otherCompanyId, role: 'admin' });
    await expect(prepareRawLogDownload(owner)).resolves.toMatchObject({ bytes: expect.any(Number) });
  });
});

describe('CSV export of the filtered log — no row cap', () => {
  it('exports every matching record (more than 5,000), newest first, other companies left out', async () => {
    const pending = Array.from({ length: 6200 }, (_, i) => ({
      userId: owner.userId!,
      userName: 'Olive',
      companyId: owner.companyId,
      action: 'update',
      entityType: 'item',
      entityId: null,
      summary: `Bulk change ${i}`,
      data: null,
    }));
    appendTransactionLog(TEST_DIR, pending);
    const csv = (await readAll(streamTransactionLogCsv(owner, { entityType: 'item' }))).toString('utf8');
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toContain('Date/Time');
    expect(lines.length - 1).toBe(6200);
    expect(lines[1]).toContain('Bulk change 6199');
    expect(csv).not.toContain('Otto vendor');

    const res = await exportGET(new NextRequest('http://localhost/api/transaction-log/export?q=Bulk%20change%2042'));
    expect(res.status).toBe(200);
    const text = await res.text();
    // "Bulk change 42" and 420-429, 4200-4299.
    expect(text.trim().split('\r\n').length - 1).toBe(1 + 10 + 100);
    ctx = { ...owner, role: 'viewer' };
    expect((await exportGET(new NextRequest('http://localhost/api/transaction-log/export'))).status).toBe(403);
    ctx = owner;
  });
});
