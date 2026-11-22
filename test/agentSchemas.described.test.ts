/**
 * Agent full access: every field an agent may send to an enter / change operation says what it is
 * (plan §6.3, "A test fails when an enter / change operation's top-level fields have no
 * description").
 *
 * An agent learns an operation's body from describe_operation: the JSON Schema of the zod schema
 * the route parses its body with (lib/agent/operations/schemas.ts). A field with no description,
 * or only the generic text of a helper ("Id (a uuid) of an existing record."), leaves the agent
 * guessing which record, and what leaving the field out does. So, for every enter / change
 * operation an agent can reach:
 *
 *  - with a body schema: each top-level field of the described body (every branch of a union,
 *    fields the guards leave out excepted) has its own description. Write it in the voice of
 *    lib/validation/invoices.ts: what the field is, and what leaving it out does, on a new record
 *    and on an edit.
 *  - without one: the operation is on KNOWN_NO_SCHEMA below. That list may only get shorter. A
 *    route that reads its body by hand gets a zod schema in lib/validation that accepts exactly what
 *    the handler reads (lib/validation/bankTransactions.ts shows how), and comes off the list.
 *  - a route that parses its body with a zod schema written inside the route file is not allowed:
 *    the registry cannot load such a schema, so the agent would see no body at all. Move it to
 *    lib/validation (scripts/agent-registry.mjs inlineBodySchemas lists them).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { allOperations } from '@/lib/agent/operations/registry';
import { describeSchemas, loadBodySchema } from '@/lib/agent/operations/schemas';
import type { Operation } from '@/lib/agent/operations/types';
import {
  zDate,
  zDecimal,
  zDecimalPositive,
  zLines,
  zMoney,
  zMoneyPositive,
  zUuid,
} from '@/lib/validation/helpers';
import {
  categorizeBankLineSchema,
  excludeBankLineSchema,
  matchBankLineSchema,
  unmatchBankLineSchema,
} from '@/lib/validation/bankTransactions';
import { inventoryActionSchema, physicalCountSchema, valueAdjustSchema } from '@/lib/validation/inventory';
import { payPayrollLiabilitiesSchema, paySalesTaxSchema } from '@/lib/validation/liabilities';
import { reverseJournalEntrySchema } from '@/lib/validation/journal';
import { estimateActionSchema } from '@/lib/validation/estimates';
import { creditMemoActionSchema } from '@/lib/validation/creditMemos';
import { vendorCreditActionSchema } from '@/lib/validation/vendorCredits';
import { createExpenseReportSchema, expenseReportActionSchema } from '@/lib/validation/expenseReports';
import { reconciliationUpdateSchema } from '@/lib/validation/reconciliations';
import { createRuleSchema } from '@/lib/validation/rules';
import { z } from 'zod';

const root = path.resolve(__dirname, '..');

/**
 * Enter / change operations whose route reads a JSON body by hand, with no zod schema (so
 * describe_operation shows no body). Take an operation off when its route gets a schema; never add
 * one. The count below is the length of this list and may only go down.
 */
const KNOWN_NO_SCHEMA = [
  'ai.posts.undo',
  'assemblies.pending.create',
  'assemblies.replace',
  'assemblies.update',
  'bank-accounts.create',
  'billing-groups.create',
  'billing-groups.update',
  'currencies.fx-adjustment',
  'custom-fields.values',
  'customer-prices.create',
  'demo-feed',
  'errors.apply',
  'fifo.adjust',
  'inventory-transfers.action',
  'invoices.post-draft',
  'landed-cost.action',
  'lists.action',
  'pay-liabilities.by-item.pay',
  'pay-liabilities.checks.action',
  'print-queue.refunds.add',
  'reconciliations.pay',
  'sales-forms.flags.update',
  'sales-reps.assign',
  'sales-reps.create',
  'sales-reps.update',
  'sales-tax.payments.action',
];
const KNOWN_NO_SCHEMA_MAX = 26;

