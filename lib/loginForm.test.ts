/**
 * prefsperms (review 5 leftover): the sign-in screen cleared the PASSWORD after a wrong
 * authenticator code, so the person had to type both again. The decision is a pure function now
 * (lib/loginForm.ts), used by app/login/page.tsx.
 */
import { describe, expect, it } from 'vitest';
import { afterFailedSignIn } from './loginForm';

describe('sign-in screen after a failed attempt', () => {
  it('a wrong authenticator code keeps the password and asks for the code again', () => {
    const r = afterFailedSignIn('Invalid authentication code.', true);
    expect(r.clearPassword).toBe(false);
    expect(r.clearCode).toBe(true);
    expect(r.focus).toBe('code');
    expect(r.keepCodeStep).toBe(true);
    expect(r.error).toMatch(/recovery code/i);
  });

  it('a wrong password clears only the password', () => {
    const r = afterFailedSignIn('Invalid email or password.', false);
    expect(r).toMatchObject({ clearPassword: true, clearCode: true, focus: 'password', keepCodeStep: false });
    expect(r.error).toMatch(/case-sensitive/);
  });

  it('anything else (too many attempts, file locked) keeps what was typed', () => {
    const r = afterFailedSignIn('Too many sign-in attempts. Try again in 1 minute.', true);
    expect(r).toMatchObject({ clearPassword: false, clearCode: false, focus: 'code', keepCodeStep: true });
    expect(r.error).toBe('Too many sign-in attempts. Try again in 1 minute.');
  });
});
