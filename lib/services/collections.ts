/**
 * Collections Center actions (C9) — what a bookkeeper DOES about a late customer, beyond reading
 * the list (lib/services/incomeTracker.collectionsCenter):
 *
 *  - record a contact or a note (`recordCollectionContact`): a dated collection note saying how
 *    the customer was reached ('call', 'email', 'letter', ...), with an optional follow-up date
 *    that can also go on the To Do list (todos.createTodo, linked to the customer) and a copy on
 *    the customer's own Notes (lists/notes.addNote). The latest contact is the customer's
 *    "last contacted" in the Collections Center;
 *  - email the overdue invoices or a statement (`emailCollectionReminder`) through the app's own
 *    email flow (salesForms.emailSalesForm / emailCustomerStatement: SMTP settings, the company's
 *    network opt-in and sandbox rules apply there), recorded as an email contact;
 *  - print a collection letter (`collectionLetter`) from the Letters templates
 *    (letters.prepareLettersPdf), recorded as a letter contact.
 *
 * No GL impact. Everything is company-scoped and audited (the note, the to-do, the email).
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { collectionNotes, customers, invoices } from '@/lib/db/schema';
import { type ServiceContext, ServiceError, inTransaction, notFound, validation, writeAudit } from './_base';
import { emailCustomerStatement, emailSalesForm } from './salesForms';
import { listLetterTemplates, prepareLettersPdf } from './letters';
import { createTodo, type TodoKind } from './todos';
import { addNote } from './lists/notes';
import { companyToday } from './salesDates';
import { docRef } from './docNumbers';
import { isRealIsoDay } from '@/lib/validation/prefs';

export const CONTACT_METHODS = ['call', 'email', 'letter', 'statement', 'visit', 'other'] as const;
export type ContactMethod = (typeof CONTACT_METHODS)[number];

export const CONTACT_LABEL: Record<ContactMethod, string> = {
  call: 'Phone call',
  email: 'Email',
  letter: 'Collection letter',
  statement: 'Statement',
  visit: 'Visit',
  other: 'Other contact',
};

const DEFAULT_TEXT: Record<ContactMethod, string> = {
  call: 'Called the customer about the overdue balance.',
  email: 'Emailed the customer about the overdue balance.',
  letter: 'Sent a collection letter.',
  statement: 'Sent a statement.',
  visit: 'Visited the customer about the overdue balance.',
  other: 'Contacted the customer about the overdue balance.',
};

const TODO_KIND: Record<ContactMethod, TodoKind> = {
  call: 'call',
  email: 'email',
  letter: 'task',
  statement: 'task',
  visit: 'meeting',
  other: 'task',
};

export interface CollectionContactInput {
  customerId: string;
  /** How the customer was contacted; null / undefined = a plain note (not a contact). */
  method?: ContactMethod | null;
  /** What happened ("promised to pay Friday"). Optional for a contact (a default is written). */
  note?: string | null;
  /** The invoice the note is about (one of the customer's). */
  invoiceId?: string | null;
  /** 'YYYY-MM-DD': when to follow up. */
  followUpDate?: string | null;
  /** Also put the follow-up on the To Do list (needs a follow-up date). */
  addTodo?: boolean;
  /** Also save the note on the customer's Notes. */
  addCustomerNote?: boolean;
}

export interface CollectionContactResult {
  note: typeof collectionNotes.$inferSelect;
  todoId: string | null;
  customerNoteId: string | null;
}

async function customerOf(ctx: ServiceContext, customerId: unknown) {
  if (typeof customerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(customerId)) throw notFound('Customer');
  const [c] = await ctx.db
    .select({ id: customers.id, name: customers.displayName, email: customers.email })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, customerId)));
  if (!c) throw notFound('Customer');
  return c;
}

function followUpDay(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !isRealIsoDay(v)) throw validation('The follow-up date is not a valid date.');
  return v;
}

/**
 * Record a collection note — a contact when `method` is given — with an optional follow-up
 * (also on the To Do list) and an optional copy on the customer's Notes. One transaction.
 */
