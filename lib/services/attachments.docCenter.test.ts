/**
 * Doc Center (J9): unfiled inbox, filing a document to a record and back, search, and the
 * guards (link must be complete and well-formed, size limit, company scoping).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  MAX_ATTACHMENT_BYTES,
  listAttachments,
  listUnfiledAttachments,
  saveAttachment,
  searchAttachments,
  updateAttachment,
} from './attachments';
import { createCustomer } from './customers';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('Doc Center (integration)', () => {
  beforeAll(async () => {
    t = await makeTestCompany('doccenter');
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('a document uploaded without a record lands in the inbox', async () => {
    const doc = await saveAttachment(t.ctx, {
      filename: 'gas-receipt.pdf',
      mimeType: 'application/pdf',
      base64: b64('%PDF-1.4 fake'),
      description: 'Shell station, March',
    });
    expect(doc.entityType).toBeNull();
    expect(doc.entityId).toBeNull();
    const inbox = await listUnfiledAttachments(t.ctx);
    expect(inbox.map((d) => d.id)).toContain(doc.id);
  });

  it('files it to a record, finds it there, and can unfile it again', async () => {
    const [doc] = await listUnfiledAttachments(t.ctx);
    // Filing needs a real record of this company (a made-up id is refused).
    await expect(updateAttachment(t.ctx, doc.id, { entityType: 'invoice', entityId: randomUUID() })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    const cust = await createCustomer(t.ctx, { displayName: 'Doc Center Customer' });
    const filed = await updateAttachment(t.ctx, doc.id, { entityType: 'customer', entityId: cust.id });
    expect(filed.entityType).toBe('customer');
    expect((await listUnfiledAttachments(t.ctx)).some((d) => d.id === doc.id)).toBe(false);
    expect((await listAttachments(t.ctx, { entityType: 'customer', entityId: cust.id })).map((d) => d.id)).toEqual([doc.id]);
    const back = await updateAttachment(t.ctx, doc.id, { entityType: null, entityId: null, description: 'moved back' });
    expect(back.entityId).toBeNull();
    expect(back.description).toBe('moved back');
  });

  it('searches by file name and description', async () => {
    await saveAttachment(t.ctx, { filename: 'lease-2026.pdf', mimeType: 'application/pdf', base64: b64('x') });
    expect((await searchAttachments(t.ctx, { q: 'lease' })).map((d) => d.filename)).toEqual(['lease-2026.pdf']);
    expect((await searchAttachments(t.ctx, { q: 'moved' })).map((d) => d.filename)).toEqual(['gas-receipt.pdf']);
    expect((await searchAttachments(t.ctx, { q: '%' })).length).toBe(0); // wildcards are literal
    expect((await searchAttachments(t.ctx)).length).toBe(2);
  });

  it('rejects half links, bad ids, empty and oversized files', async () => {
    await expect(
      saveAttachment(t.ctx, { entityType: 'invoice', filename: 'a.txt', mimeType: 'text/plain', base64: b64('a') }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      saveAttachment(t.ctx, { entityType: 'invoice', entityId: 'nope', filename: 'a.txt', mimeType: 'text/plain', base64: b64('a') }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      saveAttachment(t.ctx, { entityType: '../etc', entityId: randomUUID(), filename: 'a.txt', mimeType: 'text/plain', base64: b64('a') }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(saveAttachment(t.ctx, { filename: 'e.txt', mimeType: 'text/plain', base64: '' })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1).toString('base64');
    await expect(saveAttachment(t.ctx, { filename: 'big.bin', mimeType: 'application/octet-stream', base64: big })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
  });

  it('never touches another company file', async () => {
    const [doc] = await searchAttachments(t.ctx, { q: 'lease' });
    const otherCtx = { ...t.ctx, companyId: randomUUID() };
    await expect(updateAttachment(otherCtx, doc.id, { description: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await listUnfiledAttachments(otherCtx)).toEqual([]);
  });
});
