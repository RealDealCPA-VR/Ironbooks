/**
 * The tools an agent gets, and first the reads: what a bookkeeper looks at before touching
 * anything (READ_TOOLS). None of these reads can change the books.
 *
 * Each read calls one plain GET route and trims the answer to what is useful, so an agent does not
 * spend its attention on internal fields. Whether the agent may read a route is decided by
 * Ironbooks, not here: lib/permissions/agentAccess.ts agentRouteAllowed, with the operation
 * registry (lib/agent/operations) and the agent's role. Conventions, the same in every tool:
 *
 *  - dates are YYYY-MM-DD; money is a string with two decimals ("1250.00"), never a float;
 *  - ids are the long ids other tools return (accounts, customers, vendors, journal entries);
 *  - a long answer is cut at `max_rows`, and says so, so the agent can narrow the question.
 *
 * TOOLS (at the end) adds the rest: the tools that change the books, the entry and report tools
 * over the generic door, the generic door itself, and files.
 */
import { ToolError } from './protocol.mjs';
import { WRITE_READ_TOOLS, WRITE_TOOLS } from './write-tools.mjs';
import { BANKING_READ_TOOLS, BANKING_WRITE_TOOLS } from './banking-tools.mjs';
import { ENTRY_TOOLS } from './entry-tools.mjs';
import { DATE_PRESETS, REPORT_TOOLS, TXN_TYPES, compactCollected, shapeReport } from './report-tools.mjs';
import { OPERATION_TOOLS, REQUEST_TEMPLATE, REQUEST_URI_PREFIX, readRequestResource } from './operations-tools.mjs';
import { FILE_TEMPLATE, FILE_TOOLS, FILE_URI_PREFIX, readFileResource } from './files-tools.mjs';
import { GUIDE_PROMPT, GUIDE_PROMPT_NAME, GUIDE_RESOURCE, GUIDE_URI, guideContents, guidePrompt } from './guide.mjs';

// The report shaping and the choices the reports share live with the report tools; kept
// exported here for the callers and tests that import them from this file.
export { DATE_PRESETS, TXN_TYPES, shapeReport };

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', patternHint: 'must be a date as YYYY-MM-DD' };
const ID = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', patternHint: 'must be an id returned by another tool' };
const MONEY = { type: 'string', pattern: '^\\d{1,13}(\\.\\d{1,2})?$', patternHint: 'must be an amount like 1250.00' };

export const OTHER_LISTS = [
  'terms', 'payment-methods', 'sales-tax-codes', 'sales-tax-items', 'other-names', 'ship-via', 'job-types',
  'customer-messages', 'vehicles',
];

const MAX_ROWS = { type: 'integer', minimum: 1, maximum: 2000, description: 'Most rows to return (default 300). The answer says when it was cut.' };

/** @param {object} properties @param {string[]} [required] */
function schema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const text = (v) => (v === null || v === undefined ? '' : String(v));
const has = (hay, needle) => text(hay).toLowerCase().includes(needle);

/** Keep rows whose named fields contain the search text (case-insensitive). */
function filterText(rows, search, fields) {
  const q = text(search).trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => fields.some((f) => has(r[f], q)));
}

/** Cut a list at max_rows and say so. */
function capped(rows, maxRows, key, hint) {
  const limit = maxRows ?? 300;
  const out = { count: rows.length, [key]: rows.slice(0, limit) };
  if (rows.length > limit) {
    out.truncated = true;
    out.note = `Showing the first ${limit} of ${rows.length}. ${hint}`;
  }
  return out;
}

const asList = (v, key) => (Array.isArray(v) ? v : Array.isArray(v?.[key]) ? v[key] : []);

/** The date arguments of a period report: either a named period or from/to. */
function periodQuery(a) {
  if (a.period && (a.date_from || a.date_to)) throw new ToolError('Give either "period" or date_from / date_to, not both.');
  return { dates: a.period, from: a.date_from, to: a.date_to };
}

const PERIOD_PROPS = {
  period: { type: 'string', enum: DATE_PRESETS, description: 'A named period, instead of date_from / date_to.' },
  date_from: { ...DATE, description: 'First day (YYYY-MM-DD). Default: start of the fiscal year that date_to falls in.' },
  date_to: { ...DATE, description: 'Last day (YYYY-MM-DD). Default: today.' },
};
const BASIS = { type: 'string', enum: ['accrual', 'cash'], description: "Default: the company's report basis (see get_company_info)." };

