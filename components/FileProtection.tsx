'use client';
/**
 * Shared screens of "the password belongs to the company file" (filecrypto):
 *  - RecoveryKeyPanel: the recovery key, shown ONCE (new file, protection turned on, a new key),
 *    with Print and Save to a File, and the plain warning that it is the only way back in if every
 *    password is lost;
 *  - FilePasswordFields: "Protect this file with a password" (on by default) for portable company
 *    files (.bkp) and Accountant's Copy transfer files (.ibac);
 *  - CredentialsModal: the user name + password (or recovery key) of the company file a protected
 *    backup was made from, asked when the server says it needs them.
 * Every control is a native form element: keyboard operable, labelled, Enter submits.
 */
import * as React from 'react';
import { Download, KeyRound, Printer, ShieldCheck } from 'lucide-react';
import { Button, Input, Label, Modal } from '@/components/ui';

/** The shortest password a portable or transfer file may be given (lib/services/portableFile.ts). */
export const MIN_FILE_PASSWORD = 8;

interface SaveBytesBridge {
  saveBytes?: (opts: { defaultName: string; filters?: Array<{ name: string; extensions: string[] }>; data: ArrayBuffer }) => Promise<string | null>;
}

function recoveryKeyText(companyName: string, recoveryKey: string): string {
  return [
    `Ironbooks recovery key for the company file "${companyName}"`,
    '',
    `    ${recoveryKey}`,
    '',
    `Made ${new Date().toLocaleString()}.`,
    '',
    'This key opens the company file if every password is lost. It is the ONLY way back in then:',
    'nobody - not Ironbooks, not your accountant - can open the file without a password or this key.',
    'Keep it somewhere safe and private, away from the computer (a locked drawer, a safe).',
    'Anyone who has it and a copy of the company file can open the books.',
    '',
    'To use it: on the sign-in screen choose "I forgot my password", then "Use the recovery key".',
  ].join('\r\n');
}

/** The print-only sheet (a direct child of <body>) and the class that hides everything else. */
export const RECOVERY_PRINT_ID = 'ib-recovery-key-print';
const RECOVERY_PRINT_CLASS = 'ib-printing-recovery-key';
const RECOVERY_PRINT_CSS =
  `#${RECOVERY_PRINT_ID}{display:none}` +
  `@media print{body.${RECOVERY_PRINT_CLASS}>*:not(#${RECOVERY_PRINT_ID}){display:none!important}` +
  `body.${RECOVERY_PRINT_CLASS} #${RECOVERY_PRINT_ID}{display:block!important;padding:32px;color:#000;background:#fff}}`;

/**
 * Print `text` on its own sheet from the current page: a print-only block is added to <body>, the
 * rest of the page is hidden for printing, window.print() runs, and the block goes away again
 * after printing. Plain text only (textContent): nothing in it is ever read as HTML.
 */
