/**
 * Runtime smoke crawl of the REAL production (standalone) server.
 *
 *  1. Spawns .next/standalone/server.js on a throwaway data dir (own port, default 3998).
 *  2. Signs up, unlocks, completes company setup and seeds a rich company through the HTTP API.
 *  3. GETs every page route (app/**\/page.tsx) with the session cookie; flags >= 500, hangs and
 *     streamed server-component errors (React error digests / Next error page markers).
 *  4. Calls every API route (app/api/**\/route.ts): GET bare, GET with realistic query params,
 *     GET with garbage query params; then POST/PUT/PATCH/DELETE with {} and invalid bodies.
 *     Anything >= 500 (or a hang) is a finding. Destructive whole-file routes are skipped or only
 *     hit with a body that must fail validation.
 *  5. Scans the server's stdout/stderr for unhandled errors and attributes them to the request
 *     that was in flight (requests are sequential).
 *
 * Usage:   npm run test:crawl   (= node scripts/crawl.mjs; needs a current `next build`)
 * Env:     CRAWL_PORT (3998) · CRAWL_TIMEOUT_MS (45000 per request; slower = hang)
 *          CRAWL_ONLY=pages|api|seed (limit phases) · CRAWL_KEEP=1 (keep the temp root)
 *
 * Isolation: everything the crawl and the server write — company file, backups, report exports,
 * sandboxes, the server's own temp files, results.json and server.log — lives in ONE private temp
 * root (os tmpdir/bka-crawl-XXXX). The server runs with BKA_NETWORK_MODE=offline (no email, bank
 * feeds or AI calls). The root is removed at the end, unless CRAWL_KEEP=1 or the run failed (then
 * its path is printed so results.json can be inspected).
 *
 * Exit code: 1 when any ERROR was found — HTTP >= 500, a hang, a dropped connection, a malformed
 * JSON response, a streamed server-component error or the server process dying. Warnings
 * (slow responses, suspicious values, closed-period postings that were accepted, unexpected
 * redirects) are printed but do not fail the run. Exit 2 when there is no build.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = process.env.CRAWL_PORT || '3998';
const BASE = `http://127.0.0.1:${PORT}`;
const root = process.cwd();
const TIMEOUT = Number(process.env.CRAWL_TIMEOUT_MS || 45000);
const ONLY = process.env.CRAWL_ONLY || '';

if (!existsSync(path.join(root, '.next', 'standalone', 'server.js'))) {
  console.error('No standalone build at .next/standalone/server.js: run `next build` first.');
  process.exit(2);
}

// One private temp root for everything (see the header). The server also writes NEXT TO its data
// dir (backups, Report Exports, sandboxes) and to os.tmpdir(), so all of those are pinned inside.
const tempRoot = mkdtempSync(path.join(tmpdir(), 'bka-crawl-'));
const dataDir = path.join(tempRoot, 'company');
const serverTmp = path.join(tempRoot, 'tmp');
for (const d of [dataDir, serverTmp]) mkdirSync(d, { recursive: true });
const OUT = tempRoot;

// A build older than the sources crawls stale code: say so (not a failure).
function newestMtime(dir) {
  let newest = 0;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const f = path.join(dir, e);
    const st = statSync(f);
    newest = Math.max(newest, st.isDirectory() ? newestMtime(f) : st.mtimeMs);
  }
  return newest;
}
try {
  const built = statSync(path.join(root, '.next', 'BUILD_ID')).mtimeMs;
  const src = Math.max(...['app', 'lib', 'components'].map((d) => newestMtime(path.join(root, d))), statSync(path.join(root, 'middleware.ts')).mtimeMs);
  if (src > built) console.warn('WARNING: source files are newer than .next/BUILD_ID — the crawl runs the last build, not the current code.');
} catch {}

// ---------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------
const cookies = {};
const findings = []; // { phase, method, url, status, ms, note, body, log }
const seedLog = []; // { step, status, error }
const stats = { pages: 0, pageUrls: 0, apiRoutes: 0, apiCalls: 0 };
let current = null; // label of the request in flight (for server-log attribution)
const serverLines = []; // { t, line, during }

function cookieHeader() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * One request. body: undefined → none; string → sent raw; otherwise JSON. Returns
 * { status, data, text, ms, headers, hang }.
 */
async function call(method, p, body, opts = {}) {
  const url = BASE + p;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeout ?? TIMEOUT);
  const t0 = Date.now();
  current = `${method} ${p}`;
  const logMark = serverLines.length;
  try {
    const headers = { cookie: cookieHeader(), ...(opts.headers || {}) };
    let payload;
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    }
    const res = await fetch(url, { method, headers, body: payload, redirect: 'manual', signal: ctl.signal });
    for (const [k, v] of res.headers) {
      if (k.toLowerCase() === 'set-cookie' && !opts.noCookies) {
        const m = /^([^=]+)=([^;]*)/.exec(v);
        if (m) {
          if (m[2] === '' || /max-age=0/i.test(v) || /expires=thu, 01 jan 1970/i.test(v)) delete cookies[m[1]];
          else cookies[m[1]] = m[2];
        }
      }
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') || '';
    const text = /json|text|html|xml|csv|javascript/.test(ct) || !ct ? buf.toString('utf8') : '';
    let data = null;
    if (/json/.test(ct)) {
      try { data = text ? JSON.parse(text) : null; } catch { data = Symbol.for('malformed-json'); }
    } else data = text;
    return { status: res.status, data, text, ms: Date.now() - t0, headers: res.headers, ct, bytes: buf.length, logMark };
  } catch (e) {
    const hang = e?.name === 'AbortError';
    return { status: hang ? 'HANG' : 'NETERR', data: null, text: String(e?.message || e), ms: Date.now() - t0, headers: new Headers(), ct: '', bytes: 0, hang, logMark };
  } finally {
    clearTimeout(timer);
    current = null;
  }
}

function logSince(mark) {
  return serverLines.slice(mark).map((l) => l.line).join('\n').slice(0, 4000);
}

// Notes that make a finding an ERROR even without a 5xx status (streamed SSR errors etc.).
const ERROR_NOTE = /malformed JSON|streamed error|RSC error|Application error|__next_error__|Internal Server Error|server logged/;
function record(phase, method, p, r, note, sentBody) {
  const body = typeof r.data === 'symbol' ? '(malformed JSON) ' + String(r.text).slice(0, 300)
    : typeof r.text === 'string' ? r.text.slice(0, 600) : '';
  const severity = !phase.endsWith('-accepted') && (isBad(r) || ERROR_NOTE.test(note)) ? 'error' : 'warn';
  findings.push({ severity, phase, method, url: p, status: r.status, ms: r.ms, note, sent: sentBody === undefined ? undefined : (typeof sentBody === 'string' ? sentBody : JSON.stringify(sentBody)).slice(0, 300), body, log: logSince(r.logMark) });
}

const isBad = (r) => r.status === 'HANG' || r.status === 'NETERR' || (typeof r.status === 'number' && r.status >= 500);

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------
const server = spawn(process.execPath, [path.join(root, '.next', 'standalone', 'server.js')], {
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BKA_'))),
    NODE_ENV: 'production',
    PORT,
    HOSTNAME: '127.0.0.1',
    BKA_DATA_DIR: dataDir,
    BKA_MIGRATIONS_DIR: path.join(root, 'drizzle'),
    BKA_AUTH_SECRET: 'crawl-secret',
    BKA_BACKUP_DIR: path.join(tempRoot, 'backups'),
    BKA_REPORT_EXPORT_DIR: path.join(tempRoot, 'exports'),
    BKA_SANDBOX_ROOT: path.join(tempRoot, 'sandboxes'),
    BKA_NETWORK_MODE: 'offline',
    TMP: serverTmp,
    TEMP: serverTmp,
    TMPDIR: serverTmp,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverExited = null;
server.on('exit', (code, sig) => { serverExited = { code, sig }; });
for (const stream of [server.stdout, server.stderr]) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      serverLines.push({ t: Date.now(), line, during: current });
    }
  });
}

