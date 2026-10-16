'use client';

/**
 * Review a receipt (receipt capture): the picture on the left, what was read from it on the
 * right, prefilled into a new expense, check, credit card charge or bill. Nothing is recorded
 * until the person checks the details and clicks Save; the receipt is then attached to the new
 * transaction (and leaves the inbox).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Receipt, RefreshCw, Trash2 } from 'lucide-react';
import {
  AmountInput,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DateInput,
  Input,
  Label,
  PageHeader,
  PageSkeleton,
  Select,
  toast,
  toastError,
} from '@/components/ui';
import { ReceiptStatusBadge, type ReceiptRow } from '@/components/ReceiptStatus';
import { api, ApiError } from '@/lib/client';
import { todayISO } from '@/lib/dates';
import { isBankAccount, isCreditCardAccount } from '@/lib/accountTypes';
import { PREFILL_SOURCE_LABEL } from '@/lib/aiClient';
import { formatCurrency, Money } from '@/lib/money';
import { canDo, useMe } from '@/lib/usePermissions';

type Kind = 'expense' | 'check' | 'credit_card' | 'bill';

interface Suggestions {
  vendor: { vendorId: string; vendorName: string; score: number } | null;
  accountId: string | null;
  accountSource: 'vendor-default' | 'last-used' | 'learned' | 'none';
  paymentAccountId: string | null;
  kind: Kind;
}

interface Vendor {
  id: string;
  displayName: string;
  isActive?: boolean;
}
interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  isActive?: boolean;
}

const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: 'expense', label: 'Paid now (cash or debit card)', hint: 'Money already left a bank account.' },
  { value: 'credit_card', label: 'Credit card charge', hint: 'Paid with a company credit card.' },
  { value: 'check', label: 'Paid by check', hint: 'You wrote a check for it.' },
  { value: 'bill', label: 'Bill to pay later', hint: 'You owe it and will pay it later.' },
];

const NEW_VENDOR = '__new__';
const NO_VENDOR = '';

/** Fields read with low confidence get a "please check" note. */
function CheckNote({ confidence }: { confidence: number | undefined }) {
  if (confidence === undefined || confidence >= 0.75) return null;
  return (
    <Badge tone="warning" className="ml-2 align-middle">
      {confidence === 0 ? 'Not found' : 'Please check'}
    </Badge>
  );
}

