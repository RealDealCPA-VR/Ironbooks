'use client';
/**
 * Set Closing Date (QB Company > Set Closing Date / Accountant > Set Closing Date): a dialog over
 * the current window with the closing date and the closing date password, like QuickBooks'
 * "Set Closing Date and Password" box. It opens from the desktop menus (electron/menuRoutes.js
 * sends the 'set-closing-date' menu action, components/DesktopBridge.tsx calls
 * openSetClosingDate) and from the Accountant Center, so setting the date never leaves the window
 * the bookkeeper is working in. Saving goes through PATCH /api/company/closing-date (Closing Date /
 * Periods: modify), which records the change in the audit trail.
 *
 * Keyboard: the date field has focus when it opens; Enter saves, Escape cancels.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Input, Label, Modal, toast, toastError } from '@/components/ui';
import { api } from '@/lib/client';

const OPEN_EVENT = 'ironbooks:set-closing-date';

/** Open the Set Closing Date dialog (mounted once by DesktopBridge). */
export function openSetClosingDate(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_EVENT));
}

interface ClosingDateSettings {
  closingDate: string | null;
  hasPassword: boolean;
}

/** The dialog host: renders nothing until openSetClosingDate() is called. */
export function SetClosingDateHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);
  return open ? <SetClosingDateDialog onClose={() => setOpen(false)} /> : null;
}

export function SetClosingDateDialog({ onClose }: { onClose: () => void }) {
  const [loaded, setLoaded] = useState<ClosingDateSettings | null>(null);
  const [date, setDate] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [removePassword, setRemovePassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    api
      .get<ClosingDateSettings>('/api/company/closing-date')
      .then((s) => {
        setLoaded(s);
        setDate(s.closingDate ?? '');
      })
      .catch((err) => {
        toastError(err, 'Could not read the closing date.');
        onCloseRef.current();
      });
  }, []);

  async function save(clear = false) {
    setError(null);
    if (!clear && !date) {
      setError('Enter the closing date, or click Remove Closing Date.');
      return;
    }
    if (!clear && password !== confirm) {
      setError('The password and its confirmation do not match.');
      return;
    }
    setBusy(true);
    try {
      const body = clear
        ? { closingDate: null }
        : { closingDate: date, ...(password ? { password } : removePassword ? { password: null } : {}) };
      const saved = await api.patch<ClosingDateSettings>('/api/company/closing-date', body);
      toast(
        saved.closingDate
          ? `Books are closed through ${saved.closingDate}${saved.hasPassword ? ' (password protected)' : ''}.`
          : 'The closing date was removed.',
        'success',
      );
      onClose();
    } catch (err) {
      toastError(err, 'Could not save the closing date.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Set Closing Date and Password"
      footer={
        <>
          {loaded?.closingDate && (
            <Button variant="ghost" disabled={busy} onClick={() => void save(true)}>
              Remove Closing Date
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={!loaded}>
            OK
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex flex-col gap-4"
      >
        <p className="text-sm text-navy/60">
          Transactions dated on or before the closing date can&apos;t be added, changed or voided without the closing date
          password. Each change made with the password is listed on the{' '}
          <Link href="/reports/closing-date-exceptions" className="text-electric hover:underline" onClick={onClose}>
            Closing Date Exception Report
          </Link>
          .
        </p>
        <div>
          <Label htmlFor="scd-date">Closing date</Label>
          <Input id="scd-date" type="date" autoFocus value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="scd-pw">Closing date password</Label>
            <Input
              id="scd-pw"
              type="password"
              autoComplete="new-password"
              value={password}
              placeholder={loaded?.hasPassword ? 'Leave blank to keep it' : 'Optional'}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="scd-confirm">Confirm password</Label>
            <Input id="scd-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
        </div>
        {loaded?.hasPassword && !password && (
          <label className="flex items-center gap-2 text-sm text-navy/70">
            <input type="checkbox" checked={removePassword} onChange={(e) => setRemovePassword(e.target.checked)} />
            Remove the password (anyone who may change closed periods could then do it without one)
          </label>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        {/* Enter in a field submits (the OK button lives in the footer). */}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