export function printRecoveryKeySheet(text: string): void {
  if (typeof document === 'undefined') return;
  document.getElementById(RECOVERY_PRINT_ID)?.remove();
  const sheet = document.createElement('div');
  sheet.id = RECOVERY_PRINT_ID;
  const style = document.createElement('style');
  style.textContent = RECOVERY_PRINT_CSS;
  const pre = document.createElement('pre');
  pre.style.cssText = 'font:15px ui-monospace,Consolas,monospace;white-space:pre-wrap;margin:0';
  pre.textContent = text;
  sheet.append(style, pre);
  document.body.appendChild(sheet);
  document.body.classList.add(RECOVERY_PRINT_CLASS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cleanup = () => {
    window.removeEventListener('afterprint', cleanup);
    if (timer) clearTimeout(timer);
    document.body.classList.remove(RECOVERY_PRINT_CLASS);
    sheet.remove();
  };
  window.addEventListener('afterprint', cleanup);
  // Should a print dialog never report back, the sheet does not stay around for long.
  timer = setTimeout(cleanup, 5 * 60 * 1000);
  window.print();
}

/**
 * The recovery key, shown once. `onDone` continues (enabled once the person says they kept it).
 */
export function RecoveryKeyPanel({ recoveryKey, companyName, onDone, doneLabel = 'Continue' }: { recoveryKey: string; companyName: string; onDone: () => void; doneLabel?: string }) {
  const [kept, setKept] = React.useState(false);
  const fileName = `${companyName.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Company'} - recovery key.txt`;

  async function saveToFile() {
    const data = new TextEncoder().encode(recoveryKeyText(companyName, recoveryKey));
    const b = (window as unknown as { bookkeeper?: SaveBytesBridge }).bookkeeper;
    if (b?.saveBytes) {
      const saved = await b.saveBytes({ defaultName: fileName, filters: [{ name: 'Text file', extensions: ['txt'] }], data: data.buffer as ArrayBuffer });
      if (saved) setKept(true);
      return;
    }
    const url = URL.createObjectURL(new Blob([data], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
    setKept(true);
  }

  function print() {
    // Printed from this page itself, the way reports and checks print (window.print): the desktop
    // app never opens a blank pop-up window (electron/security.js refuses it), and the key never
    // goes into a URL. While printing, only the recovery key sheet is on the page.
    printRecoveryKeySheet(recoveryKeyText(companyName, recoveryKey));
    setKept(true);
  }

  return (
    <div className="space-y-4" aria-live="polite">
      <div className="flex items-start gap-3">
        <KeyRound className="h-6 w-6 text-electric flex-none mt-0.5" aria-hidden />
        <div>
          <h2 className="text-lg font-bold text-navy">Your recovery key</h2>
          <p className="text-sm text-navy/70 mt-1">
            This company file is protected with its own passwords: it is encrypted, and only its user names and passwords open it,
            on any computer. <strong>If every password is ever lost, this recovery key is the only way back in.</strong> Nobody else
            can open the file for you. Print it or save it now and keep it somewhere safe and private. It is shown only this once.
          </p>
        </div>
      </div>
      <p
        className="rounded-xl border-2 border-dashed border-electric/40 bg-electric/5 px-4 py-3 text-center font-mono text-lg font-bold tracking-wider text-navy select-all"
        aria-label="Recovery key"
        data-testid="recovery-key"
      >
        {recoveryKey}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={print}>
          <Printer className="h-4 w-4" aria-hidden /> Print…
        </Button>
        <Button type="button" variant="secondary" onClick={() => void saveToFile()}>
          <Download className="h-4 w-4" aria-hidden /> Save to a File…
        </Button>
      </div>
      <label className="flex items-start gap-2 text-sm text-navy">
        <input type="checkbox" className="mt-1" checked={kept} onChange={(e) => setKept(e.target.checked)} />
        I printed or saved the recovery key and will keep it somewhere safe.
      </label>
      <Button type="button" className="w-full" disabled={!kept} onClick={onDone}>
        {doneLabel}
      </Button>
    </div>
  );
}

export interface FilePasswordChoice {
  protect: boolean;
  password: string;
  confirm: string;
}

export function filePasswordProblem(c: FilePasswordChoice): string | null {
  if (!c.protect) return null;
  if (c.password.length < MIN_FILE_PASSWORD) return `Use at least ${MIN_FILE_PASSWORD} characters.`;
  if (c.password !== c.confirm) return 'The two passwords are different.';
  return null;
}

/** True once the open company file is known to be protected with passwords (GET /api/file-protection). */
export function useFileIsProtected(): boolean {
  const [isProtected, setProtected] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    fetch('/api/file-protection', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { protected?: boolean } | null) => alive && setProtected(Boolean(s?.protected)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return isProtected;
}

/**
 * "Protect this file with a password" (on by default) + password + confirm. For a company file
 * protected with passwords the password is required (its copies are protected too): no choice.
 */
export function FilePasswordFields({ value, onChange, what }: { value: FilePasswordChoice; onChange: (v: FilePasswordChoice) => void; what: string }) {
  const id = React.useId();
  const fileProtected = useFileIsProtected();
  const problem = value.confirm || value.password.length >= MIN_FILE_PASSWORD ? filePasswordProblem(value) : null;
  React.useEffect(() => {
    if (fileProtected && !value.protect) onChange({ ...value, protect: true });
  }, [fileProtected, value, onChange]);
  return (
    <fieldset className="rounded-xl border border-navy/10 p-4 space-y-3">
      <legend className="px-1 text-sm font-semibold text-navy flex items-center gap-1.5">
        <ShieldCheck className="h-4 w-4 text-electric" aria-hidden /> Password
      </legend>
      {fileProtected ? (
        <p className="text-sm text-navy">
          This company file is protected with passwords, so {what} is too: give it a password. Once it is restored, the copy opens with
          the same user names and passwords as this company file.
        </p>
      ) : (
        <label className="flex items-start gap-2 text-sm text-navy">
          <input type="checkbox" className="mt-1" checked={value.protect} onChange={(e) => onChange({ ...value, protect: e.target.checked })} />
          <span>
            Protect {what} with a password (recommended). It holds every user, password hash and transaction of this company file;
            without a password anyone who gets the file can read the books.
          </span>
        </label>
      )}
      {value.protect && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor={`${id}-pw`}>Password for the file</Label>
            <Input id={`${id}-pw`} type="password" autoComplete="new-password" value={value.password} onChange={(e) => onChange({ ...value, password: e.target.value })} minLength={MIN_FILE_PASSWORD} required />
          </div>
          <div>
            <Label htmlFor={`${id}-confirm`}>Confirm password</Label>
            <Input id={`${id}-confirm`} type="password" autoComplete="new-password" value={value.confirm} onChange={(e) => onChange({ ...value, confirm: e.target.value })} required aria-invalid={Boolean(problem) || undefined} />
          </div>
          <p className={`sm:col-span-2 text-xs ${problem ? 'text-red-600' : 'text-navy/50'}`} role={problem ? 'alert' : undefined}>
            {problem ?? `At least ${MIN_FILE_PASSWORD} characters. Give it to the person who opens the file separately (not in the same email). It can't be recovered.`}
          </p>
        </div>
      )}
    </fieldset>
  );
}

/** base64url of the UTF-8 bytes (lib/net/archiveCredentials.ts PASSWORD_HEADER). */
export function encodePasswordHeader(password: string): string {
  const bytes = new TextEncoder().encode(password);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface ArchiveCredentialsInput {
  login: string;
  password: string;
  recoveryKey: string;
}

/** Request headers carrying a protected backup's credentials (never the URL). */
export function credentialHeaders(c: ArchiveCredentialsInput | null): Record<string, string> {
  if (!c) return {};
  if (c.recoveryKey.trim()) return { 'x-ironbooks-recovery-key': c.recoveryKey.trim() };
  if (c.login.trim() && c.password) return { 'x-ironbooks-login': c.login.trim(), 'x-ironbooks-password': encodePasswordHeader(c.password) };
  return {};
}

/** Header carrying the password of a password-protected portable / transfer file. */
export function filePasswordHeader(password: string | null): Record<string, string> {
  return password ? { 'x-ironbooks-password': encodePasswordHeader(password) } : {};
}

/**
 * Ask for what opens a protected file: a user name + password of the company file it came from
 * (or its recovery key) — `mode: 'credentials'`; or one password — `mode: 'password'`.
 */
export function CredentialsModal({
  open,
  mode,
  title,
  message,
  error,
  busy,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  mode: 'credentials' | 'password';
  title: string;
  message: string;
  error?: string | null;
  busy?: boolean;
  onSubmit: (c: ArchiveCredentialsInput) => void;
  onCancel: () => void;
}) {
  const id = React.useId();
  const [c, setC] = React.useState<ArchiveCredentialsInput>({ login: '', password: '', recoveryKey: '' });
  const [useKey, setUseKey] = React.useState(false);
  React.useEffect(() => {
    if (open) setC((x) => ({ ...x, password: '' }));
  }, [open, error]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(useKey ? { login: '', password: '', recoveryKey: c.recoveryKey } : { ...c, recoveryKey: '' });
  };
  return (
    <Modal
      open={open}
      onClose={() => !busy && onCancel()}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={`${id}-form`} loading={busy}>
            Open
          </Button>
        </>
      }
    >
      <form id={`${id}-form`} onSubmit={submit} className="space-y-3">
        <p className="text-sm text-navy/70">{message}</p>
        {mode === 'credentials' && !useKey && (
          <div>
            <Label htmlFor={`${id}-login`}>User name</Label>
            <Input id={`${id}-login`} autoComplete="off" spellCheck={false} value={c.login} onChange={(e) => setC({ ...c, login: e.target.value })} required />
          </div>
        )}
        {!useKey && (
          <div>
            <Label htmlFor={`${id}-pw`}>Password</Label>
            <Input id={`${id}-pw`} type="password" autoComplete="off" value={c.password} onChange={(e) => setC({ ...c, password: e.target.value })} required />
          </div>
        )}
        {useKey && (
          <div>
            <Label htmlFor={`${id}-rk`}>Recovery key</Label>
            <Input id={`${id}-rk`} autoComplete="off" spellCheck={false} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" className="font-mono" value={c.recoveryKey} onChange={(e) => setC({ ...c, recoveryKey: e.target.value })} required />
          </div>
        )}
        {mode === 'credentials' && (
          <button type="button" className="text-sm text-electric hover:underline" onClick={() => setUseKey((v) => !v)}>
            {useKey ? 'Use a user name and password instead' : 'Use the recovery key instead'}
          </button>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
