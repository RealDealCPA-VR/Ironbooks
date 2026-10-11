'use client';

/**
 * QuickBooks list import — step 1 of the "Migrate from QuickBooks" page (app/qb-import/page.tsx).
 *
 * Supports two import paths:
 *   IIF  — paste (or open-file) the raw IIF text; imports accounts, customers,
 *          vendors, classes, items, employees, and TRNS/SPL transactions
 *          (posted as balanced journal entries).
 *   CSV  — paste CSV, choose kind (customers | vendors | items | accounts),
 *          map columns.
 *
 * Every import returns per-row issues (skips, duplicates, code remaps,
 * auto-created accounts) which are rendered in a detail table below the counts.
 *
 * Uses window.bookkeeper?.openFile?.() when running inside the Electron shell,
 * with a plain <textarea> fallback for browser use.
 */
import { useState } from 'react';
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Format = 'iif' | 'csv';
type CsvKind = 'customers' | 'vendors' | 'items' | 'accounts';

interface ImportIssue {
  entity: string;
  name: string;
  code?: string;
  reason: string;
  message: string;
}

interface ImportCounts {
  accounts: number;
  customers: number;
  vendors: number;
  classes: number;
  items: number;
  employees: number;
  transactions: number;
  skipped: number;
  issues: ImportIssue[];
}

/** CSV column-mapping fields shown in the UI, per kind. */
const CSV_FIELDS: Record<CsvKind, Array<{ key: string; label: string }>> = {
  customers: [
    { key: 'displayName', label: 'Display Name *' },
    { key: 'companyName', label: 'Company Name' },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'billingAddress_line1', label: 'Billing Address Line 1' },
    { key: 'billingAddress_city', label: 'Billing City' },
    { key: 'billingAddress_state', label: 'Billing State' },
    { key: 'billingAddress_zip', label: 'Billing Zip' },
    { key: 'notes', label: 'Notes' },
  ],
  vendors: [
    { key: 'displayName', label: 'Display Name *' },
    { key: 'companyName', label: 'Company Name' },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'address_line1', label: 'Address Line 1' },
    { key: 'address_city', label: 'City' },
    { key: 'address_state', label: 'State' },
    { key: 'address_zip', label: 'Zip' },
    { key: 'notes', label: 'Notes' },
  ],
  items: [
    { key: 'name', label: 'Item Name *' },
    { key: 'sku', label: 'SKU' },
    { key: 'type', label: 'Type (service / inventory / non-inventory)' },
    { key: 'description', label: 'Description' },
    { key: 'salesPrice', label: 'Sales Price' },
    { key: 'purchaseCost', label: 'Purchase Cost' },
    { key: 'incomeAccount', label: 'Income Account (name or code)' },
    { key: 'expenseAccount', label: 'Expense/COGS Account (name or code)' },
    { key: 'assetAccount', label: 'Inventory Asset Account (name or code)' },
  ],
  accounts: [
    { key: 'name', label: 'Account Name *' },
    { key: 'code', label: 'Account Code / Number' },
    { key: 'type', label: 'Type (asset / liability / … or QB type like BANK)' },
    { key: 'subtype', label: 'Subtype' },
    { key: 'description', label: 'Description' },
  ],
};

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

  // Detect whether Electron file-open API is available.
  const canOpenFile =
    typeof window !== 'undefined' &&
    typeof (window as unknown as Record<string, unknown>).bookkeeper === 'object' &&
    typeof ((window as unknown as Record<string, unknown>).bookkeeper as Record<string, unknown>)?.openFile === 'function';

  const csvFields = CSV_FIELDS[csvKind];
  const csvHeaders = parseCsvHeaders(content);

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
    if (!content.trim()) {
      toast('Please paste or open a file first.', 'danger');
      return;
    }
    if (format === 'csv' && !mapping[REQUIRED_FIELD[csvKind]]) {
      toast(`Please map the ${csvKind === 'customers' || csvKind === 'vendors' ? 'Display Name' : 'Name'} column.`, 'danger');
      return;
    }

    setLoading(true);
    setResult(null);
    try {
      const body =
        format === 'iif'
          ? { format: 'iif', content }
          : { format: 'csv', kind: csvKind, content, mapping };

      const counts = await api.post<ImportCounts>('/api/import/qb', body);
      setResult(counts);
      const total =
        counts.accounts + counts.customers + counts.vendors + counts.classes +
        counts.items + counts.employees + counts.transactions;
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
          {(['iif', 'csv'] as Format[]).map((f) => (
            <Button
              key={f}
              variant={format === f ? 'primary' : 'secondary'}
              onClick={() => { setFormat(f); handleReset(); }}
            >
              {f.toUpperCase()}
              {f === 'iif' && (
                <span className="ml-1 text-xs opacity-70">
                  (accounts, lists, items, employees + transactions)
                </span>
              )}
            </Button>
          ))}
        </div>

        {format === 'csv' && (
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
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-navy">Paste or open the file</h2>
          {canOpenFile && (
            <Button variant="secondary" size="sm" onClick={handleOpenFile}>
              Open file…
            </Button>
          )}
        </div>

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

        {content && (
          <p className="text-xs text-navy/50">
            {content.split('\n').length} lines loaded.
          </p>
        )}
      </Card>

      {/* ---- CSV column mapping ---- */}
      {format === 'csv' && content && csvHeaders.length > 0 && (
        <Card className="p-6 space-y-4">
          <h2 className="text-lg font-bold text-navy">Match the columns</h2>
          <p className="text-sm text-navy/60">
            Match each field to the column in your CSV. Only the * field is required.
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
          disabled={!content.trim()}
          className="min-w-[140px]"
        >
          Run Import
        </Button>
        {content && (
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
                <ResultBadge label="Transactions" count={result.transactions} />
              </>
            )}
            {format === 'csv' && csvKind === 'accounts' && (
              <ResultBadge label="Accounts" count={result.accounts} />
            )}
            {format === 'csv' && csvKind === 'items' && (
              <ResultBadge label="Items" count={result.items} />
            )}
            <ResultBadge label="Customers" count={result.customers} />
            <ResultBadge label="Vendors" count={result.vendors} />
            <ResultBadge label="Skipped" count={result.skipped} tone="neutral" />
          </div>

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
