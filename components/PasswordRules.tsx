'use client';
/**
 * The company file's password rules on password forms (sign-up, reset, change password, Users &
 * Roles). Reads GET /api/auth/password-policy (falls back to the defaults) and shows what a new
 * password still needs as the person types. The server enforces the same rules
 * (lib/services/passwordPolicy.ts); this is only guidance.
 */
import * as React from 'react';
import {
  DEFAULT_PASSWORD_POLICY,
  describePasswordPolicy,
  normalizePasswordPolicy,
  passwordProblems,
  type PasswordPolicy,
} from '@/lib/passwordPolicy';

export function usePasswordPolicy(): PasswordPolicy {
  const [policy, setPolicy] = React.useState<PasswordPolicy>({ ...DEFAULT_PASSWORD_POLICY });
  React.useEffect(() => {
    let alive = true;
    fetch('/api/auth/password-policy')
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => {
        if (alive && p) setPolicy(normalizePasswordPolicy(p));
      })
      .catch(() => {
        /* defaults */
      });
    return () => {
      alive = false;
    };
  }, []);
  return policy;
}

/** True when `password` meets the policy (for disabling a submit button). */
export function meetsPolicy(password: string, policy: PasswordPolicy): boolean {
  return passwordProblems(password, policy).length === 0;
}

export function PasswordRulesHint({
  id,
  password,
  policy,
}: {
  id?: string;
  password: string;
  policy: PasswordPolicy;
}) {
  const missing = password ? passwordProblems(password, policy) : [];
  return (
    <p id={id} className="mt-1 text-xs text-navy/60" aria-live="polite">
      {describePasswordPolicy(policy)}
      {missing.length > 0 && <span className="text-red-600"> Still needed: {missing.join(', ')}.</span>}
    </p>
  );
}
