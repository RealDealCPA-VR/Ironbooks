/**
 * The entry tools (mcp/entry-tools.mjs): each is a thin wrapper over one operation of the generic
 * door. These tests hold them to the app on three sides:
 *
 *  - the registry: every operation a tool names (in `operations`, or quoted in its description)
 *    exists and is open to agents, and the tool's confirm flags are the operation's own;
 *  - the body: what each tool sends parses with the operation's own zod schema and has no field
 *    the schema does not know (or, for a route that reads its body by hand, that the route reads);
 *    every argument a tool declares reaches the body;
 *  - the answer: asked, needs_confirmation and refused are worded as the other named tools word them.
 *
 * The app is a recording stand-in, as in tools.test.ts and operations.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { argumentProblem, createServer } from '../../mcp/protocol.mjs';
import { TOOLS } from '../../mcp/tools.mjs';
import { ENTRY_TOOLS, fit } from '../../mcp/entry-tools.mjs';
import { operationById } from '@/lib/agent/operations/registry';
import { SCHEMA_LOADERS } from '@/lib/agent/operations/schemas.generated';

type Any = Record<string, any>;
const ID = '11111111-2222-4333-8444-555555555555';
const ID2 = '99999999-2222-4333-8444-555555555555';
const ROOT = path.resolve(__dirname, '../..');

/** ajv is not a dependency of its own (electron-builder brings it): skip its checks without it. */
const Ajv2020: any = await import('ajv/dist/2020').then((m) => m.default ?? m).catch(() => null);

/** Records every POST to the door and answers with `answer`. */
function fake(answer: (r: Any) => unknown = (r) => ({ operation: r.operation, outcome: r.dryRun ? 'dry_run' : 'posted' })) {
  const acted: Any[] = [];
  return {
    acted,
    client: {
      async act(r: Any) {
        acted.push(r);
        const a = answer(r);
        if (a instanceof Error) throw a;
        return a;
      },
      async get() {
        throw new Error('an entry tool must not read a route of its own');
      },
    },
  };
}

async function call(client: unknown, name: string, args: Any = {}) {
  const server = createServer({ tools: TOOLS, client, serverInfo: { name: 't', version: '0' } });
  const res = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as Any;
  expect(res.error, JSON.stringify(res.error)).toBeUndefined();
  const text: string = res.result.content[0].text;
  let data: Any = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* a message */
  }
  return { isError: res.result.isError as boolean, text, data };
}

const byName = new Map((ENTRY_TOOLS as Any[]).map((t) => [t.name, t]));
const tool = (name: string) => byName.get(name)!;

// ---------------------------------------------------------------------------
// Sample arguments, made from each tool's own schema
// ---------------------------------------------------------------------------

/** One value of each form the tools' patterns take; the first that fits a pattern is used. */
const SAMPLES = [ID, '2026-03-01', '10.00', '2', 'EUR', '50'];

function sampleFor(s: Any): unknown {
  if (Array.isArray(s.enum)) return s.enum[0];
  if (s.type === 'boolean') return true;
  if (s.type === 'integer') return s.minimum ?? 1;
  if (s.type === 'string') return s.pattern ? SAMPLES.find((v) => new RegExp(s.pattern).test(v)) ?? 'x' : 'x';
  if (s.type === 'array') return [sampleFor(s.items)];
  if (s.type === 'object') return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, sampleFor(v as Any)]));
  return 'x';
}

const META = ['dry_run', 'request_id', 'reason', 'confirm'];

/** Every argument a tool declares, filled; then the variants that cover the ones that exclude each other. */
function variants(name: string): Any[] {
  const full = sampleFor(tool(name).inputSchema) as Any;
  for (const k of META) delete full[k];
  const without = (o: Any, ...keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
  switch (name) {
    case 'enter_estimate':
    case 'enter_credit_memo':
      return [without(full, 'no_sales_tax'), { ...without(full, 'tax_rate_id'), no_sales_tax: true }];
    case 'convert_estimate':
      return [
        { estimate_id: ID },
        { estimate_id: ID, to: 'invoice' },
        { estimate_id: ID, to: 'progress_invoice', percent: '50', date: '2026-03-01' },
        { estimate_id: ID, to: 'progress_invoice', remaining: true },
        { estimate_id: ID, to: 'progress_invoice', lines: full.lines },
      ];
    case 'adjust_inventory': {
      const quantity = without(full, 'new_total_value', 'new_unit_cost');
      const value = without(full, 'quantity_change', 'unit_cost', 'site_id', 'bin_id', 'serial_numbers', 'lot_number', 'lot_expiration', 'new_unit_cost');
      return [quantity, { ...value, kind: 'value' }, { ...without(value, 'new_total_value'), kind: 'value', new_unit_cost: '2' }];
    }
    default:
      return [full];
  }
}

/** Dotted paths of every field in a body, list items as one ("lines.itemId"). */
function paths(v: unknown, prefix = ''): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => paths(x, prefix));
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => [`${prefix}${k}`, ...paths(x, `${prefix}${k}.`)]);
  return [];
}

