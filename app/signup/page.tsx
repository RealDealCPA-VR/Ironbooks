'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Briefcase } from 'lucide-react';
import { Button, Card, Input, Label, toast } from '@/components/ui';
import { api } from '@/lib/client';

export default function SignupPage() {
  const [form, setForm] = useState({ name: '', email: '', password: '', companyName: '' });
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/auth/signup', form);
      // Every new company goes through the setup interview (it offers Skip).
      window.location.href = '/onboarding?new=1';
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Sign up failed', 'danger');
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
          <h1 className="text-2xl font-extrabold text-navy">Create your account</h1>
          <p className="text-sm text-navy/50">Set up BookKeeper AI in seconds</p>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label>Your name</Label>
            <Input value={form.name} onChange={set('name')} required autoFocus />
          </div>
          <div>
            <Label>Company name</Label>
            <Input value={form.companyName} onChange={set('companyName')} placeholder="Acme Inc." />
          </div>
          <div>
            <Label>Email</Label>
            <Input type="email" value={form.email} onChange={set('email')} required />
          </div>
          <div>
            <Label>Password</Label>
            <Input type="password" value={form.password} onChange={set('password')} required minLength={6} />
          </div>
          <Button type="submit" className="w-full" loading={busy}>
            Create account
          </Button>
        </form>
        <p className="mt-6 text-center text-sm text-navy/50">
          Already have an account?{' '}
          <Link href="/login" className="text-electric font-semibold hover:underline">
            Sign in
          </Link>
        </p>
      </Card>
    </main>
  );
}
