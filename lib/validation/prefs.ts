/**
 * Zod schemas for the wave-2 Preferences package routes: My Preferences, form templates,
 * to-dos, leads, letters/labels/envelopes, Doc Center attachments, calendar.
 */
import { z } from 'zod';
import { describeShape, zUuid } from './helpers';
import { FORM_TYPES, MAX_FAVORITES, isFavoritePath } from '@/lib/preferences';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ?templateId= query value: null when absent, the id when valid, false when malformed. */
export function templateIdParam(v: string | null | undefined): string | null | false {
  if (v === null || v === undefined || v === '') return null;
  return UUID_RE.test(v) ? v : false;
}

/** True when `v` is a real calendar day in YYYY-MM-DD form (rejects 2026-02-30, 2026-13-01). */
export function isRealIsoDay(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const zIsoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
  .refine(isRealIsoDay, 'is not a real date');

// ---- My Preferences ----
export const myPreferencesSchema = z
  .object({
    enterMovesBetweenFields: z.boolean(),
    beepOnRecord: z.boolean(),
    autoDecimalPoint: z.boolean(),
    warnWhenEditing: z.boolean(),
    // Always on: deleting or voiding always asks first (shown locked on the Preferences page).
    warnWhenDeleting: z
      .boolean()
      .refine((v) => v === true, 'is always on: deleting or voiding always asks first, because it cannot be undone'),
    defaultDate: z.enum(['today', 'last']),
    autoRecallLastTransaction: z.boolean(),
    keepQuickBooksRunning: z.boolean(),
    showRemindersAtStartup: z.boolean(),
    reportsRefresh: z.enum(['prompt', 'auto', 'never']),
    spellCheckEnabled: z.boolean(),
    spellIgnoreUppercase: z.boolean(),
    spellIgnoreWithNumbers: z.boolean(),
    spellIgnoreInternetAddresses: z.boolean(),
    startWithPayee: z.boolean(),
    // prefsperms: Send Forms - who my emails come from.
    sendFromName: z.string().trim().max(100),
    sendFromEmail: z.union([z.literal(''), z.string().trim().max(255).email('must be an email address')]),
    bccMe: z.boolean(),
    showHomeWorkflow: z.boolean(),
    navMode: z.enum(['simple', 'advanced']),
    quickBooksNames: z.boolean(),
    density: z.enum(['comfortable', 'compact']),
    // The Favorites menu: in-app page paths, in order.
    favorites: z
      .array(z.string().refine(isFavoritePath, 'must be a page of the app, like /invoices'))
      .max(MAX_FAVORITES, `can hold at most ${MAX_FAVORITES} pages`),
    // prefsperms A2: Desktop View, Search and Calendar.
    startPage: z.enum(['home', 'last']),
    showSearchBox: z.boolean(),
    searchDefault: z.enum(['pages', 'everything']),
    calendarView: z.enum(['day', 'week', 'month', 'last']),
    calendarWeek: z.enum(['company', 'sun_sat', 'mon_sun', 'mon_fri']),
    calendarShowEntered: z.boolean(),
    calendarShowDue: z.boolean(),
    calendarPastDueDays: z.number().int('must be a whole number of days').min(0).max(365),
    calendarUpcomingDays: z.number().int('must be a whole number of days').min(0).max(365),
  })
  .partial()
  .strict();

// ---- Form templates ----
export const formTypeSchema = z.enum(FORM_TYPES);
/** Design is normalized by the service (unknown keys dropped, bad values defaulted). */
const zDesign = z.record(z.unknown());

export const createFormTemplateSchema = z.object({
  formType: formTypeSchema,
  name: z.string().trim().min(1, 'name is required').max(100),
  design: zDesign.optional(),
  isDefault: z.boolean().optional(),
  copyFromId: zUuid.nullish(),
});

export const updateFormTemplateSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(100).optional(),
  design: zDesign.optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const uploadFileSchema = z.object({
  filename: z.string().trim().min(1, 'filename is required').max(255),
  mimeType: z.string().max(100).default('application/octet-stream'),
  base64: z.string().min(1, 'file content is required'),
});

export const previewFormTemplateSchema = z.object({
  formType: formTypeSchema,
  design: zDesign.optional(),
  /** Reuse a saved template's logo in the live preview. */
  templateId: zUuid.nullish(),
});

// ---- To-dos ----
const todoBase = {
  title: z.string().trim().min(1, 'A to-do needs a short description.').max(255),
  notes: z.string().max(5000).nullish(),
  kind: z.enum(['call', 'meeting', 'task', 'email']).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  dueDate: zIsoDay.nullish(),
  dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM').nullish(),
  done: z.boolean().optional(),
  entityType: z.enum(['customer', 'vendor', 'employee', 'lead']).nullish(),
  entityId: zUuid.nullish(),
};
export const createTodoSchema = z.object(todoBase);
export const updateTodoSchema = z.object(todoBase).partial();

// ---- Leads ----
const contactSchema = z.object({
  name: z.string().trim().min(1).max(255).describe('Name of the contact person.'),
  title: z.string().max(100).optional().describe('Job title of the contact; leave out for none.'),
  email: z.string().max(255).optional().describe('Email address of the contact; leave out for none.'),
  phone: z.string().max(50).optional().describe('Phone number of the contact; leave out for none.'),
});
const leadBase = {
  name: z.string().trim().min(1, 'A lead needs a name.').max(255),
  companyName: z.string().max(255).nullish(),
  status: z.enum(['hot', 'warm', 'cold']).optional(),
  email: z.union([z.literal(''), z.string().email('is not a valid email address')]).nullish(),
  phone: z.string().max(50).nullish(),
  website: z.string().max(255).nullish(),
  address: z.record(z.string()).nullish(),
  contacts: z.array(contactSchema).max(50).nullish(),
  notes: z.string().max(10000).nullish(),
  isActive: z.boolean().optional(),
};
// The edit takes the same fields, each optional; updateLead (lib/services/leads.ts) keeps every
// field left out, and null or blank text clears one. Both are built from leadBase itself
// (describeShape), so a field added to it reaches both and must be described there.
export const createLeadSchema = z.object(
  describeShape(leadBase, {
    name: 'Name of the lead (a person or a business), at most 255 characters.',
    companyName: "The lead's company name; leave out for none. On converting, it becomes the customer name.",
    status: 'hot, warm or cold; leave out for warm.',
    email: 'Email address of the lead; leave out for none.',
    phone: 'Phone number of the lead (at most 50 characters); leave out for none.',
    website: 'Website of the lead; leave out for none.',
    address: 'Address as named text lines such as line1, line2, city, state, zip and country; leave out for none.',
    contacts: 'Contact people at the lead, at most 50; leave out for none.',
    notes: 'Notes about the lead (at most 10,000 characters); leave out for none.',
    isActive: 'False adds the lead as inactive; leave out for active.',
  }),
);
export const updateLeadSchema = z
  .object(
    describeShape(leadBase, {
      name: 'New name of the lead; leave out to keep the name.',
      companyName: "The lead's company name; leave out to keep it, or send null to clear it.",
      status: 'hot, warm or cold; leave out to keep it.',
      email: 'Email address of the lead; leave out to keep it, or send null or "" to clear it.',
      phone: 'Phone number of the lead; leave out to keep it, or send null to clear it.',
      website: 'Website of the lead; leave out to keep it, or send null to clear it.',
      address: 'Address as named text lines such as line1, city, state and zip, replacing the saved one; leave out to keep it, or send null to clear it.',
      contacts: 'All contact people of the lead, replacing the saved ones; leave out to keep them, or send null to remove them all.',
      notes: 'Notes about the lead, replacing the saved ones; leave out to keep them, or send null to clear them.',
      isActive: 'False makes the lead inactive; true makes it active again. Leave out to keep it.',
    }),
  )
  .partial();
export const convertLeadSchema = z.object({
  displayName: z
    .string()
    .trim()
    .max(255)
    .optional()
    .describe("Name of the new customer; leave out for the lead's company name, or its name when it has none."),
});

// ---- Letters ----
const recipientType = z.enum(['customer', 'vendor', 'employee', 'lead']);
export const letterTemplateSchema = z.object({
  category: z
    .enum(['collection', 'customer', 'vendor', 'employee', 'lead', 'other'])
    .describe('Which letters list the template is under: collection, customer, vendor, employee, lead or other.'),
  name: z.string().trim().min(1).max(100).describe('Name of the template, such as "Friendly reminder" (at most 100 characters).'),
  body: z
    .string()
    .min(1)
    .max(20000)
    .describe(
      'Text of the letter, with merge fields filled per recipient, such as {{date}}, {{recipient.name}}, {{recipient.address}}, {{balance}}, {{overdueBalance}}, {{invoiceList}}, {{company.name}} and {{signer}}.',
    ),
});
export const updateLetterTemplateSchema = z
  .object(
    describeShape(letterTemplateSchema.shape, {
      category: 'Which letters list the template is under; leave out to keep it.',
      name: 'New name of the template; leave out to keep the name.',
      body: 'Text of the letter with its merge fields, replacing the saved text; leave out to keep it.',
    }),
  )
  .partial();
export const prepareLettersSchema = z
  .object({
    recipientType,
    recipientIds: z.array(zUuid).min(1, 'Pick at least one recipient.').max(1000),
    templateId: z.string().max(64).optional(),
    body: z.string().max(20000).optional(),
    signer: z.string().max(100).optional(),
    date: zIsoDay.optional(),
  })
  .refine((v) => v.templateId || v.body, { message: 'Pick a letter template (or write the letter).' });
export const labelsSchema = z.object({
  recipientType,
  recipientIds: z.array(zUuid).min(1, 'Pick at least one recipient.').max(3000),
  startPosition: z.number().int().min(1).max(30).optional(),
});
export const envelopesSchema = z.object({
  recipientType,
  recipientIds: z.array(zUuid).min(1, 'Pick at least one recipient.').max(1000),
  includeReturnAddress: z.boolean().optional(),
});

// ---- Doc Center ----
/** The record kinds a document can be filed to (FILING_TABLES in lib/services/attachments.ts). */
const FILING_KINDS =
  'invoice, bill, expense, journal_entry, customer, vendor, employee, paycheck, estimate, sales_receipt, sales_order, ' +
  'purchase_order, credit_memo, vendor_credit, payment_received, bill_payment, item, lead, form_template or deposit';
const zEntityType = z.string().regex(/^[a-z][a-z0-9_]{0,99}$/, 'entityType is not valid');

export const uploadAttachmentSchema = z.object({
  entityType: zEntityType
    .nullish()
    .describe(`Kind of record the document is filed to, such as ${FILING_KINDS}; send it with entityId, or leave both out to put the document in the Doc Center inbox.`),
  entityId: zUuid.nullish().describe('Id of that record; send it with entityType.'),
  filename: z.string().trim().min(1, 'filename is required').max(255).describe('File name with its extension, such as "receipt-0412.pdf".'),
  mimeType: z.string().max(100).optional().describe('Content type of the file, such as "application/pdf"; leave out for none.'),
  base64: z.string().min(1, 'file content is required').describe("The file's bytes as base64 text, at most 25 MB before encoding."),
  description: z.string().max(1000).nullish().describe('Description shown with the document; leave out for none.'),
});
export const updateAttachmentSchema = z.object({
  entityType: zEntityType
    .nullish()
    .describe(`Kind of record to file the document to, such as ${FILING_KINDS}; send it with entityId. Send both as null to move it back to the inbox, or leave both out to keep where it is filed.`),
  entityId: zUuid.nullish().describe('Id of that record; send it with entityType.'),
  description: z.string().max(1000).nullish().describe('Description shown with the document; leave out to keep it, or send null to clear it.'),
});

// ---- Calendar ----
export const calendarQuerySchema = z.object({ from: zIsoDay, to: zIsoDay });

// ---------------------------------------------------------------------------
// prefsperms: Preferences > Send Forms mail server (lib/services/emailSettings.ts)
// ---------------------------------------------------------------------------

/** The mail server form. `password`: a string sets it, null / '' removes it, absent keeps it. */
export const emailSetupSchema = z
  .object({
    host: z.string().trim().min(1, 'enter the mail server name').max(255),
    port: z.coerce.number().int('must be a whole number').min(1).max(65535),
    security: z.enum(['ssl', 'starttls', 'none']),
    username: z.string().max(255).nullish(),
    password: z.string().max(500).nullish(),
    fromName: z.string().max(255).nullish(),
    fromEmail: z.string().trim().min(1, 'enter the address forms are sent from').max(255),
    replyTo: z.string().max(255).nullish(),
    bcc: z.string().max(500).nullish(),
    useSenderAddress: z.boolean().optional(),
  })
  .strict();

/** Test: the saved settings (no draft) or the typed, not yet saved ones; `to` = where to send it. */
export const emailTestSchema = z
  .object({
    to: z.string().max(255).nullish(),
    draft: emailSetupSchema.nullish(),
  })
  .strict();
