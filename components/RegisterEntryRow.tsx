'use client';
/**
 * The blank row at the bottom of an account register (QB "Use Register"): type Date, Number,
 * Payee, Account, Memo and one amount, press Enter, and the transaction is saved without leaving
 * the register. lib/registerEntryPlan.ts decides what it saves as (check, deposit, transfer,
 * credit card charge / credit or journal entry); the row shows that before you save.
 *
 *  - Payee: any customer, vendor, employee or Other Name. A name not in any list asks which list
 *    it belongs on (NewNameModal) or keeps it as a one-time payee.
 *  - Account: find-as-you-type over the chart of accounts. Typing a name that isn't there (or
 *    the + button) opens Add Account and puts the new account on the row.
 *  - Picking a payee with history fills the account (vendor default → last used → learned model).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { AmountInput, Button, Input, toast } from '@/components/ui';
import { Typeahead } from '@/components/Typeahead';
import { NewNameModal, type CreatedName, type NameType } from '@/components/NewNameModal';
import { AddAccountModal, type Account } from '@/components/accounts/AccountForm';
import { api, ApiError } from '@/lib/client';
import { todayISO } from '@/lib/dates';
import { SUBTYPE_LABELS } from '@/lib/accountTypes';
import { saveWithDuplicateCheck } from '@/lib/purchasesClient';
import { type TypeaheadChoice, type TypeaheadOption, choicesToOptions, isExactTypeaheadMatch, labelForId, resolveTypedChoice } from '@/lib/typeahead';
import {
  REGISTER_ENTRY_LABELS,
  planRegisterEntry,
  registerEntryBlockedReason,
  type RegisterEntryKind,
  type RegisterSide,
} from '@/lib/registerEntryPlan';

export interface RegisterEntryAccount {
  id: string;
  type: string;
  subtype: string;
  currency?: string | null;
}

interface NameOption {
  type: NameType;
  id: string;
  label: string;
}

const NAME_HINTS: Record<NameType, string> = { vendor: 'Vendor', customer: 'Customer', employee: 'Employee', other: 'Other' };

/** Every name list the user may read (a list hidden by permissions is simply left out). */
async function loadNames(): Promise<NameOption[]> {
  const get = <T,>(url: string) => api.get<T>(url).catch(() => null);
  const [vendors, customers, employees, others] = await Promise.all([
    get<Array<{ id: string; displayName: string; isActive?: boolean }>>('/api/vendors'),
    get<Array<{ id: string; displayName: string; isActive?: boolean }>>('/api/customers'),
    get<Array<{ id: string; firstName: string; lastName: string; isActive?: boolean }>>('/api/employees'),
    get<{ entries: Array<{ id: string; name: string; isActive?: boolean }> }>('/api/lists/other-names'),
  ]);
  const active = <T extends { isActive?: boolean }>(xs: T[] | null | undefined) => (xs ?? []).filter((x) => x.isActive !== false);
  return [
    ...active(vendors).map((v) => ({ type: 'vendor' as const, id: v.id, label: v.displayName })),
    ...active(customers).map((c) => ({ type: 'customer' as const, id: c.id, label: c.displayName })),
    ...active(employees).map((e) => ({ type: 'employee' as const, id: e.id, label: `${e.firstName} ${e.lastName}`.trim() })),
    ...active(others?.entries).map((o) => ({ type: 'other' as const, id: o.id, label: o.name })),
  ];
}

