'use client';
/**
 * Users & Roles > Password rules (gapsb K, Admin only). The rules cover every login in this
 * company file: minimum length, letters + numbers, a symbol, expiry (then the person must pick a
 * new password at their next sign-in) and how many earlier passwords can't be reused.
 * GET/PUT /api/users/password-policy; the server only lets an Admin of every company in the file
 * save (lib/services/passwordPolicy.ts). Existing passwords keep working; the rules apply the next
 * time a password is set.
 */
import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button, Card, Input, Label, toast } from '@/components/ui';
import { api } from '@/lib/client';
import {
  PASSWORD_POLICY_LIMITS,
  describePasswordPolicy,
  normalizePasswordPolicy,
  type PasswordPolicy,
} from '@/lib/passwordPolicy';

export default function PasswordPolicyEditor() {
  const [policy, setPolicy] = useState<PasswordPolicy | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<PasswordPolicy>('/api/users/password-policy')
      .then((p) => setPolicy(normalizePasswordPolicy(p)))
      .catch((e) => toast(e instanceof Error ? e.message : 'Could not load the password rules.', 'danger'));
  }, []);

  if (!policy) return <Card className="p-6 text-sm text-navy/60">Loading password rules…</Card>;

  const set = <K extends keyof PasswordPolicy>(k: K, v: PasswordPolicy[K]) => setPolicy({ ...policy, [k]: v });
  const num = (v: string) => (v === '' ? 0 : Math.trunc(Number(v)));

  async function save() {
    setBusy(true);
    try {
      const saved = await api.put<PasswordPolicy>('/api/users/password-policy', policy);
      setPolicy(normalizePasswordPolicy(saved));
      toast('Password rules saved.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the password rules.', 'danger');
    } finally {
      setBusy(false);
    }
  }

  const [minLo, minHi] = PASSWORD_POLICY_LIMITS.minLength;
  const [expLo, expHi] = PASSWORD_POLICY_LIMITS.expiryDays;
  const [histLo, histHi] = PASSWORD_POLICY_LIMITS.historyCount;

  return (
    <Card className="p-6 max-w-2xl">
      <div className="mb-4 flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-electric" aria-hidden />
        <h2 className="text-lg font-bold text-navy">Password rules for this company file</h2>
      </div>
      <p className="mb-5 text-sm text-navy/60">
        These rules apply to everyone who signs in to this file whenever a password is set: when someone
        signs up, resets a forgotten password, changes their own, or an Admin sets one here. Passwords people
        already have keep working; if a password expires, the person is asked to choose a new one the next
        time they sign in.
      </p>
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="max-w-xs">
          <Label htmlFor="pp-min">Minimum length (characters)</Label>
          <Input
            id="pp-min"
            type="number"
            min={minLo}
            max={minHi}
            value={policy.minLength}
            onChange={(e) => set('minLength', num(e.target.value))}
          />
          <p className="mt-1 text-xs text-navy/50">At least {minLo}.</p>
        </div>
        <label className="flex items-start gap-3 text-sm text-navy">
          <input
            type="checkbox"
            className="mt-1"
            checked={policy.requireLettersAndNumbers}
            onChange={(e) => set('requireLettersAndNumbers', e.target.checked)}
          />
          <span>
            Require letters and numbers
            <span className="block text-xs text-navy/50">For example “harbor42” instead of “harborlights”.</span>
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm text-navy">
          <input
            type="checkbox"
            className="mt-1"
            checked={policy.requireSymbol}
            onChange={(e) => set('requireSymbol', e.target.checked)}
          />
          <span>
            Also require a symbol
            <span className="block text-xs text-navy/50">Such as ! # $ or %.</span>
          </span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="pp-exp">Passwords expire after (days)</Label>
            <Input
              id="pp-exp"
              type="number"
              min={expLo}
              max={expHi}
              value={policy.expiryDays}
              onChange={(e) => set('expiryDays', num(e.target.value))}
            />
            <p className="mt-1 text-xs text-navy/50">0 = never. QuickBooks uses 90.</p>
          </div>
          <div>
            <Label htmlFor="pp-hist">Can&apos;t reuse the last … passwords</Label>
            <Input
              id="pp-hist"
              type="number"
              min={histLo}
              max={histHi}
              value={policy.historyCount}
              onChange={(e) => set('historyCount', num(e.target.value))}
            />
            <p className="mt-1 text-xs text-navy/50">0 = no check. Up to {histHi}.</p>
          </div>
        </div>
        <p className="text-sm text-navy/70" aria-live="polite">
          New passwords: {describePasswordPolicy(normalizePasswordPolicy(policy))}
        </p>
        <Button type="submit" loading={busy}>
          Save password rules
        </Button>
      </form>
    </Card>
  );
}
