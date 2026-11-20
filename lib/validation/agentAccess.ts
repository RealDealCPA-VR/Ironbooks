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
 */
import { z } from 'zod';
import { AREA_KEYS, type Area } from '@/lib/permissions/model';
import { AGENT_PRESETS, POLICY_SETTINGS, REQUEST_STATUSES, RISK_CLASSES, type SecretKind } from '@/lib/agent/operations/types';
import { parseDateInput, zUuid } from './helpers';

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

const AREA_ENUM = z.enum(AREA_KEYS as [Area, ...Area[]]);

/** Longest note a person can leave an agent, and longest typed secret. */
export const NOTE_MAX = 1000;
const SECRET_MAX = 1000;
/** Most requests one batch approval takes (each is still approved and reported on its own). */
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

/** A query value: blank counts as left out, so "?status=" is the same as no status. */
function queryValue<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
}

// ---------------------------------------------------------------------------
// Answering requests (POST /api/agent-requests/[id]/approve, /deny, /batch-approve)
// ---------------------------------------------------------------------------

/** GrantConstraints (lib/agent/operations/types.ts): every field the approver ticked must match. */
export const grantConstraintsSchema = z
  .object({
    entityIds: z.array(zUuid).max(200).optional(),
    accountIds: z.array(zUuid).max(200).optional(),
    maxAmount: zAmountText.optional(),
    dateFrom: zDay.optional(),
    dateTo: zDay.optional(),
    maxUses: z.number().int().min(1).max(10_000).optional(),
    maxCount: z.number().int().min(1).max(100_000).optional(),
  })
  .strict()
  .refine((c) => !c.dateFrom || !c.dateTo || c.dateFrom <= c.dateTo, {
    message: 'the first date must be on or before the last one',
    path: ['dateTo'],
  });

/** ApproveInput (lib/agent/contract.ts). Every field is optional: "Approve once" sends nothing. */
export const approveRequestSchema = z
  .object({
    /** Typed on the card, for this one run. Never stored, never echoed in an error. */
    secrets: z.record(z.enum(SECRET_KINDS), z.string().min(1, 'is empty').max(SECRET_MAX, 'is too long')).optional(),
    grant: z
      .object({
        minutes: z.number().int().min(1, 'must be at least 1 minute').max(GRANT_MINUTES_MAX, 'can be at most a day'),
        constraints: grantConstraintsSchema,
      })
      .strict()
      .nullish(),
    acceptStale: z.boolean().optional(),
    answers: z.record(z.string().min(1).max(100), z.unknown()).optional(),
    note: zNote,
  })
  .strict();

/** POST /api/agent-requests/[id]/deny { note? } */
export const denyRequestSchema = z.object({ note: zNote }).strict();

/** POST /api/agent-requests/batch-approve { ids } (asked twice is approved once). */
export const batchApproveSchema = z
  .object({
    ids: z
      .array(zUuid, { required_error: 'choose the requests to approve', invalid_type_error: 'must be a list of request ids' })
      .min(1, 'choose at least one request')
      .max(BATCH_APPROVE_MAX, `can be at most ${BATCH_APPROVE_MAX} requests at once`),
  })
  .strict()
  .transform((b) => ({ ids: [...new Set(b.ids)] }));

/** GET /api/agent-requests?status=&agentId=&limit= */
export const personRequestListQuerySchema = z.object({
  status: queryValue(z.enum([...REQUEST_STATUSES, 'all'] as const)),
  agentId: queryValue(zUuid),
  limit: queryValue(z.coerce.number().int().min(1).max(500)),
});

// ---------------------------------------------------------------------------
// The agent's own requests (GET /api/agent/requests, /api/agent/requests/[id])
// ---------------------------------------------------------------------------

/** GET /api/agent/requests?status=&limit= */
export const agentRequestListQuerySchema = z.object({
  status: queryValue(z.enum(REQUEST_STATUSES)),
  limit: queryValue(z.coerce.number().int().min(1).max(200)),
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
  .object({
    class: z.enum(RISK_CLASSES),
    area: AREA_ENUM.nullish().transform((v) => v ?? null),
    setting: z.enum(POLICY_SETTINGS),
  })
  .strict();

/** PATCH /api/agents/[id]: AgentPolicyInput (lib/agent/contract.ts). `overrides` replaces every stored one. */
export const agentPolicySchema = z
  .object({
    preset: z.enum(AGENT_PRESETS).optional(),
    overrides: z.array(policyOverrideSchema).max(RISK_CLASSES.length * (AREA_KEYS.length + 1)).optional(),
    bulkCap: z.number().int().min(1, 'must be at least 1').max(100_000).nullable().optional(),
    twoPersonOver: zAmountText.nullable().optional(),
    requestExpiryDays: z.number().int().min(1, 'must be at least 1 day').max(365, 'can be at most 365 days').optional(),
    folders: z.array(z.string().trim().min(1, 'is empty').max(1000)).max(50).optional(),
    notifyEmail: z.boolean().optional(),
  })
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
export const pauseAgentsSchema = z.object({ paused: z.boolean({ required_error: 'say paused: true or false' }) }).strict();

/** GET /api/agents/[id]/grants?live= (live only unless live=0 or false). */
export const agentGrantsQuerySchema = z.object({
  live: queryValue(z.enum(['1', '0', 'true', 'false'])),
});

/** GET /api/agents/[id]/activity?limit= (at most 200). */
export const agentActivityQuerySchema = z.object({
  limit: queryValue(z.coerce.number().int().min(1).max(200)),
});
