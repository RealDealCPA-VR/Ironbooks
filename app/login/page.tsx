'use client';
/**
 * Sign in to the open company file — QuickBooks' "QuickBooks Desktop Login" box.
 *
 * Users and passwords belong to the company FILE (they live inside it and travel with it), so
 * this screen says which company file it is opening and where that file is. The user name last
 * used for this file on this computer is filled in (desktop: the shell remembers it; browser /
 * teammates: this browser does), so most of the time you type your password and press Enter.
 * Cancel closes the company file (desktop: back to No Company Open).
 *
 * A company file protected with its own passwords (filecrypto) is encrypted: this ONE sign-in
 * also unlocks it on this computer (the user name and password open the file's key slot, the
 * books are decrypted into the private working copy, then the session starts). When the file also
 * has a company-file password it is asked here, once the file is open. After the sign-in: an
 * Admin of an unprotected single company file is offered to protect it (/security?protect=1),
 * and an "unsaved changes" copy kept at open time is reported.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Lock, ShieldCheck } from 'lucide-react';
import { Button, Card, Input, Label, toast } from '@/components/ui';
import { AccessKeyText } from '@/components/AccessKey';
import { ApiError, api } from '@/lib/client';
import { safeNext } from '@/lib/safeNext';

interface FileInfo {
  companyName: string | null;
  fileName: string;
  location: string | null;
  singleFile: boolean;
  hasUsers: boolean;
  fileId: string;
  remote: boolean;
  /** Protected with its own passwords (encrypted; filecrypto). */
  protected?: boolean;
}

interface DesktopCompanyBridge {
  company?: {
    lastUser?: () => Promise<string | null>;
    signedIn?: (name: string) => Promise<unknown>;
    close?: () => Promise<unknown>;
  };
  isDesktop?: boolean;
}

function desktop(): DesktopCompanyBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { bookkeeper?: DesktopCompanyBridge }).bookkeeper;
}

const lastUserKey = (fileId: string) => `ib:last-user:${fileId}`;

