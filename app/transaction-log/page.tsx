'use client';
/**
 * Transaction Log — the running detail of every committed change to this company file, in
 * plain language (QuickBooks Desktop .TLG parity). Each record is fingerprinted and chained
 * to the one before it, so the "Verified" banner proves nothing was edited or removed and
 * that every posted journal entry is accounted for.
 *
 * Filters: date range, user, record type, action, free text. Click a row for its details;
 * "Open" drills to the record. Export via the shared report toolbar (CSV / Excel / PDF).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ScrollText, ShieldCheck, ShieldAlert, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  DateInput,
  EmptyState,
  Input,
  Label,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  Tr,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import ReportToolbar, { type ExportTable } from '@/app/reports/_components/ReportToolbar';

interface LogRecord {
  seq: number;
  ts: string;
  userId: string | null;
  userName: string | null;
  companyId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  data: unknown;
  prevHash: string;
  hash: string;
}

interface LogPage {
  rows: LogRecord[];
  total: number;
  users: Array<{ userId: string; userName: string }>;
  entityTypes: string[];
}

interface Verification {
  ok: boolean;
  exists: boolean;
  records: number;
  chainIntact: boolean;
  chainError: { line: number; seq: number | null; reason: string } | null;
  startedAt: string | null;
  postedEntries: number;
  missingEntries: Array<{ id: string; entryNumber: number }>;
  preLogEntries: number;
}

const FETCH_LIMIT = 5000;
const PAGE_SIZE = 50;

const ACTIONS = [
  { value: '', label: 'All actions' },
  { value: 'create', label: 'Created' },
  { value: 'update', label: 'Changed' },
  { value: 'void', label: 'Voided' },
  { value: 'delete', label: 'Deleted' },
  { value: 'llm_correction', label: 'AI correction' },
];

const ACTION_LABEL: Record<string, string> = {
  create: 'Created',
  update: 'Changed',
  void: 'Voided',
  delete: 'Deleted',
  llm_correction: 'AI correction',
  log_started: 'Log started',
};

const ACTION_TONE: Record<string, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = {
  create: 'success',
  update: 'info',
  void: 'warning',
  delete: 'danger',
};

/** Where "Open" goes for each record type (pages that accept ?focus= highlight the record). */
const DRILL: Record<string, (id: string) => string> = {
  journal_entry: (id) => `/journal?focus=${id}`,
  invoice: (id) => `/invoices?focus=${id}`,
  customer: (id) => `/customers?focus=${id}`,
  vendor: (id) => `/vendors?focus=${id}`,
  item: (id) => `/items?focus=${id}`,
  payment_received: (id) => `/payments?focus=${id}`,
  expense: (id) => `/expenses?focus=${id}`,
  deposit: (id) => `/deposits?focus=${id}`,
  bill: () => '/bills',
  bill_payment: () => '/pay-bills',
  account: () => '/accounts',
  employee: () => '/employees',
  estimate: () => '/estimates',
  sales_receipt: () => '/sales-receipts',
  sales_order: () => '/sales-orders',
  purchase_order: () => '/purchase-orders',
  credit_memo: () => '/credit-memos',
  vendor_credit: () => '/vendor-credits',
  transfer: () => '/transfers',
  item_receipt: () => '/item-receipts',
  time_entry: () => '/time-tracking',
  mileage_log: () => '/mileage',
  fixed_asset: () => '/fixed-assets',
  job: () => '/jobs',
  class: () => '/tracking',
  location: () => '/tracking',
  recurring_template: () => '/recurring',
  reconciliation: () => '/reconcile',
  fiscal_period: () => '/fiscal-periods',
  user_company: () => '/settings',
  company_settings: () => '/settings',
};

function typeLabel(t: string): string {
  const special: Record<string, string> = {
    journal_entry: 'Journal entry',
    payment_received: 'Customer payment',
    expense: 'Check / expense',
    user_company: 'User permission',
    transaction_log: 'Transaction log',
  };
  if (special[t]) return special[t];
  const s = t.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtTs(ts: string): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
}