/** Find an account by exact number, exact name, or a unique part of the name. */
function resolveAccount(accounts, wanted) {
  const q = text(wanted).trim().toLowerCase();
  const label = (a) => (a.code ? `${a.code} ${a.name}` : a.name);
  const exact = accounts.filter((a) => text(a.code).toLowerCase() === q || text(a.name).toLowerCase() === q);
  const hits = exact.length ? exact : accounts.filter((a) => has(a.name, q) || has(label(a), q));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new ToolError(`No account matches "${wanted}". Use list_accounts to see the chart of accounts.`);
  throw new ToolError(`"${wanted}" matches more than one account: ${hits.slice(0, 8).map(label).join('; ')}. Use the account number or account_id.`);
}

const accountRow = (a) => ({ id: a.id, number: a.code ?? null, name: a.name, type: a.qbType ?? a.type, subtype: a.subtype ?? null, balance: a.balance ?? null, active: a.isActive !== false });

/** The tools that only look: lists, registers, search and reports. @type {import('./protocol.mjs').Tool[]} */
export const READ_TOOLS = [
  {
    name: 'get_company_info',
    title: 'Company information',
    description:
      'Start here. Which company these books belong to and how to read them: company name, fiscal year end, report basis (accrual or cash), home currency, the closing date (nothing on or before it can change without a person approving it), the time zone and today\'s date there, and which features the company uses (classes, inventory, sales tax, payroll, multiple currencies). Also says who you are in these books: your agent name and your role. get_my_permissions shows exactly what you may do on your own and what a person must approve.',
    inputSchema: schema({}),
    handler: (_a, c) => c.get('/api/agent/whoami'),
  },
  {
    name: 'list_accounts',
    title: 'Chart of accounts',
    description:
      'The chart of accounts: each account\'s id, number, name, type (Bank, Accounts Receivable, Income, Expense…), balance and whether it is active. Use it to find the account_id other tools ask for. A balance of null means your role may not see balances.',
    inputSchema: schema({
      search: { type: 'string', maxLength: 100, description: 'Only accounts whose name or number contains this text.' },
      type: { type: 'string', maxLength: 60, description: 'Only accounts of this type, for example "Bank", "Expense" or "Accounts Receivable".' },
      include_inactive: { type: 'boolean', description: 'Also list inactive accounts (default false).' },
      max_rows: MAX_ROWS,
    }),
    handler: async (a, c) => {
      let rows = asList(await c.get('/api/accounts', { includeInactive: a.include_inactive ? 'true' : undefined }), 'accounts').map(accountRow);
      rows = filterText(rows, a.search, ['name', 'number']);
      if (a.type) rows = rows.filter((r) => has(r.type, a.type.trim().toLowerCase()) || has(r.subtype, a.type.trim().toLowerCase()));
      return capped(rows, a.max_rows, 'accounts', 'Use search or type to narrow it.');
    },
  },
  {
    name: 'list_customers',
    title: 'Customers',
    description:
      'The customer list (customers and their jobs): id, name, company, email, phone, payment terms and the open balance each one owes. Use it to find a customer_id, or to see who owes money. For what is overdue and by how long, use report_ar_aging.',
    inputSchema: schema({
      search: { type: 'string', maxLength: 100, description: 'Only customers whose name, company or email contains this text.' },
      include_inactive: { type: 'boolean', description: 'Also list inactive customers (default false).' },
      max_rows: MAX_ROWS,
    }),
    handler: async (a, c) => {
      const raw = asList(await c.get('/api/customers', { withBalances: 'true', includeInactive: a.include_inactive ? 'true' : undefined }), 'customers');
      const rows = raw.map((r) => ({
        id: r.id, name: r.displayName, company: r.companyName ?? null, email: r.email ?? null, phone: r.phone ?? null,
        terms: r.terms ?? null, balance: r.balance ?? null, ...(r.parentId ? { parent_id: r.parentId } : {}), active: r.isActive !== false,
      }));
      return capped(filterText(rows, a.search, ['name', 'company', 'email']), a.max_rows, 'customers', 'Use search to narrow it.');
    },
  },
  {
    name: 'list_vendors',
    title: 'Vendors',
    description:
      'The vendor list: id, name, company, email, phone, payment terms, whether the vendor gets a 1099, and the open balance owed to each. Use it to find a vendor_id, or to see who is owed money. For what is overdue, use report_ap_aging.',
    inputSchema: schema({
      search: { type: 'string', maxLength: 100, description: 'Only vendors whose name, company or email contains this text.' },
      include_inactive: { type: 'boolean', description: 'Also list inactive vendors (default false).' },
      max_rows: MAX_ROWS,
    }),
    handler: async (a, c) => {
      const raw = asList(await c.get('/api/vendors', { withBalances: 'true', includeInactive: a.include_inactive ? 'true' : undefined }), 'vendors');
      const rows = raw.map((r) => ({
        id: r.id, name: r.displayName, company: r.companyName ?? null, email: r.email ?? null, phone: r.phone ?? null,
        terms: r.terms ?? null, eligible_1099: r.is1099 === true, balance: r.balance ?? null, active: r.isActive !== false,
      }));
      return capped(filterText(rows, a.search, ['name', 'company', 'email']), a.max_rows, 'vendors', 'Use search to narrow it.');
    },
  },
  {
    name: 'list_items',
    title: 'Items',
    description:
      'The item list (what the company sells and buys): id, name, type (service, inventory, non_inventory, other_charge, discount, sales_tax…), description, sales price, cost, and quantity on hand for inventory items.',
    inputSchema: schema({
      search: { type: 'string', maxLength: 100, description: 'Only items whose name contains this text.' },
      type: { type: 'string', enum: ['service', 'inventory', 'non_inventory', 'bundle', 'other_charge', 'discount', 'subtotal', 'payment', 'sales_tax'], description: 'Only items of this type.' },
      include_inactive: { type: 'boolean', description: 'Also list inactive items (default false).' },
      max_rows: MAX_ROWS,
    }),
    handler: async (a, c) => {
      const raw = asList(await c.get('/api/items', { includeInactive: a.include_inactive ? 'true' : undefined, type: a.type, search: a.search }), 'items');
      const rows = raw.map((r) => ({
        id: r.id, name: r.name, type: r.type, description: r.description ?? null, sales_price: r.salesPrice ?? null, cost: r.purchaseCost ?? null,
        ...(r.type === 'inventory' ? { quantity_on_hand: r.quantityOnHand ?? null } : {}), active: r.isActive !== false,
      }));
      return capped(rows, a.max_rows, 'items', 'Use search or type to narrow it.');
    },
  },
  {
    name: 'list_classes',
    title: 'Classes',
    description: 'The class list (how the company tags income and expenses by department, location or line of business): id and name of each active class. Use it to find a class_id for report filters.',
    inputSchema: schema({}),
    handler: async (_a, c) => {
      const rows = asList(await c.get('/api/classes'), 'classes').map((r) => ({ id: r.id, name: r.name, ...(r.parentId ? { parent_id: r.parentId } : {}) }));
      return { count: rows.length, classes: rows };
    },
  },
  {
    name: 'list_employees',
    title: 'Employees',
    description: 'The employee list: id, name, email, pay type and whether each is active. Social Security numbers are never shown in full. Needs a role that can see payroll.',
    inputSchema: schema({
      include_inactive: { type: 'boolean', description: 'Also list employees who have left (default false).' },
    }),
    handler: async (a, c) => {
      const rows = asList(await c.get('/api/employees', { includeInactive: a.include_inactive ? 'true' : undefined }), 'employees').map((r) => ({
        id: r.id, name: [r.firstName, r.lastName].filter(Boolean).join(' '), email: r.email ?? null, pay_type: r.payType ?? null,
        ...(r.ssnLast4 ? { ssn_last4: r.ssnLast4 } : {}), active: r.isActive !== false,
      }));
      return { count: rows.length, employees: rows };
    },
  },
  {
    name: 'list_other',
    title: 'Other lists',
    description:
      'One of the smaller lists a bookkeeper picks from: payment terms ("terms"), payment methods, sales tax codes, sales tax items (the rates charged, with their agency), other names, ship via, job types, customer messages, vehicles.',
    inputSchema: schema({
      list: { type: 'string', enum: OTHER_LISTS, description: 'Which list.' },
      include_inactive: { type: 'boolean', description: 'Also list inactive entries (default false).' },
    }, ['list']),
    handler: async (a, c) => {
      const q = { includeInactive: a.include_inactive ? 'true' : undefined };
      if (a.list === 'sales-tax-items') {
        const rows = asList(await c.get('/api/tax-rates', q), 'rates').map((r) => ({ id: r.id, name: r.name, rate: r.rate, agency_id: r.agencyId ?? null, active: r.isActive !== false }));
        return { list: a.list, count: rows.length, note: 'rate is a fraction: 0.0825 means 8.25%.', entries: rows };
      }
      const rows = asList(await c.get(`/api/lists/${a.list}`, q), 'entries').map((r) => {
        const { companyId: _c, createdAt: _ca, updatedAt: _u, editedAt: _e, isActive, ...rest } = r;
        return { ...rest, active: isActive !== false };
      });
      return { list: a.list, count: rows.length, entries: rows };
    },
  },
  {
    name: 'search',
    title: 'Quick search',
    description:
      'Look something up by a few words or a number when you do not know what kind of record it is: finds customers, vendors, items, accounts, employees and documents (invoices, bills, payments, journal entries, estimates, sales and purchase orders…) and returns each match with its kind and id. For transactions by amount, date or account, use find_transactions.',
    inputSchema: schema({ query: { type: 'string', maxLength: 200, description: 'Words or a number to look for.' } }, ['query']),
    handler: async (a, c) => {
      const rows = asList(await c.get('/api/search', { q: a.query }), 'results').map((r) => ({ kind: r.type, label: r.label, id: r.id }));
      return { count: rows.length, results: rows };
    },
  },
  {
    name: 'find_transactions',
    title: 'Find transactions',
    description:
      'Find transactions by what you know about them: type, customer or vendor, account, dates, amount range, document number, memo text, class, or cleared status. Newest first. Each row has the type, date, number, name, memo, account and amount, and a journal_entry_id you can pass to get_journal_entry to see every line. Use this to answer "did we already enter this?" before anything is entered.',
    inputSchema: schema({
      type: { type: 'string', enum: TXN_TYPES, description: 'Only this kind of transaction.' },
      customer_id: { ...ID, description: 'Only transactions for this customer (from list_customers).' },
      vendor_id: { ...ID, description: 'Only transactions for this vendor (from list_vendors).' },
      account_id: { ...ID, description: 'Only transactions that touch this account (from list_accounts).' },
      class_id: { ...ID, description: 'Only transactions in this class (from list_classes).' },
      date_from: { ...DATE, description: 'On or after this date.' },
      date_to: { ...DATE, description: 'On or before this date.' },
      amount_min: { ...MONEY, description: 'Transaction total at least this much.' },
      amount_max: { ...MONEY, description: 'Transaction total at most this much. Set both to the same value for an exact amount.' },
      number: { type: 'string', maxLength: 100, description: 'Document number (invoice no., check no., bill ref.).' },
      memo: { type: 'string', maxLength: 200, description: 'Text in the memo or description.' },
      cleared: { type: 'string', enum: ['any', 'cleared', 'uncleared'], description: 'Bank status of the transaction.' },
      max_rows: MAX_ROWS,
    }),
    handler: async (a, c) =>
      shapeReport(
        await c.get('/api/find', {
          txnType: a.type, customerId: a.customer_id, vendorId: a.vendor_id, accountId: a.account_id, classId: a.class_id, from: a.date_from,
          to: a.date_to, amountMin: a.amount_min, amountMax: a.amount_max, number: a.number, memo: a.memo, cleared: a.cleared,
        }),
        a.max_rows,
      ),
  },
  {
    name: 'get_register',
    title: 'Account register',
    description:
      'The register of one account, as a bookkeeper sees it: every transaction in date order with its number, payee or description, the other account, the amount in or out, the running balance, and whether it is cleared or reconciled. Works for bank and credit card accounts and for any other balance sheet account. Name the account by account_id or by its number or name. Without an account, lists the accounts that have a register. Give dates, or `newest` for the latest transactions.',
    inputSchema: schema({
      account_id: { ...ID, description: 'The account (from list_accounts).' },
      account: { type: 'string', maxLength: 150, description: 'Or the account number or name, for example "1000" or "Checking".' },
      date_from: { ...DATE, description: 'On or after this date.' },
      date_to: { ...DATE, description: 'On or before this date.' },
      search: { type: 'string', maxLength: 100, description: 'Only rows whose description, number or memo contains this text.' },
      newest: { type: 'integer', minimum: 1, maximum: 500, description: 'Only the newest N transactions (default 100 when no dates are given).' },
      max_rows: MAX_ROWS,
    }),
    handler: async (a, c) => {
      if (a.account_id && a.account) throw new ToolError('Give either account_id or account, not both.');
      const accounts = asList(await c.get('/api/registers'), 'accounts');
      if (!a.account_id && !a.account) {
        return { note: 'Name an account to see its register.', count: accounts.length, accounts: accounts.map(accountRow) };
      }
      const account = a.account_id ? accounts.find((x) => x.id === a.account_id) : resolveAccount(accounts, a.account);
      if (!account) throw new ToolError('That account has no register you can open. Call get_register without an account to list the ones you can.');
      const limit = a.max_rows ?? 300;
      const dated = Boolean(a.date_from || a.date_to);
      const res = await c.get(`/api/registers/${account.id}`, {
        from: a.date_from, to: a.date_to, search: a.search, last: a.newest ?? (dated ? undefined : 100), limit: a.newest || !dated ? undefined : limit,
      });
      const reg = res?.register ?? {};
      const rows = (Array.isArray(reg.rows) ? reg.rows : []).map((r) => ({
        date: text(r.date).slice(0, 10), number: r.reference || null, description: r.description || null, memo: r.memo || null,
        other_account: r.otherAccount?.label ?? null, increase_or_debit: r.debit ?? null, decrease_or_credit: r.credit ?? null,
        balance: r.runningBalance ?? null, status: r.cleared ?? 'uncleared', journal_entry_id: r.journalEntryId,
      }));
      const out = {
        account: accountRow(reg.account ?? account),
        ...(reg.currency ? { currency: reg.currency } : {}),
        opening_balance: reg.openingBalance ?? null,
        closing_balance: reg.closingBalance ?? null,
        note: 'For a bank or asset account a debit increases the balance; for a credit card or liability account a credit increases it.',
        total_rows: reg.totalRows ?? rows.length,
        rows: rows.slice(0, limit),
      };
      if ((reg.totalRows ?? rows.length) > out.rows.length) {
        out.truncated = true;
        out.note += ` Showing ${out.rows.length} of ${reg.totalRows ?? rows.length} rows; narrow the dates or raise max_rows.`;
      }
      return out;
    },
  },
  {
    name: 'get_journal_entry',
    title: 'Journal entry lines',
    description:
      'Every debit and credit line behind one transaction: account, amount, memo, class and the customer or vendor on the line, plus the entry\'s date, number, status (posted or void) and what document it came from. Pass the journal_entry_id from get_register or find_transactions.',
    inputSchema: schema({ id: { ...ID, description: 'The journal_entry_id.' } }, ['id']),
    handler: async (a, c) => {
      const e = (await c.get(`/api/journal-entries/${a.id}`))?.entry;
      if (!e) throw new ToolError('That journal entry was not found.');
      return {
        id: e.id, number: e.entryNumber ?? null, date: text(e.date).slice(0, 10), description: e.description ?? null, reference: e.reference ?? null,
        status: e.status, source: e.sourceRef ?? null, adjusting: e.isAdjusting === true,
        lines: (Array.isArray(e.lines) ? e.lines : []).map((l) => ({
          account_id: l.accountId, account: [l.accountCode, l.accountName].filter(Boolean).join(' '), debit: l.debit ?? null, credit: l.credit ?? null,
          memo: l.memo ?? null, ...(l.className ? { class: l.className } : {}), ...(l.entityName ? { name: l.entityName, name_kind: l.entityType } : {}),
        })),
      };
    },
  },
  {
    name: 'report_profit_and_loss',
    title: 'Profit & Loss',
    description:
      'The Profit & Loss (income statement) for a period: income, cost of goods sold, expenses and net income, with sub-accounts rolled up as in the app. Choose a named period or dates; optionally one column per month, quarter or year, a comparison with the previous period or year, cash or accrual basis, or one class.',
    inputSchema: schema({
      ...PERIOD_PROPS,
      basis: BASIS,
      columns: { type: 'string', enum: ['total', 'month', 'quarter', 'year'], description: 'One total column (default) or one column per month, quarter or year.' },
      compare: { type: 'string', enum: ['none', 'prev_period', 'prev_year'], description: 'Add the previous period or the same period last year, with the change.' },
      class_id: { ...ID, description: 'Only this class.' },
      max_rows: MAX_ROWS,
    }),
    handler: async (a, c) =>
      shapeReport(await c.get('/api/reports/std/profit-loss', { ...periodQuery(a), basis: a.basis, columns: a.columns, compare: a.compare, classId: a.class_id }), a.max_rows),
  },
  {
    name: 'report_balance_sheet',
    title: 'Balance Sheet',
    description:
      'The Balance Sheet as of a date: assets, liabilities and equity, with Retained Earnings and Net Income. The answer says whether it balances. Optionally compare with the previous period or year.',
    inputSchema: schema({
      as_of: { ...DATE, description: 'The date (default today).' },
      basis: BASIS,
      compare: { type: 'string', enum: ['none', 'prev_period', 'prev_year'], description: 'Add an earlier balance sheet beside it, with the change.' },
      class_id: { ...ID, description: 'Only this class.' },
      max_rows: MAX_ROWS,
    }),
    handler: async (a, c) => shapeReport(await c.get('/api/reports/std/balance-sheet', { asOf: a.as_of, basis: a.basis, compare: a.compare, classId: a.class_id }), a.max_rows),
  },
  {
    name: 'report_trial_balance',
    title: 'Trial Balance',
    description: 'The Trial Balance as of a date: the debit or credit balance of every account, and whether total debits equal total credits. The usual starting point for checking the books or preparing adjusting entries.',
    inputSchema: schema({ as_of: { ...DATE, description: 'The date (default today).' }, basis: BASIS, max_rows: MAX_ROWS }),
    handler: async (a, c) => shapeReport(await c.get('/api/reports/std/trial-balance', { asOf: a.as_of, basis: a.basis }), a.max_rows),
  },
  {
    name: 'report_general_ledger',
    title: 'General Ledger',
    description:
      'The General Ledger for a period: for each account its beginning balance, every transaction and its ending balance. It is long; give a short period and, when you can, one account. Rows carry a journal_entry_id for get_journal_entry.',
    inputSchema: schema({
      ...PERIOD_PROPS,
      account_id: { ...ID, description: 'Only this account (from list_accounts). Recommended.' },
      customer_id: { ...ID, description: 'Only lines for this customer.' },
      vendor_id: { ...ID, description: 'Only lines for this vendor.' },
      class_id: { ...ID, description: 'Only this class.' },
      basis: BASIS,
      max_rows: MAX_ROWS,
    }),
    handler: async (a, c) =>
      shapeReport(
        await c.get('/api/reports/std/general-ledger', { ...periodQuery(a), accountId: a.account_id, customerId: a.customer_id, vendorId: a.vendor_id, classId: a.class_id, basis: a.basis }),
        a.max_rows,
      ),
  },
  {
    name: 'report_ar_aging',
    title: 'A/R Aging',
    description:
      'Accounts receivable aging as of a date: what each customer owes, split by how many days past due (current, 1-30, 31-60, 61-90, over 90). With detail, lists each open invoice and credit instead of one line per customer. The total ties to Accounts Receivable on the balance sheet.',
    inputSchema: schema({
      as_of: { ...DATE, description: 'The date (default today).' },
      detail: { type: 'boolean', description: 'List every open invoice and credit (default false: one line per customer).' },
      customer_id: { ...ID, description: 'Only this customer.' },
      days_per_column: { type: 'integer', minimum: 1, maximum: 365, description: 'Width of each aging column in days (default 30).' },
      max_rows: MAX_ROWS,
    }),
    handler: async (a, c) =>
      shapeReport(await c.get(`/api/reports/std/${a.detail ? 'ar-aging-detail' : 'ar-aging-summary'}`, { asOf: a.as_of, customerId: a.customer_id, interval: a.days_per_column }), a.max_rows),
  },
  {
    name: 'report_ap_aging',
    title: 'A/P Aging',
    description:
      'Accounts payable aging as of a date: what the company owes each vendor, split by how many days past due. With detail, lists each open bill and credit instead of one line per vendor. The total ties to Accounts Payable on the balance sheet.',
    inputSchema: schema({
      as_of: { ...DATE, description: 'The date (default today).' },
      detail: { type: 'boolean', description: 'List every open bill and credit (default false: one line per vendor).' },
      vendor_id: { ...ID, description: 'Only this vendor.' },
      days_per_column: { type: 'integer', minimum: 1, maximum: 365, description: 'Width of each aging column in days (default 30).' },
      max_rows: MAX_ROWS,
    }),
    handler: async (a, c) =>
      shapeReport(await c.get(`/api/reports/std/${a.detail ? 'ap-aging-detail' : 'ap-aging-summary'}`, { asOf: a.as_of, vendorId: a.vendor_id, interval: a.days_per_column }), a.max_rows),
  },
];

