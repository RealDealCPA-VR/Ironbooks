'use client';

/**
 * Loan Manager (QB Banking > Loan Manager).
 *
 * Track loans against a liability account: see the payment, remaining balance and the
 * amortization schedule, and "Set up payment" to write the next payment as a check or a bill
 * split between principal (reduces the loan), interest (expense) and escrow.
 */
import { useCallback, useEffect, useState } from 'react';
import { Landmark, Plus } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Label,
  Modal,
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
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/utils';
import { saveWithDuplicateCheck } from '@/lib/purchasesClient';

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
}
interface Vendor {
  id: string;
  displayName: string;
  /** p1 fx: the vendor's currency (null = home). */
  currency?: string | null;
}
interface ScheduleRow {
  number: number;
  date: string;
  payment: string;
  principal: string;
  interest: string;
  escrow: string;
  total: string;
  balance: string;
}
interface LoanRow {
  id: string;
  name: string;
  lenderName: string | null;
  liabilityAccountName: string | null;
  originalAmount: string;
  annualRate: string;
  termMonths: number;
  paymentsPerYear: number;
  payment: string;
  balance: string;
  paymentsMade: number;
  numberOfPayments: number;
  next: ScheduleRow | null;
  /** p1 fx: loan currency (null = home) and the rate it was booked at. */
  currency?: string | null;
  exchangeRate?: string | null;
}
interface LoanDetail extends LoanRow {
  lenderVendorId: string | null;
  liabilityAccountId: string;
  interestAccountId: string;
  escrowAccountId: string | null;
  paymentAccountId: string | null;
  originDate: string;
  firstPaymentDate: string;
  escrowAmount: string;
  notes: string | null;
  principalPaid: string;
  interestPaid: string;
  schedule: ScheduleRow[];
  payments: Array<{ id: string; paymentNumber: number; date: string; total: string; principal: string; interest: string; kind: string; active: boolean; reference: string | null }>;
}

const FREQUENCIES: Array<[number, string]> = [
  [12, 'Monthly'],
  [26, 'Every two weeks'],
  [52, 'Weekly'],
  [24, 'Twice a month'],
  [4, 'Quarterly'],
  [2, 'Twice a year'],
  [1, 'Yearly'],
];

const today = () => new Date().toISOString().slice(0, 10);

function emptyForm() {
  return {
    name: '',
    lenderVendorId: '',
    liabilityAccountId: '',
    interestAccountId: '',
    escrowAccountId: '',
    paymentAccountId: '',
    originalAmount: '',
    annualRate: '',
    termMonths: '60',
    paymentsPerYear: '12',
    originDate: today(),
    firstPaymentDate: today(),
    escrowAmount: '',
    notes: '',
    exchangeRate: '',
  };
}

