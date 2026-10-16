'use client';

import { useEffect, useState, useCallback } from 'react';
import { Receipt, Download, Settings2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  Label,
  Select,
  Table,
  Th,
  Td,
  Tr,
  PageHeader,
  Spinner,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency, Money, toAmountString } from '@/lib/money';
import { csvQuoted } from '@/lib/csv';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Tax1099Box = 'nec_1' | 'misc_1' | 'misc_3';

interface WorksheetRow {
  vendorId: string;
  vendorName: string;
  taxId: string | null;
  nec1: string;
  misc1: string;
  misc3: string;
  total: string;
  necEligible: boolean;
  miscEligible: boolean;
}

interface Worksheet {
  year: number;
  mapped: boolean;
  rows: WorksheetRow[];
}

interface MappingBoxMeta {
  box: Tax1099Box;
  label: string;
}

interface Tax1099Mapping {
  boxes: Array<{ box: Tax1099Box; accountIds: string[] }>;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
}

// ---------------------------------------------------------------------------
// CSV download
// ---------------------------------------------------------------------------

function downloadCsv(rows: WorksheetRow[], year: number) {
  const headers = [
    'Vendor Name',
    'Tax ID (EIN/SSN)',
    'NEC Box 1 (Nonemployee Comp)',
    'MISC Box 1 (Rents)',
    'MISC Box 3 (Other Income)',
    'Total',
    'NEC Required',
    'MISC Required',
  ];
  const escape = (v: string) => csvQuoted(v); // formula-safe (lib/csv.ts)

  const lines = [
    `"1099 Worksheet — Calendar Year ${year}"`,
    `"Forms are required when a box reaches $600. Card-settled payments are excluded (1099-K)."`,
    '',
    headers.map(escape).join(','),
    ...rows.map((r) =>
      [
        r.vendorName,
        r.taxId ?? '',
        r.nec1,
        r.misc1,
        r.misc3,
        r.total,
        r.necEligible ? 'Yes' : 'No',
        r.miscEligible ? 'Yes' : 'No',
      ]
        .map(escape)
        .join(','),
    ),
  ];

  const csv = lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `1099-worksheet-${year}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Year options (5 years back from current)
// ---------------------------------------------------------------------------

function buildYearOptions() {
  const current = new Date().getFullYear();
  const years: number[] = [];
  for (let y = current; y >= current - 5; y--) {
    years.push(y);
  }
  return years;
}

// ---------------------------------------------------------------------------
// Mapping editor
// ---------------------------------------------------------------------------

function MappingEditor({
  boxes,
  mapping,
  accounts,
  onSaved,
}: {
  boxes: MappingBoxMeta[];
  mapping: Tax1099Mapping | null;
  accounts: Account[];
  onSaved: () => void;
}) {
  // box -> Set of accountIds (local edit state)
  const [selection, setSelection] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const next: Record<string, string[]> = {};
    for (const b of boxes) next[b.box] = [];
    for (const entry of mapping?.boxes ?? []) next[entry.box] = [...entry.accountIds];
    setSelection(next);
  }, [mapping, boxes]);

  // Show expense accounts (the usual 1099 sources) plus anything already mapped.
  const mappedIds = new Set(Object.values(selection).flat());
  const candidates = accounts.filter((a) => a.type === 'expense' || mappedIds.has(a.id));

  function boxOf(accountId: string): string | null {
    for (const [box, ids] of Object.entries(selection)) {
      if (ids.includes(accountId)) return box;
    }
    return null;
  }

  function toggle(box: Tax1099Box, accountId: string, checked: boolean) {
    setSelection((prev) => {
      const next: Record<string, string[]> = {};
      for (const [b, ids] of Object.entries(prev)) {
        // An account feeds exactly one box: remove it everywhere, then add to the target.
        next[b] = ids.filter((id) => id !== accountId);
      }
      if (checked) next[box] = [...(next[box] ?? []), accountId];
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch('/api/reports/1099/mapping', {
        boxes: boxes.map((b) => ({ box: b.box, accountIds: selection[b.box] ?? [] })),
      });
      toast('1099 account mapping saved.', 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save mapping.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  const anyMapped = Object.values(selection).some((ids) => ids.length > 0);

  return (
    <Card className="p-6 mb-6">
      <div className="flex items-center gap-2 mb-1">
        <Settings2 className="h-4 w-4 text-electric" />
        <h2 className="text-sm font-bold text-navy">Account-to-Box Mapping</h2>
      </div>
      <p className="text-xs text-navy/50 mb-4">
        Payments count toward a box only when the bill/expense line hits a mapped account.
        With no accounts mapped, everything counts as 1099-NEC Box 1. An account can feed
        only one box.
      </p>

      {candidates.length === 0 ? (
        <p className="text-sm text-navy/40">No expense accounts found.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {boxes.map((b) => (
            <div key={b.box} className="rounded-lg border border-slate-200 p-3">
              <p className="text-xs font-bold text-navy mb-2">{b.label}</p>
              <div className="max-h-48 overflow-y-auto space-y-1 pr-1">
                {candidates.map((a) => {
                  const currentBox = boxOf(a.id);
                  const checked = currentBox === b.box;
                  return (
                    <label
                      key={a.id}
                      className={`flex items-center gap-2 text-xs rounded px-1.5 py-1 cursor-pointer ${
                        checked ? 'bg-electric/10 text-navy font-semibold' : 'text-navy/70 hover:bg-slate-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => toggle(b.box, a.id, e.target.checked)}
                      />
                      <span className="truncate">
                        {a.code} – {a.name}
                        {currentBox && currentBox !== b.box && (
                          <span className="ml-1 text-[10px] text-gold">(in another box)</span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 flex items-center justify-between">
        <p className="text-xs text-navy/40">
          {anyMapped
            ? 'Mapping active — unmapped accounts are excluded from the worksheet.'
            : 'No mapping — all eligible payments count as NEC Box 1.'}
        </p>
        <Button size="sm" onClick={handleSave} loading={saving}>
          Save Mapping
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Worksheet tables
// ---------------------------------------------------------------------------

function NecTable({ rows }: { rows: WorksheetRow[] }) {
  const visible = rows.filter((r) => Number(r.nec1) > 0);
  const total = toAmountString(Money.add(...visible.map((r) => r.nec1), 0));
  return (
    <Card className="p-0 overflow-hidden mb-6">
      <div className="px-4 pt-4 pb-2">
        <h2 className="text-sm font-bold text-navy">1099-NEC Worksheet</h2>
        <p className="text-xs text-navy/50">Box 1 — Nonemployee compensation. Form required at $600.</p>
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Vendor Name</Th>
            <Th>Tax ID (EIN / SSN)</Th>
            <Th numeric>Box 1 — Nonemployee Comp</Th>
            <Th>Form Required</Th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 ? (
            <tr>
              <Td colSpan={4} className="py-10 text-center text-navy/40">
                No NEC-reportable payments for this year.
              </Td>
            </tr>
          ) : (
            visible.map((row) => (
              <Tr key={row.vendorId}>
                <Td className="font-semibold text-navy">{row.vendorName}</Td>
                <Td className="tabular-nums text-navy/70">
                  {row.taxId ?? <span className="italic text-gold text-xs">Not on file</span>}
                </Td>
                <Td numeric className="font-semibold">{formatCurrency(row.nec1)}</Td>
                <Td>
                  {row.necEligible ? (
                    <Badge tone="success">Required</Badge>
                  ) : (
                    <Badge tone="neutral">Under $600</Badge>
                  )}
                </Td>
              </Tr>
            ))
          )}
        </tbody>
        {visible.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-navy/20 bg-navy/5 font-bold text-navy">
              <td colSpan={2} className="py-3 px-4">
                Total — {visible.length} vendor{visible.length !== 1 ? 's' : ''}
              </td>
              <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(total)}</td>
              <td />
            </tr>
          </tfoot>
        )}
      </Table>
    </Card>
  );
}

function MiscTable({ rows }: { rows: WorksheetRow[] }) {
  const visible = rows.filter((r) => Number(r.misc1) > 0 || Number(r.misc3) > 0);
  const totalRents = toAmountString(Money.add(...visible.map((r) => r.misc1), 0));
  const totalOther = toAmountString(Money.add(...visible.map((r) => r.misc3), 0));
  return (
    <Card className="p-0 overflow-hidden mb-6">
      <div className="px-4 pt-4 pb-2">
        <h2 className="text-sm font-bold text-navy">1099-MISC Worksheet</h2>
        <p className="text-xs text-navy/50">
          Box 1 — Rents; Box 3 — Other income. Form required when a box reaches $600. Map accounts
          to MISC boxes above to populate this worksheet.
        </p>
      </div>
      <Table>
        <thead>
          <tr>
            <Th>Vendor Name</Th>
            <Th>Tax ID (EIN / SSN)</Th>
            <Th numeric>Box 1 — Rents</Th>
            <Th numeric>Box 3 — Other Income</Th>
            <Th>Form Required</Th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 ? (
            <tr>
              <Td colSpan={5} className="py-10 text-center text-navy/40">
                No MISC-reportable payments for this year.
              </Td>
            </tr>
          ) : (
            visible.map((row) => (
              <Tr key={row.vendorId}>
                <Td className="font-semibold text-navy">{row.vendorName}</Td>
                <Td className="tabular-nums text-navy/70">
                  {row.taxId ?? <span className="italic text-gold text-xs">Not on file</span>}
                </Td>
                <Td numeric className="font-semibold">{formatCurrency(row.misc1)}</Td>
                <Td numeric className="font-semibold">{formatCurrency(row.misc3)}</Td>
                <Td>
                  {row.miscEligible ? (
                    <Badge tone="success">Required</Badge>
                  ) : (
                    <Badge tone="neutral">Under $600</Badge>
                  )}
                </Td>
              </Tr>
            ))
          )}
        </tbody>
        {visible.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-navy/20 bg-navy/5 font-bold text-navy">
              <td colSpan={2} className="py-3 px-4">
                Total — {visible.length} vendor{visible.length !== 1 ? 's' : ''}
              </td>
              <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(totalRents)}</td>
              <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(totalOther)}</td>
              <td />
            </tr>
          </tfoot>
        )}
      </Table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Report1099Page() {
  const currentYear = new Date().getFullYear();
  const yearOptions = buildYearOptions();

  const [selectedYear, setSelectedYear] = useState(String(currentYear));
  const [worksheet, setWorksheet] = useState<Worksheet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mapping editor data
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [mapping, setMapping] = useState<Tax1099Mapping | null>(null);
  const [mappingBoxes, setMappingBoxes] = useState<MappingBoxMeta[]>([]);

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    setWorksheet(null);
    try {
      const data = await api.get<Worksheet>(
        `/api/reports/1099?year=${selectedYear}&worksheet=1`,
      );
      setWorksheet(data);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to load 1099 worksheet.';
      setError(msg);
      toast(msg, 'danger');
    } finally {
      setLoading(false);
    }
  }, [selectedYear]);

  const loadMapping = useCallback(async () => {
    try {
      const data = await api.get<{ mapping: Tax1099Mapping | null; boxes: MappingBoxMeta[] }>(
        '/api/reports/1099/mapping',
      );
      setMapping(data.mapping);
      setMappingBoxes(data.boxes);
    } catch {
      // Non-fatal: the worksheet still works without the editor.
    }
  }, []);

  // Auto-load on mount
  useEffect(() => {
    loadReport();
    loadMapping();
    api.get<Account[]>('/api/accounts').then(setAccounts).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleMappingSaved() {
    await loadMapping();
    await loadReport();
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="1099 Worksheets (NEC + MISC)"
        icon={Receipt}
        action={
          <Button
            variant="secondary"
            size="sm"
            disabled={!worksheet?.rows.length}
            onClick={() => worksheet && downloadCsv(worksheet.rows, worksheet.year)}
          >
            <Download className="h-4 w-4" />
            Download CSV
          </Button>
        }
      />

      {/* ---- Year picker ---- */}
      <Card className="p-4 mb-6">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <Label htmlFor="year">Calendar Year</Label>
            <Select
              id="year"
              value={selectedYear}
              onChange={(e) => setSelectedYear(e.target.value)}
            >
              {yearOptions.map((y) => (
                <option key={y} value={String(y)}>
                  {y}
                </option>
              ))}
            </Select>
          </div>
          <Button onClick={loadReport} disabled={loading}>
            {loading ? 'Loading…' : 'Run Report'}
          </Button>
          {worksheet && (
            <Badge tone={worksheet.mapped ? 'info' : 'neutral'}>
              {worksheet.mapped ? 'Account mapping active' : 'No mapping — all to NEC Box 1'}
            </Badge>
          )}
        </div>

        <p className="mt-3 text-xs text-navy/50">
          Sums payments to 1099 vendors (bill payments + direct expenses) for the calendar year,
          split into NEC / MISC boxes by the account mapping below. Credit-card payments are
          excluded — those belong on the card processor&apos;s 1099-K.
        </p>
      </Card>

      {/* ---- Mapping editor (settings live on this page) ---- */}
      {mappingBoxes.length > 0 && (
        <MappingEditor
          boxes={mappingBoxes}
          mapping={mapping}
          accounts={accounts}
          onSaved={handleMappingSaved}
        />
      )}

      {/* ---- Results ---- */}
      {loading && (
        <Card>
          <div className="flex items-center justify-center gap-2 py-16 text-navy/50 text-sm">
            <Spinner className="h-4 w-4" /> Loading…
          </div>
        </Card>
      )}

      {!loading && error && (
        <Card>
          <div className="flex flex-col items-center justify-center py-16 gap-4">
            <p className="text-red-600 text-sm">{error}</p>
            <Button variant="secondary" size="sm" onClick={loadReport}>
              Retry
            </Button>
          </div>
        </Card>
      )}

      {!loading && !error && worksheet !== null && (
        <>
          <NecTable rows={worksheet.rows} />
          <MiscTable rows={worksheet.rows} />
        </>
      )}
    </main>
  );
}
