/**
 * Wave 2 prefs QA re-test (adversarial7), after fix round 6.
 *
 * Round 6 fixed: letter template writes are refused for view-only members before anything is
 * written; uploading straight to a record checks that the record is real and belongs to this
 * company. This file pushes on the edges of those two fixes:
 *  - J9  upload to the wrong record type, padded type names, another company's form template,
 *        no file left on disk when an upload is refused, real records still work
 *  - B11 a logo for another company's template is refused and nothing is written
 *  - J15 the viewer check comes first (built-in / missing ids / bad input still say FORBIDDEN),
 *        an accountant may still edit, another company's template is not reachable
 * The books must stay balanced (TB and balance sheet) throughout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { attachments, auditLogs, formTemplates, letterTemplates, users } from '@/lib/db/schema';
import { balanceSheet, trialBalance } from './reports';
import { createCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { createLetterTemplate, deleteLetterTemplate, updateLetterTemplate } from './letters';
import { listAttachments, listUnfiledAttachments, saveAttachment } from './attachments';
import { createLead } from './leads';
import { createFormTemplate, setFormTemplateLogo } from './formTemplates';
import { addMember, makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const FAKE_ID = '00000000-0000-4000-8000-0000000000aa';
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

async function books() {
  const tb = await trialBalance(t.ctx);
  expect(tb.balanced).toBe(true);
  const bs = await balanceSheet(t.ctx);
  expect(bs.balanced).toBe(true);
}

async function otherCompany(label: string) {
  const [u] = await t.db
    .insert(users)
    .values({ email: `${label}-${Date.now()}-${Math.random()}@test.local`, name: label, passwordHash: 'x' })
    .returning();
  const co = await createCompany(t.db, { name: `${label} Co`, ownerId: u.id });
  return { db: t.db, companyId: co.id, userId: u.id };
}

function filesOnDisk(): number {
  const dir = path.join(t.dir, 'attachments');
  return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
}

async function rowCount(): Promise<number> {
  return (await t.db.select({ id: attachments.id }).from(attachments).where(eq(attachments.companyId, t.ctx.companyId)))
    .length;
}

async function auditCount(entityType: string): Promise<number> {
  return (
    await t.db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, t.ctx.companyId), eq(auditLogs.entityType, entityType)))
  ).length;
}

beforeAll(async () => {
  t = await makeTestCompany('prefs-adv7');
}, 120_000);

afterAll(async () => {
  await t?.cleanup();
});

// ---------------------------------------------------------------------------
// J9 uploads straight to a record
// ---------------------------------------------------------------------------
describe('Doc Center: uploading straight to a record', () => {
  it('a refused upload leaves no row and no file on disk', async () => {
    // make sure the folder exists so the count is meaningful
    await saveAttachment(t.ctx, { filename: 'seed.png', mimeType: 'image/png', base64: PNG_1PX });
    const files = filesOnDisk();
    const rows = await rowCount();
    await expect(
      saveAttachment(t.ctx, { entityType: 'bill', entityId: FAKE_ID, filename: 'o.png', mimeType: 'image/png', base64: PNG_1PX }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/VALIDATION|NOT_FOUND/) });
    expect(filesOnDisk()).toBe(files);
    expect(await rowCount()).toBe(rows);
  });

  it('a real id of the wrong record type is refused (a vendor is not a customer)', async () => {
    const v = await createVendor(t.ctx, { displayName: 'Wrong Type Vendor' });
    const rows = await rowCount();
    const files = filesOnDisk();
    await expect(
      saveAttachment(t.ctx, { entityType: 'customer', entityId: v.id, filename: 'w.png', mimeType: 'image/png', base64: PNG_1PX }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/VALIDATION|NOT_FOUND/) });
    expect(await rowCount()).toBe(rows);
    expect(filesOnDisk()).toBe(files);
  });

  it('padding the record type with spaces does not skip the check', async () => {
    const rows = await rowCount();
    await expect(
      saveAttachment(t.ctx, { entityType: '  invoice ', entityId: ` ${FAKE_ID} `, filename: 'p.png', mimeType: 'image/png', base64: PNG_1PX }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/VALIDATION|NOT_FOUND/) });
    expect(await rowCount()).toBe(rows);
  });

  it("another company's form template cannot receive a document", async () => {
    const other = await otherCompany('ft-other7');
    const theirs = await createFormTemplate(other, { formType: 'invoice', name: 'Their Template' });
    const rows = await rowCount();
    await expect(
      saveAttachment(t.ctx, { entityType: 'form_template', entityId: theirs.id, filename: 'l.png', mimeType: 'image/png', base64: PNG_1PX }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/VALIDATION|NOT_FOUND/) });
    expect(await rowCount()).toBe(rows);
  });

  it('uploads to real records of this company still work and land on the record, not the inbox', async () => {
    const c = await createCustomer(t.ctx, { displayName: 'Upload Target Co' });
    const inv = await createInvoice(t.ctx, {
      customerId: c.id, date: day('2026-05-01'), dueDate: day('2026-05-31'),
      lines: [{ description: 'Service', quantity: '2', rate: '12.50' }],
    });
    const lead = await createLead(t.ctx, { name: 'Upload Lead' });
    const a = await saveAttachment(t.ctx, { entityType: 'invoice', entityId: inv.id, filename: 'i.png', mimeType: 'image/png', base64: PNG_1PX });
    const b = await saveAttachment(t.ctx, { entityType: 'lead', entityId: lead.id, filename: 'l.png', mimeType: 'image/png', base64: PNG_1PX });
    expect((await listAttachments(t.ctx, { entityType: 'invoice', entityId: inv.id })).map((r) => r.id)).toEqual([a.id]);
    expect((await listAttachments(t.ctx, { entityType: 'lead', entityId: lead.id })).map((r) => r.id)).toEqual([b.id]);
    const inbox = (await listUnfiledAttachments(t.ctx)).map((r) => r.id);
    expect(inbox).not.toContain(a.id);
    expect(inbox).not.toContain(b.id);
    await books();
  });
});

// ---------------------------------------------------------------------------
// B11 logos on another company's template
// ---------------------------------------------------------------------------
describe('form templates: logo for a template of another company', () => {
  it('is refused and writes nothing (no row, no file, their template unchanged)', async () => {
    const other = await otherCompany('logo-other7');
    const theirs = await createFormTemplate(other, { formType: 'invoice', name: 'Their Logo Template' });
    const rows = await rowCount();
    const files = filesOnDisk();
    await expect(
      setFormTemplateLogo(t.ctx, theirs.id, { filename: 'l.png', mimeType: 'image/png', base64: PNG_1PX }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|VALIDATION/) });
    expect(await rowCount()).toBe(rows);
    expect(filesOnDisk()).toBe(files);
    const [row] = await t.db.select().from(formTemplates).where(eq(formTemplates.id, theirs.id));
    expect(row.logoAttachmentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// J15 letter templates
// ---------------------------------------------------------------------------
describe('letter templates: the view-only check comes first', () => {
  it('a viewer gets FORBIDDEN even for built-in ids, missing ids and bad input; no audit rows', async () => {
    const viewer = await addMember(t, 'viewer', 'letter-viewer7');
    const audits = await auditCount('letter_template');
    await expect(updateLetterTemplate(viewer, 'builtin:customer-collection', { body: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deleteLetterTemplate(viewer, 'builtin:customer-collection')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(deleteLetterTemplate(viewer, FAKE_ID)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      createLetterTemplate(viewer, { category: 'not-a-category', name: '', body: '' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await auditCount('letter_template')).toBe(audits);
  });

  it('an accountant can still add, change and delete letter templates', async () => {
    const acct = await addMember(t, 'accountant', 'letter-acct7');
    const tpl = await createLetterTemplate(acct, { category: 'vendor', name: 'Acct letter', body: 'Hello {{name}}' });
    const up = await updateLetterTemplate(acct, tpl.id, { body: 'Hi {{name}}' });
    expect(up.body).toBe('Hi {{name}}');
    await deleteLetterTemplate(acct, tpl.id);
    const left = await t.db.select().from(letterTemplates).where(eq(letterTemplates.id, tpl.id));
    expect(left.length).toBe(0);
  });

  it("another company's letter template cannot be changed or deleted", async () => {
    const other = await otherCompany('letter-other7');
    const theirs = await createLetterTemplate(other, { category: 'customer', name: 'Theirs', body: 'Original' });
    await expect(updateLetterTemplate(t.ctx, theirs.id, { body: 'hijacked' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(deleteLetterTemplate(t.ctx, theirs.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const [row] = await t.db.select().from(letterTemplates).where(eq(letterTemplates.id, theirs.id));
    expect(row.body).toBe('Original');
  });
});

describe('books after the whole run', () => {
  it('TB and balance sheet balanced', async () => {
    await books();
  });
});