/** The texts the shared helpers carry: right for a field nobody described, not a description of it. */
const GENERIC_TEXTS = new Set(
  [zUuid, zDate, zMoney, zMoneyPositive, zDecimal, zDecimalPositive, zLines(z.object({}))]
    .map((s) => s.description?.trim())
    .filter((t): t is string => !!t),
);

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A node with the branches of its anyOf / oneOf / allOf and the $defs it points at. */
function partsOf(node: Node, root: Node, seen = new Set<Node>()): Node[] {
  if (seen.has(node)) return [];
  seen.add(node);
  const out = [node];
  for (const k of ['anyOf', 'oneOf', 'allOf']) {
    const list = node[k];
    if (Array.isArray(list)) for (const o of list) if (isNode(o)) out.push(...partsOf(o, root, seen));
  }
  const ref = node.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/$defs/') && isNode(root.$defs)) {
    const target = (root.$defs as Node)[ref.slice('#/$defs/'.length)];
    if (isNode(target)) out.push(...partsOf(target, root, seen));
  }
  return out;
}

/** The description an agent reads for a field: its own, or the first one inside its branches. */
function descriptionOf(field: unknown, root: Node): string {
  if (!isNode(field)) return '';
  for (const p of partsOf(field, root)) {
    if (typeof p.description === 'string' && p.description.trim()) return p.description.trim();
  }
  return '';
}

/** The top-level fields of a described body: every property of the root and of each branch. */
function topLevelFields(body: Node): Array<{ name: string; description: string }> {
  const out: Array<{ name: string; description: string }> = [];
  for (const part of partsOf(body, body)) {
    if (!isNode(part.properties)) continue;
    for (const [name, field] of Object.entries(part.properties)) out.push({ name, description: descriptionOf(field, body) });
  }
  return out;
}

/** Enter / change operations an agent can ask for. */
const enterOrChange = (): Operation[] =>
  allOperations().filter((o) => (o.class === 'enter' || o.class === 'change') && o.availability === 'agent');

/** A route operation that is sent a body: anything but a DELETE or GET with body 'none'. */
const takesBody = (o: Operation) => o.body !== 'none' || (o.method !== 'DELETE' && o.method !== 'GET');

/** Route operations of that kind with no body schema. */
const withoutSchema = () => enterOrChange().filter((o) => o.kind === 'route' && !o.bodySchema && takesBody(o));