export async function recordCollectionContact(
  ctx: ServiceContext,
  input: CollectionContactInput,
): Promise<CollectionContactResult> {
  const cust = await customerOf(ctx, input.customerId);
  const method = input.method ?? null;
  if (method !== null && !CONTACT_METHODS.includes(method)) throw validation('Pick how you contacted the customer.');
  const text = input.note?.trim() || (method ? DEFAULT_TEXT[method] : '');
  if (!text) throw validation('Type a note first.');
  if (text.length > 4000) throw validation('Notes are limited to 4,000 characters.');
  const follow = followUpDay(input.followUpDate);
  if (input.addTodo && !follow) throw validation('Pick a follow-up date to add it to the To Do list.');
  if (input.invoiceId) {
    const [i] = await ctx.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(eq(invoices.companyId, ctx.companyId), eq(invoices.id, input.invoiceId), eq(invoices.customerId, cust.id)));
    if (!i) throw notFound('Invoice');
  }

  return inTransaction(ctx, async (tx) => {
    const [row] = await tx.db
      .insert(collectionNotes)
      .values({
        companyId: tx.companyId,
        customerId: cust.id,
        invoiceId: input.invoiceId ?? null,
        note: text,
        followUpDate: follow ? new Date(`${follow}T00:00:00.000Z`) : null,
        createdBy: tx.userId,
        contactMethod: method,
      })
      .returning();
    await writeAudit(tx, { action: 'create', entityType: 'collection_note', entityId: row.id, newValues: row });

    let todoId: string | null = null;
    if (input.addTodo && follow) {
      const todo = await createTodo(tx, {
        title: `Collections follow-up: ${cust.name}`.slice(0, 200),
        notes: text,
        kind: method ? TODO_KIND[method] : 'call',
        priority: 'high',
        dueDate: follow,
        entityType: 'customer',
        entityId: cust.id,
      });
      todoId = todo.id;
    }
    let customerNoteId: string | null = null;
    if (input.addCustomerNote) {
      const n = await addNote(tx, {
        entityType: 'customer',
        entityId: cust.id,
        body: `Collections${method ? ` (${CONTACT_LABEL[method].toLowerCase()})` : ''}: ${text}${follow ? ` Follow up ${follow}.` : ''}`,
      });
      customerNoteId = n.id;
    }
    return { note: row, todoId, customerNoteId };
  });
}

/** The customer's open invoices that are past due on the company's today (oldest first). */
async function overdueInvoices(ctx: ServiceContext, customerId: string) {
  const today = (await companyToday(ctx)).getTime();
  const rows = await ctx.db
    .select({ id: invoices.id, num: invoices.invoiceNumber, ref: invoices.refNumber, due: invoices.dueDate, date: invoices.date })
    .from(invoices)
    .where(
      and(
        eq(invoices.companyId, ctx.companyId),
        eq(invoices.customerId, customerId),
        inArray(invoices.status, ['open', 'partial', 'overdue']),
        sql`CAST(${invoices.balanceDue} AS NUMERIC) > 0`,
      ),
    )
    .orderBy(asc(invoices.dueDate), asc(invoices.date));
  // Past due = the due day (else the invoice day) is before today, as the Collections Center counts.
  return rows.filter((r) => {
    const d = r.due ?? r.date;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) < today;
  });
}

export interface CollectionEmailInput {
  customerId: string;
  /** 'invoices': each overdue invoice (or `invoiceIds`) as a PDF; 'statement': one statement. */
  what: 'invoices' | 'statement';
  /** Limit 'invoices' to these (each must be one of the customer's open invoices). */
  invoiceIds?: string[] | null;
  /** Send to this address instead of the customer's email. */
  to?: string | null;
  followUpDate?: string | null;
  addTodo?: boolean;
}

export interface CollectionEmailResult {
  sent: Array<{ id: string; label: string; to: string }>;
  failed: Array<{ id: string; label: string; error: string }>;
  note: typeof collectionNotes.$inferSelect | null;
  todoId: string | null;
}

/**
 * Email the overdue invoices (one PDF each) or a statement through the app's email flow and
 * record the contact. Nothing sent → the first error is thrown (e.g. "Email is not set up yet")
 * and no contact is recorded.
 */
