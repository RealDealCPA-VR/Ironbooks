'use client';
/**
 * Batch Invoicing (wave2 sales C6) — bill the same items to a group of customers at once.
 * Each invoice is a normal, fully posted invoice; customers who cannot be billed (inactive, over
 * their credit limit) are listed afterwards instead of blocking the rest.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Layers } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  DateInput,
  Input,
  Label,
  PageHeader,
  Select,
  Table,
  Td,
  Th,
  Tr,
  toast,
  toastError,
} from '@/components/ui';
import { api } from '@/lib/client';
import { todayISO } from '@/lib/dates';
import { formatCurrency } from '@/lib/money';
import {
  PricedLinesEditor,
  emptyPricedLine,
  type PricedLineItem,
  type PricedLineValue,
} from '@/components/PricedLinesEditor';

interface Customer {
  id: string;
  displayName: string;
  isActive?: boolean;
  customerTypeId?: string | null;
  terms?: string | null;
}
interface TypeRow {
  id: string;
  name: string;
}
interface TaxRate {
  id: string;
  name: string;
  rate: string;
}
interface Result {
  created: Array<{ customerId: string; customerName: string; invoiceNumber: number; total: string }>;
  skipped: Array<{ customerId: string; customerName: string; reason: string; code: string }>;
}

export default function BatchInvoicingPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [types, setTypes] = useState<TypeRow[]>([]);
  const [items, setItems] = useState<PricedLineItem[]>([]);
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [date, setDate] = useState(todayISO());
  const [dueDate, setDueDate] = useState('');
  const [taxMode, setTaxMode] = useState('customer');
  const [memo, setMemo] = useState('');
  const [toBePrinted, setToBePrinted] = useState(false);
  const [toBeEmailed, setToBeEmailed] = useState(false);
  const [lines, setLines] = useState<PricedLineValue[]>([emptyPricedLine()]);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    api.get<Customer[]>('/api/customers').then((c) => setCustomers(Array.isArray(c) ? c : [])).catch(() => {});
    api.get<{ types: TypeRow[] }>('/api/type-lists/customer').then((r) => setTypes(r.types ?? [])).catch(() => {});
    api.get<{ items: PricedLineItem[] }>('/api/items').then((r) => setItems(r.items ?? [])).catch(() => {});
    api.get<TaxRate[]>('/api/tax-rates').then((r) => setTaxRates(Array.isArray(r) ? r : [])).catch(() => {});
  }, []);

  const visible = useMemo(
    () =>
      customers.filter(
        (c) =>
          c.isActive !== false &&
          (!typeFilter || c.customerTypeId === typeFilter) &&
          (!search || c.displayName.toLowerCase().includes(search.toLowerCase())),
      ),
    [customers, typeFilter, search],
  );
  const perInvoice = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.rate) || 0), 0);

  async function submit(override = false) {
    const valid = lines.filter((l) => l.itemId || l.description || l.rate);
    if (picked.size === 0) return toast('Pick at least one customer.', 'danger');
    if (valid.length === 0) return toast('Add at least one line to bill.', 'danger');
    setSaving(true);
    try {
      const r = await api.post<Result>('/api/invoices/batch', {
        customerIds: [...picked],
        date,
        dueDate: dueDate || null,
        memo: memo || null,
        toBePrinted,
        toBeEmailed,
        overrideCreditLimit: override,
        ...(taxMode === 'customer'
          ? { useCustomerTaxRate: true }
          : { useCustomerTaxRate: false, taxRateId: taxMode === 'none' ? null : taxMode }),
        lines: valid.map((l) => ({
          itemId: l.itemId || null,
          description: l.description || null,
          quantity: l.quantity || '1',
          rate: l.rate === '' ? null : l.rate,
          taxable: l.taxable,
        })),
      });
      setResult(r);
      toast(`${r.created.length} invoice${r.created.length === 1 ? '' : 's'} created.`, 'success');
      setPicked(new Set(r.skipped.map((s) => s.customerId)));
    } catch (err) {
      toastError(err, 'Batch invoicing did not work.');
    } finally {
      setSaving(false);
    }
  }

  const overLimit = result?.skipped.filter((s) => s.code === 'CREDIT_LIMIT') ?? [];

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Batch Invoicing"
        icon={Layers}
        action={<Link href="/invoices" className="text-sm font-semibold text-electric hover:underline">Back to invoices</Link>}
      />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-4 lg:col-span-1">
          <h2 className="font-bold text-navy mb-2">1. Who to bill</h2>
          <div className="space-y-2">
            <Input placeholder="Search customers" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search customers" />
            {types.length > 0 && (
              <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Customer type">
                <option value="">All customer types</option>
                {types.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </Select>
            )}
            <div className="flex gap-2 text-sm">
              <button type="button" className="text-electric hover:underline" onClick={() => setPicked(new Set([...picked, ...visible.map((c) => c.id)]))}>
                Select all shown
              </button>
              <button type="button" className="text-electric hover:underline" onClick={() => setPicked(new Set())}>
                Clear
              </button>
              <span className="ml-auto text-navy/50">{picked.size} picked</span>
            </div>
            <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-100">
              {visible.map((c) => (
                <label key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={picked.has(c.id)}
                    onChange={(e) =>
                      setPicked((prev) => {
                        const n = new Set(prev);
                        if (e.target.checked) n.add(c.id);
                        else n.delete(c.id);
                        return n;
                      })
                    }
                  />
                  {c.displayName}
                </label>
              ))}
            </div>
          </div>
        </Card>

        <Card className="p-4 lg:col-span-2 space-y-4">
          <h2 className="font-bold text-navy">2. What to bill</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label htmlFor="bi-date" required>Invoice date</Label>
              <DateInput id="bi-date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="bi-due">Due date</Label>
              <DateInput id="bi-due" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              <p className="text-xs text-navy/40 mt-1">Blank = from each customer&apos;s terms.</p>
            </div>
            <div>
              <Label htmlFor="bi-tax">Sales tax</Label>
              <Select id="bi-tax" value={taxMode} onChange={(e) => setTaxMode(e.target.value)}>
                <option value="customer">Each customer&apos;s own tax rate</option>
                <option value="none">No tax</option>
                {taxRates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name} for everyone</option>
                ))}
              </Select>
            </div>
          </div>
          <PricedLinesEditor items={items} lines={lines} onChange={setLines} header={{ customerId: null, date }} showTaxable />
          <div>
            <Label htmlFor="bi-memo">Memo</Label>
            <Input id="bi-memo" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional" />
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm text-navy/80">
            <label className="flex items-center gap-2"><input type="checkbox" checked={toBePrinted} onChange={(e) => setToBePrinted(e.target.checked)} /> To be printed</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={toBeEmailed} onChange={(e) => setToBeEmailed(e.target.checked)} /> To be emailed</label>
            <span className="ml-auto">
              About {formatCurrency(perInvoice.toFixed(2))} each (before tax and customer prices)
            </span>
          </div>
          <div className="flex justify-end">
            <Button loading={saving} onClick={() => submit(false)}>
              Create {picked.size} invoice{picked.size === 1 ? '' : 's'}
            </Button>
          </div>
        </Card>
      </div>

      {result && (
        <Card className="mt-4 p-4">
          <h2 className="font-bold text-navy mb-2">Results</h2>
          <Table>
            <thead>
              <Tr>
                <Th>Customer</Th>
                <Th>Result</Th>
                <Th numeric>Total</Th>
              </Tr>
            </thead>
            <tbody>
              {result.created.map((c) => (
                <Tr key={c.customerId}>
                  <Td>{c.customerName}</Td>
                  <Td><Badge tone="success">Invoice #{c.invoiceNumber}</Badge></Td>
                  <Td numeric>{formatCurrency(c.total)}</Td>
                </Tr>
              ))}
              {result.skipped.map((s) => (
                <Tr key={s.customerId}>
                  <Td>{s.customerName}</Td>
                  <Td><span className="text-red-600 text-sm">{s.reason}</span></Td>
                  <Td numeric>—</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          {overLimit.length > 0 && (
            <div className="mt-3 flex items-center gap-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
              {overLimit.length} customer{overLimit.length === 1 ? ' is' : 's are'} over the credit limit (still picked).
              <Button size="sm" variant="secondary" loading={saving} onClick={() => submit(true)}>
                Bill them anyway
              </Button>
            </div>
          )}
        </Card>
      )}
    </main>
  );
}
