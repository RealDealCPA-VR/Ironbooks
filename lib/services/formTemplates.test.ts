/**
 * Form templates (B11): several templates per form, one default per form, normalized designs,
 * locally stored logos (PNG/JPEG only), and the print path (lib/pdf/forms.ts) resolving the
 * selected / default / built-in template.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { attachments } from '@/lib/db/schema';
import { buildInvoicePdf, buildPurchaseOrderPdf, buildEstimatePdf } from '@/lib/pdf/forms';
import {
  createFormTemplate,
  deleteFormTemplate,
  listFormTemplates,
  removeFormTemplateLogo,
  resolveFormTemplate,
  setFormTemplateLogo,
  updateFormTemplate,
} from './formTemplates';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { createVendor } from './vendors';
import { createPurchaseOrder } from './purchaseOrders';
import { createEstimate } from './estimates';
import { makeTestCompany, addMember, type TestCompany } from './testkit.prefs';

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';

let t: TestCompany;

describe('Form templates (integration)', () => {
  beforeAll(async () => {
    t = await makeTestCompany('formtpl');
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('falls back to the built-in standard layout when no template exists', async () => {
    const r = await resolveFormTemplate(t.ctx, 'invoice');
    expect(r.templateId).toBeNull();
    expect(r.name).toBe('Standard');
    expect(r.design.title).toBe('INVOICE');
  });

  it('creates templates, keeps exactly one default per form, normalizes designs', async () => {
    const a = await createFormTemplate(t.ctx, { formType: 'invoice', name: 'Service', isDefault: true, design: { title: 'SERVICE INVOICE', font: 'nope' } });
    expect(a.isDefault).toBe(true);
    expect(a.design.title).toBe('SERVICE INVOICE');
    expect(a.design.font).toBe('helvetica');
    const b = await createFormTemplate(t.ctx, { formType: 'invoice', name: 'Product', isDefault: true });
    const list = await listFormTemplates(t.ctx, 'invoice');
    expect(list.filter((x) => x.isDefault).map((x) => x.id)).toEqual([b.id]);
    // Duplicate names are refused per form; other forms may reuse a name.
    await expect(createFormTemplate(t.ctx, { formType: 'invoice', name: 'product' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await createFormTemplate(t.ctx, { formType: 'estimate', name: 'Product' });
    await expect(createFormTemplate(t.ctx, { formType: 'paycheck', name: 'X' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('resolves the default, an explicit template, and rejects a template of another form', async () => {
    const [service] = (await listFormTemplates(t.ctx, 'invoice')).filter((x) => x.name === 'Service');
    const def = await resolveFormTemplate(t.ctx, 'invoice');
    expect(def.name).toBe('Product');
    const explicit = await resolveFormTemplate(t.ctx, 'invoice', service.id);
    expect(explicit.design.title).toBe('SERVICE INVOICE');
    const [est] = await listFormTemplates(t.ctx, 'estimate');
    await expect(resolveFormTemplate(t.ctx, 'invoice', est.id)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('an inactive template cannot stay the default', async () => {
    const [product] = (await listFormTemplates(t.ctx, 'invoice')).filter((x) => x.name === 'Product');
    const off = await updateFormTemplate(t.ctx, product.id, { isActive: false });
    expect(off.isDefault).toBe(false);
    await expect(updateFormTemplate(t.ctx, product.id, { isDefault: true })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await resolveFormTemplate(t.ctx, 'invoice')).templateId).toBeNull();
    await updateFormTemplate(t.ctx, product.id, { isActive: true, isDefault: true });
    expect((await resolveFormTemplate(t.ctx, 'invoice')).name).toBe('Product');
  });

  it('stores the logo locally, validates the image, and replaces/removes it', async () => {
    const [product] = (await listFormTemplates(t.ctx, 'invoice')).filter((x) => x.name === 'Product');
    await expect(
      setFormTemplateLogo(t.ctx, product.id, { filename: 'x.gif', mimeType: 'image/gif', base64: TINY_PNG_B64 }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      setFormTemplateLogo(t.ctx, product.id, { filename: 'x.png', mimeType: 'image/png', base64: Buffer.from('not an image').toString('base64') }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const withLogo = await setFormTemplateLogo(t.ctx, product.id, { filename: 'logo.png', mimeType: 'image/png', base64: TINY_PNG_B64 });
    expect(withLogo.logoAttachmentId).toBeTruthy();
    const [att] = await t.db.select().from(attachments).where(eq(attachments.id, withLogo.logoAttachmentId!));
    expect(att.entityType).toBe('form_template');
    expect(fs.existsSync(path.join(t.dir, att.storagePath))).toBe(true);
    const resolved = await resolveFormTemplate(t.ctx, 'invoice');
    expect(resolved.logo?.mimeType).toBe('image/png');

    const replaced = await setFormTemplateLogo(t.ctx, product.id, { filename: 'logo2.png', mimeType: 'image/png', base64: TINY_PNG_B64 });
    expect(replaced.logoAttachmentId).not.toBe(withLogo.logoAttachmentId);
    const old = await t.db.select().from(attachments).where(eq(attachments.id, withLogo.logoAttachmentId!));
    expect(old).toHaveLength(0); // the old logo file is released

    const removed = await removeFormTemplateLogo(t.ctx, product.id);
    expect(removed.logoAttachmentId).toBeNull();
  });

  it('prints invoices, estimates and P.O.s with the resolved template', async () => {
    const customer = await createCustomer(t.ctx, {
      displayName: 'Print Customer',
      billingAddress: { line1: '1 Main St', city: 'Springfield', state: 'IL', zip: '62701' },
    });
    const inv = await createInvoice(t.ctx, {
      customerId: customer.id,
      date: new Date('2026-06-01T00:00:00Z'),
      lines: [{ description: 'Consulting', quantity: '2', rate: '150.00' }],
    });
    const [service] = (await listFormTemplates(t.ctx, 'invoice')).filter((x) => x.name === 'Service');
    const byDefault = await buildInvoicePdf(t.ctx, inv.id);
    const byTemplate = await buildInvoicePdf(t.ctx, inv.id, service.id);
    expect(String.fromCharCode(...byDefault.bytes.slice(0, 4))).toBe('%PDF');
    expect(byTemplate.bytes.length).not.toBe(byDefault.bytes.length);
    expect(byDefault.number).toBe(inv.invoiceNumber);

    const est = await createEstimate(t.ctx, {
      customerId: customer.id,
      date: new Date('2026-06-01T00:00:00Z'),
      lines: [{ description: 'Quote', quantity: '1', rate: '99.00' }],
    } as never);
    expect((await buildEstimatePdf(t.ctx, est.id)).bytes.length).toBeGreaterThan(500);

    const vendor = await createVendor(t.ctx, { displayName: 'Print Vendor' });
    const po = await createPurchaseOrder(t.ctx, {
      vendorId: vendor.id,
      date: new Date('2026-06-01T00:00:00Z'),
      lines: [{ description: 'Paper', accountId: t.acct['6300'], quantity: '5', rate: '10.00' }],
    } as never);
    expect((await buildPurchaseOrderPdf(t.ctx, po.id)).bytes.length).toBeGreaterThan(500);
  });

  it('view-only members cannot design templates; deleting falls back to the standard layout', async () => {
    const viewer = await addMember(t, 'viewer');
    await expect(createFormTemplate(viewer, { formType: 'statement', name: 'Nope' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const tpl of await listFormTemplates(t.ctx, 'invoice')) await deleteFormTemplate(t.ctx, tpl.id);
    expect((await resolveFormTemplate(t.ctx, 'invoice')).templateId).toBeNull();
  });
});
