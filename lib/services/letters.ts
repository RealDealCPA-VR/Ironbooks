/**
 * Letters & labels (QB Company > Prepare Letters with Envelopes, File > Print Forms > Labels).
 *
 * Built-in letter templates (collection letters at three levels, thank-you, vendor and employee
 * letters, a lead introduction) plus the company's own templates (letter_templates). A letter is
 * plain text with {{merge.fields}} filled per recipient; output is PDF (letters, Avery 5160
 * labels, #10 envelopes), generated locally.
 *
 * Merge fields: {{date}} {{company.name}} {{company.address}} {{company.phone}} {{company.email}}
 * {{recipient.name}} {{recipient.company}} {{recipient.address}} {{customer.name}} {{balance}}
 * {{overdueBalance}} {{daysOverdue}} {{invoiceList}} {{credits}} {{signer}}
 *
 * Customer balances are NET of unapplied credit memos and unapplied payments (QB's customer
 * balance), so a collection letter never asks for more than the customer actually owes. Credits
 * are treated as applied to the oldest (overdue) invoices first, and are listed in the letter.
 */
import { and, asc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import {
  bills,
  creditMemos,
  customers,
  employees,
  invoices,
  leads,
  letterTemplates,
  paymentsReceived,
  vendors,
} from '@/lib/db/schema';
import { Money, formatCurrency, toAmountString } from '@/lib/money';
import { fillMergeFields, todayInTimeZone } from '@/lib/preferences';
import { addressToLines, companyLetterhead } from '@/lib/pdf/forms';
import { renderEnvelopesPdf, renderLabelsPdf, renderLettersPdf } from '@/lib/pdf/letters';
import { type ServiceContext, notFound, validation, writeAudit } from './_base';
import { getPreferences } from './company';

export const RECIPIENT_TYPES = ['customer', 'vendor', 'employee', 'lead'] as const;
export type RecipientType = (typeof RECIPIENT_TYPES)[number];
export const LETTER_CATEGORIES = ['collection', 'customer', 'vendor', 'employee', 'lead', 'other'] as const;
export type LetterCategory = (typeof LETTER_CATEGORIES)[number];

export interface LetterTemplateView {
  id: string;
  category: LetterCategory;
  name: string;
  body: string;
  builtIn: boolean;
}

const SIGN_OFF = '\n\nSincerely,\n\n\n{{signer}}\n{{company.name}}';
const HEAD = '{{date}}\n\n{{recipient.name}}\n{{recipient.address}}\n\nDear {{recipient.name}},\n\n';

export const BUILTIN_LETTERS: LetterTemplateView[] = [
  {
    id: 'builtin:collection-friendly',
    category: 'collection',
    name: 'Friendly reminder (slightly overdue)',
    builtIn: true,
    body:
      HEAD +
      'This is a friendly reminder that your account has a past-due balance of {{overdueBalance}}. If you have already sent your payment, please disregard this letter and accept our thanks.\n\nOpen invoices:\n{{invoiceList}}\n\nIf you have any questions about your account, please call us at {{company.phone}}.' +
      SIGN_OFF,
  },
  {
    id: 'builtin:collection-firm',
    category: 'collection',
    name: 'Firm reminder (more than 30 days)',
    builtIn: true,
    body:
      HEAD +
      'Our records show that your account is {{daysOverdue}} days past due, with {{overdueBalance}} outstanding. We have not received a response to our earlier reminder.\n\nOpen invoices:\n{{invoiceList}}\n\nPlease send payment within 10 days, or contact us at {{company.phone}} to arrange a payment plan.' +
      SIGN_OFF,
  },
  {
    id: 'builtin:collection-final',
    category: 'collection',
    name: 'Final notice (seriously overdue)',
    builtIn: true,
    body:
      HEAD +
      'Despite our previous letters, your account remains {{daysOverdue}} days past due with an overdue balance of {{overdueBalance}}.\n\nOpen invoices:\n{{invoiceList}}\n\nUnless we receive payment or hear from you within 7 days, we will have to consider further collection steps. We would much rather resolve this with you directly, so please call us at {{company.phone}}.' +
      SIGN_OFF,
  },
  {
    id: 'builtin:customer-thanks',
    category: 'customer',
    name: 'Thank you for your business',
    builtIn: true,
    body: HEAD + 'Thank you for choosing {{company.name}}. We truly appreciate your business and look forward to working with you again.' + SIGN_OFF,
  },
  {
    id: 'builtin:vendor-info',
    category: 'vendor',
    name: 'Request for vendor information (W-9)',
    builtIn: true,
    body:
      HEAD +
      'To keep our records current, please send us a completed Form W-9 with your legal name, address and taxpayer identification number. You can mail it to the address above or email it to {{company.email}}.\n\nThank you for your help.' +
      SIGN_OFF,
  },
  {
    id: 'builtin:employee-welcome',
    category: 'employee',
    name: 'Welcome to the team',
    builtIn: true,
    body: HEAD + 'Welcome to {{company.name}}! We are delighted to have you on the team. Please let us know if there is anything you need as you get settled in.' + SIGN_OFF,
  },
  {
    id: 'builtin:lead-intro',
    category: 'lead',
    name: 'Introduction',
    builtIn: true,
    body: HEAD + 'Thank you for your interest in {{company.name}}. We would welcome the chance to learn more about your needs and show you how we can help. Please call us at {{company.phone}} at your convenience.' + SIGN_OFF,
  },
];

export async function listLetterTemplates(ctx: ServiceContext): Promise<LetterTemplateView[]> {
  const rows = await ctx.db
    .select()
    .from(letterTemplates)
    .where(eq(letterTemplates.companyId, ctx.companyId))
    .orderBy(asc(letterTemplates.name));
  return [
    ...BUILTIN_LETTERS,
    ...rows.map((r) => ({ id: r.id, category: r.category as LetterCategory, name: r.name, body: r.body, builtIn: false })),
  ];
}

function checkTemplate(input: { category?: string; name?: string; body?: string }, creating: boolean) {
  if (creating || input.category !== undefined) {
    if (!LETTER_CATEGORIES.includes(input.category as LetterCategory)) throw validation('Pick a letter category.');
  }
  if (creating || input.name !== undefined) {
    if (!input.name?.trim()) throw validation('A letter template needs a name.');
    if (input.name.trim().length > 100) throw validation('The name is too long.');
  }
  if (creating || input.body !== undefined) {
    if (!input.body?.trim()) throw validation('The letter is empty.');
    if (input.body.length > 20000) throw validation('The letter is too long.');
  }
}

export async function createLetterTemplate(
  ctx: ServiceContext,
  input: { category: string; name: string; body: string },
): Promise<LetterTemplateView> {
  checkTemplate(input, true);
  const [row] = await ctx.db
    .insert(letterTemplates)
    .values({ companyId: ctx.companyId, category: input.category, name: input.name.trim(), body: input.body })
    .returning();
  await writeAudit(ctx, { action: 'create', entityType: 'letter_template', entityId: row.id, newValues: { name: row.name, category: row.category } });
  return { id: row.id, category: row.category as LetterCategory, name: row.name, body: row.body, builtIn: false };
}

async function loadTemplateRow(ctx: ServiceContext, id: string) {
  const [row] = await ctx.db
    .select()
    .from(letterTemplates)
    .where(and(eq(letterTemplates.id, id), eq(letterTemplates.companyId, ctx.companyId)));
  if (!row) throw notFound('Letter template');
  return row;
}

export async function updateLetterTemplate(
  ctx: ServiceContext,
  id: string,
  input: { category?: string; name?: string; body?: string },
): Promise<LetterTemplateView> {
  if (id.startsWith('builtin:')) throw validation('Built-in letters can’t be changed. Save a copy instead.');
  const before = await loadTemplateRow(ctx, id);
  checkTemplate(input, false);
  const [row] = await ctx.db
    .update(letterTemplates)
    .set({
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      updatedAt: new Date(),
    })
    .where(eq(letterTemplates.id, id))
    .returning();
  await writeAudit(ctx, {
    action: 'update',
    entityType: 'letter_template',
    entityId: id,
    oldValues: { name: before.name, category: before.category, body: before.body },
    newValues: { name: row.name, category: row.category, body: row.body },
  });
  return { id: row.id, category: row.category as LetterCategory, name: row.name, body: row.body, builtIn: false };
}

export async function deleteLetterTemplate(ctx: ServiceContext, id: string): Promise<void> {
  if (id.startsWith('builtin:')) throw validation('Built-in letters can’t be deleted.');
  const before = await loadTemplateRow(ctx, id);
  await ctx.db.delete(letterTemplates).where(eq(letterTemplates.id, id));
  await writeAudit(ctx, { action: 'delete', entityType: 'letter_template', entityId: id, oldValues: { name: before.name } });
}

async function resolveLetterBody(ctx: ServiceContext, templateId: string): Promise<string> {
  const builtin = BUILTIN_LETTERS.find((b) => b.id === templateId);
  if (builtin) return builtin.body;
  if (!/^[0-9a-f-]{36}$/i.test(templateId)) throw notFound('Letter template');
  return (await loadTemplateRow(ctx, templateId)).body;
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

export interface Recipient {
  id: string;
  type: RecipientType;
  name: string;
  company: string | null;
  addressLines: string[];
  email: string | null;
  balance: string | null;
  overdueBalance: string | null;
  daysOverdue: number | null;
  invoiceList: string | null;
  /** Customers: unapplied credit memos + unapplied payments already deducted from `balance`. */
  credits?: string | null;
}

export interface ListRecipientsOptions {
  type: RecipientType;
  /** Customers only: keep only those with a balance overdue by at least this many days. */
  overdueDays?: number;
  /** Customers/vendors: keep only those owing (or owed) at least this amount. */
  minBalance?: string | number;
  includeInactive?: boolean;
  /** Restrict to these ids. */
  ids?: string[];
  today?: string;
}

function dayOf(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

export async function listRecipients(ctx: ServiceContext, opts: ListRecipientsOptions): Promise<Recipient[]> {
  if (!RECIPIENT_TYPES.includes(opts.type)) throw validation('Unknown recipient type.');
  const prefs = await getPreferences(ctx);
  const today = opts.today ?? todayInTimeZone(prefs.timezone);
  const idFilter = opts.ids && opts.ids.length > 0 ? new Set(opts.ids) : null;
  let list: Recipient[] = [];

  if (opts.type === 'customer') {
    const rows = await ctx.db
      .select()
      .from(customers)
      .where(eq(customers.companyId, ctx.companyId))
      .orderBy(asc(customers.displayName));
    const open = await ctx.db
      .select({
        customerId: invoices.customerId,
        n: invoices.invoiceNumber,
        date: invoices.date,
        due: invoices.dueDate,
        balance: invoices.balanceDue,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, ctx.companyId),
          inArray(invoices.status, ['open', 'partial', 'overdue']),
          gt(invoices.balanceDue, '0'),
        ),
      );
    // Unapplied credits (credit memos + payments not yet applied to an invoice) reduce what is owed.
    // Voiding zeroes `unapplied`, but filter void/voided rows anyway.
    const credit = new Map<string, ReturnType<typeof Money.zero>>();
    const addCredit = (id: string, amt: string) => {
      if (Money.isPositive(amt)) credit.set(id, (credit.get(id) ?? Money.zero()).plus(Money.of(amt)));
    };
    const memoCredits = await ctx.db
      .select({ customerId: creditMemos.customerId, amt: creditMemos.unapplied })
      .from(creditMemos)
      .where(and(eq(creditMemos.companyId, ctx.companyId), ne(creditMemos.status, 'void'), gt(creditMemos.unapplied, '0')));
    for (const m of memoCredits) addCredit(m.customerId, m.amt);
    const payCredits = await ctx.db
      .select({ customerId: paymentsReceived.customerId, amt: paymentsReceived.unapplied })
      .from(paymentsReceived)
      .where(
        and(
          eq(paymentsReceived.companyId, ctx.companyId),
          isNull(paymentsReceived.voidedAt),
          gt(paymentsReceived.unapplied, '0'),
        ),
      );
    for (const p of payCredits) addCredit(p.customerId, p.amt);

    const byCustomer = new Map<string, typeof open>();
    for (const o of open) {
      const l = byCustomer.get(o.customerId) ?? [];
      l.push(o);
      byCustomer.set(o.customerId, l);
    }
    // Aging basis follows Preferences > Reports (from due date or from transaction date).
    const agingFromDue = prefs.agingFrom !== 'transaction_date';
    list = rows
      .filter((r) => opts.includeInactive || r.isActive)
      .map((r) => {
        const inv = (byCustomer.get(r.id) ?? []).sort((a, b) => a.n - b.n);
        let balance = Money.zero();
        let overdue = Money.zero();
        let maxDays = 0;
        const lines: string[] = [];
        for (const i of inv) {
          balance = balance.plus(Money.of(i.balance));
          const basis = dayOf(agingFromDue ? (i.due ?? i.date) : i.date) ?? today;
          const days = daysBetween(basis, today);
          if (days > 0) {
            overdue = overdue.plus(Money.of(i.balance));
            maxDays = Math.max(maxDays, days);
          }
          lines.push(
            `  Invoice ${i.n}  dated ${dayOf(i.date)}${i.due ? `, due ${dayOf(i.due)}` : ''}: ${formatCurrency(i.balance)}${days > 0 ? ` (${days} days overdue)` : ''}`,
          );
        }
        const credits = credit.get(r.id) ?? Money.zero();
        if (credits.greaterThan(0)) {
          lines.push(`  Less unapplied credits and payments: -${formatCurrency(toAmountString(credits))}`);
          balance = balance.minus(credits);
          // Credits apply to the oldest (overdue) invoices first; overdue never goes below zero.
          overdue = overdue.greaterThan(credits) ? overdue.minus(credits) : Money.zero();
          if (!overdue.greaterThan(0)) maxDays = 0;
        }
        return {
          id: r.id,
          type: 'customer' as const,
          name: r.displayName,
          company: r.companyName,
          addressLines: addressToLines(r.billingAddress),
          email: r.email,
          balance: toAmountString(balance),
          overdueBalance: toAmountString(overdue),
          daysOverdue: maxDays,
          invoiceList: lines.join('\n') || '  (no open invoices)',
          credits: toAmountString(credits),
        };
      });
    if (opts.overdueDays !== undefined) {
      list = list.filter((r) => Money.isPositive(r.overdueBalance!) && (r.daysOverdue ?? 0) >= opts.overdueDays!);
    }
  } else if (opts.type === 'vendor') {
    const rows = await ctx.db.select().from(vendors).where(eq(vendors.companyId, ctx.companyId)).orderBy(asc(vendors.displayName));
    const open = await ctx.db
      .select({ vendorId: bills.vendorId, balance: bills.balanceDue })
      .from(bills)
      .where(and(eq(bills.companyId, ctx.companyId), inArray(bills.status, ['open', 'partial', 'overdue'])));
    const owed = new Map<string, ReturnType<typeof Money.zero>>();
    for (const b of open) owed.set(b.vendorId, (owed.get(b.vendorId) ?? Money.zero()).plus(Money.of(b.balance)));
    list = rows
      .filter((r) => opts.includeInactive || r.isActive)
      .map((r) => ({
        id: r.id,
        type: 'vendor' as const,
        name: r.displayName,
        company: r.companyName,
        addressLines: addressToLines(r.address),
        email: r.email,
        balance: toAmountString(owed.get(r.id) ?? Money.zero()),
        overdueBalance: null,
        daysOverdue: null,
        invoiceList: null,
      }));
  } else if (opts.type === 'employee') {
    const rows = await ctx.db.select().from(employees).where(eq(employees.companyId, ctx.companyId)).orderBy(asc(employees.lastName));
    list = rows
      .filter((r) => opts.includeInactive || r.isActive)
      .map((r) => ({
        id: r.id,
        type: 'employee' as const,
        name: `${r.firstName} ${r.lastName}`.trim(),
        company: null,
        addressLines: addressToLines(r.address as Record<string, string> | null),
        email: r.email,
        balance: null,
        overdueBalance: null,
        daysOverdue: null,
        invoiceList: null,
      }));
  } else {
    const rows = await ctx.db.select().from(leads).where(eq(leads.companyId, ctx.companyId)).orderBy(asc(leads.name));
    list = rows
      .filter((r) => (opts.includeInactive || r.isActive) && !r.convertedCustomerId)
      .map((r) => ({
        id: r.id,
        type: 'lead' as const,
        name: r.name,
        company: r.companyName,
        addressLines: addressToLines(r.address),
        email: r.email,
        balance: null,
        overdueBalance: null,
        daysOverdue: null,
        invoiceList: null,
      }));
  }
  if (opts.minBalance !== undefined && opts.minBalance !== '') {
    const min = Money.of(opts.minBalance);
    list = list.filter((r) => r.balance !== null && Money.gte(r.balance, min));
  }
  if (idFilter) list = list.filter((r) => idFilter.has(r.id));
  return list;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface PrepareLettersInput {
  recipientType: RecipientType;
  recipientIds: string[];
  /** A built-in ('builtin:…') or custom template id — or `body` for a one-off letter. */
  templateId?: string;
  body?: string;
  signer?: string;
  /** 'YYYY-MM-DD' printed as the letter date (default today). */
  date?: string;
}

function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export async function mergeLetters(ctx: ServiceContext, input: PrepareLettersInput): Promise<Array<{ recipientId: string; body: string }>> {
  if (!input.recipientIds?.length) throw validation('Pick at least one recipient.');
  if (input.recipientIds.length > 1000) throw validation('Print at most 1,000 letters at a time.');
  const body = input.body?.trim() ? input.body : input.templateId ? await resolveLetterBody(ctx, input.templateId) : null;
  if (!body) throw validation('Pick a letter template (or write the letter).');
  const prefs = await getPreferences(ctx);
  const today = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : todayInTimeZone(prefs.timezone);
  const recipients = await listRecipients(ctx, { type: input.recipientType, ids: input.recipientIds, includeInactive: true, today });
  if (recipients.length === 0) throw notFound('Recipients');
  const lh = await companyLetterhead(ctx);
  return recipients.map((r) => ({
    recipientId: r.id,
    body: fillMergeFields(body, {
      date: longDate(today),
      'company.name': lh.name,
      'company.address': lh.addressLines.join('\n'),
      'company.phone': lh.phone ?? '',
      'company.email': lh.email ?? '',
      'recipient.name': r.name,
      'customer.name': r.name,
      'vendor.name': r.name,
      'recipient.company': r.company ?? '',
      'recipient.address': r.addressLines.join('\n'),
      balance: r.balance !== null ? formatCurrency(r.balance) : '',
      overdueBalance: r.overdueBalance !== null ? formatCurrency(r.overdueBalance) : '',
      daysOverdue: r.daysOverdue ?? '',
      invoiceList: r.invoiceList ?? '',
      credits: r.credits ? formatCurrency(r.credits) : '',
      signer: input.signer?.trim() || lh.name,
    }),
  }));
}

export async function prepareLettersPdf(ctx: ServiceContext, input: PrepareLettersInput): Promise<Uint8Array> {
  const merged = await mergeLetters(ctx, input);
  return renderLettersPdf(merged, await companyLetterhead(ctx));
}

export async function labelsPdf(
  ctx: ServiceContext,
  input: { recipientType: RecipientType; recipientIds: string[]; startPosition?: number },
): Promise<Uint8Array> {
  if (!input.recipientIds?.length) throw validation('Pick at least one recipient.');
  const recipients = await listRecipients(ctx, { type: input.recipientType, ids: input.recipientIds, includeInactive: true });
  return renderLabelsPdf(
    recipients.map((r) => [r.name, ...(r.company && r.company !== r.name ? [r.company] : []), ...r.addressLines]),
    { startPosition: input.startPosition },
  );
}

export async function envelopesPdf(
  ctx: ServiceContext,
  input: { recipientType: RecipientType; recipientIds: string[]; includeReturnAddress?: boolean },
): Promise<Uint8Array> {
  if (!input.recipientIds?.length) throw validation('Pick at least one recipient.');
  const recipients = await listRecipients(ctx, { type: input.recipientType, ids: input.recipientIds, includeInactive: true });
  const lh = await companyLetterhead(ctx);
  return renderEnvelopesPdf(
    recipients.map((r) => [r.name, ...(r.company && r.company !== r.name ? [r.company] : []), ...r.addressLines]),
    input.includeReturnAddress === false ? null : [lh.name, ...lh.addressLines],
  );
}