const isObject = (/** @type {unknown} */ v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Where the generic door's tools read one request by id (operations-tools.mjs getRequest). */
const REQUEST_PATH = '/api/agent/requests/';

/** One stand-in per client (collectingClient), so what operations-tools keeps per client stays together. */
const collecting = new WeakMap();

/**
 * The client the generic door's tools are given. It makes an approved report read compact as the
 * answer arrives, before operations-tools.mjs holds the answer to the connector's size limit
 * (holdToLimit): the limit is then spent on the compact rows, so the agent sees as many rows as
 * run_report shows for the same report, and row_count stays the report's own. Two answers are
 * touched: a request read by id (wait_for_decision, the request's resource) and run_operation sent
 * again with the request id it was asked under (the door's answer then says `replayed`); only a
 * report or drill-down result in them changes (report-tools.mjs compactCollected). Everything else
 * goes to the client and comes back as it is. The same stand-in is given for one client every time:
 * operations-tools keeps an operation's confirm flags per client (describe_operation, then
 * run_operation), and they must meet.
 * @param {any} client
 */
function collectingClient(client) {
  if (!client || typeof client !== 'object') return client;
  let stand = collecting.get(client);
  if (stand) return stand;
  // A Proxy over an empty object, not over the client itself: its methods run on the client (state
  // such as noteRequest's stays there), and a frozen client still works.
  stand = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'get' && typeof client.get === 'function') {
          return async (/** @type {unknown} */ path, /** @type {unknown[]} */ ...rest) => {
            const res = await client.get(path, ...rest);
            if (typeof path !== 'string' || !path.startsWith(REQUEST_PATH) || !isObject(res) || !isObject(res.request)) return res;
            const request = compactCollected(res.request);
            return request === res.request ? res : { ...res, request };
          };
        }
        if (prop === 'act' && typeof client.act === 'function') {
          return async (/** @type {any} */ request) => {
            const answer = await client.act(request);
            return request?.verb === 'run_operation' && isObject(answer) && answer.replayed === true ? compactCollected(answer, request.operation) : answer;
          };
        }
        const v = client[prop];
        return typeof v === 'function' ? v.bind(client) : v;
      },
      has: (_t, prop) => prop in client,
    },
  );
  collecting.set(client, stand);
  return stand;
}

