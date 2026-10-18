'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Landmark, ListChecks, Plus } from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  Input,
  Select,
  Label,
  Badge,
  Spinner,
  Table,
  Th,
  Td,
  Tr,
  Modal,
  PageHeader,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/dates';
import { StatementReview, type StatementExtract, type ReviewedStatement } from '@/components/StatementReview';
import { usePreferences } from '@/lib/usePreferences';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  /** wave2 purchases: currency of a bank / credit-card account (null = home). */
  currency?: string | null;
}

interface CurrencyRow {
  code: string;
  name: string;
  isBase: boolean;
}

interface BankAccount {
  id: string;
  accountId: string;
  bankName: string;
  accountNumber: string;
  lastReconciledDate: string | null;
  lastReconciledBalance: string | null;
  glAccountName: string;
  glAccountCode: string;
}

interface ImportSummary {
  fileImportId: string;
  parsed: number;
  imported: number;
  skippedDupes: number;
  errors: number;
}

interface CsvPreviewRow {
  date: string;
  description: string;
  amount: string;
  fitId?: string;
}

interface CsvPreviewResult {
  headers: string[];
  rows: CsvPreviewRow[];
  totalParsed: number;
  error: string | null;
}

/** Common bank-export date formats offered in the mapper. '' = auto-detect. */
const DATE_FORMATS = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'MM-DD-YYYY', 'DD.MM.YYYY'];

interface Rule {
  id: string;
  name: string;
  matchField: string;
  matchOperator: string;
  matchValue: string;
  setAccountId: string;
  priority: number;
  isActive: boolean;
}

// ---------------------------------------------------------------------------
// Add Bank Account Modal
// ---------------------------------------------------------------------------