export async function emailCollectionReminder(
  ctx: ServiceContext,
  input: CollectionEmailInput,
): Promise<CollectionEmailResult> {
  const cust = await customerOf(ctx, input.customerId);
  if (input.what !== 'invoices' && input.what !== 'statement') throw validation('Pick what to email: the overdue invoices or a statement.');
  const to = input.to?.trim() || null;
  if (!to && !cust.email) {
    throw validation(`There is no email address for ${cust.name}. Type one in, or add it to the customer record.`);
  }
  const follow = followUpDay(input.followUpDate);

  const sent: CollectionEmailResult['sent'] = [];
  const failed: CollectionEmailResult['failed'] = [];
  let firstError: unknown = null;
  if (input.what === 'statement') {
    const r = await emailCustomerStatement(ctx, cust.id, { email: to });
    sent.push({ id: cust.id, label: 'Statement', to: r.to });
  } else {
    let list: Array<{ id: string; num: number; ref: string | null }> = await overdueInvoices(ctx, cust.id);
    if (input.invoiceIds?.length) {
      const want = new Set(input.invoiceIds.map((v) => v.toLowerCase()));
      const open = await ctx.db
        .select({ id: invoices.id, num: invoices.invoiceNumber, ref: invoices.refNumber })
        .from(invoices)
        .where(
          and(
            eq(invoices.companyId, ctx.companyId),
            eq(invoices.customerId, cust.id),
            inArray(invoices.status, ['open', 'partial', 'overdue']),
          ),
        );
      list = open.filter((i) => want.has(i.id));
      if (list.length !== want.size) throw notFound('Invoice');
    }
    if (list.length === 0) throw validation(`${cust.name} has no overdue invoices to email.`);
    for (const inv of list) {
      const label = `Invoice #${docRef(inv.ref, inv.num)}`;
      try {
        const r = await emailSalesForm(ctx, 'invoice', inv.id, to);
        sent.push({ id: inv.id, label, to: r.to });
      } catch (err) {
        if (err instanceof ServiceError && err.code === 'FORBIDDEN') throw err;
        if (!(err instanceof ServiceError)) throw err;
        firstError ??= err;
        failed.push({ id: inv.id, label, error: err.message });
      }
    }
    if (sent.length === 0) throw firstError;
  }

  const recipient = sent[0].to;
  const what = input.what === 'statement' ? 'a statement' : sent.map((s) => s.label).join(', ');
  const rec = await recordCollectionContact(ctx, {
    customerId: cust.id,
    method: input.what === 'statement' ? 'statement' : 'email',
    note: `Emailed ${what} to ${recipient}.`,
    followUpDate: follow,
    addTodo: !!(input.addTodo && follow),
  });
  return { sent, failed, note: rec.note, todoId: rec.todoId };
}

/**
 * A collection letter for the customer (PDF, from a Letters template — a built-in collection
 * letter or one of the company's own), recorded as a letter contact.
 */
export async function collectionLetter(
  ctx: ServiceContext,
  input: { customerId: string; templateId: string; signer?: string | null; followUpDate?: string | null; addTodo?: boolean },
): Promise<{ bytes: Uint8Array; note: typeof collectionNotes.$inferSelect; todoId: string | null }> {
  const cust = await customerOf(ctx, input.customerId);
  const template = (await listLetterTemplates(ctx)).find((t) => t.id === input.templateId);
  if (!template) throw notFound('Letter template');
  const follow = followUpDay(input.followUpDate);
  const bytes = await prepareLettersPdf(ctx, {
    recipientType: 'customer',
    recipientIds: [cust.id],
    templateId: template.id,
    signer: input.signer ?? undefined,
  });
  const rec = await recordCollectionContact(ctx, {
    customerId: cust.id,
    method: 'letter',
    note: `Printed the collection letter "${template.name}".`,
    followUpDate: follow,
    addTodo: !!(input.addTodo && follow),
  });
  return { bytes, note: rec.note, todoId: rec.todoId };
}