/**
 * A report read a person approved (asked for with run_operation, as run_report and report_drilldown
 * advise when reports are set to Ask) comes back in the shape those tools give, wherever the agent
 * collects it: wait_for_decision, run_operation sent again with the request id it was asked under
 * (its answer then says `repeated`), and the request's resource (collectedContents, below). It is
 * made compact before the answer is held to its size limit (collectingClient); after that,
 * compactCollected runs again to say inside the result what the limit cut, if anything. A read
 * run_operation does at once keeps the app's own shape, as everything run_operation answers does.
 * Anything else these tools answer passes as it is (compactCollected changes only a report or
 * drill-down result).
 * @param {import('./protocol.mjs').Tool} tool
 * @returns {import('./protocol.mjs').Tool}
 */
function collectingReads(tool) {
  /** @type {import('./protocol.mjs').Tool['handler']} */
  const handler = (a, c, s) => tool.handler(a, collectingClient(c), s);
  if (tool.name === 'wait_for_decision') {
    return { ...tool, handler: async (a, c, s) => compactCollected(await handler(a, c, s)) };
  }
  if (tool.name === 'run_operation') {
    return {
      ...tool,
      handler: async (a, c, s) => {
        const out = await handler(a, c, s);
        return out && typeof out === 'object' && /** @type {any} */ (out).repeated === true ? compactCollected(out, a.operation) : out;
      },
    };
  }
  return { ...tool, handler };
}

