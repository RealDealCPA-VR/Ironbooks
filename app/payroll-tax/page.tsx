'use client';
/**
 * Payroll Tax Calculator — federal + state withholding estimator.
 *
 * Federal: IRS Publication 15-T percentage-method tables for the chosen tax year
 * (lib/services/payrollTax.ts keeps one table per year). State: ~2024 public income-tax rates
 * (approximation). State unemployment / disability rates are set on Payroll setup.
 * Results are for estimation purposes only; verify before filing.
 */
import { useState } from 'react';
import { Calculator } from 'lucide-react';
import {
  Button,
  Card,
  Input,
  Label,
  PageHeader,
  Select,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { taxYearTable } from '@/lib/services/payrollTax';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WithholdingResult {
  federalIncomeTax: string;
  socialSecurity: string;
  medicare: string;
  totalPerPeriod: string;
  net: string;
}

interface StateTaxResult {
  stateTax: string;
  annualStateTax: string;
  stateCode: string;
  stateName: string;
  rateLabel: string;
}

// ---------------------------------------------------------------------------
// State list (mirrors STATES in lib/services/statePayrollTax.ts)
// ---------------------------------------------------------------------------

interface StateOption {
  code: string;
  name: string;
}

// All 50 US states + DC — mirrors STATES in lib/services/statePayrollTax.ts
const STATE_OPTIONS: StateOption[] = [
  { code: 'AK', name: 'Alaska' },
  { code: 'AL', name: 'Alabama' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'DE', name: 'Delaware' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'IA', name: 'Iowa' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MD', name: 'Maryland' },
  { code: 'ME', name: 'Maine' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MT', name: 'Montana' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NY', name: 'New York' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VA', name: 'Virginia' },
  { code: 'VT', name: 'Vermont' },
  { code: 'WA', name: 'Washington' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WY', name: 'Wyoming' },
];

interface PayFrequency {
  label: string;
  periodsPerYear: number;
}

const PAY_FREQUENCIES: PayFrequency[] = [
  { label: 'Weekly (52×/year)',        periodsPerYear: 52 },
  { label: 'Biweekly (26×/year)',      periodsPerYear: 26 },
  { label: 'Semimonthly (24×/year)',   periodsPerYear: 24 },
  { label: 'Monthly (12×/year)',       periodsPerYear: 12 },
  { label: 'Quarterly (4×/year)',      periodsPerYear: 4  },
  { label: 'Annually (1×/year)',       periodsPerYear: 1  },
];

// ---------------------------------------------------------------------------
// Result row helper
// ---------------------------------------------------------------------------

function ResultRow({
  label,
  value,
  className = '',
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={`flex justify-between items-center py-2 border-b border-navy/10 ${className}`}>
      <span className="text-navy/70 text-sm">{label}</span>
      <span className="font-semibold tabular-nums text-navy">{formatCurrency(value)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function PayrollTaxPage() {
  const [grossPerPeriod, setGrossPerPeriod] = useState('');
  const [frequencyIndex, setFrequencyIndex] = useState(1); // biweekly default
  const [filingStatus, setFilingStatus] = useState<'single' | 'married' | 'head_of_household'>('single');
  const [taxYear, setTaxYear] = useState(String(new Date().getFullYear()));
  const [selectedState, setSelectedState] = useState('TX'); // default no-tax state
  const [result, setResult] = useState<WithholdingResult | null>(null);
  const [stateResult, setStateResult] = useState<StateTaxResult | null>(null);
  const [loading, setLoading] = useState(false);

  const selectedFrequency = PAY_FREQUENCIES[frequencyIndex];

  async function handleCalculate() {
    const gross = parseFloat(grossPerPeriod);
    if (!grossPerPeriod || isNaN(gross) || gross <= 0) {
      toast('Enter a valid gross pay amount greater than zero.', 'danger');
      return;
    }

    setLoading(true);
    setResult(null);
    setStateResult(null);
    try {
      const [federalData, stateData] = await Promise.all([
        api.post<WithholdingResult>('/api/payroll/calc', {
          grossPerPeriod: gross,
          periodsPerYear: selectedFrequency.periodsPerYear,
          filingStatus,
          year: Number(taxYear),
        }),
        api.post<StateTaxResult>('/api/payroll/state-tax', {
          grossPerPeriod: gross,
          periodsPerYear: selectedFrequency.periodsPerYear,
          state: selectedState,
        }),
      ]);
      setResult(federalData);
      setStateResult(stateData);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Calculation failed. Please try again.', 'danger');
    } finally {
      setLoading(false);
    }
  }

  function handleReset() {
    setGrossPerPeriod('');
    setFrequencyIndex(1);
    setFilingStatus('single');
    setSelectedState('TX');
    setResult(null);
    setStateResult(null);
  }

  // Annualized gross for display
  const annualGross =
    grossPerPeriod && !isNaN(parseFloat(grossPerPeriod))
      ? parseFloat(grossPerPeriod) * selectedFrequency.periodsPerYear
      : null;

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader title="Payroll Tax Calculator" icon={Calculator} />

      {/* Disclaimer banner */}
      <div className="mb-6 rounded-xl border border-gold/30 bg-gold/10 px-5 py-4 text-sm text-navy/80 leading-relaxed">
        <span className="font-bold">Disclaimer:</span> This calculator uses the IRS Publication 15-T
        percentage-method withholding tables for the tax year you choose. It is provided for estimation
        purposes only. Results may differ from actual withholding depending on W-4 elections,
        state taxes, pre-tax deductions, and other factors.{' '}
        <span className="font-semibold">Always verify against official IRS guidance before
        filing or remitting payroll taxes.</span> This is not professional tax advice.
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Input card */}
        <Card className="p-6 space-y-5">
          <h2 className="font-bold text-navy text-lg">Withholding Inputs</h2>

          {/* Gross per period */}
          <div>
            <Label htmlFor="pt-gross">Gross Pay per Period ($)</Label>
            <Input
              id="pt-gross"
              type="number"
              min="0"
              step="0.01"
              placeholder="e.g. 2500.00"
              value={grossPerPeriod}
              onChange={(e) => setGrossPerPeriod(e.target.value)}
            />
            {annualGross !== null && (
              <p className="mt-1 text-xs text-navy/50">
                Annualized: {formatCurrency(annualGross)}
              </p>
            )}
          </div>

          {/* Pay frequency */}
          <div>
            <Label htmlFor="pt-freq">Pay Frequency</Label>
            <Select
              id="pt-freq"
              value={frequencyIndex}
              onChange={(e) => setFrequencyIndex(Number(e.target.value))}
            >
              {PAY_FREQUENCIES.map((f, i) => (
                <option key={f.periodsPerYear} value={i}>
                  {f.label}
                </option>
              ))}
            </Select>
          </div>

          {/* Filing status */}
          <div>
            <Label htmlFor="pt-filing">Filing Status</Label>
            <Select
              id="pt-filing"
              value={filingStatus}
              onChange={(e) => setFilingStatus(e.target.value as 'single' | 'married' | 'head_of_household')}
            >
              <option value="single">Single</option>
              <option value="married">Married Filing Jointly</option>
              <option value="head_of_household">Head of Household</option>
            </Select>
          </div>

          {/* Tax year (federal tables are kept per year) */}
          <div>
            <Label htmlFor="pt-year">Tax year</Label>
            <Select id="pt-year" value={taxYear} onChange={(e) => setTaxYear(e.target.value)}>
              {[2026, 2025, 2024, 2023, 2022].map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          </div>

          {/* State */}
          <div>
            <Label htmlFor="pt-state">State</Label>
            <Select
              id="pt-state"
              value={selectedState}
              onChange={(e) => setSelectedState(e.target.value)}
            >
              {STATE_OPTIONS.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name} ({s.code})
                </option>
              ))}
            </Select>
          </div>

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <Button onClick={handleCalculate} disabled={!grossPerPeriod} loading={loading}>
              Calculate
            </Button>
            <Button variant="secondary" onClick={handleReset} disabled={loading}>
              Reset
            </Button>
          </div>
        </Card>

        {/* Results card */}
        <Card className="p-6">
          <h2 className="font-bold text-navy text-lg mb-4">Per-Period Withholding</h2>

          {!result && !loading && (
            <div className="py-12 text-center text-navy/40 text-sm">
              Enter your gross pay and click Calculate to see withholding estimates.
            </div>
          )}

          {loading && (
            <div className="py-12 text-center text-navy/40 text-sm">Calculating…</div>
          )}

          {result && stateResult && !loading && (
            <div className="space-y-1">
              {/* Input summary */}
              <div className="mb-4 text-xs text-navy/50 space-y-0.5">
                <p>
                  <span className="font-medium">Gross:</span>{' '}
                  {formatCurrency(grossPerPeriod)} &times; {selectedFrequency.periodsPerYear} periods/year
                </p>
                <p>
                  <span className="font-medium">Status:</span>{' '}
                  {filingStatus === 'married' ? 'Married Filing Jointly' : filingStatus === 'head_of_household' ? 'Head of Household' : 'Single'}
                </p>
                <p>
                  <span className="font-medium">State:</span>{' '}
                  {stateResult.stateName} — {stateResult.rateLabel}
                </p>
              </div>

              {/* Federal withholding breakdown */}
              <p className="text-xs font-semibold text-navy/50 uppercase tracking-wide pt-1">Federal</p>
              <ResultRow label="Federal Income Tax" value={result.federalIncomeTax} />
              <ResultRow label="Social Security (6.2%)" value={result.socialSecurity} />
              <ResultRow label="Medicare (1.45% + 0.9%*)" value={result.medicare} />

              {/* State withholding */}
              <p className="text-xs font-semibold text-navy/50 uppercase tracking-wide pt-3">State</p>
              <ResultRow
                label={`${stateResult.stateName} Income Tax`}
                value={stateResult.stateTax}
              />

              {/* Total withholding (federal + state) */}
              {(() => {
                const fedTotal = parseFloat(result.totalPerPeriod);
                const stateTaxAmt = parseFloat(stateResult.stateTax);
                const combinedTotal = (fedTotal + stateTaxAmt).toFixed(2);
                const combinedNet = (parseFloat(grossPerPeriod) - parseFloat(combinedTotal)).toFixed(2);
                return (
                  <>
                    <div className="flex justify-between items-center py-3 mt-2 border-t-2 border-navy/20">
                      <span className="font-bold text-navy">Total Withholding (Fed + State)</span>
                      <span className="font-bold tabular-nums text-red-600">
                        {formatCurrency(combinedTotal)}
                      </span>
                    </div>

                    {/* Net pay */}
                    <div className="flex justify-between items-center py-3 rounded-lg bg-emerald/10 px-4 mt-1">
                      <span className="font-bold text-emerald">Estimated Net Pay</span>
                      <span className="font-bold tabular-nums text-emerald text-lg">
                        {formatCurrency(combinedNet)}
                      </span>
                    </div>
                  </>
                );
              })()}

              <p className="mt-4 text-xs text-navy/40 leading-relaxed">
                * Additional Medicare Tax of 0.9% applies to wages exceeding $200,000/year.
                Social Security capped at {formatCurrency(String(taxYearTable(Number(taxYear)).ssWageBase))} of wages ({taxYearTable(Number(taxYear)).year}).
              </p>

              <p className="mt-3 text-xs text-gold leading-relaxed font-semibold">
                Approximation only — progressive states (CA, NY, NJ, OR, MN, DC, HI, VT, ME, CT,
                WI, SC, NE, MT, IA, MO, AR, NM, MD, DE, AL, VA, RI, KS, OK, WV, ND, OH, LA) use
                a single flat mid-range effective rate, not graduated brackets. Does not include
                local taxes, pre-tax deductions (401k, health insurance, FSA), or individual
                W-4/state equivalent adjustments. Always verify against official state guidance
                before filing or remitting payroll taxes.
              </p>
            </div>
          )}
        </Card>
      </div>

      {/* Reference card — straight from the year-keyed tables in payrollTax.ts */}
      {(() => {
        const table = taxYearTable(Number(taxYear));
        const rates = [10, 12, 22, 24, 32, 35, 37];
        const list = (edges: number[]) =>
          rates.map((r, i) =>
            i < edges.length ? `${r}% up to ${formatCurrency(String(edges[i]))}` : `${r}% over ${formatCurrency(String(edges[edges.length - 1]))}`,
          );
        const cols: Array<[string, number[]]> = [
          ['Single', table.bracketEdges.single],
          ['Married (MFJ)', table.bracketEdges.married],
          ['Head of Household', table.bracketEdges.head_of_household],
        ];
        return (
          <Card className="mt-6 p-6">
            <h2 className="font-bold text-navy text-base mb-3">{table.year} Federal Tax Reference</h2>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 text-sm text-navy/70">
              <div>
                <h3 className="font-semibold text-navy mb-2">FICA Rates</h3>
                <ul className="space-y-1">
                  <li>Social Security: <span className="font-medium">6.2%</span> (up to {formatCurrency(String(table.ssWageBase))})</li>
                  <li>Medicare: <span className="font-medium">1.45%</span> (all wages)</li>
                  <li>Addl. Medicare: <span className="font-medium">+0.9%</span> over $200,000</li>
                </ul>
              </div>
              {cols.map(([label, edges]) => (
                <div key={label}>
                  <h3 className="font-semibold text-navy mb-2">{label} brackets</h3>
                  <ul className="space-y-1 font-mono text-xs">
                    {list(edges).map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs text-navy/40">
              Brackets apply after the standard deduction ({formatCurrency(String(table.standardDeduction.single))} single,{' '}
              {formatCurrency(String(table.standardDeduction.married))} married, {formatCurrency(String(table.standardDeduction.head_of_household))}{' '}
              head of household). Source: IRS Publication 15-T ({table.year}). Consult the current IRS publication before filing.
            </p>
          </Card>
        );
      })()}
    </main>
  );
}
