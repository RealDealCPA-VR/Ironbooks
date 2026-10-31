/**
 * Feature round (accountant) — J9 Doc Center: an attachment panel on sales receipts, credit memos,
 * estimates, sales orders, purchase orders, deposits, customer payments, items and employees, and
 * deposits as a real filing record (checked against the company's deposits and guarded by Banking,
 * like checks).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeGrant, type EffectiveAccess, type PermissionGrant } from '@/lib/permissions/model';
import type { ServiceContext } from './_base';
import { attachmentArea, listAttachments, saveAttachment } from './attachments';
import { createDeposit } from './deposits';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
let depositId: string;
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

describe('J9 Doc Center on every form and list', () => {
  beforeAll(async () => {
    t = await makeTestCompany('j9docs');
    depositId = (
      await createDeposit(t.ctx, {
        depositAccountId: t.acct['1000'],
        date: new Date('2026-03-02T12:00:00Z'),
        extraLines: [{ accountId: t.acct['4000'], amount: '50.00', description: 'Cash sale' }],
      })
    ).id;
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('a document filed to a deposit needs Banking, like a check', async () => {
    expect(attachmentArea('deposit', 'view')).toBe('banking');
    const listsOnly = withAccess({ lists: ['full'] });
    await expect(
      saveAttachment(listsOnly, { entityType: 'deposit', entityId: depositId, filename: 'slip.pdf', mimeType: 'application/pdf', base64: b64('slip') }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const banking = withAccess({ banking: ['full'] });
    const doc = await saveAttachment(banking, { entityType: 'deposit', entityId: depositId, filename: 'slip.pdf', mimeType: 'application/pdf', base64: b64('slip') });
    expect(doc.entityType).toBe('deposit');
    expect((await listAttachments(banking, { entityType: 'deposit', entityId: depositId })).map((a) => a.id)).toContain(doc.id);
    await expect(listAttachments(listsOnly, { entityType: 'deposit', entityId: depositId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a deposit id that is not one of the company deposits is refused', async () => {
    await expect(
      saveAttachment(t.ctx, { entityType: 'deposit', entityId: randomUUID(), filename: 'x.pdf', mimeType: 'application/pdf', base64: b64('x') }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('each form and list shows the attachment panel for its own record', () => {
    const pages: Array<[string, string]> = [
      ['sales-receipts', 'sales_receipt'],
      ['credit-memos', 'credit_memo'],
      ['estimates', 'estimate'],
      ['sales-orders', 'sales_order'],
      ['purchase-orders', 'purchase_order'],
      ['deposits', 'deposit'],
      ['payments', 'payment_received'],
      ['items', 'item'],
      ['employees', 'employee'],
    ];
    for (const [page, type] of pages) {
      const src = fs.readFileSync(path.resolve(process.cwd(), 'app', page, 'page.tsx'), 'utf8');
      expect(src, page).toContain("import AttachmentPanel from '@/components/AttachmentPanel'");
      expect(src, page).toMatch(new RegExp(`<AttachmentPanel[^>]*entityType="${type}"`));
      // ...and the Doc Center can file to it.
      const doc = fs.readFileSync(path.resolve(process.cwd(), 'app', 'attachments', 'page.tsx'), 'utf8');
      expect(doc, type).toMatch(new RegExp(`'${type}'`));
    }
  });
});