async function waitUp() {
  for (let i = 0; i < 120; i++) {
    if (serverExited) return false;
    try {
      const r = await fetch(`${BASE}/api/auth/me`);
      if (r.status) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------------------------
const S = {}; // seeded ids by key
const extract = (d) => {
  if (!d || typeof d !== 'object') return null;
  if (d.id) return d;
  for (const k of Object.keys(d)) if (d[k] && typeof d[k] === 'object' && !Array.isArray(d[k]) && d[k].id) return d[k];
  return null;
};
async function step(name, method, p, body, key) {
  const r = await call(method, p, body);
  const ok = typeof r.status === 'number' && r.status < 300;
  const row = ok ? extract(r.data) : null;
  if (key && row?.id) S[key] = row.id;
  const err = ok ? '' : (r.data && typeof r.data === 'object' ? (r.data.error || JSON.stringify(r.data)) : String(r.text).slice(0, 200));
  seedLog.push({ step: name, status: r.status, error: err ? String(err).slice(0, 300) : undefined });
  if (!ok) console.log(`  seed ✗ ${name}: HTTP ${r.status} ${String(err).slice(0, 200)}`);
  if (isBad(r)) record('seed', method, p, r, `seed step "${name}"`, body);
  return { ...r, row, ok };
}
const listOf = (d) => {
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') {
    for (const k of ['rows', 'items', 'data', 'results', 'list', 'records', 'entries', 'transactions']) if (Array.isArray(d[k])) return d[k];
    for (const v of Object.values(d)) if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && v[0].id) return v;
  }
  return [];
};

// ---------------------------------------------------------------------------------------------
// Seed: a rich company through the HTTP API
// ---------------------------------------------------------------------------------------------
const CLOSED_THROUGH = '2026-01-31';
const CLOSED_DOCS = []; // [name, collection path, id] dated inside the closed period
async function seed() {
  console.log('\nSEED');
  await step('unlock', 'POST', '/api/unlock', {});
  creds = { email: 'crawl@test.local', password: 'Crawl-secret-123!' };
  const su = await step('signup', 'POST', '/api/auth/signup', { name: 'Crawler', email: creds.email, password: creds.password, companyName: 'Crawl Co' });
  S.companyId = su.data?.companyId;
  const me = await call('GET', '/api/auth/me');
  if (me.data?.id) S.userId = me.data.id;
  await step('setup interview', 'POST', '/api/company/setup-interview', {
    businessType: 'product', entityType: 'sole_prop', fiscalYearStartMonth: 1, startDate: '2026-01-01', reportBasis: 'accrual',
    salesTax: true, inventory: true, employees: true, estimates: true, progressInvoicing: true, timeTracking: true,
    classTracking: true, multiCurrency: true, currency: 'USD',
    company: { name: 'Crawl Co', legalName: 'Crawl Co LLC', ein: '12-3456789', addressLine1: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', country: 'US', phone: '555-0100', email: 'crawl@test.local' },
  });
  await step('enable features', 'PATCH', '/api/company', { settings: {
    multiCurrencyEnabled: true, inventoryEnabled: true, salesTaxEnabled: true, classTrackingEnabled: true, priceLevelsEnabled: true,
    estimatesEnabled: true, salesOrdersEnabled: true,
  } });

  const accts = listOf((await call('GET', '/api/accounts')).data);
  const A = (code) => accts.find((a) => a.code === code)?.id;
  Object.assign(S, { bank: A('1000'), savings: A('1010'), uf: A('1050'), ar: A('1200'), invAsset: A('1300'), fa: A('1500'), ap: A('2000'),
    cc: A('2100'), stp: A('2200'), payLiab: A('2300'), equity: A('3000'), income: A('4000'), svcIncome: A('4100'), otherIncome: A('4900'),
    cogs: A('5000'), adv: A('6000'), bankFees: A('6100'), rent: A('6400'), payrollExp: A('6500') });
  await step('long-term liability account', 'POST', '/api/accounts', { code: '2700', name: 'Truck Loan', type: 'liability', subtype: 'long_term_liability' }, 'ltl');
  await step('sub-account', 'POST', '/api/accounts', { code: '6410', name: 'Rent - Warehouse', type: 'expense', subtype: 'operating_expenses', parentId: S.rent }, 'subAcct');

  // Lists / dimensions
  await step('class', 'POST', '/api/classes', { name: 'East' }, 'class');
  await step('class 2', 'POST', '/api/classes', { name: 'West' }, 'class2');
  await step('sales rep', 'POST', '/api/sales-reps', { name: 'Jane Rep', email: 'jane@x.com', commissionRate: '0.05' }, 'rep');
  await step('tax agency', 'POST', '/api/tax-agencies', { name: 'TX Comptroller', liabilityAccountId: S.stp }, 'taxAgency');
  await step('tax rate', 'POST', '/api/tax-rates', { name: 'TX 8.25%', rate: '0.0825', agencyId: S.taxAgency }, 'taxRate');
  await step('tax group', 'POST', '/api/tax-rates', { name: 'Austin combined', rate: '0', agencyId: S.taxAgency }, 'taxGroup');
  if (S.taxGroup) await step('tax group components', 'PATCH', `/api/tax-rates/${S.taxGroup}/components`, { components: [{ name: 'State', rate: '0.0625', agencyId: S.taxAgency }, { name: 'City', rate: '0.02' }] });
  await step('site A', 'POST', '/api/inventory-sites', { name: 'Main Warehouse', code: 'MW', isDefault: false }, 'site');
  await step('site B', 'POST', '/api/inventory-sites', { name: 'Store', code: 'ST', isDefault: false }, 'site2');
  await step('price level', 'POST', '/api/pricing/levels', { name: 'Wholesale', type: 'fixed_percent', percent: '-10', rounding: 'none' }, 'priceLevel');

  // Names
  await step('customer', 'POST', '/api/customers', { displayName: 'Acme Corp', companyName: 'Acme Inc', email: 'ap@acme.test', phone: '555-0101',
    billingAddress: { line1: '2 Elm', city: 'Austin', state: 'TX', zip: '78702', country: 'US' }, terms: 'net_30', creditLimit: '50000.00', taxable: true, taxRateId: S.taxRate }, 'customer');
  await step('customer 2', 'POST', '/api/customers', { displayName: 'Beta LLC', email: 'beta@x.test', priceLevelId: S.priceLevel }, 'customer2');
  await step('sub-customer', 'POST', '/api/customers', { displayName: 'Plant 2', parentId: S.customer }, 'subCustomer');
  await step('EUR customer', 'POST', '/api/customers', { displayName: 'Euro GmbH', email: 'eu@x.test' }, 'eurCustomer');
  await step('job', 'POST', '/api/jobs', { name: 'Remodel', customerId: S.customer, budget: '10000', startDate: '2026-02-01' }, 'job');
  await step('vendor', 'POST', '/api/vendors', { displayName: 'Supply Co', companyName: 'Supply Co LLC', email: 'ar@supply.test', terms: 'net_30', is1099: true, taxId: '98-7654321', defaultExpenseAccountId: S.rent }, 'vendor');
  await step('vendor 2', 'POST', '/api/vendors', { displayName: 'Landlord Inc' }, 'vendor2');

  // Items
  const item = async (name, body, key) => step(`item ${name}`, 'POST', '/api/items', { name, ...body }, key);
  await item('Consulting', { type: 'service', salesPrice: '150.00', incomeAccountId: S.svcIncome, taxable: false }, 'svcItem');
  await item('Widget', { type: 'inventory', sku: 'W1', salesPrice: '25.00', purchaseCost: '10.00', incomeAccountId: S.income, expenseAccountId: S.cogs, assetAccountId: S.invAsset, taxable: true, reorderPoint: '5', openingQuantity: '100', openingUnitCost: '10', openingAsOf: '2026-02-01' }, 'invItem');
  await item('Gadget', { type: 'inventory', sku: 'G1', salesPrice: '40.00', purchaseCost: '15.00', incomeAccountId: S.income, expenseAccountId: S.cogs, assetAccountId: S.invAsset, openingQuantity: '50', openingUnitCost: '15', openingAsOf: '2026-02-01' }, 'invItem2');
  await item('Widget Kit', { type: 'inventory', sku: 'KIT1', salesPrice: '90.00', purchaseCost: '0', incomeAccountId: S.income, expenseAccountId: S.cogs, assetAccountId: S.invAsset }, 'assembly');
  await item('Bolt', { type: 'inventory', sku: 'B1', salesPrice: '1.00', purchaseCost: '0.20', incomeAccountId: S.income, expenseAccountId: S.cogs, assetAccountId: S.invAsset }, 'avgItem');
  await item('Nut', { type: 'inventory', sku: 'N1', salesPrice: '0.50', purchaseCost: '0.10', incomeAccountId: S.income, expenseAccountId: S.cogs, assetAccountId: S.invAsset }, 'avgItem2');
  await step('stock avg-cost components', 'POST', '/api/bills', { vendorId: S.vendor, billNumber: 'STOCK-1', date: '2026-02-05', lines: [{ itemId: S.avgItem, quantity: '200', unitCost: '0.20' }, { itemId: S.avgItem2, quantity: '300', unitCost: '0.10' }] }, 'stockBill');
  await item('Packaging', { type: 'non_inventory', salesPrice: '2.00', purchaseCost: '1.00', incomeAccountId: S.income, expenseAccountId: S.adv }, 'nonInv');
  await item('Delivery', { type: 'other_charge', salesPrice: '20.00', incomeAccountId: S.otherIncome }, 'otherCharge');
  await item('Loyalty Discount', { type: 'discount', salesPrice: '5.00', incomeAccountId: S.income }, 'discountItem');
  await item('Subtotal', { type: 'subtotal' }, 'subtotalItem');
  await item('Deposit Received', { type: 'payment' }, 'paymentItem');
  await item('Out of state tax', { type: 'sales_tax', salesPrice: '0.05' }, 'salesTaxItem');
  await item('Starter Bundle', { type: 'bundle', salesPrice: '60.00' }, 'bundle');
  if (S.assembly && S.avgItem && S.avgItem2) {
    await step('assembly BOM', 'PUT', '/api/assemblies', { assemblyItemId: S.assembly, components: [{ componentItemId: S.avgItem, quantity: '4' }, { componentItemId: S.avgItem2, quantity: '4' }] });
    await step('assembly build', 'POST', '/api/assemblies/build', { assemblyItemId: S.assembly, quantity: '5', action: 'build', date: '2026-02-10' });
  }
  if (S.bundle && S.svcItem && S.invItem) await step('bundle components', 'PUT', '/api/assemblies', { assemblyItemId: S.bundle, components: [{ componentItemId: S.invItem, quantity: '1' }, { componentItemId: S.svcItem, quantity: '1' }] });
  await step('customer price', 'POST', '/api/customer-prices', { customerId: S.customer, itemId: S.invItem, price: '22.50' });

  // Multi-currency
  await step('base currency', 'POST', '/api/currencies', { code: 'USD', name: 'US Dollar', isBase: true });
  await step('EUR currency', 'POST', '/api/currencies', { code: 'EUR', name: 'Euro', rateToBase: '1.10' }, 'eur');

  // Sales
  const inv = await step('invoice', 'POST', '/api/invoices', { customerId: S.customer, date: '2026-03-01', dueDate: '2026-03-31', terms: 'net_30', taxRateId: S.taxRate, classId: S.class, jobId: S.job, salesRepId: S.rep, memo: 'crawl',
    lines: [
      { itemId: S.invItem, description: 'Widget', quantity: '4', rate: '25.00', taxable: true },
      { itemId: S.svcItem, description: 'Consulting', quantity: '2', rate: '150.00', taxable: false },
      { itemId: S.subtotalItem, quantity: '1' },
      { itemId: S.discountItem, quantity: '1', rate: '-5.00' },
      { accountId: S.otherIncome, description: 'Misc', quantity: '1', rate: '10' },
    ] }, 'invoice');
  if (!inv.ok) await step('invoice (simple)', 'POST', '/api/invoices', { customerId: S.customer, date: '2026-03-01', lines: [{ itemId: S.invItem, quantity: '4', rate: '25.00' }, { accountId: S.svcIncome, quantity: '1', rate: '300' }] }, 'invoice');
  const invRow = S.invoice ? (await call('GET', `/api/invoices/${S.invoice}`)).data : null;
  await step('invoice 2 (open)', 'POST', '/api/invoices', { customerId: S.customer2, date: '2026-04-01', lines: [{ itemId: S.svcItem, quantity: '10', rate: '150' }] }, 'invoice2');
  await step('invoice 3 (retainage)', 'POST', '/api/invoices', { customerId: S.customer, date: '2026-05-01', retainagePercent: '10', lines: [{ itemId: S.svcItem, quantity: '5', rate: '150' }] }, 'invoice3');
  await step('EUR invoice', 'POST', '/api/invoices', { customerId: S.eurCustomer, date: '2026-03-15', currency: 'EUR', exchangeRate: '1.10', lines: [{ itemId: S.svcItem, quantity: '3', rate: '100' }] }, 'eurInvoice');
  const invTotal = invRow?.balanceDue || invRow?.total || '420.00';
  const pay = await step('payment', 'POST', '/api/payments', { customerId: S.customer, date: '2026-03-05', method: 'check', reference: '1234', amount: invTotal, applications: S.invoice ? [{ invoiceId: S.invoice, amountApplied: invTotal }] : [] });
  if (pay.data?.payment?.id) S.payment = pay.data.payment.id;
  const pay2 = await step('partial payment', 'POST', '/api/payments', { customerId: S.customer2, date: '2026-04-10', method: 'ach', amount: '500.00', applications: S.invoice2 ? [{ invoiceId: S.invoice2, amountApplied: '500.00' }] : [] });
  if (pay2.data?.payment?.id) S.payment2 = pay2.data.payment.id;
  const eurPay = await step('EUR payment', 'POST', '/api/payments', { customerId: S.eurCustomer, date: '2026-03-20', method: 'bank_transfer', amount: '100.00', currency: 'EUR', exchangeRate: '1.12', applications: S.eurInvoice ? [{ invoiceId: S.eurInvoice, amountApplied: '100.00' }] : [] });
  if (eurPay.data?.payment?.id) S.eurPayment = eurPay.data.payment.id;
  await step('sales receipt', 'POST', '/api/sales-receipts', { customerId: S.customer2, date: '2026-03-02', method: 'cash', lines: [{ itemId: S.invItem2, quantity: '1', rate: '40.00' }] }, 'salesReceipt');
  if (S.payment) await step('deposit', 'POST', '/api/deposits', { depositAccountId: S.bank, date: '2026-03-06', paymentIds: [S.payment], salesReceiptIds: S.salesReceipt ? [S.salesReceipt] : [], extraLines: [{ accountId: S.equity, amount: '5000.00', description: 'Owner contribution' }] }, 'deposit');
  await step('credit memo', 'POST', '/api/credit-memos', { customerId: S.customer, date: '2026-03-10', lines: [{ itemId: S.invItem, quantity: '1', rate: '25.00', taxable: true, restock: true }] }, 'creditMemo');
  await step('estimate', 'POST', '/api/estimates', { customerId: S.customer, date: '2026-02-15', expirationDate: '2026-12-31', lines: [{ itemId: S.invItem, quantity: '3', rate: '25' }, { itemId: S.svcItem, quantity: '4', rate: '150' }] }, 'estimate');
  await step('sales order', 'POST', '/api/sales-orders', { customerId: S.customer, date: '2026-03-03', shipDate: '2026-03-08', lines: [{ itemId: S.invItem, quantity: '3', rate: '25' }, { itemId: S.invItem2, quantity: '2', rate: '40' }] }, 'so');
  await step('statement charge', 'POST', '/api/invoices/statement-charges', { customerId: S.customer, date: '2026-04-15', itemId: S.svcItem, quantity: '1', rate: '50', amount: '50.00', description: 'Late setup' });

  // Purchases
  await step('bill', 'POST', '/api/bills', { vendorId: S.vendor, billNumber: 'B-100', date: '2026-03-01', dueDate: '2026-03-31', terms: 'net_30', classId: S.class,
    lines: [{ accountId: S.rent, amount: '1200.00', description: 'Rent', customerId: S.customer, jobId: S.job }, { itemId: S.invItem, quantity: '20', unitCost: '10.00' }] }, 'bill');
  await step('bill 2 (open)', 'POST', '/api/bills', { vendorId: S.vendor2, billNumber: 'L-1', date: '2026-04-01', lines: [{ accountId: S.rent, amount: '2000.00' }] }, 'bill2');
  await step('vendor credit', 'POST', '/api/vendor-credits', { vendorId: S.vendor, date: '2026-03-05', refNumber: 'VC-1', lines: [{ accountId: S.rent, amount: '50.00' }] }, 'vendorCredit');
  const bp = await step('bill payment', 'POST', '/api/bill-payments', { vendorId: S.vendor, date: '2026-03-15', method: 'check', reference: '2001', paymentAccountId: S.bank,
    applications: S.bill ? [{ billId: S.bill, amountApplied: '1350.00' }] : [], vendorCredits: S.vendorCredit && S.bill ? [{ vendorCreditId: S.vendorCredit, billId: S.bill, amount: '50.00' }] : [] });
  if (bp.data?.payment?.id) S.billPayment = bp.data.payment.id;
  const chk = await step('check', 'POST', '/api/expenses', { vendorId: S.vendor2, date: '2026-03-04', method: 'check', paymentAccountId: S.bank, memo: 'office', lines: [{ accountId: S.adv, amount: '75.00', classId: S.class }, { itemId: S.nonInv, quantity: '2', unitCost: '1.00' }] });
  if (chk.data?.expense?.id) S.check = chk.data.expense.id;
  const ccx = await step('credit card charge', 'POST', '/api/expenses', { payeeName: 'Coffee Shop', date: '2026-03-07', method: 'credit_card', paymentAccountId: S.cc, lines: [{ accountId: S.adv, amount: '12.50' }] });
  if (ccx.data?.expense?.id) S.ccCharge = ccx.data.expense.id;
  await step('purchase order', 'POST', '/api/purchase-orders', { vendorId: S.vendor, date: '2026-03-10', expectedDate: '2026-03-20', lines: [{ itemId: S.invItem, quantity: '10', rate: '9.50' }, { itemId: S.invItem2, quantity: '5', rate: '14' }] }, 'po');
  const ir = await step('item receipt', 'POST', '/api/item-receipts', { vendorId: S.vendor, date: '2026-03-12', reference: 'PK-1', purchaseOrderId: S.po, lines: [{ itemId: S.invItem, quantity: '5', unitCost: '9.50' }] }, 'itemReceipt');
  S.receiptLine = ir.data?.lines?.[0]?.id;
  await step('item receipt 2 (no PO)', 'POST', '/api/item-receipts', { vendorId: S.vendor, date: '2026-03-13', lines: [{ itemId: S.invItem2, quantity: '3', unitCost: '15' }] }, 'itemReceipt2');
  await step('PO 2', 'POST', '/api/purchase-orders', { vendorId: S.vendor2, date: '2026-04-10', lines: [{ itemId: S.invItem2, quantity: '4', rate: '15' }] }, 'po2');

  // Ledger
  const je = await step('journal entry', 'POST', '/api/journal-entries', { date: '2026-03-31', description: 'Accrue wages', reference: 'JE-1', lines: [{ accountId: S.payrollExp, debit: '500.00', classId: S.class }, { accountId: S.payLiab, credit: '500.00' }] });
  if (je.data?.entry?.id) S.je = je.data.entry.id;
  const je2 = await step('AR journal entry', 'POST', '/api/journal-entries', { date: '2026-04-30', description: 'AR adj', isAdjusting: true, lines: [{ accountId: S.ar, debit: '25.00', entityType: 'customer', entityId: S.customer }, { accountId: S.otherIncome, credit: '25.00' }] });
  if (je2.data?.entry?.id) S.je2 = je2.data.entry.id;
  await step('transfer', 'POST', '/api/transfers', { date: '2026-03-20', fromAccountId: S.bank, toAccountId: S.savings, amount: '1000.00', memo: 'to savings' }, 'transfer');
  await step('bank account (register link)', 'POST', '/api/bank-accounts', { accountId: S.bank, bankName: 'Chase', accountNumber: '123456789' }, 'bankAccount');
  await step('bank rule', 'POST', '/api/bank-rules', { name: 'Uber', matchField: 'description', matchOperator: 'contains', matchValue: 'UBER', bankAccountId: S.bankAccount, direction: 'out', setAccountId: S.adv, mode: 'suggest', enabled: true }, 'bankRule');
  await step('demo bank feed', 'POST', '/api/demo-feed', { bankAccountId: S.bankAccount });

  // Reconciliation
  if (S.bankAccount) {
    await step('reconciliation', 'POST', '/api/reconciliations', { bankAccountId: S.bankAccount, statementDate: '2026-03-31', statementBalance: '0.00' }, 'recon');
    if (S.recon) {
      const cl = listOf((await call('GET', `/api/reconciliations/${S.recon}/clearable`)).data);
      let bal = 0;
      for (const line of cl.slice(0, 60)) {
        if (String(line.date || '').slice(0, 10) > '2026-03-31') continue;
        const r = await step('clear line', 'PATCH', `/api/reconciliations/${S.recon}`, { action: 'toggleCleared', journalEntryLineId: line.journalEntryLineId, isCleared: true });
        if (r.ok) bal += Number(line.debit || 0) - Number(line.credit || 0);
      }
      await step('update statement', 'PATCH', `/api/reconciliations/${S.recon}`, { action: 'updateStatement', statementBalance: bal.toFixed(2), statementDate: '2026-03-31' });
      const done = await step('complete reconciliation', 'PATCH', `/api/reconciliations/${S.recon}`, { action: 'complete' });
      if (!done.ok) S.reconIncomplete = true;
    }
  }

  // Payroll / time
  await step('employee', 'POST', '/api/employees', { firstName: 'Eve', lastName: 'Worker', email: 'eve@x.test', payType: 'hourly', payRate: '25' }, 'employee');
  await step('employee 2', 'POST', '/api/employees', { firstName: 'Sal', lastName: 'Aried', payType: 'salary', payRate: '60000' }, 'employee2');
  if (S.employee) await step('employee details', 'PATCH', `/api/employees/${S.employee}`, { ssn: '123-45-6789', hireDate: '2026-01-05', address: { line1: '9 Oak', city: 'Austin', state: 'TX', zip: '78703' }, w4: { filingStatus: 'single' } });
  await step('paycheck', 'POST', '/api/payroll', { employeeId: S.employee, payDate: '2026-03-15', periodStart: '2026-03-01', periodEnd: '2026-03-14', earnings: [{ kind: 'regular', hours: '80', rate: '25' }], filingStatus: 'single', periodsPerYear: 26 }, 'paycheck');
  await step('pay run', 'POST', '/api/payroll/pay-runs', { payDate: '2026-03-31', periodStart: '2026-03-15', periodEnd: '2026-03-28', employees: [{ employeeId: S.employee, hours: '80' }, ...(S.employee2 ? [{ employeeId: S.employee2 }] : [])] });
  await step('time entry', 'POST', '/api/time-entries', { employeeId: S.employee, customerId: S.customer, jobId: S.job, serviceItemId: S.svcItem, date: '2026-03-18', hours: '6.5', billable: true, rate: '150', description: 'Site work' }, 'timeEntry');
  await step('time entry 2', 'POST', '/api/time-entries', { employeeId: S.employee, customerId: S.customer2, date: '2026-03-19', hours: '2', billable: true }, 'timeEntry2');
  await step('mileage', 'POST', '/api/mileage', { date: '2026-03-18', vehicle: 'Truck', miles: '42', customerId: S.customer, ratePerMile: '0.67', purpose: 'site visit', billable: true }, 'mileage');

  // Planning / assets / templates
  await step('budget', 'POST', '/api/budgets', { name: 'FY26', fiscalYear: 2026, kind: 'profit_loss', isForecast: false }, 'budget');
  if (S.budget) for (const m of [1, 2, 3, 6, 12]) await step(`budget line ${m}`, 'PATCH', `/api/budgets/${S.budget}`, { accountId: S.svcIncome, month: m, amount: '1500.00' });
  if (S.budget) await step('budget class line', 'PATCH', `/api/budgets/${S.budget}`, { accountId: S.rent, month: 3, amount: '1200.00', classId: S.class });
  await step('fixed asset', 'POST', '/api/fixed-assets', { name: 'Laptop', cost: '2400.00', salvageValue: '0', usefulLifeMonths: 36, placedInService: '2026-02-15' }, 'fixedAsset');
  if (S.fixedAsset) await step('depreciate', 'POST', `/api/fixed-assets/${S.fixedAsset}`, { action: 'depreciate', date: '2026-03-31' });
  await step('loan', 'POST', '/api/loans', { name: 'Truck loan', liabilityAccountId: S.ltl, interestAccountId: S.bankFees, paymentAccountId: S.bank, originalAmount: '25000.00', annualRate: '6.5', termMonths: 60, paymentsPerYear: 12, originDate: '2026-02-01', firstPaymentDate: '2026-03-01' }, 'loan');
  await step('recurring check', 'POST', '/api/recurring', { name: 'Monthly rent', docType: 'check', frequency: 'monthly', nextRunDate: '2026-11-01', mode: 'remind', template: { vendorId: S.vendor2, paymentAccountId: S.bank, lines: [{ accountId: S.rent, amount: '2000.00' }] } }, 'recurring');
  await step('recurring invoice', 'POST', '/api/recurring', { name: 'Retainer', docType: 'invoice', frequency: 'monthly', nextRunDate: '2026-11-01', mode: 'automatic', template: { customerId: S.customer, lines: [{ itemId: S.svcItem, quantity: '1', rate: '500' }] } }, 'recurring2');
  await step('inventory transfer', 'POST', '/api/inventory-transfers', { date: '2026-03-25', fromSiteId: S.site, toSiteId: S.site2, lines: [{ itemId: S.invItem, quantity: '1' }] });
  await step('physical count', 'POST', '/api/inventory/physical-count', { itemId: S.avgItem, countedQty: '150', date: '2026-03-31' });
  await step('sales tax pay', 'POST', '/api/sales-tax/pay', { date: '2026-04-20', paymentAccountId: S.bank, payments: [{ agencyId: S.taxAgency, amount: '5.00' }], dueThrough: '2026-03-31' });
  await step('todo', 'POST', '/api/todos', { title: 'Call Acme', kind: 'call', priority: 'high', dueDate: '2026-04-01', entityType: 'customer', entityId: S.customer }, 'todo');
  await step('lead', 'POST', '/api/leads', { name: 'Prospect Co', companyName: 'Prospect Co', email: 'p@x.test' }, 'lead');
  await step('note', 'POST', '/api/notes', { entityType: 'customer', entityId: S.customer, body: 'Prefers email' }, 'note');
  await step('memorized report', 'POST', '/api/memorized-reports', { name: 'My P&L', reportType: 'profit-loss', config: { from: FROM, to: TO } }, 'memReport');
  await step('receipt upload link', 'POST', '/api/receipts/upload-links', {}, 'uploadLink');
  {
    const links = await call('GET', '/api/receipts/upload-links');
    const l = listOf(links.data)[0];
    if (l?.token) S.uploadToken = l.token;
  }
  const u = await step('user', 'POST', '/api/users', { name: 'Bob Clerk', login: 'bob', password: 'Bob-secret-123!', roleKeys: ['bookkeeper'], requireChange: false });
  if (u.data?.userId) S.otherUser = u.data.userId;
  const role = await step('role', 'POST', '/api/roles', { cloneFrom: 'bookkeeper', name: 'BK2' });
  if (role.data?.key) S.roleKey = role.data.key;
  await step('payroll item', 'POST', '/api/payroll-items', { name: '401k', kind: 'deduction', pretax: true, calcBasis: 'percent', defaultRate: '5', liabilityAccountId: S.payLiab }, 'payrollItem');
  await step('form template', 'POST', '/api/form-templates', { formType: 'invoice', name: 'Crawl T1', design: {}, isDefault: false }, 'template');
  await step('attachment', 'POST', '/api/attachments', { filename: 'a.txt', mimeType: 'text/plain', base64: 'aGVsbG8=', entityType: 'invoice', entityId: S.invoice }, 'attachment');
  await step('expense report', 'POST', '/api/expense-reports', { employeeId: S.employee, title: 'Trip', lines: [{ accountId: S.adv, date: '2026-03-02', description: 'Taxi', amount: '40' }] }, 'expenseReport');
  await step('uom set', 'POST', '/api/uom-sets', { name: 'Box', kind: 'count', baseUnitName: 'Each', baseUnitAbbrev: 'ea', units: [{ name: 'Box', abbrev: 'bx', factor: '12' }] }, 'uomSet');
  await step('billing rate level', 'POST', '/api/billing-rate-levels', { name: 'Senior', type: 'fixed_rate', fixedRate: '150' }, 'billingRate');
  await step('terms entry', 'POST', '/api/lists/terms', { name: 'Net 45', kind: 'standard', netDays: 45 });
  await step('vehicle entry', 'POST', '/api/lists/vehicles', { name: 'Truck' });
  await step('other name', 'POST', '/api/lists/other-names', { name: 'Owner Draw Payee' });
  await step('customer type', 'POST', '/api/type-lists/customer', { name: 'Retail' });
  await step('calendar todo', 'POST', '/api/calendar/todos', { title: 'Meet vendor', kind: 'meeting', dueDate: '2026-04-02', entityType: 'vendor', entityId: S.vendor });
  await step('collections note', 'POST', '/api/collections/notes', { customerId: S.customer, body: 'Called', note: 'Called' });
  await step('letter template', 'POST', '/api/letters/templates', { name: 'Collection', category: 'collection', body: 'Dear {{name}}' });
  await step('location', 'POST', '/api/locations', { name: 'HQ' });
  await step('bin', 'POST', '/api/inventory-sites/bins', { siteId: S.site, name: 'A1' });
  await step('memorized group', 'POST', '/api/memorized-reports/groups', { name: 'Monthly' });
  await step('workers comp code', 'POST', '/api/payroll/workers-comp', { code: '8810', description: 'Clerical', ratePer100: '0.50' });
  await step('state tax setting', 'POST', '/api/payroll/state-settings', { state: 'TX', year: 2026, suiRate: '0.027', suiWageBase: '9000', accountNumber: '123' });
  await step('pricing rule', 'POST', '/api/pricing/rules', { name: 'Spring sale', conditions: { itemIds: [S.invItem] }, adjustment: { basis: 'price', method: 'percent', direction: 'decrease', value: '5' } });
  await step('estimate 2', 'POST', '/api/estimates', { customerId: S.customer2, date: '2026-04-15', lines: [{ itemId: S.svcItem, quantity: '2', rate: '150' }] }, 'estimate2');
  await step('invoice from SO', 'POST', `/api/sales-orders/${S.so}`, { action: 'convert' });
  await step('receive bill from receipt', 'POST', '/api/receiving/bill', { vendorId: S.vendor, billNumber: 'RB-1', date: '2026-03-14', lines: S.receiptLine ? [{ receiptLineId: S.receiptLine, quantity: '5', unitCost: '9.60' }] : [] });
  await step('landed cost bill', 'POST', '/api/bills', { vendorId: S.vendor, billNumber: 'FRT-1', date: '2026-03-14', lines: [{ accountId: S.cogs, amount: '30.00', description: 'Freight' }] }, 'freightBill');
  await step('report schedule', 'POST', '/api/report-schedules', { name: 'Daily', memorizedReportId: S.memReport, frequency: 'daily', format: 'csv' }, 'schedule');
  await step('value adjust', 'POST', '/api/inventory/value-adjust', { itemId: S.avgItem2, newUnitCost: '0.11', date: '2026-04-30', reason: 'Revalue' });
  await step('loan payment', 'POST', `/api/loans/${S.loan}/payments`, { kind: 'check', date: '2026-03-01', paymentAccountId: S.bank });
  await step('billable time invoice', 'POST', '/api/time-entries/bill', { customerId: S.customer2 });
  await step('finance charges', 'POST', '/api/finance-charges', { date: '2026-06-30', asOf: '2026-06-30' });

  // Receipt capture (multipart upload) → real ids for the /receipts/[id] page and its API routes.
  {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fd = new FormData();
    fd.append('file', new Blob([png], { type: 'image/png' }), 'receipt.png');
    const r = await fetch(BASE + '/api/receipts', { method: 'POST', headers: { cookie: cookieHeader() }, body: fd }).catch((e) => ({ status: 'NETERR', ok: false, json: async () => String(e) }));
    const d = await r.json().catch(() => null);
    seedLog.push({ step: 'receipt upload', status: r.status, error: r.ok ? undefined : JSON.stringify(d)?.slice(0, 200) });
    if (!r.ok) console.log(`  seed ✗ receipt upload: HTTP ${r.status} ${JSON.stringify(d)?.slice(0, 200)}`);
    if (d?.receipt?.id) S.receipt = d.receipt.id;
  }
  {
    const bt = listOf((await call('GET', `/api/bank-transactions?bankAccountId=${S.bankAccount}`)).data);
    if (bt[0]?.id) S.bankTxn = bt[0].id;
    const lc = await call('GET', `/api/landed-cost?sources=1&billId=${S.freightBill}`);
    const src = listOf(lc.data)[0] || (Array.isArray(lc.data?.sources) ? lc.data.sources[0] : null);
    if (src && S.itemReceipt) {
      await step('landed cost', 'POST', '/api/landed-cost', { billId: S.freightBill, billLineId: src.billLineId || src.lineId || src.id, method: 'quantity', itemReceiptIds: [S.itemReceipt] }, 'landedCost');
    }
  }

  // Documents dated inside the period that is closed next (their void/delete is probed afterwards).
  const J = '2026-01-20';
  const jdoc = async (name, p, body, key, pick) => {
    const r = await step(`jan ${name}`, 'POST', p, body);
    const id = pick ? pick(r.data) : r.row?.id;
    if (id) CLOSED_DOCS.push([name, p, id]);
    if (id && key) S[key] = id;
  };
  await jdoc('invoice', '/api/invoices', { customerId: S.customer2, date: J, lines: [{ itemId: S.svcItem, quantity: '1', rate: '100' }] }, 'janInvoice');
  await jdoc('payment', '/api/payments', { customerId: S.customer2, date: J, method: 'check', amount: '100.00', applications: S.janInvoice ? [{ invoiceId: S.janInvoice, amountApplied: '100.00' }] : [] }, null, (d) => d?.payment?.id);
  await jdoc('sales receipt', '/api/sales-receipts', { date: J, method: 'cash', depositAccountId: S.bank, lines: [{ itemId: S.svcItem, quantity: '1', rate: '50' }] });
  await jdoc('credit memo', '/api/credit-memos', { customerId: S.customer2, date: J, lines: [{ itemId: S.svcItem, quantity: '1', rate: '10' }] });
  await jdoc('deposit', '/api/deposits', { depositAccountId: S.bank, date: J, extraLines: [{ accountId: S.equity, amount: '300.00' }] });
  await jdoc('bill', '/api/bills', { vendorId: S.vendor2, billNumber: 'JAN-1', date: J, lines: [{ accountId: S.rent, amount: '400.00' }] }, 'janBill');
  await jdoc('bill payment', '/api/bill-payments', { vendorId: S.vendor2, date: J, method: 'check', paymentAccountId: S.bank, applications: S.janBill ? [{ billId: S.janBill, amountApplied: '400.00' }] : [] }, null, (d) => d?.payment?.id);
  await jdoc('check', '/api/expenses', { payeeName: 'Jan Payee', date: J, method: 'check', paymentAccountId: S.bank, lines: [{ accountId: S.adv, amount: '20.00' }] }, null, (d) => d?.expense?.id);
  await jdoc('vendor credit', '/api/vendor-credits', { vendorId: S.vendor, date: J, lines: [{ accountId: S.rent, amount: '15.00' }] });
  await jdoc('journal entry', '/api/journal-entries', { date: J, description: 'Jan JE', lines: [{ accountId: S.adv, debit: '5.00' }, { accountId: S.bank, credit: '5.00' }] }, null, (d) => d?.entry?.id);
  await jdoc('transfer', '/api/transfers', { date: J, fromAccountId: S.bank, toAccountId: S.savings, amount: '50.00' });
  await jdoc('paycheck', '/api/payroll', { employeeId: S.employee, payDate: J, earnings: [{ kind: 'regular', hours: '8', rate: '25' }] });
  await jdoc('time entry', '/api/time-entries', { employeeId: S.employee, customerId: S.customer2, date: J, hours: '1', billable: false });
  await jdoc('mileage', '/api/mileage', { date: J, vehicle: 'Truck', miles: '5', ratePerMile: '0.67' });

  // Closed period (last): fiscal period Jan 2026 + company closing date.
  await step('closed fiscal period', 'POST', '/api/fiscal-periods', { periodStart: '2026-01-01', periodEnd: CLOSED_THROUGH }, 'fiscalPeriod');
  await step('closing date', 'PATCH', '/api/company/closing-date', { closingDate: CLOSED_THROUGH, password: 'closepw' });
  await closedPeriodProbes();
  console.log(`  seeded ${Object.keys(S).length} ids; ${seedLog.filter((s) => !(typeof s.status === 'number' && s.status < 300)).length} non-2xx seed steps`);
}

// Posting into the closed period must be refused with 4xx (PERIOD_CLOSED), never 500.
async function closedPeriodProbes() {
  const D = '2026-01-15';
  const probes = [
    ['invoice', '/api/invoices', { customerId: S.customer, date: D, lines: [{ itemId: S.svcItem, quantity: '1', rate: '10' }] }],
    ['payment', '/api/payments', { customerId: S.customer2, date: D, method: 'cash', amount: '10.00', applications: [] }],
    ['sales receipt', '/api/sales-receipts', { date: D, method: 'cash', lines: [{ itemId: S.svcItem, quantity: '1', rate: '10' }] }],
    ['credit memo', '/api/credit-memos', { customerId: S.customer, date: D, lines: [{ itemId: S.svcItem, quantity: '1', rate: '10' }] }],
    ['deposit', '/api/deposits', { depositAccountId: S.bank, date: D, extraLines: [{ accountId: S.equity, amount: '10.00' }] }],
    ['bill', '/api/bills', { vendorId: S.vendor, billNumber: 'CLOSED-1', date: D, lines: [{ accountId: S.rent, amount: '10.00' }] }],
    ['bill payment', '/api/bill-payments', { vendorId: S.vendor2, date: D, method: 'check', paymentAccountId: S.bank, applications: S.bill2 ? [{ billId: S.bill2, amountApplied: '10.00' }] : [] }],
    ['check', '/api/expenses', { payeeName: 'X', date: D, method: 'check', paymentAccountId: S.bank, lines: [{ accountId: S.adv, amount: '10.00' }] }],
    ['vendor credit', '/api/vendor-credits', { vendorId: S.vendor, date: D, lines: [{ accountId: S.rent, amount: '10.00' }] }],
    ['item receipt', '/api/item-receipts', { vendorId: S.vendor, date: D, lines: [{ itemId: S.invItem, quantity: '1', unitCost: '10' }] }],
    ['journal entry', '/api/journal-entries', { date: D, description: 'closed', lines: [{ accountId: S.adv, debit: '10.00' }, { accountId: S.bank, credit: '10.00' }] }],
    ['transfer', '/api/transfers', { date: D, fromAccountId: S.bank, toAccountId: S.savings, amount: '10.00' }],
    ['paycheck', '/api/payroll', { employeeId: S.employee, payDate: D, earnings: [{ kind: 'regular', hours: '1', rate: '25' }] }],
    ['pay run', '/api/payroll/pay-runs', { payDate: D, employees: [{ employeeId: S.employee, hours: '1' }] }],
    ['depreciation', `/api/fixed-assets/${S.fixedAsset}`, { action: 'depreciate', date: D }],
    ['assembly build', '/api/assemblies/build', { assemblyItemId: S.assembly, quantity: '1', action: 'build', date: D }],
    ['physical count', '/api/inventory/physical-count', { itemId: S.avgItem, countedQty: '140', date: D }],
    ['value adjust', '/api/inventory/value-adjust', { itemId: S.avgItem2, newUnitCost: '0.12', date: D, reason: 'x' }],
    ['sales tax pay', '/api/sales-tax/pay', { date: D, paymentAccountId: S.bank, payments: [{ agencyId: S.taxAgency, amount: '1.00' }] }],
    ['time bill', '/api/time-entries/bill', { customerId: S.customer, date: D, timeEntryIds: S.timeEntry ? [S.timeEntry] : [] }],
    ['finance charges', '/api/finance-charges', { date: D, asOf: D }],
    ['fx adjustment', '/api/currencies/fx-adjustment', { date: D, currency: 'EUR', rate: '1.2' }],
    ['home currency adjustment', '/api/currencies/home-currency-adjustment', { date: D, currency: 'EUR', exchangeRate: '1.2' }],
    ['loan payment', `/api/loans/${S.loan}/payments`, { kind: 'check', date: D, paymentAccountId: S.bank }],
    ['so convert', `/api/sales-orders/${S.so}`, { action: 'convert', date: D }],
    ['estimate convert', `/api/estimates/${S.estimate}`, { action: 'convert', date: D }],
    ['po convert', `/api/purchase-orders/${S.po2}`, { action: 'convert', date: D }],
    ['item receipt convert', `/api/item-receipts/${S.itemReceipt2}`, { action: 'convert', date: D }],
    ['inventory transfer', '/api/inventory-transfers', { date: D, fromSiteId: S.site, toSiteId: S.site2, lines: [{ itemId: S.invItem, quantity: '1' }] }],
  ];
  console.log('  closed-period probes');
  for (const [name, p, body] of probes) {
    if (p.includes('undefined')) continue;
    const r = await call('POST', p, body);
    seedLog.push({ step: `closed-period ${name}`, status: r.status, error: r.data?.code || r.data?.error });
    if (isBad(r)) {
      record('closed-period', 'POST', p, r, `posting dated ${D} into the closed period: server error`, body);
      console.log(`  ✗ closed-period ${name}: HTTP ${r.status} ${JSON.stringify(r.data)?.slice(0, 160)}`);
    } else if (typeof r.status === 'number' && r.status < 300 && !/inventory transfer/.test(name)) {
      console.log(`  ! closed-period ${name}: accepted (HTTP ${r.status})`);
      record('closed-period-accepted', 'POST', p, r, `posting dated ${D} into the closed period was ACCEPTED`, body);
    }
  }
  const editProbes = [
    ['PATCH', `/api/invoices/${S.invoice2}`, { date: D }],
    ['PATCH', `/api/bills/${S.bill2}`, { date: D }],
    ['PATCH', `/api/journal-entries/${S.je2}`, { date: D }],
    ['PATCH', `/api/transfers/${S.transfer}`, { date: D }],
    ['PATCH', `/api/expenses/${S.ccCharge}`, { date: D }],
    ['PATCH', `/api/deposits/${S.deposit}`, { date: D }],
    ['PATCH', `/api/payroll/${S.paycheck}`, { payDate: D }],
    ['PATCH', `/api/time-entries/${S.timeEntry2}`, { date: D }],
    ['PATCH', `/api/credit-memos/${S.creditMemo}`, { date: D }],
    ['PATCH', `/api/vendor-credits/${S.vendorCredit}`, { date: D }],
    ['PATCH', `/api/sales-receipts/${S.salesReceipt}`, { date: D }],
    ['PATCH', `/api/bill-payments/${S.billPayment}`, { date: D }],
    ['PATCH', `/api/payments/${S.payment2}`, { date: D }],
  ];
  for (const [m, p, body] of editProbes) {
    if (p.includes('undefined')) continue;
    const r = await call(m, p, body);
    seedLog.push({ step: `closed-period edit ${p}`, status: r.status, error: r.data?.code || r.data?.error });
    if (isBad(r)) {
      record('closed-period', m, p, r, 'moving a document into the closed period: server error', body);
      console.log(`  ✗ closed-period edit ${m} ${p}: HTTP ${r.status} ${JSON.stringify(r.data)?.slice(0, 160)}`);
    }
  }
  for (const [name, coll, id] of CLOSED_DOCS) {
    for (const [m, body] of [['PATCH', { memo: 'edited in closed period', description: 'edited' }], ['DELETE', undefined]]) {
      const p = `${coll}/${id}`;
      const r = await call(m, p, body);
      seedLog.push({ step: `closed-doc ${m} ${name}`, status: r.status, error: r.data?.code || r.data?.error });
      if (isBad(r)) {
        record('closed-period', m, p, r, `${m} of a ${name} dated inside the closed period: server error`, body);
        console.log(`  ✗ closed-doc ${m} ${name}: HTTP ${r.status} ${JSON.stringify(r.data)?.slice(0, 160)}`);
      } else if (m === 'DELETE' && typeof r.status === 'number' && r.status < 300) {
        record('closed-period-accepted', m, p, r, `void/delete of a ${name} dated inside the closed period was ACCEPTED`);
        console.log(`  ! closed-doc DELETE ${name}: accepted (HTTP ${r.status})`);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Route enumeration
// ---------------------------------------------------------------------------------------------
function walk(dir, name, acc = []) {
  for (const e of readdirSync(dir)) {
    const f = path.join(dir, e);
    const st = statSync(f);
    if (st.isDirectory()) walk(f, name, acc);
    else if (e === name) acc.push(f);
  }
  return acc;
}
function routeOf(file, base) {
  const rel = path.relative(base, path.dirname(file)).split(path.sep).filter((s) => s && !/^\(.*\)$/.test(s));
  return '/' + rel.join('/');
}
const appDir = path.join(root, 'app');
const pageRoutes = walk(appDir, 'page.tsx').filter((f) => !f.includes(`${path.sep}api${path.sep}`)).map((f) => routeOf(f, appDir)).map((r) => (r === '/' ? '/' : r)).sort();
const apiFiles = walk(path.join(appDir, 'api'), 'route.ts').sort();
const apiRoutes = apiFiles.map((f) => {
  const src = readFileSync(f, 'utf8');
  const methods = [...new Set([...src.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]))];
  // Query params the route reads directly (heuristic): x.get('name') excluding headers/cookies.
  const qp = [...new Set([...src.matchAll(/(?:searchParams|sp|params|qs|query|url\.searchParams|q)\.get\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g)].map((m) => m[1]))];
  return { route: routeOf(f, appDir), file: path.relative(root, f), methods, qp };
});
// Standard report keys from the catalog (static source).
const catalogSrc = readFileSync(path.join(root, 'lib', 'reports', 'catalog.ts'), 'utf8');
const STD_REPORTS = [...catalogSrc.matchAll(/\{\s*key:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------------------------
// Param values
// ---------------------------------------------------------------------------------------------
const FROM = '2026-01-01';
const TO = '2026-12-31';
const ASOF = '2026-06-30';
function qpValue(name) {
  const n = name.toLowerCase();
  if (/^(from|start|startdate|datefrom|periodstart|fromdate|since|begin)$/.test(n)) return FROM;
  if (/^(to|end|enddate|dateto|periodend|todate|until)$/.test(n)) return TO;
  if (/^(asof|asofdate|date|through|statementdate|cutoff|paydate|duedate|enddateasof)$/.test(n)) return ASOF;
  if (n === 'year' || n === 'taxyear') return '2026';
  if (n === 'quarter') return '2';
  if (n === 'month') return '6';
  if (/^(q|query|search|term|text|name|keyword)$/.test(n)) return 'a';
  if (/^(limit|pagesize|take|top)$/.test(n)) return '10';
  if (/^(offset|skip)$/.test(n)) return '0';
  if (n === 'page') return '1';
  if (n === 'basis') return 'accrual';
  if (n === 'format') return 'json';
  if (n === 'status') return 'open';
  if (/^(include|all|showall|includeinactive|inactive|detail|preview)$/.test(n)) return 'true';
  if (n.endsWith('id')) {
    const k = n.slice(0, -2);
    const map = {
      customer: 'customer', vendor: 'vendor', account: 'bank', item: 'invItem', employee: 'employee',
      invoice: 'invoice', bill: 'bill', class: 'class', job: 'job', budget: 'budget', site: 'site',
      payment: 'payment', estimate: 'estimate', po: 'po', purchaseorder: 'po', salesorder: 'so',
      bankaccount: 'bankAccount', reconciliation: 'recon', company: 'companyId', user: 'userId', name: 'customer',
      deposit: 'deposit', paycheck: 'paycheck', entity: 'customer', source: 'invoice', txn: 'invoice',
      transaction: 'invoice', template: 'template', rep: 'rep', salesrep: 'rep', location: 'site', fixedasset: 'fixedAsset',
      asset: 'fixedAsset', loan: 'loan', lead: 'lead', receipt: 'receipt', vendorcredit: 'vendorCredit', creditmemo: 'creditMemo',
      payrollitem: 'payrollItem', agency: 'taxAgency', taxagency: 'taxAgency', taxrate: 'taxRate', currency: 'eur',
    };
    if (map[k] && S[map[k]]) return S[map[k]];
    if (n === 'id') return null;
    return S.customer || null;
  }
  if (n === 'type' || n === 'kind') return null; // route specific; leave out
  if (n === 'currency' || n === 'currencycode' || n === 'code') return 'EUR';
  return null;
}

// Real ids for [id]-style segments, keyed by the API collection path before the param.
const SEG_IDS = {}; // filled after seeding: '/api/customers' → id
function resolvePath(route, idFor, bogus) {
  // route: /api/foo/[id]/bar  → replace each [param]
  const parts = route.split('/');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    const m = /^\[(\.\.\.)?([^\]]+)\]$/.exec(seg);
    if (!m) { out.push(seg); continue; }
    const prefix = out.join('/');
    const v = bogus ? bogus(m[2], prefix) : idFor(m[2], prefix);
    if (v == null) return null;
    out.push(encodeURIComponent(v));
  }
  return out.join('/');
}

// ---------------------------------------------------------------------------------------------
// Page crawl
// ---------------------------------------------------------------------------------------------
const BENIGN_DIGESTS = /NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING/;
function htmlProblems(html) {
  const probs = [];
  if (!html) return probs;
  if (/Application error: a (?:client|server)-side exception/i.test(html)) probs.push('"Application error" marker');
  if (/<html[^>]*id="__next_error__"/.test(html)) probs.push('__next_error__ document');
  if (/Internal Server Error/.test(html) && html.length < 5000) probs.push('"Internal Server Error" text');
  for (const m of html.matchAll(/data-dgst="([^"]*)"/g)) if (!BENIGN_DIGESTS.test(m[1])) probs.push(`streamed error digest ${m[1]}`);
  // RSC payload error rows: E{"digest":"…"}  (escaped inside self.__next_f.push strings)
  for (const m of html.matchAll(/E\{\\?"digest\\?":\\?"([^"\\]*)\\?"/g)) if (!BENIGN_DIGESTS.test(m[1])) probs.push(`RSC error digest ${m[1]}`);
  return [...new Set(probs)];
}

function pageIdFor(param, prefix) {
  if (prefix.endsWith('/receipts')) return S.receipt;
  if (prefix.endsWith('/registers')) return S.bank;
  if (prefix.endsWith('/reports/reconciliation')) return S.recon;
  if (prefix.endsWith('/m/receipt')) return S.uploadToken || 'not-a-real-token';
  return null;
}

async function crawlPages() {
  console.log(`\nPAGES: ${pageRoutes.length} page routes`);
  const urls = [];
  for (const r of pageRoutes) {
    if (r === '/reports/std/[report]') {
      for (const k of STD_REPORTS) urls.push(`/reports/std/${k}`);
      urls.push('/reports/std/not-a-report');
      continue;
    }
    if (r.includes('[')) {
      const real = resolvePath(r, pageIdFor);
      if (real) urls.push(real);
      const bogus = resolvePath(r, () => '00000000-0000-4000-8000-000000000000');
      urls.push(bogus);
      urls.push(resolvePath(r, () => 'garbage'));
      continue;
    }
    urls.push(r);
  }
  // Pages that take ids / filters in the query string (common deep links).
  const extra = [
    `/invoices?id=${S.invoice}`, `/invoices?customerId=${S.customer}`, `/bills?id=${S.bill}`, `/estimates?id=${S.estimate}`,
    `/sales-orders?id=${S.so}`, `/purchase-orders?id=${S.po}`, `/credit-memos?id=${S.creditMemo}`, `/vendor-credits?id=${S.vendorCredit}`,
    `/journal?id=${S.je}`, `/payments?id=${S.payment}`, `/deposits?id=${S.deposit}`, `/customers?id=${S.customer}`,
    `/vendors?id=${S.vendor}`, `/items?id=${S.invItem}`, `/reconcile?accountId=${S.bank}`, `/reports/drilldown?report=profit-loss&from=${FROM}&to=${TO}`,
    `/reports/general-ledger?from=${FROM}&to=${TO}`, `/reports/profit-loss?from=${FROM}&to=${TO}&basis=cash`, `/reports/balance-sheet?asOf=${ASOF}`,
    `/reports/std/profit-loss?from=garbage&to=nope`, `/reports/std/general-ledger?accountId=garbage`, `/registers/${S.bank}?from=garbage`,
    `/invoices?id=garbage`, `/find?q=a`, `/transactions?type=invoice`, `/expenses?id=${S.check}`, `/item-receipts?id=${S.itemReceipt}`,
    `/sales-receipts?id=${S.salesReceipt}`, `/transfers?id=${S.transfer}`, `/employees?id=${S.employee}`, `/fixed-assets?id=${S.fixedAsset}`,
  ].filter((u) => !u.includes('undefined'));
  urls.push(...extra);
  stats.pages = pageRoutes.length;
  stats.pageUrls = urls.length;
  let n = 0;
  for (const u of urls) {
    const r = await call('GET', u);
    n++;
    const probs = [];
    if (isBad(r)) probs.push(`HTTP ${r.status}`);
    if (typeof r.status === 'number' && r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location') || '';
      const portalLogin = /^\/portal(\/|$)/.test(u) && /\/portal\/login/.test(loc);
      if (/\/(login|unlock|onboarding)/.test(loc) && !portalLogin) probs.push(`unexpected redirect → ${loc}`);
    }
    if (r.status === 404 && !/garbage|00000000-0000|not-a-report|not-a-real/.test(u)) probs.push('HTTP 404 for a real route');
    probs.push(...htmlProblems(r.text));
    const logged = serverLines.slice(r.logMark).filter((l) => /error|Error|ERR|⨯/.test(l.line));
    if (logged.length) probs.push(`server logged ${logged.length} error line(s)`);
    if (r.ms > 15000) probs.push(`slow (${r.ms} ms)`);
    if (probs.length) {
      record('page', 'GET', u, r, probs.join('; '));
      console.log(`  ✗ page ${u}: ${probs.join('; ')}`);
    }
    if (n % 40 === 0) console.log(`  … ${n}/${urls.length} pages`);
  }
}

// ---------------------------------------------------------------------------------------------
// API crawl
// ---------------------------------------------------------------------------------------------
// Whole-file / session-killing routes: never sent a body that could pass validation.
const DESTRUCTIVE = new Set([
  '/api/backups/restore', '/api/portable/restore', '/api/condense', '/api/condense/archives', '/api/companies/[id]',
  '/api/sandbox', '/api/sandbox/discard', '/api/sandbox/keep', '/api/sandbox/leftovers/[id]', '/api/backup', '/api/backup/company',
  '/api/import', '/api/import/qb', '/api/qb-import', '/api/qb-import/gl', '/api/qb-import/open-items', '/api/import/rebuild',
  '/api/accountant-copy', '/api/accountant-copy/open', '/api/accountant-copy/cancel', '/api/accountant-copy/changes/import',
  '/api/file-lock', '/api/single-user', '/api/network-policy', '/api/users/password-policy', '/api/auth/change-password',
  '/api/auth/logout', '/api/auth/2fa/enable', '/api/auth/2fa/disable', '/api/auth/2fa/setup', '/api/sessions', '/api/sessions/[id]',
  '/api/year-end-close', '/api/month-end-close/close', '/api/companies/select', '/api/companies', '/api/users/[id]',
  '/api/users/[id]/reset-password', '/api/auth/reset', '/api/auth/request-reset', '/api/auth/login', '/api/auth/signup',
  '/api/unlock', '/api/portal/logout', '/api/period-copy', '/api/merge', '/api/undo/commit', '/api/undo/[id]',
  '/api/company/closing-date', '/api/demo-feed', '/api/backups', '/api/backups/run', '/api/dashboard/auto-backup', '/api/attention/backup',
  '/api/plaid/exchange', '/api/plaid/sync', '/api/ai/test', '/api/ai/assistant', '/api/ai/settings', '/api/roles/[id]',
  '/api/cleanup', '/api/accountant/batch-void', '/api/accountant/write-off', '/api/accountant/reclassify', '/api/errors/[id]/apply',
  '/api/report-schedules/run-due', '/api/reports/schedules/run-due', '/api/invoices/[id]/email', '/api/sales-forms/[kind]/[id]/email',
  '/api/sales-forms/statement-email', '/api/fiscal-periods/[id]', '/api/backup/company', '/api/accountant-copy/changes',
  '/api/accountant-copy/changes/review', '/api/print-queue', '/api/print-queue/paychecks', '/api/print-queue/refunds', '/api/recurring/run',
  '/api/memorized-reports/process', '/api/preferences/my', '/api/company', '/api/attention/state',
]);
// Routes that ignore the request body and act anyway (log out, create a sandbox, write backups or
// exports, run due schedules): never called with any method but GET.
const NEVER = new Set([
  '/api/auth/logout', '/api/portal/logout', '/api/sandbox', '/api/attention/backup', '/api/backups/run',
  '/api/dashboard/auto-backup', '/api/report-schedules/run-due', '/api/reports/schedules/run-due', '/api/cleanup',
  '/api/recurring/run', '/api/auth/2fa/setup', '/api/auth/2fa/disable', '/api/unlock',
]);
// Bodies that must never pass validation anywhere.
const INVALID_BODIES = [
  ['empty-object', {}],
  ['array', []],
  ['string', '"x"'],
  ['null', 'null'],
  ['malformed', '{"a":'],
  ['wrong-types', {
    id: 'garbage', ids: 'garbage', customerId: 'garbage', vendorId: 'garbage', accountId: 12, itemId: {}, date: 'notadate',
    from: 'nope', to: 'nope', asOf: 'nope', amount: 'abc', total: -1e30, quantity: 'many', lines: 'notalist', items: 'x',
    name: 123, displayName: [], email: 7, password: 1, status: 'bogus', type: 'bogus', kind: 'bogus', action: 'bogus',
  }],
  ['wrong-lines', { customerId: 'garbage', vendorId: 'garbage', date: '2026-02-30', lines: [null, 5, 'x', { amount: 'abc', quantity: 'q', accountId: 'garbage' }], applications: [null], entries: [null] }],
];
const DESTRUCTIVE_BODIES = [['malformed', '{"a":'], ['array', []]];

function apiIdFor(param, prefix) {
  if (SEG_IDS[prefix]) return SEG_IDS[prefix];
  const p = prefix;
  if (param === 'list') return /\/export$/.test(p) ? 'customers' : 'terms';
  if (param === 'kind') return /sales-forms/.test(p) ? 'invoice' : 'customer';
  if (param === 'report') return 'profit-loss';
  if (param === 'token') return S.uploadToken || 'not-a-token';
  if (param === 'accountId') return S.bank;
  return null;
}
function bogusIdFor(kind) {
  return (param, prefix) => {
    if (param === 'list' || param === 'kind' || param === 'report') return kind === 'uuid' ? 'not-a-list' : '__proto__';
    return kind === 'uuid' ? '00000000-0000-4000-8000-000000000000' : 'garbage';
  };
}

function queryFor(route, names) {
  const qs = new URLSearchParams();
  for (const n of ['from', 'to', 'asOf']) qs.set(n, qpValue(n));
  for (const n of names) {
    const v = qpValue(n);
    if (v != null) qs.set(n, v);
  }
  return qs.toString();
}
function garbageQuery(names) {
  const qs = new URLSearchParams();
  for (const n of new Set(['from', 'to', 'asOf', 'id', 'limit', 'year', ...names])) qs.set(n, n === 'limit' ? '-5' : n === 'year' ? '99999' : "garbage'\"");
  return qs.toString();
}

// Extra realistic GET variants for routes whose meaning depends on a query (beyond heuristics).
const EXTRA_GETS = () => [
  ...STD_REPORTS.flatMap((k) => [
    `/api/reports/std/${k}`,
    `/api/reports/std/${k}?from=${FROM}&to=${TO}&asOf=${ASOF}`,
    `/api/reports/std/${k}?from=${FROM}&to=${TO}&asOf=${ASOF}&columns=month&compare=prev_year&basis=cash`,
    `/api/reports/std/${k}?from=${FROM}&to=${TO}&columns=quarter&compare=prev_period&subtotalBy=class&sortBy=amount&sortDir=desc`,
    `/api/reports/std/${k}?dates=all&subtotalBy=name&sortBy=name&view=detail&interval=15&through=60&agingFrom=transaction_date`,
    `/api/reports/std/${k}?from=${FROM}&to=${TO}&customerId=${S.customer}&vendorId=${S.vendor}&itemId=${S.invItem}&accountId=${S.bank}&classId=${S.class || S.customer}&jobId=${S.job || S.customer}&employeeId=${S.employee || S.customer}&budgetId=${S.budget || S.customer}`,
    `/api/reports/std/${k}?from=${FROM}&to=${TO}&txnType=invoice&amountMin=1&amountMax=99999&cleared=uncleared&memo=a&number=1&subtotalBy=month&columns=year`,
    `/api/reports/std/${k}?nameId=${S.eurCustomer || S.customer}&customerId=${S.eurCustomer || S.customer}&dates=this_fiscal_year&overDays=0&section=income`,
    `/api/reports/summary/${k}?from=${FROM}&to=${TO}`,
    `/api/reports/drilldown/${k}?from=${FROM}&to=${TO}&row=0`,
  ]),
];

async function crawlApi() {
  console.log(`\nAPI: ${apiRoutes.length} route files`);
  stats.apiRoutes = apiRoutes.length;
  const mutations = [];
  let n = 0;
  // ---- GET phase
  for (const ar of apiRoutes) {
    n++;
    if (n % 50 === 0) console.log(`  … ${n}/${apiRoutes.length} routes (GET phase)`);
    if (ar.methods.includes('GET')) {
      const real = resolvePath(ar.route, apiIdFor);
      if (!real) (stats.unresolved ||= []).push(ar.route);
      const variants = [];
      if (real) {
        variants.push([real, 'bare']);
        variants.push([`${real}?${queryFor(ar.route, ar.qp)}`, 'realistic']);
        variants.push([`${real}?${garbageQuery(ar.qp)}`, 'garbage-query']);
      }
      if (ar.route.includes('[')) {
        variants.push([resolvePath(ar.route, apiIdFor, bogusIdFor('uuid')), 'unknown-id']);
        variants.push([resolvePath(ar.route, apiIdFor, bogusIdFor('garbage')), 'garbage-id']);
      }
      for (const [u, label] of variants) {
        if (!u) continue;
        if (/\/api\/auth\/logout|\/api\/portal\/logout/.test(u)) continue;
        const r = await call('GET', u);
        stats.apiCalls++;
        checkApi('GET', u, r, label);
      }
    }
    if (NEVER.has(ar.route)) continue;
    for (const m of ar.methods) if (m !== 'GET') mutations.push([ar, m]);
  }
  for (const u of EXTRA_GETS()) {
    if (u.includes('undefined')) continue;
    const r = await call('GET', u);
    stats.apiCalls++;
    checkApi('GET', u, r, 'report-matrix');
  }
  // ---- mutation phase: non-DELETE first, DELETE (on real ids) last, destructive routes only
  // with bodies that cannot validate.
  mutations.sort((a, b) => (a[1] === 'DELETE') - (b[1] === 'DELETE'));
  console.log(`  mutation calls on ${mutations.length} (route, method) pairs`);
  n = 0;
  for (const [ar, m] of mutations) {
    n++;
    if (n % 50 === 0) console.log(`  … ${n}/${mutations.length} mutations`);
    const destructive = DESTRUCTIVE.has(ar.route);
    const bodies = destructive ? DESTRUCTIVE_BODIES : INVALID_BODIES;
    const pathsToTry = [];
    if (ar.route.includes('[')) {
      // Unknown / garbage ids first (must be 4xx), then the real id with invalid bodies.
      pathsToTry.push([resolvePath(ar.route, apiIdFor, bogusIdFor('uuid')), 'unknown-id']);
      pathsToTry.push([resolvePath(ar.route, apiIdFor, bogusIdFor('garbage')), 'garbage-id']);
      if (!destructive && m !== 'DELETE') pathsToTry.push([resolvePath(ar.route, apiIdFor), 'real-id']);
    } else pathsToTry.push([ar.route, 'plain']);
    for (const [u, label] of pathsToTry) {
      if (!u) continue;
      for (const [bname, body] of (m === 'DELETE' ? [['no-body', undefined], ...bodies.slice(0, 1)] : bodies)) {
        const r = await call(m, u, body);
        stats.apiCalls++;
        checkApi(m, u, r, `${label}/${bname}`, body);
      }
    }
    await ensureSession();
  }
  // Finally DELETE real ids (should be 2xx or 4xx, never 5xx).
  for (const [ar, m] of mutations) {
    if (m !== 'DELETE' || !ar.route.includes('[') || DESTRUCTIVE.has(ar.route)) continue;
    const u = resolvePath(ar.route, apiIdFor);
    if (!u) continue;
    const r = await call(m, u);
    stats.apiCalls++;
    checkApi(m, u, r, 'real-id-delete');
    await ensureSession();
  }
}

const MALFORMED_VALUE = /"(?:NaN|Infinity|-Infinity|Invalid Date|\[object Object\])"|:\s*NaN\b|"undefined"/;
function checkApi(method, u, r, label, body) {
  const probs = [];
  if (isBad(r)) probs.push(`HTTP ${r.status}`);
  if (typeof r.data === 'symbol') probs.push('malformed JSON body');
  if (method === 'GET' && typeof r.status === 'number' && r.status < 300 && typeof r.text === 'string' && /json/.test(r.ct) && MALFORMED_VALUE.test(r.text)) {
    probs.push(`suspicious value ${MALFORMED_VALUE.exec(r.text)[0]}`);
  }
  if (r.ms > 15000 && r.status !== 'HANG') probs.push(`slow (${r.ms} ms)`);
  if (probs.length) {
    record('api', method, u, r, `${label}: ${probs.join('; ')}`, body);
    console.log(`  ✗ ${method} ${u} [${label}]: ${probs.join('; ')} ${typeof r.text === 'string' ? r.text.slice(0, 160) : ''}`);
  }
}

let creds = null;
async function ensureSession() {
  const me = await call('GET', '/api/auth/me');
  const authed = me.status === 200 && me.data && typeof me.data === 'object' && me.data.id && me.data.companyId;
  if (authed) return;
  console.log('  (session lost — re-unlocking and signing in again)');
  await call('POST', '/api/unlock', {});
  if (creds) await call('POST', '/api/auth/login', { email: creds.email, password: creds.password });
}

// ---------------------------------------------------------------------------------------------
// Collect real ids for every [id] API route from its list endpoint.
// ---------------------------------------------------------------------------------------------
async function collectSegmentIds() {
  const prefixes = new Set();
  for (const ar of apiRoutes) {
    const i = ar.route.indexOf('/[');
    if (i > 0) prefixes.add(ar.route.slice(0, i));
  }
  for (const p of prefixes) {
    if (p.includes('[')) continue;
    const r = await call('GET', p);
    const rows = listOf(r.data);
    const row = rows.find((x) => x && x.id);
    if (row) SEG_IDS[p] = row.id;
  }
  // Seeded ids win where the list is ambiguous.
  const pref = {
    '/api/customers': S.customer, '/api/vendors': S.vendor, '/api/items': S.invItem, '/api/invoices': S.invoice,
    '/api/bills': S.bill, '/api/payments': S.payment, '/api/deposits': S.deposit, '/api/estimates': S.estimate,
    '/api/sales-orders': S.so, '/api/purchase-orders': S.po, '/api/item-receipts': S.itemReceipt, '/api/credit-memos': S.creditMemo,
    '/api/vendor-credits': S.vendorCredit, '/api/journal-entries': S.je, '/api/transfers': S.transfer, '/api/expenses': S.check,
    '/api/bill-payments': S.billPayment, '/api/employees': S.employee, '/api/payroll': S.paycheck, '/api/budgets': S.budget,
    '/api/reconciliations': S.recon, '/api/fixed-assets': S.fixedAsset, '/api/recurring': S.recurring, '/api/accounts': S.bank,
    '/api/registers': S.bank, '/api/sales-receipts': S.salesReceipt, '/api/receipts': S.receipt, '/api/inventory/center': S.invItem,
    '/api/pricing/customers': S.customer, '/api/receiving/po': S.po, '/api/time-entries': S.timeEntry, '/api/jobs': S.job,
    '/api/companies': S.companyId, '/api/users': S.userId, '/api/sales-forms/invoice': S.invoice, '/api/fiscal-periods': S.fiscalPeriod,
    '/api/loans': S.loan, '/api/leads': S.lead, '/api/todos': S.todo, '/api/classes': S.class, '/api/inventory-sites': S.site,
    '/api/attachments': S.attachment, '/api/bank-transactions': S.bankTxn, '/api/landed-cost': S.landedCost,
  };
  for (const [k, v] of Object.entries(pref)) if (v) SEG_IDS[k] = v;
  if (S.otherUser) SEG_IDS['/api/users'] = S.otherUser;
  if (S.roleKey) SEG_IDS['/api/roles'] = S.roleKey;
  // Nested list routes: /api/lists/terms/[id], /api/type-lists/customer/[id], /api/sales-forms/invoice/[id]
  const terms = listOf((await call('GET', '/api/lists/terms')).data?.entries);
  if (terms[0]?.id) SEG_IDS['/api/lists/terms'] = terms[0].id;
  const types = listOf((await call('GET', '/api/type-lists/customer')).data?.types);
  if (types[0]?.id) SEG_IDS['/api/type-lists/customer'] = types[0].id;
  const todos = listOf((await call('GET', '/api/todos')).data?.todos);
  if (todos[0]?.id) SEG_IDS['/api/todos'] = SEG_IDS['/api/calendar/todos'] = todos[0].id;
  if (S.invoice) SEG_IDS['/api/sales-forms/invoice'] = S.invoice;
  // Never let the crawl act on our own session / company with real ids.
  delete SEG_IDS['/api/sessions'];
  delete SEG_IDS['/api/companies'];
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
async function main() {
  if (!(await waitUp())) throw new Error('server did not start' + (serverExited ? ` (exited ${JSON.stringify(serverExited)})` : ''));
  console.log(`Crawl: server up on ${BASE} (data ${dataDir})`);
  await seed();
  await collectSegmentIds();
  if (!ONLY || ONLY === 'pages') await crawlPages();
  if (!ONLY || ONLY === 'api') await crawlApi();
}

function finish(code) {
  // Unattributed server errors (logged while no request was in flight, or never tied to a finding).
  const errLines = serverLines.filter((l) => /\bError\b|⨯|Unhandled|uncaught|ECONN|TypeError|ReferenceError|RangeError/i.test(l.line));
  const summary = {
    when: new Date().toISOString(), base: BASE, stats, seedFailures: seedLog.filter((s) => !(typeof s.status === 'number' && s.status < 300)),
    seeded: S, findings, serverErrorLines: errLines.slice(0, 500).map((l) => ({ during: l.during, line: l.line.slice(0, 500) })),
  };
  if (serverExited) {
    findings.push({ severity: 'error', phase: 'server', method: '-', url: '-', status: 'EXIT', note: `server process exited during the crawl: ${JSON.stringify(serverExited)}` });
  }
  const errors = findings.filter((x) => x.severity === 'error');
  const warnings = findings.filter((x) => x.severity !== 'error');
  summary.errors = errors.length;
  summary.warnings = warnings.length;
  writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(summary, null, 2));
  writeFileSync(path.join(OUT, 'server.log'), serverLines.map((l) => `[${l.during || '-'}] ${l.line}`).join('\n'));
  console.log(`\nSUMMARY: ${stats.pages} page routes (${stats.pageUrls} URLs), ${stats.apiRoutes} API route files, ${stats.apiCalls} API calls`);
  console.log(`  seed failures: ${summary.seedFailures.length} · errors: ${errors.length} · warnings: ${warnings.length} · server error lines: ${errLines.length}`);
  for (const e of errors.slice(0, 40)) console.log(`  ERROR ${e.method} ${e.url} → ${e.status}: ${e.note}`);
  const failed = code !== 0 || errors.length > 0;
  const keep = failed || process.env.CRAWL_KEEP === '1';
  console.log(keep ? `  results kept in ${tempRoot} (results.json, server.log)` : '  temp root removed');
  console.log(failed ? '\nCRAWL FAILED' : '\nCRAWL PASSED');
  try { server.kill(); } catch {}
  setTimeout(() => {
    if (!keep) {
      // A passing run leaves nothing behind.
      try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
    }
    process.exit(failed ? 1 : 0);
  }, 1500);
}

main()
  .then(() => finish(0))
  .catch((e) => { console.error('CRAWL ERROR:', e?.stack || e); finish(1); });
