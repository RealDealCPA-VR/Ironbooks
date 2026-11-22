/**
 * The guess limit of the closing-date password (QB "Set Closing Date" password), one helper for
 * every way a guess comes in:
 *  - lib/context.ts resolveClosingDateOverride: the x-closing-password header of a person's save;
 *  - lib/services/company.ts setClosingDate: the current password, to move the date earlier or to
 *    change or remove the password;
 *  - lib/agent/bridge.ts: the password a person types on an agent's approval card.
 *
 * Guesses are limited like sign-in (review round 5): this was the one password with no attempt
 * limit, so a user with the closed-period right but not the password (an Accountant, an External
 * Accountant) could try passwords until one worked. The keys are the person in this company, plus
 * the global cap, in the realm of where the request came from (lib/net/rateLimit.ts attemptKeys:
 * 'local' for the Ironbooks window on this computer, the device for a teammate's). Never the
 * address alone: everyone working on this computer shares 'local', and one person's wrong guesses
 * must not lock the others out.
 *
 * A person's own guesses, made in their own window, all count under the same keys, whichever of the
 * three ways they come in, so they cannot be spread over them. A password typed on an approval
 * card is counted under the approving person's own keys only: the bridge checks it before each run
 * of the agent's work it is handed to (the rolled-back try an approval may make, the commit),
 * outside the agent's service scope (so in the approver's realm). A wrong one refuses that run at
 * once, whatever the work, before the route runs: nothing after it is tried, so one approval is at
 * most one wrong guess. A right one reaches Set Closing Date marked as already checked
 * (lib/serviceScope.ts closingPasswordCheckedInScope), which compares it again without counting it,
 * so it is never counted under the agent scope's keys ("this computer, outside Ironbooks").
 *
 * A locked limiter refuses before the password is even looked at, so the right password does not
 * get through a lock either.
 */
import { GLOBAL_KEY_WEIGHT, attemptKeys, loginLimiter, tooManyAttempts } from '@/lib/net/rateLimit';
import { getRequestOrigin } from '@/lib/net/requestInfo';
import { ServiceError } from '@/lib/services/errors';

/** The limiter's key scope for closing-date password guesses. */
export const CLOSING_PASSWORD_SCOPE = 'closing-password';

/** Who is guessing: the person (null with nobody signed in) in this company. */
export interface ClosingPasswordGuesser {
  companyId: string;
  userId?: string | null;
}

/** "Too many wrong closing-date passwords. Try again in 40 seconds." */
function tooManyWrongGuesses(retryAfterMs: number): ServiceError {
  const secs = Number(tooManyAttempts(retryAfterMs).retryAfter);
  return new ServiceError(
    'FORBIDDEN',
    `Too many wrong closing-date passwords. Try again in ${secs < 90 ? `${secs} seconds` : `${Math.ceil(secs / 60)} minutes`}.`,
    { rateLimited: true, retryAfterSeconds: secs },
  );
}

/**
 * Check one closing-date password guess through the limiter. `verify` says whether the password is
 * right; it runs only when the limiter lets the guess through. A right password clears the person's
 * own count (not the global one), a wrong one counts against both. Returns what `verify` said.
 *
 * Throws a FORBIDDEN ServiceError (details { rateLimited: true, retryAfterSeconds }) before
 * `verify` runs when there were too many wrong guesses; an error `verify` throws is thrown as it is.
 */
export async function limitClosingPasswordGuess(who: ClosingPasswordGuesser, verify: () => Promise<boolean>): Promise<boolean> {
  const origin = await getRequestOrigin();
  const limiter = loginLimiter();
  const keys = attemptKeys(CLOSING_PASSWORD_SCOPE, `${who.companyId}:${who.userId ?? ''}`, origin.addr).filter((k) => !k.includes(':addr:'));
  const weights = { [keys[keys.length - 1]]: GLOBAL_KEY_WEIGHT };
  const gate = limiter.begin(keys, Date.now(), weights);
  if (!gate.allowed) throw tooManyWrongGuesses(gate.retryAfterMs);
  try {
    const ok = await verify();
    if (ok) limiter.recordSuccess(keys.slice(0, -1));
    else limiter.recordFailure(keys, Date.now(), weights);
    return ok;
  } finally {
    gate.release();
  }
}
