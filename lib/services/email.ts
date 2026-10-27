/**
 * Email service — send invoices via configurable SMTP (nodemailer).
 *
 * Configuration is read entirely from environment variables:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 *
 * None of the env vars are required to start the app; `isConfigured()` returns
 * false when they are absent, and `sendMail` / `emailInvoice` throw a friendly
 * VALIDATION ServiceError so the API layer can surface the hint to the UI.
 */
import nodemailer from 'nodemailer';
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
import { assertOutboundAllowed } from '@/lib/net/guard';
import { assertNotSandbox } from './sandboxState';
import { getHomeCurrencyCode } from './currencies';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function isConfigured(): boolean {
  return !!(
    process.env.SMTP_HOST &&
    process.env.SMTP_PORT &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    process.env.SMTP_FROM
  );
}

/** Bracket bare IPv6 literals so the host can be embedded in a URL for the policy check. */
function smtpHostForUrl(host: string): string {
  const h = host.trim();
  return h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
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

export async function sendMail(opts: MailOptions, ctx: ServiceContext): Promise<void> {
  // Sandbox mode: nothing leaves a practice copy (checked first, even before SMTP config).
  assertNotSandbox('Email');
  if (!isConfigured()) {
    throw new ServiceError(
      'VALIDATION',
      'Email not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM environment variables.',
    );
  }

  // Network policy: an SMTP relay on the LAN/tailnet is always fine; a public mail provider
  // needs the company's explicit cloud opt-in for 'email' (Settings → Privacy & Network).
  const port = Number(process.env.SMTP_PORT!);
  await assertOutboundAllowed(
    `${port === 465 ? 'smtps' : 'smtp'}://${smtpHostForUrl(process.env.SMTP_HOST!)}:${port}`,
    'email',
    ctx,
  );

  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST!,
    port: Number(process.env.SMTP_PORT!),
    secure: Number(process.env.SMTP_PORT!) === 465,
    auth: {
      user: process.env.SMTP_USER!,
      pass: process.env.SMTP_PASS!,
    },
  });

  await transport.sendMail({
    from: process.env.SMTP_FROM!,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    attachments: opts.attachments,
  });
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
 * {{balance}}, {{dueDate}}).
 *
 * Throws ServiceError('VALIDATION') when SMTP is not configured.
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
  // Guard early so we don't do heavy work when SMTP is unconfigured.
  if (!isConfigured()) {
    throw new ServiceError(
      'VALIDATION',
      'Email not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and SMTP_FROM environment variables.',
    );
  }

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