/**
 * Every tool: the reads (with every standard report, report-tools.mjs), the tools that change the
 * books (write-tools.mjs, banking-tools.mjs, and entry-tools.mjs over the generic door), then the
 * generic door to every other operation (operations-tools.mjs) and files (files-tools.mjs).
 * About 80 tools: clients slow down and models choose badly past about 100 (plan §6), so anything
 * else is one find_operations away rather than a tool of its own.
 * @type {import('./protocol.mjs').Tool[]}
 */
export const TOOLS = [
  ...READ_TOOLS,
  ...WRITE_READ_TOOLS,
  ...BANKING_READ_TOOLS,
  ...REPORT_TOOLS,
  ...WRITE_TOOLS,
  ...BANKING_WRITE_TOOLS,
  ...ENTRY_TOOLS,
  ...OPERATION_TOOLS.map(collectingReads),
  ...FILE_TOOLS,
];

export const INSTRUCTIONS = [
  'Ironbooks is a desktop accounting system (a double-entry ledger, like QuickBooks Desktop). These tools work in one company\'s books. The full guide is the resource ironbooks://guide (also the prompt ironbooks_guide): read it before your first change.',
  'Start with get_company_info (which company, the closing date, who you are) and get_my_permissions (what you may do on your own, what a person must approve, what is not allowed).',
  'Before entering anything, look: use find_transactions or search to make sure it is not already there, and list_accounts, list_customers or list_vendors for the ids you need.',
  'Every standard report (about 100) is list_reports, then run_report; report_drilldown lists the transactions behind an amount, and export_report makes the report a PDF or Excel file.',
  'The named tools cover everyday bookkeeping: invoices, bills, payments, checks, deposits, estimates, purchase orders, receiving items, credit memos, vendor credits, time, inventory adjustments, sales tax, bank statements and reconciling. For anything else (1099s, paystubs, the audit trail, emailing a form, budgets …), find_operations, then describe_operation, then run_operation: every operation a person can do in Ironbooks has an id.',
  'Every tool that changes the books takes dry_run, request_id and reason. dry_run true checks the change and shows what it would post, without keeping anything: use it whenever you are not sure. request_id is your own name for one change; asking again with the same request_id never does it twice, so repeat a request with the SAME request_id after a timeout, and use a NEW one for each new change. reason is one plain sentence saying why you want it: a person who must approve it reads it on the approval card.',
  'When an answer says "asked", a person must approve it in Ironbooks: call wait_for_decision with its request_id, and do not send it again. "needs_confirmation" is a warning a person would have been asked about: go ahead only if it is right, as the answer says. "Refused" means stop.',
  'When you edit, void or make something inactive, send the updated_at you read (get_transaction; for an account or an item, its edited_at) as expected_updated_at. A 409 (conflict) then means someone changed the record after you read it, and nothing was changed: read it again and make your change on what it says now.',
  'The named tools never delete: a mistake is voided (void_transaction) or corrected (edit_transaction). Deleting for good, closed-period work and settings always need a person; sending anything outside this computer does too, unless a person gave you a short standing permission for it. Dates are YYYY-MM-DD and amounts are text with two decimals ("1250.00").',
  'Never ask the person for a password, code or key, and never send one: when an operation needs one, the person types it on their own screen.',
  'If a tool says Ironbooks is not ready, the person needs to open the company file in Ironbooks and sign in. If Ironbooks stops answering, it may be restarting: wait a minute, then read what you need again.',
].join(' ');

