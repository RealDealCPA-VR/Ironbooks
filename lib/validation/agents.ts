/**
 * Agent access request schemas (AGENT_ACCESS.md). Routes: app/api/agents/**.
 */
import { z } from 'zod';
import { AGENT_MODES } from '@/lib/permissions/agentAccess';

export const createAgentSchema = z
  .object({
    name: z.string().trim().min(1, 'is required').max(100),
    roleKeys: z.array(z.string().min(1).max(64)).min(1, 'choose at least one role').max(30),
    mode: z.enum(AGENT_MODES),
    unattended: z.boolean().optional(),
  })
  .strict();
