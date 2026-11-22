/**
 * Agent full access: request schemas of the HTTP API in lib/agent/contract.ts section 11. The
 * person's window answers agents' requests and manages agents (app/api/agent-requests/**,
 * app/api/agent-grants/**, app/api/agents/**); an agent reads its own requests
 * (app/api/agent/requests/**).
 *
 * These check the shape only. Who may approve what, how long a standing permission may last and
 * which policy cells can be Allow are decided by the services (lib/services/agentRequests.ts,
 * agentGrants.ts, agentPolicies.ts), which have the last word. Making an agent (POST /api/agents)
 * keeps its schema in lib/validation/agents.ts.
 *
 * What they answer is read by a person (or an agent), so every refusal is in plain words: a field
 * the request does not take is named, a choice lists what it may be, never zod's own
 * "Unrecognized key(s)" or "Invalid enum value".
 */
import { z } from 'zod';
import { AREA_KEYS, type Area } from '@/lib/permissions/model';
import { AGENT_PRESETS, POLICY_SETTINGS, REQUEST_STATUSES, RISK_CLASSES, type SecretKind } from '@/lib/agent/operations/types';
import { parseDateInput } from './helpers';

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

/**
 * Every secret kind an approver may type on a card. A Record so that a kind added to
 * lib/agent/operations/types.ts fails to compile here until it is listed (types.ts has no list).
 */
const SECRET_KIND_SET: Record<SecretKind, true> = {
  closing_password: true,
  file_password: true,
  backup_password: true,
  archive_credentials: true,
  new_user_password: true,
  mail_password: true,
  portal_password: true,
  recovery_key: true,
  file_key: true,
  capability_link: true,
};
export const SECRET_KINDS = Object.keys(SECRET_KIND_SET) as [SecretKind, ...SecretKind[]];

/** Most field names a refusal of unknown fields names; each is cut short (they are the caller's text). */
const UNKNOWN_SHOWN = 3;
const UNKNOWN_NAME_MAX = 40;

/**
 * The plain words for an object's own refusals. A field it does not take is named ("Ironbooks does
 * not take "approveEverything" here."), and a value that is not an object at all says to reload:
 * the window builds these bodies, so a wrong shape means the page is older than the server.
 */
export const plainObjectErrors: z.ZodErrorMap = (issue, ctx) => {
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    const names = issue.keys.slice(0, UNKNOWN_SHOWN).map((k) => `"${k.slice(0, UNKNOWN_NAME_MAX)}"`);
    const more = issue.keys.length > UNKNOWN_SHOWN ? ` and ${issue.keys.length - UNKNOWN_SHOWN} more` : '';
    const it = issue.keys.length > 1 ? 'them' : 'it';
    return { message: `Ironbooks does not take ${names.join(', ')}${more} here. Leave ${it} out and try again.` };
  }
  if (issue.code === z.ZodIssueCode.invalid_type) {
    return { message: issue.received === 'undefined' ? 'is required' : 'is not in the form Ironbooks expects. Reload the page and try again.' };
  }
  return { message: ctx.defaultError };
};

/** One of a fixed list of words, refused in plain words with the list. */
function zOneOf<T extends string>(values: readonly [T, ...T[]]) {
  return z.enum(values as [T, ...T[]], { errorMap: () => ({ message: `must be one of: ${values.join(', ')}` }) });
}

const AREA_ENUM = zOneOf(AREA_KEYS as [Area, ...Area[]]);

/** The id of a record (lib/validation/helpers.ts zUuid), refused in plain words. */
const zId = z
  .string({ invalid_type_error: 'must be the id of a record, as Ironbooks gives it' })
  .uuid('must be the id of a record, as Ironbooks gives it')
  .describe('Id (a uuid) of an existing record.');

/** Longest note a person can leave an agent, and longest typed secret. */
export const NOTE_MAX = 1000;
const SECRET_MAX = 1000;
/**
 * Most requests one batch approval takes (each is still approved and reported on its own), the one
 * number for it: POST /api/agent-requests/batch-approve refuses more through batchApproveSchema,
 * the service (lib/services/agentRequests.ts batchApprove) imports it from here, and so does the
 * approval center (app/agent-requests/words.ts BATCH_MAX).
 */
export const BATCH_APPROVE_MAX = 100;
/** Longest standing permission the form can ask for; the service holds it to the class's own limit. */
const GRANT_MINUTES_MAX = 24 * 60;

/** An amount as decimal text ("5000.00"), above zero. A number is accepted and turned into text. */
const zAmountText = z
  .union([z.string(), z.number()], { errorMap: () => ({ message: 'must be an amount, like 5000 or 5000.00' }) })
  .transform((v) => (typeof v === 'number' ? String(v) : v.trim()))
  .refine((s) => /^\d+(\.\d{1,2})?$/.test(s) && Number(s) > 0, 'must be an amount above zero, like 5000 or 5000.00');

