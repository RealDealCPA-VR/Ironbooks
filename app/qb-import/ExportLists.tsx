'use client';

/**
 * "Take your data with you" — export any list as CSV, Excel or QuickBooks IIF, every list at
 * once, or the general journal as IIF for a date range (File › Utilities › Export parity).
 * Downloads come straight from the local server (/api/export/...).
 */
import { useState } from 'react';
import { Button, Card, Input, Label, Select } from '@/components/ui';

const LISTS: Array<{ key: string; label: string; iif: boolean }> = [
  { key: 'customers', label: 'Customers', iif: true },
  { key: 'vendors', label: 'Vendors', iif: true },
  { key: 'items', label: 'Items', iif: true },
  { key: 'accounts', label: 'Chart of Accounts', iif: true },
  { key: 'employees', label: 'Employees', iif: true },
  { key: 'classes', label: 'Classes', iif: true },
  { key: 'tax_rates', label: 'Sales Tax Items', iif: false },
  { key: 'terms', label: 'Terms', iif: false },
  { key: 'jobs', label: 'Jobs', iif: false },
  { key: 'payroll_items', label: 'Payroll Items', iif: false },
  { key: 'customer_types', label: 'Customer Types', iif: true },
  { key: 'vendor_types', label: 'Vendor Types', iif: true },
  { key: 'sales_reps', label: 'Sales Reps', iif: true },
  { key: 'workers_comp_codes', label: "Workers' Comp Codes", iif: false },
];

function download(url: string) {
  window.open(url, '_blank', 'noopener');
}

export function ExportLists() {
  const [list, setList] = useState('customers');
  const [format, setFormat] = useState<'csv' | 'xlsx' | 'iif'>('csv');
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const current = LISTS.find((l) => l.key === list);
  const iifBlocked = format === 'iif' && current && !current.iif;

  return (
    <Card className="p-6 space-y-5">
      <p className="text-sm text-navy/70">
        Your data is yours. Save any list as a spreadsheet, or as an IIF file that QuickBooks Desktop (and this
        app) can read back in.
      </p>
      <div className="grid gap-4 sm:grid-cols-3 items-end">
        <div>
          <Label htmlFor="exp-list">List</Label>
          <Select id="exp-list" value={list} onChange={(e) => setList(e.target.value)}>
            {LISTS.map((l) => (
              <option key={l.key} value={l.key}>
                {l.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="exp-format">File type</Label>
          <Select id="exp-format" value={format} onChange={(e) => setFormat(e.target.value as 'csv' | 'xlsx' | 'iif')}>
            <option value="csv">CSV (any spreadsheet)</option>
            <option value="xlsx">Excel (.xlsx)</option>
            <option value="iif">QuickBooks IIF</option>
          </Select>
        </div>
        <Button disabled={!!iifBlocked} onClick={() => download(`/api/export/${list}?format=${format}`)}>
          Download
        </Button>
      </div>
      {iifBlocked && <p className="text-xs text-yellow-800">This list has no IIF form — choose CSV or Excel.</p>}

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => download('/api/export/all?format=xlsx')}>
          Every list in one Excel workbook
        </Button>
        <Button variant="secondary" onClick={() => download('/api/export/all?format=iif')}>
          Every list as one IIF file
        </Button>
      </div>

      <div className="border-t border-slate-200 pt-4 space-y-3">
        <h3 className="text-sm font-bold text-navy">Transactions as IIF (general journal)</h3>
        <div className="grid gap-4 sm:grid-cols-3 items-end">
          <div>
            <Label htmlFor="exp-from">From</Label>
            <Input id="exp-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="exp-to">To</Label>
            <Input id="exp-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button variant="secondary" onClick={() => download(`/api/export/journal?format=iif&from=${from}&to=${to}`)}>
            Download journal
          </Button>
        </div>
      </div>
    </Card>
  );
}
