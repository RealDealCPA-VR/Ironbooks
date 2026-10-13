/**
 * Friendly errors — turns API/service failures into plain-language messages that say what
 * happened AND what to do next. Used centrally by `toastError` (components/ui.tsx) so every
 * page gets the same wording for the same problem.
 *
 * Mapping is keyed on the stable ServiceError code the API returns in its JSON body
 * (`{ error, code }` — see lib/services/_base.ts), falling back to the HTTP status for
 * routes that do not send a code. The server's own message is kept (it is usually specific,
 * e.g. "Invoice 1042 has payments applied") and the next step is added after it, except for
 * internal errors whose text is never useful to an end user.
 *
 * Pure module (no React/DOM) so it is unit-testable in the node test environment.
 */
import type { ServiceErrorCode } from '@/lib/services/_base';

export interface FriendlyError {
  /** Short headline, e.g. "That date is in a closed period". */
  title: string;
  /** What happened, in plain language (often the server's specific message). */
  message: string;
  /** What the user should do next. */
  nextStep: string;
  /** Resolved code (from the response body or inferred from status), when known. */
  code?: ServiceErrorCode | 'NETWORK' | 'FILE_LOCKED';
}

/** Minimal structural view of lib/client.ts ApiError (avoids a circular import). */
interface ApiErrorLike {
  name?: string;
  status: number;
  message: string;
  code?: string;
}

const KNOWN_CODES: readonly ServiceErrorCode[] = [
  'NOT_FOUND',
  'VALIDATION',
  'UNBALANCED',
  'FORBIDDEN',
  'CONFLICT',
  'PERIOD_CLOSED',
  'INTERNAL',
];

function isApiErrorLike(err: unknown): err is ApiErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as ApiErrorLike).status === 'number' &&
    typeof (err as ApiErrorLike).message === 'string'
  );
}

/** Infer a code from an HTTP status when the response body did not carry one. */
export function codeFromStatus(status: number): ServiceErrorCode | undefined {
  if (status === 400 || status === 422) return 'VALIDATION';
  if (status === 401 || status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status >= 500) return 'INTERNAL';
  return undefined;
}

/**
 * Make zod-style field paths readable: "lines.0.debit: must be ..." becomes
 * "Line 1 debit: must be ...", "customerId: Required" becomes "Customer: Required".
 */
export function humanizeFieldMessage(message: string): string {
  const m = /^([A-Za-z_][\w]*(?:\.\w+)*):\s*([\s\S]+)$/.exec(message);
  if (!m) return message;
  const [, path, rest] = m;
  const parts = path.split('.');
  const words: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (/^\d+$/.test(p)) {
      // Index into the previous collection: "lines.0" -> "Line 1".
      const prev = words.pop() ?? 'Item';
      const singular = prev.replace(/s$/i, '');
      words.push(`${singular} ${Number(p) + 1}`);
      continue;
    }
    const label = p
      .replace(/Id$/, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .toLowerCase();
    words.push(words.length === 0 ? label.charAt(0).toUpperCase() + label.slice(1) : label);
  }
  return `${words.join(' ')}: ${rest}`;
}

const FILE_LOCK_RE = /company file is locked/i;
const NETWORK_RE = /failed to fetch|networkerror|network request failed|load failed|fetch failed/i;

/**
 * Describe any thrown value in plain language. `fallback` is the action-specific message the
 * page would have shown before (e.g. "Failed to save invoice.") and is used when the error
 * carries no useful text.
 */
export function describeError(err: unknown, fallback = 'That didn’t work.'): FriendlyError {
  // Network failure: fetch() rejects with a TypeError before any response arrives.
  if (err instanceof TypeError && NETWORK_RE.test(err.message)) {
    return {
      code: 'NETWORK',
      title: 'Can’t reach BookKeeper',
      message: 'The app could not talk to its accounting engine, so nothing was saved.',
      nextStep: 'Wait a moment and try again. If it keeps happening, restart BookKeeper AI.',
    };
  }

  if (!isApiErrorLike(err)) {
    const msg = err instanceof Error && err.message ? err.message : fallback;
    return {
      title: 'Something went wrong',
      message: msg,
      nextStep: 'Try again. If it keeps happening, reload the page.',
    };
  }

  const serverMsg = (err.message || '').trim();
  const rawCode = err.code && (KNOWN_CODES as readonly string[]).includes(err.code)
    ? (err.code as ServiceErrorCode)
    : undefined;
  const code = rawCode ?? codeFromStatus(err.status);
  const specific = serverMsg && !/^internal server error\.?$/i.test(serverMsg) ? serverMsg : '';

  if (err.status === 403 && FILE_LOCK_RE.test(serverMsg)) {
    return {
      code: 'FILE_LOCKED',
      title: 'Your company file is locked',
      message: 'For your security the file was locked when the app restarted.',
      nextStep: 'Enter the company file password on the unlock screen to continue.',
    };
  }

  switch (code) {
    case 'UNBALANCED':
      return {
        code,
        title: 'Debits and credits don’t match',
        message: specific || 'This transaction is out of balance, so it was not saved.',
        nextStep:
          'Every transaction must balance: total debits must equal total credits. Adjust the amounts until the difference is 0.00, then save again.',
      };
    case 'PERIOD_CLOSED':
      return {
        code,
        title: 'That date is in a closed period',
        message:
          specific || 'The books are closed for this date, so the transaction was not saved.',
        nextStep:
          'Change the date to one after your closing date, or ask the company owner for the closing-date password (Settings → Closing Date).',
      };
    case 'FORBIDDEN':
      // Preferences feature switch (lib/featureGate.ts): not a permission problem.
      if (/is turned off for this company|are turned off for this company/.test(serverMsg)) {
        return {
          code,
          title: 'This feature is turned off',
          message: serverMsg,
          nextStep: 'Turn it on in Settings > Preferences, or ask an administrator to.',
        };
      }
      return {
        code,
        title: 'You don’t have permission to do that',
        message: specific || 'Your user role does not allow this action.',
        nextStep:
          'Ask the company owner or an admin to change your role, or sign in as a user who has access.',
      };
    case 'CONFLICT':
      return {
        code,
        title: 'This can’t be changed right now',
        message: specific || 'The record changed or is linked to other transactions.',
        nextStep:
          'Refresh the page to see the latest version. If it is linked to something else (for example, already paid or deposited), undo that first, then try again.',
      };
    case 'VALIDATION':
      return {
        code,
        title: 'Some information needs fixing',
        message: specific ? humanizeFieldMessage(specific) : 'Some fields are missing or invalid.',
        nextStep: 'Check the fields marked with * and try again.',
      };
    case 'NOT_FOUND':
      return {
        code,
        title: 'We couldn’t find that',
        message: specific || 'The record may have been deleted or voided.',
        nextStep: 'Refresh the page and try again — someone else may have changed it.',
      };
    case 'INTERNAL':
      return {
        code,
        title: 'Something went wrong',
        // Internal messages are developer-facing; never surface them verbatim.
        message: `${fallback} The action did not finish.`,
        nextStep:
          'Try again in a moment. If it keeps happening, run Admin → Data Integrity to check your books.',
      };
    default:
      return {
        title: 'Something went wrong',
        message: specific || fallback,
        nextStep: 'Try again. If it keeps happening, reload the page.',
      };
  }
}

/** One-line form ("message — next step") for places that can only show a string. */
export function friendlyErrorText(err: unknown, fallback?: string): string {
  const f = describeError(err, fallback);
  return `${f.message} ${f.nextStep}`;
}
