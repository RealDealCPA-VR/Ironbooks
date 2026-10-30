/**
 * Email service — send forms through the company's mail server (nodemailer).
 *
 * prefsperms: the mail server is set up INSIDE the app (Preferences > Send Forms) and stored in the
 * company file (lib/services/emailSettings.ts, password sealed with the file's own vault secret).
 * This computer's SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM environment variables
 * still work as a fallback when the file has no mail server of its own (a server deployment).
 *
 * Every send:
 *  - is refused in a sandbox (practice copy);
 *  - throws a friendly VALIDATION ServiceError when no mail server is set up
 *    (EMAIL_NOT_SET_UP_MESSAGE, with a "Set up email" fix that opens Preferences > Send Forms);
 *  - obeys the company network policy: a mail relay on the LAN / tailnet is always fine, a public
 *    mail provider needs the company's opt-in for email (Privacy & Network);
 *  - comes from the sending user's own name and address when they set one (My Preferences >
 *    Send Forms) and the company allows it, else from the company's sender with replies to them;
 *  - explains a mail server failure in plain words.
 */
import type { Attachment } from 'nodemailer/lib/mailer';
import { and, eq } from 'drizzle-orm';
import { customers } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { ServiceError } from './_base';
import { getInvoice } from './invoices';
import { docRef } from './docNumbers';
import { getCompany, getPreferences } from './company';
import { buildInvoicePdf } from '@/lib/pdf/forms';
import { fillMergeFields } from '@/lib/preferences';
import { formatCurrency } from '@/lib/money';
import { assertNotSandbox } from './sandboxState';
import { getHomeCurrencyCode } from './currencies';
import {
  EMAIL_NOT_SET_UP_MESSAGE,
  assertMailServerAllowed,
  explainMailError,
  isEmailConfigured,
  mailTransport,
  resolveMailConfig,
  senderFor,
  senderMergeFields,
  transportOptions,
} from './emailSettings';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Can this company send email? True when the company file has a usable mail server
 * (Preferences > Send Forms) or this computer's SMTP environment variables are set.
 */
export async function isConfigured(ctx: ServiceContext): Promise<boolean> {
  return isEmailConfigured(ctx);
}

/** The "Email is not set up" error, with a fix that opens Preferences > Send Forms. */
export function emailNotSetUpError(): ServiceError {
  return new ServiceError('VALIDATION', EMAIL_NOT_SET_UP_MESSAGE, undefined, [
    { id: 'email.setup', label: 'Set up email', kind: 'navigate', href: '/settings?tab=sendForms' },
  ]);
}

// ---------------------------------------------------------------------------
// Low-level sendMail
// ---------------------------------------------------------------------------

export interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Attachment[];
}

/**
 * Send one email through the company's mail server, from the signed-in user's sender identity.
 * Returns the addresses used.
 */
export async function sendMail(opts: MailOptions, ctx: ServiceContext): Promise<{ from: string; to: string }> {
  // Sandbox mode: nothing leaves a practice copy (checked first, even before the mail set-up).
  assertNotSandbox('Email');
  const cfg = await resolveMailConfig(ctx);
  if (!cfg) throw emailNotSetUpError();

  // Network policy: an SMTP relay on the LAN/tailnet is always fine; a public mail provider
  // needs the company's explicit cloud opt-in for 'email' (Settings → Privacy & Network).
  await assertMailServerAllowed(ctx, cfg);

  const sender = await senderFor(ctx, cfg);
  const transport = mailTransport.create(transportOptions(cfg));
  try {
    await transport.sendMail({
      from: sender.from.name ? { name: sender.from.name, address: sender.from.address } : sender.from.address,
      to: opts.to,
      ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
      ...(sender.bcc.length ? { bcc: sender.bcc } : {}),
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      attachments: opts.attachments,
    });
  } catch (err) {
    throw new ServiceError('VALIDATION', explainMailError(err, { host: cfg.host, port: cfg.port, fromEmail: sender.from.address }));
  }
  return { from: sender.from.address, to: opts.to };
}

// ---------------------------------------------------------------------------
// emailInvoice — high-level: load invoice + render PDF + send
// ---------------------------------------------------------------------------

/**
 * The Send Forms merge fields for an invoice email. Amounts are shown in the INVOICE's currency
 * (the attached PDF's), not always in dollars: a EUR invoice says "€1,000.00" in the email too.
 */
