'use client';
/**
 * QB "Adjust Quantity/Value on Hand" header fields (p1 purchases): Adjustment Account (defaults to
 * "Inventory Adjustments", created on first use), Class and Customer:Job. Used by every inventory
 * adjustment form so the offset never silently lands in equity or COGS.
 */
import { useEffect, useState } from 'react';
import { Label, Select } from '@/components/ui';
import { api } from '@/lib/client';

export interface AdjustmentFieldValues {
  adjustmentAccountId: string;
  classId: string;
  customerId: string;
  jobId: string;
}

export const EMPTY_ADJUSTMENT_FIELDS: AdjustmentFieldValues = {
  adjustmentAccountId: '',
  classId: '',
  customerId: '',
  jobId: '',
};

/** Request-body fields (blank → omitted, so the server default applies). */
export function adjustmentPayload(v: AdjustmentFieldValues) {
  return {
    adjustmentAccountId: v.adjustmentAccountId || null,
    classId: v.classId || null,
    customerId: v.customerId || null,
    jobId: v.jobId || null,
  };
}

interface Named {
  id: string;
  name?: string;
  displayName?: string;
  code?: string;
  type?: string;
  subtype?: string | null;
  customerId?: string | null;
}

export function InventoryAdjustmentFields({
  value,
  onChange,
  idPrefix = 'adj',
}: {
  value: AdjustmentFieldValues;
  onChange: (v: AdjustmentFieldValues) => void;
  idPrefix?: string;
}) {
  const [accounts, setAccounts] = useState<Named[]>([]);
  const [classes, setClasses] = useState<Named[]>([]);
  const [customers, setCustomers] = useState<Named[]>([]);
  const [jobs, setJobs] = useState<Named[]>([]);

  useEffect(() => {
    const soft = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
    Promise.all([
      soft(api.get<Named[]>('/api/accounts'), []),
      soft(api.get<Named[]>('/api/classes'), []),
      soft(api.get<Named[]>('/api/customers'), []),
      soft(api.get<Named[]>('/api/jobs'), []),
    ]).then(([a, c, cu, j]) => {
      // QB lists income, expense, COGS and equity-type accounts as adjustment accounts — never
      // A/R, A/P, bank or the inventory asset itself.
      setAccounts(
        (Array.isArray(a) ? a : []).filter(
          (x) =>
            x.type === 'expense' ||
            x.type === 'revenue' ||
            x.type === 'equity' ||
            (x.type === 'asset' && !['inventory', 'accounts_receivable', 'checking', 'savings', 'cash'].includes(x.subtype ?? '')) ||
            (x.type === 'liability' && !['accounts_payable', 'credit_card'].includes(x.subtype ?? '')),
        ),
      );
      setClasses(Array.isArray(c) ? c : []);
      setCustomers(Array.isArray(cu) ? cu : []);
      setJobs(Array.isArray(j) ? j : []);
    });
  }, []);

  const set = (patch: Partial<AdjustmentFieldValues>) => onChange({ ...value, ...patch });
  const jobsForCustomer = value.customerId ? jobs.filter((j) => !j.customerId || j.customerId === value.customerId) : jobs;

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <div>
        <Label htmlFor={`${idPrefix}-account`}>Adjustment account</Label>
        <Select id={`${idPrefix}-account`} value={value.adjustmentAccountId} onChange={(e) => set({ adjustmentAccountId: e.target.value })}>
          <option value="">Inventory Adjustments (default)</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code ? `${a.code} — ` : ''}
              {a.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-class`}>Class</Label>
        <Select id={`${idPrefix}-class`} value={value.classId} onChange={(e) => set({ classId: e.target.value })}>
          <option value="">None</option>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor={`${idPrefix}-customer`}>Customer:Job</Label>
        <div className="flex gap-2">
          <Select
            id={`${idPrefix}-customer`}
            value={value.customerId}
            onChange={(e) => set({ customerId: e.target.value, jobId: '' })}
          >
            <option value="">None</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName ?? c.name}
              </option>
            ))}
          </Select>
          {jobsForCustomer.length > 0 && (
            <Select aria-label="Job" value={value.jobId} onChange={(e) => set({ jobId: e.target.value })}>
              <option value="">No job</option>
              {jobsForCustomer.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </Select>
          )}
        </div>
      </div>
    </div>
  );
}