function LogRow({ rec }: { rec: LogRecord }) {
  const [open, setOpen] = useState(false);
  const href = rec.entityId && DRILL[rec.entityType] ? DRILL[rec.entityType](rec.entityId) : null;
  return (
    <>
      <Tr className="cursor-pointer" onClick={() => setOpen((v) => !v)}>
        <Td className="w-8 text-navy/40">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </Td>
        <Td className="text-navy/50 tabular-nums text-sm">{rec.seq}</Td>
        <Td className="whitespace-nowrap text-sm">{fmtTs(rec.ts)}</Td>
        <Td className="text-sm">{rec.userName ?? (rec.userId ? 'Unknown user' : 'System')}</Td>
        <Td>
          <Badge tone={ACTION_TONE[rec.action] ?? 'neutral'}>{ACTION_LABEL[rec.action] ?? rec.action}</Badge>
        </Td>
        <Td className="text-sm whitespace-nowrap">{typeLabel(rec.entityType)}</Td>
        <Td className="text-sm">{rec.summary}</Td>
        <Td className="text-right">
          {href && (
            <Link
              href={href}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-sm font-semibold text-electric hover:underline"
            >
              Open <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          )}
        </Td>
      </Tr>
      {open && (
        <tr>
          <td colSpan={8} className="bg-slate-50 px-6 py-4 border-b border-slate-100">
            <div className="grid gap-3 text-xs text-navy/70">
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span>Record #{rec.seq}</span>
                {rec.entityId && <span>Record id: <span className="font-mono">{rec.entityId}</span></span>}
                <span>Fingerprint: <span className="font-mono">{rec.hash.slice(0, 16)}…</span></span>
                <span>Previous: <span className="font-mono">{rec.prevHash.slice(0, 16)}…</span></span>
              </div>
              {rec.data != null && (
                <pre className="max-h-80 overflow-auto rounded-lg border border-slate-200 bg-white p-3 whitespace-pre-wrap break-words">
                  {JSON.stringify(rec.data, null, 2)}
                </pre>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function TransactionLogPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [userId, setUserId] = useState('');
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [data, setData] = useState<LogPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [verify, setVerify] = useState<Verification | null>(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(FETCH_LIMIT) });
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (userId) params.set('userId', userId);
      if (entityType) params.set('entityType', entityType);
      if (action) params.set('action', action);
      if (debouncedQ.trim()) params.set('q', debouncedQ.trim());
      setData(await api.get<LogPage>(`/api/transaction-log?${params}`));
      setPage(0);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load the transaction log.', 'danger');
    } finally {
      setLoading(false);
    }
  }, [from, to, userId, entityType, action, debouncedQ]);

  const runVerify = useCallback(async () => {
    setVerifying(true);
    try {
      setVerify(await api.get<Verification>('/api/transaction-log/verify'));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Verification failed to run.', 'danger');
    } finally {
      setVerifying(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    runVerify();
  }, [runVerify]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));

  const exportTable: ExportTable | null = data
    ? {
        filename: 'transaction-log',
        title: 'Transaction Log',
        subtitle: [from && `From ${from}`, to && `to ${to}`].filter(Boolean).join(' ') || 'All dates',
        columns: [
          { header: '#' },
          { header: 'Date/Time' },
          { header: 'User' },
          { header: 'Action' },
          { header: 'Type' },
          { header: 'Details' },
          { header: 'Record id' },
        ],
        rows: rows.map((r) => [
          r.seq,
          fmtTs(r.ts),
          r.userName ?? (r.userId ? 'Unknown user' : 'System'),
          ACTION_LABEL[r.action] ?? r.action,
          typeLabel(r.entityType),
          r.summary,
          r.entityId ?? '',
        ]),
        landscape: true,
      }
    : null;

  const filtersActive = Boolean(from || to || userId || entityType || action || q);

  return (
    <div className="p-8 w-full">
      <PageHeader title="Transaction Log" icon={ScrollText} />
      <p className="-mt-4 mb-6 max-w-3xl text-sm text-navy/60">
        Every saved change to this company file, newest first — who did it, when, and what changed. Records are
        chained together with fingerprints, so any edit or deletion of the log is detected.
      </p>

      {/* Verification banner */}
      <Card
        className={`mb-6 flex items-start justify-between gap-4 p-4 ${
          verify && !verify.ok ? 'border-red-200 bg-red-50' : ''
        }`}
      >
        <div className="flex items-start gap-3">
          {verify && !verify.ok ? (
            <ShieldAlert className="mt-0.5 h-6 w-6 text-red-600" />
          ) : (
            <ShieldCheck className="mt-0.5 h-6 w-6 text-emerald" />
          )}
          <div className="text-sm">
            {!verify ? (
              <p className="text-navy/60">Checking the log…</p>
            ) : !verify.exists ? (
              <p className="font-semibold text-navy">The transaction log starts with the next change you save.</p>
            ) : verify.ok ? (
              <>
                <p className="font-semibold text-navy">Log verified — nothing has been altered or removed.</p>
                <p className="text-navy/60">
                  {verify.records.toLocaleString()} records since{' '}
                  {verify.startedAt ? new Date(verify.startedAt).toLocaleDateString('en-US') : '—'}; all{' '}
                  {(verify.postedEntries - verify.preLogEntries).toLocaleString()} posted journal entries since then are
                  accounted for
                  {verify.preLogEntries > 0 && ` (${verify.preLogEntries.toLocaleString()} older entries predate the log)`}.
                </p>
              </>
            ) : (
              <>
                <p className="font-semibold text-red-700">The transaction log did not verify.</p>
                {verify.chainError && (
                  <p className="text-red-700/80">
                    Record {verify.chainError.seq ?? `on line ${verify.chainError.line}`}: {verify.chainError.reason}
                  </p>
                )}
                {verify.missingEntries.length > 0 && (
                  <p className="text-red-700/80">
                    {verify.missingEntries.length} posted journal entr{verify.missingEntries.length === 1 ? 'y is' : 'ies are'}{' '}
                    not in the log (e.g. #{verify.missingEntries.slice(0, 5).map((m) => m.entryNumber).join(', #')}).
                    Restore from a backup or contact support.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={runVerify} loading={verifying}>
          Verify now
        </Button>
      </Card>

      {/* Filters */}
      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="tl-from">From</Label>
            <DateInput id="tl-from" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="tl-to">To</Label>
            <DateInput id="tl-to" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="tl-user">User</Label>
            <Select id="tl-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">All users</option>
              {(data?.users ?? []).map((u) => (
                <option key={u.userId} value={u.userId}>
                  {u.userName}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="tl-type">Type</Label>
            <Select id="tl-type" value={entityType} onChange={(e) => setEntityType(e.target.value)}>
              <option value="">All types</option>
              {(data?.entityTypes ?? []).map((t) => (
                <option key={t} value={t}>
                  {typeLabel(t)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="tl-action">Action</Label>
            <Select id="tl-action" value={action} onChange={(e) => setAction(e.target.value)}>
              {ACTIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="min-w-[220px] flex-1">
            <Label htmlFor="tl-q">Search</Label>
            <Input id="tl-q" placeholder="Invoice 1001, Acme, rent…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {filtersActive && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFrom('');
                setTo('');
                setUserId('');
                setEntityType('');
                setAction('');
                setQ('');
              }}
            >
              Clear filters
            </Button>
          )}
        </div>
      </Card>

      <ReportToolbar table={exportTable} disabled={loading} />

      <Card className="p-0">
        {loading && !data ? (
          <div className="flex justify-center py-16">
            <Spinner className="h-6 w-6" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={filtersActive ? 'No changes match these filters' : 'No changes recorded yet'}
            message={filtersActive ? 'Try a wider date range or clear the filters.' : 'Saved changes will appear here.'}
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th className="w-8" />
                  <Th>#</Th>
                  <Th>When</Th>
                  <Th>User</Th>
                  <Th>Action</Th>
                  <Th>Type</Th>
                  <Th>What happened</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <LogRow key={r.seq} rec={r} />
                ))}
              </tbody>
            </Table>
            <div className="flex items-center justify-between px-4 py-3 text-sm text-navy/60">
              <span>
                {data && data.total > rows.length
                  ? `Showing the newest ${rows.length.toLocaleString()} of ${data.total.toLocaleString()} matching changes — narrow the filters to see older ones.`
                  : `${rows.length.toLocaleString()} change${rows.length === 1 ? '' : 's'}`}
              </span>
              {pages > 1 && (
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                    Previous
                  </Button>
                  <span>
                    Page {page + 1} of {pages}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={page >= pages - 1}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