export default function ReviewReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { me } = useMe();
  const [receipt, setReceipt] = useState<ReceiptRow | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  // Form
  const [kind, setKind] = useState<Kind>('expense');
  const [vendorChoice, setVendorChoice] = useState<string>(NO_VENDOR);
  const [newName, setNewName] = useState('');
  const [addToList, setAddToList] = useState(true);
  const [date, setDate] = useState('');
  const [total, setTotal] = useState('');
  const [tax, setTax] = useState('');
  const [splitTax, setSplitTax] = useState(false);
  const [taxAccountId, setTaxAccountId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [paymentAccountId, setPaymentAccountId] = useState('');
  const [reference, setReference] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [memo, setMemo] = useState('');
  const [saving, setSaving] = useState(false);
  const [rereading, setRereading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [duplicate, setDuplicate] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ txnType: string; txnId: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.get<{ receipt: ReceiptRow; suggestions: Suggestions | null }>(`/api/receipts/${id}`);
      setReceipt(d.receipt);
      setSuggestions(d.suggestions);
      return d;
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load this receipt.');
      return null;
    }
  }, [id]);

  useEffect(() => {
    load();
    api.get<Vendor[]>('/api/vendors').then((v) => setVendors(v.filter((x) => x.isActive !== false))).catch(() => setVendors([]));
    api.get<Account[]>('/api/accounts').then((a) => setAccounts(a.filter((x) => x.isActive !== false))).catch(() => setAccounts([]));
  }, [load]);

  // Still being read: ask to read it now (no-op when someone else is already reading) and poll.
  // An abandoned read is reported as 'pending' by the server (effectiveReceiptStatus), so it restarts.
  useEffect(() => {
    if (!receipt || (receipt.status !== 'pending' && receipt.status !== 'processing')) return;
    let cancelled = false;
    if (receipt.status === 'pending') {
      api
        .post(`/api/receipts/${id}/extract`, {})
        .then(() => {
          if (!cancelled) void load();
        })
        .catch(() => {});
    }
    const t = setTimeout(() => !cancelled && load(), 2000);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [receipt, id, load]);

  // Prefill the form once, when the receipt has been read.
  const applyPrefill = useCallback(
    (r: ReceiptRow, s: Suggestions | null) => {
      setKind(s?.kind ?? 'expense');
      if (s?.vendor) setVendorChoice(s.vendor.vendorId);
      else if (r.vendorName) {
        setVendorChoice(NEW_VENDOR);
        setNewName(r.vendorName);
      } else setVendorChoice(NO_VENDOR);
      setDate(r.date ?? todayISO());
      setTotal(r.total ?? '');
      setTax(r.tax ?? '');
      setSplitTax(false);
      setAccountId(s?.accountId ?? '');
      setPaymentAccountId(s?.paymentAccountId ?? '');
      setReference(r.reference ?? '');
      setMemo(r.cardLast4 ? `${r.cardBrand ?? 'Card'} ending ${r.cardLast4}` : '');
    },
    [],
  );

  useEffect(() => {
    if (initialized || !receipt || receipt.status === 'pending' || receipt.status === 'processing') return;
    applyPrefill(receipt, suggestions);
    setInitialized(true);
  }, [receipt, suggestions, initialized, applyPrefill]);

  const payAccounts = useMemo(
    () => accounts.filter((a) => (kind === 'credit_card' ? isCreditCardAccount(a) : isBankAccount(a))),
    [accounts, kind],
  );
  // Keep the paying account compatible with the kind of transaction.
  useEffect(() => {
    if (paymentAccountId && !payAccounts.some((a) => a.id === paymentAccountId)) setPaymentAccountId('');
    if (!paymentAccountId && payAccounts.length === 1) setPaymentAccountId(payAccounts[0].id);
  }, [payAccounts, paymentAccountId]);

  const lineAccounts = useMemo(
    () =>
      accounts
        .filter((a) => !isBankAccount(a) && !isCreditCardAccount(a) && a.subtype !== 'accounts_payable' && a.subtype !== 'accounts_receivable' && a.subtype !== 'non_posting')
        .sort((a, b) => (a.type === 'expense' ? 0 : 1) - (b.type === 'expense' ? 0 : 1) || a.name.localeCompare(b.name)),
    [accounts],
  );

  const taxAmount = splitTax && tax ? tax : '';
  const netAmount = useMemo(() => {
    try {
      if (!total) return null;
      return Money.sub(total, taxAmount || '0').toFixed(2);
    } catch {
      return null;
    }
  }, [total, taxAmount]);

  async function rereadNow() {
    if (!receipt) return;
    setRereading(true);
    try {
      const d = await api.post<{ receipt: ReceiptRow }>(`/api/receipts/${id}/extract`, { force: true, version: receipt.version });
      const fresh = await load();
      if (fresh) applyPrefill(fresh.receipt, fresh.suggestions);
      toast(d.receipt.status === 'failed' ? 'Nothing could be read. Type the details.' : 'Read again.', 'info');
    } catch (err) {
      toastError(err, 'Could not read the receipt again.');
    } finally {
      setRereading(false);
    }
  }

  async function save(allowDuplicateNumber = false) {
    if (!receipt) return;
    const isNew = vendorChoice === NEW_VENDOR;
    const name = newName.trim();
    if (kind === 'bill' && (vendorChoice === NO_VENDOR || (isNew && !name))) {
      toast('A bill needs a vendor. Pick one or type a new vendor name.', 'danger');
      return;
    }
    if (vendorChoice === NO_VENDOR || (isNew && !name)) {
      toast('Who did you pay? Pick a vendor or type a name.', 'danger');
      return;
    }
    const body = {
      version: receipt.version,
      kind,
      vendorId: !isNew ? vendorChoice : null,
      newVendorName: isNew && (addToList || kind === 'bill') ? name : null,
      payeeName: isNew && !(addToList || kind === 'bill') ? name : null,
      date,
      total,
      tax: taxAmount || null,
      taxAccountId: taxAmount ? taxAccountId || null : null,
      accountId,
      paymentAccountId: kind === 'bill' ? null : paymentAccountId || null,
      reference: reference.trim() || null,
      dueDate: kind === 'bill' && dueDate ? dueDate : null,
      memo: memo.trim() || null,
      allowDuplicateNumber,
    };
    setSaving(true);
    try {
      const res = await api.post<{ txnType: string; txnId: string }>(`/api/receipts/${id}/save`, body);
      setSaved(res);
      toast(kind === 'bill' ? 'Bill saved with the receipt attached.' : 'Saved with the receipt attached.', 'success');
      load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && (err.details as { duplicateNumber?: boolean } | undefined)?.duplicateNumber) {
        setDuplicate(err.message);
      } else {
        toastError(err, 'Could not save.');
        if (err instanceof ApiError && err.status === 409) load();
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await api.del(`/api/receipts/${id}`);
      toast('Receipt removed.', 'success');
      router.push('/receipts');
    } catch (err) {
      toastError(err, 'Could not remove the receipt.');
    }
  }

  if (loadError) {
    return (
      <div className="p-8 max-w-6xl mx-auto w-full">
        <PageHeader title="Review receipt" icon={Receipt} />
        <Card className="p-6 text-navy">
          <p>{loadError}</p>
          <Link href="/receipts" className="mt-3 inline-block font-semibold text-electric hover:underline">
            Back to receipts
          </Link>
        </Card>
      </div>
    );
  }
  if (!receipt) return <PageSkeleton rows={8} />;

  const fileUrl = `/api/attachments/${receipt.attachmentId}?inline=1`;
  const isImage = /^image\/(jpeg|png|webp|gif)$/i.test(receipt.mimeType ?? '');
  const isPdf = receipt.mimeType === 'application/pdf';
  const busy = receipt.status === 'pending' || receipt.status === 'processing';
  const conf = receipt.confidence ?? {};
  const canSave = canDo(me, kind === 'bill' ? 'vendors' : 'banking', 'create');
  const txnHref = (t: { txnType: string }) => (t.txnType === 'bill' ? '/bills' : '/expenses');
  const done = receipt.status === 'saved' ? { txnType: receipt.txnType ?? 'expense', txnId: receipt.txnId ?? '' } : saved;

  return (
    <div className="p-8 max-w-6xl mx-auto w-full">
      <Link href="/receipts" className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-electric hover:underline">
        <ArrowLeft className="h-4 w-4" /> All receipts
      </Link>
      <PageHeader
        title="Review receipt"
        icon={Receipt}
        action={<ReceiptStatusBadge status={receipt.status} txnType={receipt.txnType} />}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="overflow-hidden p-0">
          <div className="border-b border-slate-100 px-4 py-2 text-sm text-navy/60">{receipt.filename}</div>
          {isImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={fileUrl} alt={`Receipt ${receipt.filename}`} className="max-h-[75vh] w-full object-contain bg-slate-50" />
          ) : isPdf ? (
            <iframe src={fileUrl} title={`Receipt ${receipt.filename}`} className="h-[75vh] w-full bg-slate-50" />
          ) : (
            <div className="p-6 text-sm text-navy/70">
              This picture can&apos;t be shown here.{' '}
              <a href={`/api/attachments/${receipt.attachmentId}`} className="font-semibold text-electric hover:underline">
                Download it
              </a>{' '}
              to look at it.
            </div>
          )}
        </Card>

        <div>
          {busy ? (
            <Card className="p-6 text-navy" aria-live="polite">
              <p className="font-semibold">Reading the receipt on this computer…</p>
              <p className="mt-1 text-sm text-navy/60">This usually takes a few seconds.</p>
            </Card>
          ) : done ? (
            <Card className="p-6 text-navy" aria-live="polite">
              <p className="font-semibold">Saved. The receipt is attached to the {done.txnType === 'bill' ? 'bill' : 'transaction'}.</p>
              <div className="mt-3 flex flex-wrap gap-3 text-sm">
                <Link href={txnHref(done)} className="font-semibold text-electric hover:underline">
                  {done.txnType === 'bill' ? 'Open Enter Bills' : 'Open Write Checks'}
                </Link>
                <Link href="/receipts" className="font-semibold text-electric hover:underline">
                  Next receipt
                </Link>
              </div>
            </Card>
          ) : (
            <Card className="p-6">
              {receipt.message && (
                <p role="status" className="mb-4 rounded-lg bg-gold/15 px-3 py-2 text-sm text-yellow-900">
                  {receipt.message}
                </p>
              )}
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  save();
                }}
              >
                <fieldset>
                  <legend className="mb-2 text-sm font-medium text-navy/70">What is this?</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {KINDS.map((k) => (
                      <label
                        key={k.value}
                        className={`cursor-pointer rounded-lg border px-3 py-2 text-sm ${
                          kind === k.value ? 'border-electric bg-electric/5' : 'border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="radio"
                          name="kind"
                          value={k.value}
                          checked={kind === k.value}
                          onChange={() => setKind(k.value)}
                          className="mr-2 accent-[#2563eb]"
                        />
                        <span className="font-semibold text-navy">{k.label}</span>
                        <span className="block pl-5 text-xs text-navy/50">{k.hint}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>

                <div>
                  <Label htmlFor="vendor">
                    Paid to
                    <CheckNote confidence={suggestions?.vendor ? Math.max(conf.vendorName ?? 0, suggestions.vendor.score) : conf.vendorName} />
                  </Label>
                  <Select id="vendor" value={vendorChoice} onChange={(e) => setVendorChoice(e.target.value)} required>
                    <option value={NO_VENDOR}>Pick a vendor…</option>
                    <option value={NEW_VENDOR}>Someone not in my list…</option>
                    {vendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.displayName}
                      </option>
                    ))}
                  </Select>
                  {suggestions?.vendor && vendorChoice === suggestions.vendor.vendorId && receipt.vendorName && (
                    <p className="mt-1 text-xs text-navy/50">Matched &ldquo;{receipt.vendorName}&rdquo; on the receipt to this vendor.</p>
                  )}
                  {vendorChoice === NEW_VENDOR && (
                    <div className="mt-2 space-y-2">
                      <Label htmlFor="new-vendor" className="sr-only">
                        Name
                      </Label>
                      <Input id="new-vendor" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Store or company name" />
                      <label className="flex items-center gap-2 text-sm text-navy/70">
                        <input
                          type="checkbox"
                          checked={addToList || kind === 'bill'}
                          disabled={kind === 'bill'}
                          onChange={(e) => setAddToList(e.target.checked)}
                        />
                        Add to my vendor list{kind === 'bill' ? ' (needed for a bill)' : ''}
                      </label>
                    </div>
                  )}
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="date">
                      Date <CheckNote confidence={conf.date} />
                    </Label>
                    <DateInput id="date" value={date} onChange={(e) => setDate(e.target.value)} required />
                  </div>
                  <div>
                    <Label htmlFor="total">
                      Total paid <CheckNote confidence={conf.total} />
                    </Label>
                    <AmountInput id="total" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} required />
                  </div>
                </div>

                <div>
                  <Label htmlFor="account">What was it for? (account)</Label>
                  <Select id="account" value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
                    <option value="">Pick an account…</option>
                    {lineAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                  {suggestions?.accountId && accountId === suggestions.accountId && suggestions.accountSource !== 'none' && (
                    <p className="mt-1 text-xs text-navy/50">Suggested {PREFILL_SOURCE_LABEL[suggestions.accountSource]}.</p>
                  )}
                </div>

                <div className="rounded-lg border border-slate-100 p-3">
                  <label className="flex items-center gap-2 text-sm text-navy/80">
                    <input type="checkbox" checked={splitTax} onChange={(e) => setSplitTax(e.target.checked)} />
                    Record the sales tax on its own line
                    {receipt.tax && <span className="text-navy/50">({formatCurrency(receipt.tax)} on the receipt)</span>}
                  </label>
                  {splitTax && (
                    <div className="mt-3 grid gap-4 sm:grid-cols-2">
                      <div>
                        <Label htmlFor="tax">
                          Sales tax <CheckNote confidence={conf.tax} />
                        </Label>
                        <AmountInput id="tax" inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} />
                      </div>
                      <div>
                        <Label htmlFor="tax-account">Tax account</Label>
                        <Select id="tax-account" value={taxAccountId} onChange={(e) => setTaxAccountId(e.target.value)} required={Boolean(taxAmount)}>
                          <option value="">Pick an account…</option>
                          {lineAccounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </Select>
                      </div>
                      {netAmount && (
                        <p className="sm:col-span-2 text-xs text-navy/50">
                          {formatCurrency(netAmount)} goes to the account above and {formatCurrency(taxAmount || '0')} to the tax account.
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {kind !== 'bill' ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="paid-from">
                        {kind === 'credit_card' ? 'Credit card' : 'Paid from (bank account)'}
                        {receipt.cardLast4 && <span className="ml-1 text-navy/50">— card ending {receipt.cardLast4}</span>}
                      </Label>
                      <Select id="paid-from" value={paymentAccountId} onChange={(e) => setPaymentAccountId(e.target.value)} required>
                        <option value="">Pick an account…</option>
                        {payAccounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </Select>
                      {kind === 'credit_card' && payAccounts.length === 0 && (
                        <p className="mt-1 text-xs text-navy/50">
                          No credit card account yet. <Link href="/accounts" className="text-electric hover:underline">Add one</Link> in the Chart of Accounts.
                        </p>
                      )}
                    </div>
                    <div>
                      <Label htmlFor="reference">{kind === 'check' ? 'Check number (blank = next number)' : 'Receipt or slip number'}</Label>
                      <Input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />
                    </div>
                  </div>
                ) : (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="bill-no">Vendor&apos;s bill number</Label>
                      <Input id="bill-no" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />
                    </div>
                    <div>
                      <Label htmlFor="due">Due date (blank = vendor&apos;s terms)</Label>
                      <DateInput id="due" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                    </div>
                  </div>
                )}

                <div>
                  <Label htmlFor="memo">Note (optional)</Label>
                  <Input id="memo" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={1000} />
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-2">
                  <Button type="submit" loading={saving} disabled={!canSave}>
                    Save {kind === 'bill' ? 'bill' : kind === 'check' ? 'check' : kind === 'credit_card' ? 'card charge' : 'expense'}
                  </Button>
                  {receipt.mimeType !== 'image/heic' && (
                    <Button type="button" variant="secondary" onClick={rereadNow} loading={rereading}>
                      <RefreshCw className="h-4 w-4" /> Read again
                    </Button>
                  )}
                  <Button type="button" variant="ghost" onClick={() => setConfirmDelete(true)} className="ml-auto text-red-600">
                    <Trash2 className="h-4 w-4" /> Remove
                  </Button>
                </div>
                {!canSave && (
                  <p className="text-xs text-navy/50">
                    Your role can&apos;t create {kind === 'bill' ? 'bills' : 'banking transactions'}. Ask your administrator.
                  </p>
                )}
              </form>

              {receipt.rawText && (
                <details className="mt-5 text-sm">
                  <summary className="cursor-pointer font-semibold text-navy/70">
                    Show the text that was read
                    {receipt.method && (
                      <span className="ml-1 font-normal text-navy/50">
                        ({receipt.method === 'pdf-text' ? 'from the PDF' : receipt.method === 'ocr' ? 'text recognition' : receipt.method === 'vision' ? 'your local AI model' : ''})
                      </span>
                    )}
                  </summary>
                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-navy/80">{receipt.rawText}</pre>
                </details>
              )}
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Remove this receipt?"
        message="The receipt will be deleted from the inbox. This can't be undone."
        confirmLabel="Remove"
        tone="danger"
        onConfirm={remove}
        onClose={() => setConfirmDelete(false)}
      />
      <ConfirmDialog
        open={Boolean(duplicate)}
        title="Number already used"
        message={`${duplicate ?? ''} Save anyway?`}
        confirmLabel="Save anyway"
        onConfirm={() => {
          setDuplicate(null);
          save(true);
        }}
        onClose={() => setDuplicate(null)}
      />
    </div>
  );
}