/**
 * One request read as a resource, with an approved report read in run_report's shape, as
 * wait_for_decision gives it (collectingReads: made compact as it arrives, then what the size
 * limit cut said inside the result). A text that is not JSON passes as it is.
 * @param {Array<{ uri: string, mimeType?: string, text?: string }> | null} contents
 */
function collectedContents(contents) {
  if (!Array.isArray(contents)) return contents;
  return contents.map((part) => {
    if (typeof part?.text !== 'string') return part;
    let request;
    try {
      request = JSON.parse(part.text);
    } catch {
      return part;
    }
    const shaped = compactCollected(request);
    return shaped === request ? part : { ...part, text: JSON.stringify(shaped) };
  });
}

/** The resources this server serves: the guide, and (by template) the agent's requests and files. */
export const RESOURCES = {
  list: () => [GUIDE_RESOURCE],
  templates: () => [REQUEST_TEMPLATE, FILE_TEMPLATE],
  /** @param {string} uri @param {any} client */
  read: async (uri, client) => {
    if (uri === GUIDE_URI) return guideContents();
    if (uri.startsWith(REQUEST_URI_PREFIX)) return collectedContents(await readRequestResource(uri, collectingClient(client)));
    if (uri.startsWith(FILE_URI_PREFIX)) return readFileResource(uri, client);
    return null;
  },
};

/** The prompts this server serves: the guide. */
export const PROMPTS = {
  list: () => [GUIDE_PROMPT],
  /** @param {string} name */
  get: (name) => (name === GUIDE_PROMPT_NAME ? guidePrompt() : null),
};
