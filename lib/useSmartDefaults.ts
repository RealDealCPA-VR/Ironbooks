'use client';
/**
 * useSmartDefaults(form) — what a NEW transaction form should start with (QB auto-fill):
 *  - defaultDate(): today, or — My Preferences "Default date = the last date I entered" — the
 *    last date entered on this form type this session;
 *  - recall(nameId, opts): the name's last transaction of this type (lines, terms, class, rep,
 *    tax item, memo) and, for checks, the next check number. Null when My Preferences turned
 *    recall off, nothing is on file, or the request failed — forms never break because of it;
 *  - nextCheckNumber(bankAccountId): the next number for that bank account;
 *  - rememberDate(date): call after a save (PreferenceBehaviors also does this for every save).
 *
 * Everything is computed locally (lib/services/smartDefaults.ts reads the company file); no AI
 * and nothing leaves the machine.
 */
import { useCallback, useMemo } from 'react';
import { api } from '@/lib/client';
import { usePreferences } from '@/lib/usePreferences';
import {
  SMART_FORM_LABELS,
  defaultFormDate,
  isVendorForm,
  rememberFormDate,
  type SmartDefaults,
  type SmartForm,
} from '@/lib/smartDefaults';

function routeFor(form: SmartForm): string {
  if (form === 'bill') return '/api/smart-defaults/bills';
  if (isVendorForm(form)) return '/api/smart-defaults/expenses';
  return '/api/smart-defaults/sales';
}

/** "Filled in from the last check #1042 (2026-09-30). Change anything you need." */
export function recallNote(d: SmartDefaults): string {
  if (!d.source) return '';
  const what = SMART_FORM_LABELS[d.source.form];
  const num = d.source.number ? ` #${d.source.number}` : '';
  return `Filled in from the last ${what}${num} (${d.source.date}). Change anything you need.`;
}

/**
 * `dateKey` names the form type the default date is remembered under (defaults to `form`; Write
 * Checks uses 'credit_card_credit' for card credits so they keep their own date).
 */
export function useSmartDefaults(form: SmartForm, dateKey: string = form) {
  const prefs = usePreferences();
  const datePref = prefs.my.defaultDate;
  const today = prefs.today;
  const recallOn = prefs.my.autoRecallLastTransaction;

  const defaultDate = useCallback(() => defaultFormDate(datePref, dateKey, today), [datePref, dateKey, today]);

  const rememberDate = useCallback((date: string) => rememberFormDate(dateKey, date), [dateKey]);

  const recall = useCallback(
    async (nameId: string, opts: { paymentAccountId?: string } = {}): Promise<SmartDefaults | null> => {
      if (!nameId || !recallOn) return null;
      const q = new URLSearchParams({ form });
      q.set(isVendorForm(form) ? 'vendorId' : 'customerId', nameId);
      if (opts.paymentAccountId) q.set('paymentAccountId', opts.paymentAccountId);
      try {
        const d = await api.get<SmartDefaults>(`${routeFor(form)}?${q.toString()}`);
        return d.recallEnabled && d.source ? d : null;
      } catch {
        return null;
      }
    },
    [form, recallOn],
  );

  const nextCheckNumber = useCallback(async (paymentAccountId: string): Promise<string | null> => {
    if (!paymentAccountId) return null;
    try {
      const d = await api.get<SmartDefaults>(
        `/api/smart-defaults/expenses?form=check&paymentAccountId=${encodeURIComponent(paymentAccountId)}`,
      );
      return d.nextCheckNumber;
    } catch {
      return null;
    }
  }, []);

  return useMemo(
    () => ({ defaultDate, rememberDate, recall, nextCheckNumber, recallEnabled: recallOn, loaded: prefs.loaded }),
    [defaultDate, rememberDate, recall, nextCheckNumber, recallOn, prefs.loaded],
  );
}
