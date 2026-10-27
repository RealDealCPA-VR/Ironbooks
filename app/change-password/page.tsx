'use client';
/**
 * Change My Password (gapsb K). Anyone signed in can change their own password here (reachable
 * from Company > Change My Password). It is also where a person lands when their password has
 * expired under the file's password policy, or an Admin asked them to pick a new one: until they
 * do, every other screen is refused (lib/context.ts) and lib/client.ts sends them here.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { KeyRound } from 'lucide-react';
import { Button, Card, Input, Label, toast } from '@/components/ui';
import { api } from '@/lib/client';
import { safeNext } from '@/lib/safeNext';
import { PasswordRulesHint, meetsPolicy, usePasswordPolicy } from '@/components/PasswordRules';

interface Me {
  name: string;
  mustChangePassword?: boolean;
}

/** Only same-app paths are followed after the change (no open redirect — lib/safeNext.ts). */
const nextAfterChange = (raw: string | null) => safeNext(raw, '/dashboard', ['/change-password']);

export default function ChangePasswordPage() {
  const policy = usePasswordPolicy();
  const [me, setMe] = useState<Me | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setReason(new URLSearchParams(window.location.search).get('reason'));
    fetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((u: Me | null) => {
        if (!u) window.location.href = '/login?next=/change-password';
        else setMe(u);
      })
      .catch(() => setMe(null));
  }, []);

  const required = Boolean(me?.mustChangePassword);
  const mismatch = confirm.length > 0 && confirm !== next;

  async function save() {
    if (next !== confirm) {
      toast('The new passwords do not match.', 'danger');
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/auth/change-password', { currentPassword: current, newPassword: next });
      toast('Your password was changed.', 'success');
      window.location.href = nextAfterChange(new URLSearchParams(window.location.search).get('next'));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not change the password.', 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.href = '/login';
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-offwhite bg-[radial-gradient(1200px_600px_at_50%_-10%,rgb(var(--accent)/0.14),transparent)] p-4 font-sans">
      <Card className="w-full max-w-md p-8">
        <div className="flex flex-col items-center mb-6">
          <div className="rounded-2xl bg-gradient-to-b from-electric/85 to-electric h-12 w-12 flex items-center justify-center shadow-md mb-3">
            <KeyRound className="text-white h-6 w-6" aria-hidden />
          </div>
          <h1 className="text-2xl font-bold text-navy">Change my password</h1>
          {me && <p className="text-sm text-navy/60 mt-1">Signed in as {me.name}</p>}
        </div>

        {required && (
          <div role="alert" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {reason === 'expired'
              ? 'Your password has expired under this company file’s password rules. Choose a new one to continue.'
              : 'You need to choose a new password before you continue.'}
          </div>
        )}

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div>
            <Label htmlFor="cp-current">Current password</Label>
            <Input
              id="cp-current"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="cp-new">New password</Label>
            <Input
              id="cp-new"
              type="password"
              autoComplete="new-password"
              aria-describedby="cp-rules"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
            <PasswordRulesHint id="cp-rules" password={next} policy={policy} />
            {policy.historyCount > 0 && (
              <p className="mt-1 text-xs text-navy/50">
                You can&apos;t reuse your last {policy.historyCount} password{policy.historyCount === 1 ? '' : 's'}.
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="cp-confirm">Type the new password again</Label>
            <Input
              id="cp-confirm"
              type="password"
              autoComplete="new-password"
              aria-invalid={mismatch || undefined}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {mismatch && <p className="mt-1 text-xs text-red-600">The two new passwords are different.</p>}
          </div>
          <Button
            type="submit"
            className="w-full"
            loading={busy}
            disabled={!current || !meetsPolicy(next, policy) || next !== confirm}
          >
            Change password
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-navy/50">
          {required ? (
            <button type="button" onClick={() => void signOut()} className="text-electric font-semibold hover:underline">
              Sign out instead
            </button>
          ) : (
            <Link href="/dashboard" className="text-electric font-semibold hover:underline">
              Back to Home
            </Link>
          )}
        </p>
      </Card>
    </main>
  );
}
