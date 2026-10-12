'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Briefcase } from 'lucide-react';
import { Button, Card, Input, Label, toast } from '@/components/ui';
import { api } from '@/lib/client';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needs2fa, setNeeds2fa] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post<{ requires2fa?: boolean }>('/api/auth/login', {
        email,
        password,
        totp: totp || undefined,
      });
      if (res?.requires2fa) {
        setNeeds2fa(true);
        setBusy(false);
        return;
      }
      const next = new URLSearchParams(window.location.search).get('next') || '/dashboard';
      window.location.href = next;
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Login failed', 'danger');
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-navy via-[#11294a] to-navy p-4 font-sans">
      <Card className="w-full max-w-md p-8">
        <div className="flex flex-col items-center mb-6">
          <div className="rounded-xl bg-navy h-12 w-12 flex items-center justify-center shadow-md mb-3">
            <Briefcase className="text-gold h-6 w-6" />
          </div>
          <h1 className="text-2xl font-extrabold text-navy">Welcome back</h1>
          <p className="text-sm text-navy/50">Sign in to BookKeeper AI</p>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label>Email or user name</Label>
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
              autoFocus
            />
          </div>
          <div>
            <Label>Password</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {needs2fa && (
            <div>
              <Label>Authentication code</Label>
              <Input
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                placeholder="6-digit code"
                inputMode="numeric"
                autoFocus
                required
              />
            </div>
          )}
          <Button type="submit" className="w-full" loading={busy}>
            {needs2fa ? 'Verify & sign in' : 'Sign in'}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm">
          <Link href="/reset-password" className="text-navy/50 hover:text-electric hover:underline">
            Forgot password?
          </Link>
        </p>
        <p className="mt-2 text-center text-sm text-navy/50">
          New company file?{' '}
          <Link href="/signup" className="text-electric font-semibold hover:underline">
            Set up the first user
          </Link>
        </p>
      </Card>
    </main>
  );
}
