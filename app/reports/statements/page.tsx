'use client';

import { useEffect, useState, useCallback } from 'react';
import { FileText, Printer, Download, Layers, FolderArchive } from 'lucide-react';
import {
  Button,
  Card,
  Input,
  Label,
  Select,
  Table,
  Th,
  Td,
  Tr,
  PageHeader,
  Badge,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Customer {
  id: string;
  displayName: string;
}

interface StatementLine {
  date: string;
  type: 'invoice' | 'payment' | 'credit_memo' | 'general_journal';
  ref: string | null;
  amount: string;
  runningBalance: string;
}

interface CustomerStatement {
  customer: {
    id: string;
    displayName: string;
    companyName: string | null;
    email: string | null;
  };
  from: string | null;
  to: string | null;
  openingBalance: string;
  lines: StatementLine[];
  closingBalance: string;
}

interface OpenItemLine {
  invoiceId: string;
  date: string;
  invoiceNumber: number;
  dueDate: string;
  total: string;
  amountPaid: string;
  balanceDue: string;
  daysPastDue: number;
  agingBucket: 'current' | '1-30' | '31-60' | '61-90' | '90+';
}

interface OpenItemStatement {
  customer: {
    id: string;
    displayName: string;
    companyName: string | null;
    email: string | null;
  };
  asOf: string;
  lines: OpenItemLine[];
  aging: {
    current: string;
    days1_30: string;
    days31_60: string;
    days61_90: string;
    days90Plus: string;
  };
  totalDue: string;
}

type StatementFormat = 'balance_forward' | 'open_item';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Charges column: invoices and positive General Journal lines; everything else is a credit. */
function isCharge(line: { type: string; amount: string }): boolean {
  return line.type === 'invoice' || (line.type === 'general_journal' && !line.amount.startsWith('-'));
}

export default function CustomerStatementsPage() {
  const today = new Date().toISOString().slice(0, 10);

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customersLoading, setCustomersLoading] = useState(true);

  const [format, setFormat] = useState<StatementFormat>('balance_forward');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [asOfDate, setAsOfDate] = useState(today);

  const [statement, setStatement] = useState<CustomerStatement | null>(null);
  const [openItem, setOpenItem] = useState<OpenItemStatement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load customer list for the picker
  useEffect(() => {
    setCustomersLoading(true);
    api
      .get<Customer[]>('/api/customers')
      .then(setCustomers)
      .catch((err) =>
        toast(err instanceof ApiError ? err.message : 'Failed to load customers', 'danger'),
      )
      .finally(() => setCustomersLoading(false));
  }, []);

  const loadStatement = useCallback(async () => {
    if (!selectedCustomerId) {
      toast('Please select a customer.', 'danger');
      return;
    }
    setLoading(true);
    setError(null);
    setStatement(null);
    setOpenItem(null);
    try {
      if (format === 'open_item') {
        const params = new URLSearchParams({ customerId: selectedCustomerId, asOf: asOfDate });
        const data = await api.get<OpenItemStatement>(
          `/api/export/statements/open-item?${params}`,
        );
        setOpenItem(data);
      } else {
        const params = new URLSearchParams({ customerId: selectedCustomerId });
        if (fromDate) params.set('from', fromDate);
        if (toDate) params.set('to', toDate);
        const data = await api.get<CustomerStatement>(`/api/reports/customer-statement?${params}`);
        setStatement(data);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to load statement.';
      setError(msg);
      toast(msg, 'danger');
    } finally {
      setLoading(false);
    }
  }, [selectedCustomerId, fromDate, toDate, asOfDate, format]);

  function openPdf() {
    if (format === 'open_item') {
      const params = new URLSearchParams({ customerId: selectedCustomerId, asOf: asOfDate });
      window.open(`/api/export/statements/open-item/pdf?${params}`, '_blank');
    } else {
      const params = new URLSearchParams({ customerId: selectedCustomerId });
      if (fromDate) params.set('from', fromDate);
      if (toDate) params.set('to', toDate);
      window.open(`/api/reports/customer-statement/pdf?${params}`, '_blank');
    }
  }

  function batchUrl(output: 'pdf' | 'zip') {
    const params = new URLSearchParams({ format, output });
    if (format === 'open_item') {
      params.set('asOf', asOfDate);
    } else {
      if (fromDate) params.set('from', fromDate);
      if (toDate) params.set('to', toDate);
    }
    return `/api/export/statements/batch?${params}`;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const hasResult = Boolean(statement || openItem);

  const headerLabel = statement
    ? [
        statement.from ? `From: ${fmtDate(statement.from)}` : null,
        statement.to ? `To: ${fmtDate(statement.to)}` : null,
      ]
        .filter(Boolean)
        .join('  |  ') || 'All Dates'
    : openItem
      ? `As of ${fmtDate(openItem.asOf)}`
      : '';

  const activeCustomer = statement?.customer ?? openItem?.customer ?? null;
  const balanceDue = statement?.closingBalance ?? openItem?.totalDue ?? '0';

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Customer Statement"
        icon={FileText}
        action={
          hasResult && (
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={openPdf}>
                <Download className="h-4 w-4" />
                PDF
              </Button>
              <Button variant="secondary" size="sm" onClick={() => window.print()}>
                <Printer className="h-4 w-4" />
                Print
              </Button>
            </div>
          )
        }
      />

      {/* ---- Filter bar ---- */}
      <Card className="p-4 mb-6 print:hidden">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <Label htmlFor="format">Format</Label>
            <Select
              id="format"
              value={format}
              onChange={(e) => {
                setFormat(e.target.value as StatementFormat);
                setStatement(null);
                setOpenItem(null);
              }}
            >
              <option value="balance_forward">Balance Forward</option>
              <option value="open_item">Open Item</option>
            </Select>
          </div>

          <div className="min-w-[220px] flex-1">
            <Label htmlFor="customer">Customer</Label>
            <Select
              id="customer"
              value={selectedCustomerId}
              onChange={(e) => setSelectedCustomerId(e.target.value)}
              disabled={customersLoading}
            >
              <option value="">
                {customersLoading ? 'Loading…' : '— Select a customer —'}
              </option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </Select>
          </div>

          {format === 'balance_forward' ? (
            <>
              <div>
                <Label htmlFor="from">From Date</Label>
                <Input
                  id="from"
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="to">To Date</Label>
                <Input
                  id="to"
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                />
              </div>
            </>
          ) : (
            <div>
              <Label htmlFor="asOf">Statement Date</Label>
              <Input
                id="asOf"
                type="date"
                value={asOfDate}
                onChange={(e) => setAsOfDate(e.target.value)}
              />
            </div>
          )}

          <Button onClick={loadStatement} disabled={loading || !selectedCustomerId}>
            {loading ? 'Loading…' : 'View Statement'}
          </Button>
        </div>

        {/* ---- Batch generation ---- */}
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
          <span className="text-sm font-semibold text-navy/60">
            Batch — all customers with balances:
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.open(batchUrl('pdf'), '_blank')}
          >
            <Layers className="h-4 w-4" />
            Combined PDF
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.open(batchUrl('zip'), '_blank')}
          >
            <FolderArchive className="h-4 w-4" />
            ZIP (one PDF per customer)
          </Button>
          <span className="text-xs text-navy/40">
            Uses the selected format{format === 'open_item' ? ' and statement date' : ' and date range'}.
          </span>
        </div>
      </Card>

      {/* ---- Empty / loading / error states ---- */}
      {!hasResult && !loading && !error && (
        <Card>
          <div className="flex flex-col items-center justify-center py-16 text-navy/40 text-sm gap-2">
            <FileText className="h-10 w-10 opacity-30" />
            <p>Select a customer and click View Statement.</p>
          </div>
        </Card>
      )}

      {loading && (
        <Card>
          <div className="flex items-center justify-center py-16 text-navy/50 text-sm">
            Loading…
          </div>
        </Card>
      )}

      {!loading && error && (
        <Card>
          <div className="flex flex-col items-center justify-center py-16 gap-4">
            <p className="text-red-600 text-sm">{error}</p>
            <Button variant="secondary" size="sm" onClick={loadStatement}>
              Retry
            </Button>
          </div>
        </Card>
      )}

      {/* ---- Shared customer header ---- */}
      {hasResult && !loading && activeCustomer && (
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-navy">{activeCustomer.displayName}</h2>
            {activeCustomer.companyName && (
              <p className="text-sm text-navy/60">{activeCustomer.companyName}</p>
            )}
            {activeCustomer.email && (
              <p className="text-sm text-navy/60">{activeCustomer.email}</p>
            )}
          </div>
          <div className="text-right text-sm text-navy/60">
            {headerLabel && <p>{headerLabel}</p>}
            <p className="mt-1 text-base font-semibold text-navy">
              Balance Due: <span className="tabular-nums">{formatCurrency(balanceDue)}</span>
            </p>
          </div>
        </div>
      )}

      {/* ---- Balance-forward statement ---- */}
      {statement && !loading && (
        <Card className="p-0 overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Type</Th>
                <Th>Reference</Th>
                <Th className="text-right">Charges</Th>
                <Th className="text-right">Credits</Th>
                <Th className="text-right">Balance</Th>
              </tr>
            </thead>
            <tbody>
              {statement.from && (
                <tr className="bg-slate-50 text-navy/60 text-sm">
                  <Td colSpan={5} className="italic">
                    Opening balance — {fmtDate(statement.from)}
                  </Td>
                  <Td className="text-right tabular-nums font-semibold">
                    {formatCurrency(statement.openingBalance)}
                  </Td>
                </tr>
              )}

              {statement.lines.length === 0 ? (
                <tr>
                  <Td colSpan={6} className="py-12 text-center text-navy/40">
                    No activity in this period.
                  </Td>
                </tr>
              ) : (
                statement.lines.map((line, idx) => (
                  <Tr key={idx}>
                    <Td className="tabular-nums">{fmtDate(line.date)}</Td>
                    <Td>
                      {line.type === 'invoice' ? (
                        <Badge tone="info">Invoice</Badge>
                      ) : line.type === 'credit_memo' ? (
                        <Badge tone="neutral">Credit Memo</Badge>
                      ) : line.type === 'general_journal' ? (
                        <Badge tone="neutral">General Journal</Badge>
                      ) : (
                        <Badge tone="success">Payment</Badge>
                      )}
                    </Td>
                    <Td className="text-navy/70">
                      {line.type === 'invoice' && line.ref ? `#${line.ref}` : (line.ref ?? '—')}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {isCharge(line) ? formatCurrency(line.amount) : ''}
                    </Td>
                    <Td className="text-right tabular-nums text-emerald">
                      {!isCharge(line) ? formatCurrency(line.amount.replace(/^-/, '')) : ''}
                    </Td>
                    <Td className="text-right tabular-nums font-semibold">
                      {formatCurrency(line.runningBalance)}
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-navy/20 bg-navy/5 font-bold text-navy">
                <td colSpan={5} className="py-3 px-4">
                  Closing Balance
                </td>
                <td className="py-3 px-4 text-right tabular-nums">
                  {formatCurrency(statement.closingBalance)}
                </td>
              </tr>
            </tfoot>
          </Table>
        </Card>
      )}

      {/* ---- Open-item statement ---- */}
      {openItem && !loading && (
        <>
          <Card className="p-0 overflow-hidden">
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Invoice #</Th>
                  <Th>Due Date</Th>
                  <Th className="text-right">Amount</Th>
                  <Th className="text-right">Paid</Th>
                  <Th className="text-right">Days Past Due</Th>
                  <Th className="text-right">Open Balance</Th>
                </tr>
              </thead>
              <tbody>
                {openItem.lines.length === 0 ? (
                  <tr>
                    <Td colSpan={7} className="py-12 text-center text-navy/40">
                      No open invoices — account is current.
                    </Td>
                  </tr>
                ) : (
                  openItem.lines.map((line) => (
                    <Tr key={line.invoiceId}>
                      <Td className="tabular-nums">{fmtDate(line.date)}</Td>
                      <Td className="text-navy/70">#{line.invoiceNumber}</Td>
                      <Td className="tabular-nums text-navy/70">{fmtDate(line.dueDate)}</Td>
                      <Td className="text-right tabular-nums">{formatCurrency(line.total)}</Td>
                      <Td className="text-right tabular-nums text-emerald">
                        {formatCurrency(line.amountPaid)}
                      </Td>
                      <Td className="text-right">
                        {line.daysPastDue > 0 ? (
                          <Badge tone="danger">{line.daysPastDue} days</Badge>
                        ) : (
                          <Badge tone="success">Current</Badge>
                        )}
                      </Td>
                      <Td className="text-right tabular-nums font-semibold">
                        {formatCurrency(line.balanceDue)}
                      </Td>
                    </Tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-navy/20 bg-navy/5 font-bold text-navy">
                  <td colSpan={6} className="py-3 px-4">
                    Total Due
                  </td>
                  <td className="py-3 px-4 text-right tabular-nums">
                    {formatCurrency(openItem.totalDue)}
                  </td>
                </tr>
              </tfoot>
            </Table>
          </Card>

          {/* Aging summary footer */}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {(
              [
                ['Current', openItem.aging.current],
                ['1–30 Days', openItem.aging.days1_30],
                ['31–60 Days', openItem.aging.days31_60],
                ['61–90 Days', openItem.aging.days61_90],
                ['Over 90 Days', openItem.aging.days90Plus],
              ] as const
            ).map(([label, amount], i) => (
              <Card key={label} className="p-4 text-center">
                <p className="text-xs font-semibold uppercase tracking-wide text-navy/50">
                  {label}
                </p>
                <p
                  className={`mt-1 text-lg font-bold tabular-nums ${
                    i === 0 ? 'text-navy' : parseFloat(amount) > 0 ? 'text-red-600' : 'text-navy/40'
                  }`}
                >
                  {formatCurrency(amount)}
                </p>
              </Card>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