export function RegisterEntryRow({
  register,
  columns,
  colSpanAfter,
  onSaved,
}: {
  register: RegisterEntryAccount;
  /** The register's two amount columns, in display order (key = change to this account). */
  columns: { key: RegisterSide; label: string }[];
  /** Extra trailing cells to fill (balance columns). */
  colSpanAfter: number;
  onSaved: (saved: { kind: RegisterEntryKind; id: string }) => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [names, setNames] = useState<NameOption[]>([]);

  const [date, setDate] = useState(todayISO());
  const [number, setNumber] = useState('');
  const [payee, setPayee] = useState('');
  const [picked, setPicked] = useState<NameOption | null>(null);
  const [accountId, setAccountId] = useState('');
  const [accountText, setAccountText] = useState('');
  const [memo, setMemo] = useState('');
  const [amounts, setAmounts] = useState<Record<RegisterSide, string>>({ increase: '', decrease: '' });
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const [askName, setAskName] = useState(false);
  const [newAccount, setNewAccount] = useState<string | null>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const payeeKey = useRef('');
  // Latest values for blur handlers: Tab fires onPick and then onBlur in the same tick, before
  // React has re-rendered, so the blur must not read the pre-pick state.
  const pickedRef = useRef<NameOption | null>(null);
  const payeeRef = useRef('');
  const account = useRef({ id: '', text: '' });
  // Add Account calls onCreated and then onClose; only a cancel should restore the old text.
  const accountJustCreated = useRef(false);
  function setPayeeBoth(t: string) {
    payeeRef.current = t;
    setPayee(t);
  }
  function setPickedBoth(n: NameOption | null) {
    pickedRef.current = n;
    setPicked(n);
  }
  function setAccountBoth(id: string, text: string) {
    account.current = { id, text };
    setAccountId(id);
    setAccountText(text);
  }

  useEffect(() => {
    api.get<Account[]>('/api/accounts').then(setAccounts).catch(() => setAccounts([]));
    loadNames().then(setNames);
  }, []);

  const blocked = registerEntryBlockedReason(register);

  // ---- Choices -----------------------------------------------------------------------------
  const accountChoices: TypeaheadChoice[] = useMemo(
    () =>
      accounts
        .filter((a) => a.isActive && a.subtype !== 'non_posting' && a.id !== register.id)
        .map((a) => ({
          id: a.id,
          label: a.code ? `${a.code} · ${a.name}` : a.name,
          hint: SUBTYPE_LABELS[a.subtype as keyof typeof SUBTYPE_LABELS] ?? a.subtype,
          terms: [a.code, a.name].filter(Boolean),
        })),
    [accounts, register.id],
  );
  const accountOptions = useMemo(() => choicesToOptions(accountChoices), [accountChoices]);
  const nameOptions: TypeaheadOption[] = useMemo(
    () => names.map((n) => ({ id: `${n.type}:${n.id}`, value: n.label, hint: NAME_HINTS[n.type] })),
    [names],
  );

  // ---- What it will save as ----------------------------------------------------------------
  const side: RegisterSide | null = amounts.increase.trim() ? 'increase' : amounts.decrease.trim() ? 'decrease' : null;
  const sideRef = useRef<RegisterSide | null>(null);
  sideRef.current = side;
  const other = accounts.find((a) => a.id === accountId);
  const plan = other && side ? planRegisterEntry(register, other, side) : null;

  // ---- Payee -------------------------------------------------------------------------------
  const prefill = useCallback(
    async (q: { vendorId?: string; payee?: string }) => {
      const key = q.vendorId ?? `payee:${q.payee ?? ''}`;
      payeeKey.current = key;
      // History first (vendor default, last used, learned model); with no history at all, the AI
      // picks from the chart using what the business does (ai=1). Bank and card registers are the
      // account the money moved through, so the AI never suggests the register itself.
      const throughAccount = ['checking', 'savings', 'credit_card'].includes(register.subtype);
      const params = new URLSearchParams({
        ...(q.vendorId ? { vendorId: q.vendorId } : { payee: q.payee ?? '' }),
        ai: '1',
        direction: planSuggestsVendor(register, sideRef.current ?? defaultSide(register)) ? 'out' : 'in',
        ...(throughAccount ? { sourceAccountId: register.id } : {}),
      });
      const res = await api
        .get<{ source: string; lines: Array<{ accountId: string }>; reason?: string; lookedUp?: unknown[] }>(`/api/ai/prefill?${params}`)
        .catch(() => null);
      if (payeeKey.current !== key || !res?.lines?.[0]) return;
      const id = res.lines[0].accountId;
      if (!accountChoices.some((c) => c.id === id)) return;
      if (account.current.id || account.current.text.trim()) return; // never overwrite what the user chose
      setAccountBoth(id, labelForId(accountChoices, id));
      setNote(
        res.source === 'vendor-default'
          ? "Account from the vendor's default."
          : res.source === 'last-used'
            ? 'Account from the last transaction with this payee.'
            : res.source === 'ai'
              ? `AI suggestion${res.lookedUp?.length ? ' (looked the vendor up online)' : ''}${res.reason ? `: ${res.reason}` : ''} Check it before you save.`
              : 'Account suggested from similar past transactions.',
      );
    },
    [accountChoices, register],
  );

  function pickName(n: NameOption) {
    setPickedBoth(n);
    setPayeeBoth(n.label);
    if (n.type === 'vendor') prefill({ vendorId: n.id });
    else prefill({ payee: n.label });
  }

  function exactName(text: string): NameOption | null {
    const matches = names.filter((n) => isExactTypeaheadMatch({ value: n.label }, text));
    return matches.length === 1 ? matches[0] : null;
  }

  // ---- Account -----------------------------------------------------------------------------
  function leaveAccount() {
    const { id: cur, text: raw } = account.current;
    const text = raw.trim();
    if (!text) {
      setAccountBoth('', '');
      return;
    }
    if (cur && labelForId(accountChoices, cur) === raw) return; // still the chosen account
    const id = resolveTypedChoice(accountChoices, text, '');
    if (id) setAccountBoth(id, labelForId(accountChoices, id));
    else setNewAccount(text); // not in the chart: offer to set it up
  }

  // ---- Save --------------------------------------------------------------------------------
  function reset() {
    setNumber('');
    setPayeeBoth('');
    setPickedBoth(null);
    setAccountBoth('', '');
    setMemo('');
    setAmounts({ increase: '', decrease: '' });
    setNote('');
    setTimeout(() => dateRef.current?.focus(), 0);
  }

  async function submit(name: { type: NameType; id: string } | null) {
    if (!side || !accountId) return;
    setSaving(true);
    try {
      const res = await saveWithDuplicateCheck((allowDuplicateNumber) =>
        api.post<{ entry: { kind: RegisterEntryKind; id: string } }>(`/api/registers/${register.id}`, {
          date,
          number: number.trim() || null,
          payee: payee.trim() || null,
          name,
          otherAccountId: accountId,
          memo: memo.trim() || null,
          side,
          amount: amounts[side].trim(),
          allowDuplicateNumber,
        }),
      );
      if (!res) return;
      toast(`Saved as ${REGISTER_ENTRY_LABELS[res.entry.kind].toLowerCase()}.`, 'success');
      onSaved(res.entry);
      reset();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save the transaction.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  function save() {
    if (saving) return;
    if (!accountId) {
      toast('Choose the account for this transaction.', 'danger');
      return;
    }
    if (!side) {
      toast(`Enter an amount in ${columns[0].label} or ${columns[1].label}.`, 'danger');
      return;
    }
    if (plan && !plan.ok) {
      toast(plan.message, 'danger');
      return;
    }
    const text = payee.trim();
    const name = picked && picked.label === text ? picked : text ? exactName(text) : null;
    if (text && !name) {
      setAskName(true); // a name not in any list: ask which list it belongs on
      return;
    }
    submit(name ? { type: name.type, id: name.id } : null);
  }

  if (blocked) {
    return (
      <tr className="bg-slate-50">
        <td colSpan={7 + colSpanAfter} className="px-4 py-3 text-xs text-navy/50">
          {blocked}
        </td>
      </tr>
    );
  }

  const cell = 'px-2 py-2 align-top';
  // Payment-like columns suggest a vendor for a new name; money in suggests a customer.
  const moneyOut = side ? planSuggestsVendor(register, side) : true;

  return (
    <>
      <tr
        data-register-entry
        className="bg-electric/5 border-t-2 border-electric/20"
        onKeyDown={(e) => {
          const t = e.target as HTMLElement;
          if (e.key === 'Enter' && !e.defaultPrevented && t.getAttribute('aria-expanded') !== 'true' && t.tagName !== 'BUTTON') {
            e.preventDefault();
            save();
          }
        }}
      >
        <td className={cell}>
          <Input ref={dateRef} type="date" aria-label="Date" value={date} onChange={(e) => setDate(e.target.value)} className="min-w-[130px]" />
        </td>
        <td className={cell}>
          <Input aria-label="Number" placeholder={register.subtype === 'checking' || register.subtype === 'savings' ? 'Auto' : ''} value={number} onChange={(e) => setNumber(e.target.value)} className="w-20" />
        </td>
        <td className={cell}>
          <Typeahead
            aria-label="Payee"
            placeholder="Payee"
            value={payee}
            allowFreeText
            options={nameOptions}
            onChange={(t) => {
              setPayeeBoth(t);
              if (pickedRef.current && pickedRef.current.label !== t) setPickedBoth(null);
            }}
            onPick={(o) => {
              const n = names.find((x) => `${x.type}:${x.id}` === o.id);
              if (n) pickName(n);
            }}
            onBlur={() => {
              const text = payeeRef.current.trim();
              if (pickedRef.current || !text) return;
              const n = exactName(text);
              if (n) pickName(n);
              else prefill({ payee: text });
            }}
          />
        </td>
        <td className={cell}>
          <div className="flex items-start gap-1">
            <Typeahead
              aria-label="Account"
              placeholder="Account"
              value={accountText}
              options={accountOptions}
              onChange={(t) => {
                account.current = { ...account.current, text: t };
                setAccountText(t);
              }}
              onPick={(o) => {
                if (o.id) {
                  setAccountBoth(o.id, o.value);
                  setNote('');
                }
              }}
              onBlur={leaveAccount}
            />
            <button
              type="button"
              title="New account"
              aria-label="New account"
              onClick={() => setNewAccount(accountText.trim())}
              className="mt-2 text-electric/70 hover:text-electric"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </td>
        <td className={cell}>
          <Input aria-label="Memo" placeholder="Memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
        </td>
        {columns.map((col) => (
          <td key={col.key} className={cell}>
            <AmountInput
              aria-label={col.label}
              placeholder="0.00"
              value={amounts[col.key]}
              onChange={(e) => {
                const v = e.target.value;
                // One amount per row: typing in one column clears the other.
                setAmounts(col.key === 'increase' ? { increase: v, decrease: '' } : { increase: '', decrease: v });
              }}
              className="w-28"
            />
          </td>
        ))}
        <td className={cell} colSpan={colSpanAfter}>
          <Button onClick={save} loading={saving} className="whitespace-nowrap">
            Record
          </Button>
        </td>
      </tr>
      <tr className="bg-electric/5">
        <td colSpan={7 + colSpanAfter} className="px-3 pb-2 text-xs">
          {plan && !plan.ok ? (
            <span className="text-red-600">{plan.message}</span>
          ) : plan?.ok ? (
            <span className="text-navy/60">
              Saves as: <span className="font-semibold text-navy">{REGISTER_ENTRY_LABELS[plan.kind]}</span>
              {plan.kind === 'check' && !number.trim() ? ' (next check number)' : ''}
              {note ? <span className="ml-3 text-electric">{note}</span> : null}
            </span>
          ) : (
            <span className="text-navy/40">
              Type a date, payee, account and one amount, then press Enter. {note ? <span className="ml-2 text-electric">{note}</span> : null}
            </span>
          )}
        </td>
      </tr>

      <NewNameModal
        open={askName}
        name={payee}
        suggestedType={moneyOut ? 'vendor' : 'customer'}
        onClose={() => setAskName(false)}
        onCreated={(n: CreatedName) => {
          setAskName(false);
          const opt = { type: n.type, id: n.id, label: n.label };
          setNames((prev) => [...prev, opt]);
          setPickedBoth(opt);
          setPayeeBoth(n.label);
          submit({ type: n.type, id: n.id });
        }}
        onUseOnce={() => {
          setAskName(false);
          submit(null);
        }}
      />
      <AddAccountModal
        open={newAccount !== null}
        // A register's other account is usually an expense (money out) or income (money in).
        initial={{ name: newAccount ?? '', qbType: moneyOut ? 'expense' : 'income' }}
        accounts={accounts}
        onClose={() => {
          setNewAccount(null);
          if (accountJustCreated.current) {
            accountJustCreated.current = false;
            return;
          }
          setAccountBoth(account.current.id, labelForId(accountChoices, account.current.id));
        }}
        onCreated={(a) => {
          accountJustCreated.current = true;
          setAccounts((prev) => [...prev, a]);
          setAccountBoth(a.id, a.code ? `${a.code} · ${a.name}` : a.name);
          setNewAccount(null);
        }}
      />
    </>
  );
}

/** Before an amount is typed: banks, cards and expenses usually pay out; income usually comes in. */
function defaultSide(register: RegisterEntryAccount): RegisterSide {
  if (register.type === 'revenue') return 'increase';
  if (register.type === 'asset') return 'decrease';
  return 'increase'; // a card charge, an expense, a liability growing
}

/** Is this row paying someone (suggest Vendor for a new name) rather than receiving (Customer)? */
function planSuggestsVendor(register: RegisterEntryAccount, side: RegisterSide): boolean {
  if (register.type === 'expense') return side === 'increase'; // an expense paid
  if (register.type === 'revenue') return side === 'decrease'; // a refund
  // Assets shrinking (a bank payment) or liabilities growing (a card charge) pay someone.
  return register.type === 'asset' ? side === 'decrease' : side === 'increase';
}

export default RegisterEntryRow;
