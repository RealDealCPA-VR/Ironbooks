/**
 * Zod schema for POST /api/receipts/:id/save — turn a reviewed receipt into an expense, check,
 * card charge or bill.
 *
 * The service owns the schema (lib/services/receipts.ts saveReceiptSchema) and parses the body
 * itself. This is the same schema with a description on every field, for agents
 * (describe_operation, plan §6.3): the route checks the body with it first and refuses it with the
 * very answer the service gives, so what the route accepts is unchanged. The descriptions are
 * applied to the service's own field schemas and its two refinements are kept as they are.
 *
 * Loading this module never fails: a field the service adds or renames is simply left without a
 * description here, so a person's receipt save keeps working. The tests catch the gap instead
 * (test/agentSchemas.described.test.ts compares RECEIPT_FIELD_TEXTS with the service's fields).
 *
 * SERVER ONLY: it imports the receipts service.
 */
import { z } from 'zod';
import { saveReceiptSchema } from '@/lib/services/receipts';

/** What an agent reads for each field of saveReceiptSchema. */
export const RECEIPT_FIELD_TEXTS: Readonly<Record<string, string>> = {
  version: "The receipt's version as you last read it (GET /api/receipts/:id); a receipt changed since is refused so you can read it again.",
  kind: 'What the receipt becomes: expense (paid in cash), check, credit_card (a card charge) or bill (to pay later).',
  vendorId: 'Id of the vendor paid (vendor list); send this, newVendorName, or for anything but a bill payeeName.',
  payeeName: 'Not a bill: name of who was paid, when there is no vendor record (at most 255 characters).',
  newVendorName: 'Name of a new vendor to add to the vendor list and use (at most 255 characters).',
  date: 'Date on the receipt, YYYY-MM-DD.',
  total: 'Total of the receipt, tax included, as decimal text such as "42.18".',
  tax: 'Sales tax on the receipt as decimal text, recorded on its own line; needs taxAccountId. Leave out for none.',
  taxAccountId: 'Id of the account (chart of accounts) the tax line goes to; needed with tax.',
  accountId: 'Id of the account (chart of accounts) the purchase is charged to, such as an expense account.',
  paymentAccountId: 'Not a bill: id of the bank or credit card account the money came out of (chart of accounts). Required for those kinds.',
  memo: 'Memo saved with the transaction (at most 1000 characters); leave out for none.',
  reference: "The check number, card slip number or vendor's bill number (at most 60 characters); leave out for none.",
  dueDate: 'Bills only: date the bill is due, YYYY-MM-DD; leave out for the due date a new bill gets by default.',
  classId: 'Id of a class (class list) for reports by class; leave out for none.',
  customerId: 'Id of a customer (customer list) the purchase is for, for job costing; leave out for none.',
  allowDuplicateNumber: 'Send true only after the app warned that this check or bill number is already used, to save it anyway.',
};

/** The object inside `schema`'s refinements, or null when it is not one (for the tests). */
export function innerObjectOf(schema: z.ZodTypeAny): z.AnyZodObject | null {
  if (schema instanceof z.ZodEffects) return innerObjectOf(schema._def.schema as z.ZodTypeAny);
  if (schema instanceof z.ZodObject) return schema;
  return null;
}

/**
 * `schema` with `.describe(text)` on each field of the object inside its refinements that has a
 * text. A field with no text is left as it is, and a schema of another shape comes back unchanged:
 * the route must keep accepting what the service accepts whatever happens to the descriptions.
 */
function withFieldDescriptions<T extends z.ZodTypeAny>(schema: T, texts: Readonly<Record<string, string>>): T {
  if (schema instanceof z.ZodEffects) {
    const inner = withFieldDescriptions(schema._def.schema as z.ZodTypeAny, texts);
    return new z.ZodEffects({ ...schema._def, schema: inner }) as unknown as T;
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const described: Record<string, z.ZodTypeAny> = {};
    for (const k of Object.keys(shape)) if (Object.hasOwn(texts, k)) described[k] = shape[k].describe(texts[k]);
    return schema.extend(described) as unknown as T;
  }
  return schema;
}

export const saveReceiptBodySchema = withFieldDescriptions(saveReceiptSchema, RECEIPT_FIELD_TEXTS);
