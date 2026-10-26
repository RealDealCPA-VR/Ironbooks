'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileCode2, Download } from 'lucide-react';
import {
  Button,
  Card,
  Label,
  Select,
  Table,
  Th,
  Td,
  Tr,
  PageHeader,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency, Money } from '@/lib/money';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Vendor1099Row {
  vendorId: string;
  vendorName: string;
  taxId: string | null;
  total: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildYearOptions(): number[] {
  const current = new Date().getFullYear();
  const years: number[] = [];
  for (let y = current; y >= current - 5; y--) {
    years.push(y);
  }
  return years;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Form1099EfilePage() {
  const yearOptions = buildYearOptions();
  const currentYear = new Date().getFullYear();

  const [selectedYear, setSelectedYear] = useState(String(currentYear));
  const [rows, setRows] = useState<Vendor1099Row[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the eligible vendor list to show a preview count.
  const loadVendors = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRows(null);
    try {
      const data = await api.get<Vendor1099Row[]>(`/api/reports/1099?year=${selectedYear}&nec=1`);
      setRows(data);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to load 1099 vendor list.';
      setError(msg);
      toast(msg, 'danger');
    } finally {
      setLoading(false);
    }
  }, [selectedYear]);

  // Auto-load on mount.
  useEffect(() => {
    loadVendors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Trigger the XML download by navigating to the API endpoint.
  // The API returns Content-Disposition: attachment, so the browser saves the file.
  async function handleDownload() {
    setDownloading(true);
    try {
      const response = await fetch(`/api/reports/1099-xml?year=${selectedYear}`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${response.status}`);
      }
      const xml = await response.text();
      const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `1099-nec-${selectedYear}.xml`;
      a.click();
      URL.revokeObjectURL(url);
      toast(`1099-NEC e-file downloaded for ${selectedYear}.`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Download failed.';
      toast(msg, 'danger');
    } finally {
      setDownloading(false);
    }
  }

  const eligibleCount = rows?.length ?? 0;
  const canDownload = !loading && rows !== null;

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="1099-NEC E-file Export"
        icon={FileCode2}
        action={
          canDownload ? (
            <Button
              onClick={handleDownload}
              disabled={downloading || eligibleCount === 0}
              size="sm"
            >
              <Download className="h-4 w-4" />
              {downloading ? 'Generating…' : `Generate 1099-NEC e-file (${selectedYear})`}
            </Button>
          ) : undefined
        }
      />

      {/* ------------------------------------------------------------------ */}
      {/* Year picker + run                                                    */}
      {/* ------------------------------------------------------------------ */}
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
          <Button onClick={loadVendors} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </div>

        <p className="mt-3 text-xs text-navy/50">
          Lists 1099 vendors (marked as 1099 in vendor settings) with $600 or more of nonemployee
          compensation (1099-NEC box 1, following your 1099 account mapping) in the selected calendar
          year. Sources: bill payments, checks and General Journal amounts paid in Pay Bills.
        </p>
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Summary + download call-to-action                                   */}
      {/* ------------------------------------------------------------------ */}
      {!loading && rows !== null && (
        <Card className="p-4 mb-6 border border-electric/30 bg-electric/5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-navy">
                {eligibleCount === 0
                  ? `No 1099-eligible vendors found for ${selectedYear}.`
                  : `${eligibleCount} eligible vendor${eligibleCount !== 1 ? 's' : ''} found for ${selectedYear}.`}
              </p>
              <p className="mt-0.5 text-xs text-navy/60">
                Only vendors with $600 or more in NEC box 1 are included in the e-file.
              </p>
            </div>
            {eligibleCount > 0 && (
              <Button onClick={handleDownload} disabled={downloading}>
                <Download className="h-4 w-4" />
                {downloading ? 'Generating…' : 'Download XML e-file'}
              </Button>
            )}
          </div>
        </Card>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* IRS FIRE disclaimer                                                  */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-4 mb-6 border border-gold/30 bg-gold/10">
        <p className="text-xs text-navy/70 leading-relaxed">
          <strong>Disclaimer:</strong> This tool generates the 1099-NEC data file for review
          purposes. Actual transmission to the IRS must be performed via the IRS FIRE (Filing
          Information Returns Electronically) system at{' '}
          <a
            href="https://fire.irs.gov"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:no-underline"
          >
            https://fire.irs.gov
          </a>
          . You must have a valid TCC (Transmitter Control Code) issued by the IRS to use FIRE.
          Verify all amounts and tax IDs before filing. Consult a tax professional if needed.
        </p>
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Loading / error states                                               */}
      {/* ------------------------------------------------------------------ */}
      {loading && (
        <Card>
          <div className="flex items-center justify-center py-16 text-navy/50 text-sm">
            Loading eligible vendors…
          </div>
        </Card>
      )}

      {!loading && error && (
        <Card>
          <div className="flex flex-col items-center justify-center py-16 gap-4">
            <p className="text-red-600 text-sm">{error}</p>
            <Button variant="secondary" size="sm" onClick={loadVendors}>
              Retry
            </Button>
          </div>
        </Card>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Vendor preview table                                                 */}
      {/* ------------------------------------------------------------------ */}
      {!loading && !error && rows !== null && rows.length > 0 && (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th>Vendor Name</Th>
                <Th>Tax ID (EIN / SSN)</Th>
                <Th className="text-right">Box 1 — Nonemployee Compensation</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Tr key={row.vendorId}>
                  <Td className="font-semibold text-navy">{row.vendorName}</Td>
                  <Td className="tabular-nums text-navy/70">
                    {row.taxId ?? (
                      <span className="italic text-gold text-xs">Not on file</span>
                    )}
                  </Td>
                  <Td className="text-right tabular-nums font-semibold">
                    {formatCurrency(row.total)}
                  </Td>
                </Tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-navy/20 bg-navy/5 font-bold text-navy">
                <td colSpan={2} className="py-3 px-4">
                  Total — {rows.length} vendor{rows.length !== 1 ? 's' : ''}
                </td>
                <td className="py-3 px-4 text-right tabular-nums">
                  {formatCurrency(Money.add(...rows.map((r) => r.total)))}
                </td>
              </tr>
            </tfoot>
          </Table>
        </Card>
      )}
    </main>
  );
}
