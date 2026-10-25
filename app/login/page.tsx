'use client';
/**
 * Sign in to the open company file — QuickBooks' "QuickBooks Desktop Login" box.
 *
 * Users and passwords belong to the company FILE (they live inside it and travel with it), so
 * this screen says which company file it is opening and where that file is. The user name last
 * used for this file on this computer is filled in (desktop: the shell remembers it; browser /
 * teammates: this browser does), so most of the time you type your password and press Enter.
 * Cancel closes the company file (desktop: back to No Company Open).
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Lock } from 'lucide-react';
import { Button, Card, Input, Label, toast } from '@/components/ui';
import { AccessKeyText } from '@/components/AccessKey';
import { api } from '@/lib/client';

interface FileInfo {
  companyName: string | null;
  fileName: string;
  location: string | null;
  singleFile: boolean;
  hasUsers: boolean;
  fileId: string;
  remote: boolean;
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
  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);

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
      }>('/api/auth/login', {
        email: userName,
        password,
        totp: totp || undefined,
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
      const next = new URLSearchParams(window.location.search).get('next') || '/dashboard';
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
      window.location.href = next;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign-in failed';
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
        </p>
      </Card>
    </main>
  );
}
