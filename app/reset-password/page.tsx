'use client';
import { useState } from 'react';
import Link from 'next/link';
import { KeyRound } from 'lucide-react';
import { Button, Card, Input, Label, toast } from '@/components/ui';
import { api } from '@/lib/client';
import { PasswordRulesHint, meetsPolicy, usePasswordPolicy } from '@/components/PasswordRules';

export default function ResetPasswordPage() {
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const policy = usePasswordPolicy();

  async function requestToken() {
    setBusy(true);
    try {
      const r = await api.post<{ token?: string }>('/api/auth/request-reset', { email });
      if (r.token) {
        setToken(r.token);
        toast('Reset token generated — set your new password below.', 'success');
      } else {
        toast('If that account exists, a token was generated.', 'info');
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed', 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    try {
      await api.post('/api/auth/reset', { token, password });
      toast('Password reset. You can sign in now.', 'success');
      setTimeout(() => (window.location.href = '/login'), 800);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed', 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-offwhite bg-[radial-gradient(1200px_600px_at_50%_-10%,rgb(var(--accent)/0.14),transparent)] p-4 font-sans">
      <Card className="w-full max-w-md p-8">
        <div className="flex flex-col items-center mb-6">
          <div className="rounded-2xl bg-gradient-to-b from-electric/85 to-electric h-12 w-12 flex items-center justify-center shadow-md mb-3">
            <KeyRound className="text-white h-6 w-6" />
          </div>
          <h1 className="text-2xl font-bold text-navy">Reset password</h1>
        </div>

        <div className="space-y-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              requestToken();
            }}
          >
            <Label>Email</Label>
            <div className="flex gap-2">
              <Input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
              <Button type="submit" variant="secondary" loading={busy} disabled={!email}>
                Get token
              </Button>
            </div>
          </form>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              reset();
            }}
            className="space-y-4"
          >
            <div>
              <Label>Reset token</Label>
              <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="paste token" />
            </div>
            <div>
              <Label htmlFor="rp-new">New password</Label>
              <Input
                id="rp-new"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                aria-describedby="rp-new-rules"
              />
              <PasswordRulesHint id="rp-new-rules" password={password} policy={policy} />
            </div>
            <Button type="submit" className="w-full" loading={busy} disabled={!token || !meetsPolicy(password, policy)}>
              Set new password
            </Button>
          </form>
        </div>
        <p className="mt-4 text-xs text-navy/60">
          Self-service reset is only for a company file with a single user. If your file has
          several users, ask an Admin to reset your password in Users &amp; Roles.
        </p>
        <p className="mt-6 text-center text-sm text-navy/50">
          <Link href="/login" className="text-electric font-semibold hover:underline">Back to sign in</Link>
        </p>
      </Card>
    </main>
  );
}