export default function LoginPage() {
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [userName, setUserName] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needs2fa, setNeeds2fa] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // filecrypto: the company-file password, asked once a protected file is open.
  const [needsFilePassword, setNeedsFilePassword] = useState(false);
  const [filePassword, setFilePassword] = useState('');
  // An "unsaved changes" copy kept when the file was opened: shown before continuing.
  const [keptCopy, setKeptCopy] = useState<{ path: string; next: string } | null>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const filePassRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const i = await fetch('/api/company-file/info', { cache: 'no-store' })
        .then((r) => (r.ok ? (r.json() as Promise<FileInfo>) : null))
        .catch(() => null);
      if (!alive) return;
      // A brand-new company file has no users yet: set up its Admin first.
      if (i && !i.hasUsers) {
        window.location.replace('/signup');
        return;
      }
      setInfo(i);
      let last: string | null = null;
      try {
        last = (await desktop()?.company?.lastUser?.()) ?? null;
      } catch {
        last = null;
      }
      if (!last && i?.fileId) {
        try {
          last = localStorage.getItem(lastUserKey(i.fileId));
        } catch {
          last = null;
        }
      }
      if (!alive) return;
      if (last) {
        setUserName(last);
        setTimeout(() => passRef.current?.focus(), 0);
      } else {
        setTimeout(() => userRef.current?.focus(), 0);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api.post<{
        name?: string;
        requires2fa?: boolean;
        mustChangePassword?: boolean;
        passwordChangeReason?: string;
        challengeMissing?: boolean;
        offerProtection?: boolean;
        conflictCopy?: string;
      }>('/api/auth/login', {
        email: userName,
        password,
        totp: totp || undefined,
        filePassword: needsFilePassword && filePassword ? filePassword : undefined,
      });
      if (res?.requires2fa) {
        setNeeds2fa(true);
        setBusy(false);
        return;
      }
      const login = userName.trim();
      try {
        if (info?.fileId) localStorage.setItem(lastUserKey(info.fileId), login);
      } catch {
        /* storage unavailable */
      }
      try {
        await desktop()?.company?.signedIn?.(login);
      } catch {
        /* the shell is optional */
      }
      // Only a page of this app (never another site or a javascript: URL — lib/safeNext.ts).
      const next = safeNext(new URLSearchParams(window.location.search).get('next'), '/dashboard', ['/login']);
      // gapsb K: an expired password (or one an Admin asked to change) must be replaced first.
      if (res?.mustChangePassword) {
        window.location.href =
          '/change-password?next=' + encodeURIComponent(next) + '&reason=' + encodeURIComponent(res.passwordChangeReason ?? 'required');
        return;
      }
      // No challenge question yet: offer to set one (once per computer and file), then continue.
      if (res?.challengeMissing && info?.fileId) {
        let asked = false;
        try {
          asked = localStorage.getItem(`ib:challenge-asked:${info.fileId}:${login}`) === '1';
          localStorage.setItem(`ib:challenge-asked:${info.fileId}:${login}`, '1');
        } catch {
          asked = true;
        }
        if (!asked) {
          window.location.href = '/security?challenge=1&next=' + encodeURIComponent(next);
          return;
        }
      }
      // filecrypto: an Admin of a single company file without passwords is offered protection.
      if (res?.offerProtection && info?.fileId) {
        let asked = false;
        try {
          asked = localStorage.getItem(`ib:protect-asked:${info.fileId}:${login}`) === '1';
          localStorage.setItem(`ib:protect-asked:${info.fileId}:${login}`, '1');
        } catch {
          asked = true;
        }
        if (!asked) {
          window.location.href = '/security?protect=1&next=' + encodeURIComponent(next);
          return;
        }
      }
      if (res?.conflictCopy) {
        setKeptCopy({ path: res.conflictCopy, next });
        setBusy(false);
        return;
      }
      window.location.href = next;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign-in failed';
      const details = err instanceof ApiError ? (err.details as { filePasswordRequired?: boolean; noKeySlot?: boolean } | undefined) : undefined;
      if (details?.filePasswordRequired) {
        // The file is open now; its own company-file password finishes opening it.
        setNeedsFilePassword(true);
        setError(filePassword ? msg : '');
        setFilePassword('');
        setBusy(false);
        setTimeout(() => filePassRef.current?.focus(), 0);
        return;
      }
      setError(/invalid email or password/i.test(msg) ? 'The user name or password is not correct. Passwords are case-sensitive.' : msg);
      setPassword('');
      setBusy(false);
      setTimeout(() => passRef.current?.focus(), 0);
    }
  }

  async function cancel() {
    const d = desktop();
    if (d?.company?.close) {
      await d.company.close();
      return;
    }
    toast('Close this browser tab to leave without signing in.', 'info');
  }

  const company = info?.companyName || info?.fileName?.replace(/\.(ironbooks|bookkeeper)$/i, '') || 'Company file';

  if (keptCopy) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-offwhite p-4 font-sans">
        <Card className="w-full max-w-md p-8 space-y-4">
          <h1 className="text-lg font-bold text-navy">Your unsaved changes were kept</h1>
          <p className="text-sm text-navy/70">
            The last time this company file was open on this computer, changes were made that never reached the file, and someone
            else has saved it since. Those changes were kept as a separate company file, protected with the same passwords:
          </p>
          <p className="font-mono text-xs text-navy/70 break-all select-text">{keptCopy.path}</p>
          <p className="text-sm text-navy/70">Open it later (File &gt; Open Company) to compare it with this file and re-enter anything that is missing.</p>
          <Button className="w-full" autoFocus onClick={() => (window.location.href = keptCopy.next)}>
            Continue
          </Button>
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-offwhite bg-[radial-gradient(1200px_600px_at_50%_-10%,rgb(var(--accent)/0.14),transparent)] p-4 font-sans">
      <Card className="w-full max-w-md p-8">
        <div className="flex items-start gap-4 mb-6">
          <div className="rounded-2xl bg-gradient-to-b from-electric/85 to-electric h-12 w-12 flex-none flex items-center justify-center shadow-md">
            <Lock className="text-white h-6 w-6" aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-navy leading-tight break-words">{company}</h1>
            <p className="text-sm text-navy/60 mt-0.5">Sign in to open this company file.</p>
            {info?.location && (
              <p className="mt-1 font-mono text-[11px] text-navy/45 break-all select-text" title={info.location}>
                {info.location}
              </p>
            )}
          </div>
        </div>
        {info?.protected && (
          <p className="mb-4 flex items-start gap-2 rounded-lg bg-emerald/5 px-3 py-2 text-xs text-navy/70" id="login-protected-help">
            <ShieldCheck className="h-4 w-4 flex-none text-emerald mt-px" aria-hidden />
            <span>
              This company file is protected with its own passwords: it is encrypted, and signing in also unlocks it on this computer.
              Your user name and password open it on any computer with Ironbooks.
            </span>
          </p>
        )}
        <form onSubmit={submit} className="space-y-4" aria-describedby={error ? 'login-error' : undefined}>
          <div>
            <Label htmlFor="login-user">
              <AccessKeyText text="User name" accessKey="u" />
            </Label>
            <Input
              id="login-user"
              ref={userRef}
              accessKey="u"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              autoComplete="username"
              spellCheck={false}
              required
            />
          </div>
          <div>
            <Label htmlFor="login-password">
              <AccessKeyText text="Password" accessKey="p" />
            </Label>
            <Input
              id="login-password"
              ref={passRef}
              accessKey="p"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {needsFilePassword && (
            <div>
              <Label htmlFor="login-file-password">Company file password</Label>
              <Input
                id="login-file-password"
                ref={filePassRef}
                type="password"
                value={filePassword}
                onChange={(e) => setFilePassword(e.target.value)}
                autoComplete="off"
                required
              />
              <p className="mt-1 text-xs text-navy/50">This company file also has its own open password (set by an Admin). Enter it to finish opening the file.</p>
            </div>
          )}
          {needs2fa && (
            <div>
              <Label htmlFor="login-totp">Authentication code</Label>
              <Input
                id="login-totp"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                placeholder="6-digit code"
                inputMode="numeric"
                autoFocus
                required
              />
            </div>
          )}
          {error && (
            <p id="login-error" role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" className="flex-1" loading={busy} data-shortcut="save">
              {needs2fa ? 'Verify & sign in' : 'OK'}
            </Button>
            <Button type="button" variant="secondary" className="flex-1" onClick={cancel} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
        <p className="mt-5 text-center text-sm">
          <Link href="/reset-password" className="text-navy/50 hover:text-electric hover:underline">
            I forgot my password
          </Link>
          {info?.protected && !info.remote && (
            <>
              <span className="text-navy/30"> · </span>
              <Link href="/reset-password?recovery=1" className="text-navy/50 hover:text-electric hover:underline">
                Use the recovery key
              </Link>
            </>
          )}
        </p>
      </Card>
    </main>
  );
}