function AddBankAccountModal({
  open,
  onClose,
  onAdded,
  glAccounts,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
  glAccounts: Account[];
}) {
  const [accountId, setAccountId] = useState('');
  const [bankName, setBankName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [saving, setSaving] = useState(false);

  // Reset on open
  useEffect(() => {
    if (open) {
      setAccountId('');
      setBankName('');
      setAccountNumber('');
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId || !bankName.trim()) {
      toast('GL account and bank name are required.', 'danger');
      return;
    }
    setSaving(true);
    try {
      await api.post('/api/bank-accounts', { accountId, bankName: bankName.trim(), accountNumber });
      toast('Bank account added.', 'success');
      onAdded();
      onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to add bank account.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add Bank Account"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={saving}>
            Add Account
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="ba-gl-account">GL Account (Asset or Liability)</Label>
          <Select
            id="ba-gl-account"
            autoFocus
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            required
          >
            <option value="">Select account…</option>
            {glAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name} ({a.type})
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="ba-bank-name">Bank Name</Label>
          <Input
            id="ba-bank-name"
            placeholder="e.g. Chase, Wells Fargo"
            value={bankName}
            onChange={(e) => setBankName(e.target.value)}
            required
          />
        </div>
        <div>
          <Label htmlFor="ba-account-number">Account Number (last 4 digits)</Label>
          <Input
            id="ba-account-number"
            placeholder="e.g. 4321"
            value={accountNumber}
            onChange={(e) => setAccountNumber(e.target.value)}
          />
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Add Rule Modal
// ---------------------------------------------------------------------------

function AddRuleModal({
  open,
  onClose,
  onAdded,
  allAccounts,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
  allAccounts: Account[];
}) {
  const [name, setName] = useState('');
  const [matchField, setMatchField] = useState<'description' | 'payee' | 'amount'>('description');
  const [matchOperator, setMatchOperator] = useState<'contains' | 'equals' | 'starts_with'>(
    'contains',
  );
  const [matchValue, setMatchValue] = useState('');
  const [setAccountId, setSetAccountId] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setMatchField('description');
      setMatchOperator('contains');
      setMatchValue('');
      setSetAccountId('');
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !matchValue.trim() || !setAccountId) {
      toast('Name, match value, and account are required.', 'danger');
      return;
    }
    setSaving(true);
    try {
      await api.post('/api/rules', {
        name: name.trim(),
        matchField,
        matchOperator,
        matchValue: matchValue.trim(),
        setAccountId,
      });
      toast('Categorization rule created.', 'success');
      onAdded();
      onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to create rule.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add Categorization Rule"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={saving}>
            Add Rule
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="rule-name">Rule Name</Label>
          <Input
            id="rule-name"
            autoFocus
            placeholder="e.g. Amazon purchases"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="rule-field">Match Field</Label>
            <Select
              id="rule-field"
              value={matchField}
              onChange={(e) =>
                setMatchField(e.target.value as 'description' | 'payee' | 'amount')
              }
            >
              <option value="description">Description</option>
              <option value="payee">Payee</option>
              <option value="amount">Amount</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="rule-operator">Operator</Label>
            <Select
              id="rule-operator"
              value={matchOperator}
              onChange={(e) =>
                setMatchOperator(e.target.value as 'contains' | 'equals' | 'starts_with')
              }
            >
              <option value="contains">Contains</option>
              <option value="equals">Equals</option>
              <option value="starts_with">Starts with</option>
            </Select>
          </div>
        </div>
        <div>
          <Label htmlFor="rule-value">Match Value</Label>
          <Input
            id="rule-value"
            placeholder="e.g. amazon"
            value={matchValue}
            onChange={(e) => setMatchValue(e.target.value)}
            required
          />
        </div>
        <div>
          <Label htmlFor="rule-account">Assign to Account</Label>
          <Select
            id="rule-account"
            value={setAccountId}
            onChange={(e) => setSetAccountId(e.target.value)}
            required
          >
            <option value="">Select account…</option>
            {allAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </Select>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// CSV column picker — a free-text Input until a preview detects the headers,
// then a Select over the detected column names (current value kept selectable).
// ---------------------------------------------------------------------------

function ColumnPicker({
  id,
  label,
  value,
  onChange,
  headers,
  placeholder,
  allowEmpty,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  headers?: string[];
  placeholder?: string;
  /** Render a "(none)" option (for optional columns like the transaction ID). */
  allowEmpty?: boolean;
}) {
  const hasHeaders = !!headers && headers.length > 0;
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      {hasHeaders ? (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {allowEmpty && <option value="">(none)</option>}
          {!allowEmpty && value && !headers!.includes(value) && (
            <option value={value}>{value} (not found)</option>
          )}
          {headers!.map((h) => (
            <option key={h} value={h}>{h}</option>
          ))}
        </Select>
      ) : (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    bookkeeper?: {
      openFile?: (opts?: { filters?: { name: string; extensions: string[] }[] }) => Promise<
        { content: string; filename: string } | null
      >;
    };
  }
}

/** OFX / QBO / CSV are text files; a statement (PDF or scan) and Excel are read on the server. */
type ImportKind = 'ofx' | 'qbo' | 'csv' | 'statement' | 'xlsx';
const BINARY_KINDS: ImportKind[] = ['statement', 'xlsx'];
const ACCEPT: Record<ImportKind, string> = {
  ofx: '.ofx,.qfx,.txt',
  qbo: '.qbo,.txt',
  csv: '.csv,.txt',
  statement: '.pdf,.png,.jpg,.jpeg,.webp',
  xlsx: '.xlsx',
};

/** File bytes → base64, in chunks (a long statement is several MB). */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export default function BankingPage() {
  const prefs = usePreferences();
  // Data state
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [glAccounts, setGlAccounts] = useState<Account[]>([]);
  const [allAccounts, setAllAccounts] = useState<Account[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [currencyList, setCurrencyList] = useState<CurrencyRow[]>([]);

  // Loading
  const [loadingBankAccounts, setLoadingBankAccounts] = useState(true);
  const [loadingRules, setLoadingRules] = useState(true);

  // Modals
  const [showAddBankAccount, setShowAddBankAccount] = useState(false);
  const [showAddRule, setShowAddRule] = useState(false);

  // Import form
  const [importBankAccountId, setImportBankAccountId] = useState('');
  const [importFileType, setImportFileType] = useState<ImportKind>('ofx');
  const [importContent, setImportContent] = useState('');
  const [importFilename, setImportFilename] = useState('');
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);

  // CSV mapping — the full mapper the import service supports
  const [csvDateCol, setCsvDateCol] = useState('Date');
  const [csvDescCol, setCsvDescCol] = useState('Description');
  const [csvAmountCol, setCsvAmountCol] = useState('Amount');
  const [csvSplitDebitCredit, setCsvSplitDebitCredit] = useState(false);
  const [csvDebitCol, setCsvDebitCol] = useState('Debit');
  const [csvCreditCol, setCsvCreditCol] = useState('Credit');
  const [csvFitIdCol, setCsvFitIdCol] = useState('');
  const [csvDateFormat, setCsvDateFormat] = useState('');
  const [csvSkipRows, setCsvSkipRows] = useState('0');
  const [csvFlipSign, setCsvFlipSign] = useState(false);
  const [csvPayeeCol, setCsvPayeeCol] = useState('');
  const [csvMemoCol, setCsvMemoCol] = useState('');
  const [csvCheckCol, setCsvCheckCol] = useState('');
  // Statement PDF / scan read on the server, waiting for review (lib/services/statementImport.ts).
  const [statementExtract, setStatementExtract] = useState<StatementExtract | null>(null);
  const [extracting, setExtracting] = useState(false);

  // CSV preview (server-side dry run via /api/import/csv-preview)
  const [csvPreview, setCsvPreview] = useState<CsvPreviewResult | null>(null);
  // Detected headers persist across mapping edits (they only depend on the file
  // + skipRows), so the column dropdowns stay usable while re-mapping.
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);

  // Browser file input fallback (Electron picker preferred when available)
  const importFileRef = useRef<HTMLInputElement>(null);

  function buildCsvMapping(): Record<string, unknown> {
    const skip = parseInt(csvSkipRows, 10);
    return {
      dateCol: csvDateCol,
      descriptionCol: csvDescCol,
      amountCol: csvAmountCol,
      ...(csvSplitDebitCredit ? { debitCol: csvDebitCol, creditCol: csvCreditCol } : {}),
      ...(csvFitIdCol.trim() ? { fitIdCol: csvFitIdCol.trim() } : {}),
      ...(csvDateFormat ? { dateFormat: csvDateFormat } : {}),
      ...(Number.isFinite(skip) && skip > 0 ? { skipRows: skip } : {}),
      ...(csvFlipSign ? { flipSign: true } : {}),
      ...(csvPayeeCol.trim() ? { payeeCol: csvPayeeCol.trim() } : {}),
      ...(csvMemoCol.trim() ? { memoCol: csvMemoCol.trim() } : {}),
      ...(csvCheckCol.trim() ? { checkNumberCol: csvCheckCol.trim() } : {}),
    };
  }

  // Any mapping/content change invalidates the current preview — the user must
  // re-preview before committing, so the table always reflects what will import.
  useEffect(() => {
    setCsvPreview(null);
  }, [
    importContent, importFileType, csvDateCol, csvDescCol, csvAmountCol,
    csvSplitDebitCredit, csvDebitCol, csvCreditCol, csvFitIdCol,
    csvDateFormat, csvSkipRows, csvFlipSign,
  ]);

  // Headers only change with the file content (or skipped preamble rows).
  useEffect(() => {
    setCsvHeaders([]);
  }, [importContent, importFileType]);

  async function runCsvPreview(content?: string): Promise<CsvPreviewResult | null> {
    const text = content ?? importContent;
    if (!text.trim()) {
      toast('Paste or load the CSV content first.', 'danger');
      return null;
    }
    setPreviewing(true);
    try {
      const result = await api.post<CsvPreviewResult>('/api/import/csv-preview', {
        content: text,
        csvMapping: buildCsvMapping(),
        limit: 10,
      });
      setCsvPreview(result);
      if (result.headers.length > 0) setCsvHeaders(result.headers);
      return result;
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Preview failed.', 'danger');
      return null;
    } finally {
      setPreviewing(false);
    }
  }

  // Fetch helpers
  const fetchBankAccounts = useCallback(async () => {
    setLoadingBankAccounts(true);
    try {
      const data = await api.get<BankAccount[]>('/api/bank-accounts');
      setBankAccounts(data);
    } catch {
      toast('Failed to load bank accounts.', 'danger');
    } finally {
      setLoadingBankAccounts(false);
    }
  }, []);

  const fetchRules = useCallback(async () => {
    setLoadingRules(true);
    try {
      const data = await api.get<Rule[]>('/api/rules');
      setRules(data);
    } catch {
      toast('Failed to load categorization rules.', 'danger');
    } finally {
      setLoadingRules(false);
    }
  }, []);

  const fetchAccounts = useCallback(async () => {
    try {
      const data = await api.get<Account[]>('/api/accounts');
      setAllAccounts(data);
      setGlAccounts(data.filter((a) => a.type === 'asset' || a.type === 'liability'));
    } catch {
      toast('Failed to load GL accounts.', 'danger');
    }
  }, []);

  useEffect(() => {
    fetchBankAccounts();
    fetchRules();
    fetchAccounts();
    api
      .get<CurrencyRow[]>('/api/currencies')
      .then(setCurrencyList)
      .catch(() => setCurrencyList([]));
  }, [fetchBankAccounts, fetchRules, fetchAccounts]);

  // Multi-currency: a bank / card account can hold a foreign currency (only before it is used).
  // A2: the currency column / picker only while Preferences > Multiple Currencies is on.
  const multiCurrency = currencyList.length > 1 && prefs.company.multiCurrencyEnabled;
  const homeCode = currencyList.find((c) => c.isBase)?.code ?? '';
  async function changeAccountCurrency(accountId: string, code: string) {
    try {
      await api.post('/api/banking/account-currency', { accountId, currency: code || null });
      toast('Account currency updated.', 'success');
    } catch (err) {
      toast(
        err instanceof Error ? err.message : 'Could not change the account currency.',
        'danger',
      );
    }
    await fetchAccounts();
  }

  // Auto-select first bank account for import when list loads
  useEffect(() => {
    if (bankAccounts.length > 0 && !importBankAccountId) {
      setImportBankAccountId(bankAccounts[0].id);
    }
  }, [bankAccounts, importBankAccountId]);

  /** Infer the import file type from a filename extension. .qfx is OFX-on-the-wire. */
  function fileTypeFromName(name: string): ImportKind | null {
    const ext = name.toLowerCase().split('.').pop() ?? '';
    if (ext === 'ofx' || ext === 'qfx') return 'ofx';
    if (ext === 'qbo') return 'qbo';
    if (ext === 'csv') return 'csv';
    if (ext === 'xlsx') return 'xlsx';
    if (['pdf', 'png', 'jpg', 'jpeg', 'webp'].includes(ext)) return 'statement';
    return null;
  }

  /** Statement PDF / scan or Excel: read on the server (nothing is imported yet). */
  async function extractFile(file: File) {
    if (!importBankAccountId) {
      toast('Select the bank or credit card account first.', 'danger');
      return;
    }
    setExtracting(true);
    setImportSummary(null);
    setStatementExtract(null);
    try {
      const result = await api.post<{ kind: 'csv'; csv: string; sheet: string } | StatementExtract>('/api/import/extract', {
        bankAccountId: importBankAccountId,
        filename: file.name,
        data: await fileToBase64(file),
      });
      if (result.kind === 'csv') {
        // Excel → CSV text, then the normal column mapper and preview.
        setImportFileType('csv');
        setImportContent(result.csv);
        setImportFilename(file.name);
        await runCsvPreview(result.csv);
        toast(`Read sheet "${result.sheet}". Check the column mapping, then import.`, 'info');
      } else {
        setImportFileType('statement');
        setImportFilename(file.name);
        setStatementExtract(result);
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not read that file.', 'danger');
    } finally {
      setExtracting(false);
    }
  }

  async function importStatement(reviewed: ReviewedStatement) {
    if (!statementExtract) return;
    setImporting(true);
    try {
      const summary = await api.post<ImportSummary>('/api/import', {
        bankAccountId: importBankAccountId,
        fileType: 'rows',
        rows: reviewed.rows,
        filename: importFilename || 'statement.pdf',
        statement: {
          kind: statementExtract.statementKind,
          openingBalance: reviewed.openingBalance,
          closingBalance: reviewed.closingBalance,
          acknowledgeDifference: reviewed.acknowledgeDifference,
        },
      });
      setImportSummary(summary);
      setStatementExtract(null);
      toast(`Import complete: ${summary.imported} imported, ${summary.skippedDupes} duplicates skipped. Review them in Review bank transactions.`, 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Import failed.', 'danger');
    } finally {
      setImporting(false);
    }
  }

  function applyLoadedFile(content: string, filename: string) {
    setImportContent(content);
    setImportFilename(filename);
    const inferred = fileTypeFromName(filename);
    if (inferred) setImportFileType(inferred);
    setImportSummary(null);
    toast(`Loaded: ${filename}`, 'info');
  }

  // Electron file picker (browser <input type=file> fallback below)
  async function handleOpenFile() {
    // .qfx is accepted everywhere .ofx is.
    const extensions: Record<string, string[]> = {
      ofx: ['ofx', 'qfx'],
      qbo: ['qbo'],
      csv: ['csv'],
    };
    // Binary files (PDF, images, Excel) are read as bytes through the file chooser.
    if (window.bookkeeper?.openFile && !BINARY_KINDS.includes(importFileType)) {
      const result = await window.bookkeeper.openFile({
        filters: [{ name: 'Bank file', extensions: extensions[importFileType] ?? ['*'] }],
      });
      if (result) applyLoadedFile(result.content, result.filename);
    } else {
      importFileRef.current?.click();
    }
  }

  async function handleBrowserFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    const kind = fileTypeFromName(file.name);
    if (kind && BINARY_KINDS.includes(kind)) {
      await extractFile(file);
      return;
    }
    try {
      const text = await file.text();
      applyLoadedFile(text, file.name);
    } catch {
      toast('Could not read that file.', 'danger');
    }
  }

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    if (!importBankAccountId) {
      toast('Select a bank account first.', 'danger');
      return;
    }
    if (!importContent.trim()) {
      toast('Paste or load the file content.', 'danger');
      return;
    }
    // CSV requires a clean preview of the CURRENT mapping before committing.
    if (importFileType === 'csv') {
      let preview = csvPreview;
      if (!preview) preview = await runCsvPreview();
      if (!preview) return;
      if (preview.error) {
        toast('Fix the column mapping — the preview shows a parse error.', 'danger');
        return;
      }
    }
    setImporting(true);
    setImportSummary(null);
    try {
      const body: Record<string, unknown> = {
        bankAccountId: importBankAccountId,
        fileType: importFileType,
        content: importContent,
        ...(importFilename ? { filename: importFilename } : {}),
      };
      if (importFileType === 'csv') {
        body.csvMapping = buildCsvMapping();
      }
      const summary = await api.post<ImportSummary>('/api/import', body);
      setImportSummary(summary);
      toast(
        `Import complete: ${summary.imported} imported, ${summary.skippedDupes} duplicates skipped.`,
        'success',
      );
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Import failed.', 'danger');
    } finally {
      setImporting(false);
    }
  }

  const operatorLabel: Record<string, string> = {
    contains: 'contains',
    equals: '=',
    starts_with: 'starts with',
  };

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Banking"
        icon={Landmark}
        action={
          <Button onClick={() => setShowAddBankAccount(true)}>
            <Plus className="h-4 w-4" /> Add Bank Account
          </Button>
        }
      />

      {/* ------------------------------------------------------------------ */}
      {/* Card 1: Bank Accounts                                               */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-6 mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-navy">Bank Accounts</h2>
          <Button size="sm" onClick={() => setShowAddBankAccount(true)}>
            <Plus className="h-4 w-4" />
            Add Bank Account
          </Button>
        </div>

        {loadingBankAccounts ? (
          <div className="py-10 flex justify-center">
            <Spinner className="text-electric" />
          </div>
        ) : bankAccounts.length === 0 ? (
          <EmptyState
            icon={Landmark}
            title="No bank accounts yet"
            message="Add one to start importing transactions."
            action={
              <Button onClick={() => setShowAddBankAccount(true)}>
                <Plus className="h-4 w-4" /> Add Bank Account
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>Bank</Th>
                <Th>Account #</Th>
                <Th>GL Account</Th>
                <Th>Last Reconciled</Th>
                <Th numeric>Reconciled Balance</Th>
                {multiCurrency && <Th>Currency</Th>}
              </Tr>
            </thead>
            <tbody>
              {bankAccounts.map((ba) => (
                <Tr key={ba.id}>
                  <Td className="font-medium">{ba.bankName}</Td>
                  <Td className="font-mono text-sm">{ba.accountNumber || '—'}</Td>
                  <Td>
                    <span className="text-navy/60 text-xs mr-1">{ba.glAccountCode}</span>
                    {ba.glAccountName}
                  </Td>
                  <Td>{formatDate(ba.lastReconciledDate)}</Td>
                  <Td numeric>
                    {ba.lastReconciledBalance != null
                      ? formatCurrency(ba.lastReconciledBalance)
                      : '—'}
                  </Td>
                  {multiCurrency && (
                    <Td>
                      <Select
                        aria-label={`Currency of ${ba.bankName}`}
                        value={allAccounts.find((a) => a.id === ba.accountId)?.currency ?? ''}
                        onChange={(e) => changeAccountCurrency(ba.accountId, e.target.value)}
                      >
                        <option value="">{homeCode ? `${homeCode} (home)` : 'Home currency'}</option>
                        {currencyList
                          .filter((c) => !c.isBase)
                          .map((c) => (
                            <option key={c.code} value={c.code}>
                              {c.code} — {c.name}
                            </option>
                          ))}
                      </Select>
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Card 2: Import Transactions                                          */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-6 mb-8">
        <h2 className="text-lg font-bold text-navy mb-4">Import Transactions</h2>
        <form onSubmit={handleImport} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="import-bank-account">Bank Account</Label>
              <Select
                id="import-bank-account"
                value={importBankAccountId}
                onChange={(e) => setImportBankAccountId(e.target.value)}
                required
              >
                <option value="">Select bank account…</option>
                {bankAccounts.map((ba) => (
                  <option key={ba.id} value={ba.id}>
                    {ba.bankName} {ba.accountNumber ? `(…${ba.accountNumber})` : ''}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="import-file-type">File Type</Label>
              <Select
                id="import-file-type"
                value={importFileType}
                onChange={(e) => {
                  setImportFileType(e.target.value as ImportKind);
                  setImportSummary(null);
                  setStatementExtract(null);
                }}
              >
                <option value="ofx">OFX / QFX</option>
                <option value="qbo">QBO (QuickBooks Online)</option>
                <option value="csv">CSV</option>
                <option value="xlsx">Excel (.xlsx)</option>
                <option value="statement">Bank statement (PDF or scan)</option>
              </Select>
            </div>
          </div>

          {/* CSV column mapping — full mapper + server-side preview */}
          {importFileType === 'csv' && (
            <div className="flex flex-col gap-4 p-4 rounded-lg bg-slate-50 border border-slate-200">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <ColumnPicker
                  id="csv-date"
                  label="Date column"
                  value={csvDateCol}
                  onChange={setCsvDateCol}
                  headers={csvHeaders}
                  placeholder="Date"
                />
                <ColumnPicker
                  id="csv-desc"
                  label="Description column"
                  value={csvDescCol}
                  onChange={setCsvDescCol}
                  headers={csvHeaders}
                  placeholder="Description"
                />
                {!csvSplitDebitCredit && (
                  <ColumnPicker
                    id="csv-amount"
                    label="Amount column"
                    value={csvAmountCol}
                    onChange={setCsvAmountCol}
                    headers={csvHeaders}
                    placeholder="Amount"
                  />
                )}
              </div>

              <label className="flex items-center gap-2 text-sm text-navy/80">
                <input
                  type="checkbox"
                  checked={csvSplitDebitCredit}
                  onChange={(e) => setCsvSplitDebitCredit(e.target.checked)}
                  className="rounded border-slate-300"
                />
                File has separate debit and credit columns
              </label>

              {csvSplitDebitCredit && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <ColumnPicker
                    id="csv-debit"
                    label="Debit column (money out)"
                    value={csvDebitCol}
                    onChange={setCsvDebitCol}
                    headers={csvHeaders}
                    placeholder="Debit"
                  />
                  <ColumnPicker
                    id="csv-credit"
                    label="Credit column (money in)"
                    value={csvCreditCol}
                    onChange={setCsvCreditCol}
                    headers={csvHeaders}
                    placeholder="Credit"
                  />
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <ColumnPicker
                  id="csv-payee"
                  label="Payee column (optional)"
                  value={csvPayeeCol}
                  onChange={setCsvPayeeCol}
                  headers={csvHeaders}
                  placeholder="(none)"
                  allowEmpty
                />
                <ColumnPicker
                  id="csv-memo"
                  label="Memo column (optional)"
                  value={csvMemoCol}
                  onChange={setCsvMemoCol}
                  headers={csvHeaders}
                  placeholder="(none)"
                  allowEmpty
                />
                <ColumnPicker
                  id="csv-check"
                  label="Check number column (optional)"
                  value={csvCheckCol}
                  onChange={setCsvCheckCol}
                  headers={csvHeaders}
                  placeholder="(none)"
                  allowEmpty
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <ColumnPicker
                  id="csv-fitid"
                  label="Transaction ID column (optional)"
                  value={csvFitIdCol}
                  onChange={setCsvFitIdCol}
                  headers={csvHeaders}
                  placeholder="(none — auto-dedupe)"
                  allowEmpty
                />
                <div>
                  <Label htmlFor="csv-date-format">Date format</Label>
                  <Select
                    id="csv-date-format"
                    value={csvDateFormat}
                    onChange={(e) => setCsvDateFormat(e.target.value)}
                  >
                    <option value="">Auto-detect</option>
                    {DATE_FORMATS.map((f) => (
                      <option key={f} value={f}>{f}</option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="csv-skip-rows">Skip rows before header</Label>
                  <Input
                    id="csv-skip-rows"
                    type="number"
                    min={0}
                    value={csvSkipRows}
                    onChange={(e) => setCsvSkipRows(e.target.value)}
                  />
                </div>
                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 text-sm text-navy/80">
                    <input
                      type="checkbox"
                      checked={csvFlipSign}
                      onChange={(e) => setCsvFlipSign(e.target.checked)}
                      className="rounded border-slate-300"
                    />
                    Flip sign of amounts
                  </label>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => runCsvPreview()}
                  loading={previewing}
                  disabled={!importContent.trim()}
                >
                  Preview parsed rows
                </Button>
                {csvPreview && !csvPreview.error && (
                  <span className="text-xs text-navy/60">
                    {csvPreview.totalParsed} row{csvPreview.totalParsed === 1 ? '' : 's'} parsed
                    {csvPreview.totalParsed > csvPreview.rows.length
                      ? ` — showing first ${csvPreview.rows.length}`
                      : ''}
                  </span>
                )}
              </div>

              {csvPreview?.error && (
                <p className="text-sm text-red-600">
                  Parse error: {csvPreview.error}
                  {csvPreview.headers.length > 0 && (
                    <span className="block text-xs text-navy/60 mt-1">
                      Detected columns: {csvPreview.headers.join(', ')}
                    </span>
                  )}
                </p>
              )}

              {csvPreview && !csvPreview.error && csvPreview.rows.length > 0 && (
                <Table>
                  <thead>
                    <Tr>
                      <Th>Date</Th>
                      <Th>Description</Th>
                      <Th numeric>Amount</Th>
                    </Tr>
                  </thead>
                  <tbody>
                    {csvPreview.rows.map((r, i) => (
                      <Tr key={i}>
                        <Td>{formatDate(r.date)}</Td>
                        <Td>{r.description}</Td>
                        <Td numeric>{formatCurrency(r.amount)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
              {csvPreview && !csvPreview.error && csvPreview.rows.length === 0 && (
                <p className="text-sm text-navy/60">The file parsed but contains no data rows.</p>
              )}
            </div>
          )}

          {BINARY_KINDS.includes(importFileType) && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <Button type="button" variant="secondary" onClick={() => importFileRef.current?.click()} loading={extracting}>
                  {importFileType === 'xlsx' ? 'Choose Excel file…' : 'Choose statement PDF or scan…'}
                </Button>
                <span className="text-xs text-navy/50">
                  {importFileType === 'xlsx'
                    ? 'The first sheet with data is read; then you map its columns.'
                    : 'Read on this computer. You check every row and the balances before anything is imported.'}
                </span>
              </div>
              {statementExtract && (
                <StatementReview
                  extract={statementExtract}
                  importing={importing}
                  onImport={importStatement}
                  onCancel={() => setStatementExtract(null)}
                />
              )}
            </div>
          )}
          {/* File loader (Electron picker or browser file input) or paste */}
          <div className={BINARY_KINDS.includes(importFileType) ? 'hidden' : undefined}>
            <div className="flex items-center justify-between mb-1">
              <Label htmlFor="import-content">File Content</Label>
              <button
                type="button"
                onClick={handleOpenFile}
                className="text-xs text-electric underline hover:no-underline"
              >
                Open file…
              </button>
            </div>
            {/* Hidden browser fallback — accepts .qfx everywhere .ofx is accepted */}
            <input
              ref={importFileRef}
              type="file"
              accept={ACCEPT[importFileType]}
              className="hidden"
              onChange={handleBrowserFile}
            />
            <textarea
              id="import-content"
              value={importContent}
              onChange={(e) => setImportContent(e.target.value)}
              rows={8}
              placeholder={`Paste your ${importFileType === 'ofx' ? 'OFX/QFX' : importFileType.toUpperCase()} file content here, or click "Open file…" above.`}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-navy font-mono outline-none focus:border-electric focus:ring-2 focus:ring-electric/30 placeholder:text-navy/30 resize-y"
            />
            {importFilename && (
              <p className="text-xs text-navy/50 mt-1">Loaded: {importFilename}</p>
            )}
          </div>

          <div className={`flex items-center gap-4 ${importFileType === 'statement' && !importSummary ? 'hidden' : ''}`}>
            <Button type="submit" loading={importing} className={BINARY_KINDS.includes(importFileType) ? 'hidden' : undefined}>
              {importFileType === 'csv' ? 'Commit Import' : 'Import'}
            </Button>
            {importSummary && (
              <div className="flex gap-3 text-sm">
                <Badge tone="success">{importSummary.imported} imported</Badge>
                <Badge tone="neutral">{importSummary.skippedDupes} duplicates</Badge>
                <Badge tone="info">{importSummary.parsed} total parsed</Badge>
                {importSummary.errors > 0 && (
                  <Badge tone="danger">{importSummary.errors} errors</Badge>
                )}
              </div>
            )}
          </div>
        </form>
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Card 3: Categorization Rules                                         */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-navy">Categorization Rules</h2>
          <Button size="sm" onClick={() => setShowAddRule(true)}>
            <Plus className="h-4 w-4" />
            Add Rule
          </Button>
        </div>

        {loadingRules ? (
          <div className="py-10 flex justify-center">
            <Spinner className="text-electric" />
          </div>
        ) : rules.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="No rules yet"
            message="Rules auto-categorize imported transactions."
            action={
              <Button onClick={() => setShowAddRule(true)}>
                <Plus className="h-4 w-4" /> Add Rule
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>Name</Th>
                <Th>Condition</Th>
                <Th>Assign Account</Th>
                <Th>Status</Th>
                <Th numeric>Priority</Th>
              </Tr>
            </thead>
            <tbody>
              {rules.map((r) => {
                const acct = allAccounts.find((a) => a.id === r.setAccountId);
                return (
                  <Tr key={r.id}>
                    <Td className="font-medium">{r.name}</Td>
                    <Td className="text-sm">
                      <span className="text-navy/60">{r.matchField}</span>{' '}
                      <span className="text-electric font-medium">
                        {operatorLabel[r.matchOperator] ?? r.matchOperator}
                      </span>{' '}
                      <span className="font-mono bg-slate-100 px-1 rounded">{r.matchValue}</span>
                    </Td>
                    <Td>
                      {acct ? (
                        <>
                          <span className="text-navy/60 text-xs mr-1">{acct.code}</span>
                          {acct.name}
                        </>
                      ) : (
                        <span className="text-navy/40 text-xs italic">Unknown account</span>
                      )}
                    </Td>
                    <Td>
                      <Badge tone={r.isActive ? 'success' : 'neutral'}>
                        {r.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </Td>
                    <Td numeric>
                      <Badge tone="neutral">{r.priority}</Badge>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      {/* Modals */}
      <AddBankAccountModal
        open={showAddBankAccount}
        onClose={() => setShowAddBankAccount(false)}
        onAdded={fetchBankAccounts}
        glAccounts={glAccounts}
      />
      <AddRuleModal
        open={showAddRule}
        onClose={() => setShowAddRule(false)}
        onAdded={fetchRules}
        allAccounts={allAccounts}
      />
    </main>
  );
}