/** A calendar day ("2026-03-31"), kept as text. */
const zDay = z
  .string({ invalid_type_error: 'must be a date like 2026-03-31' })
  .trim()
  .refine((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && parseDateInput(s) !== null, 'must be a real date like 2026-03-31');

/** A note to the agent: trimmed, blank means none. */
const zNote = z
  .string({ invalid_type_error: 'must be text' })
  .trim()
  .max(NOTE_MAX, `can be at most ${NOTE_MAX} characters`)
  .nullish()
  .transform((v) => (v ? v : null));

/** A whole number from min to max, in plain words. */
function zWhole(min: number, max: number, unit: string) {
  return z
    .number({ invalid_type_error: `must be a whole number of ${unit}` })
    .int(`must be a whole number of ${unit}`)
    .min(min, `must be at least ${min}`)
    .max(max, `can be at most ${max}`);
}

/** A query value: blank counts as left out, so "?status=" is the same as no status. */
function queryValue<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
}

/** A whole number in a query ("?limit=50"), from 1 to max. */
function queryLimit(max: number) {
  return queryValue(
    z.coerce
      .number({ invalid_type_error: 'must be a number' })
      .int('must be a whole number')
      .min(1, 'must be at least 1')
      .max(max, `can be at most ${max}`),
  );
}

// ---------------------------------------------------------------------------
// Answering requests (POST /api/agent-requests/[id]/approve, /deny, /batch-approve)
// ---------------------------------------------------------------------------

/** GrantConstraints (lib/agent/operations/types.ts): every field the approver ticked must match. */
export const grantConstraintsSchema = z
  .object(
    {
      entityIds: z.array(zId, { invalid_type_error: 'must be a list of record ids' }).max(200, 'can name at most 200 records').optional(),
      accountIds: z.array(zId, { invalid_type_error: 'must be a list of account ids' }).max(200, 'can name at most 200 accounts').optional(),
      maxAmount: zAmountText.optional(),
      dateFrom: zDay.optional(),
      dateTo: zDay.optional(),
      maxUses: zWhole(1, 10_000, 'uses').optional(),
      maxCount: zWhole(1, 100_000, 'records').optional(),
    },
    { errorMap: plainObjectErrors },
  )
  .strict()
  .refine((c) => !c.dateFrom || !c.dateTo || c.dateFrom <= c.dateTo, {
    message: 'the first date must be on or before the last one',
    path: ['dateTo'],
  });

/**
 * What the approver typed on the card, by kind. A box left empty is the same as one not sent and is
 * dropped here: a secret the route treats as optional (ApprovalNeeds.optionalSecrets, wave 4: the
 * sign-in of another company file for a restore, which a backup of this same file does not need)
 * may be left empty, and the run goes ahead without it. Which secrets a request cannot do without
 * is the request's, not the body's, and the service judges it (lib/services/agentRequests.ts
 * checkTypedSecrets; what it covers is in app/api/agent-requests/[id]/approve/route.ts). A typed
 * value is kept exactly as typed, spaces and all, and is never echoed in a refusal (only the kind's
 * name is).
 */
const zTypedSecrets = z
  .record(
    z.enum(SECRET_KINDS, { errorMap: () => ({ message: 'is not something an approval card asks you to type' }) }),
    z.string({ invalid_type_error: 'must be text' }).max(SECRET_MAX, 'is too long'),
    { errorMap: plainObjectErrors },
  )
  .transform((typed) => {
    const out: Partial<Record<SecretKind, string>> = {};
    for (const [kind, value] of Object.entries(typed) as Array<[SecretKind, string | undefined]>) {
      if (typeof value === 'string' && value.length > 0) out[kind] = value;
    }
    return out;
  });

/** ApproveInput (lib/agent/contract.ts). Every field is optional: "Approve once" sends nothing. */
export const approveRequestSchema = z
  .object(
    {
      /** Typed on the card, for this one run. Never stored, never echoed in an error. */
      secrets: zTypedSecrets.optional(),
      grant: z
        .object(
          {
            minutes: z
              .number({ invalid_type_error: 'must be a whole number of minutes', required_error: 'say how many minutes it lasts' })
              .int('must be a whole number of minutes')
              .min(1, 'must be at least 1 minute')
              .max(GRANT_MINUTES_MAX, 'can be at most a day'),
            constraints: grantConstraintsSchema,
          },
          { errorMap: plainObjectErrors },
        )
        .strict()
        .nullish(),
      acceptStale: z.boolean({ invalid_type_error: 'must be true or false' }).optional(),
      answers: z
        .record(z.string().min(1, 'names no question').max(100, 'names a question Ironbooks does not know'), z.unknown(), {
          errorMap: plainObjectErrors,
        })
        .optional(),
      note: zNote,
    },
    { errorMap: plainObjectErrors },
  )
  .strict();