/** The same for what a schema declares, in the app's names. */
function declared(s: Any, prefix = ''): string[] {
  const props = s.type === 'array' ? s.items?.properties : s.properties;
  if (!props) return [];
  return Object.entries(props).flatMap(([k, v]) => {
    const name = `${prefix}${k.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase())}`;
    return [name, ...declared(v as Any, `${name}.`)];
  });
}

const at = (prefix: string, key: string) => (prefix ? `${prefix}.${key}` : key);

/**
 * What a zod schema would quietly lose of `value`, as dotted paths: a field it does not declare (a
 * strip schema drops it), and a value a lenient field turns into nothing. A route that reads its
 * body by hand checks it with lenient fields (lib/validation/helpers.ts zLenient, which is
 * optional().catch(undefined)), so safeParse passes even when such a value is of the wrong form:
 * the value under a catch must parse with the schema inside it. Unions are followed into the
 * option the value is (a discriminated union by its discriminator, as the route reads it).
 */
function lost(schema: any, value: unknown, prefix = ''): string[] {
  let s = schema;
  for (;;) {
    const t = s?._def?.typeName;
    if (t === 'ZodCatch') {
      s = s._def.innerType;
      if (!s.safeParse(value).success) return [`${prefix || '(the body)'} (a value of the wrong form, dropped)`];
    } else if (t === 'ZodOptional' || t === 'ZodNullable' || t === 'ZodDefault' || t === 'ZodReadonly') s = s._def.innerType;
    else if (t === 'ZodEffects') s = s._def.schema;
    else if (t === 'ZodBranded') s = s._def.type;
    else if (t === 'ZodPipeline') s = s._def.in;
    else if (t === 'ZodLazy') s = s._def.getter();
    else break;
  }
  if (value === undefined || value === null) return [];
  const t = s?._def?.typeName;
  if (t === 'ZodObject' && typeof value === 'object' && !Array.isArray(value)) {
    const shape = s.shape;
    return Object.entries(value).flatMap(([k, v]) => (k in shape ? lost(shape[k], v, at(prefix, k)) : [at(prefix, k)]));
  }
  if (t === 'ZodArray' && Array.isArray(value)) return value.flatMap((v) => lost(s._def.type, v, prefix));
  if (t === 'ZodRecord' && typeof value === 'object') return Object.entries(value as Any).flatMap(([k, v]) => lost(s._def.valueType, v, at(prefix, k)));
  if (t === 'ZodDiscriminatedUnion') {
    const key: string = s._def.discriminator;
    const option = s._def.optionsMap.get((value as Any)?.[key]);
    return option ? lost(option, value, prefix) : [`${at(prefix, key)} (no such choice)`];
  }
  if (t === 'ZodUnion') {
    const each = (s._def.options as any[]).filter((o) => o.safeParse(value).success).map((o) => lost(o, value, prefix));
    return each.find((l) => l.length === 0) ?? each[0] ?? [`${prefix || '(the body)'} (fits none of its forms)`];
  }
  return [];
}

/** The app's own body schema of an operation (registry bodySchema), through the registry's own loaders. */
async function bodySchemaOf(name: string): Promise<any> {
  const load = SCHEMA_LOADERS[name];
  expect(load, `the registry names the body schema ${name}, but schemas.generated.ts has no loader for it`).toBeDefined();
  const zod = await load();
  expect(typeof (zod as any)?.safeParse, `${name} is not a zod schema`).toBe('function');
  return zod;
}

