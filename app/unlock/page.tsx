'use client';
/**
 * Company-file unlock screen (QuickBooks-Desktop-style "open this file" password).
 *
 * On mount it POSTs an empty password: if the file is unprotected the server sets the unlock
 * cookie and we continue straight through (a brief spinner). If the file is protected the server
 * replies 401 and we render the password prompt.
 */
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Lock } from 'lucide-react';
import { Button, Card, Input, Label } from '@/components/ui';
import { safeNext } from '@/lib/safeNext';

function UnlockInner() {
  const router = useRouter();
  const params = useSearchParams();
  // Only same-app paths (never an open redirect — lib/safeNext.ts).
  const next = safeNext(params.get('next'), '/', ['/unlock']);

  const [phase, setPhase] = useState<'checking' | 'prompt'>('checking');
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /** true = unlocked; otherwise the message to show ('' = just ask for the password). */
  async function attempt(pwd: string): Promise<true | string> {
    const res = await fetch('/api/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: pwd }),
    });
    if (res.ok) {
      // Full reload so middleware + server see the new cookie immediately.
      window.location.assign(next);
      return true;
    }
    const data = await res.json().catch(() => ({}));
    if (typeof data.companyName === 'string') setCompanyName(data.companyName);
    // Too many wrong passwords: say so (the right password is refused too until the wait is over).
    if (res.status === 429) return typeof data.error === 'string' ? data.error : 'Too many attempts. Wait a minute and try again.';
    return pwd ? 'Incorrect password. Please try again.' : '';
  }

  // Auto-pass when the file has no password.
  useEffect(() => {
    let active = true;
    (async () => {
      const passed = await attempt('');
      if (active && passed !== true) {
        if (passed) setError(passed);
        setPhase('prompt');
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;
    setSubmitting(true);
    setError('');
    const result = await attempt(password);
    if (result !== true) {
      setError(result || 'Incorrect password. Please try again.');
      setSubmitting(false);
      setPassword('');
      inputRef.current?.focus();
    }
  }

  if (phase === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-offwhite bg-[radial-gradient(1200px_600px_at_50%_-10%,rgb(var(--accent)/0.14),transparent)]">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-navy/15 border-t-electric" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-offwhite bg-[radial-gradient(1200px_600px_at_50%_-10%,rgb(var(--accent)/0.14),transparent)] p-4">
      <Card className="w-full max-w-sm p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-4 rounded-2xl bg-electric/10 p-4">
            <Lock className="h-8 w-8 text-electric" />
          </div>
          <h1 className="text-xl font-bold text-navy">{companyName || 'Company File'}</h1>
          <p className="mt-1 text-sm text-navy/60">This company file is password protected.</p>
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <Label htmlFor="file-password">File password</Label>
            <Input
              id="file-password"
              ref={inputRef}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter the file password"
            />
            {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
          </div>
          <Button type="submit" className="w-full" loading={submitting} disabled={!password}>
            Unlock
          </Button>
        </form>
      </Card>
    </div>
  );
}

export default function UnlockPage() {
  return (
    <Suspense fallback={null}>
      <UnlockInner />
    </Suspense>
  );
}
