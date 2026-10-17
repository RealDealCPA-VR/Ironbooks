'use client';

/**
 * QuickBooks list import — step 1 of the "Migrate from QuickBooks" page (app/qb-import/page.tsx).
 *
 * Supports three import paths:
 *   IIF   — paste (or open-file) the raw IIF text; imports the account hierarchy, customers
 *           (+ jobs), vendors, classes, items, employees, other lists, and TRNS/SPL
 *           transactions (posted as balanced journal entries — or, optionally, open invoices
 *           and bills as real documents).
 *   CSV   — paste CSV, choose kind (customers | vendors | items | accounts), map columns.
 *   Excel — pick an .xlsx workbook, choose kind, map columns (same importers as CSV).
 *
 * Every import returns per-row issues (skips, duplicates, code remaps,
 * auto-created accounts) which are rendered in a detail table below the counts.
 *
 * Uses window.bookkeeper?.openFile?.() when running inside the Electron shell,
 * with a plain <textarea> fallback for browser use.
 */
import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Select,
  Label,
  Badge,
  Table,
  Th,
  Td,
  Tr,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Format = 'iif' | 'csv' | 'xlsx';
type CsvKind = 'customers' | 'vendors' | 'items' | 'accounts';

interface ImportIssue {
  entity: string;
  name: string;
  code?: string;
  reason: string;
  message: string;
}

interface DeferredList {
  list: string;
  label: string;
  count: number;
  note: string;
}

interface ImportCounts {
  accounts: number;
  customers: number;
  vendors: number;
  classes: number;
  items: number;
  employees: number;
  jobs?: number;
  transactions: number;
  lists?: Record<string, number>;
  deferred?: DeferredList[];
  openItems?: { invoices: number; bills: number; credits: number; skipped: number };
  /** G1: inventory items brought in with a quantity on hand, and its total value. */
  openingStock?: { items: number; value: string; unposted?: number };
  skipped: number;
  issues: ImportIssue[];
}

/** Read a picked file as text, or as base64 for Excel workbooks. */
function readFile(file: File, asBase64: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(asBase64 ? result.replace(/^data:[^,]*,/, '') : result);
    };
    if (asBase64) reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}

/**
 * CSV column-mapping fields shown in the UI, per kind. `aliases` are column headings (compared
 * case-insensitively) that are matched to the field automatically — they include the headings of
 * Ironbooks' own list export (lib/services/listExport.ts), so a list exported here re-imports
 * without mapping by hand.
 */
