/**
 * What the sign-in screen (app/login/page.tsx) does after a failed attempt. Pure, so it is tested
 * in node (lib/loginForm.test.ts).
 *
 * The server checks the password BEFORE the second factor, so "Invalid authentication code" means
 * the password was right: keep it and ask only for the code again (review round 5 leftover — the
 * screen used to clear the password too, and the person had to retype both).
 */
export interface FailedSignInState {
  error: string;
  clearPassword: boolean;
  clearCode: boolean;
  /** Which field gets the cursor. */
  focus: 'password' | 'code';
  /** Stay on the "authentication code" step. */
  keepCodeStep: boolean;
}

export function afterFailedSignIn(message: string, onCodeStep: boolean): FailedSignInState {
  if (/invalid email or password/i.test(message)) {
    return {
      error: 'The user name or password is not correct. Passwords are case-sensitive.',
      clearPassword: true,
      clearCode: true,
      focus: 'password',
      keepCodeStep: false,
    };
  }
  if (/invalid authentication code/i.test(message)) {
    return {
      error:
        'That code is not right. Enter the current 6-digit code from your authenticator app, or one of your recovery codes.',
      clearPassword: false,
      clearCode: true,
      focus: 'code',
      keepCodeStep: true,
    };
  }
  return {
    error: message || 'Sign-in failed',
    clearPassword: false,
    clearCode: false,
    focus: onCodeStep ? 'code' : 'password',
    keepCodeStep: onCodeStep,
  };
}
