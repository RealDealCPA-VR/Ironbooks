'use client';
/**
 * Currencies page — multi-currency management.
 *
 * - Lists all currencies for the company (base currency highlighted).
 * - "Add / Update Currency" modal: code, name, rateToBase, isBase toggle.
 * - "FX Adjustment" modal: pick a GL account, enter amount, choose gain/loss, pick date.
 * - "Home Currency Adjustment" (p1 fx): revalue every foreign balance at entered rates, as QB.
 */
import { useState, useEffect, useCallback } from 'react';
import { Coins } from 'lucide-react';
import {
  Button,
  Card,
  Input,
  Label,
  Modal,
  EmptyState,
  Spinner,
  PageHeader,
  Select,
  Table,
  Th,
  Td,
  Tr,
  Badge,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';
import { formatDate } from '@/lib/dates';
import { HomeCurrencyAdjustmentHistory, HomeCurrencyAdjustmentModal } from './HomeCurrencyAdjustment';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Currency {
  id: string;
  code: string;
  name: string;
  rateToBase: string;
  isBase: boolean;
  updatedAt: string;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Add/Update Currency Modal
// ---------------------------------------------------------------------------

function CurrencyModal({
  open,
  onClose,
  onSaved,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  initial?: Currency | null;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [rate, setRate] = useState('');
  const [isBase, setIsBase] = useState(false);
  const [saving, setSaving] = useState(false);

  // Pre-fill when editing
  useEffect(() => {
    if (open) {
      setCode(initial?.code ?? '');
      setName(initial?.name ?? '');
      setRate(initial?.isBase ? '1' : (initial?.rateToBase ?? ''));
      setIsBase(initial?.isBase ?? false);
    }
  }, [open, initial]);

  async function handleSave() {
    if (!code.trim()) { toast('Currency code is required.', 'danger'); return; }
    if (!name.trim()) { toast('Currency name is required.', 'danger'); return; }
    if (!isBase && (!rate.trim() || isNaN(Number(rate)) || Number(rate) <= 0)) {
      toast('Rate to base must be a positive number.', 'danger');
      return;
    }

    setSaving(true);
    try {
      await api.post('/api/currencies', {
        code: code.trim().toUpperCase(),
        name: name.trim(),
        rateToBase: isBase ? undefined : rate.trim(),
        isBase,
      });
      toast(`${code.toUpperCase()} saved.`, 'success');
      onSaved();
      onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save currency.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial ? `Edit ${initial.code}` : 'Add / Update Currency'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <Label htmlFor="cur-code">ISO Currency Code</Label>
          <Input
            id="cur-code"
            placeholder="e.g. EUR"
            maxLength={3}
            autoFocus={!initial}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            disabled={!!initial}
          />
        </div>

        <div>
          <Label htmlFor="cur-name">Currency Name</Label>
          <Input
            id="cur-name"
            placeholder="e.g. Euro"
            autoFocus={!!initial}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-3">
          <input
            id="cur-isbase"
            type="checkbox"
            checked={isBase}
            onChange={(e) => setIsBase(e.target.checked)}
            className="h-4 w-4 accent-electric"
          />
          <label htmlFor="cur-isbase" className="text-sm font-medium text-navy/80 cursor-pointer">
            Set as base currency (rate locked to 1)
          </label>
        </div>

        {!isBase && (
          <div>
            <Label htmlFor="cur-rate">Rate to Base Currency</Label>
            <Input
              id="cur-rate"
              type="number"
              step="0.00000001"
              min="0.00000001"
              placeholder="e.g. 1.10 (1 EUR = 1.10 USD)"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
            <p className="text-xs text-navy/40 mt-1">
              How many base-currency units equal 1 unit of this currency.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// FX Adjustment Modal
// ---------------------------------------------------------------------------

function FxAdjustmentModal({
  open,
  onClose,
  onSaved,
  accounts,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  accounts: Account[];
}) {
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [gain, setGain] = useState(true);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && accounts.length > 0 && !accountId) {
      setAccountId(accounts[0].id);
    }
  }, [open, accounts, accountId]);

  async function handleSave() {
    if (!accountId) { toast('Please select an account.', 'danger'); return; }
    if (!amount.trim() || isNaN(Number(amount)) || Number(amount) <= 0) {
      toast('Amount must be a positive number.', 'danger');
      return;
    }
    if (!date) { toast('Date is required.', 'danger'); return; }

    setSaving(true);
    try {
      await api.post('/api/currencies/fx-adjustment', {
        accountId,
        amount: amount.trim(),
        gain,
        date,
        memo: memo.trim() || undefined,
      });
      toast('FX adjustment posted.', 'success');
      onSaved();
      onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to post FX adjustment.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record FX Adjustment"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} loading={saving}>
            Post Entry
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-navy/60">
          Posts a balanced journal entry for a foreign-exchange gain or loss against the selected account.
        </p>

        <div>
          <Label htmlFor="fx-account">Account</Label>
          <Select
            id="fx-account"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="fx-amount">Amount (base currency)</Label>
          <Input
            id="fx-amount"
            type="number"
            step="0.01"
            min="0.01"
            placeholder="e.g. 150.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>

        <div>
          <Label>Type</Label>
          <div className="flex gap-4 mt-1">
            <label className="flex items-center gap-2 cursor-pointer text-sm text-navy/80">
              <input
                type="radio"
                name="fx-type"
                checked={gain}
                onChange={() => setGain(true)}
                className="accent-electric"
              />
              FX Gain
              <span className="text-xs text-navy/40">(Dr account / Cr Other Income 4900)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer text-sm text-navy/80">
              <input
                type="radio"
                name="fx-type"
                checked={!gain}
                onChange={() => setGain(false)}
                className="accent-electric"
              />
              FX Loss
              <span className="text-xs text-navy/40">(Dr Bank Fees 6100 / Cr account)</span>
            </label>
          </div>
        </div>

        <div>
          <Label htmlFor="fx-date">Date</Label>
          <Input
            id="fx-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        <div>
          <Label htmlFor="fx-memo">Memo (optional)</Label>
          <Input
            id="fx-memo"
            placeholder="e.g. EUR A/R revaluation Q2"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function CurrenciesPage() {
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [loading, setLoading] = useState(true);

  const [accounts, setAccounts] = useState<Account[]>([]);

  const [showCurrencyModal, setShowCurrencyModal] = useState(false);
  const [editTarget, setEditTarget] = useState<Currency | null>(null);

  const [showFxModal, setShowFxModal] = useState(false);
  const [showHca, setShowHca] = useState(false);
  const [hcaRefresh, setHcaRefresh] = useState(0);

  const loadCurrencies = useCallback(() => {
    setLoading(true);
    api
      .get<Currency[]>('/api/currencies')
      .then(setCurrencies)
      .catch((err) => toast(err instanceof ApiError ? err.message : 'Failed to load currencies.', 'danger'))
      .finally(() => setLoading(false));
  }, []);

  const loadAccounts = useCallback(() => {
    api
      .get<Account[]>('/api/accounts')
      .then(setAccounts)
      .catch(() => {/* non-fatal */});
  }, []);

  useEffect(() => {
    loadCurrencies();
    loadAccounts();
  }, [loadCurrencies, loadAccounts]);

  function openAdd() {
    setEditTarget(null);
    setShowCurrencyModal(true);
  }

  function openEdit(cur: Currency) {
    setEditTarget(cur);
    setShowCurrencyModal(true);
  }

  const baseCurrency = currencies.find((c) => c.isBase);

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="Currencies"
        icon={Coins}
        action={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowHca(true)}
              disabled={currencies.filter((c) => !c.isBase).length === 0}
            >
              Home Currency Adjustment
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowFxModal(true)}
            >
              FX Adjustment
            </Button>
            <Button size="sm" onClick={openAdd}>
              Add / Update Currency
            </Button>
          </div>
        }
      />

      {baseCurrency && (
        <div className="mb-4 text-sm text-navy/60">
          Base currency:{' '}
          <span className="font-semibold text-navy">
            {baseCurrency.code} — {baseCurrency.name}
          </span>
        </div>
      )}

      <Card className="p-0 overflow-hidden">
        {loading && (
          <div className="py-16 flex justify-center text-electric">
            <Spinner className="h-6 w-6" />
          </div>
        )}

        {!loading && currencies.length === 0 && (
          <EmptyState
            icon={Coins}
            title="No currencies configured yet"
            message="Add a base currency to get started with multi-currency."
            action={<Button onClick={openAdd}>Add Currency</Button>}
          />
        )}

        {!loading && currencies.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th numeric>Rate to Base</Th>
                <Th>Status</Th>
                <Th>Last Updated</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {currencies.map((cur) => (
                <Tr key={cur.id}>
                  <Td className="font-mono font-bold text-navy">{cur.code}</Td>
                  <Td>{cur.name}</Td>
                  <Td numeric>
                    {cur.isBase ? (
                      <span className="text-navy/40">1.00000000 (base)</span>
                    ) : (
                      parseFloat(cur.rateToBase).toFixed(8)
                    )}
                  </Td>
                  <Td>
                    {cur.isBase ? (
                      <Badge tone="success">Base</Badge>
                    ) : (
                      <Badge tone="neutral">Foreign</Badge>
                    )}
                  </Td>
                  <Td className="text-navy/50 text-xs">
                    {formatDate(cur.updatedAt)}
                  </Td>
                  <Td className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEdit(cur)}
                    >
                      Edit
                    </Button>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {/* Conversion reference card */}
      {!loading && currencies.length > 1 && baseCurrency && (
        <Card className="mt-6 p-5">
          <h2 className="text-base font-bold text-navy mb-3">Quick Conversion Reference</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {currencies
              .filter((c) => !c.isBase)
              .map((cur) => {
                const rate = parseFloat(cur.rateToBase);
                return (
                  <div
                    key={cur.id}
                    className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3"
                  >
                    <div className="text-xs text-navy/50 mb-1">
                      1 {cur.code} =
                    </div>
                    <div className="font-bold text-navy tabular-nums">
                      {formatCurrency(rate, baseCurrency.code)}
                    </div>
                    <div className="text-xs text-navy/40 mt-0.5">
                      {baseCurrency.code}
                    </div>
                  </div>
                );
              })}
          </div>
        </Card>
      )}

      {/* Modals */}
      <CurrencyModal
        open={showCurrencyModal}
        onClose={() => setShowCurrencyModal(false)}
        onSaved={loadCurrencies}
        initial={editTarget}
      />

      <HomeCurrencyAdjustmentHistory refreshKey={hcaRefresh} />

      <HomeCurrencyAdjustmentModal
        open={showHca}
        onClose={() => setShowHca(false)}
        onPosted={() => { loadCurrencies(); setHcaRefresh((n) => n + 1); }}
        currencies={currencies}
      />

      <FxAdjustmentModal
        open={showFxModal}
        onClose={() => setShowFxModal(false)}
        onSaved={loadCurrencies}
        accounts={accounts}
      />
    </main>
  );
}
