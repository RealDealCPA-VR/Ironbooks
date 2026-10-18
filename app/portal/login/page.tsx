'use client';
import { useState } from 'react';
import { UserSquare } from 'lucide-react';
import { Button, Card, Input, Label, toast } from '@/components/ui';
import { api } from '@/lib/client';

export default function PortalLoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/portal/login', { email, password });
      window.location.href = '/portal';
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Login failed', 'danger');
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-offwhite bg-[radial-gradient(1200px_600px_at_50%_-10%,rgb(var(--accent)/0.14),transparent)] p-4 font-sans">
      <Card className="w-full max-w-md p-8">
        <div className="flex flex-col items-center mb-6">
          <div className="rounded-xl bg-emerald h-12 w-12 flex items-center justify-center shadow-md mb-3">
            <UserSquare className="text-white h-6 w-6" />
          </div>
          <h1 className="text-2xl font-bold text-navy">Employee Portal</h1>
          <p className="text-sm text-navy/50">View your pay stubs and tax forms</p>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          <div>
            <Label>Password</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <Button type="submit" className="w-full" loading={busy}>
            Sign in
          </Button>
        </form>
        <p className="mt-6 text-center text-xs text-navy/40">
          Your employer sets up your portal access. Contact them if you can't sign in.
        </p>
      </Card>
    </main>
  );
}
