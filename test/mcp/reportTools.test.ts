/**
 * The report tools (mcp/report-tools.mjs): list_reports, run_report, report_drilldown and
 * export_report, each over the generic door. These tests hold the connector's copy of the report
 * catalog to lib/reports/catalog.ts, its options to the app's report parameters
 * (lib/validation/reports.ts), its drill-down list to lib/reports/drilldown.ts and its export to
 * the report window's own (lib/reports/types.ts reportToTable); and check what each tool sends
 * and how it words the answer. The app is a recording stand-in, as in the other mcp tests.
 */
import { describe, expect, it } from 'vitest';
import { argumentProblem, createServer } from '../../mcp/protocol.mjs';
import { TOOLS } from '../../mcp/tools.mjs';
import {
  DATE_PRESETS,
  DRILLDOWN_KEYS,
  EXPORT_MAX_ROWS,
  REPORTS,
  REPORT_CONTROL_OPTIONS,
  REPORT_GROUPS,
  REPORT_KEYS,
  REPORT_OPTIONS,
  REPORT_OPTION_PARAMS,
  REPORT_TOOLS,
  TXN_TYPES,
  compactCollected,
  optionsOf,
  reportQuery,
  reportTable,
} from '../../mcp/report-tools.mjs';
import { IronbooksError } from '../../mcp/client.mjs';
import { REPORT_READ_DONE } from '../../mcp/operations-tools.mjs';
import { REQUEST_ID_MESSAGE } from '@/lib/agent/actions';
import { REPORT_CATALOG, REPORT_GROUPS as APP_GROUPS } from '@/lib/reports/catalog';
import { DRILLDOWN_REPORTS } from '@/lib/reports/drilldown';
import { reportToTable, type StdReport } from '@/lib/reports/types';
import { TXN_TYPE_KEYS, parseReportParams, reportParamsSchema } from '@/lib/validation/reports';
import { findOperations, operationById } from '@/lib/agent/operations/registry';

type Any = Record<string, any>;
const ID = '11111111-2222-4333-8444-555555555555';
const ID2 = '99999999-2222-4333-8444-555555555555';
const FILE = 'ab'.repeat(16);

/** ajv is not a dependency of its own (electron-builder brings it): skip its checks without it. */
const Ajv2020: any = await import('ajv/dist/2020').then((m) => m.default ?? m).catch(() => null);

const REPORT: StdReport = {
  key: 'profit-loss',
  title: 'Profit & Loss',
  subtitle: 'January 2026',
  basis: 'accrual',
  range: { from: '2026-01-01', to: '2026-01-31', asOf: '2026-01-31' },
  columns: [{ key: 'label', header: 'Account' }, { key: 'amount', header: 'Jan 2026', type: 'money' }],
  rows: [
    { id: 'sec:income', depth: 0, kind: 'section', cells: { label: 'Income' } },
    { id: 'acct:4000', depth: 1, kind: 'data', cells: { label: 'Sales', amount: '100.00' } },
    { id: 'sp', depth: 0, kind: 'spacer', cells: {} },
    { id: 'tot:income', depth: 0, kind: 'total', cells: { label: 'Total Income', amount: '100.00' } },
  ],
};

