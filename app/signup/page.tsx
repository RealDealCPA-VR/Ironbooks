'use client';
/**
 * Set up a new company file's Admin — QuickBooks' "Set up an external accountant / Admin
 * password" step of creating a company.
 *
 * The user name and password belong to THIS company file: they are stored inside it and travel
 * with it when it is copied to a file server, a USB drive or an accountant. Anyone who opens the
 * file must sign in. The challenge question is how a forgotten Admin password is reset, so a copy
 * of the file can't be opened by someone who merely guesses the user name.
 *
 * A new single company file is protected with passwords from its first save (filecrypto; on by
 * default, "Protect this company file" can be unticked): the file is encrypted and only its own
 * user names and passwords open it, on any computer. The recovery key is shown once, right after
 * the Admin is created (print it or save it), before the setup interview.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Briefcase } from 'lucide-react';
import { Button, Card, Input, Label, Select, toast } from '@/components/ui';
import { api } from '@/lib/client';
import { MIN_PASSWORD_LENGTH } from '@/lib/passwordPolicy';
import { CHALLENGE_QUESTIONS, CHALLENGE_SLOT_RULE_TEXT, challengeAnswerOpensFile } from '@/lib/challengeQuestions';
import { PasswordRulesHint, usePasswordPolicy } from '@/components/PasswordRules';
import { RecoveryKeyPanel } from '@/components/FileProtection';

interface FileInfo {
  companyName: string | null;
  fileName: string;
  location: string | null;
  hasUsers: boolean;
  /** A single company file (.ironbooks): only those can be protected with passwords. */
  singleFile?: boolean;
}

/** Where a new company goes after its Admin is set up ("Convert from QuickBooks" → the import wizard). */
function afterSetup(): string {
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('then') === 'qb-import') return '/qb-import';
  return '/onboarding?new=1';
}

