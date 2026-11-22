/**
 * Agent access request schemas (AGENT_ACCESS.md). Routes: app/api/agents/**. Refusals are in plain
 * words, as in lib/validation/agentAccess.ts (plainObjectErrors).
 */
import { z } from 'zod';
import { AGENT_MODES } from '@/lib/permissions/agentAccess';
import { AGENT_PRESETS } from '@/lib/agent/operations/types';
import { plainObjectErrors } from './agentAccess';

/**
 * POST /api/agents. Any role may be chosen, Admin included (D1): the service checks the roles
 * exist. `preset` is what the agent may do without asking; `mode` is the older form of the same
 * choice. Left out, the preset comes from the mode, or is "Ask for every change" (D2). Sent
 * together, the mode must be the preset's own (lib/services/agents.ts refuses a mismatch).
 */
export const createAgentSchema = z
  .object(
    {
      name: z.string({ required_error: 'is required', invalid_type_error: 'must be text' }).trim().min(1, 'is required').max(100, 'can be at most 100 characters'),
      roleKeys: z
        .array(z.string({ invalid_type_error: 'must be a role' }).min(1, 'names no role').max(64, 'names a role Ironbooks does not have'), {
          required_error: 'choose at least one role',
          invalid_type_error: 'must be a list of roles',
        })
        .min(1, 'choose at least one role')
        .max(30, 'can be at most 30 roles'),
      preset: z.enum(AGENT_PRESETS, { errorMap: () => ({ message: `must be one of: ${AGENT_PRESETS.join(', ')}` }) }).optional(),
      mode: z.enum(AGENT_MODES, { errorMap: () => ({ message: `must be one of: ${AGENT_MODES.join(', ')}` }) }).optional(),
      unattended: z.boolean({ invalid_type_error: 'must be true or false' }).optional(),
    },
    { errorMap: plainObjectErrors },
  )
  .strict();
