'use client';
/**
 * Mounted once by components/AppShell. Applies the app-wide Preferences (decision logic in
 * lib/prefBehaviors.ts):
 *  - save-time prompts through the API client's write hooks: past/future date warning for the
 *    forms that don't ask themselves, and "Warn when editing a transaction";
 *  - after a transaction saves: "Beep when recording a transaction", remember the date for
 *    "Default date = the last date I entered", and tell other open report windows the data
 *    changed (Reports "When report data changes");
 *  - keyboard/field behaviour: "Pressing Enter moves between fields", "Automatically place the
 *    decimal point" (amount fields), and the remembered default date on new transaction forms.
 */
import * as React from 'react';
import { usePathname } from 'next/navigation';
import { setWriteHooks } from '@/lib/client';
import { usePreferences } from '@/lib/usePreferences';
import {
  LAST_DATE_STORAGE_KEY,
  TRANSACTION_PAGES,
  autoDecimal,
  bodyDate,
  isMoneyField,
  isNewTransactionDateField,
  promptsBeforeSave,
  recordsTransaction,
} from '@/lib/prefBehaviors';

const DATA_CHANGED_KEY = 'bka:dataChangedAt';

function setNativeValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** A short, quiet confirmation tone made locally (no sound files, no network). */
function beep() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.05;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
    osc.onended = () => void ctx.close();
  } catch {
    /* no audio device: stay silent */
  }
}

function labelTextFor(el: HTMLInputElement): string {
  const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
  return (byFor?.textContent ?? el.closest('label')?.textContent ?? '').trim();
}

export default function PreferenceBehaviors() {
  const prefs = usePreferences();
  const pathname = usePathname() || '';
  const ref = React.useRef(prefs);
  ref.current = prefs;

  // ---- save-time prompts + after-save effects (API client write hooks) ----
  React.useEffect(() => {
    setWriteHooks({
      before: (info) => {
        const p = ref.current;
        for (const prompt of promptsBeforeSave(info, p.company, p.my, p.today)) {
          if (!window.confirm(prompt.message)) return false;
        }
        return true;
      },
      after: (info) => {
        if (!recordsTransaction(info)) return;
        const p = ref.current;
        if (p.my.beepOnRecord) beep();
        const date = bodyDate(info.body);
        try {
          if (date) localStorage.setItem(LAST_DATE_STORAGE_KEY, date);
          localStorage.setItem(DATA_CHANGED_KEY, String(Date.now()));
        } catch {
          /* storage unavailable */
        }
      },
    });
    return () => setWriteHooks(null);
  }, []);

  // ---- Enter moves between fields; automatic decimal point ----
  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!ref.current.my.enterMovesBetweenFields) return;
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (!el || el.tagName !== 'INPUT') return;
      const input = el as HTMLInputElement;
      if (['checkbox', 'radio', 'submit', 'button', 'file'].includes(input.type)) return;
      if (input.closest('[data-grid-row]')) return; // line grids: Enter already moves down a line
      if (input.getAttribute('aria-expanded') === 'true') return; // an open picker list
      const scope = input.closest('form, [role="dialog"]') ?? document.body;
      const fields = Array.from(
        scope.querySelectorAll<HTMLElement>('input, select, textarea'),
      ).filter((f) => !(f as HTMLInputElement).disabled && f.offsetParent !== null && (f as HTMLInputElement).type !== 'hidden');
      const i = fields.indexOf(input);
      if (i >= 0 && i < fields.length - 1) {
        e.preventDefault();
        fields[i + 1].focus();
      }
    }
    const typed = new WeakSet<HTMLInputElement>();
    function onInput(e: Event) {
      const el = e.target as HTMLInputElement;
      if (e.isTrusted && el?.tagName === 'INPUT') typed.add(el);
    }
    function onFocusOut(e: FocusEvent) {
      if (!ref.current.my.autoDecimalPoint) return;
      const el = e.target as HTMLInputElement | null;
      if (!el || el.tagName !== 'INPUT' || el.inputMode !== 'decimal' || !typed.has(el)) return;
      typed.delete(el);
      if (!isMoneyField({ placeholder: el.placeholder, name: el.name, id: el.id, ariaLabel: el.getAttribute('aria-label') })) return;
      const next = autoDecimal(el.value);
      if (next !== el.value) setNativeValue(el, next);
    }
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('focusout', onFocusOut, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('focusout', onFocusOut, true);
    };
  }, []);

  // ---- Default date = the last date I entered (new transaction forms) ----
  const onTransactionPage = TRANSACTION_PAGES.some((p) => pathname === p || pathname.startsWith(p + '/'));
  React.useEffect(() => {
    if (!onTransactionPage || prefs.my.defaultDate !== 'last') return;
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_DATE_STORAGE_KEY);
    } catch {
      return;
    }
    if (!last || last === prefs.today) return;
    const done = new WeakSet<Element>();
    const apply = () => {
      document.querySelectorAll<HTMLElement>('form, [role="dialog"]').forEach((scope) => {
        if (done.has(scope)) return;
        done.add(scope);
        const first = scope.querySelector<HTMLInputElement>('input[type="date"]');
        if (!first || first.value !== prefs.today || first.disabled || first.readOnly) return;
        const label = labelTextFor(first);
        if (!isNewTransactionDateField({ name: first.name, id: first.id, ariaLabel: first.getAttribute('aria-label'), labelText: label })) return;
        setNativeValue(first, last!);
      });
    };
    apply();
    const obs = new MutationObserver(apply);
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [onTransactionPage, prefs.my.defaultDate, prefs.today]);

  // ---- Reports: when report data changes (another window saved a transaction) ----
  const onReport = pathname === '/reports' || pathname.startsWith('/reports/');
  const [stale, setStale] = React.useState(false);
  React.useEffect(() => {
    setStale(false);
    if (!onReport) return;
    const loadedAt = Date.now();
    const onStorage = (e: StorageEvent) => {
      if (e.key !== DATA_CHANGED_KEY || Number(e.newValue) <= loadedAt) return;
      const mode = ref.current.my.reportsRefresh;
      if (mode === 'auto') window.location.reload();
      else if (mode === 'prompt') setStale(true);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [onReport, pathname]);

  if (!stale) return null;
  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl bg-navy px-4 py-2 text-sm text-white shadow-lg"
    >
      Your data changed since this report was opened.
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-lg bg-white/15 px-3 py-1 font-semibold hover:bg-white/25 outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        Refresh report
      </button>
      <button type="button" onClick={() => setStale(false)} className="text-white/70 hover:text-white" aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}
