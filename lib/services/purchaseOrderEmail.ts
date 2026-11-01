/**
 * Email a purchase order to the vendor (prefsperms; QB Purchase Order > Email).
 *
 * The PDF is the same one Print makes (lib/pdf/forms.ts buildPurchaseOrderPdf, with the chosen or
 * default P.O. form template); the subject and message are the "Purchase Order" email template of
 * Preferences > Send Forms with its merge fields filled ({{number}}, {{vendor.name}}, {{total}},
 * {{date}}, {{expectedDate}}, {{company.name}}, {{sender.name}}, {{sender.email}}). Sending goes
 * through sendMail: the company's mail server, the sender's own address, the network policy and
 * the sandbox rule all apply. The send is recorded in the audit trail.
 */
import { and, eq } from 'drizzle-orm';
import { vendors } from '@/lib/db/schema';
import { buildPurchaseOrderPdf } from '@/lib/pdf/forms';
import { fillMergeFields } from '@/lib/preferences';
import { formatCurrency } from '@/lib/money';
import { type ServiceContext, notFound, validation, writeAudit } from './_base';
import { requireActivity } from './access';
import { getCompany, getPreferences } from './company';
import { getHomeCurrencyCode } from './currencies';
import { emailNotSetUpError, isConfigured, sendMail } from './email';
import { senderMergeFields } from './emailSettings';
import { getPurchaseOrder } from './purchaseOrders';
import { assertNotSandbox } from './sandboxState';

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

function isoDay(d: Date | string | null | undefined): string {
  if (!d) return '';
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? '' : x.toISOString().slice(0, 10);
}

/** The subject and message for a purchase order email (the company's Send Forms template). */
export async function purchaseOrderEmailText(
  ctx: ServiceContext,
  po: { number: string; vendorName: string; total: string; date: Date | string | null; expectedDate: Date | string | null },
): Promise<{ subject: string; text: string }> {
  const [prefs, company, sender] = await Promise.all([getPreferences(ctx), getCompany(ctx), senderMergeFields(ctx)]);
  let code: string | null = null;
  try {
    code = await getHomeCurrencyCode(ctx);
  } catch {
    code = null;
  }
  if (!code) code = /^[A-Za-z]{3}$/.test(String(prefs.currency ?? '')) ? String(prefs.currency).toUpperCase() : 'USD';
  let total: string;
  try {
    total = formatCurrency(po.total, code);
  } catch {
    total = formatCurrency(po.total);
  }
  const merge = {
    number: po.number,
    'vendor.name': po.vendorName,
    total,
    date: isoDay(po.date),
    expectedDate: isoDay(po.expectedDate),
    'company.name': company?.name ?? 'Your Company',
    ...sender,
  };
  const t = prefs.sendForms.purchase_order;
  return { subject: fillMergeFields(t.subject, merge).trim() || `Purchase Order ${po.number}`, text: fillMergeFields(t.body, merge) };
}

/**
 * Email one purchase order (as a PDF) to the vendor's email address, or to `to`. Needs Purchase
 * Orders: print (the route checks it too).
 */
export async function emailPurchaseOrder(
  ctx: ServiceContext,
  poId: string,
  to?: string | null,
  templateId?: string | null,
): Promise<{ ok: true; to: string }> {
  if (typeof poId !== 'string' || !/^[0-9a-f-]{36}$/i.test(poId)) throw notFound('Purchase order');
  assertNotSandbox('Email');
  requireActivity(ctx, 'vendors.purchase_orders', 'print');
  if (!(await isConfigured(ctx))) throw emailNotSetUpError();
  const po = await getPurchaseOrder(ctx, poId);
  const [vendor] = await ctx.db
    .select({ displayName: vendors.displayName, email: vendors.email })
    .from(vendors)
    .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, po.vendorId)));
  const vendorName = vendor?.displayName ?? 'Vendor';
  const recipient = (typeof to === 'string' && to.trim()) || vendor?.email || '';
  if (!recipient) {
    throw validation(`There is no email address for ${vendorName}. Type one in, or add it to the vendor record.`);
  }
  if (!EMAIL_RE.test(recipient)) throw validation('That email address does not look right.');
  const { bytes, number } = await buildPurchaseOrderPdf(ctx, poId, templateId);
  const { subject, text } = await purchaseOrderEmailText(ctx, {
    number: String(number),
    vendorName,
    total: po.total,
    date: po.date,
    expectedDate: po.expectedDate,
  });
  await sendMail(
    {
      to: recipient,
      subject,
      text,
      attachments: [
        { filename: `po-${String(number).replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf`, content: Buffer.from(bytes), contentType: 'application/pdf' },
      ],
    },
    ctx,
  );
  // Emailing changes nothing in the books: a member who may only print P.O.s may send one, so
  // audit under a context without the read-only role (writeAudit would refuse it after the send).
  await writeAudit({ ...ctx, role: ctx.role === 'viewer' ? undefined : ctx.role }, {
    action: 'update',
    entityType: 'purchase_order',
    entityId: poId,
    newValues: { action: 'emailed', to: recipient },
  });
  return { ok: true, to: recipient };
}