/** POST /api/agent-requests/[id]/deny { note? } */
export const denyRequestSchema = z.object({ note: zNote }, { errorMap: plainObjectErrors }).strict();

/** POST /api/agent-requests/batch-approve { ids } (asked twice is approved once). */
export const batchApproveSchema = z
  .object(
    {
      ids: z
        .array(zId, { required_error: 'choose the requests to approve', invalid_type_error: 'must be a list of request ids' })
        .min(1, 'choose at least one request')
        .max(BATCH_APPROVE_MAX, `can be at most ${BATCH_APPROVE_MAX} requests at once`),
    },
    { errorMap: plainObjectErrors },
  )
  .strict()
  .transform((b) => ({ ids: [...new Set(b.ids)] }));

/** GET /api/agent-requests?status=&agentId=&limit= */
export const personRequestListQuerySchema = z.object({
  status: queryValue(zOneOf([...REQUEST_STATUSES, 'all'] as const)),
  agentId: queryValue(zId),
  limit: queryLimit(500),
});

// ---------------------------------------------------------------------------
// The agent's own requests (GET /api/agent/requests, /api/agent/requests/[id])
// ---------------------------------------------------------------------------

/** GET /api/agent/requests?status=&limit= */
export const agentRequestListQuerySchema = z.object({
  status: queryValue(zOneOf(REQUEST_STATUSES)),
  limit: queryLimit(200),
});

/**
 * GET /api/agent/requests/[id]?wait=<seconds>. Any whole number of seconds is accepted; the route
 * waits at most WAIT_MAX_SECONDS (lib/agent/contract.ts) however many are asked for.
 */
export const agentRequestWaitQuerySchema = z.object({
  wait: queryValue(z.coerce.number({ invalid_type_error: 'must be a number of seconds' }).int('must be whole seconds').min(0, 'cannot be negative')),
});

// ---------------------------------------------------------------------------
// Managing agents (app/api/agents/**, app/api/agent-grants/**)
// ---------------------------------------------------------------------------

/** One Allow / Ask / Never cell of the policy grid, for a class, in one area or everywhere (null). */
export const policyOverrideSchema = z
  .object(
    {
      class: zOneOf(RISK_CLASSES),
      area: AREA_ENUM.nullish().transform((v) => v ?? null),
      setting: zOneOf(POLICY_SETTINGS),
    },
    { errorMap: plainObjectErrors },
  )
  .strict();

/** PATCH /api/agents/[id]: AgentPolicyInput (lib/agent/contract.ts). `overrides` replaces every stored one. */
export const agentPolicySchema = z
  .object(
    {
      preset: zOneOf(AGENT_PRESETS).optional(),
      overrides: z
        .array(policyOverrideSchema, { invalid_type_error: 'must be a list of settings' })
        .max(RISK_CLASSES.length * (AREA_KEYS.length + 1), 'has more settings than the grid has cells')
        .optional(),
      bulkCap: zWhole(1, 100_000, 'records').nullable().optional(),
      twoPersonOver: zAmountText.nullable().optional(),
      requestExpiryDays: z
        .number({ invalid_type_error: 'must be a whole number of days' })
        .int('must be a whole number of days')
        .min(1, 'must be at least 1 day')
        .max(365, 'can be at most 365 days')
        .optional(),
      folders: z
        .array(z.string({ invalid_type_error: 'must be a folder path' }).trim().min(1, 'is empty').max(1000, 'is too long'), {
          invalid_type_error: 'must be a list of folders',
        })
        .max(50, 'can be at most 50 folders')
        .optional(),
      notifyEmail: z.boolean({ invalid_type_error: 'must be true or false' }).optional(),
    },
    { errorMap: plainObjectErrors },
  )
  .strict()
  .superRefine((b, ctx) => {
    const seen = new Set<string>();
    for (const [i, o] of (b.overrides ?? []).entries()) {
      const key = `${o.class}/${o.area ?? ''}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['overrides', i], message: 'names the same class and area twice' });
      }
      seen.add(key);
    }
  });

/** POST /api/agents/[id]/pause and POST /api/agents/pause-all: { paused } */
export const pauseAgentsSchema = z
  .object(
    { paused: z.boolean({ required_error: 'say paused: true or false', invalid_type_error: 'say paused: true or false' }) },
    { errorMap: plainObjectErrors },
  )
  .strict();

/** GET /api/agents/[id]/grants?live= (live only unless live=0 or false). */
export const agentGrantsQuerySchema = z.object({
  live: queryValue(zOneOf(['1', '0', 'true', 'false'] as const)),
});

/** GET /api/agents/[id]/activity?limit= (at most 200). */
export const agentActivityQuerySchema = z.object({
  limit: queryLimit(200),
});
