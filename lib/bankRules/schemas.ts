/**
 * Request-body schemas for the bank rules API (team bankrules). Values are validated again in
 * the services (lib/services/bankRules.ts) — these only reject malformed shapes early.
 */
import { z } from 'zod';
import { RULE_DIRECTIONS, RULE_FIELDS, RULE_MODES, RULE_OPERATORS } from './core';

const uuid = z.string().uuid();
const optUuid = z
  .union([uuid, z.literal(''), z.null()])
  .optional()
  .transform((v) => v || null);
const optText = z.string().max(255).nullable().optional();
const amount = z
  .union([z.string().max(20), z.number(), z.null()])
  .optional()
  .transform((v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim()));

export const splitSchema = z.object({
  accountId: uuid,
  classId: optUuid,
  percent: z.union([z.string().max(12), z.number()]).transform((v) => String(v).trim()),
});

export const ruleBodySchema = z.object({
  name: z.string().max(255),
  matchField: z.enum(RULE_FIELDS as unknown as [string, ...string[]]).optional(),
  matchOperator: z.enum(RULE_OPERATORS as unknown as [string, ...string[]]).optional(),
  matchValue: optText,
  bankAccountId: optUuid,
  direction: z.enum(RULE_DIRECTIONS as unknown as [string, ...string[]]).optional(),
  amountMin: amount,
  amountMax: amount,
  setAccountId: optUuid,
  setClassId: optUuid,
  setPayee: optText,
  setMemo: optText,
  splits: z.array(splitSchema).max(20).nullable().optional(),
  mode: z.enum(RULE_MODES as unknown as [string, ...string[]]).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
});

export const ruleUpdateSchema = ruleBodySchema.partial().extend({
  expectedUpdatedAt: z.string().max(40).nullable().optional(),
});

export const ruleTestSchema = ruleBodySchema.extend({
  id: uuid.nullable().optional(),
  name: z.string().max(255).optional().default(''),
  days: z.number().int().min(1).max(3650).optional(),
});

export const reorderSchema = z.object({ orderedIds: z.array(uuid).max(5000) });

export const offerActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('accept'),
    pattern: z.string().min(1).max(255),
    accountId: uuid,
    direction: z.enum(['in', 'out']),
    mode: z.enum(['suggest', 'auto']).optional(),
  }),
  z.object({ action: z.literal('dismiss'), pattern: z.string().min(1).max(255), accountId: uuid }),
]);

const bulkItemSchema = z.object({
  bankTransactionId: uuid,
  accountId: optUuid,
  classId: optUuid,
  payee: optText,
  memo: optText,
  splits: z.array(splitSchema).max(20).nullable().optional(),
  exchangeRate: z.string().max(30).nullable().optional(),
});

export const bulkAcceptSchema = z.union([
  z.object({
    bankAccountId: uuid,
    allHighConfidence: z.literal(true),
    minConfidence: z.number().min(50).max(100).optional(),
    exchangeRate: z.string().max(30).nullable().optional(),
  }),
  z.object({
    items: z.array(bulkItemSchema).min(1).max(1000),
    exchangeRate: z.string().max(30).nullable().optional(),
  }),
]);
