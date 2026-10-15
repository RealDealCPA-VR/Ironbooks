'use client';
/**
 * One QB Preferences category ("Accounting", "Checking", "Reminders", …) with its two tabs:
 * Company Preferences (everyone in the file; needs Company & Preferences: modify) and My
 * Preferences (only the signed-in person). Driven by PREFERENCE_CATEGORIES in lib/preferences.ts.
 *
 * Company keys save through PATCH /api/company { settings } (validated + whitelisted server
 * side); My Preferences through PATCH /api/preferences/my.
 */
import * as React from 'react';
import { Building2, User } from 'lucide-react';
import { Button, Card, Input, Label, Select, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import {
  FORM_TYPES,
  FORM_TYPE_LABELS,
  PREFERENCE_CATEGORIES,
  REMINDER_KEYS,
  REMINDER_LABELS,
  type CompanyPreferences,
  type MyPreferences,
  type ReminderMode,
} from '@/lib/preferences';
import { refreshPreferences, usePreferences } from '@/lib/usePreferences';
import { FIELD_META, type Account as PrefAccount, type FieldMeta } from '@/lib/preferenceFields';
import MultiCurrencyPreference from './MultiCurrencyPreference';

type Account = PrefAccount;

type Draft = Record<string, unknown>;

function FieldRow({
  id,
  meta,
  value,
  onChange,
  accounts,
  disabled,
}: {
  id: string;
  meta: FieldMeta;
  value: unknown;
  onChange: (v: unknown) => void;
  accounts: Account[];
  disabled?: boolean;
}) {
  if (meta.type === 'bool') {
    return (
      <div className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          checked={meta.fixed ? true : Boolean(value)}
          disabled={disabled || Boolean(meta.fixed)}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-1 h-4 w-4 rounded border-slate-300 text-electric focus:ring-electric"
        />
        <div>
          <Label htmlFor={id} className="mb-0 cursor-pointer">
            {meta.label}
          </Label>
          {meta.help && <p className="mt-0.5 text-xs text-navy/50">{meta.help}</p>}
          {meta.fixed && <p className="mt-0.5 text-xs text-navy/50">{meta.fixed}</p>}
        </div>
      </div>
    );
  }
  return (
    <div className="max-w-md">
      <Label htmlFor={id}>{meta.label}</Label>
      {meta.type === 'number' && (
        <Input
          id={id}
          type="number"
          min={0}
          disabled={disabled}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
        />
      )}
      {meta.type === 'text' && (
        <Input id={id} disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      )}
      {meta.type === 'select' && (
        <Select id={id} disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {(meta.options ?? []).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      )}
      {meta.type === 'account' && (
        <Select id={id} disabled={disabled} value={String(value ?? '')} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">— None (use the standard account) —</option>
          {accounts
            .filter((a) => a.isActive !== false && (meta.accounts ? meta.accounts(a) : true))
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
        </Select>
      )}
      {meta.help && <p className="mt-1 text-xs text-navy/50">{meta.help}</p>}
    </div>
  );
}

function RemindersEditor({
  value,
  onChange,
  disabled,
}: {
  value: CompanyPreferences['reminders'];
  onChange: (v: CompanyPreferences['reminders']) => void;
  disabled?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase text-navy/50">
            <th className="py-1 pr-3">Remind me about</th>
            <th className="py-1 pr-3">Show</th>
            <th className="py-1">Days</th>
          </tr>
        </thead>
        <tbody>
          {REMINDER_KEYS.map((k) => (
            <tr key={k} className="border-t border-slate-100">
              <td className="py-1.5 pr-3 text-navy">{REMINDER_LABELS[k]}</td>
              <td className="py-1.5 pr-3">
                <Select
                  aria-label={`${REMINDER_LABELS[k]}: show`}
                  disabled={disabled}
                  value={value[k].mode}
                  onChange={(e) => onChange({ ...value, [k]: { ...value[k], mode: e.target.value as ReminderMode } })}
                >
                  <option value="summary">Summary</option>
                  <option value="list">Full list</option>
                  <option value="off">Don&apos;t remind me</option>
                </Select>
              </td>
              <td className="py-1.5 w-24">
                <Input
                  aria-label={`${REMINDER_LABELS[k]}: days`}
                  type="number"
                  min={0}
                  disabled={disabled}
                  value={value[k].days}
                  onChange={(e) =>
                    onChange({ ...value, [k]: { ...value[k], days: Math.max(0, Math.round(Number(e.target.value) || 0)) } })
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-navy/50">
        Days: how far ahead to look (for overdue invoices, how many days after the due date).
      </p>
    </div>
  );
}

function SendFormsEditor({
  value,
  onChange,
  disabled,
}: {
  value: CompanyPreferences['sendForms'];
  onChange: (v: CompanyPreferences['sendForms']) => void;
  disabled?: boolean;
}) {
  const [form, setForm] = React.useState<(typeof FORM_TYPES)[number]>('invoice');
  return (
    <div className="flex flex-col gap-3">
      <div className="max-w-xs">
        <Label htmlFor="sf-form">Form</Label>
        <Select id="sf-form" value={form} onChange={(e) => setForm(e.target.value as typeof form)}>
          {FORM_TYPES.map((f) => (
            <option key={f} value={f}>
              {FORM_TYPE_LABELS[f]}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="sf-subject">Subject</Label>
        <Input
          id="sf-subject"
          disabled={disabled}
          value={value[form].subject}
          onChange={(e) => onChange({ ...value, [form]: { ...value[form], subject: e.target.value } })}
        />
      </div>
      <div>
        <Label htmlFor="sf-body">Message</Label>
        <textarea
          id="sf-body"
          rows={8}
          disabled={disabled}
          spellCheck
          value={value[form].body}
          onChange={(e) => onChange({ ...value, [form]: { ...value[form], body: e.target.value } })}
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-electric/40"
        />
        <p className="mt-1 text-xs text-navy/50">
          Fill-in fields: {'{{number}}'}, {'{{customer.name}}'}, {'{{company.name}}'}, {'{{total}}'}, {'{{balance}}'},{' '}
          {'{{dueDate}}'}.
        </p>
      </div>
    </div>
  );
}

export default function PreferencePane({
  categoryId,
  accounts,
  exclude = [],
  canEditCompany = true,
}: {
  categoryId: string;
  accounts: Account[];
  /** Company keys already edited elsewhere on the page (legacy panes). */
  exclude?: string[];
  canEditCompany?: boolean;
}) {
  const category = PREFERENCE_CATEGORIES.find((c) => c.id === categoryId);
  const prefs = usePreferences();
  const [scope, setScope] = React.useState<'company' | 'my'>('company');
  const [draft, setDraft] = React.useState<Draft>({});
  const [myDraft, setMyDraft] = React.useState<Draft>({});
  const [saving, setSaving] = React.useState(false);

  const companyKeys = (category?.company ?? []).filter((k) => !exclude.includes(k));
  const myKeys = category?.my ?? [];

  React.useEffect(() => {
    if (!prefs.loaded) return;
    setDraft(Object.fromEntries(companyKeys.map((k) => [k, (prefs.company as unknown as Draft)[k]])));
    setMyDraft(Object.fromEntries(myKeys.map((k) => [k, (prefs.my as unknown as Draft)[k]])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.loaded, categoryId]);

  React.useEffect(() => {
    if (companyKeys.length === 0 && myKeys.length > 0) setScope('my');
    else if (myKeys.length === 0) setScope('company');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId]);

  // A2: the Multiple Currencies switch asks before turning on and locks once foreign data exists.
  if (categoryId === 'currencies' && companyKeys.includes('multiCurrencyEnabled')) {
    return <MultiCurrencyPreference canEdit={canEditCompany} />;
  }
  if (!category || (companyKeys.length === 0 && myKeys.length === 0)) return null;

  const keys = scope === 'company' ? companyKeys : myKeys;
  const values = scope === 'company' ? draft : myDraft;
  const setValue = (k: string, v: unknown) =>
    scope === 'company' ? setDraft((d) => ({ ...d, [k]: v })) : setMyDraft((d) => ({ ...d, [k]: v }));
  const readOnly = scope === 'company' && !canEditCompany;

  async function save() {
    setSaving(true);
    try {
      if (scope === 'company') {
        await api.patch('/api/company', { settings: draft });
      } else {
        await api.patch('/api/preferences/my', myDraft);
        // Desktop shell: apply the spelling preference right away.
        const bridge = (window as unknown as { bookkeeper?: { spellcheck?: { setEnabled?: (v: boolean) => unknown } } }).bookkeeper;
        if (typeof myDraft.spellCheckEnabled === 'boolean') void bridge?.spellcheck?.setEnabled?.(myDraft.spellCheckEnabled);
      }
      await refreshPreferences();
      toast('Preferences saved', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed to save preferences', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-navy">{category.label}</h2>
        <div className="flex rounded-lg border border-slate-200 overflow-hidden" role="tablist" aria-label="Preference scope">
          {(
            [
              ['my', 'My Preferences', User, myKeys.length],
              ['company', 'Company Preferences', Building2, companyKeys.length],
            ] as const
          ).map(([id, label, Icon, n]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={scope === id}
              disabled={n === 0}
              onClick={() => setScope(id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-40 ${
                scope === id ? 'bg-electric text-white' : 'bg-white text-navy/60 hover:bg-slate-50'
              }`}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>
      </div>
      <p className="mb-5 text-sm text-navy/50">
        {scope === 'company'
          ? 'These settings apply to everyone who uses this company file.'
          : 'These settings only change how the app works for you.'}
        {readOnly && ' Only an administrator can change them.'}
      </p>
      <div className="flex flex-col gap-5">
        {keys.map((k) => {
          const meta = FIELD_META[k];
          if (!meta) return null;
          if (meta.dependsOn && values[meta.dependsOn] === false) return null;
          const id = `pref-${k}`;
          if (meta.type === 'reminders') {
            return (
              <RemindersEditor
                key={k}
                disabled={readOnly}
                value={(values[k] as CompanyPreferences['reminders']) ?? prefs.company.reminders}
                onChange={(v) => setValue(k, v)}
              />
            );
          }
          if (meta.type === 'sendForms') {
            return (
              <SendFormsEditor
                key={k}
                disabled={readOnly}
                value={(values[k] as CompanyPreferences['sendForms']) ?? prefs.company.sendForms}
                onChange={(v) => setValue(k, v)}
              />
            );
          }
          return (
            <FieldRow
              key={k}
              id={id}
              meta={meta}
              value={values[k]}
              onChange={(v) => setValue(k, v)}
              accounts={accounts}
              disabled={readOnly}
            />
          );
        })}
      </div>
      <div className="mt-6">
        <Button onClick={() => void save()} loading={saving} disabled={readOnly}>
          Save {scope === 'company' ? 'company' : 'my'} preferences
        </Button>
      </div>
    </Card>
  );
}

export type { MyPreferences };
