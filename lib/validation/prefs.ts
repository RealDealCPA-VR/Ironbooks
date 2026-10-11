/**
 * Zod schemas for the wave-2 Preferences package routes: My Preferences, form templates,
 * to-dos, leads, letters/labels/envelopes, Doc Center attachments, calendar.
 */
import { z } from 'zod';
import { zUuid } from './helpers';
import { FORM_TYPES } from '@/lib/preferences';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ?templateId= query value: null when absent, the id when valid, false when malformed. */
export function templateIdParam(v: string | null | undefined): string | null | false {
  if (v === null || v === undefined || v === '') return null;
  return UUID_RE.test(v) ? v : false;
}

const zIsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

// ---- My Preferences ----
export const myPreferencesSchema = z
  .object({
    enterMovesBetweenFields: z.boolean(),
    beepOnRecord: z.boolean(),
    autoDecimalPoint: z.boolean(),
    warnWhenEditing: z.boolean(),
    warnWhenDeleting: z.boolean(),
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
    showHomeWorkflow: z.boolean(),
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
  name: z.string().trim().min(1).max(255),
  title: z.string().max(100).optional(),
  email: z.string().max(255).optional(),
  phone: z.string().max(50).optional(),
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
export const createLeadSchema = z.object(leadBase);
export const updateLeadSchema = z.object(leadBase).partial();
export const convertLeadSchema = z.object({ displayName: z.string().trim().max(255).optional() });

// ---- Letters ----
const recipientType = z.enum(['customer', 'vendor', 'employee', 'lead']);
export const letterTemplateSchema = z.object({
  category: z.enum(['collection', 'customer', 'vendor', 'employee', 'lead', 'other']),
  name: z.string().trim().min(1).max(100),
  body: z.string().min(1).max(20000),
});
export const updateLetterTemplateSchema = letterTemplateSchema.partial();
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
export const uploadAttachmentSchema = z.object({
  entityType: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/, 'entityType is not valid').nullish(),
  entityId: zUuid.nullish(),
  filename: z.string().trim().min(1, 'filename is required').max(255),
  mimeType: z.string().max(100).optional(),
  base64: z.string().min(1, 'file content is required'),
  description: z.string().max(1000).nullish(),
});
export const updateAttachmentSchema = z.object({
  entityType: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/, 'entityType is not valid').nullish(),
  entityId: zUuid.nullish(),
  description: z.string().max(1000).nullish(),
});

// ---- Calendar ----
export const calendarQuerySchema = z.object({ from: zIsoDay, to: zIsoDay });
