'use client';

/**
 * Edit a paycheck (QB "Edit Paycheck"). Loads the check's lines, lets the user change the pay
 * date, earnings, deductions and (optionally) the tax amounts, then PATCHes /api/payroll/[id]:
 * the old journal entry is voided and the corrected check posted in one step. The server
 * refuses when the check was cleared in a completed bank reconciliation or its period is closed.
 */
import { useEffect, useState } from 'react';
import Decimal from 'decimal.js';
import { Button, Input, Label, Modal, Select, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';

type EarningKind = 'regular' | 'overtime' | 'bonus' | 'commission';
interface Line {
  kind: string;
  name: string;
  amount: string;
  payrollItemId: string | null;
}
interface PaycheckDetail {
  id: string;
  payDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  lines: Line[];
}
interface EarnRow {
  kind: EarningKind;
  hours: string;
  rate: string;
  amount: string;
  payrollItemId: string | null;
}
interface SimpleRow {
  name: string;
  amount: string;
  payrollItemId: string | null;
}

const KINDS: Record<string, EarningKind> = {
  regular: 'regular',
  overtime: 'overtime',
  bonus: 'bonus',
  commission: 'commission',
  'gross pay': 'regular',
};

function toEarnRow(l: Line): EarnRow {
  const m = /^(.*?)\s*\((\d+(?:\.\d+)?)\s*hrs?\s*@\s*(\d+(?:\.\d+)?)\)\s*$/i.exec(l.name);
  const base = (m ? m[1] : l.name).trim().toLowerCase();
  return {
    kind: KINDS[base] ?? 'regular',
    hours: m ? m[2] : '',
    rate: m ? m[3] : '',
    amount: l.amount,
    payrollItemId: l.payrollItemId,
  };
}

const sum = (rows: Array<{ amount: string }>) =>
  rows.reduce((s, r) => {
    try {
      return s.plus(new Decimal(r.amount || '0'));
    } catch {
      return s;
    }
  }, new Decimal(0));

export function EditPaycheckModal({
  paycheckId,
  employeeName,
  onClose,
  onSaved,
}: {
  paycheckId: string | null;
  employeeName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loaded, setLoaded] = useState<PaycheckDetail | null>(null);
  const [payDate, setPayDate] = useState('');
  const [earnings, setEarnings] = useState<EarnRow[]>([]);
  const [deductions, setDeductions] = useState<SimpleRow[]>([]);
  const [taxes, setTaxes] = useState<SimpleRow[]>([]);
  const [employer, setEmployer] = useState<SimpleRow[]>([]);
  const [recalc, setRecalc] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!paycheckId) return;
    setLoaded(null);
    api
      .get<PaycheckDetail>(`/api/payroll/${paycheckId}`)
      .then((pc) => {
        setLoaded(pc);
        setPayDate(String(pc.payDate).slice(0, 10));
        setEarnings(pc.lines.filter((l) => l.kind === 'earning').map(toEarnRow));
        const simple = (k: string) =>
          pc.lines.filter((l) => l.kind === k).map((l) => ({ name: l.name, amount: l.amount, payrollItemId: l.payrollItemId }));
        setDeductions(simple('deduction'));
        setTaxes(simple('tax'));
        setEmployer(simple('employer_contribution'));
      })
      .catch((err) => toast(err instanceof ApiError ? err.message : 'Could not load the paycheck.', 'danger'));
  }, [paycheckId]);

  const gross = earnings.reduce((s, e) => {
    try {
      if (e.amount) return s.plus(new Decimal(e.amount));
      if (e.hours && e.rate) return s.plus(new Decimal(e.hours).times(e.rate).toDecimalPlaces(2));
    } catch {
      /* ignore partial input */
    }
    return s;
  }, new Decimal(0));
  const net = recalc ? null : gross.minus(sum(taxes)).minus(sum(deductions));

  async function save() {
    if (!loaded) return;
    setSaving(true);
    try {
      await api.patch(`/api/payroll/${loaded.id}`, {
        payDate,
        periodStart: loaded.periodStart ? String(loaded.periodStart).slice(0, 10) : null,
        periodEnd: loaded.periodEnd ? String(loaded.periodEnd).slice(0, 10) : null,
        earnings: earnings.map((e) => ({
          kind: e.kind,
          ...(e.hours && e.rate ? { hours: e.hours, rate: e.rate } : {}),
          ...(e.amount ? { amount: e.amount } : {}),
          payrollItemId: e.payrollItemId,
        })),
        deductions: deductions.filter((d) => d.name && d.amount).map((d) => ({ kind: 'deduction', ...d })),
        ...(recalc
          ? {}
          : {
              taxes: taxes.filter((t) => t.name && t.amount).map((t) => ({ kind: 'tax', ...t })),
              employerTaxes: employer.filter((t) => t.name && t.amount).map((t) => ({ kind: 'employer_contribution', ...t })),
            }),
      });
      toast('Paycheck updated.', 'success');
      onSaved();
      onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update the paycheck.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  const rowEditor = (rows: SimpleRow[], set: (r: SimpleRow[]) => void, label: string, disabled = false) => (
    <div>
      <div className="flex items-center justify-between mb-1">
        <Label>{label}</Label>
        {!disabled && (
          <button type="button" className="text-xs text-electric hover:underline" onClick={() => set([...rows, { name: '', amount: '', payrollItemId: null }])}>
            + Add line
          </button>
        )}
      </div>
      {rows.map((r, i) => (
        <div key={i} className="flex gap-2 mb-2">
          <Input aria-label={`${label} name`} value={r.name} disabled={disabled} onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className="flex-1" />
          <Input aria-label={`${label} amount`} inputMode="decimal" value={r.amount} disabled={disabled} onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} className="w-28 text-right" />
        </div>
      ))}
      {rows.length === 0 && <p className="text-xs text-navy/40 italic">None.</p>}
    </div>
  );

  return (
    <Modal
      open={!!paycheckId}
      onClose={onClose}
      title={`Edit paycheck — ${employeeName}`}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!loaded}>
            Save changes
          </Button>
        </>
      }
    >
      {!loaded ? (
        <p className="text-sm text-navy/50">Loading…</p>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-navy/60">
            Saving replaces this paycheck&apos;s accounting entry with a corrected one. Paychecks that were cleared in a
            finished bank reconciliation, or that fall in a closed period, cannot be changed.
          </p>
          <div className="max-w-xs">
            <Label htmlFor="epc-date">Pay date</Label>
            <Input id="epc-date" type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
          </div>
          <div>
            <Label>Earnings</Label>
            {earnings.map((e, i) => (
              <div key={i} className="grid grid-cols-4 gap-2 mb-2">
                <Select aria-label="Earning type" value={e.kind} onChange={(ev) => setEarnings(earnings.map((x, j) => (j === i ? { ...x, kind: ev.target.value as EarningKind } : x)))}>
                  <option value="regular">Regular</option>
                  <option value="overtime">Overtime</option>
                  <option value="bonus">Bonus</option>
                  <option value="commission">Commission</option>
                </Select>
                <Input aria-label="Hours" placeholder="Hours" inputMode="decimal" value={e.hours} onChange={(ev) => setEarnings(earnings.map((x, j) => (j === i ? { ...x, hours: ev.target.value, amount: '' } : x)))} />
                <Input aria-label="Rate" placeholder="Rate" inputMode="decimal" value={e.rate} onChange={(ev) => setEarnings(earnings.map((x, j) => (j === i ? { ...x, rate: ev.target.value, amount: '' } : x)))} />
                <Input aria-label="Amount" placeholder="Amount" inputMode="decimal" value={e.amount} onChange={(ev) => setEarnings(earnings.map((x, j) => (j === i ? { ...x, amount: ev.target.value } : x)))} />
              </div>
            ))}
            <button type="button" className="text-xs text-electric hover:underline" onClick={() => setEarnings([...earnings, { kind: 'regular', hours: '', rate: '', amount: '', payrollItemId: null }])}>
              + Add earning
            </button>
          </div>
          {rowEditor(deductions, setDeductions, 'Deductions')}
          <label className="flex items-start gap-2 text-sm text-navy">
            <input type="checkbox" className="mt-1" checked={recalc} onChange={(e) => setRecalc(e.target.checked)} />
            <span>Recalculate the taxes for the new amounts (uses the employee&apos;s W-4 and year-to-date pay)</span>
          </label>
          {!recalc && (
            <div className="grid gap-4 sm:grid-cols-2">
              {rowEditor(taxes, setTaxes, 'Taxes withheld')}
              {rowEditor(employer, setEmployer, 'Employer taxes')}
            </div>
          )}
          <p className="text-sm text-navy">
            Gross {formatCurrency(gross.toFixed(2))}
            {net !== null && <> · Net pay {formatCurrency(net.toFixed(2))}</>}
          </p>
        </div>
      )}
    </Modal>
  );
}