export function invoiceMergeFields(inv: {
  number: string;
  customerName: string;
  companyName: string;
  total: string;
  balanceDue: string;
  dueDate: Date | string | null;
  /** The invoice's currency, else the home currency; anything unusable falls back to USD. */
  currency?: unknown;
}): Record<string, string> {
  const code = typeof inv.currency === 'string' && /^[A-Za-z]{3}$/.test(inv.currency.trim()) ? inv.currency.trim().toUpperCase() : 'USD';
  const money = (v: string) => {
    try {
      return formatCurrency(v, code);
    } catch {
      return formatCurrency(v);
    }
  };
  return {
    number: inv.number,
    'customer.name': inv.customerName,
    'company.name': inv.companyName,
    total: money(inv.total),
    balance: money(inv.balanceDue),
    dueDate: inv.dueDate ? new Date(inv.dueDate).toISOString().slice(0, 10) : '',
  };
}

/**
 * Send an invoice as a PDF attachment to the customer's email (or to a
 * caller-supplied `to` address if the customer email is absent).
 *
 * The PDF prints with the invoice form template (the given `templateId`, else the invoice
 * default template — see lib/pdf/forms.ts) and the subject/body come from the Send Forms
 * preferences (merge fields: {{number}}, {{customer.name}}, {{company.name}}, {{total}},
 * {{balance}}, {{dueDate}}, {{sender.name}}, {{sender.email}}).
 *
 * Throws ServiceError('VALIDATION') when no mail server is set up.
 * Throws ServiceError('NOT_FOUND') when the invoice or company is missing.
 * Throws ServiceError('VALIDATION') when no recipient email can be determined.
 */
export async function emailInvoice(
  ctx: ServiceContext,
  invoiceId: string,
  to?: string | null,
  templateId?: string | null,
): Promise<void> {
  assertNotSandbox('Email');
  // Guard early so we don't do heavy work when no mail server is set up.
  if (!(await isConfigured(ctx))) throw emailNotSetUpError();

  // Load invoice (scoped to company via getInvoice).
  const invoice = await getInvoice(ctx, invoiceId);

  // Load company (letterhead).
  const company = await getCompany(ctx);
  if (!company) {
    throw new ServiceError('NOT_FOUND', 'Company not found.');
  }

  // Load customer display name + email.
  const [customerRow] = await ctx.db
    .select({ displayName: customers.displayName, email: customers.email })
    .from(customers)
    .where(
      and(
        eq(customers.id, invoice.customerId),
        eq(customers.companyId, ctx.companyId),
      ),
    );

  const customerName = customerRow?.displayName ?? 'Customer';
  const recipient = to || customerRow?.email || null;

  if (!recipient) {
    throw new ServiceError(
      'VALIDATION',
      'No recipient email address. Supply a "to" address or add an email to the customer record.',
    );
  }

  // Render PDF with the selected / default invoice template.
  const { bytes: pdfBytes } = await buildInvoicePdf(ctx, invoiceId, templateId);
  // The number the customer sees: the typed ref number, else the legacy integer.
  const shownNumber = docRef(invoice.refNumber, invoice.invoiceNumber);
  const filename = `invoice-${shownNumber.replace(/[^A-Za-z0-9._-]+/g, '_')}.pdf`;

  // Subject + body from Send Forms preferences.
  const prefs = await getPreferences(ctx);
  let home: string | null = null;
  try {
    home = await getHomeCurrencyCode(ctx);
  } catch {
    /* no currency list: fall back to the company setting below */
  }
  const merge = invoiceMergeFields({
    number: shownNumber,
    customerName,
    companyName: company.name,
    total: invoice.total,
    balanceDue: invoice.balanceDue,
    dueDate: invoice.dueDate,
    currency: invoice.currency || home || (company.settings as Record<string, unknown> | null)?.currency,
  });
  Object.assign(merge, await senderMergeFields(ctx));
  const form = prefs.sendForms.invoice;

  await sendMail({
    to: recipient,
    subject: fillMergeFields(form.subject, merge),
    text: fillMergeFields(form.body, merge),
    attachments: [
      {
        filename,
        content: Buffer.from(pdfBytes),
        contentType: 'application/pdf',
      },
    ],
  }, ctx);
}
