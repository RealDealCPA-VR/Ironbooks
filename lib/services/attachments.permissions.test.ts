/**
 * P1 controls — Doc Center documents take the permission area of the record they're filed to.
 * Before: /api/attachments* was gated only by Lists, so a Lists user could list and download
 * documents filed to employees and paychecks. Now payroll documents need Payroll, bill documents
 * need Vendors, and the unfiled inbox needs Lists — on list, search, download, file/unfile and
 * delete. A vendors-only user can attach to a bill.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_ROUTE_PERMISSIONS } from '@/lib/permissions/routes';
import { normalizeGrant, type EffectiveAccess, type PermissionGrant } from '@/lib/permissions/model';
import type { ServiceContext } from './_base';
import {
  attachmentArea,
  deleteAttachment,
  getAttachmentFile,
  listAttachments,
  listUnfiledAttachments,
  saveAttachment,
  searchAttachments,
  updateAttachment,
} from './attachments';
import { createEmployee } from './payroll';
import { createBill } from './bills';
import { createVendor } from './vendors';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
let listsOnly: ServiceContext;
let vendorsOnly: ServiceContext;
let payrollUser: ServiceContext;
let employeeId: string;
let billId: string;
const b64 = (s: string) => Buffer.from(s).toString('base64');

function withAccess(grant: PermissionGrant): ServiceContext {
  const access: EffectiveAccess = {
    roleKeys: ['custom'],
    permissions: normalizeGrant(grant),
    flags: { sensitivePayroll: false, fullAccountNumbers: false, closedPeriod: false },
    isAdmin: false,
  };
  return { ...t.ctx, access };
}

describe('Doc Center permissions follow the record a document is filed to', () => {
  beforeAll(async () => {
    t = await makeTestCompany('docperm');
    listsOnly = withAccess({ lists: ['full'] });
    vendorsOnly = withAccess({ vendors: ['full'] });
    payrollUser = withAccess({ payroll: ['full'], lists: ['view'] });
    employeeId = (await createEmployee(t.ctx, { firstName: 'Pat', lastName: 'Lee', payType: 'salary', payRate: '50000.00' } as never)).id;
    const vendor = await createVendor(t.ctx, { displayName: 'Paper Co' } as never);
    const expenseAcct = Object.entries(t.acct).find(([code]) => code.startsWith('6'))![1];
    billId = (await createBill(t.ctx, { vendorId: vendor.id, date: new Date('2026-03-01T12:00:00Z'), lines: [{ accountId: expenseAcct, amount: '10.00' }] })).id;
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('the API routes no longer gate Doc Center by Lists alone', () => {
    expect(API_ROUTE_PERMISSIONS['/api/attachments'].GET).toBe('member');
    expect(API_ROUTE_PERMISSIONS['/api/attachments/[id]'].GET).toBe('member');
    expect(attachmentArea('employee', 'view')).toBe('payroll');
    expect(attachmentArea('paycheck', 'view')).toBe('payroll');
    expect(attachmentArea('bill', 'modify')).toBe('vendors');
    expect(attachmentArea(null, 'view')).toBe('lists');
  });

  it('employee documents are hidden from a Lists-only user everywhere', async () => {
    const doc = await saveAttachment(t.ctx, {
      entityType: 'employee',
      entityId: employeeId,
      filename: 'w4-pat.pdf',
      mimeType: 'application/pdf',
      base64: b64('%PDF W-4'),
    });
    const unfiled = await saveAttachment(t.ctx, { filename: 'inbox-scan.pdf', mimeType: 'application/pdf', base64: b64('scan') });

    // List for the record: refused.
    await expect(listAttachments(listsOnly, { entityType: 'employee', entityId: employeeId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Search: the employee document is not in the results, the inbox document is.
    const found = (await searchAttachments(listsOnly, {})).map((d) => d.id);
    expect(found).not.toContain(doc.id);
    expect(found).toContain(unfiled.id);
    expect((await searchAttachments(listsOnly, { q: 'w4' })).length).toBe(0);
    // Download / re-file / delete by id: looks like it doesn't exist.
    await expect(getAttachmentFile(listsOnly, doc.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(updateAttachment(listsOnly, doc.id, { entityType: null, entityId: null })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(deleteAttachment(listsOnly, doc.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Filing an inbox document to an employee needs Payroll.
    await expect(updateAttachment(listsOnly, unfiled.id, { entityType: 'employee', entityId: employeeId })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // A payroll user sees and downloads it.
    expect((await listAttachments(payrollUser, { entityType: 'employee', entityId: employeeId })).map((d) => d.id)).toEqual([doc.id]);
    expect((await getAttachmentFile(payrollUser, doc.id)).filename).toBe('w4-pat.pdf');
    expect((await searchAttachments(payrollUser, { q: 'w4' })).map((d) => d.id)).toEqual([doc.id]);
  });

  it('a vendors-only user can attach to a bill but not see the inbox or payroll documents', async () => {
    const doc = await saveAttachment(vendorsOnly, {
      entityType: 'bill',
      entityId: billId,
      filename: 'invoice-from-vendor.pdf',
      mimeType: 'application/pdf',
      base64: b64('bill scan'),
    });
    expect((await listAttachments(vendorsOnly, { entityType: 'bill', entityId: billId })).map((d) => d.id)).toEqual([doc.id]);
    expect((await getAttachmentFile(vendorsOnly, doc.id)).filename).toBe('invoice-from-vendor.pdf');
    await expect(listUnfiledAttachments(vendorsOnly)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(saveAttachment(vendorsOnly, { filename: 'x.pdf', mimeType: 'application/pdf', base64: b64('x') })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const visible = (await searchAttachments(vendorsOnly, {})).map((d) => d.filename);
    expect(visible).toEqual(['invoice-from-vendor.pdf']);
    // Lists-only users can't see the bill's document either.
    await expect(getAttachmentFile(listsOnly, doc.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Unfiling it (back to the Lists-guarded inbox) needs Lists too.
    await expect(updateAttachment(vendorsOnly, doc.id, { entityType: null, entityId: null })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await deleteAttachment(vendorsOnly, doc.id);
  });

  it('trusted (internal) contexts are unaffected', async () => {
    expect((await searchAttachments(t.ctx, {})).length).toBeGreaterThan(0);
  });
});