describe('agent operation bodies: every top-level field is described (plan §6.3)', () => {
  it('describes every top-level field of every enter / change body schema', async () => {
    const problems: string[] = [];
    let checked = 0;
    for (const op of enterOrChange()) {
      if (op.kind === 'route' && !op.bodySchema) continue;
      let loaded: unknown;
      try {
        loaded = await loadBodySchema(op);
      } catch (err) {
        problems.push(`${op.id}: its body schema does not load (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      if (!loaded) continue;
      const { body } = await describeSchemas(op);
      if (!isNode(body)) {
        problems.push(`${op.id}: no body schema could be described`);
        continue;
      }
      checked += 1;
      const missing = new Set<string>();
      const generic = new Set<string>();
      for (const f of topLevelFields(body)) {
        if (!f.description) missing.add(f.name);
        else if (GENERIC_TEXTS.has(f.description)) generic.add(f.name);
      }
      const where = op.bodySchema ? ` (${op.bodySchema})` : '';
      if (missing.size) problems.push(`${op.id}${where}: no description on ${[...missing].join(', ')}`);
      if (generic.size) problems.push(`${op.id}${where}: only a helper's generic text on ${[...generic].join(', ')}`);
    }
    expect(problems, 'add .describe() text to these fields (lib/validation, in the voice of invoices.ts)').toEqual([]);
    // The registry really has bodies to check (a loader or registry change that hid them would
    // make this test pass on nothing).
    expect(checked).toBeGreaterThan(120);
  }, 120_000);

  it('lists every enter / change route that has no body schema, and the list only gets shorter', () => {
    const now = withoutSchema()
      .map((o) => o.id)
      .sort();
    const known = new Set(KNOWN_NO_SCHEMA);
    expect(
      now.filter((id) => !known.has(id)),
      'these enter / change routes read a body with no zod schema: give each one a schema in lib/validation',
    ).toEqual([]);
    expect(
      KNOWN_NO_SCHEMA.filter((id) => !now.includes(id)),
      'these now have a body schema (or are gone): take them off KNOWN_NO_SCHEMA and lower KNOWN_NO_SCHEMA_MAX',
    ).toEqual([]);
    expect(new Set(KNOWN_NO_SCHEMA).size, 'KNOWN_NO_SCHEMA lists an operation twice').toBe(KNOWN_NO_SCHEMA.length);
    expect(KNOWN_NO_SCHEMA.length, 'KNOWN_NO_SCHEMA may only get shorter').toBeLessThanOrEqual(KNOWN_NO_SCHEMA_MAX);
  });

  it('has no route that parses its body with a zod schema written inside the route file', () => {
    // The generator reads every route file with the TypeScript parser; run it in its own process.
    const url = pathToFileURL(path.join(root, 'scripts', 'agent-registry.mjs')).href;
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `import { inlineBodySchemas } from ${JSON.stringify(url)}; console.log(JSON.stringify(inlineBodySchemas()));`],
      { cwd: root, encoding: 'utf8', timeout: 110_000 },
    );
    const inline = JSON.parse(out.trim().split('\n').pop() ?? '[]') as string[];
    expect(inline, 'move each schema to lib/validation and import it in the route').toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The schemas of routes that read their body by hand accept what the handler accepts
// ---------------------------------------------------------------------------

/**
 * These routes check their body with a schema written for agents, after their own checks
 * (lib/validation/bankTransactions.ts and the files it names). The schema must not refuse a body
 * the route used to take: a field the handler ignores, converts or leaves to its service passes
 * with any value. Each body below gets past the route's own checks today, odd values included.
 */
const UUID = '7d3c1f9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const HANDLER_ACCEPTS: Array<[string, z.ZodTypeAny, unknown]> = [
  ['categorize: the usual body', categorizeBankLineSchema, { bankTransactionId: UUID, accountId: UUID, payee: 'Shell', memo: null, exchangeRate: '1.10' }],
  ['categorize: splits instead of an account, odd extras', categorizeBankLineSchema, { bankTransactionId: UUID, splits: [{ accountId: UUID, percent: '100' }], classId: '', payee: 12, exchangeRate: 1.1 }],
  ['match', matchBankLineSchema, { bankTransactionId: UUID, journalEntryId: UUID }],
  ['unmatch', unmatchBankLineSchema, { bankTransactionId: UUID }],
  ['exclude: restore as any truthy value', excludeBankLineSchema, { bankTransactionId: UUID, restore: 'yes' }],
  ['inventory adjust: site fields of any type', inventoryActionSchema, { action: 'adjust', itemId: UUID, quantityChange: '5', unitCost: 2, date: '2026-03-01', siteId: 3, serialNumbers: 'x', lotNumber: 7 }],
  ['inventory cogs', inventoryActionSchema, { action: 'cogs', itemId: UUID, quantity: -2, date: '2026-03-01', memo: null }],
  ['physical count of zero, blank account', physicalCountSchema, { itemId: UUID, countedQty: 0, date: '2026-03-01', adjustmentAccountId: '' }],
  ['value adjust by unit cost', valueAdjustSchema, { itemId: UUID, date: '2026-03-01', newUnitCost: 4.25, reason: null, classId: 5 }],
  ['pay sales tax: agency rows left to the service', paySalesTaxSchema, { date: '2026-03-01', paymentAccountId: UUID, payments: [{ agencyId: '', amount: '' }, null], toPrint: 'yes', memo: 3 }],
  ['pay payroll liabilities: check fields of any type', payPayrollLiabilitiesSchema, { amount: ' 120.00 ', date: '2026-03-01', paymentAccountId: UUID, vendorId: 7, toPrint: 1, checkNumber: 1001 }],
  ['reverse with no body', reverseJournalEntrySchema, {}],
  ['reverse with a date of any type', reverseJournalEntrySchema, { asOfDate: 5 }],
  ['estimate convert', estimateActionSchema, { action: 'convert', overrideCreditLimit: 'yes' }],
  ['estimate progress by lines of any shape', estimateActionSchema, { action: 'progress', lines: [{ lineId: 3, amount: 'x' }], date: '2026-03-01' }],
  ['estimate void', estimateActionSchema, { action: 'void' }],
  ['credit memo apply', creditMemoActionSchema, { action: 'apply', invoiceId: UUID, amount: 5 }],
  ['credit memo refund', creditMemoActionSchema, { action: 'refund', bankAccountId: UUID, amount: '5.00', memo: 3 }],
  ['credit memo unapply', creditMemoActionSchema, { action: 'unapply', applicationId: UUID }],
  ['vendor credit refund', vendorCreditActionSchema, { action: 'refund', bankAccountId: UUID, amount: 5, exchangeRate: 'x', date: 20260301 }],
  ['vendor credit unapply', vendorCreditActionSchema, { action: 'unapply', billId: UUID, amount: '1.00' }],
  ['expense report: fields left to the service', createExpenseReportSchema, { employeeId: 5, title: null, lines: 'x' }],
  ['expense report reimburse', expenseReportActionSchema, { action: 'reimburse', bankAccountId: 7 }],
  ['reconcile complete', reconciliationUpdateSchema, { action: 'complete', adjust: 'yes' }],
  ['reconcile mark many, ids of any type', reconciliationUpdateSchema, { action: 'setClearedMany', journalEntryLineIds: [1, UUID], isCleared: true }],
  ['reconcile statement', reconciliationUpdateSchema, { action: 'updateStatement', statementBalance: 5, statementDate: null }],
  ['reconcile adjustments of any shape', reconciliationUpdateSchema, { action: 'adjustments', serviceCharge: 'x', interestEarned: { amount: 1 } }],
  ['rule: payee and priority of any type', createRuleSchema, { name: 'n', matchField: 'payee', matchOperator: 'equals', matchValue: 'v', setAccountId: UUID, setPayee: 5, priority: 'high' }],
];

describe('schemas of routes that read their body by hand', () => {
  it.each(HANDLER_ACCEPTS)('accepts what the handler accepts: %s', (_name, schema, body) => {
    const parsed = schema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The receipt save texts follow the service's schema
// ---------------------------------------------------------------------------

/**
 * lib/validation/receipts.ts describes the fields of the receipts service's own schema. It never
 * throws when the two drift apart (a person's receipt save must keep working), so the check that
 * every field has a text, and that no text names a field the service dropped, lives here.
 */
describe('receipt save: the descriptions follow lib/services/receipts.ts saveReceiptSchema', () => {
  it('has a text for every field of the service schema and none for a field it does not have', async () => {
    const { saveReceiptSchema } = await import('@/lib/services/receipts');
    const { RECEIPT_FIELD_TEXTS, innerObjectOf, saveReceiptBodySchema } = await import('@/lib/validation/receipts');
    const service = innerObjectOf(saveReceiptSchema);
    const described = innerObjectOf(saveReceiptBodySchema);
    expect(service, 'saveReceiptSchema is no longer an object with refinements: update lib/validation/receipts.ts').not.toBeNull();
    expect(described).not.toBeNull();
    const fields = Object.keys(service!.shape).sort();
    const texts = Object.keys(RECEIPT_FIELD_TEXTS).sort();
    expect(fields.filter((k) => !texts.includes(k)), 'describe these fields in lib/validation/receipts.ts').toEqual([]);
    expect(texts.filter((k) => !fields.includes(k)), 'the service no longer has these fields: drop their texts').toEqual([]);
    // The route checks the very fields the service parses, refinements included.
    expect(Object.keys(described!.shape).sort()).toEqual(fields);
    for (const k of fields) expect((described!.shape as Record<string, z.ZodTypeAny>)[k].description).toBe(RECEIPT_FIELD_TEXTS[k]);
    expect(saveReceiptBodySchema).toBeInstanceOf(z.ZodEffects);
  }, 60_000);
});
