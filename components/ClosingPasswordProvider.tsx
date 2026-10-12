'use client';
/**
 * App-wide closing date password prompt (QB "Set Closing Date" password).
 *
 * Mounted once in app/layout.tsx. It registers the prompt that lib/client.ts calls when the
 * server refuses to save, void or edit a transaction dated on or before the closing date. The
 * user types the closing date password and the save is retried with it; a wrong password asks
 * again with a plain message. Accepted overrides are recorded by the server on the Closing Date
 * Exception report (Reports > Accountant).
 *
 * It also shows QB's record-locking notice: when someone else saved a record after this user
 * opened it, the save is refused (409) and a dialog says who changed it and offers Reload.
 */
import * as React from 'react';
import {
  setClosingPasswordPrompt,
  setStaleRecordHandler,
  type ClosingPasswordPromptInfo,
  type StaleRecordInfo,
} from '@/lib/client';
import { Button, Input, Label, Modal } from '@/components/ui';

interface Pending {
  info: ClosingPasswordPromptInfo;
  resolve: (password: string | null) => void;
}

export default function ClosingPasswordProvider() {
  return (
    <>
      <ClosingPasswordPrompt />
      <RecordChangedDialog />
    </>
  );
}

/** "This record was changed by another user" — QB record locking, with a Reload button. */
function RecordChangedDialog() {
  const [info, setInfo] = React.useState<StaleRecordInfo | null>(null);
  React.useEffect(() => {
    setStaleRecordHandler(setInfo);
    return () => setStaleRecordHandler(null);
  }, []);
  const close = React.useCallback(() => setInfo(null), []);
  if (!info) return null;
  return (
    <Modal
      open
      onClose={close}
      title="This record was changed by another user"
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Keep my screen
          </Button>
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </>
      }
    >
      <p className="text-sm text-navy/70">
        {info.changedBy ? `${info.changedBy} saved` : 'Someone else saved'} this record
        {info.changedAt ? ` at ${new Date(info.changedAt).toLocaleString()}` : ''}, after you opened
        it. Your changes were not saved, so nothing was overwritten.
      </p>
      <p className="mt-2 text-sm text-navy/70">
        Choose Reload to see the latest version, then make your changes again.
      </p>
    </Modal>
  );
}

function ClosingPasswordPrompt() {
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [password, setPassword] = React.useState('');
  const pendingRef = React.useRef<Pending | null>(null);

  React.useEffect(() => {
    const prompt = (info?: ClosingPasswordPromptInfo) =>
      new Promise<string | null>((resolve) => {
        // A second prompt while one is open: cancel the older one so nothing hangs.
        pendingRef.current?.resolve(null);
        const next: Pending = {
          info: info ?? { message: '', rejected: false },
          resolve,
        };
        pendingRef.current = next;
        setPassword('');
        setPending(next);
      });
    setClosingPasswordPrompt(prompt);
    return () => {
      setClosingPasswordPrompt(null);
      pendingRef.current?.resolve(null);
      pendingRef.current = null;
    };
  }, []);

  const finish = React.useCallback((value: string | null) => {
    const p = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    setPassword('');
    p?.resolve(value);
  }, []);

  const cancel = React.useCallback(() => finish(null), [finish]);

  if (!pending) return null;
  const { rejected } = pending.info;
  return (
    <Modal
      open
      onClose={cancel}
      title="Closing date password"
      footer={
        <>
          <Button variant="secondary" onClick={cancel}>
            Cancel
          </Button>
          <Button type="submit" form="closing-password-form">
            OK
          </Button>
        </>
      }
    >
      <form
        id="closing-password-form"
        onSubmit={(e) => {
          e.preventDefault();
          finish(password);
        }}
        className="space-y-3"
      >
        <p className="text-sm text-navy/70">
          This transaction is dated on or before the closing date, so the books for that period are
          closed. To save this change anyway, enter the closing date password. The change will be
          listed on the Closing Date Exception report.
        </p>
        {rejected && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
            That password didn&apos;t work. Check it and try again, or ask the person who set the
            closing date. Your role may also not be allowed to change closed-period transactions.
          </p>
        )}
        <div>
          <Label htmlFor="closing-password-input">Password</Label>
          <Input
            id="closing-password-input"
            type="password"
            autoFocus
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      </form>
    </Modal>
  );
}