type CsvField = { key: string; label: string; aliases?: string[] };
export const CSV_FIELDS: Record<CsvKind, CsvField[]> = {
  customers: [
    { key: 'displayName', label: 'Display Name *', aliases: ['name', 'display name', 'customer', 'customer name'] },
    { key: 'companyName', label: 'Company Name', aliases: ['company', 'company name'] },
    { key: 'email', label: 'Email', aliases: ['email', 'e-mail'] },
    { key: 'phone', label: 'Phone', aliases: ['phone'] },
    { key: 'billingAddress_line1', label: 'Billing Address Line 1', aliases: ['billing street 1', 'billing address line 1', 'bill to 1'] },
    { key: 'billingAddress_line2', label: 'Billing Address Line 2', aliases: ['billing street 2', 'billing address line 2', 'bill to 2'] },
    { key: 'billingAddress_city', label: 'Billing City', aliases: ['billing city'] },
    { key: 'billingAddress_state', label: 'Billing State', aliases: ['billing state'] },
    { key: 'billingAddress_zip', label: 'Billing Zip', aliases: ['billing zip', 'billing postal code'] },
    { key: 'billingAddress_country', label: 'Billing Country', aliases: ['billing country'] },
    { key: 'terms', label: 'Terms (e.g. Net 30)', aliases: ['terms'] },
    { key: 'notes', label: 'Notes', aliases: ['notes'] },
  ],
  vendors: [
    { key: 'displayName', label: 'Display Name *', aliases: ['name', 'display name', 'vendor', 'vendor name'] },
    { key: 'companyName', label: 'Company Name', aliases: ['company', 'company name'] },
    { key: 'email', label: 'Email', aliases: ['email', 'e-mail'] },
    { key: 'phone', label: 'Phone', aliases: ['phone'] },
    { key: 'address_line1', label: 'Address Line 1', aliases: ['street', 'address line 1'] },
    { key: 'address_city', label: 'City', aliases: ['city'] },
    { key: 'address_state', label: 'State', aliases: ['state'] },
    { key: 'address_zip', label: 'Zip', aliases: ['zip', 'postal code'] },
    { key: 'terms', label: 'Terms (e.g. Net 30)', aliases: ['terms'] },
    { key: 'is1099', label: '1099 Vendor (Y / N)', aliases: ['1099 vendor', '1099', 'eligible for 1099'] },
    { key: 'notes', label: 'Notes', aliases: ['notes'] },
  ],
  items: [
    { key: 'name', label: 'Item Name *', aliases: ['name', 'item name', 'item'] },
    { key: 'sku', label: 'SKU', aliases: ['sku'] },
    { key: 'type', label: 'Type (service / inventory / non-inventory)', aliases: ['type'] },
    { key: 'description', label: 'Description', aliases: ['description'] },
    { key: 'salesPrice', label: 'Sales Price', aliases: ['sales price', 'price'] },
    { key: 'purchaseCost', label: 'Purchase Cost', aliases: ['purchase cost', 'cost'] },
    { key: 'incomeAccount', label: 'Income Account (name or code)', aliases: ['income account'] },
    { key: 'expenseAccount', label: 'Expense/COGS Account (name or code)', aliases: ['expense account', 'cogs account'] },
    { key: 'assetAccount', label: 'Inventory Asset Account (name or code)', aliases: ['asset account', 'inventory asset account'] },
    { key: 'taxable', label: 'Taxable (Y / N)', aliases: ['taxable'] },
    // G1: opening stock for inventory items (Inventory Asset vs Opening Balance Equity). Not
    // auto-matched: mapping it posts opening stock, so the user chooses it.
    { key: 'quantityOnHand', label: 'Quantity on Hand (inventory items)' },
    { key: 'totalValue', label: 'Total Value of that quantity (blank = quantity × cost)' },
    { key: 'asOfDate', label: 'As of Date for the quantity (blank = today)' },
  ],
  accounts: [
    { key: 'name', label: 'Account Name *', aliases: ['name', 'account name', 'account'] },
    { key: 'code', label: 'Account Code / Number', aliases: ['code', 'number', 'account number', 'accnt #'] },
    { key: 'type', label: 'Type (asset / liability / … or QB type like BANK)', aliases: ['type'] },
    { key: 'subtype', label: 'Subtype', aliases: ['subtype', 'detail type'] },
    { key: 'description', label: 'Description', aliases: ['description'] },
    { key: 'parent', label: 'Parent Account (name, code or Parent:Sub)', aliases: ['parent code', 'parent', 'parent account'] },
  ],
};

/**
 * Columns whose heading matches a field's aliases, for the fields not mapped yet (a choice the
 * user already made is never replaced). Exported for tests.
 */
export function autoMapColumns(
  fields: CsvField[],
  headers: string[],
  current: Record<string, string>,
): Record<string, string> {
  const byHeading = new Map(headers.map((h) => [h.trim().toLowerCase(), h]));
  // Columns already taken by this kind's fields (a mapping left over from another kind doesn't count).
  const used = new Set(fields.map((f) => current[f.key]).filter(Boolean));
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (current[f.key]) continue;
    const hit = (f.aliases ?? []).map((a) => byHeading.get(a)).find((h): h is string => !!h && !used.has(h));
    if (hit) {
      out[f.key] = hit;
      used.add(hit);
    }
  }
  return out;
}

