'use client';
/**
 * Preferences > Finance Charge (prefsperms A2; QB Edit > Preferences > Finance Charge > Company
 * Preferences). Saved through PATCH /api/finance-charges/settings into
 * companies.settings.financeCharges and used by Customers > Assess Finance Charges
 * (lib/services/financeCharges.ts):
 *  - annual interest rate, minimum finance charge, grace period;
 *  - the income account finance charges post to;
 *  - "Assess finance charges on overdue finance charges";
 *  - "Calculate charges from" the due date or the invoice date;
 *  - "Mark finance charge invoices To be printed".
 */
import * as React from 'react';
import Link from 'next/link';
import { BadgePercent } from 'lucide-react';
import { Button, Card, Input, Label, Select, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';

interface Settings {
  annualRate: string;
  minCharge: string;
  graceDays: number;
  accountId: string | null;
  assessOnFinanceCharges: boolean;
  calculateFrom: 'due_date' | 'invoice_date';
  markToBePrinted: boolean;
}

interface AccountOpt {
  id: string;
  code: string;
  name: string;
  type: string;
  isActive?: boolean;
}

export default function FinanceChargePreference({ canEdit = true, accounts }: { canEdit?: boolean; accounts: AccountOpt[] }) {
  const [s, setS] = React.useState<Settings | null>(null);
  const [rate, setRate] = React.useState('');
  const [min, setMin] = React.useState('');
  const [grace, setGrace] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    api
      .get<Settings>('/api/finance-charges/settings')
      .then((v) => {
        setS(v);
        setRate(v.annualRate);
        setMin(v.minCharge);
        setGrace(String(v.graceDays));
      })
      .catch((err) => toast(err instanceof ApiError ? err.message : 'Could not load the finance charge settings.', 'danger'));
  }, []);

  async function save() {
    if (!s) return;
    setSaving(true);
    try {
      const v = await api.patch<Settings>('/api/finance-charges/settings', {
        annualRate: rate,
        minCharge: min,
        graceDays: Number(grace),
        accountId: s.accountId,
        assessOnFinanceCharges: s.assessOnFinanceCharges,
        calculateFrom: s.calculateFrom,
        markToBePrinted: s.markToBePrinted,
      });
      setS(v);
      setRate(v.annualRate);
      setMin(v.minCharge);
      setGrace(String(v.graceDays));
      toast('Finance charge preferences saved', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save the finance charge preferences.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  const income = accounts.filter((a) => a.type === 'revenue' && a.isActive !== false);
  const readOnly = !canEdit;

  return (
    <Card className="p-8">
      <h2 className="mb-1 flex items-center gap-2 text-lg font-bold text-navy">
        <BadgePercent className="h-5 w-5 text-electric" aria-hidden="true" /> Finance Charge
      </h2>
      <p className="mb-5 text-sm text-navy/50">
        Interest you charge customers on overdue invoices. These settings apply to everyone and are used when you{' '}
        <Link href="/finance-charges" className="font-semibold text-electric hover:underline">
          assess finance charges
        </Link>
        .{readOnly && ' Only someone who may change company preferences can change them.'}
      </p>
      {!s ? (
        <p className="text-sm text-navy/50">Loading…</p>
      ) : (
        <fieldset disabled={readOnly} className="flex flex-col gap-5">
          <legend className="sr-only">Finance charge preferences</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <Label htmlFor="fc-rate">Annual interest rate (%)</Label>
              <Input id="fc-rate" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="fc-min">Minimum finance charge</Label>
              <Input id="fc-min" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="fc-grace">Grace period (days)</Label>
              <Input id="fc-grace" inputMode="numeric" value={grace} onChange={(e) => setGrace(e.target.value.replace(/[^0-9]/g, ''))} />
            </div>
          </div>
          <div className="max-w-md">
            <Label htmlFor="fc-account">Finance charge account</Label>
            <Select id="fc-account" value={s.accountId ?? ''} onChange={(e) => setS({ ...s, accountId: e.target.value || null })}>
              <option value="">Finance Charge Income (created when first needed)</option>
              {income.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-navy/50">The income account finance charges are posted to.</p>
          </div>
          <div className="flex items-start gap-3">
            <input
              id="fc-compound"
              type="checkbox"
              checked={s.assessOnFinanceCharges}
              onChange={(e) => setS({ ...s, assessOnFinanceCharges: e.target.checked })}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-electric focus:ring-electric"
            />
            <div>
              <Label htmlFor="fc-compound" className="mb-0 cursor-pointer">
                Assess finance charges on overdue finance charges
              </Label>
              <p className="mt-0.5 text-xs text-navy/50">
                Off: unpaid finance charges are never charged interest again. Check the rules where you do business before
                turning this on.
              </p>
            </div>
          </div>
          <div className="max-w-md">
            <Label htmlFor="fc-from">Calculate charges from</Label>
            <Select
              id="fc-from"
              value={s.calculateFrom}
              onChange={(e) => setS({ ...s, calculateFrom: e.target.value === 'invoice_date' ? 'invoice_date' : 'due_date' })}
            >
              <option value="due_date">The due date</option>
              <option value="invoice_date">The invoice (billed) date</option>
            </Select>
            <p className="mt-1 text-xs text-navy/50">
              An invoice is charged only once it is past due (and past the grace period); this decides from which day the
              interest counts.
            </p>
          </div>
          <div className="flex items-start gap-3">
            <input
              id="fc-print"
              type="checkbox"
              checked={s.markToBePrinted}
              onChange={(e) => setS({ ...s, markToBePrinted: e.target.checked })}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-electric focus:ring-electric"
            />
            <Label htmlFor="fc-print" className="mb-0 cursor-pointer">
              Mark finance charge invoices &quot;To be printed&quot;
            </Label>
          </div>
          <div>
            <Button onClick={() => void save()} loading={saving} disabled={readOnly}>
              Save finance charge preferences
            </Button>
          </div>
        </fieldset>
      )}
    </Card>
  );
}