/** Records every POST to the door and answers with `answer`. */
function fake(answer: (r: Any) => unknown) {
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
        throw new Error('a report tool must not read a route of its own');
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

const FEATURES: Record<string, string> = { inventoryEnabled: 'inventory', payrollEnabled: 'payroll', salesTaxEnabled: 'sales_tax' };

/** One valid value of each option, in the tool's form. */
function optionSample(name: string): unknown {
  const s = (REPORT_OPTIONS.properties as Any)[name];
  if (Array.isArray(s.enum)) return s.enum.at(-1);
  if (s.type === 'integer') return Math.max(s.minimum ?? 1, 1);
  if (name === 'date_from' || name === 'prior_as_of') return '2026-01-01';
  if (s.pattern?.includes('\\d{4}-')) return '2026-03-31';
  if (s.pattern?.includes('fA-F')) return ID;
  if (s.pattern) return '10.00';
  return 'x';
}

describe('the copy of the report catalog and the app agree', () => {
  it('every report, in the catalog\'s order, with its title, group, description, controls, basis and feature', () => {
    const listed = REPORT_CATALOG.filter((e) => !e.hidden);
    expect(REPORTS.map((r: Any) => r.key)).toEqual(listed.map((e) => e.key));
    expect(REPORT_KEYS).toEqual(listed.map((e) => e.key));
    for (const e of listed) {
      const r = REPORTS.find((x: Any) => x.key === e.key)!;
      expect(r, e.key).toEqual({
        key: e.key,
        title: e.title,
        group: e.group,
        about: e.description,
        controls: e.controls.join(' '),
        ...(e.basis ? { basis: true } : {}),
        ...(e.feature ? { needs: FEATURES[e.feature] } : {}),
      });
    }
    expect(REPORTS.length).toBeGreaterThan(100);
    expect(REPORT_GROUPS).toEqual([...APP_GROUPS]);
    expect(DRILLDOWN_KEYS).toEqual([...DRILLDOWN_REPORTS]);
    for (const k of DRILLDOWN_KEYS) expect(REPORT_KEYS, k).toContain(k);
  });

  it('every control the catalog uses has its options, and every option is a report parameter of the app', () => {
    const used = new Set(REPORT_CATALOG.flatMap((e) => e.controls));
    for (const c of used) expect(REPORT_CONTROL_OPTIONS, c).toHaveProperty(c);
    const shape = (reportParamsSchema as any)._def.schema.shape as Record<string, unknown>;
    for (const [option, param] of Object.entries(REPORT_OPTION_PARAMS)) expect(shape, `${option} -> ${param}`).toHaveProperty(param as string);
    expect(Object.keys(REPORT_OPTIONS.properties).sort()).toEqual(Object.keys(REPORT_OPTION_PARAMS).sort());
    for (const opts of Object.values(REPORT_CONTROL_OPTIONS)) for (const o of opts as string[]) expect(REPORT_OPTION_PARAMS, o).toHaveProperty(o);
    expect(TXN_TYPES).toEqual([...TXN_TYPE_KEYS]);
  });

  it('every choice an option offers is one the app accepts', () => {
    for (const [name, s] of Object.entries(REPORT_OPTIONS.properties as Record<string, Any>)) {
      const param = (REPORT_OPTION_PARAMS as Any)[name];
      if (Array.isArray(s.enum)) for (const v of s.enum) expect(parseReportParams({ [param]: v }).success, `${name} ${v}`).toBe(true);
    }
    for (const d of DATE_PRESETS) expect(parseReportParams({ dates: d }).success, d).toBe(true);
    expect(parseReportParams({ repId: 'none' }).success).toBe(true);
  });

  it('every report\'s options, all given at once, make a query the app accepts', () => {
    for (const r of REPORTS as Array<{ key: string; controls: string; basis?: boolean }>) {
      const options: Any = {};
      for (const o of optionsOf(r)) if (o !== 'period') options[o] = optionSample(o);
      expect(argumentProblem(REPORT_OPTIONS, options), r.key).toBeNull();
      const parsed = parseReportParams(reportQuery(r.key, options));
      expect(parsed.success, `${r.key}: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);
    }
  });

  it('the operations the tools run exist, are open to agents, and only read', () => {
    for (const [id, output] of [['reports.std.get', 'json'], ['reports.drilldown.get', 'json'], ['export.reports', 'file']]) {
      const op = operationById(id);
      expect(op, `operation "${id}" is not in the registry (renamed?)`).not.toBeNull();
      expect(op!.availability, id).toBe('agent');
      expect(op!.class, id).toBe('read');
      expect(op!.output, id).toBe(output);
    }
    expect(operationById('reports.std.get')!.params).toEqual(['report']);
    expect(operationById('reports.drilldown.get')!.params).toEqual(['report']);
    // What the descriptions send the agent to instead: there, and open to agents.
    for (const id of ['reports.1099', 'reports.1099-pdf', 'reports.1099-xml', 'payroll.paystub', 'audit-trail', 'transaction-log', 'why-changed', 'budgets.list']) {
      const op = operationById(id);
      expect(op, `"${id}" is named in a description but is not an operation (renamed?)`).not.toBeNull();
      expect(op!.availability, id).toBe('agent');
    }
  });

  it('find_operations finds each of the other reads by the words the descriptions promise', () => {
    // The words are quoted in OTHER_READS; the door answers find_operations with findOperations and
    // shows at most 30 (lib/agent/operate.ts FIND_LIMIT).
    const description = (REPORT_TOOLS as Any[]).find((t) => t.name === 'list_reports')!.description as string;
    const promised: Array<[string, string[]]> = [
      ['1099', ['reports.1099', 'reports.1099-pdf', 'reports.1099-xml']],
      ['paystub', ['payroll.paystub']],
      ['audit trail', ['audit-trail']],
      ['transaction log', ['transaction-log']],
      ['why changed', ['why-changed']],
    ];
    for (const [words, ids] of promised) {
      expect(description, words).toContain(`"${words}"`);
      const found = findOperations({ query: words, limit: 30 }).map((o) => o.id);
      for (const id of ids) expect(found, `find_operations "${words}" does not show ${id}`).toContain(id);
    }
  });

  it('the report tools only look: no dry run, nothing marked as a change; the reads through the door may ask', () => {
    expect(REPORT_TOOLS.map((t: Any) => t.name)).toEqual(['list_reports', 'run_report', 'report_drilldown', 'export_report']);
    const names = new Set((TOOLS as Any[]).map((t) => t.name));
    for (const t of REPORT_TOOLS as Any[]) {
      expect(names.has(t.name), t.name).toBe(true);
      expect(t.changes, t.name).not.toBe(true);
      expect(t.inputSchema.properties, t.name).not.toHaveProperty('dry_run');
      // list_reports reads nothing from Ironbooks; the other three may need a person's approval to
      // read, and take a request_id and a reason to ask with, neither of them required.
      const asks = t.name !== 'list_reports';
      expect('request_id' in t.inputSchema.properties, t.name).toBe(asks);
      expect('reason' in t.inputSchema.properties, t.name).toBe(asks);
      expect(t.inputSchema.required ?? [], t.name).not.toContain('request_id');
      if (asks) expect(t.inputSchema.properties.reason.maxLength, t.name).toBe(500);
    }
    for (const name of ['list_reports', 'run_report']) expect((REPORT_TOOLS as Any[]).find((t) => t.name === name)!.description).toMatch(/find_operations[^.]*"1099"[^.]*"audit trail"/);
  });

  it.skipIf(!Ajv2020)('every schema compiles as JSON Schema 2020-12, strictly, and agrees with the tool\'s own check', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    ajv.addKeyword({ keyword: 'patternHint', schemaType: 'string' });
    ajv.addKeyword({ keyword: 'anyOfHint', schemaType: 'string' });
    const cases: Record<string, { good: Any[]; bad: Any[] }> = {
      list_reports: { good: [{}, { query: 'aging', group: 'Sales' }], bad: [{ group: 'Taxes' }, { other: 1 }] },
      run_report: {
        good: [
          { key: 'profit-loss' },
          { key: 'ar-aging-summary', options: { as_of: '2026-03-31', days_per_column: 15, sales_rep_id: 'none' }, max_rows: 50 },
          { key: 'profit-loss', request_id: 'pl-2026-03', reason: 'The owner asked for March.' },
          { key: 'profit-loss', request_id: `r${'x'.repeat(119)}` },
        ],
        bad: [
          {},
          { key: 'no-such-report' },
          { key: 'profit-loss', options: { from: '2026-01-01' } },
          { key: 'profit-loss', options: { sales_rep_id: 'nobody' } },
          { key: 'profit-loss', max_rows: 0 },
          { key: 'profit-loss', request_id: 'pl' },
          { key: 'profit-loss', request_id: `r${'x'.repeat(120)}` },
          { key: 'profit-loss', request_id: 'pl 2026' },
          { key: 'profit-loss', reason: 'x'.repeat(501) },
          { key: 'profit-loss', dry_run: true },
        ],
      },
      report_drilldown: {
        good: [{ key: 'profit-loss', row_id: 'acct:4000', column: 'amount' }, { key: 'profit-loss', row_id: 'acct:4000', column: 'amount', request_id: 'drill-1', reason: 'Why sales rose.' }],
        bad: [{ key: 'journal', row_id: 'x', column: 'amount' }, { key: 'profit-loss', row_id: 'x' }, { key: 'profit-loss', row_id: 'x', column: 'a b' }, { key: 'profit-loss', row_id: 'x', column: 'amount', request_id: '-x1' }],
      },
      export_report: {
        good: [{ key: 'trial-balance', format: 'xlsx' }, { key: 'profit-loss', format: 'pdf', title: 'P&L', landscape: true }, { key: 'trial-balance', format: 'pdf', request_id: `e${'x'.repeat(114)}`, reason: 'For the board.' }],
        // The file step adds ":file" to the request id: at most 115 characters, so it still fits the door's 120.
        bad: [{ key: 'trial-balance' }, { key: 'trial-balance', format: 'csv' }, { key: 'trial-balance', format: 'pdf', request_id: `e${'x'.repeat(115)}` }],
      },
    };
    for (const [name, { good, bad }] of Object.entries(cases)) {
      const schema = (REPORT_TOOLS as Any[]).find((t) => t.name === name)!.inputSchema;
      const validate = ajv.compile(schema);
      for (const args of good) {
        expect(validate(args), `${name} ${JSON.stringify(args)}: ${JSON.stringify(validate.errors)}`).toBe(true);
        expect(argumentProblem(schema, args), `${name} ${JSON.stringify(args)}`).toBeNull();
      }
      for (const args of bad) {
        expect(validate(args), `${name} ${JSON.stringify(args)}`).toBe(false);
        expect(argumentProblem(schema, args), `${name} ${JSON.stringify(args)}`).not.toBeNull();
      }
    }
  });
});

describe('list_reports', () => {
  it('finds reports by words and by group, with the options each takes', async () => {
    const { client, acted } = fake(() => ({}));
    const aging = await call(client, 'list_reports', { query: 'aging summary' });
    expect(aging.data.reports.map((r: Any) => r.key)).toEqual(['ar-aging-summary', 'ap-aging-summary', 'combined-ar-aging', 'combined-ap-aging']);
    expect(aging.data.reports[0]).toEqual({
      key: 'ar-aging-summary',
      title: 'A/R Aging Summary',
      group: 'Customers & Receivables',
      shows: 'What each customer owes, by how many days past due.',
      options: ['period', 'as_of', 'class_id', 'customer_id', 'customer_type_id', 'days_per_column', 'through_days', 'age_from'],
      drilldown: true,
    });
    const inventory = await call(client, 'list_reports', { group: 'Inventory' });
    expect(inventory.data.count).toBe(10);
    expect(inventory.data.reports[0].needs).toMatch(/inventory to be turned on/);
    const contacts = await call(client, 'list_reports', { query: 'customer contact' });
    expect(contacts.data.reports).toEqual([expect.objectContaining({ key: 'customer-contact-list', options: 'none' })]);
    const none = await call(client, 'list_reports', { query: 'astrology' });
    expect(none.data).toMatchObject({ count: 0, reports: [] });
    expect(none.data.next).toMatch(/Nothing matched/);
    expect(none.data.other).toMatch(/find_operations/);
    const all = await call(client, 'list_reports');
    expect(all.data.count).toBe(REPORTS.length);
    expect(acted).toEqual([]);
  });
});

describe('run_report', () => {
  it('sends the run_operation verb for reports.std.get, the key as its parameter and the options in the app\'s names', async () => {
    const { client, acted } = fake(() => ({ operation: 'reports.std.get', outcome: 'read', result: REPORT }));
    const r = await call(client, 'run_report', {
      key: 'profit-loss',
      options: { date_from: '2026-01-01', date_to: '2026-01-31', basis: 'cash', columns: 'month', compare: 'prev_year', class_id: ID, transaction_type: 'invoice', amount_min: '5.00' },
    });
    expect(r.isError, r.text).toBe(false);
    expect(acted).toEqual([
      {
        verb: 'run_operation',
        operation: 'reports.std.get',
        params: { report: 'profit-loss' },
        query: { from: '2026-01-01', to: '2026-01-31', basis: 'cash', columns: 'month', compare: 'prev_year', classId: ID, txnType: 'invoice', amountMin: '5.00' },
      },
    ]);
    // A drill-down report: each row has its id and each column its key, for report_drilldown.
    expect(r.data).toMatchObject({ key: 'profit-loss', report: 'Profit & Loss', basis: 'accrual', row_count: 3 });
    expect(r.data.columns).toEqual([{ name: 'Account', key: 'label' }, { name: 'Jan 2026', key: 'amount', type: 'money' }]);
    expect(r.data.rows[1]).toEqual({ row_id: 'acct:4000', kind: 'data', level: 1, cells: ['Sales', '100.00'] });
    expect(r.data.drilldown).toMatch(/report_drilldown/);
  });

  it('a report that cannot be drilled has no ids; numbers go as text; a named period is the app\'s "dates"', async () => {
    const { client, acted } = fake(() => ({ operation: 'reports.std.get', outcome: 'read', result: { ...REPORT, key: 'journal', title: 'Journal' } }));
    const r = await call(client, 'run_report', { key: 'journal', options: { period: 'last_month', account_id: ID }, max_rows: 1 });
    expect(acted[0].query).toEqual({ dates: 'last_month', accountId: ID });
    expect(r.data.rows).toEqual([{ kind: 'section', level: 0, cells: ['Income', null] }]);
    expect(r.data.truncated).toBe(true);
    expect(r.data).not.toHaveProperty('drilldown');
    await call(client, 'run_report', { key: 'ap-aging-detail', options: { as_of: '2026-03-31', days_per_column: 15, through_days: 120, age_from: 'transaction_date', vendor_id: ID2 } });
    expect(acted[1].query).toEqual({ asOf: '2026-03-31', interval: '15', through: '120', agingFrom: 'transaction_date', vendorId: ID2 });
    await call(client, 'run_report', { key: 'cash-flow-forecast', options: { forecast_by: 'month' } });
    expect(acted[2].query).toEqual({ period: 'month' });
  });

  it('refuses an option the report does not take, and a period with dates, before anything is sent', async () => {
    const { client, acted } = fake(() => ({ outcome: 'read', result: REPORT }));
    const vendor = await call(client, 'run_report', { key: 'trial-balance', options: { vendor_id: ID } });
    expect(vendor.isError).toBe(true);
    expect(vendor.text).toBe('The Trial Balance report does not take vendor_id. It takes: period, as_of, basis. list_reports shows each report\'s options.');
    const none = await call(client, 'run_report', { key: 'customer-phone-list', options: { as_of: '2026-03-31' } });
    expect(none.text).toMatch(/It takes no options/);
    const both = await call(client, 'run_report', { key: 'profit-loss', options: { period: 'this_year', date_to: '2026-03-31' } });
    expect(both.text).toMatch(/either "period" or dates/);
    expect(acted).toEqual([]);
  });

  /**
   * The door's request-id check as the connector receives it (lib/agent/operate.ts requireRequestId):
   * a 400 VALIDATION that names the field it wants (details.fields.requestId, client.mjs
   * IronbooksError.fields). `message`: the door's wording, the app's own REQUEST_ID_MESSAGE unless a
   * test changes it.
   */
  const requestIdCheck = (message: string = REQUEST_ID_MESSAGE) =>
    new IronbooksError(message, { status: 400, code: 'VALIDATION', fields: { requestId: 'give a request_id of your own, unique to this change' } });

  /**
   * The door when an Admin set reading reports to Ask: the read sent without a request id is refused
   * with its request-id check, before anything is read. A dry run is never needed to tell that
   * refusal from another, so one sent fails the test.
   */
  const askedDoor = (message: string = REQUEST_ID_MESSAGE, also: (r: Any) => unknown = () => undefined) =>
    fake((r) => {
      const other = also(r);
      if (other !== undefined) return other;
      if (r.dryRun === true) return new Error('a report tool must not send a dry run to learn why a read was refused');
      return requestIdCheck(message);
    });

  /** What a tool says when the read must be asked for and it was sent without a request_id. */
  const sendAgain = (tool: string) =>
    `A person must approve this read before you see it. Send ${tool} again with the same arguments, a request_id of your own and a reason: Ironbooks then asks a person, and its answer says what to do next.`;

  it('a read a person must approve (an Admin set reports to Ask), sent without a request_id: the tool says to send it again with one', async () => {
    const first = askedDoor();
    const run = await call(first.client, 'run_report', { key: 'profit-loss', options: { period: 'last_month' } });
    expect(run.isError).toBe(true);
    expect(run.text).toBe(sendAgain('run_report'));
    // The read alone, once: the refusal names the field it wants, so nothing more is sent to learn
    // which 400 it was. Never a request id or a reason.
    expect(first.acted).toEqual([{ verb: 'run_operation', operation: 'reports.std.get', params: { report: 'profit-loss' }, query: { dates: 'last_month' } }]);
    expect(first.acted.some((a) => 'requestId' in a || 'reason' in a)).toBe(false);
    const drill = await call(askedDoor().client, 'report_drilldown', { key: 'profit-loss', row_id: 'acct:4000', column: 'amount' });
    expect(drill.text).toBe(sendAgain('report_drilldown'));
    // The file step asked for, after the report was read.
    const file = await call(
      askedDoor(REQUEST_ID_MESSAGE, (r) => (r.operation === 'reports.std.get' ? { operation: r.operation, outcome: 'read', result: REPORT } : undefined)).client,
      'export_report',
      { key: 'profit-loss', format: 'pdf' },
    );
    expect(file.isError).toBe(true);
    expect(file.text).toBe(sendAgain('export_report'));
    // Any other error is the app's own, unchanged, and asks nothing more of the door.
    const down = fake(() => new IronbooksError('Ironbooks is not ready: open the company file.', { status: 503 }));
    const other = await call(down.client, 'run_report', { key: 'profit-loss' });
    expect(other.text).toBe('Ironbooks is not ready: open the company file.');
    expect(down.acted).toHaveLength(1);
  });

  it('the asked read is told by the field the refusal names, not by the words of its message, and nothing is read twice', async () => {
    // The door words it differently one day: still the same advice.
    const reworded = await call(askedDoor('Send an id of your own with this, so it is never done twice.').client, 'run_report', { key: 'profit-loss' });
    expect(reworded.text).toMatch(/^A person must approve this read before you see it/);
    // The route's own 400 for the read (dates it cannot use): the app's message as it was, with no
    // word about approval, after one read (it counts once against the agent's calls per minute).
    const badDates = new IronbooksError('The start date must be on or before the end date.', { status: 400, code: 'VALIDATION' });
    const route = fake(() => badDates);
    const r = await call(route.client, 'run_report', { key: 'profit-loss', options: { date_from: '2026-02-01', date_to: '2026-01-01' } });
    expect(r.text).toBe('The start date must be on or before the end date.');
    expect(route.acted).toHaveLength(1);
    // The request-id words without the field are not taken for the check: passed on as they are.
    const words = fake(() => new IronbooksError(REQUEST_ID_MESSAGE, { status: 400, code: 'VALIDATION' }));
    expect((await call(words.client, 'run_report', { key: 'profit-loss' })).text).toBe(REQUEST_ID_MESSAGE);
    expect(words.acted).toHaveLength(1);
    // A message that names request_id, from anything but the door's request-id check, is not taken for it.
    const named = await call(fake(() => new IronbooksError('The request_id "x-1" was already used for a different request.', { status: 409, code: 'CONFLICT' })).client, 'run_report', { key: 'profit-loss' });
    expect(named.text).toBe('The request_id "x-1" was already used for a different request.');
  });

  it('what the agent collects after a person approves the read is what run_report gives', async () => {
    const shown = await call(fake(() => ({ operation: 'reports.std.get', outcome: 'read', result: REPORT })).client, 'run_report', { key: 'profit-loss' });
    // wait_for_decision's request (mcp/operations-tools.mjs shapeRequest), with the route's raw report.
    const request = { request_id: ID2, decision: 'approved', status: 'executed', operation: 'reports.std.get', summary: 'Read the profit-loss report', result: REPORT, next: 'It is done.' };
    const collected = compactCollected(request);
    expect(collected).toEqual({ ...request, result: shown.data });
    // Already compact, or not a report: handed back as it is.
    expect(compactCollected(collected)).toBe(collected);
    const other = { ...request, operation: 'invoices.get', result: { id: ID } };
    expect(compactCollected(other)).toBe(other);
    expect(compactCollected({ ...request, result: null }).result).toBeNull();
    // run_operation's answer names no operation: it is given.
    const replay = { outcome: 'read', repeated: true, result: REPORT };
    expect(compactCollected(replay, 'reports.std.get')).toEqual({ ...replay, result: shown.data });
    expect(compactCollected(replay)).toBe(replay);
    // A drill-down, as report_drilldown gives it.
    const txn = { key: `je:${ID}`, entryId: ID, date: '2026-01-05', type: 'Invoice', num: '1001', name: 'Acme', memo: '', account: 'Sales', amount: '100.00' };
    const raw = { report: 'profit-loss', rowLabel: 'Sales', columnLabel: 'Jan 2026', kind: 'transactions', cell: '100.00', total: '100.00', ties: true, count: 1, transactions: [txn], listTruncated: false, incomplete: false };
    const drilled = await call(fake(() => ({ operation: 'reports.drilldown.get', outcome: 'read', result: raw })).client, 'report_drilldown', { key: 'profit-loss', row_id: 'acct:4000', column: 'amount' });
    expect(compactCollected({ operation: 'reports.drilldown.get', result: raw })).toEqual({ operation: 'reports.drilldown.get', result: drilled.data });
    // A report of a key this copy of the catalog does not know: still compact, without the drill-down parts.
    const unknown = compactCollected({ operation: 'reports.std.get', result: { ...REPORT, key: 'brand-new-report' } });
    expect(unknown.result).toMatchObject({ key: 'brand-new-report', report: 'Profit & Loss', row_count: 3, rows: [{ kind: 'section', level: 0, cells: ['Income', null] }, expect.anything(), expect.anything()] });
    expect(unknown.result).not.toHaveProperty('drilldown');
  });

  it('a collected result the size limit cut says so inside the result, with the numbers it knows', () => {
    const cutShort = { result: 'The result was too long to show in full: its longest lists were cut. It was carried out once, in full: do not send it again.' };
    const base = { request_id: ID2, decision: 'approved', operation: 'reports.std.get', cut_short: cutShort };
    const SEE = 'To see the rest, run it again with a shorter date range or a filter.';
    // Made compact before it was held (mcp/tools.mjs): row_count is the report's own.
    const compact = compactCollected({ operation: 'reports.std.get', result: REPORT }).result;
    const held = { ...base, result: { ...compact, rows: compact.rows.slice(0, 1) } };
    const marked = compactCollected(held);
    expect(marked.result).toMatchObject({ row_count: 3, truncated: true });
    expect(marked.result.rows).toHaveLength(1);
    expect(marked.result.notes.at(-1)).toBe(`Showing the first 1 of 3 rows: the whole report was too long for one answer. ${SEE}`);
    // Marked once.
    expect(compactCollected(marked)).toBe(marked);
    // Cut elsewhere (every row still there): said without a count it does not have.
    expect(compactCollected({ ...base, result: compact }).result.notes.at(-1)).toBe(`Part of the report was left out: the whole report was too long for one answer. ${SEE}`);
    // Held while still raw (an older order): the real count is gone, and the note says row_count counts only what is shown.
    const raw = compactCollected({ ...base, result: { ...REPORT, rows: REPORT.rows.slice(0, 2) } });
    expect(raw.result).toMatchObject({ row_count: 2, truncated: true });
    expect(raw.result.notes.at(-1)).toBe(`Part of the report was left out (the whole report was too long for one answer), so row_count counts only the 2 rows shown. ${SEE}`);
    // Nothing cut: nothing said.
    expect(compactCollected({ ...base, cut_short: { would_post: 'x' }, result: compact }).result).not.toHaveProperty('truncated');
    // A drill-down whose list was cut: the count and total still cover everything.
    const txn = { key: `je:${ID}`, entryId: ID, date: '2026-01-05', type: 'Invoice', num: '1001', name: 'Acme', memo: '', account: 'Sales', amount: '100.00' };
    const drill = { report: 'profit-loss', rowLabel: 'Sales', columnLabel: 'Jan 2026', kind: 'transactions', cell: '200.00', total: '200.00', ties: true, count: 2, transactions: [txn], listTruncated: false, incomplete: false };
    const drilled = compactCollected({ operation: 'reports.drilldown.get', cut_short: cutShort, result: drill });
    expect(drilled.result).toMatchObject({ count: 2, truncated: true });
    expect(drilled.result.notes.at(-1)).toMatch(/^Only 1 of the transactions are listed here: the whole list was too long for one answer\. The count and the total still cover all of them\./);
    expect(compactCollected(drilled)).toBe(drilled);
  });

  it('an asked answer (a read filed for a person) is worded like every other one', async () => {
    const needs = { admin: false, fileAdmin: false, hostOnly: false, flag: null, secrets: [], twoPerson: false, grantable: 'no' };
    const { client } = fake((r) => ({ operation: r.operation, outcome: 'asked', requestId: ID2, status: 'pending', needs, summary: 'Run the profit-loss report' }));
    const asked = await call(client, 'run_report', { key: 'profit-loss' });
    expect(asked.isError).toBe(false);
    expect(asked.data).toMatchObject({ outcome: 'asked', said: 'Not done yet. A person must approve it in Ironbooks first.', request_id: ID2 });
    expect(asked.data.next).toMatch(new RegExp(`wait_for_decision with request_id "${ID2}"`));
    expect(asked.data.next).toMatch(/Once a person approves it, wait_for_decision gives you the report as run_report does\.$/);
  });

  it('with a request_id and a reason, a read a person must approve is asked for from the tool itself', async () => {
    const needs = { admin: false, fileAdmin: false, hostOnly: false, flag: null, secrets: [], twoPerson: false, grantable: 'no' };
    const asked = fake((r) => ({ operation: r.operation, outcome: 'asked', requestId: ID2, status: 'pending', needs, summary: 'Run the profit-loss report' }));
    const r = await call(asked.client, 'run_report', { key: 'profit-loss', options: { period: 'last_month' }, request_id: 'pl-2026-03', reason: '  The owner asked for last month.  ' });
    expect(r.isError, r.text).toBe(false);
    // Sent once, with the request id and the reason (trimmed) beside the input; never a dry run.
    expect(asked.acted).toEqual([
      { verb: 'run_operation', operation: 'reports.std.get', params: { report: 'profit-loss' }, query: { dates: 'last_month' }, requestId: 'pl-2026-03', reason: 'The owner asked for last month.' },
    ]);
    expect(r.data).toMatchObject({ outcome: 'asked', request_id: ID2, status: 'pending' });
    expect(r.data.next).toMatch(new RegExp(`^Call wait_for_decision with request_id "${ID2}"`));
    expect(r.data.next).toMatch(/Once a person approves it, wait_for_decision gives you the report as run_report does\.$/);
    // A reason of only spaces is no reason, and is left out. A read that runs at once needs none; one
    // a person must approve is then not put to anyone: the door refuses to ask without a reason
    // (lib/agent/operate.ts NO_REASON_NOTE), and the agent is told to send one.
    const blank = fake((q) => ({ operation: q.operation, outcome: 'read', result: REPORT }));
    await call(blank.client, 'run_report', { key: 'profit-loss', request_id: 'pl-2026-03', reason: '   ' });
    expect(blank.acted[0]).toEqual({ verb: 'run_operation', operation: 'reports.std.get', params: { report: 'profit-loss' }, query: {}, requestId: 'pl-2026-03' });
    const { NO_REASON_NOTE } = await import('@/lib/agent/operate');
    const noReason = fake((q) => ({ operation: q.operation, outcome: 'refused', note: NO_REASON_NOTE }));
    const refused = await call(noReason.client, 'run_report', { key: 'profit-loss', request_id: 'pl-2026-03', reason: '   ' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(new RegExp(`^Refused: ${NO_REASON_NOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} Nothing was done\\.`));
    // A reason without a request id asks nothing: neither is sent.
    await call(blank.client, 'run_report', { key: 'profit-loss', reason: 'Because.' });
    expect(blank.acted[1]).toEqual({ verb: 'run_operation', operation: 'reports.std.get', params: { report: 'profit-loss' }, query: {} });
  });

  it('a read that runs at once with a request_id is the report as usual; sent again after an approval, it is the approved report', async () => {
    const now = await call(fake((q) => ({ operation: q.operation, outcome: 'read', result: REPORT })).client, 'run_report', { key: 'profit-loss' });
    const once = await call(fake((q) => ({ operation: q.operation, outcome: 'read', result: REPORT })).client, 'run_report', { key: 'profit-loss', request_id: 'pl-1' });
    expect(once.data).toEqual(now.data);
    // The door's answer to the same request_id once a person approved and it ran (operate.ts presentState).
    const replay = fake((q) => ({ operation: q.operation, outcome: 'read', result: REPORT, requestId: ID2, status: 'executed', replayed: true, note: 'A person approved it and it was done.' }));
    const again = await call(replay.client, 'run_report', { key: 'profit-loss', request_id: 'pl-1' });
    expect(again.data).toEqual(now.data);
    // Denied: a refusal, in the person's words.
    const denied = fake((q) => ({ operation: q.operation, outcome: 'refused', requestId: ID2, status: 'denied', replayed: true, note: 'A person said no: "Not this month."' }));
    const no = await call(denied.client, 'run_report', { key: 'profit-loss', request_id: 'pl-1' });
    expect(no.isError).toBe(true);
    expect(no.text).toMatch(/^Refused: A person said no: "Not this month\."/);
  });

  it('with a request_id, an error is the read\'s own: no dry run is sent to tell it from the request-id check', async () => {
    const badDates = new IronbooksError('The start date must be on or before the end date.', { status: 400, code: 'VALIDATION' });
    const route = fake(() => badDates);
    const r = await call(route.client, 'run_report', { key: 'profit-loss', options: { date_from: '2026-02-01', date_to: '2026-01-01' }, request_id: 'pl-1' });
    expect(r.text).toBe('The start date must be on or before the end date.');
    expect(route.acted).toHaveLength(1);
  });

  it('a refusal that names the request id field (details.fields.requestId) is the request-id check; one that names another field is the route\'s own', async () => {
    const named = fake(() => requestIdCheck());
    const r = await call(named.client, 'run_report', { key: 'profit-loss' });
    expect(r.text).toBe(sendAgain('run_report'));
    expect(named.acted).toHaveLength(1);
    // A refusal that names another field is the route's own: passed on as it is, after one read.
    const other = fake(() => new IronbooksError('from: Invalid date', { status: 400, code: 'VALIDATION', fields: { from: 'Invalid date' } }));
    const o = await call(other.client, 'run_report', { key: 'profit-loss' });
    expect(o.text).toBe('from: Invalid date');
    expect(other.acted).toHaveLength(1);
    // Any other kind of error, with the field named or not, is not the check either.
    const busy = fake(() => new IronbooksError('Ironbooks is busy.', { status: 409, code: 'CONFLICT', fields: { requestId: 'x' } }));
    expect((await call(busy.client, 'run_report', { key: 'profit-loss' })).text).toBe('Ironbooks is busy.');
  });

  it('a refusal is a tool error, and an answer that is not a report is said plainly', async () => {
    const refused = await call(fake(() => ({ operation: 'reports.std.get', outcome: 'refused', note: 'Your role may not see payroll reports' })).client, 'run_report', { key: 'payroll-summary' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^Refused: Your role may not see payroll reports\. Nothing was done\./);
    const odd = await call(fake(() => ({ outcome: 'read', result: null })).client, 'run_report', { key: 'profit-loss' });
    expect(odd.isError).toBe(true);
    expect(odd.text).toMatch(/answered without a report/);
  });
});

describe('report_drilldown', () => {
  it('sends the row, the column, the limit and the report\'s options, and lists the transactions', async () => {
    const txn = { key: `je:${ID}`, entryId: ID, sourceRef: `invoice:${ID2}`, date: '2026-01-05', type: 'Invoice', num: '1001', name: 'Acme', memo: '', account: 'Sales', amount: '100.00' };
    const { client, acted } = fake(() => ({
      operation: 'reports.drilldown.get',
      outcome: 'read',
      result: {
        report: 'profit-loss', rowId: 'acct:4000', column: 'amount', rowLabel: 'Sales', columnLabel: 'Jan 2026', kind: 'transactions', cell: '100.00', total: '100.00',
        ties: true, count: 3, largest: txn, transactions: [txn], listTruncated: true, incomplete: false, explanation: 'Made of 3 transactions.', scope: 'Sales · 01/01/2026 – 01/31/2026', basis: 'accrual',
      },
    }));
    const r = await call(client, 'report_drilldown', { key: 'profit-loss', row_id: 'acct:4000', column: 'amount', options: { period: 'last_month', basis: 'accrual' }, max_transactions: 1 });
    expect(r.isError, r.text).toBe(false);
    expect(acted).toEqual([
      { verb: 'run_operation', operation: 'reports.drilldown.get', params: { report: 'profit-loss' }, query: { dates: 'last_month', basis: 'accrual', row: 'acct:4000', col: 'amount', limit: '1' } },
    ]);
    const row = { date: '2026-01-05', type: 'Invoice', number: '1001', name: 'Acme', memo: null, account: 'Sales', amount: '100.00', journal_entry_id: ID, source: `invoice:${ID2}` };
    expect(r.data).toEqual({
      report: 'profit-loss',
      line: 'Sales',
      column: 'Jan 2026',
      scope: 'Sales · 01/01/2026 – 01/31/2026',
      basis: 'accrual',
      amount_shown: '100.00',
      total: '100.00',
      count: 3,
      largest: row,
      explanation: 'Made of 3 transactions.',
      transactions: [row],
      notes: ['Only the first 1 of 3 transactions are listed. Raise max_transactions, or narrow the dates, to see more.'],
    });
  });

  it('with a request_id and a reason, a drill-down a person must approve is asked for, and says what it then gives', async () => {
    const needs = { admin: false, fileAdmin: false, hostOnly: false, flag: null, secrets: [], twoPerson: false, grantable: 'no' };
    const { client, acted } = fake((r) => ({ operation: r.operation, outcome: 'asked', requestId: ID2, status: 'pending', needs, summary: 'Transactions behind a report amount' }));
    const r = await call(client, 'report_drilldown', { key: 'profit-loss', row_id: 'acct:4000', column: 'amount', request_id: 'drill-1', reason: 'Why sales rose.' });
    expect(acted).toEqual([
      { verb: 'run_operation', operation: 'reports.drilldown.get', params: { report: 'profit-loss' }, query: { row: 'acct:4000', col: 'amount', limit: '200' }, requestId: 'drill-1', reason: 'Why sales rose.' },
    ]);
    expect(r.data).toMatchObject({ outcome: 'asked', request_id: ID2 });
    expect(r.data.next).toMatch(/Once a person approves it, wait_for_decision gives you the transactions as report_drilldown does\.$/);
  });

  it('says when the total cannot be trusted', async () => {
    const answer = (extra: Any) => fake(() => ({ outcome: 'read', result: { count: 0, total: '0.00', ties: true, transactions: [], incomplete: false, listTruncated: false, ...extra } })).client;
    const incomplete = await call(answer({ incomplete: true, ties: false }), 'report_drilldown', { key: 'general-ledger', row_id: 'x', column: 'amount' });
    expect(incomplete.data.notes).toEqual([expect.stringMatching(/too many transactions to add up/)]);
    const moved = await call(answer({ ties: false }), 'report_drilldown', { key: 'general-ledger', row_id: 'x', column: 'amount' });
    expect(moved.data.notes).toEqual([expect.stringMatching(/the books changed between the two reads/)]);
  });
});

describe('export_report', () => {
  it('runs the report, makes the same table the report window exports, and answers with the file', async () => {
    const file = { fileId: FILE, name: 'profit-loss.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 4096 };
    const { client, acted } = fake((r) =>
      r.operation === 'reports.std.get' ? { operation: r.operation, outcome: 'read', result: REPORT } : { operation: r.operation, outcome: 'read', result: null, file },
    );
    const r = await call(client, 'export_report', { key: 'profit-loss', format: 'xlsx', options: { period: 'last_month' } });
    expect(r.isError, r.text).toBe(false);
    expect(acted.map((a) => a.operation)).toEqual(['reports.std.get', 'export.reports']);
    expect(acted[0]).toEqual({ verb: 'run_operation', operation: 'reports.std.get', params: { report: 'profit-loss' }, query: { dates: 'last_month' } });
    const table = reportToTable(REPORT);
    expect(acted[1]).toEqual({
      verb: 'run_operation',
      operation: 'export.reports',
      body: { format: 'xlsx', filename: 'profit-loss', title: 'Profit & Loss', subtitle: 'January 2026', columns: table.columns, rows: table.rows },
    });
    expect(reportTable(REPORT)).toEqual(table);
    expect(r.data).toMatchObject({
      outcome: 'read',
      said: 'Ironbooks made an Excel (.xlsx) file of the report "Profit & Loss". Nothing in the books changed.',
      row_count: 3,
      file: { file_id: FILE, name: 'profit-loss.xlsx', type: file.type, size: 4096 },
    });
    expect(r.data.next).toMatch(new RegExp(`get_file with file_id "${FILE}"`));
    expect(r.data.next).toMatch(/save_file/);
    // A PDF with a title of its own, printed sideways.
    await call(client, 'export_report', { key: 'profit-loss', format: 'pdf', title: 'P&L for the board', landscape: true });
    expect(acted[3].body).toMatchObject({ format: 'pdf', title: 'P&L for the board', landscape: true });
    // A blank title is no title: the report's own is printed (the file's check needs one).
    await call(client, 'export_report', { key: 'profit-loss', format: 'pdf', title: '   ' });
    expect(acted[5].body.title).toBe('Profit & Loss');
    expect(acted.some((a) => 'requestId' in a || 'reason' in a)).toBe(false);
  });

  it('a report too long for a file is refused before the file is asked for; a refusal stops it', async () => {
    const long = { ...REPORT, rows: Array.from({ length: EXPORT_MAX_ROWS + 1 }, (_, i) => ({ id: `r${i}`, depth: 0, kind: 'data', cells: { label: `x${i}`, amount: '1.00' } })) };
    const { client, acted } = fake(() => ({ outcome: 'read', result: long }));
    const r = await call(client, 'export_report', { key: 'general-ledger', format: 'pdf' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/a file holds at most 50000/);
    expect(acted.map((a) => a.operation)).toEqual(['reports.std.get']);
    const refused = await call(fake(() => ({ outcome: 'refused', note: 'This agent may not read reports' })).client, 'export_report', { key: 'trial-balance', format: 'pdf' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^Refused: This agent may not read reports\./);
    const noFile = await call(fake((q) => ({ outcome: 'read', result: q.operation === 'reports.std.get' ? REPORT : null })).client, 'export_report', { key: 'profit-loss', format: 'pdf' });
    expect(noFile.isError).toBe(true);
    expect(noFile.text).toMatch(/did not make the file/);
  });

  it('with a request_id, each step a person must approve is asked for: the read under it, the file under it with ":file"', async () => {
    const needs = { admin: false, fileAdmin: false, hostOnly: false, flag: null, secrets: [], twoPerson: false, grantable: 'no' };
    const file = { fileId: FILE, name: 'profit-loss.pdf', type: 'application/pdf', size: 2048 };
    const args = { key: 'profit-loss', format: 'pdf', options: { period: 'last_month' }, request_id: 'exp-1', reason: 'For the board.' };
    // Reading the report is asked: the file is not asked for yet, and the agent is told to send the tool again once approved.
    const readAsked = fake((r) => ({ operation: r.operation, outcome: 'asked', requestId: ID2, status: 'pending', needs, summary: 'Run the profit-loss report' }));
    const first = await call(readAsked.client, 'export_report', args);
    expect(first.isError, first.text).toBe(false);
    expect(readAsked.acted).toEqual([
      { verb: 'run_operation', operation: 'reports.std.get', params: { report: 'profit-loss' }, query: { dates: 'last_month' }, requestId: 'exp-1', reason: 'For the board.' },
    ]);
    expect(first.data).toMatchObject({ outcome: 'asked', request_id: ID2 });
    // Two request ids in one answer: Ironbooks' (to wait with) and the agent's own (to send the tool
    // again with). Each is named for what it is for, and "do not send it again" holds only until then.
    expect(first.data.next).toBe(
      `Call wait_for_decision with request_id "${ID2}" to wait for the person's answer. Until a person approves it, do not send export_report again: it is already waiting. Once they approve it (wait_for_decision then says it is done), send export_report again with the same arguments and your own request_id "exp-1", not the request_id above: the report is not read a second time, and the file is made from it.`,
    );
    // wait_for_decision's last word on the approved read says the same, not only "do not send it again".
    const approved = {
      async act() {
        throw new Error('wait_for_decision only reads the request');
      },
      async get() {
        return {
          request: { id: ID2, kind: 'operation', operation: 'reports.std.get', class: 'read', status: 'executed', summary: 'Run the profit-loss report', decidedByName: 'Dana Lee', decidedAt: '2026-11-22T10:00:00.000Z', result: REPORT },
        };
      },
    };
    const waited = await call(approved, 'wait_for_decision', { request_id: ID2, timeout_seconds: 0 });
    expect(waited.data).toMatchObject({ decision: 'approved', said: 'Approved by Dana Lee, and done.' });
    expect(waited.data.next).toBe(REPORT_READ_DONE);
    expect(waited.data.next).toMatch(/If you asked for it with export_report, send export_report again now with the same arguments and your own request_id \(the one you chose, not this request_id\) to make the file/);
    // Approved and run: sent again, the read answers what was read, and the file is asked for under its own id.
    const fileAsked = fake((r) =>
      r.operation === 'reports.std.get'
        ? { operation: r.operation, outcome: 'read', result: REPORT, requestId: ID2, status: 'executed', replayed: true }
        : { operation: r.operation, outcome: 'asked', requestId: ID, status: 'pending', needs, summary: 'Make a pdf file of the report Profit & Loss' },
    );
    const second = await call(fileAsked.client, 'export_report', args);
    expect(fileAsked.acted.map((a) => [a.operation, a.requestId, a.reason])).toEqual([
      ['reports.std.get', 'exp-1', 'For the board.'],
      ['export.reports', 'exp-1:file', 'For the board.'],
    ]);
    expect(second.data).toMatchObject({ outcome: 'asked', request_id: ID });
    expect(second.data.next).toMatch(
      /Once a person approves it, wait_for_decision gives you the file_id of the file it made\. Collect it there, and do not send export_report again for it: the report would be read afresh, and once the books change it is no longer the same request\.$/,
    );
    // Both run at once: the file, as without a request id.
    const both = fake((r) => (r.operation === 'reports.std.get' ? { operation: r.operation, outcome: 'read', result: REPORT } : { operation: r.operation, outcome: 'read', result: null, file }));
    const made = await call(both.client, 'export_report', args);
    expect(made.data).toMatchObject({ outcome: 'read', file: { file_id: FILE } });
  });

  it('sent again after only the file step was asked, with the books changed since: the conflict is said in the tool\'s words', async () => {
    // The read runs at once (and is read afresh); the file step's request_id was used for the
    // report as it read before, so the door refuses it (lib/agent/operate.ts earlierAnswer).
    const conflict = 'The request_id "exp-1:file" was already used for a different request. Use a new request_id for a new request; reuse one only to repeat the very same request.';
    const door = fake((r) => (r.operation === 'reports.std.get' ? { operation: r.operation, outcome: 'read', result: REPORT } : new IronbooksError(conflict, { status: 409, code: 'CONFLICT' })));
    const r = await call(door.client, 'export_report', { key: 'profit-loss', format: 'pdf', request_id: 'exp-1', reason: 'For the board.' });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      `${conflict} ("exp-1:file" is the request_id export_report gives the file step: yours with ":file" added.) To collect a file a person was already asked to approve, call wait_for_decision with the request_id that answer gave (list_my_requests shows it): export_report sent again reads the report afresh, and once the books change it is no longer the same request. For a file of the report as it is now, send export_report with a NEW request_id.`,
    );
    // Without a request_id of the agent's own, nothing is added: the door's words as they are.
    const plain = fake((q) => (q.operation === 'reports.std.get' ? { operation: q.operation, outcome: 'read', result: REPORT } : new IronbooksError('Busy.', { status: 409, code: 'CONFLICT' })));
    expect((await call(plain.client, 'export_report', { key: 'profit-loss', format: 'pdf' })).text).toBe('Busy.');
  });
});