/** Arguments a tool turns into something other than a body field of the same name. */
const NOT_A_FIELD: Record<string, Record<string, string>> = {
  enter_estimate: { noSalesTax: 'taxRateId' },
  enter_credit_memo: { noSalesTax: 'taxRateId' },
  convert_estimate: { estimateId: 'params.id', to: 'action' },
  adjust_inventory: { kind: 'the operation', memo: 'memo or reason' },
};

async function sent(name: string, args: Any) {
  const { client, acted } = fake();
  const problem = argumentProblem(tool(name).inputSchema, args);
  expect(problem, `${name} ${JSON.stringify(args)}`).toBeNull();
  const r = await call(client, name, { ...args, dry_run: true });
  expect(r.isError, `${name}: ${r.text}`).toBe(false);
  expect(acted).toHaveLength(1);
  return acted[0];
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe('the entry tools and the registry agree', () => {
  it('the nine tools the plan names, all of them in TOOLS, each changing the books', () => {
    expect(ENTRY_TOOLS.map((t: Any) => t.name).sort()).toEqual(
      ['adjust_inventory', 'convert_estimate', 'enter_credit_memo', 'enter_estimate', 'enter_purchase_order', 'enter_time', 'enter_vendor_credit', 'pay_sales_tax', 'receive_items'].sort(),
    );
    const names = new Set((TOOLS as Any[]).map((t) => t.name));
    for (const t of ENTRY_TOOLS as Any[]) {
      expect(names.has(t.name), t.name).toBe(true);
      expect(t.changes, t.name).toBe(true);
      expect(t.inputSchema.properties, t.name).toHaveProperty('dry_run');
      expect(t.inputSchema.properties, t.name).toHaveProperty('request_id');
      expect(t.inputSchema.properties, t.name).toHaveProperty('reason');
    }
  });

  it('every operation a tool runs exists, is open to agents, and takes exactly the tool\'s confirm flags', () => {
    for (const t of ENTRY_TOOLS as Any[]) {
      expect(t.operations.length, t.name).toBeGreaterThan(0);
      const flags = new Set<string>();
      for (const id of t.operations) {
        const op = operationById(id);
        expect(op, `${t.name}: operation "${id}" is not in the registry (renamed?)`).not.toBeNull();
        expect(op!.availability, id).toBe('agent');
        expect(op!.classified, id).toBe(true);
        expect(op!.kind, id).toBe('route');
        expect(['enter', 'change'], id).toContain(op!.class);
        for (const f of op!.confirmFlags) flags.add(f);
      }
      const offered = t.inputSchema.properties.confirm?.items?.enum ?? [];
      expect([...offered].sort(), t.name).toEqual([...flags].sort());
    }
  });

  it('every operation id a description names exists and is open to agents', () => {
    const named = new Set<string>();
    for (const t of ENTRY_TOOLS as Any[]) {
      for (const m of t.description.matchAll(/"([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)"/g)) named.add(m[1]);
    }
    expect(named.size).toBeGreaterThan(5);
    for (const id of named) {
      const op = operationById(id);
      expect(op, `"${id}" is named in a tool description but is not an operation`).not.toBeNull();
      expect(op!.availability, id).toBe('agent');
    }
  });

  it.skipIf(!Ajv2020)('every schema compiles as JSON Schema 2020-12, strictly', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    ajv.addKeyword({ keyword: 'patternHint', schemaType: 'string' });
    ajv.addKeyword({ keyword: 'anyOfHint', schemaType: 'string' });
    for (const t of ENTRY_TOOLS as Any[]) {
      const validate = ajv.compile(t.inputSchema);
      for (const args of variants(t.name)) expect(validate({ ...args, request_id: 'r-1' }), `${t.name}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

describe('what each tool sends is what the operation reads', () => {
  it('the verb, the operation, and a body the app\'s own schema accepts, with no field it does not know', async () => {
    const checked = new Set<string>();
    for (const t of ENTRY_TOOLS as Any[]) {
      for (const args of variants(t.name)) {
        const req = await sent(t.name, args);
        expect(req.verb, t.name).toBe('run_operation');
        expect(t.operations, t.name).toContain(req.operation);
        expect(req, t.name).not.toHaveProperty('requestId');
        expect(req.dryRun).toBe(true);
        const op = operationById(req.operation)!;
        if (op.bodySchema) {
          const zod = await bodySchemaOf(op.bodySchema);
          const parsed = zod.safeParse(req.body);
          expect(parsed.success, `${t.name} ${JSON.stringify(req.body)}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
          expect(lost(zod, req.body), `${t.name} ${JSON.stringify(req.body)}`).toEqual([]);
          checked.add(op.id);
        } else {
          // The route reads its body by hand: every field sent is one its source reads.
          const source = fs.readFileSync(path.join(ROOT, `app${op.route}/route.ts`), 'utf8');
          for (const p of paths(req.body)) {
            const field = p.split('.').at(-1)!;
            expect(source, `${t.name}: ${op.route} does not read "${field}"`).toMatch(new RegExp(`\\b${field}\\b`));
          }
          checked.add(op.id);
        }
      }
    }
    // Every operation of every tool was reached by some variant and checked one way or the other.
    expect([...checked].sort()).toEqual((ENTRY_TOOLS as Any[]).flatMap((t) => t.operations).sort());
  });

  it('the body check itself sees a field the schema does not know and a value a lenient field drops, in unions too', async () => {
    const estimateAction = await bodySchemaOf('@/lib/validation/estimates#estimateActionSchema');
    const inventoryAction = await bodySchemaOf('@/lib/validation/inventory#inventoryActionSchema');
    const paySalesTax = await bodySchemaOf('@/lib/validation/liabilities#paySalesTaxSchema');
    // Each of these parses (the lenient fields let them through), which is why lost() is needed.
    const unknownInVariant = { action: 'adjust', itemId: ID, date: '2026-03-01', quantityChange: '1', quantity: '1' };
    expect(inventoryAction.safeParse(unknownInVariant).success).toBe(true);
    expect(lost(inventoryAction, unknownInVariant)).toEqual(['quantity']);
    const dropped = { action: 'progress', lines: [{ lineId: ID, amount: { value: '5' } }] };
    expect(estimateAction.safeParse(dropped).success).toBe(true);
    expect(lost(estimateAction, dropped)).toEqual(['lines.amount (a value of the wrong form, dropped)']);
    expect(lost(estimateAction, { action: 'convert', allowOverBilling: true })).toEqual(['allowOverBilling']);
    expect(lost(estimateAction, { action: 'progress', allowOverBilling: true, remaining: true })).toEqual([]);
    const agency = { date: '2026-03-31', paymentAccountId: ID, payments: [{ agencyId: ID2, amount: '1.00', agency_id: ID2 }] };
    expect(paySalesTax.safeParse(agency).success).toBe(true);
    expect(lost(paySalesTax, agency)).toEqual(['payments.agency_id']);
  });

  it('every argument a tool declares reaches the operation', async () => {
    for (const t of ENTRY_TOOLS as Any[]) {
      const reached = new Set<string>();
      for (const args of variants(t.name)) {
        const req = await sent(t.name, args);
        for (const p of paths(req.body)) reached.add(p);
        if (req.params?.id) reached.add('params.id');
      }
      const special = NOT_A_FIELD[t.name] ?? {};
      for (const d of declared(t.inputSchema).filter((d) => !['dryRun', 'requestId', 'reason', 'confirm'].includes(d))) {
        if (special[d]) continue;
        expect(reached.has(d), `${t.name}: ${d} is declared but never sent`).toBe(true);
      }
    }
  });

  it('the special cases: the estimate\'s id and action, no sales tax, the two kinds of inventory adjustment', async () => {
    expect(await sent('convert_estimate', { estimate_id: ID })).toMatchObject({ operation: 'estimates.action', params: { id: ID }, body: { action: 'convert' } });
    expect(await sent('convert_estimate', { estimate_id: ID, to: 'progress_invoice', lines: [{ line_id: ID2, amount: '5.00' }] })).toMatchObject({
      params: { id: ID },
      body: { action: 'progress', lines: [{ lineId: ID2, amount: '5.00' }] },
    });
    const est = await sent('enter_estimate', { customer_id: ID, date: '2026-03-01', no_sales_tax: true, lines: [{ quantity: '1', rate: '5' }] });
    expect(est.body).toEqual({ customerId: ID, date: '2026-03-01', taxRateId: null, lines: [{ quantity: '1', rate: '5' }] });
    expect(await sent('adjust_inventory', { item_id: ID, date: '2026-03-01', quantity_change: '-2', memo: 'Broken' })).toMatchObject({
      operation: 'inventory.adjust',
      body: { action: 'adjust', itemId: ID, date: '2026-03-01', quantityChange: '-2', memo: 'Broken' },
    });
    expect(await sent('adjust_inventory', { kind: 'value', item_id: ID, date: '2026-03-01', new_unit_cost: '4.25', memo: 'Recost' })).toEqual({
      verb: 'run_operation',
      operation: 'inventory.value-adjust',
      body: { itemId: ID, date: '2026-03-01', newUnitCost: '4.25', reason: 'Recost' },
      dryRun: true,
    });
    const pay = await sent('pay_sales_tax', { date: '2026-03-31', payment_account_id: ID, payments: [{ agency_id: ID2, amount: '120.00' }], to_print: true });
    expect(pay).toEqual({
      verb: 'run_operation',
      operation: 'sales-tax.payments.create',
      body: { date: '2026-03-31', paymentAccountId: ID, payments: [{ agencyId: ID2, amount: '120.00' }], toPrint: true },
      dryRun: true,
    });
  });

  it('a real request carries request_id, reason and confirm; a dry run never files one', async () => {
    const { client, acted } = fake(() => ({ operation: 'estimates.create', outcome: 'done', result: { id: ID2 } }));
    const args = { customer_id: ID, date: '2026-03-01', lines: [{ item_id: ID2, quantity: '2' }] };
    await call(client, 'enter_estimate', { ...args, request_id: 'est-1', reason: 'The customer asked for a quote.', confirm: ['allowDuplicateNumber', 'allowDuplicateNumber'] });
    expect(acted[0]).toEqual({
      verb: 'run_operation',
      operation: 'estimates.create',
      body: { customerId: ID, date: '2026-03-01', lines: [{ itemId: ID2, quantity: '2' }] },
      confirm: ['allowDuplicateNumber'],
      requestId: 'est-1',
      reason: 'The customer asked for a quote.',
    });
    await call(client, 'enter_estimate', { ...args, dry_run: true, request_id: 'est-1', reason: 'r' });
    expect(acted[1]).toEqual({ verb: 'run_operation', operation: 'estimates.create', body: { customerId: ID, date: '2026-03-01', lines: [{ itemId: ID2, quantity: '2' }] }, dryRun: true });
  });

  it('checks what it can before anything is sent', async () => {
    const { client, acted } = fake();
    const cases: Array<[string, Any, RegExp]> = [
      ['enter_time', { date: '2026-03-01', hours: '1.5' }, /Give a request_id/],
      ['enter_time', { date: '2026-03-01', hours: '-1', request_id: 'r-1' }, /"hours" must be a number like 2 or 1\.5 \(as text, not negative\)/],
      ['enter_estimate', { customer_id: ID, date: '2026-03-01', tax_rate_id: ID2, no_sales_tax: true, lines: [{ quantity: '1' }], request_id: 'r-1' }, /tax_rate_id or no_sales_tax, not both/],
      ['enter_estimate', { customer_id: ID, date: '2026-03-01', lines: [], request_id: 'r-1' }, /"lines" needs at least 1 entry/],
      ['enter_estimate', { customer_id: ID, date: '2026-03-01', lines: [{ quantity: '1' }], confirm: ['allowLedgerRewrite'], request_id: 'r-1' }, /must be one of: allowDuplicateNumber/],
      ['enter_time', { date: '2026-03-01', hours: '1', confirm: ['allowZero'], request_id: 'r-1' }, /Unknown argument "confirm"/],
      ['convert_estimate', { estimate_id: ID, percent: '50', request_id: 'r-1' }, /only for to: "progress_invoice"/],
      ['convert_estimate', { estimate_id: ID, to: 'progress_invoice', request_id: 'r-1' }, /exactly one of percent, remaining or lines/],
      ['convert_estimate', { estimate_id: ID, to: 'progress_invoice', percent: '10', remaining: true, request_id: 'r-1' }, /exactly one of percent, remaining or lines/],
      ['adjust_inventory', { item_id: ID, date: '2026-03-01', request_id: 'r-1' }, /give quantity_change/],
      ['adjust_inventory', { item_id: ID, date: '2026-03-01', quantity_change: '1', new_unit_cost: '2', request_id: 'r-1' }, /new_unit_cost is only for kind "value"/],
      ['adjust_inventory', { kind: 'value', item_id: ID, date: '2026-03-01', request_id: 'r-1' }, /exactly one of new_total_value or new_unit_cost/],
      ['adjust_inventory', { kind: 'value', item_id: ID, date: '2026-03-01', new_total_value: '9.00', site_id: ID, request_id: 'r-1' }, /site_id is only for kind "quantity"/],
      ['pay_sales_tax', { date: '2026-03-31', payment_account_id: ID, payments: [{ agency_id: ID2, amount: '1.005' }], request_id: 'r-1' }, /must be an amount like 1250\.00/],
      ['receive_items', { vendor_id: ID, date: '2026-03-01', lines: [{ item_id: ID2, quantity: '1' }], request_id: 'r-1' }, /"lines"\[1\]\.unit_cost is required/],
    ];
    for (const [name, args, message] of cases) {
      const r = await call(client, name, args);
      expect(r.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      expect(r.text, name).toMatch(message);
    }
    expect(acted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

describe('the answer is the door\'s, worded as the other named tools word it', () => {
  const ledger = { entries: [{ journalEntryId: ID, date: '2026-03-01', description: 'Credit memo', lines: [{ accountCode: '1200', accountName: 'Accounts Receivable', debit: null, credit: '50.00' }] }], changes: [] };
  const memo = { customer_id: ID, date: '2026-03-01', lines: [{ item_id: ID2, quantity: '1', rate: '50' }] };

  it('posted and done', async () => {
    const posted = await call(fake(() => ({ operation: 'credit-memos.create', outcome: 'posted', result: { id: ID2 }, ledger })).client, 'enter_credit_memo', { ...memo, request_id: 'cm-1' });
    expect(posted.data).toMatchObject({ outcome: 'posted', said: 'Entered.', result: { id: ID2 }, ledger: [{ journal_entry_id: ID }] });
    const done = await call(fake(() => ({ operation: 'time-entries.create', outcome: 'done', result: { id: ID2 } })).client, 'enter_time', { date: '2026-03-01', hours: '2', request_id: 't-1' });
    expect(done.data).toMatchObject({ outcome: 'done', said: 'Done. Nothing was posted to the ledger.' });
  });

  it('asked: nothing done yet, who decides, and wait_for_decision with the request id', async () => {
    const needs = { admin: false, fileAdmin: false, hostOnly: false, flag: null, secrets: [], twoPerson: false, grantable: 'yes' };
    const preview = { ledger, records: [], effects: [], warnings: [], loss: null, routePreview: null, truncated: false };
    const { client } = fake(() => ({ operation: 'credit-memos.create', outcome: 'asked', requestId: ID2, status: 'pending', needs, preview, summary: 'Enter a credit memo for customer x' }));
    const r = await call(client, 'enter_credit_memo', { ...memo, request_id: 'cm-ask', reason: 'Returned goods.' });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ outcome: 'asked', said: 'Not done yet. A person must approve it in Ironbooks first.', request_id: ID2, status: 'pending' });
    expect(r.data.who_decides).toBe('A person who may do this themselves must approve it.');
    expect(r.data.would_post[0].lines).toEqual([{ account: '1200 Accounts Receivable', debit: null, credit: '50.00' }]);
    expect(r.data).not.toHaveProperty('ledger');
    expect(r.data.next).toMatch(new RegExp(`wait_for_decision with request_id "${ID2}"`));
    expect(r.data.next).toMatch(/Do not send this request again/);
  });

  it('needs_confirmation: the warning, and confirm with its flag when the tool takes it; change the request when no flag accepts it', async () => {
    const warnings = [{ flag: 'allowDuplicateNumber', message: 'Estimate 1001 is already used.' }];
    const est = await call(fake(() => ({ operation: 'estimates.create', outcome: 'needs_confirmation', warnings })).client, 'enter_estimate', {
      customer_id: ID,
      date: '2026-03-01',
      ref_number: '1001',
      lines: [{ quantity: '1' }],
      request_id: 'e-dup',
    });
    expect(est.isError).toBe(false);
    expect(est.data.said).toMatch(/Not done. Ironbooks raised a warning/);
    expect(est.data.warnings).toEqual([{ flag: 'allowDuplicateNumber', message: 'Estimate 1001 is already used.', resend_with: 'confirm: ["allowDuplicateNumber"]' }]);
    expect(est.data.next).toMatch(/NEW request_id/);
    expect(est.data.next).toMatch(/what resend_with says/);
    // enter_time takes no confirm, because its operation lists no flag: the door would refuse one
    // sent through run_operation as well, so the answer says to change the request instead.
    const time = await call(fake(() => ({ operation: 'time-entries.create', outcome: 'needs_confirmation', warnings: [{ flag: 'allowZero', message: 'Zero hours.' }] })).client, 'enter_time', {
      date: '2026-03-01',
      hours: '0',
      request_id: 't-0',
    });
    expect(time.isError).toBe(false);
    expect(time.data.warnings).toEqual([
      { flag: 'allowZero', message: 'Zero hours.', instead: 'This warning cannot be accepted with a flag. Change the request so it no longer raises it, or stop and tell the person.' },
    ]);
    expect(time.data.next).toMatch(/^No flag accepts these warnings\. Change the request/);
    expect(time.text).not.toMatch(/run_operation|confirm: \[/);
    // A tool that takes some flags: only those are offered back; another flag is to change the request for.
    const mixed = await call(
      fake(() => ({
        operation: 'estimates.create',
        outcome: 'needs_confirmation',
        warnings: [
          { flag: 'allowDuplicateNumber', message: 'Estimate 1001 is already used.' },
          { flag: 'allowClosedPeriod', message: 'The date is on or before the closing date.' },
        ],
      })).client,
      'enter_estimate',
      { customer_id: ID, date: '2026-03-01', lines: [{ quantity: '1' }], request_id: 'e-mixed' },
    );
    expect(mixed.data.warnings).toEqual([
      { flag: 'allowDuplicateNumber', message: 'Estimate 1001 is already used.', resend_with: 'confirm: ["allowDuplicateNumber"]' },
      { flag: 'allowClosedPeriod', message: 'The date is on or before the closing date.', instead: expect.stringMatching(/cannot be accepted with a flag/) },
    ]);
    // Every resend_with an entry tool gives, sent back as it says, is an argument the tool takes.
    for (const t of ENTRY_TOOLS as Any[]) {
      const flags: string[] = [...(operationById(t.operations[0])?.confirmFlags ?? []), 'allowSomethingElse'];
      const r = await call(fake(() => ({ operation: t.operations[0], outcome: 'needs_confirmation', warnings: flags.map((flag) => ({ flag, message: 'x' })) })).client, t.name, {
        ...variants(t.name)[0],
        request_id: 'w-1',
      });
      for (const w of r.data.warnings as Any[]) {
        if (!w.resend_with) continue;
        const confirm = JSON.parse(String(w.resend_with).replace(/^confirm: /, ''));
        expect(argumentProblem(t.inputSchema, { ...variants(t.name)[0], request_id: 'w-2', confirm }), `${t.name} ${w.resend_with}`).toBeNull();
      }
      expect((r.data.warnings as Any[]).find((w) => w.flag === 'allowSomethingElse'), t.name).not.toHaveProperty('resend_with');
    }
  });

  it('refused: a tool error that says nothing was done and not to send it again', async () => {
    const { client } = fake(() => ({ operation: 'sales-tax.payments.create', outcome: 'refused', note: 'This agent may never pay sales tax' }));
    const r = await call(client, 'pay_sales_tax', { date: '2026-03-31', payment_account_id: ID, payments: [{ agency_id: ID2, amount: '1.00' }], request_id: 'st-1' });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      'Refused: This agent may never pay sales tax. Nothing was done. Do not send it again as it is. get_my_permissions shows what you may do; if the work still needs doing, tell the person what you wanted to do and why.',
    );
  });

  it('a very long answer is held to the door\'s size limit', () => {
    const shaped = { outcome: 'posted', said: 'Entered.', result: { rows: Array.from({ length: 30_000 }, (_, i) => ({ i, text: 'x'.repeat(20) })) } };
    const held = fit(shaped) as Any;
    expect(JSON.stringify(held).length).toBeLessThanOrEqual(200_000);
    expect(held.outcome).toBe('posted');
    expect(held.said).toBe('Entered.');
  });
});
