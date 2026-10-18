'use client';

import { useState } from 'react';
import Link from 'next/link';
import { SlidersHorizontal } from 'lucide-react';
import { Button, Card, Input, Label, PageHeader, Select, toast, toastError } from '@/components/ui';
import { Help } from '@/components/Help';
import { api } from '@/lib/client';
import { type AccountOpt, type NamedOpt, BackToCenter, accountLabel, today, useList } from '../_shared';

const REASONS: Array<[string, string, 'reduce' | 'increase']> = [
  ['discount', 'Discount for paying on time', 'reduce'],
  ['rounding', 'Rounding difference', 'reduce'],
  ['penalty', 'Penalty', 'increase'],
  ['interest', 'Interest', 'increase'],
  ['other', 'Other', 'reduce'],
];

export default function SalesTaxAdjustmentPage() {
  const agencies = useList<NamedOpt>('/api/tax-agencies');
  const accounts = useList<AccountOpt>('/api/accounts');
  const [date, setDate] = useState(today());
  const [agencyId, setAgencyId] = useState('');
  const [reason, setReason] = useState('discount');
  const [direction, setDirection] = useState<'reduce' | 'increase'>('reduce');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [memo, setMemo] = useState('');
  const [saving, setSaving] = useState(false);

  const offsetAccounts = accounts.filter((a) => (a.type === 'revenue' || a.type === 'expense') && a.isActive !== false);

  async function save() {
    setSaving(true);
    try {
      await api.post('/api/accountant/sales-tax/adjustments', {
        date,
        agencyId,
        amount,
        direction,
        adjustmentAccountId: accountId,
        reason,
        memo: memo || null,
      });
      toast('Sales tax adjustment recorded.', 'success');
      setAmount('');
      setMemo('');
    } catch (err) {
      toastError(err, 'Could not record the adjustment.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <BackToCenter />
      <PageHeader title="Adjust Sales Tax Due" icon={SlidersHorizontal} />
      <p className="mb-4 max-w-2xl text-sm text-navy/60">
        Lower what you owe an agency <Help term="sales-tax" /> (an early-payment discount or a rounding difference) or raise it
        (a penalty or interest). The adjustment shows on the Pay Sales Tax screen and the Sales Tax Liability report.
      </p>
      <Card className="max-w-2xl p-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="sta-date">Adjustment date</Label>
            <Input id="sta-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="sta-agency">Sales tax agency</Label>
            <Select id="sta-agency" value={agencyId} onChange={(e) => setAgencyId(e.target.value)}>
              <option value="">Choose…</option>
              {agencies.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="sta-reason">Reason</Label>
            <Select
              id="sta-reason"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setDirection(REASONS.find((r) => r[0] === e.target.value)?.[2] ?? 'reduce');
              }}
            >
              {REASONS.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="sta-dir">This adjustment will</Label>
            <Select id="sta-dir" value={direction} onChange={(e) => setDirection(e.target.value as 'reduce' | 'increase')}>
              <option value="reduce">Reduce sales tax owed</option>
              <option value="increase">Increase sales tax owed</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="sta-amt">Amount</Label>
            <Input id="sta-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </div>
          <div>
            <Label htmlFor="sta-acct">{direction === 'reduce' ? 'Income account for the discount' : 'Expense account for the penalty / interest'}</Label>
            <Select id="sta-acct" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Choose…</option>
              {offsetAccounts
                .filter((a) => (direction === 'reduce' ? true : a.type === 'expense'))
                .map((a) => (
                  <option key={a.id} value={a.id}>{accountLabel(a)}</option>
                ))}
            </Select>
          </div>
          <div className="md:col-span-2">
            <Label htmlFor="sta-memo">Memo (optional)</Label>
            <Input id="sta-memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
          </div>
        </div>
        <div className="mt-6 flex items-center gap-3">
          <Button loading={saving} disabled={!agencyId || !accountId || !(Number(amount) > 0)} onClick={save}>
            Record adjustment
          </Button>
          <Link href="/reports/sales-tax" className="text-sm text-electric hover:underline">View sales tax liability</Link>
        </div>
      </Card>
    </main>
  );
}
