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
import { getCompany } from './company';
import { renderInvoicePdf } from '@/lib/pdf/invoice';
import { assertOutboundAllowed } from '@/lib/net/guard';

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

/** Format a Date or string as YYYY-MM-DD for the PDF renderer. */
function fmtDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 10);
}

/**
 * Send an invoice as a PDF attachment to the customer's email (or to a
 * caller-supplied `to` address if the customer email is absent).
 *
 * Throws ServiceError('VALIDATION') when SMTP is not configured.
 * Throws ServiceError('NOT_FOUND') when the invoice or company is missing.
 * Throws ServiceError('VALIDATION') when no recipient email can be determined.
 */
export async function emailInvoice(
  ctx: ServiceContext,
  invoiceId: string,
  to?: string | null,
): Promise<void> {
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

  // The number the customer sees: the typed ref number, else the legacy integer.
  const shownNumber = docRef(invoice.refNumber, invoice.invoiceNumber);

  // Render PDF.
  const pdfBytes = await renderInvoicePdf({
    company: { name: company.name },
    customerName,
    invoice: {
      number: shownNumber,
      date: fmtDate(invoice.date),
      dueDate: invoice.dueDate ? fmtDate(invoice.dueDate) : null,
      subtotal: invoice.subtotal,
      discount: invoice.discount,
      tax: invoice.taxAmount,
      total: invoice.total,
      balanceDue: invoice.balanceDue,
    },
    lines: invoice.lines.map((l) => ({
      description: l.description ?? '',
      quantity: l.quantity,
      rate: l.rate,
      amount: l.amount,
    })),
  });

  const filename = `invoice-${shownNumber.replace(/[^A-Za-z0-9._-]+/g, '_')}.pdf`;

  await sendMail({
    to: recipient,
    subject: `Invoice #${shownNumber} from ${company.name}`,
    text: [
      `Dear ${customerName},`,
      '',
      `Please find attached Invoice #${shownNumber} from ${company.name}.`,
      `Total: ${invoice.total}`,
      `Balance Due: ${invoice.balanceDue}`,
      '',
      'Thank you for your business.',
      company.name,
    ].join('\n'),
    attachments: [
      {
        filename,
        content: Buffer.from(pdfBytes),
        contentType: 'application/pdf',
      },
    ],
  }, ctx);
}
