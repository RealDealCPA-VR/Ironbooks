'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { FileClock, ChevronDown, ChevronRight, Copy } from 'lucide-react';
import {
  Button,
  Card,
  Input,
  Select,
  Label,
  Badge,
  Table,
  Th,
  Td,
  Tr,
  PageHeader,
  EmptyState,
  Spinner,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatDate } from '@/lib/utils';
import { localDayEndIso, localDayStartIso } from '@/lib/dates';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuditLogRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorName: string | null;
  actorId: string | null;
  createdAt: string;
  oldValues?: unknown;
  newValues?: unknown;
  llmReasoning?: string | null;
}

interface ListResult {
  rows: AuditLogRow[];
  total: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 25;

const ACTION_OPTIONS = [
  { value: '', label: 'All actions' },
  { value: 'create', label: 'Create' },
  { value: 'update', label: 'Update' },
  { value: 'delete', label: 'Delete' },
  { value: 'void', label: 'Void' },
  { value: 'llm_correction', label: 'AI Correction' },
];

const ENTITY_TYPE_OPTIONS = [
  { value: '', label: 'All entities' },
  { value: 'account', label: 'Account' },
  { value: 'journal_entry', label: 'Journal Entry' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'customer', label: 'Customer' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'bill', label: 'Bill' },
  { value: 'payment', label: 'Payment' },
  { value: 'employee', label: 'Employee' },
];

const ACTION_TONES: Record<string, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = {
  create: 'success',
  update: 'info',
  delete: 'danger',
  void: 'warning',
  llm_correction: 'neutral',
};

// ---------------------------------------------------------------------------
// Entity label resolution — show document numbers / names instead of raw UUIDs.
// The audit list endpoint only carries entityType/entityId, so we resolve labels
// client-side from the corresponding list endpoints (fetched once, in parallel).
// ---------------------------------------------------------------------------

type AnyRow = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

const LABEL_SOURCES: Record<
  string,
  { url: string; rows: (d: unknown) => AnyRow[]; label: (r: AnyRow) => string; href?: (id: string) => string }
> = {
  account: {
    url: '/api/accounts',
    rows: (d) => (Array.isArray(d) ? (d as AnyRow[]) : []),
    label: (r) => `${str(r.code)} · ${str(r.name)}`,
  },
  invoice: {
    url: '/api/invoices',
    rows: (d) => (Array.isArray(d) ? (d as AnyRow[]) : []),
    label: (r) => `Invoice #${str(r.invoiceNumber)}`,
    href: (id) => `/invoices?focus=${id}`,
  },
  bill: {
    url: '/api/bills',
    rows: (d) => (Array.isArray(d) ? (d as AnyRow[]) : []),
    label: (r) => (r.billNumber ? `Bill #${str(r.billNumber)}` : 'Bill'),
  },
  customer: {
    url: '/api/customers',
    rows: (d) => (Array.isArray(d) ? (d as AnyRow[]) : []),
    label: (r) => str(r.displayName),
    href: (id) => `/customers?focus=${id}`,
  },
  vendor: {
    url: '/api/vendors',
    rows: (d) => (Array.isArray(d) ? (d as AnyRow[]) : []),
    label: (r) => str(r.displayName) || str(r.name),
    href: (id) => `/vendors?focus=${id}`,
  },
  employee: {
    url: '/api/employees',
    rows: (d) => (Array.isArray(d) ? (d as AnyRow[]) : []),
    label: (r) => `${str(r.firstName)} ${str(r.lastName)}`.trim(),
  },
  journal_entry: {
    url: '/api/journal-entries',
    rows: (d) => ((d as { entries?: AnyRow[] })?.entries ?? []),
    label: (r) => `JE #${str(r.entryNumber)}`,
  },
  payment: {
    url: '/api/payments',
    rows: (d) => ((d as { payments?: AnyRow[] })?.payments ?? []),
    label: (r) => (r.paymentNumber ? `Payment #${str(r.paymentNumber)}` : 'Payment'),
  },
};

/** key: `${entityType}:${entityId}` -> human label */
type LabelMap = Map<string, { label: string; href?: string }>;

async function buildLabelMap(): Promise<LabelMap> {
  const map: LabelMap = new Map();
  await Promise.allSettled(
    Object.entries(LABEL_SOURCES).map(async ([type, source]) => {
      const data = await api.get<unknown>(source.url);
      for (const row of source.rows(data)) {
        if (typeof row.id !== 'string') continue;
        const label = source.label(row);
        if (!label) continue;
        map.set(`${type}:${row.id}`, { label, href: source.href?.(row.id) });
      }
    }),
  );
  return map;
}

function copyId(id: string) {
  navigator.clipboard
    ?.writeText(id)
    .then(() => toast('Record ID copied to clipboard', 'info'))
    .catch(() => toast('Could not copy ID', 'danger'));
}

// ---------------------------------------------------------------------------
// Helper: JSON diff viewer
// ---------------------------------------------------------------------------

function JsonDiff({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div className="mb-3">
      <p className="text-xs font-semibold text-navy/50 uppercase tracking-wide mb-1">{label}</p>
      <pre className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-3 overflow-x-auto text-navy/80 whitespace-pre-wrap break-words">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expandable row component
// ---------------------------------------------------------------------------

function AuditRow({ row, entityLabels }: { row: AuditLogRow; entityLabels: LabelMap }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<AuditLogRow | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggleExpand() {
    if (!expanded && !detail) {
      setLoading(true);
      try {
        // The list endpoint trims oldValues/newValues for performance, so fetch the full
        // record from the detail endpoint when the row doesn't already carry them.
        if (row.oldValues !== undefined || row.newValues !== undefined) {
          setDetail(row);
        } else {
          const full = await api.get<AuditLogRow>(`/api/audit-trail/${row.id}`);
          setDetail(full);
        }
      } catch (err) {
        toast(err instanceof ApiError ? err.message : 'Failed to load details', 'danger');
      } finally {
        setLoading(false);
      }
    }
    setExpanded((v) => !v);
  }

  const actionTone = ACTION_TONES[row.action] ?? 'neutral';
  const actionLabel =
    ACTION_OPTIONS.find((o) => o.value === row.action)?.label ?? row.action;
  const dateStr = formatDate(row.createdAt);
  const timeStr = formatDate(row.createdAt, 'HH:mm:ss');

  const shownDetail = detail ?? row;
  const entity = entityLabels.get(`${row.entityType}:${row.entityId}`);

  return (
    <>
      <Tr
        className="cursor-pointer select-none"
        onClick={toggleExpand}
      >
        <Td className="w-6 pr-0">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-navy/40" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-navy/40" />
          )}
        </Td>
        <Td className="tabular-nums text-xs text-navy/60 whitespace-nowrap">
          <span className="block">{dateStr}</span>
          <span className="block text-navy/40">{timeStr}</span>
        </Td>
        <Td>
          <span className="text-sm text-navy/80">{row.actorName ?? <em className="text-navy/40">System</em>}</span>
        </Td>
        <Td>
          <Badge tone={actionTone}>{actionLabel}</Badge>
        </Td>
        <Td>
          <span className="text-sm font-medium text-navy">
            {ENTITY_TYPE_OPTIONS.find((o) => o.value === row.entityType)?.label ?? row.entityType}
          </span>
        </Td>
        <Td>
          {entity ? (
            entity.href ? (
              <Link
                href={entity.href}
                onClick={(e) => e.stopPropagation()}
                className="text-sm font-medium text-electric hover:underline"
              >
                {entity.label}
              </Link>
            ) : (
              <span className="text-sm text-navy/80">{entity.label}</span>
            )
          ) : (
            <button
              onClick={(e) => {
                e.stopPropagation();
                copyId(row.entityId);
              }}
              title="Copy record ID"
              className="inline-flex items-center gap-1 text-xs text-navy/50 hover:text-navy"
            >
              <Copy className="h-3 w-3" />
              Copy record ID
            </button>
          )}
        </Td>
      </Tr>

      {expanded && (
        <tr>
          <td colSpan={6} className="px-4 pb-4 pt-0 bg-slate-50/80 border-b border-slate-100">
            <div className="rounded-xl border border-slate-200 bg-white p-4 mt-1">
              {loading ? (
                <div className="flex items-center gap-2 text-sm text-navy/40">
                  <Spinner className="h-4 w-4" /> Loading details...
                </div>
              ) : (
                <>
                  {shownDetail.oldValues == null && shownDetail.newValues == null ? (
                    <p className="text-sm text-navy/40 italic">No value snapshot recorded.</p>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <JsonDiff label="Before" value={shownDetail.oldValues ?? null} />
                      <JsonDiff label="After" value={shownDetail.newValues ?? null} />
                    </div>
                  )}
                  {shownDetail.llmReasoning && (
                    <div className="mt-3">
                      <p className="text-xs font-semibold text-navy/50 uppercase tracking-wide mb-1">
                        AI Reasoning
                      </p>
                      <p className="text-sm text-navy/70 bg-gold/10 border border-gold/20 rounded-lg p-3">
                        {shownDetail.llmReasoning}
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AuditTrailPage() {
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);

  // Human labels for entity references (entityType:entityId -> document number / name).
  const [entityLabels, setEntityLabels] = useState<LabelMap>(new Map());

  // Filters
  const [filterAction, setFilterAction] = useState('');
  const [filterEntityType, setFilterEntityType] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const fetchLogs = useCallback(async (currentPage: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterAction) params.set('action', filterAction);
      if (filterEntityType) params.set('entityType', filterEntityType);
      // Local start / end of the picked days (audit timestamps are real instants).
      const fromIso = localDayStartIso(filterFrom);
      const toIso = localDayEndIso(filterTo);
      if (fromIso) params.set('from', fromIso);
      if (toIso) params.set('to', toIso);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(currentPage * PAGE_SIZE));

      const result = await api.get<ListResult>(`/api/audit-trail?${params.toString()}`);
      setRows(result.rows);
      setTotal(result.total);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to load audit trail', 'danger');
    } finally {
      setLoading(false);
    }
  }, [filterAction, filterEntityType, filterFrom, filterTo]);

  // Single fetch effect: filter changes recreate fetchLogs (and reset the page in
  // their handlers), page changes re-run it — exactly one request per change.
  useEffect(() => {
    fetchLogs(page);
  }, [page, fetchLogs]);

  // Entity labels load once, in parallel, and tolerate partial failures.
  useEffect(() => {
    let cancelled = false;
    buildLabelMap().then((map) => {
      if (!cancelled) setEntityLabels(map);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Update a filter and jump back to the first page (one fetch via the effect). */
  function applyFilter(setter: (v: string) => void) {
    return (value: string) => {
      setPage(0);
      setter(value);
    };
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Audit Trail"
        icon={FileClock}
        action={
          <span className="text-sm text-navy/50">
            {total.toLocaleString()} event{total !== 1 ? 's' : ''}
          </span>
        }
      />

      {/* ---- Filters ---- */}
      <Card className="p-4 mb-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 items-end">
          <div>
            <Label htmlFor="filterAction">Action</Label>
            <Select
              id="filterAction"
              value={filterAction}
              onChange={(e) => applyFilter(setFilterAction)(e.target.value)}
            >
              {ACTION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="filterEntityType">Entity Type</Label>
            <Select
              id="filterEntityType"
              value={filterEntityType}
              onChange={(e) => applyFilter(setFilterEntityType)(e.target.value)}
            >
              {ENTITY_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="filterFrom">From Date</Label>
            <Input
              id="filterFrom"
              type="date"
              value={filterFrom}
              onChange={(e) => applyFilter(setFilterFrom)(e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="filterTo">To Date</Label>
            <Input
              id="filterTo"
              type="date"
              value={filterTo}
              onChange={(e) => applyFilter(setFilterTo)(e.target.value)}
            />
          </div>
        </div>

        <div className="flex justify-end mt-4 gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setPage(0);
              setFilterAction('');
              setFilterEntityType('');
              setFilterFrom('');
              setFilterTo('');
            }}
          >
            Clear
          </Button>
        </div>
      </Card>

      {/* ---- Table ---- */}
      <Card>
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-12 text-navy/40 text-sm">
            <Spinner className="h-4 w-4" /> Loading audit trail...
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={FileClock}
            title="No audit events found"
            message="No audit log entries match your filters."
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th className="w-6" />
                  <Th>Date / Time</Th>
                  <Th>User</Th>
                  <Th>Action</Th>
                  <Th>Entity Type</Th>
                  <Th>Record</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <AuditRow key={row.id} row={row} entityLabels={entityLabels} />
                ))}
              </tbody>
            </Table>

            {/* ---- Pagination ---- */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100">
                <p className="text-sm text-navy/50">
                  Page {page + 1} of {totalPages} &mdash;{' '}
                  {(page * PAGE_SIZE + 1).toLocaleString()}
                  {' – '}
                  {Math.min((page + 1) * PAGE_SIZE, total).toLocaleString()} of{' '}
                  {total.toLocaleString()}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </main>
  );
}
