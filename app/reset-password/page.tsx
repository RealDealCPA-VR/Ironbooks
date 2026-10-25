'use client';
/**
 * "I forgot my password" for the open company file (QuickBooks parity: answer your challenge
 * question, then choose a new password). The users and their challenge answers live inside the
 * company file, so this works offline on whatever computer has the file open — and someone who
 * only has a copy of the file can't get in by guessing a user name.
 *
 * Steps: user name → challenge question (when the user has one) → new password.
 * A company file with several users and no challenge question: an Admin resets the password in
 * Users & Roles instead (the server says so).
 */
import { useState } from 'react';
import Link from 'next/link';
import { KeyRound } from 'lucide-react';
import { Button, Card, Input, Label, toast } from '@/components/ui';
import { api } from '@/lib/client';
import { PasswordRulesHint, meetsPolicy, usePasswordPolicy } from '@/components/PasswordRules';

type Step = 'user' | 'question' | 'password';

export default function ResetPasswordPage() {
  const [step, setStep] = useState<Step>('user');
  const [userName, setUserName] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const policy = usePasswordPolicy();

  async function ask(withAnswer: boolean) {
    setBusy(true);
    setError('');
    try {
      const r = await api.post<{ token?: string; challengeQuestion?: string; message?: string }>('/api/auth/request-reset', {
        email: userName,
        ...(withAnswer ? { challengeAnswer: answer } : {}),
      });
      if (r.token) {
        setToken(r.token);
        setStep('password');
      } else if (r.challengeQuestion) {
        setQuestion(r.challengeQuestion);
        setStep('question');
      } else {
        // Unknown user name (or a hosted/teammate session, which never gets a token here).
        setError(
          "Ironbooks can't reset that user's password from this screen. Check the user name, or ask the company file's Admin to reset it in Company > Users and Roles.",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The password could not be reset.');
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (password !== confirm) {
      setError('The two passwords are different. Type the same password twice.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/reset', { token, password });
      toast('Password changed. Sign in with the new password.', 'success');
      setTimeout(() => (window.location.href = '/login'), 600);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The password could not be changed.');
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-offwhite bg-[radial-gradient(1200px_600px_at_50%_-10%,rgb(var(--accent)/0.14),transparent)] p-4 font-sans">
      <Card className="w-full max-w-md p-8">
        <div className="flex items-start gap-4 mb-6">
          <div className="rounded-2xl bg-gradient-to-b from-electric/85 to-electric h-12 w-12 flex-none flex items-center justify-center shadow-md">
            <KeyRound className="text-white h-6 w-6" aria-hidden />
          </div>
          <div>
            <h1 className="text-xl font-bold text-navy">Reset a forgotten password</h1>
            <p className="text-sm text-navy/60 mt-0.5">
              {step === 'user' && 'Enter your user name for this company file.'}
              {step === 'question' && 'Answer the challenge question you chose when the password was set.'}
              {step === 'password' && 'Choose a new password.'}
            </p>
          </div>
        </div>

        {step === 'user' && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              ask(false);
            }}
          >
            <div>
              <Label htmlFor="rp-user">User name</Label>
              <Input id="rp-user" autoFocus value={userName} onChange={(e) => setUserName(e.target.value)} spellCheck={false} autoComplete="username" />
            </div>
            <Button type="submit" className="w-full" loading={busy} disabled={!userName.trim()}>
              Next
            </Button>
          </form>
        )}

        {step === 'question' && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              ask(true);
            }}
          >
            <div>
              <Label htmlFor="rp-answer">{question}</Label>
              <Input id="rp-answer" autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} autoComplete="off" />
              <p className="mt-1 text-xs text-navy/50">Not case-sensitive.</p>
            </div>
            <Button type="submit" className="w-full" loading={busy} disabled={!answer.trim()}>
              Next
            </Button>
          </form>
        )}

        {step === 'password' && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              reset();
            }}
          >
            <div>
              <Label htmlFor="rp-new">New password</Label>
              <Input
                id="rp-new"
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                aria-describedby="rp-new-rules"
              />
              <PasswordRulesHint id="rp-new-rules" password={password} policy={policy} />
            </div>
            <div>
              <Label htmlFor="rp-confirm">Confirm new password</Label>
              <Input id="rp-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            </div>
            <Button type="submit" className="w-full" loading={busy} disabled={!meetsPolicy(password, policy) || !confirm}>
              Set new password
            </Button>
          </form>
        )}

        {error && (
          <p role="alert" className="mt-4 text-sm text-red-600">
            {error}
          </p>
        )}
        <p className="mt-6 text-center text-sm text-navy/50">
          <Link href="/login" className="text-electric font-semibold hover:underline">
            Back to sign in
          </Link>
        </p>
      </Card>
    </main>
  );
}
