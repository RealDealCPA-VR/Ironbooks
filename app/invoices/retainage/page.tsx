'use client';
/**
 * Retainage — what customers still owe as held-back retainage, and "Bill retainage".
 *
 * An invoice with a retainage % keeps part of its total in Retainage Receivable (account 1250)
 * instead of A/R. When the work is accepted, "Bill retainage" creates an invoice that moves the
 * released amount into A/R, where it is collected with Receive Payments. The list ties to the
 * Retainage Receivable balance on the balance sheet.
 * Data: GET/POST /api/invoices/retainage (lib/services/retainage.ts).
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, HandCoins } from 'lucide-react';
import {
  AmountInput,
  Badge,
  Button,
  Card,
  DateInput,
  EmptyState,
  Input,
  Label,
  Modal,
  PageHeader,
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
import { formatDate } from '@/lib/format';
import { useCreditLimitConfirm } from '@/components/sales/SalesExtras';
import { DocNumberField, useDocNumber, useDuplicateNumberConfirm } from '@/components/sales/DocNumberField';

interface RetainageDoc {
  invoiceId: string;
  refNumber: string;
  date: string;
  kind: 'held' | 'billed';
  amount: string;
}
interface RetainageRow {
  customerId: string;
  displayName: string;
  held: string;
  billed: string;
  open: string;
  glOpen: string;
  documents: RetainageDoc[];
}
interface RetainageReport {
  asOf: string | null;
  rows: RetainageRow[];
  totalHeld: string;
  totalBilled: string;
  totalOpen: string;
  accountBalance: string;
  ties: boolean;
}

const today = () => todayISO();

export default function RetainagePage() {
  const [asOf, setAsOf] = useState(today());
  const [report, setReport] = useState<RetainageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [billTarget, setBillTarget] = useState<RetainageRow | null>(null);
  const [billDate, setBillDate] = useState(today());
  const [billAmount, setBillAmount] = useState('');
  const [billMemo, setBillMemo] = useState('');
  const [billing, setBilling] = useState(false);
  const invNumber = useDocNumber('invoice', !!billTarget, null);
  const creditLimit = useCreditLimitConfirm();
  const dupConfirm = useDuplicateNumberConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(await api.get<RetainageReport>(`/api/invoices/retainage${asOf ? `?asOf=${asOf}` : ''}`));
    } catch (err) {
      toastError(err, 'Could not load retainage.');
    } finally {
      setLoading(false);
    }
  }, [asOf]);

  useEffect(() => {
    void load();
  }, [load]);

  function openBill(row: RetainageRow) {
    setBillTarget(row);
    setBillDate(today());
    setBillAmount(row.open);
    setBillMemo('');
  }

  async function submitBill() {
    if (!billTarget) return;
    const amt = parseFloat(billAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast('Enter the amount of retainage to bill.', 'danger');
      return;
    }
    if (amt > parseFloat(billTarget.open)) {
      toast(`Only ${formatCurrency(billTarget.open)} is still held for ${billTarget.displayName}.`, 'danger');
      return;
    }
    setBilling(true);
    try {
      const inv = await dupConfirm.run((allowDuplicateNumber) =>
        creditLimit.run((overrideCreditLimit) =>
          api.post<{ refNumber?: string | null; invoiceNumber: number }>('/api/invoices/retainage', {
            customerId: billTarget.customerId,
            date: billDate,
            amount: billAmount,
            memo: billMemo.trim() || undefined,
            refNumber: invNumber.payload,
            allowDuplicateNumber,
            overrideCreditLimit,
          }),
        ),
      );
      if (!inv) return;
      toast(`Invoice #${inv.refNumber || inv.invoiceNumber} created for the released retainage.`, 'success');
      setBillTarget(null);
      await load();
    } catch (err) {
      toastError(err, 'Could not bill the retainage.');
    } finally {
      setBilling(false);
    }
  }

  const rows = report?.rows ?? [];
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Retainage"
        icon={HandCoins}
        action={
          <Link href="/invoices" className="text-sm font-semibold text-electric hover:underline px-2">
            Back to invoices
          </Link>
        }
      />
      <p className="mb-4 max-w-3xl text-sm text-navy/60">
        Retainage is the part of an invoice your customer holds back until the job is accepted. It
        waits in Retainage Receivable, not in what the customer owes today. When it is released,
        use <strong>Bill retainage</strong> to invoice it.
      </p>

      <Card className="mb-4 flex flex-wrap items-end gap-4 p-4">
        <div>
          <Label htmlFor="ret-asof">As of</Label>
          <DateInput id="ret-asof" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </div>
        {report && (
          <div className="ml-auto text-right text-sm">
            <div className="text-navy/60">
              Still held: <span className="font-bold text-navy tabular-nums">{formatCurrency(report.totalOpen)}</span>
            </div>
            <div className={report.ties ? 'text-emerald-700' : 'text-red-600'}>
              {report.ties
                ? `Matches Retainage Receivable (${formatCurrency(report.accountBalance)})`
                : `Does not match Retainage Receivable (${formatCurrency(report.accountBalance)}) — run Verify Data`}
            </div>
          </div>
        )}
      </Card>

      <Card className="p-0 overflow-hidden">
        {!loading && rows.length === 0 ? (
          <EmptyState
            icon={HandCoins}
            title="No retainage"
            message="Invoices with a retainage % will show here until the held amount is billed."
          />
        ) : (
          <Table>
            <thead>
              <Tr>
                <Th>Customer</Th>
                <Th numeric>Held</Th>
                <Th numeric>Billed</Th>
                <Th numeric>Still held</Th>
                <Th className="text-right">Actions</Th>
              </Tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <RetainageRows
                  key={r.customerId}
                  row={r}
                  open={expanded.has(r.customerId)}
                  onToggle={() => toggle(r.customerId)}
                  onBill={() => openBill(r)}
                />
              ))}
              {report && rows.length > 0 && (
                <Tr>
                  <Td className="font-bold">Total</Td>
                  <Td numeric className="font-bold">{formatCurrency(report.totalHeld)}</Td>
                  <Td numeric className="font-bold">{formatCurrency(report.totalBilled)}</Td>
                  <Td numeric className="font-bold">{formatCurrency(report.totalOpen)}</Td>
                  <Td />
                </Tr>
              )}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal
        open={!!billTarget}
        onClose={() => setBillTarget(null)}
        title={`Bill retainage — ${billTarget?.displayName ?? ''}`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setBillTarget(null)} disabled={billing}>
              Cancel
            </Button>
            <Button onClick={submitBill} loading={billing}>
              Create invoice
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-navy/60">
            {formatCurrency(billTarget?.open ?? '0')} is still held. The invoice moves the amount you
            bill from Retainage Receivable into what the customer owes. It has no sales tax (the
            original invoices already charged it).
          </p>
          <div className="grid grid-cols-2 gap-3">
            <DocNumberField id="ret-number" label="Invoice #" value={invNumber.value} onChange={invNumber.setValue} />
            <div>
              <Label htmlFor="ret-date" required>Invoice date</Label>
              <DateInput id="ret-date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="ret-amount" required>Amount to bill</Label>
            <AmountInput id="ret-amount" value={billAmount} onChange={(e) => setBillAmount(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ret-memo">Memo</Label>
            <Input id="ret-memo" placeholder="Retainage billed" value={billMemo} onChange={(e) => setBillMemo(e.target.value)} />
          </div>
        </div>
        {creditLimit.dialog}
        {dupConfirm.dialog}
      </Modal>
    </main>
  );
}

function RetainageRows({
  row,
  open,
  onToggle,
  onBill,
}: {
  row: RetainageRow;
  open: boolean;
  onToggle: () => void;
  onBill: () => void;
}) {
  const stillHeld = parseFloat(row.open) > 0;
  return (
    <>
      <Tr>
        <Td>
          <button
            type="button"
            className="inline-flex items-center gap-1 font-semibold text-navy"
            onClick={onToggle}
            aria-expanded={open}
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            {row.displayName}
          </button>
        </Td>
        <Td numeric>{formatCurrency(row.held)}</Td>
        <Td numeric>{formatCurrency(row.billed)}</Td>
        <Td numeric className="font-semibold">{formatCurrency(row.open)}</Td>
        <Td className="text-right">
          {stillHeld ? (
            <Button size="sm" onClick={onBill}>
              Bill retainage
            </Button>
          ) : (
            <Badge tone="success">All billed</Badge>
          )}
        </Td>
      </Tr>
      {open &&
        row.documents.map((d) => (
          <Tr key={`${d.invoiceId}-${d.kind}`}>
            <Td className="pl-10 text-sm text-navy/70">
              {formatDate(d.date)} · Invoice #{d.refNumber}
            </Td>
            <Td numeric className="text-sm">{d.kind === 'held' ? formatCurrency(d.amount) : ''}</Td>
            <Td numeric className="text-sm">{d.kind === 'billed' ? formatCurrency(d.amount) : ''}</Td>
            <Td />
            <Td className="text-right text-xs text-navy/50">{d.kind === 'held' ? 'Held back' : 'Billed'}</Td>
          </Tr>
        ))}
    </>
  );
}
