'use client';
/**
 * Sales Tax Components page.
 *
 * Two sections:
 * 1. Component editor — pick a tax rate, edit its named components (name / agency / rate),
 *    shows combined total; Save replaces the components and recomputes the parent rate.
 * 2. Sales-Tax-by-Agency report — date range picker, shows collected tax split per agency/component.
 */
import React, { useEffect, useState, useCallback } from 'react';
import { Percent } from 'lucide-react';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import {
  Button,
  Card,
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

// ---------------------------------------------------------------------------
// Types (mirroring server shape)
// ---------------------------------------------------------------------------
interface TaxRate {
  id: string;
  name: string;
  rate: string;
}

interface TaxAgency {
  id: string;
  name: string;
}

interface TaxComponent {
  id?: string;
  name: string;
  agencyId: string;
  rate: string; // e.g. "0.060000"
}

interface AgencyTaxRow {
  agencyId: string | null;
  agencyName: string | null;
  componentName: string;
  componentRate: string;
  rateShare: string;
  taxCollected: string;
}

interface SalesTaxByAgencyResult {
  rows: AgencyTaxRow[];
  total: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function rateToPercent(rate: string | number): string {
  return (parseFloat(String(rate)) * 100).toFixed(4).replace(/\.?0+$/, '');
}

function percentToRate(pct: string): string {
  const n = parseFloat(pct);
  if (isNaN(n)) return '0.000000';
  return (n / 100).toFixed(6);
}

function sumComponents(comps: TaxComponent[]): number {
  return comps.reduce((s, c) => s + parseFloat(c.rate || '0'), 0);
}

const EMPTY_COMPONENT: TaxComponent = { name: '', agencyId: '', rate: '0.000000' };

// ---------------------------------------------------------------------------
// Component editor sub-section
// ---------------------------------------------------------------------------
function ComponentEditor({
  taxRateId,
  agencies,
  onSaved,
}: {
  taxRateId: string;
  agencies: TaxAgency[];
  onSaved: () => void;
}) {
  const [components, setComponents] = useState<TaxComponent[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load existing components.
  useEffect(() => {
    if (!taxRateId) return;
    setLoading(true);
    api
      .get<TaxComponent[]>(`/api/tax-rates/${taxRateId}/components`)
      .then((rows) => {
        setComponents(rows.length > 0 ? rows : [{ ...EMPTY_COMPONENT }]);
      })
      .catch(() => {
        setComponents([{ ...EMPTY_COMPONENT }]);
      })
      .finally(() => setLoading(false));
  }, [taxRateId]);

  function addRow() {
    setComponents((prev) => [...prev, { ...EMPTY_COMPONENT }]);
  }

  function removeRow(i: number) {
    setComponents((prev) => prev.filter((_, idx) => idx !== i));
  }

  function updateRow(i: number, field: keyof TaxComponent, value: string) {
    setComponents((prev) =>
      prev.map((c, idx) => {
        if (idx !== i) return c;
        if (field === 'rate') {
          // value is the percent string from the input; store as decimal fraction.
          return { ...c, rate: percentToRate(value) };
        }
        return { ...c, [field]: value };
      }),
    );
  }

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch(`/api/tax-rates/${taxRateId}/components`, {
        components: components.map((c) => ({
          name: c.name,
          agencyId: c.agencyId || null,
          rate: parseFloat(c.rate || '0'),
        })),
      });
      toast('Components saved — parent rate updated.', 'success');
      onSaved();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Save failed', 'danger');
    } finally {
      setSaving(false);
    }
  }

  const combinedPct = (sumComponents(components) * 100).toFixed(4).replace(/\.?0+$/, '');

  if (loading) {
    return (
      <div className="py-4 flex justify-center text-electric">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Table>
        <thead>
          <tr>
            <Th>Component Name</Th>
            <Th>Agency</Th>
            <Th>Rate (%)</Th>
            <Th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {components.map((c, i) => (
            <Tr key={i}>
              <Td>
                <Input
                  placeholder="e.g. State"
                  value={c.name}
                  onChange={(e) => updateRow(i, 'name', e.target.value)}
                />
              </Td>
              <Td>
                <Select
                  value={c.agencyId}
                  onChange={(e) => updateRow(i, 'agencyId', e.target.value)}
                >
                  <option value="">— None —</option>
                  {agencies.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Td>
              <Td>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  step="0.0001"
                  placeholder="0"
                  value={rateToPercent(c.rate)}
                  onChange={(e) => updateRow(i, 'rate', e.target.value)}
                  className="text-right"
                />
              </Td>
              <Td>
                <button
                  onClick={() => removeRow(i)}
                  className="text-red-400 hover:text-red-600 text-lg leading-none px-2"
                  title="Remove component"
                >
                  &times;
                </button>
              </Td>
            </Tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-navy/20">
            <td className="py-2 px-4 text-navy/60 text-sm italic" colSpan={2}>
              Combined total
            </td>
            <td className="py-2 px-4 text-right font-bold text-navy tabular-nums">
              {combinedPct}%
            </td>
            <td />
          </tr>
        </tfoot>
      </Table>

      <div className="flex gap-3 pt-1">
        <Button variant="secondary" size="sm" onClick={addRow}>
          + Add Row
        </Button>
        <Button size="sm" onClick={handleSave} loading={saving}>
          Save Components
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sales-tax-by-agency report sub-section
// ---------------------------------------------------------------------------
function SalesTaxByAgencyReport() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [result, setResult] = useState<SalesTaxByAgencyResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function runReport() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const data = await api.get<SalesTaxByAgencyResult>(
        `/api/reports/sales-tax-by-agency?${params.toString()}`,
      );
      setResult(data);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Report failed', 'danger');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4 items-end">
        <div>
          <Label htmlFor="agency-report-from">From date</Label>
          <Input
            id="agency-report-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-44"
          />
        </div>
        <div>
          <Label htmlFor="agency-report-to">To date</Label>
          <Input
            id="agency-report-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-44"
          />
        </div>
        <Button onClick={runReport} loading={loading}>
          Run Report
        </Button>
      </div>

      {result && (
        <Table>
          <thead>
            <tr>
              <Th>Component</Th>
              <Th>Agency</Th>
              <Th>Rate</Th>
              <Th>Share</Th>
              <Th numeric>Tax Collected</Th>
            </tr>
          </thead>
          <tbody>
            {result.rows.length === 0 ? (
              <Tr>
                <Td colSpan={5} className="text-center text-navy/40 italic py-6">
                  No tax collected in this date range.
                </Td>
              </Tr>
            ) : (
              result.rows.map((r, i) => (
                <Tr key={i}>
                  <Td>{r.componentName}</Td>
                  <Td>{r.agencyName ?? <span className="text-navy/40 italic">—</span>}</Td>
                  <Td className="tabular-nums">{rateToPercent(r.componentRate)}%</Td>
                  <Td className="tabular-nums">{(parseFloat(r.rateShare) * 100).toFixed(2)}%</Td>
                  <Td numeric>{formatCurrency(r.taxCollected)}</Td>
                </Tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-navy/20 font-bold">
              <td className="py-3 px-4 text-navy" colSpan={4}>
                Total Tax Collected
              </td>
              <td className="py-3 px-4 text-right tabular-nums text-navy">
                {formatCurrency(result.total)}
              </td>
            </tr>
          </tfoot>
        </Table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function SalesTaxComponentsPage() {
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [agencies, setAgencies] = useState<TaxAgency[]>([]);
  const [selectedRateId, setSelectedRateId] = useState('');
  const [parentRate, setParentRate] = useState<string | null>(null);
  const [loadingRates, setLoadingRates] = useState(true);

  // Load tax rates and agencies on mount. The two fetches are independent so a
  // failed agencies lookup must not discard the tax rates — agencies just
  // degrade to "— None —" in the component editor.
  useEffect(() => {
    api
      .get<TaxRate[]>('/api/tax-rates')
      .then((rates) => {
        setTaxRates(rates);
        if (rates.length > 0 && !selectedRateId) {
          setSelectedRateId(rates[0].id);
          setParentRate(rates[0].rate);
        }
      })
      .catch(() => toast('Failed to load tax rates', 'danger'))
      .finally(() => setLoadingRates(false));

    api
      .get<TaxAgency[]>('/api/tax-agencies')
      .then(setAgencies)
      .catch(() => {
        // Non-fatal — if the lookup fails the agency picker simply offers no agencies.
        setAgencies([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleRateChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    setSelectedRateId(id);
    const r = taxRates.find((t) => t.id === id);
    setParentRate(r?.rate ?? null);
  }

  // Refresh parent rate after save.
  const handleSaved = useCallback(() => {
    api.get<TaxRate[]>('/api/tax-rates').then((rates) => {
      setTaxRates(rates);
      const r = rates.find((t) => t.id === selectedRateId);
      setParentRate(r?.rate ?? null);
    });
  }, [selectedRateId]);

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Sales Tax Components" icon={Percent} />

      {/* ------------------------------------------------------------------ */}
      {/* Section 1: Component editor                                          */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-6 mb-8 max-w-4xl">
        <h2 className="text-lg font-bold text-navy mb-4">Edit Tax Rate Components</h2>

        <div className="mb-5">
          <Label htmlFor="tax-rate-picker">Tax Rate</Label>
          {loadingRates ? (
            <div className="py-1 text-electric">
              <Spinner className="h-5 w-5" />
            </div>
          ) : (
            <Select
              id="tax-rate-picker"
              value={selectedRateId}
              onChange={handleRateChange}
              className="max-w-xs"
            >
              {taxRates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({rateToPercent(t.rate)}%)
                </option>
              ))}
            </Select>
          )}
          {parentRate !== null && (
            <p className="mt-1 text-sm text-navy/50">
              Current combined rate:{' '}
              <span className="font-semibold text-navy">{rateToPercent(parentRate)}%</span>
            </p>
          )}
        </div>

        {selectedRateId && (
          <ComponentEditor
            key={selectedRateId}
            taxRateId={selectedRateId}
            agencies={agencies}
            onSaved={handleSaved}
          />
        )}

        {!selectedRateId && !loadingRates && (
          <p className="text-navy/40 italic text-sm">
            No tax rates found. Create one at Settings &rsaquo; Tax Rates first.
          </p>
        )}
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Section 2: Sales-Tax-by-Agency report                               */}
      {/* ------------------------------------------------------------------ */}
      <Card className="p-6 max-w-4xl">
        <h2 className="text-lg font-bold text-navy mb-4">Sales Tax by Agency Report</h2>
        <SalesTaxByAgencyReport />
      </Card>
    </main>
  );
}