export default function SignupPage() {
  const [form, setForm] = useState({
    name: '',
    userName: 'Admin',
    password: '',
    confirm: '',
    companyName: '',
    challengeQuestion: CHALLENGE_QUESTIONS[0],
    challengeAnswer: '',
  });
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [protect, setProtect] = useState(true);
  const [recovery, setRecovery] = useState<{ key: string; companyName: string } | null>(null);
  const policy = usePasswordPolicy();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    fetch('/api/company-file/info', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<FileInfo>) : null))
      .then((i) => {
        if (!i) return;
        if (i.hasUsers) {
          window.location.replace('/login');
          return;
        }
        setInfo(i);
        const fromFile = (i.companyName || i.fileName.replace(/\.(ironbooks|bookkeeper)$/i, '')).trim();
        setForm((f) => (f.companyName ? f : { ...f, companyName: fromFile === 'default' ? '' : fromFile }));
      })
      .catch(() => {});
  }, []);

  const mismatch = form.confirm.length > 0 && form.confirm !== form.password;
  // A protected (encrypted) file: the answer must be strong enough to open the file by itself,
  // or "I forgot my password" stops working once the file is closed (lib/challengeQuestions.ts).
  const weakAnswer = Boolean(info?.singleFile && protect && form.challengeAnswer.trim() && !challengeAnswerOpensFile(form.challengeAnswer));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password !== form.confirm) {
      toast('The two passwords are different. Type the same password twice.', 'danger');
      return;
    }
    setBusy(true);
    try {
      const created = await api.post<{ recoveryKey?: string }>('/api/auth/signup', {
        name: form.name,
        email: form.userName,
        password: form.password,
        companyName: form.companyName,
        challengeQuestion: form.challengeQuestion,
        challengeAnswer: form.challengeAnswer,
        protect: info?.singleFile ? protect : undefined,
      });
      try {
        await (window as unknown as { bookkeeper?: { company?: { signedIn?: (n: string) => Promise<unknown> } } }).bookkeeper?.company?.signedIn?.(
          form.userName.trim(),
        );
      } catch {
        /* the shell is optional */
      }
      // The recovery key is shown once (print / save it) before the setup interview.
      if (created?.recoveryKey) {
        setRecovery({ key: created.recoveryKey, companyName: form.companyName.trim() || info?.companyName || 'Company' });
        setBusy(false);
        return;
      }
      // Every new company goes through the setup interview (it offers Skip) — or, when it was
      // created by "Convert from QuickBooks", straight to the QuickBooks import.
      window.location.href = afterSetup();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Setup failed', 'danger');
      setBusy(false);
    }
  }

  if (recovery) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-offwhite bg-[radial-gradient(1200px_600px_at_50%_-10%,rgb(var(--accent)/0.14),transparent)] p-4 font-sans">
        <Card className="w-full max-w-lg p-8">
          <RecoveryKeyPanel
            recoveryKey={recovery.key}
            companyName={recovery.companyName}
            doneLabel={afterSetup() === '/qb-import' ? 'Continue to the QuickBooks import' : 'Continue to the company setup'}
            onDone={() => (window.location.href = afterSetup())}
          />
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-offwhite bg-[radial-gradient(1200px_600px_at_50%_-10%,rgb(var(--accent)/0.14),transparent)] p-4 font-sans">
      <Card className="w-full max-w-lg p-8">
        <div className="flex items-start gap-4 mb-6">
          <div className="rounded-2xl bg-gradient-to-b from-electric/85 to-electric h-12 w-12 flex-none flex items-center justify-center shadow-md">
            <Briefcase className="text-white h-6 w-6" aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-navy">Set up the Admin for this company file</h1>
            <p className="text-sm text-navy/60 mt-0.5">
              The Admin can do everything and adds the other users. This user name and password are saved in the
              company file itself, so they go wherever the file goes.
            </p>
            {info?.location && (
              <p className="mt-1 font-mono text-[11px] text-navy/45 break-all select-text">{info.location}</p>
            )}
          </div>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="su-company">Company name</Label>
            <Input id="su-company" value={form.companyName} onChange={set('companyName')} placeholder="Acme Plumbing, Inc." autoFocus />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="su-name">Your name</Label>
              <Input id="su-name" value={form.name} onChange={set('name')} required autoComplete="name" />
            </div>
            <div>
              <Label htmlFor="su-user">User name</Label>
              <Input
                id="su-user"
                value={form.userName}
                onChange={set('userName')}
                required
                spellCheck={false}
                autoComplete="username"
                pattern="\S+"
                title="No spaces"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="su-password">Password</Label>
              <Input
                id="su-password"
                type="password"
                value={form.password}
                onChange={set('password')}
                required
                minLength={Math.max(MIN_PASSWORD_LENGTH, policy.minLength)}
                aria-describedby="su-password-rules"
                autoComplete="new-password"
              />
            </div>
            <div>
              <Label htmlFor="su-confirm">Confirm password</Label>
              <Input
                id="su-confirm"
                type="password"
                value={form.confirm}
                onChange={set('confirm')}
                required
                aria-invalid={mismatch || undefined}
                autoComplete="new-password"
              />
              {mismatch && <p className="mt-1 text-xs text-red-600">The passwords don&apos;t match yet.</p>}
            </div>
          </div>
          <PasswordRulesHint id="su-password-rules" password={form.password} policy={policy} />
          <fieldset className="rounded-xl border border-navy/10 p-4 space-y-3">
            <legend className="px-1 text-sm font-semibold text-navy">If you ever forget the password</legend>
            <p className="text-xs text-navy/60">
              Pick a question only you can answer. Ironbooks asks it before letting anyone reset this password.
            </p>
            <div>
              <Label htmlFor="su-question">Challenge question</Label>
              <Select id="su-question" value={form.challengeQuestion} onChange={set('challengeQuestion')}>
                {CHALLENGE_QUESTIONS.map((q) => (
                  <option key={q} value={q}>
                    {q}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="su-answer">Answer</Label>
              <Input id="su-answer" value={form.challengeAnswer} onChange={set('challengeAnswer')} required autoComplete="off" />
              <p className="mt-1 text-xs text-navy/50">Not case-sensitive. Write it down somewhere safe.</p>
              {info?.singleFile && protect && (
                <p className={`mt-1 text-xs ${weakAnswer ? 'text-red-600' : 'text-navy/50'}`}>
                  {weakAnswer
                    ? `Use a longer answer: at least 10 characters, like a short phrase ("pip the grey cat"). Otherwise this answer can't get you back into the protected file if you forget the password.`
                    : CHALLENGE_SLOT_RULE_TEXT}
                </p>
              )}
            </div>
          </fieldset>
          {info?.singleFile && (
            <label className="flex items-start gap-2 rounded-xl border border-navy/10 p-4 text-sm text-navy">
              <input type="checkbox" className="mt-1" checked={protect} onChange={(e) => setProtect(e.target.checked)} />
              <span>
                <span className="font-semibold">Protect this company file with passwords</span> (recommended). The file is encrypted:
                only its own user names and passwords open it, on any computer. You get a recovery key next — print it or save it.
              </span>
            </label>
          )}
          {info?.singleFile && !protect && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Without protection there is no recovery key. If you forget both this password and the challenge answer, nobody
              can sign in as Admin. Add a second Admin later in Users &amp; Roles as a backup.
            </p>
          )}
          <Button type="submit" className="w-full" loading={busy} disabled={mismatch || weakAnswer}>
            Create the Admin and continue
          </Button>
        </form>
        <p className="mt-6 text-center text-sm text-navy/50">
          This company file already has users?{' '}
          <Link href="/login" className="text-electric font-semibold hover:underline">
            Sign in
          </Link>
        </p>
      </Card>
    </main>
  );
}
