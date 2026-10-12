/**
 * Shared zod field helpers + the standard 400 body builder.
 * Domain schema files import from here (NOT from ./index) to avoid cycles.
 * See lib/validation/index.ts for the full route-adoption pattern.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared field helpers
// ---------------------------------------------------------------------------

/** UUID string (all entity ids in the app are uuids). */
export const zUuid = z.string().uuid('must be a valid id (uuid)');

const MONEY_RE = /^-?\d+(\.\d{1,2})?$/;
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

function decimalString(v: string | number): string {
  return typeof v === 'number' ? String(v) : v.trim();
}

/** Money amount: decimal string or number with at most 2 decimal places. */
export const zMoney = z
  .union([z.string(), z.number()], {
    errorMap: () => ({ message: 'must be a decimal amount (string or number)' }),
  })
  .superRefine((v, ctx) => {
    if (!MONEY_RE.test(decimalString(v))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${v}" is not a valid money amount (decimal, max 2 decimal places)`,
      });
    }
  });

/** Money amount that must be strictly greater than zero. */
export const zMoneyPositive = zMoney.refine((v) => Number(v) > 0, {
  message: 'must be greater than zero',
});

/** Decimal of any precision (quantities, rates, exchange rates). */
export const zDecimal = z
  .union([z.string(), z.number()], {
    errorMap: () => ({ message: 'must be a decimal value (string or number)' }),
  })
  .superRefine((v, ctx) => {
    if (!DECIMAL_RE.test(decimalString(v))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${v}" is not a valid decimal value`,
      });
    }
  });

/** Decimal that must be strictly greater than zero. */
export const zDecimalPositive = zDecimal.refine((v) => Number(v) > 0, {
  message: 'must be greater than zero',
});

/**
 * User-typed document number (alphanumeric, e.g. "INV-1001"; QB "Invoice #"). Blank / null =
 * let the service pick the next number. Length and control characters are re-checked in
 * lib/services/docNumbers.ts normalizeDocNumber.
 */
export const zDocNumber = z
  .string({ invalid_type_error: 'must be text' })
  .max(50, 'can be at most 50 characters')
  .nullish();

/** ISO date string -> Date. Rejects unparseable dates. */
export const zDate = z
  .string({
    required_error: 'date is required (ISO string)',
    invalid_type_error: 'must be an ISO date string',
  })
  .transform((s, ctx) => {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${s}" is not a valid ISO date` });
      return z.NEVER;
    }
    return d;
  });

/** Non-empty array of document/posting lines. */
export function zLines<T extends z.ZodTypeAny>(line: T) {
  return z
    .array(line, {
      required_error: 'lines are required',
      invalid_type_error: 'lines must be an array',
    })
    .min(1, 'At least one line is required.');
}

// ---------------------------------------------------------------------------
// 400 response body
// ---------------------------------------------------------------------------

export interface ValidationErrorBody {
  /** Human-readable summary (first issue) — what existing UIs toast. */
  error: string;
  code: 'VALIDATION';
  /** zod flatten() fieldErrors — top-level field name -> messages. */
  fields: Record<string, string[] | undefined>;
  /** Every issue with its full dotted path (covers nested line errors). */
  issues: Array<{ path: string; message: string }>;
}

/** Convert a ZodError into the standard 400 JSON body. */
export function zodErrorBody(error: z.ZodError): ValidationErrorBody {
  const issues = error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  const first = issues[0];
  return {
    error: first
      ? first.path
        ? `${first.path}: ${first.message}`
        : first.message
      : 'Invalid request body.',
    code: 'VALIDATION',
    fields: error.flatten().fieldErrors as Record<string, string[] | undefined>,
    issues,
  };
}
