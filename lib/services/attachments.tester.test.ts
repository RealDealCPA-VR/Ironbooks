/**
 * P1 controls — independent tester: Doc Center documents take the permission area of the record
 * they are filed to. Adversarial paths: re-filing / unfiling / describing / deleting a document
 * the caller may not see, filing an inbox document onto a payroll record, view-only payroll
 * users, a payroll user without Lists, and another company's documents.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeGrant, type EffectiveAccess, type PermissionGrant } from '@/lib/permissions/model';
import { users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import {
  deleteAttachment,
  getAttachmentFile,
  listAttachments,
  listUnfiledAttachments,
  saveAttachment,
  searchAttachments,
  updateAttachment,
} from './attachments';
import { createEmployee } from './payroll';
import { createCompany } from './company';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
let employeeId: string;
const b64 = (s: string) => Buffer.from(s).toString('base64');

function withAccess(grant: PermissionGrant, base?: ServiceContext): ServiceContext {
  const access: EffectiveAccess = {
    roleKeys: ['custom'],
    permissions: normalizeGrant(grant),
    flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false },
    isAdmin: false,
  };
  return { ...(base ?? t.ctx), access };
}

beforeAll(async () => {
  t = await makeTestCompany('p1-tester-docs');
  employeeId = (await createEmployee(t.ctx, { firstName: 'Sam', lastName: 'Ray', payType: 'salary', payRate: '40000.00' } as never)).id;
}, 180_000);

afterAll(async () => {
  await t.cleanup();
});

describe('Doc Center: the record area guards every path', () => {
  it('a Lists user cannot unfile, re-describe, re-file or delete a payroll document', async () => {
    const lists = withAccess({ lists: ['full'] });
    const doc = await saveAttachment(t.ctx, {
      entityType: 'employee',
      entityId: employeeId,
      filename: 'i9-sam.pdf',
      mimeType: 'application/pdf',
      base64: b64('I-9'),
    });
    await expect(updateAttachment(lists, doc.id, { entityType: null, entityId: null })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateAttachment(lists, doc.id, { description: 'renamed' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(deleteAttachment(lists, doc.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await searchAttachments(lists, { q: 'i9' })).length).toBe(0);
    // Still there, still filed to the employee.
    const still = await listAttachments(t.ctx, { entityType: 'employee', entityId: employeeId });
    expect(still.map((d) => d.id)).toContain(doc.id);
    expect(still.find((d) => d.id === doc.id)?.description ?? null).toBeNull();
  });

  it('a Lists user cannot file an inbox document onto an employee (needs Payroll)', async () => {
    const lists = withAccess({ lists: ['full'] });
    const inbox = await saveAttachment(lists, { filename: 'scan-01.pdf', mimeType: 'application/pdf', base64: b64('scan') });
    await expect(updateAttachment(lists, inbox.id, { entityType: 'employee', entityId: employeeId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      saveAttachment(lists, { entityType: 'paycheck', entityId: employeeId, filename: 'x.pdf', mimeType: 'application/pdf', base64: b64('x') }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await listUnfiledAttachments(lists)).map((d) => d.id)).toContain(inbox.id);
  });

  it('view-only Payroll can open payroll documents but not add or change them', async () => {
    const viewer = withAccess({ payroll: ['view'], lists: ['full'] });
    const doc = await saveAttachment(t.ctx, {
      entityType: 'employee',
      entityId: employeeId,
      filename: 'w4-sam.pdf',
      mimeType: 'application/pdf',
      base64: b64('W-4'),
    });
    expect((await getAttachmentFile(viewer, doc.id)).filename).toBe('w4-sam.pdf');
    await expect(
      saveAttachment(viewer, { entityType: 'employee', entityId: employeeId, filename: 'y.pdf', mimeType: 'application/pdf', base64: b64('y') }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(updateAttachment(viewer, doc.id, { description: 'nope' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deleteAttachment(viewer, doc.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a Payroll user without Lists sees payroll documents in search but not the inbox', async () => {
    const payroll = withAccess({ payroll: ['full'] });
    const inbox = await saveAttachment(t.ctx, { filename: 'loose-receipt.pdf', mimeType: 'application/pdf', base64: b64('r') });
    const search = (await searchAttachments(payroll, {})).map((d) => d.id);
    expect(search).not.toContain(inbox.id);
    expect(search.length).toBeGreaterThan(0);
    await expect(listUnfiledAttachments(payroll)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(getAttachmentFile(payroll, inbox.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('another company never sees this company\'s documents, even with full access', async () => {
    const doc = await saveAttachment(t.ctx, { filename: 'secret.pdf', mimeType: 'application/pdf', base64: b64('s') });
    const [u] = await t.db.insert(users).values({ email: `other-${Date.now()}@t.local`, name: 'O', passwordHash: 'x' }).returning();
    const other = await createCompany(t.db, { name: 'Other Co', ownerId: u.id });
    const otherCtx: ServiceContext = { db: t.db, companyId: other.id, userId: u.id };
    await expect(getAttachmentFile(otherCtx, doc.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(deleteAttachment(otherCtx, doc.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await searchAttachments(otherCtx, { q: 'secret' })).length).toBe(0);
    await expect(
      updateAttachment(otherCtx, doc.id, { entityType: null, entityId: null }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // ...and cannot file its own document onto this company's employee.
    const mine = await saveAttachment(otherCtx, { filename: 'mine.pdf', mimeType: 'application/pdf', base64: b64('m') });
    await expect(updateAttachment(otherCtx, mine.id, { entityType: 'employee', entityId: employeeId })).rejects.toMatchObject({
      message: expect.stringMatching(/not found/i),
    });
  });
});
