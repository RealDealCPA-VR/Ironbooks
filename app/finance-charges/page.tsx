'use client';

import { useEffect, useState } from 'react';
import { Percent, Save, Search, Receipt, ChevronDown, ChevronRight } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  PageHeader,
  Table,
  Td,
  Th,
  Tr,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { todayISO } from '@/lib/dates';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/format';

// ---------------------------------------------------------------------------
// Types (mirror lib/services/financeCharges.ts)
// ---------------------------------------------------------------------------

interface FinanceChargeSettings {
  annualRate: string;
  minCharge: string;
  graceDays: number;
}

interface FinanceChargeInvoiceDetail {
  invoiceId: string;
  invoiceNumber: number;
  refNumber?: string;
  dueDate: string;
  balanceDue: string;
  daysOverdue: number;
  charge: string;
}

interface FinanceChargeCustomerPreview {
  customerId: string;
  displayName: string;
  overdueInvoices: FinanceChargeInvoiceDetail[];
  baseCharge: string;
  charge: string;
  minimumApplied: boolean;
  alreadyAssessed: boolean;
}

interface FinanceChargePreview {
  asOf: string;
  periodKey: string;
  settings: FinanceChargeSettings;
  customers: FinanceChargeCustomerPreview[];
}

interface AssessResult {
  asOf: string;
  periodKey: string;
  assessed: Array<{ customerId: string; displayName: string; invoiceNumber: number; refNumber?: string; charge: string }>;
  skipped: Array<{ customerId: string; displayName: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function FinanceChargesPage() {
  const today = todayISO();

  // Settings
  const [settings, setSettings] = useState<FinanceChargeSettings | null>(null);
  const [annualRate, setAnnualRate] = useState('18');
  const [minCharge, setMinCharge] = useState('0');
  const [graceDays, setGraceDays] = useState('0');
  const [savingSettings, setSavingSettings] = useState(false);

  // Preview / assess
  const [asOf, setAsOf] = useState(today);
  const [preview, setPreview] = useState<FinanceChargePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [assessing, setAssessing] = useState(false);

  useEffect(() => {
    api
      .get<FinanceChargeSettings>('/api/finance-charges/settings')
      .then((s) => {
        setSettings(s);
        setAnnualRate(s.annualRate);
        setMinCharge(s.minCharge);
        setGraceDays(String(s.graceDays));
      })
      .catch((err) =>
        toast(err instanceof ApiError ? err.message : 'Failed to load settings', 'danger'),
      );
  }, []);

  async function saveSettings() {
    setSavingSettings(true);
    try {
      const s = await api.patch<FinanceChargeSettings>('/api/finance-charges/settings', {
        annualRate,
        minCharge,
        graceDays: Number(graceDays),
      });
      setSettings(s);
      setAnnualRate(s.annualRate);
      setMinCharge(s.minCharge);
      setGraceDays(String(s.graceDays));
      toast('Finance charge settings saved', 'success');
      setPreview(null); // settings changed — any previous preview is stale
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save settings', 'danger');
    } finally {
      setSavingSettings(false);
    }
  }

  async function loadPreview() {
    setLoadingPreview(true);
    setPreview(null);
    try {
      const data = await api.get<FinanceChargePreview>(
        `/api/finance-charges/preview?asOf=${asOf}`,
      );
      setPreview(data);
      // Pre-select every assessable customer.
      setSelected(
        new Set(
          data.customers
            .filter((c) => !c.alreadyAssessed && parseFloat(c.charge) > 0)
            .map((c) => c.customerId),
        ),
      );
      setExpanded(new Set());
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to preview charges', 'danger');
    } finally {
      setLoadingPreview(false);
    }
  }

  async function assess() {
    if (!preview || selected.size === 0) return;
    setAssessing(true);
    try {
      const result = await api.post<AssessResult>('/api/finance-charges', {
        // The date the charges on screen were worked out for (the preview's), never a date typed
        // since: the charges assessed are the ones the user reviewed and ticked.
        asOf: preview.asOf,
        customerIds: [...selected],
      });
      const n = result.assessed.length;
      toast(
        n > 0
          ? `Assessed finance charges for ${n} customer${n === 1 ? '' : 's'}`
          : 'No finance charges were assessed',
        n > 0 ? 'success' : 'danger',
      );
      for (const s of result.skipped) {
        toast(`${s.displayName}: ${s.reason}`, 'danger');
      }
      await loadPreview();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to assess charges', 'danger');
    } finally {
      setAssessing(false);
    }
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const totalSelected = preview
    ? preview.customers
        .filter((c) => selected.has(c.customerId))
        .reduce((sum, c) => sum + parseFloat(c.charge), 0)
    : 0;

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Late-payment charges (finance charges)" icon={Percent} />

      {/* ---- Settings ---- */}
      <Card className="mb-6">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-navy/60">
          Finance Charge Settings
        </h2>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <Label htmlFor="annualRate">Annual Interest Rate (%)</Label>
            <Input
              id="annualRate"
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={annualRate}
              onChange={(e) => setAnnualRate(e.target.value)}
              className="w-40"
            />
          </div>
          <div>
            <Label htmlFor="minCharge">Minimum Charge ($)</Label>
            <Input
              id="minCharge"
              type="number"
              min="0"
              step="0.01"
              value={minCharge}
              onChange={(e) => setMinCharge(e.target.value)}
              className="w-40"
            />
          </div>
          <div>
            <Label htmlFor="graceDays">Grace Period (days)</Label>
            <Input
              id="graceDays"
              type="number"
              min="0"
              max="365"
              step="1"
              value={graceDays}
              onChange={(e) => setGraceDays(e.target.value)}
              className="w-40"
            />
          </div>
          <Button onClick={saveSettings} loading={savingSettings} disabled={!settings}>
            <Save className="h-4 w-4" />
            Save Settings
          </Button>
        </div>
        <p className="mt-3 text-xs text-navy/40">
          Charges = open balance × annual rate ÷ 365 × days overdue, per invoice. Invoices become
          chargeable once past the grace period. One finance-charge invoice is created per customer
          per month (re-running the same month is skipped). Finance charges never compound on prior
          finance charges.
        </p>
      </Card>

      {/* ---- Preview controls ---- */}
      <Card className="mb-6">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <Label htmlFor="asOf">Assessment Date</Label>
            <Input
              id="asOf"
              type="date"
              value={asOf}
              onChange={(e) => {
                setAsOf(e.target.value);
                setPreview(null); // the charges shown were for the old date: preview again
              }}
              className="w-48"
            />
          </div>
          <Button onClick={loadPreview} loading={loadingPreview}>
            <Search className="h-4 w-4" />
            Preview Charges
          </Button>
          {preview && (
            <Button
              onClick={assess}
              loading={assessing}
              disabled={selected.size === 0}
              variant="primary"
            >
              <Receipt className="h-4 w-4" />
              {`Assess ${selected.size} Charge${selected.size === 1 ? '' : 's'} (${formatCurrency(totalSelected)})`}
            </Button>
          )}
        </div>
      </Card>

      {/* ---- Preview table ---- */}
      {!preview && !loadingPreview && (
        <Card>
          <EmptyState
            icon={Percent}
            title="No preview yet"
            message="Pick an assessment date and click Preview Charges."
          />
        </Card>
      )}

      {preview && (
        <Card className="overflow-hidden p-0">
          {preview.customers.length === 0 ? (
            <EmptyState
              icon={Percent}
              title="Nothing to assess"
              message={`No overdue invoices as of ${formatDate(preview.asOf)}.`}
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th className="w-10"><span className="sr-only">Select</span></Th>
                  <Th className="w-10"><span className="sr-only">Expand</span></Th>
                  <Th>Customer</Th>
                  <Th numeric>Overdue Invoices</Th>
                  <Th numeric>Computed</Th>
                  <Th numeric>Charge</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {preview.customers.map((c) => (
                  <FragmentRow
                    key={c.customerId}
                    c={c}
                    checked={selected.has(c.customerId)}
                    expanded={expanded.has(c.customerId)}
                    onToggle={() => toggleSelected(c.customerId)}
                    onExpand={() => toggleExpanded(c.customerId)}
                  />
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </main>
  );
}

function FragmentRow({
  c,
  checked,
  expanded,
  onToggle,
  onExpand,
}: {
  c: FinanceChargeCustomerPreview;
  checked: boolean;
  expanded: boolean;
  onToggle: () => void;
  onExpand: () => void;
}) {
  const assessable = !c.alreadyAssessed && parseFloat(c.charge) > 0;
  return (
    <>
      <Tr>
        <Td>
          <input
            type="checkbox"
            checked={checked}
            disabled={!assessable}
            onChange={onToggle}
            className="rounded border-slate-300 text-electric focus:ring-electric/40"
          />
        </Td>
        <Td>
          <button
            type="button"
            onClick={onExpand}
            className="text-navy/40 hover:text-navy"
            title="Show overdue invoices"
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </Td>
        <Td className="font-semibold text-navy">{c.displayName}</Td>
        <Td numeric className="text-navy/70">{c.overdueInvoices.length}</Td>
        <Td numeric className="text-navy/70">{formatCurrency(c.baseCharge)}</Td>
        <Td numeric className="font-semibold text-navy">
          {formatCurrency(c.charge)}
          {c.minimumApplied && (
            <span className="ml-1 text-xs text-navy/40" title="Minimum charge applied">
              (min)
            </span>
          )}
        </Td>
        <Td>
          {c.alreadyAssessed ? (
            <Badge tone="neutral">Already assessed</Badge>
          ) : (
            <Badge tone="warning">Pending</Badge>
          )}
        </Td>
      </Tr>
      {expanded &&
        c.overdueInvoices.map((inv) => (
          <tr key={inv.invoiceId} className="bg-slate-50 text-sm text-navy/60">
            <Td></Td>
            <Td></Td>
            <Td className="pl-8">
              Invoice #{inv.refNumber ?? inv.invoiceNumber} — due {formatDate(inv.dueDate)}
            </Td>
            <Td numeric>{inv.daysOverdue} days late</Td>
            <Td numeric>{formatCurrency(inv.balanceDue)} open</Td>
            <Td numeric>{formatCurrency(inv.charge)}</Td>
            <Td></Td>
          </tr>
        ))}
    </>
  );
}
