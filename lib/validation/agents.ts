/**
 * Agent access request schemas (AGENT_ACCESS.md). Routes: app/api/agents/**.
 */
import { z } from 'zod';
import { AGENT_MODES } from '@/lib/permissions/agentAccess';
import { AGENT_PRESETS } from '@/lib/agent/operations/types';

/**
 * POST /api/agents. Any role may be chosen, Admin included (D1): the service checks the roles
 * exist. `preset` is what the agent may do without asking; `mode` is the older form of the same
 * choice. Left out, the preset comes from the mode, or is "Ask for every change" (D2). Sent
 * together, the mode must be the preset's own (lib/services/agents.ts refuses a mismatch).
 */
export const createAgentSchema = z
  .object({
    name: z.string().trim().min(1, 'is required').max(100),
    roleKeys: z.array(z.string().min(1).max(64)).min(1, 'choose at least one role').max(30),
    preset: z.enum(AGENT_PRESETS).optional(),
    mode: z.enum(AGENT_MODES).optional(),
    unattended: z.boolean().optional(),
  })
  .strict();
