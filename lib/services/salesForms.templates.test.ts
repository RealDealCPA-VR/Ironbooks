/**
 * B11: printing and emailing sales forms (renderSalesForm / emailSalesForm / the sales-forms PDF
 * route) honor the company's form templates — the explicit templateId, else the form's default
 * template, else the built-in layout.
 *
 * The template renderer is wrapped in a spy so the tests can assert exactly which design and logo
 * reached it; email delivery is stubbed to capture the attached PDF.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ServiceContext } from './_base';

const sent: Array<{ to: string; attachments: Array<{ filename: string; content: Buffer }> }> = [];

vi.mock('@/lib/pdf/template', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pdf/template')>();
  return { ...actual, renderFormPdf: vi.fn(actual.renderFormPdf) };
});
vi.mock('@/lib/services/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/email')>();
  return {
    ...actual,
    isConfigured: () => true,
    sendMail: vi.fn(async (msg: (typeof sent)[number]) => {
      sent.push(msg);
    }),
  };
});
let routeCtx: ServiceContext;
vi.mock('@/lib/context', () => ({ getServerContext: vi.fn(async () => routeCtx) }));

import { renderFormPdf } from '@/lib/pdf/template';
import { GET as pdfGET } from '@/app/api/sales-forms/[kind]/[id]/pdf/route';
import { createFormTemplate, setFormTemplateLogo } from './formTemplates';
import { createCustomer } from './customers';
import { createSalesReceipt } from './salesReceipts';
import { createCreditMemo } from './creditMemos';
import { createSalesOrder } from './salesOrders';
import { emailSalesForm, renderSalesForm } from './salesForms';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';

const spy = vi.mocked(renderFormPdf);
/** The [document, design, logo] of the last renderFormPdf call. */
const lastCall = () => spy.mock.calls[spy.mock.calls.length - 1];

let t: TestCompany;
let receiptId: string;
let memoId: string;
let orderId: string;