export default function LoansPage() {
  const [loans, setLoans] = useState<LoanRow[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<LoanDetail | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);

  const [payOpen, setPayOpen] = useState(false);
  const [payKind, setPayKind] = useState<'check' | 'bill'>('check');
  const [pay, setPay] = useState({ date: today(), paymentAccountId: '', principal: '', interest: '', escrow: '', reference: '', toPrint: false, exchangeRate: '' });

  const refresh = useCallback(async () => {
    try {
      const data = await api.get<{ loans: LoanRow[] }>('/api/loans');
      setLoans(data.loans);
    } catch (err) {
      toastError(err, 'Failed to load loans.');
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [a, v] = await Promise.all([api.get<Account[]>('/api/accounts'), api.get<Vendor[]>('/api/vendors')]);
        setAccounts(a);
        setVendors(v);
        await refresh();
      } catch (err) {
        toastError(err, 'Failed to load data.');
      } finally {
        setLoading(false);
      }
    })();
  }, [refresh]);

  async function openDetail(id: string) {
    try {
      setDetail(await api.get<LoanDetail>(`/api/loans/${id}`));
    } catch (err) {
      toastError(err, 'Failed to load the loan.');
    }
  }

  function openNew() {
    setEditingId(null);
    setForm(emptyForm());
    setFormOpen(true);
  }

  function openEdit(d: LoanDetail) {
    setEditingId(d.id);
    setForm({
      name: d.name,
      lenderVendorId: d.lenderVendorId ?? '',
      liabilityAccountId: d.liabilityAccountId,
      interestAccountId: d.interestAccountId,
      escrowAccountId: d.escrowAccountId ?? '',
      paymentAccountId: d.paymentAccountId ?? '',
      originalAmount: d.originalAmount,
      annualRate: String(Number(d.annualRate)),
      termMonths: String(d.termMonths),
      paymentsPerYear: String(d.paymentsPerYear),
      originDate: d.originDate.slice(0, 10),
      firstPaymentDate: d.firstPaymentDate.slice(0, 10),
      escrowAmount: Number(d.escrowAmount) > 0 ? d.escrowAmount : '',
      notes: d.notes ?? '',
      exchangeRate: d.exchangeRate ? String(Number(d.exchangeRate)) : '',
    });
    setFormOpen(true);
  }

  async function saveLoan() {
    setSaving(true);
    try {
      const body = {
        ...form,
        lenderVendorId: form.lenderVendorId || null,
        escrowAccountId: form.escrowAccountId || null,
        paymentAccountId: form.paymentAccountId || null,
        escrowAmount: form.escrowAmount || null,
        termMonths: Number(form.termMonths),
        paymentsPerYear: Number(form.paymentsPerYear),
        notes: form.notes || null,
        exchangeRate: lenderCurrency && form.exchangeRate.trim() ? form.exchangeRate.trim() : null,
      };
      if (editingId) await api.patch(`/api/loans/${editingId}`, body);
      else await api.post('/api/loans', body);
      toast(editingId ? 'Loan updated.' : 'Loan added.', 'success');
      setFormOpen(false);
      await refresh();
      if (editingId) await openDetail(editingId);
    } catch (err) {
      toastError(err, 'Failed to save the loan.');
    } finally {
      setSaving(false);
    }
  }

  // p1 fx: currency of the open loan / of the lender picked on the form.
  const cur = detail?.currency ?? undefined;
  const lenderCurrency = vendors.find((v) => v.id === form.lenderVendorId)?.currency || null;

  async function voidPayment(paymentId: string) {
    if (!detail) return;
    if (!confirm('Void this loan payment? Its check or bill is voided and the principal goes back on the loan.')) return;
    try {
      await api.del(`/api/loans/${detail.id}/payments?paymentId=${paymentId}`);
      toast('Loan payment voided.', 'success');
      await refresh();
      await openDetail(detail.id);
    } catch (err) {
      toastError(err, 'Failed to void the payment.');
    }
  }

  function openPay(kind: 'check' | 'bill') {
    if (!detail?.next) return;
    setPayKind(kind);
    setPay({
      date: detail.next.date.slice(0, 10),
      paymentAccountId: detail.paymentAccountId ?? '',
      principal: detail.next.principal,
      interest: detail.next.interest,
      escrow: detail.next.escrow,
      reference: '',
      toPrint: false,
      exchangeRate: '',
    });
    setPayOpen(true);
  }

  async function savePayment() {
    if (!detail) return;
    setSaving(true);
    try {
      const saved = await saveWithDuplicateCheck(() =>
        api.post(`/api/loans/${detail.id}/payments`, {
          kind: payKind,
          date: pay.date,
          paymentAccountId: payKind === 'check' ? pay.paymentAccountId || null : null,
          principal: pay.principal,
          interest: pay.interest,
          escrow: pay.escrow || '0',
          reference: pay.toPrint ? null : pay.reference || null,
          toPrint: payKind === 'check' ? pay.toPrint : false,
          ...(detail.currency && pay.exchangeRate.trim() ? { exchangeRate: pay.exchangeRate.trim() } : {}),
        }),
      );
      if (saved === null) return;
      toast(payKind === 'check' ? 'Loan payment check written.' : 'Loan payment bill entered.', 'success');
      setPayOpen(false);
      await refresh();
      await openDetail(detail.id);
    } catch (err) {
      toastError(err, 'Failed to set up the payment.');
    } finally {
      setSaving(false);
    }
  }

  const liabilityAccounts = accounts.filter((a) => a.type === 'liability' && a.subtype !== 'accounts_payable' && a.subtype !== 'credit_card');
  const expenseAccounts = accounts.filter((a) => a.type === 'expense');
  const bankAccounts = accounts.filter((a) => a.type === 'asset' && ['checking', 'savings'].includes(a.subtype));
  const set = (k: keyof ReturnType<typeof emptyForm>) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const acctOptions = (list: Account[]) =>
    list.map((a) => (
      <option key={a.id} value={a.id}>
        {a.code} – {a.name}
      </option>
    ));

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Loan Manager"
        icon={Landmark}
        action={
          <Button onClick={openNew}>
            <Plus className="h-4 w-4" /> Add a Loan
          </Button>
        }
      />
      <p className="-mt-4 mb-4 text-sm text-navy/60">
        Track what you still owe on each loan. &quot;Set up payment&quot; writes the next payment as a check or a
        bill, split between the part that pays down the loan (principal) and the interest. Record the money you
        received from the loan the usual way (a deposit or journal entry into the loan account).
      </p>

      <Card className="p-0 overflow-hidden mb-6">
        {loading ? (
          <div className="p-12 flex items-center justify-center gap-2 text-navy/40 text-sm">
            <Spinner className="h-4 w-4" /> Loading loans…
          </div>
        ) : loans.length === 0 ? (
          <EmptyState icon={Landmark} title="No loans yet" message="Add a loan to see its payment schedule and set up payments." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Loan</Th>
                <Th>Lender</Th>
                <Th numeric>Payment</Th>
                <Th numeric>Balance owed</Th>
                <Th>Next payment</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {loans.map((l) => (
                <Tr key={l.id}>
                  <Td className="font-medium">{l.name}</Td>
                  <Td>{l.lenderName ?? '—'}</Td>
                  <Td numeric>{formatCurrency(l.payment, l.currency ?? undefined)}</Td>
                  <Td numeric className="font-semibold">{formatCurrency(l.balance, l.currency ?? undefined)}</Td>
                  <Td>{l.next ? `#${l.next.number} on ${formatDate(l.next.date, 'MMM d, yyyy')}` : <Badge tone="success">Paid off</Badge>}</Td>
                  <Td className="text-right">
                    <Button size="sm" variant="secondary" onClick={() => openDetail(l.id)}>
                      Open
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {detail && (
        <Card className="p-6 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-navy">{detail.name}</h2>
              <p className="text-sm text-navy/60">
                {formatCurrency(detail.originalAmount, cur)} at {Number(detail.annualRate)}% for {detail.termMonths} months —{' '}
                {detail.paymentsMade} of {detail.numberOfPayments} payments made. Principal paid {formatCurrency(detail.principalPaid, cur)},
                interest paid {formatCurrency(detail.interestPaid, cur)}.
              </p>
              {detail.currency && (
                <p className="text-xs text-navy/50 mt-1">
                  This loan is in {detail.currency}, booked at {Number(detail.exchangeRate ?? 0)} home per {detail.currency}. Payments are
                  converted at their own rate; the difference on the principal is recorded as an exchange gain or loss.
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => openEdit(detail)}>
                Edit loan
              </Button>
              <Button disabled={!detail.next} onClick={() => openPay('check')}>
                Set up payment (check)
              </Button>
              <Button variant="secondary" disabled={!detail.next || !detail.lenderVendorId} onClick={() => openPay('bill')} title={detail.lenderVendorId ? '' : 'Set the lender on the loan to enter bills'}>
                Set up payment (bill)
              </Button>
            </div>
          </div>

          {detail.payments.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-navy mb-2">Payments made</h3>
              <Table>
                <thead>
                  <tr>
                    <Th>#</Th>
                    <Th>Date</Th>
                    <Th>Paid by</Th>
                    <Th numeric>Principal</Th>
                    <Th numeric>Interest</Th>
                    <Th numeric>Total</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {detail.payments.map((p) => (
                    <Tr key={p.id} className={p.active ? undefined : 'opacity-50 line-through'}>
                      <Td>{p.paymentNumber}</Td>
                      <Td>{formatDate(p.date, 'MMM d, yyyy')}</Td>
                      <Td>
                        {p.kind === 'check' ? 'Check' : 'Bill'} {p.reference ?? ''} {!p.active && <Badge tone="danger">Void</Badge>}
                      </Td>
                      <Td numeric>{formatCurrency(p.principal, cur)}</Td>
                      <Td numeric>{formatCurrency(p.interest, cur)}</Td>
                      <Td numeric>{formatCurrency(p.total, cur)}</Td>
                      <Td className="text-right">
                        {p.active && (
                          <Button size="sm" variant="ghost" onClick={() => voidPayment(p.id)}>
                            Void
                          </Button>
                        )}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}

          <div>
            <h3 className="text-sm font-semibold text-navy mb-2">Payment schedule (remaining)</h3>
            <div className="max-h-96 overflow-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>#</Th>
                    <Th>Date</Th>
                    <Th numeric>Principal</Th>
                    <Th numeric>Interest</Th>
                    <Th numeric>Escrow</Th>
                    <Th numeric>Total</Th>
                    <Th numeric>Balance after</Th>
                  </tr>
                </thead>
                <tbody>
                  {detail.schedule.map((r) => (
                    <Tr key={r.number}>
                      <Td>{r.number}</Td>
                      <Td>{formatDate(r.date, 'MMM d, yyyy')}</Td>
                      <Td numeric>{formatCurrency(r.principal)}</Td>
                      <Td numeric>{formatCurrency(r.interest)}</Td>
                      <Td numeric>{formatCurrency(r.escrow)}</Td>
                      <Td numeric className="font-semibold">{formatCurrency(r.total)}</Td>
                      <Td numeric>{formatCurrency(r.balance)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </div>
        </Card>
      )}

      <Modal
        open={formOpen}
        onClose={() => !saving && setFormOpen(false)}
        title={editingId ? 'Edit Loan' : 'Add a Loan'}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setFormOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={saveLoan} loading={saving}>
              Save Loan
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="md:col-span-2">
            <Label htmlFor="ln-name" required>Loan name</Label>
            <Input id="ln-name" placeholder="e.g. Truck loan" value={form.name} onChange={set('name')} />
          </div>
          <div>
            <Label htmlFor="ln-lender">Lender (vendor)</Label>
            <Select id="ln-lender" value={form.lenderVendorId} onChange={set('lenderVendorId')}>
              <option value="">None</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.displayName}{v.currency ? ` (${v.currency})` : ''}
                </option>
              ))}
            </Select>
            {lenderCurrency && (
              <div className="mt-2">
                <Label htmlFor="ln-rate">Booked rate (1 {lenderCurrency} = ? home)</Label>
                <Input id="ln-rate" inputMode="decimal" placeholder="Blank = Currencies list rate" value={form.exchangeRate} onChange={set('exchangeRate')} />
                <p className="text-xs text-navy/40 mt-1">The loan is in {lenderCurrency}; pay it from a {lenderCurrency} bank account.</p>
              </div>
            )}
          </div>
          <div>
            <Label htmlFor="ln-liab" required>Loan account (what you owe)</Label>
            <Select id="ln-liab" value={form.liabilityAccountId} onChange={set('liabilityAccountId')}>
              <option value="">Select…</option>
              {acctOptions(liabilityAccounts)}
            </Select>
          </div>
          <div>
            <Label htmlFor="ln-amt" required>Original amount</Label>
            <Input id="ln-amt" inputMode="decimal" value={form.originalAmount} onChange={set('originalAmount')} />
          </div>
          <div>
            <Label htmlFor="ln-rate" required>Interest rate (% per year)</Label>
            <Input id="ln-rate" inputMode="decimal" value={form.annualRate} onChange={set('annualRate')} />
          </div>
          <div>
            <Label htmlFor="ln-term" required>Term (months)</Label>
            <Input id="ln-term" inputMode="numeric" value={form.termMonths} onChange={set('termMonths')} />
          </div>
          <div>
            <Label htmlFor="ln-freq">Payments</Label>
            <Select id="ln-freq" value={form.paymentsPerYear} onChange={set('paymentsPerYear')}>
              {FREQUENCIES.map(([n, label]) => (
                <option key={n} value={String(n)}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="ln-origin" required>Loan date</Label>
            <Input id="ln-origin" type="date" value={form.originDate} onChange={set('originDate')} />
          </div>
          <div>
            <Label htmlFor="ln-first" required>First payment date</Label>
            <Input id="ln-first" type="date" value={form.firstPaymentDate} onChange={set('firstPaymentDate')} />
          </div>
          <div>
            <Label htmlFor="ln-int" required>Interest expense account</Label>
            <Select id="ln-int" value={form.interestAccountId} onChange={set('interestAccountId')}>
              <option value="">Select…</option>
              {acctOptions(expenseAccounts)}
            </Select>
          </div>
          <div>
            <Label htmlFor="ln-bank">Pay from (bank account)</Label>
            <Select id="ln-bank" value={form.paymentAccountId} onChange={set('paymentAccountId')}>
              <option value="">Choose when paying</option>
              {acctOptions(bankAccounts)}
            </Select>
          </div>
          <div>
            <Label htmlFor="ln-escrow">Escrow per payment (optional)</Label>
            <Input id="ln-escrow" inputMode="decimal" placeholder="0.00" value={form.escrowAmount} onChange={set('escrowAmount')} />
          </div>
          <div>
            <Label htmlFor="ln-escrow-acct">Escrow account</Label>
            <Select id="ln-escrow-acct" value={form.escrowAccountId} onChange={set('escrowAccountId')}>
              <option value="">None</option>
              {acctOptions(accounts)}
            </Select>
          </div>
          <div className="md:col-span-2">
            <Label htmlFor="ln-notes">Notes</Label>
            <Input id="ln-notes" value={form.notes} onChange={set('notes')} />
          </div>
        </div>
      </Modal>

      <Modal
        open={payOpen}
        onClose={() => !saving && setPayOpen(false)}
        title={payKind === 'check' ? 'Write the loan payment check' : 'Enter the loan payment bill'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPayOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={savePayment} loading={saving}>
              {payKind === 'check' ? 'Write Check' : 'Enter Bill'}
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="lp-date">Date</Label>
            <Input id="lp-date" type="date" value={pay.date} onChange={(e) => setPay((p) => ({ ...p, date: e.target.value }))} />
          </div>
          {payKind === 'check' ? (
            <div>
              <Label htmlFor="lp-bank">Bank account</Label>
              <Select id="lp-bank" value={pay.paymentAccountId} onChange={(e) => setPay((p) => ({ ...p, paymentAccountId: e.target.value }))}>
                <option value="">Select…</option>
                {acctOptions(bankAccounts)}
              </Select>
            </div>
          ) : (
            <div />
          )}
          <div>
            <Label htmlFor="lp-prin">Principal (pays down the loan)</Label>
            <Input id="lp-prin" inputMode="decimal" value={pay.principal} onChange={(e) => setPay((p) => ({ ...p, principal: e.target.value }))} />
          </div>
          <div>
            <Label htmlFor="lp-int">Interest</Label>
            <Input id="lp-int" inputMode="decimal" value={pay.interest} onChange={(e) => setPay((p) => ({ ...p, interest: e.target.value }))} />
          </div>
          <div>
            <Label htmlFor="lp-esc">Escrow</Label>
            <Input id="lp-esc" inputMode="decimal" value={pay.escrow} onChange={(e) => setPay((p) => ({ ...p, escrow: e.target.value }))} />
          </div>
          <div>
            <Label htmlFor="lp-ref">{payKind === 'check' ? 'Check #' : 'Bill #'}</Label>
            <Input id="lp-ref" value={pay.toPrint ? '' : pay.reference} disabled={pay.toPrint} placeholder={payKind === 'check' ? 'auto' : 'optional'} onChange={(e) => setPay((p) => ({ ...p, reference: e.target.value }))} />
            {payKind === 'check' && (
              <label className="mt-2 flex items-center gap-2 text-sm text-navy/70 select-none">
                <input type="checkbox" className="h-4 w-4 accent-electric" checked={pay.toPrint} onChange={(e) => setPay((p) => ({ ...p, toPrint: e.target.checked }))} />
                Print later
              </label>
            )}
          </div>
          {detail?.currency && (
            <div className="col-span-2">
              <Label htmlFor="lp-rate">Exchange rate today (1 {detail.currency} = ? home)</Label>
              <Input id="lp-rate" inputMode="decimal" placeholder="Blank = Currencies list rate" value={pay.exchangeRate} onChange={(e) => setPay((p) => ({ ...p, exchangeRate: e.target.value }))} />
            </div>
          )}
          <p className="col-span-2 text-sm text-navy/70">
            Total:{' '}
            <strong>
              {formatCurrency(((Number(pay.principal) || 0) + (Number(pay.interest) || 0) + (Number(pay.escrow) || 0)).toFixed(2), detail?.currency ?? undefined)}
            </strong>
          </p>
        </div>
      </Modal>
    </main>
  );
}
