'use client';
/**
 * Pay Sales Tax (QB Vendors > Sales Tax > Pay Sales Tax). Needs the Sales Tax permission (not
 * payroll). The grid shows what each tax agency is owed through the "Show sales tax due through"
 * date — by default the end of the last filing period for the company's filing frequency — on
 * the company's sales tax basis (accrual: as of the invoice date; cash: as customers pay).
 *
 * Paying writes one Sales Tax Payment CHECK per agency from a bank account: the agency's vendor is
 * the payee, the check gets the next number or waits in Print Checks ("To be printed"). Recent
 * payments can be printed or voided below.
 */
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Printer, Receipt } from 'lucide-react';
import {
  Badge,
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
  toastError,
} from '@/components/ui';
import { api } from '@/lib/client';
import { todayISO } from '@/lib/dates';
import { isBankAccount } from '@/lib/accountTypes';
import { Money, formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import { saveWithDuplicateCheck } from '@/lib/purchasesClient';

interface DueRow {
  agencyId: string | null;
  agencyName: string | null;
  payee: string | null;
  owedThrough: string;
  settledLater: string;
  amountDue: string;
}

interface Screen {
  basis: 'accrual' | 'cash';
  frequency: 'monthly' | 'quarterly' | 'annually';
  defaultDueThrough: string;
  dueThrough: string;
  rows: DueRow[];
  totalDue: string;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
}

interface PaymentCheck {
  id: string;
  date: string;
  payeeName: string;
  amount: string;
  reference: string | null;
  toPrint: boolean;
  memo: string | null;
  paymentAccountName: string | null;
  isVoid: boolean;
}

const FREQ_LABEL: Record<Screen['frequency'], string> = {
  monthly: 'monthly',
  quarterly: 'quarterly',
  annually: 'yearly',
};

const today = () => todayISO();

async function openCheckPdf(id: string) {
  const res = await fetch('/api/checks/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'payment_check', id }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Server error ${res.status}`);
  }
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export default function PaySalesTaxPage() {
  const [screen, setScreen] = useState<Screen | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [payments, setPayments] = useState<PaymentCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [dueThrough, setDueThrough] = useState('');
  const [checkDate, setCheckDate] = useState(today());
  const [payFrom, setPayFrom] = useState('');
  const [toPrint, setToPrint] = useState(false);
  const [firstNumber, setFirstNumber] = useState('');
  const [memo, setMemo] = useState('');
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [voidingId, setVoidingId] = useState<string | null>(null);
  /** Bumped after checks are written or voided, so the next check number is looked up again. */
  const [numberTick, setNumberTick] = useState(0);

  const banks = useMemo(() => accounts.filter((a) => isBankAccount(a)), [accounts]);

  const load = useCallback(async (through?: string) => {
    setLoading(true);
    try {
      const qs = through ? `?dueThrough=${encodeURIComponent(through)}` : '';
      const [s, accts, pays] = await Promise.all([
        api.get<Screen>(`/api/sales-tax/pay${qs}`),
        api.get<Account[]>('/api/accounts'),
        api.get<{ items: PaymentCheck[] }>('/api/sales-tax/payments'),
      ]);
      setScreen(s);
      setDueThrough(s.dueThrough);
      setAccounts(accts);
      setPayments(pays.items);
      setPicked({});
      setPayFrom((prev) => prev || accts.find((a) => isBankAccount(a))?.id || '');
    } catch (err) {
      toastError(err, 'Could not load sales tax due.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!payFrom || toPrint) return;
    let live = true;
    api
      .get<{ next: string }>(`/api/check-numbers/next?paymentAccountId=${payFrom}`)
      .then((r) => live && setFirstNumber(r.next))
      .catch(() => {});
    return () => {
      live = false;
    };
    // numberTick: the checks just written used the numbers shown, so look the next one up again
    // (the field kept the used number and the next payment was refused as a duplicate).
  }, [payFrom, toPrint, numberTick]);

  const payable = (screen?.rows ?? []).filter((r) => r.agencyId);
  const selectedTotal = Object.values(picked).reduce((t, v) => {
    try {
      return t.plus(Money.of(v || 0));
    } catch {
      return t;
    }
  }, Money.zero());

  function toggle(row: DueRow, on: boolean) {
    if (!row.agencyId) return;
    setPicked((prev) => {
      const next = { ...prev };
      if (on) next[row.agencyId!] = Money.gt(row.amountDue, 0) ? row.amountDue : '';
      else delete next[row.agencyId!];
      return next;
    });
  }

  function payAll() {
    const next: Record<string, string> = {};
    for (const r of payable) if (r.agencyId && Money.gt(r.amountDue, 0)) next[r.agencyId] = r.amountDue;
    setPicked(next);
  }

  async function handlePay() {
    const lines = Object.entries(picked).map(([agencyId, amount]) => ({ agencyId, amount: amount.trim() }));
    if (lines.length === 0) {
      toast('Tick the tax agencies you want to pay.', 'danger');
      return;
    }
    if (lines.some((l) => !l.amount || !Money.gt(l.amount, 0))) {
      toast('Each payment needs an amount greater than zero.', 'danger');
      return;
    }
    if (!payFrom) {
      toast('Pick the bank account to pay from.', 'danger');
      return;
    }
    setSaving(true);
    try {
      const res = await saveWithDuplicateCheck((allowDuplicateNumber) =>
        api.post<{ checks: PaymentCheck[]; total: string }>('/api/sales-tax/pay', {
          date: `${checkDate}T12:00:00.000Z`,
          paymentAccountId: payFrom,
          payments: lines,
          memo: memo.trim() || undefined,
          checkNumber: toPrint ? undefined : firstNumber.trim() || undefined,
          toPrint,
          dueThrough,
          allowDuplicateNumber,
        }),
      );
      if (res === null) return;
      toast(
        `${res.checks.length} sales tax check${res.checks.length === 1 ? '' : 's'} written for ${formatCurrency(res.total)}${toPrint ? ' — waiting in Print Checks' : ''}.`,
        'success',
      );
      setMemo('');
      setNumberTick((n) => n + 1);
      await load(dueThrough);
    } catch (err) {
      toastError(err, 'Could not record the sales tax payment.');
    } finally {
      setSaving(false);
    }
  }

  async function handleVoid(p: PaymentCheck) {
    if (!window.confirm(`Void the ${formatCurrency(p.amount)} payment to ${p.payeeName}? The tax will show as owed again.`)) return;
    setVoidingId(p.id);
    try {
      await api.post(`/api/sales-tax/payments/${p.id}`, { action: 'void' });
      toast('Sales tax payment voided.', 'success');
      setNumberTick((n) => n + 1);
      await load(dueThrough);
    } catch (err) {
      toastError(err, 'Could not void the payment.');
    } finally {
      setVoidingId(null);
    }
  }

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader title="Pay Sales Tax" icon={Receipt} />

      {loading && !screen ? (
        <div className="mt-8 flex justify-center text-electric">
          <Spinner className="h-6 w-6" />
        </div>
      ) : screen ? (
        <div className="mt-6 max-w-5xl space-y-6">
          <Card className="p-6 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <Label htmlFor="st-from">Pay from account</Label>
                <Select id="st-from" value={payFrom} onChange={(e) => setPayFrom(e.target.value)}>
                  <option value="">Select a bank account…</option>
                  {banks.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="st-date">Check date</Label>
                <Input id="st-date" type="date" value={checkDate} onChange={(e) => setCheckDate(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="st-through">Show sales tax due through</Label>
                <Input
                  id="st-through"
                  type="date"
                  value={dueThrough}
                  onChange={(e) => setDueThrough(e.target.value)}
                  onBlur={() => dueThrough && dueThrough !== screen.dueThrough && load(dueThrough)}
                />
              </div>
              <div>
                <Label htmlFor="st-number">Starting check no.</Label>
                <Input
                  id="st-number"
                  value={toPrint ? '' : firstNumber}
                  disabled={toPrint}
                  placeholder={toPrint ? 'Assigned when printed' : 'e.g. 1001'}
                  onChange={(e) => setFirstNumber(e.target.value)}
                />
                <label className="mt-1 flex items-center gap-2 text-xs text-navy/70">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-electric"
                    checked={toPrint}
                    onChange={(e) => setToPrint(e.target.checked)}
                  />
                  To be printed
                </label>
              </div>
            </div>
            <p className="text-xs text-navy/50">
              You owe sales tax{' '}
              <strong>{screen.basis === 'cash' ? 'when your customers pay you (cash basis)' : 'as of the invoice date (accrual basis)'}</strong>{' '}
              and file <strong>{FREQ_LABEL[screen.frequency]}</strong>, so the due-through date starts at the end of your last
              filing period ({formatDate(screen.defaultDueThrough, 'MMM d, yyyy')}). Change these in{' '}
              <Link href="/settings" className="text-electric hover:underline">Preferences &gt; Sales Tax</Link>.
              {' '}Payments recorded after the due-through date are already taken off.
            </p>
          </Card>

          <Card className="p-0 overflow-hidden">
            <div className="flex items-center justify-between p-6 pb-3">
              <div>
                <h2 className="text-base font-bold text-navy">Sales tax due</h2>
                <p className="text-xs text-navy/50">One check is written to each agency you tick.</p>
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={payAll} disabled={payable.length === 0}>
                  Pay all tax
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setPicked({})}>
                  Clear
                </Button>
              </div>
            </div>
            {screen.rows.length === 0 ? (
              <p className="px-6 pb-6 text-sm text-navy/40">No sales tax is due through this date.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Pay</Th>
                    <Th>Agency (payee)</Th>
                    <Th numeric>Owed through date</Th>
                    <Th numeric>Already paid after</Th>
                    <Th numeric>Amount due</Th>
                    <Th numeric>Amount to pay</Th>
                  </tr>
                </thead>
                <tbody>
                  {screen.rows.map((r) => {
                    const on = r.agencyId != null && picked[r.agencyId] !== undefined;
                    return (
                      <Tr key={r.agencyId ?? '__none__'}>
                        <Td>
                          {r.agencyId ? (
                            <input
                              type="checkbox"
                              aria-label={`Pay ${r.agencyName ?? 'agency'}`}
                              className="h-4 w-4 accent-electric"
                              checked={on}
                              onChange={(e) => toggle(r, e.target.checked)}
                            />
                          ) : null}
                        </Td>
                        <Td className="font-semibold text-navy">
                          {r.agencyName ?? (
                            <Link href="/accountant/fix-sales-tax" className="italic text-navy/50 hover:text-electric hover:underline">
                              Not tied to an agency — fix
                            </Link>
                          )}
                          {r.payee && r.payee !== r.agencyName && (
                            <span className="ml-2 text-[11px] font-normal text-navy/40">pay to {r.payee}</span>
                          )}
                        </Td>
                        <Td numeric className="text-navy/70">{formatCurrency(r.owedThrough)}</Td>
                        <Td numeric className="text-navy/70">{formatCurrency(r.settledLater)}</Td>
                        <Td numeric className={Money.gt(r.amountDue, 0) ? 'font-semibold text-red-500' : 'text-navy/40'}>
                          {formatCurrency(r.amountDue)}
                        </Td>
                        <Td numeric>
                          {r.agencyId && on ? (
                            <Input
                              aria-label={`Amount to pay ${r.agencyName ?? ''}`}
                              type="number"
                              min="0.01"
                              step="0.01"
                              className="w-32 text-right"
                              value={picked[r.agencyId]}
                              onChange={(e) => setPicked((p) => ({ ...p, [r.agencyId!]: e.target.value }))}
                            />
                          ) : (
                            '—'
                          )}
                        </Td>
                      </Tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-navy/20 bg-navy/5 font-bold text-navy">
                    <td className="py-3 px-4" colSpan={4}>
                      Total
                    </td>
                    <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(screen.totalDue)}</td>
                    <td className="py-3 px-4 text-right tabular-nums">{formatCurrency(selectedTotal.toFixed(2))}</td>
                  </tr>
                </tfoot>
              </Table>
            )}
            <div className="flex flex-wrap items-end justify-between gap-4 p-6">
              <div className="flex-1 min-w-[16rem]">
                <Label htmlFor="st-memo">Memo (optional)</Label>
                <Input
                  id="st-memo"
                  placeholder="Leave blank to print the agency account number"
                  value={memo}
                  onChange={(e) => setMemo(e.target.value)}
                />
              </div>
              <div className="flex gap-3 text-xs">
                <Link href="/accountant/sales-tax-adjustment" className="text-electric hover:underline">Adjust sales tax due</Link>
                <Link href="/reports/sales-tax" className="text-electric hover:underline">Sales tax liability report</Link>
              </div>
              <Button onClick={handlePay} loading={saving} disabled={Object.keys(picked).length === 0}>
                Write {Object.keys(picked).length || ''} check{Object.keys(picked).length === 1 ? '' : 's'}
              </Button>
            </div>
          </Card>

          <Card className="p-0 overflow-hidden">
            <div className="p-6 pb-3">
              <h2 className="text-base font-bold text-navy">Sales tax payments</h2>
            </div>
            {payments.length === 0 ? (
              <p className="px-6 pb-6 text-sm text-navy/40">No sales tax payments yet.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Check no.</Th>
                    <Th>Pay to</Th>
                    <Th>Bank account</Th>
                    <Th numeric>Amount</Th>
                    <Th className="text-right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <Tr key={p.id}>
                      <Td>{formatDate(p.date, 'MMM d, yyyy')}</Td>
                      <Td>
                        {p.isVoid ? (
                          <Badge tone="danger">Void</Badge>
                        ) : p.toPrint ? (
                          <Badge tone="warning">To print</Badge>
                        ) : (
                          (p.reference ?? '—')
                        )}
                      </Td>
                      <Td className="font-medium">{p.payeeName}</Td>
                      <Td>{p.paymentAccountName ?? '—'}</Td>
                      <Td numeric className={p.isVoid ? 'line-through text-navy/40' : ''}>{formatCurrency(p.amount)}</Td>
                      <Td className="text-right">
                        {!p.isVoid && (
                          <div className="flex justify-end gap-1">
                            {p.toPrint ? (
                              <Link href="/print-checks">
                                <Button variant="ghost" size="sm">
                                  <Printer className="h-4 w-4" /> Print Checks
                                </Button>
                              </Link>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openCheckPdf(p.id).catch((e) => toastError(e, 'Could not open the check.'))}
                              >
                                <Printer className="h-4 w-4" /> Reprint
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" loading={voidingId === p.id} onClick={() => handleVoid(p)}>
                              Void
                            </Button>
                          </div>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      ) : null}
    </main>
  );
}