describe('Sales forms print with form templates (B11)', () => {
  beforeAll(async () => {
    t = await makeTestCompany('sftpl');
    routeCtx = t.ctx;
    const cust = await createCustomer(t.ctx, {
      displayName: 'Template Customer',
      email: 'tc@example.com',
      billingAddress: { line1: '1 Main St', city: 'Springfield', state: 'IL', zip: '62701' },
    });
    const day = new Date('2026-06-01T00:00:00Z');
    receiptId = (await createSalesReceipt(t.ctx, { customerId: cust.id, date: day, lines: [{ description: 'Cash sale', quantity: 1, rate: 5 }] } as never)).id;
    memoId = (await createCreditMemo(t.ctx, { customerId: cust.id, date: day, lines: [{ description: 'Credit', quantity: 1, rate: 3 }] } as never)).id;
    orderId = (await createSalesOrder(t.ctx, { customerId: cust.id, date: day, shipVia: 'FedEx', lines: [{ description: 'Order', quantity: 2, rate: 7 }] } as never)).id;
  });
  afterAll(async () => {
    await t.cleanup();
  });
  beforeEach(() => {
    spy.mockClear();
    sent.length = 0;
  });

  it('without templates, sales receipts and credit memos keep the built-in layout', async () => {
    for (const [kind, id] of [['sales_receipt', receiptId], ['credit_memo', memoId], ['sales_order', orderId]] as const) {
      const f = await renderSalesForm(t.ctx, kind, id);
      expect(Buffer.from(f.bytes.slice(0, 5)).toString()).toBe('%PDF-');
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('applies the default sales-receipt template (title, colour, footer, logo)', async () => {
    const tpl = await createFormTemplate(t.ctx, {
      formType: 'sales_receipt',
      name: 'Branded receipt',
      isDefault: true,
      design: { title: 'CASH RECEIPT', accentColor: '#112233', footerText: 'Branded footer text' },
    });
    await setFormTemplateLogo(t.ctx, tpl.id, { filename: 'logo.png', mimeType: 'image/png', base64: TINY_PNG_B64 });

    const f = await renderSalesForm(t.ctx, 'sales_receipt', receiptId);
    expect(Buffer.from(f.bytes.slice(0, 5)).toString()).toBe('%PDF-');
    expect(spy).toHaveBeenCalledTimes(1);
    const [doc, design, logo] = lastCall();
    expect(doc.formType).toBe('sales_receipt');
    expect(doc.parties?.billTo).toEqual(['Template Customer', '1 Main St', 'Springfield, IL 62701']);
    expect(doc.fields.method).toBeTruthy();
    expect(design).toMatchObject({ title: 'CASH RECEIPT', accentColor: '#112233', footerText: 'Branded footer text' });
    expect(logo?.mimeType).toBe('image/png');
    expect(logo?.bytes.length).toBeGreaterThan(0);
  });

  it('an explicit templateId wins over the default; a template of another form is refused', async () => {
    const plain = await createFormTemplate(t.ctx, {
      formType: 'sales_receipt',
      name: 'Plain receipt',
      design: { title: 'PLAIN RECEIPT', font: 'courier' },
    });
    await renderSalesForm(t.ctx, 'sales_receipt', receiptId, plain.id);
    const [, design, logo] = lastCall();
    expect(design).toMatchObject({ title: 'PLAIN RECEIPT', font: 'courier' });
    expect(logo).toBeNull();

    await expect(renderSalesForm(t.ctx, 'credit_memo', memoId, plain.id)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('applies the default and explicit credit-memo templates', async () => {
    await createFormTemplate(t.ctx, {
      formType: 'credit_memo',
      name: 'Default credit',
      isDefault: true,
      design: { title: 'CUSTOMER CREDIT', accentColor: '#445566' },
    });
    const alt = await createFormTemplate(t.ctx, { formType: 'credit_memo', name: 'Alt credit', design: { title: 'REFUND NOTE' } });

    await renderSalesForm(t.ctx, 'credit_memo', memoId);
    let [doc, design] = lastCall();
    expect(doc.formType).toBe('credit_memo');
    expect(doc.totals.map((x) => x.label)).toContain('Remaining credit');
    expect(design).toMatchObject({ title: 'CUSTOMER CREDIT', accentColor: '#445566' });

    await renderSalesForm(t.ctx, 'credit_memo', memoId, alt.id);
    [, design] = lastCall();
    expect(design).toMatchObject({ title: 'REFUND NOTE' });
  });

  it('applies the default sales-order template, including ship via', async () => {
    await createFormTemplate(t.ctx, {
      formType: 'sales_order',
      name: 'SO',
      isDefault: true,
      design: { title: 'ORDER CONFIRMATION', fields: { shipVia: { show: true, label: 'Carrier' } } },
    });
    await renderSalesForm(t.ctx, 'sales_order', orderId);
    const [doc, design] = lastCall();
    expect(doc.fields.shipVia).toBe('FedEx');
    expect(doc.lines[0].ordered).toBeTruthy();
    expect(design).toMatchObject({ title: 'ORDER CONFIRMATION' });
  });

  it('emails with the default template, or the explicit one, as the attached PDF', async () => {
    const plain = (await import('./formTemplates')).listFormTemplates;
    const [plainTpl] = (await plain(t.ctx, 'sales_receipt')).filter((x) => x.name === 'Plain receipt');

    await emailSalesForm(t.ctx, 'sales_receipt', receiptId);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('tc@example.com');
    expect(String(sent[0].attachments[0].content.subarray(0, 5))).toBe('%PDF-');
    expect(lastCall()[1]).toMatchObject({ title: 'CASH RECEIPT' });

    await emailSalesForm(t.ctx, 'sales_receipt', receiptId, 'other@example.com', plainTpl.id);
    expect(sent[1].to).toBe('other@example.com');
    expect(lastCall()[1]).toMatchObject({ title: 'PLAIN RECEIPT' });

    await emailSalesForm(t.ctx, 'credit_memo', memoId);
    expect(lastCall()[1]).toMatchObject({ title: 'CUSTOMER CREDIT' });
  });

  it('the PDF route takes ?templateId and validates it', async () => {
    const [plainTpl] = (await (await import('./formTemplates')).listFormTemplates(t.ctx, 'sales_receipt')).filter(
      (x) => x.name === 'Plain receipt',
    );
    const call = (qs: string) =>
      pdfGET(new NextRequest(`http://localhost/api/sales-forms/sales_receipt/${receiptId}/pdf${qs}`), {
        params: Promise.resolve({ kind: 'sales_receipt', id: receiptId }),
      });

    const byDefault = await call('');
    expect(byDefault.status).toBe(200);
    expect(lastCall()[1]).toMatchObject({ title: 'CASH RECEIPT' });

    const explicit = await call(`?templateId=${plainTpl.id}`);
    expect(explicit.status).toBe(200);
    expect(lastCall()[1]).toMatchObject({ title: 'PLAIN RECEIPT' });

    expect((await call('?templateId=not-an-id')).status).toBe(400);
  });
});