/** The field that must be mapped before a CSV import can run, per kind. */
const REQUIRED_FIELD: Record<CsvKind, string> = {
  customers: 'displayName',
  vendors: 'displayName',
  items: 'name',
  accounts: 'name',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the first CSV header row to offer as mapping options. */
function parseCsvHeaders(content: string): string[] {
  const firstLine = content.split(/\r?\n/)[0] ?? '';
  if (!firstLine.trim()) return [];
  return firstLine.split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export function ListImport() {
  const [format, setFormat] = useState<Format>('iif');
  const [csvKind, setCsvKind] = useState<CsvKind>('customers');
  const [content, setContent] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportCounts | null>(null);
  // Excel: the workbook bytes (base64) + the header row the server found.
  const [xlsxData, setXlsxData] = useState('');
  const [xlsxName, setXlsxName] = useState('');
  const [xlsxHeaders, setXlsxHeaders] = useState<string[]>([]);
  // IIF: bring open invoices / bills in as documents (A/R and A/P detail).
  const [openItemsAsDocs, setOpenItemsAsDocs] = useState(false);
  const [alreadyInGl, setAlreadyInGl] = useState(true);

  // Detect whether Electron file-open API is available.
  const canOpenFile =
    typeof window !== 'undefined' &&
    typeof (window as unknown as Record<string, unknown>).bookkeeper === 'object' &&
    typeof ((window as unknown as Record<string, unknown>).bookkeeper as Record<string, unknown>)?.openFile === 'function';

  const csvFields = CSV_FIELDS[csvKind];
  const csvHeaders = format === 'xlsx' ? xlsxHeaders : parseCsvHeaders(content);
  const hasInput = format === 'xlsx' ? !!xlsxData : !!content.trim();

  // Match columns by heading as soon as a file's headings are known (or the list kind changes);
  // only fields the user has not mapped are filled in.
  const headerKey = csvHeaders.join('\u0001');
  useEffect(() => {
    if (format === 'iif' || !headerKey) return;
    setMapping((prev) => {
      const auto = autoMapColumns(CSV_FIELDS[csvKind], headerKey.split('\u0001'), prev);
      return Object.keys(auto).length ? { ...prev, ...auto } : prev;
    });
  }, [format, csvKind, headerKey]);

  // ---- Browser file picker ----
  async function handlePickFile(file: File | undefined) {
    if (!file) return;
    try {
      if (format === 'xlsx') {
        const data = await readFile(file, true);
        setXlsxData(data);
        setXlsxName(file.name);
        setMapping({});
        const preview = await api.post<{ headers: string[]; total: number }>('/api/import/qb', {
          format: 'xlsx',
          data,
          preview: true,
        });
        setXlsxHeaders(preview.headers);
        toast(`${preview.total} rows found in ${file.name}.`, 'info');
      } else {
        setContent(await readFile(file, false));
        setMapping({});
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not read the file.', 'danger');
    }
  }

  // ---- Open file via Electron bridge ----
  async function handleOpenFile() {
    try {
      const bk = (window as unknown as Record<string, unknown>).bookkeeper as Record<string, unknown>;
      // electron/main.js resolves { filePath, content } (or null when cancelled).
      const picked = await (bk.openFile as () => Promise<{ content: string } | string | null>)();
      const fileContent = typeof picked === 'string' ? picked : picked?.content;
      if (fileContent) setContent(fileContent);
    } catch {
      toast('Could not open file.', 'danger');
    }
  }

  // ---- Column mapping change ----
  function handleMappingChange(field: string, csvCol: string) {
    setMapping((prev) => ({ ...prev, [field]: csvCol }));
  }

  // ---- Submit ----
  async function handleImport() {
    if (!hasInput) {
      toast('Please paste or open a file first.', 'danger');
      return;
    }
    if (format !== 'iif' && !mapping[REQUIRED_FIELD[csvKind]]) {
      toast(`Please map the ${csvKind === 'customers' || csvKind === 'vendors' ? 'Display Name' : 'Name'} column.`, 'danger');
      return;
    }

    setLoading(true);
    setResult(null);
    try {
      const body =
        format === 'iif'
          ? {
              format: 'iif',
              content,
              ...(openItemsAsDocs ? { openItems: { asDocuments: true, alreadyInGl } } : {}),
            }
          : format === 'xlsx'
            ? { format: 'xlsx', kind: csvKind, data: xlsxData, mapping }
            : { format: 'csv', kind: csvKind, content, mapping };

      const counts = await api.post<ImportCounts>('/api/import/qb', body);
      setResult(counts);
      const total =
        counts.accounts + counts.customers + counts.vendors + counts.classes +
        counts.items + counts.employees + counts.transactions + (counts.jobs ?? 0) +
        Object.values(counts.lists ?? {}).reduce((a, b) => a + b, 0) +
        (counts.openItems ? counts.openItems.invoices + counts.openItems.bills + counts.openItems.credits : 0);
      toast(
        `Import complete: ${total} created, ${counts.skipped} skipped.`,
        total > 0 ? 'success' : 'info',
      );
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Import failed.';
      toast(msg, 'danger');
    } finally {
      setLoading(false);
    }
  }

  // ---- Reset ----
  function handleReset() {
    setContent('');
    setMapping({});
    setResult(null);
    setXlsxData('');
    setXlsxName('');
    setXlsxHeaders([]);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6">

      {/* ---- Format selector ---- */}
      <Card className="p-6 space-y-4">
        <h2 className="text-lg font-bold text-navy">Choose what to import</h2>
        <div className="flex gap-3">
          {(['iif', 'csv', 'xlsx'] as Format[]).map((f) => (
            <Button
              key={f}
              variant={format === f ? 'primary' : 'secondary'}
              onClick={() => { setFormat(f); handleReset(); }}
            >
              {f === 'xlsx' ? 'Excel' : f.toUpperCase()}
              {f === 'iif' && (
                <span className="ml-1 text-xs opacity-70">
                  (accounts, lists, items, employees + transactions)
                </span>
              )}
            </Button>
          ))}
        </div>

        {format === 'iif' && (
          <div className="space-y-2 rounded-lg bg-slate-50 p-3">
            <label className="flex items-start gap-2 text-sm text-navy">
              <input
                type="checkbox"
                className="mt-1"
                checked={openItemsAsDocs}
                onChange={(e) => setOpenItemsAsDocs(e.target.checked)}
              />
              <span>
                Bring in unpaid invoices and bills as real documents, so you can receive payments and pay
                bills against them. Invoices QuickBooks marked paid are left out.
              </span>
            </label>
            {openItemsAsDocs && (
              <label className="flex items-start gap-2 text-sm text-navy pl-6">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={alreadyInGl}
                  onChange={(e) => setAlreadyInGl(e.target.checked)}
                />
                <span>
                  My General Ledger history is already imported (or will be). Keep the A/R and A/P totals exactly
                  as they are — the documents only add the per-customer and per-vendor detail.
                </span>
              </label>
            )}
          </div>
        )}

        {format !== 'iif' && (
          <div>
            <Label>Import kind</Label>
            <Select
              value={csvKind}
              onChange={(e) => { setCsvKind(e.target.value as CsvKind); setMapping({}); }}
              className="max-w-xs"
            >
              <option value="customers">Customers</option>
              <option value="vendors">Vendors</option>
              <option value="items">Items (Products & Services)</option>
              <option value="accounts">Chart of Accounts</option>
            </Select>
          </div>
        )}
      </Card>

      {/* ---- File content ---- */}
      <Card className="p-6 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-lg font-bold text-navy">
            {format === 'xlsx' ? 'Choose the Excel workbook' : 'Paste or open the file'}
          </h2>
          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-navy cursor-pointer hover:bg-slate-50">
              Choose file…
              <input
                type="file"
                className="sr-only"
                accept={format === 'xlsx' ? '.xlsx' : format === 'iif' ? '.iif,.txt' : '.csv,.txt'}
                onChange={(e) => {
                  void handlePickFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </label>
            {canOpenFile && format !== 'xlsx' && (
              <Button variant="secondary" size="sm" onClick={handleOpenFile}>
                Open file…
              </Button>
            )}
          </div>
        </div>

        {format === 'xlsx' ? (
          <p className="text-sm text-navy/60">
            {xlsxName
              ? `${xlsxName} — ${xlsxHeaders.length} columns found on the first sheet.`
              : 'The first row of the first sheet must hold the column headings.'}
          </p>
        ) : (
        <textarea
          value={content}
          onChange={(e) => { setContent(e.target.value); setMapping({}); }}
          placeholder={
            format === 'iif'
              ? 'Paste IIF file content here…'
              : 'Paste CSV file content here (first row must be headers)…'
          }
          rows={10}
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-navy font-mono outline-none focus:border-electric focus:ring-2 focus:ring-electric/30 placeholder:text-navy/30 resize-y"
        />
        )}

        {content && format !== 'xlsx' && (
          <p className="text-xs text-navy/50">
            {content.split('\n').length} lines loaded.
          </p>
        )}
      </Card>

      {/* ---- CSV column mapping ---- */}
      {format !== 'iif' && hasInput && csvHeaders.length > 0 && (
        <Card className="p-6 space-y-4">
          <h2 className="text-lg font-bold text-navy">Match the columns</h2>
          <p className="text-sm text-navy/60">
            Match each field to the column in your file. Only the * field is required. Columns with a
            matching heading (for example a list exported from Ironbooks) are matched for you.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            {csvFields.map(({ key, label }) => (
              <div key={key}>
                <Label>{label}</Label>
                <Select
                  value={mapping[key] ?? ''}
                  onChange={(e) => handleMappingChange(key, e.target.value)}
                >
                  <option value="">(not mapped)</option>
                  {csvHeaders.map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ---- Submit ---- */}
      <div className="flex items-center gap-4">
        <Button
          onClick={handleImport}
          loading={loading}
          disabled={!hasInput}
          className="min-w-[140px]"
        >
          Run Import
        </Button>
        {hasInput && (
          <Button variant="ghost" onClick={handleReset} disabled={loading}>
            Clear
          </Button>
        )}
      </div>

      {/* ---- Results ---- */}
      {result && (
        <Card className="p-6 space-y-4">
          <h2 className="text-lg font-bold text-navy">Import results</h2>
          <div className="flex flex-wrap gap-3">
            {format === 'iif' && (
              <>
                <ResultBadge label="Accounts" count={result.accounts} />
                <ResultBadge label="Classes" count={result.classes} />
                <ResultBadge label="Items" count={result.items} />
                <ResultBadge label="Employees" count={result.employees} />
                <ResultBadge label="Jobs" count={result.jobs ?? 0} />
                <ResultBadge label="Transactions" count={result.transactions} />
                {Object.entries(result.lists ?? {}).map(([k, n]) => (
                  <ResultBadge key={k} label={LIST_LABEL[k] ?? k} count={n} />
                ))}
                {result.openItems && (
                  <>
                    <ResultBadge label="Open invoices" count={result.openItems.invoices} />
                    <ResultBadge label="Open bills" count={result.openItems.bills} />
                    <ResultBadge label="Open credits" count={result.openItems.credits} />
                  </>
                )}
              </>
            )}
            {format !== 'iif' && csvKind === 'accounts' && (
              <ResultBadge label="Accounts" count={result.accounts} />
            )}
            {format !== 'iif' && csvKind === 'items' && (
              <ResultBadge label="Items" count={result.items} />
            )}
            <ResultBadge label="Customers" count={result.customers} />
            <ResultBadge label="Vendors" count={result.vendors} />
            <ResultBadge label="Skipped" count={result.skipped} tone="neutral" />
          </div>
          {result.openingStock && result.openingStock.items > 0 && (
            <p className="text-sm text-navy/70">
              {result.openingStock.items} inventory item{result.openingStock.items === 1 ? '' : 's'} started with a
              quantity on hand worth {formatCurrency(result.openingStock.value)} in total (added to Inventory Asset
              against Opening Balance Equity).
              {(result.openingStock.unposted ?? 0) > 0 && (
                <>
                  {' '}
                  For {result.openingStock.unposted} of them the file already brings in the inventory asset balance, so
                  their stock was set up without a journal entry.
                </>
              )}
            </p>
          )}

          {(result.deferred ?? []).length > 0 && (
            <div className="rounded-lg border border-gold/40 bg-gold/10 p-3 space-y-1">
              <h3 className="text-sm font-bold text-navy">Read from the file, not added yet</h3>
              <ul className="text-xs text-navy/70 space-y-1">
                {(result.deferred ?? []).map((d) => (
                  <li key={d.list}>
                    <b>{d.label}</b> ({d.count}) — {d.note}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Per-row issues detail */}
          {result.issues.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-sm font-bold text-navy">
                Row details ({result.issues.length})
              </h3>
              <p className="text-xs text-navy/50">
                Every skipped row, duplicate, code remap, and auto-created account is listed
                below so nothing is silently dropped.
              </p>
              <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-100">
                <Table>
                  <thead>
                    <tr>
                      <Th>Entity</Th>
                      <Th>Name</Th>
                      <Th>Code</Th>
                      <Th>Reason</Th>
                      <Th>Detail</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.issues.map((issue, i) => (
                      <Tr key={i}>
                        <Td className="capitalize">{issue.entity}</Td>
                        <Td className="font-medium">{issue.name}</Td>
                        <Td className="font-mono text-xs">{issue.code ?? '—'}</Td>
                        <Td>
                          <Badge
                            tone={
                              issue.reason === 'duplicate'
                                ? 'neutral'
                                : issue.reason === 'validation'
                                  ? 'danger'
                                  : 'warning'
                            }
                          >
                            {issue.reason}
                          </Badge>
                        </Td>
                        <Td className="text-navy/70 text-xs">{issue.message}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </div>
          ) : (
            <p className="text-sm text-navy/60">All rows imported cleanly — no issues.</p>
          )}
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small helper component
// ---------------------------------------------------------------------------

const LIST_LABEL: Record<string, string> = {
  CTYPE: 'Customer types',
  VTYPE: 'Vendor types',
  SALESREP: 'Sales reps',
  BUD: 'Budget rows',
  INVITEMCOMP: 'Groups / assemblies',
};

function ResultBadge({
  label,
  count,
  tone = count > 0 ? 'success' : 'neutral',
}: {
  label: string;
  count: number;
  tone?: 'success' | 'neutral' | 'warning' | 'danger' | 'info';
}) {
  return (
    <div className="flex flex-col items-center gap-1 min-w-[80px]">
      <span className="text-2xl font-extrabold text-navy">{count}</span>
      <Badge tone={tone}>{label}</Badge>
    </div>
  );
}
