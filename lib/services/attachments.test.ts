/**
 * Integration tests for the Attachments service.
 *
 * Each test run uses a unique data directory to avoid cross-test pollution.
 * We verify the full lifecycle: save -> list -> read-back -> delete.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { getDb, closeDb, type DB } from '@/lib/db';
import { users, companies, customers, vendors } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import {
  saveAttachment,
  listAttachments,
  getAttachmentFile,
  deleteAttachment,
} from './attachments';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-attachments-' + Date.now());

let ctx: ServiceContext;
let db: DB;
/** Real records of the test company: uploads straight to a record must point at a real one. */
let customerId: string;
let vendorId: string;

describe('Attachments service (integration)', () => {
  beforeAll(async () => {
    // Env var controls resolveDataDir() inside attachments.ts
    process.env.BKA_DATA_DIR = TEST_DIR;

    db = await getDb(TEST_DIR);

    const [user] = await db
      .insert(users)
      .values({ email: 'attach-test@local.test', name: 'Test User', passwordHash: 'x' })
      .returning();

    const [company] = await db
      .insert(companies)
      .values({ name: 'Attachment Test Co', ownerId: user.id })
      .returning();

    ctx = { db, companyId: company.id, userId: user.id };

    const [cust] = await db.insert(customers).values({ companyId: company.id, displayName: 'Attach Customer' }).returning();
    const [vend] = await db.insert(vendors).values({ companyId: company.id, displayName: 'Attach Vendor' }).returning();
    customerId = cust.id;
    vendorId = vend.id;
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    // Clean up test data directory.
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    delete process.env.BKA_DATA_DIR;
  });

  // ---- small PNG-ish 1x1 red pixel in base64 ----
  const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';

  let savedId: string;

  it('saves a base64 file and returns a DB row', async () => {
    const row = await saveAttachment(ctx, {
      entityType: 'customer',
      entityId: customerId,
      filename: 'receipt.png',
      mimeType: 'image/png',
      base64: TINY_PNG_B64,
    });

    expect(row.id).toBeTruthy();
    expect(row.filename).toBe('receipt.png');
    expect(row.mimeType).toBe('image/png');
    expect(row.sizeBytes).toBeGreaterThan(0);
    expect(row.storagePath).toMatch(/^attachments[\\/]/);
    expect(row.companyId).toBe(ctx.companyId);

    savedId = row.id;

    // File should exist on disk.
    const abs = path.join(TEST_DIR, row.storagePath);
    expect(fs.existsSync(abs)).toBe(true);
  });

  it('lists the saved attachment for the entity', async () => {
    const list = await listAttachments(ctx, {
      entityType: 'customer',
      entityId: customerId,
    });

    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(savedId);
    expect(list[0].filename).toBe('receipt.png');
  });

  it('returns an empty list for a different entityId', async () => {
    const list = await listAttachments(ctx, {
      entityType: 'customer',
      entityId: '00000000-0000-0000-0000-000000000099',
    });
    expect(list).toHaveLength(0);
  });

  it('reads back the file with equal contents', async () => {
    const { filename, mimeType, buffer } = await getAttachmentFile(ctx, savedId);

    expect(filename).toBe('receipt.png');
    expect(mimeType).toBe('image/png');

    // The buffer should equal the decoded base64.
    const expected = Buffer.from(TINY_PNG_B64, 'base64');
    expect(buffer.equals(expected)).toBe(true);
  });

  it('throws NOT_FOUND for a missing id', async () => {
    await expect(
      getAttachmentFile(ctx, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('deletes the attachment row and file', async () => {
    // Grab the storagePath before deletion.
    const { buffer } = await getAttachmentFile(ctx, savedId);
    expect(buffer.length).toBeGreaterThan(0);

    await deleteAttachment(ctx, savedId);

    // Row should be gone.
    const list = await listAttachments(ctx, {
      entityType: 'customer',
      entityId: customerId,
    });
    expect(list).toHaveLength(0);

    // getAttachmentFile should now throw.
    await expect(getAttachmentFile(ctx, savedId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws NOT_FOUND when deleting a non-existent attachment', async () => {
    await expect(
      deleteAttachment(ctx, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('saves a second attachment and lists both', async () => {
    const entityId = vendorId;

    const r1 = await saveAttachment(ctx, {
      entityType: 'vendor',
      entityId,
      filename: 'invoice-a.pdf',
      mimeType: 'application/pdf',
      base64: Buffer.from('pdf-content-a').toString('base64'),
    });

    const r2 = await saveAttachment(ctx, {
      entityType: 'vendor',
      entityId,
      filename: 'invoice-b.pdf',
      mimeType: 'application/pdf',
      base64: Buffer.from('pdf-content-b').toString('base64'),
    });

    const list = await listAttachments(ctx, { entityType: 'vendor', entityId });
    expect(list).toHaveLength(2);
    const ids = list.map((r) => r.id);
    expect(ids).toContain(r1.id);
    expect(ids).toContain(r2.id);
  });
  it('refuses an upload straight to a made-up record of a known type, but keeps free-form "other" references', async () => {
    await expect(
      saveAttachment(ctx, {
        entityType: 'invoice',
        entityId: '00000000-0000-0000-0000-000000000001',
        filename: 'x.png',
        mimeType: 'image/png',
        base64: TINY_PNG_B64,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const ref = '00000000-0000-0000-0000-000000000003';
    const row = await saveAttachment(ctx, { entityType: 'other', entityId: ref, filename: 'o.png', mimeType: 'image/png', base64: TINY_PNG_B64 });
    expect((await listAttachments(ctx, { entityType: 'other', entityId: ref })).map((r) => r.id)).toEqual([row.id]);
  });
});
