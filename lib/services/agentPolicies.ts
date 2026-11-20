/**
 * Agent full access: An agent's policy as stored: preset, overrides, limits, pause (plan §4.1, §7.1).
 * STUB: the signatures are the contract (lib/agent/contract.ts); the bodies are still to be written.
 */
import type { ServiceContext } from './_base';
import type { AgentActivityRow, AgentDetail } from '@/lib/agent/contract';
import type { AgentCeiling, GetAgentPolicyView, LoadAgentPolicy, PauseAgent, PauseAllAgents, SaveAgentPolicy } from '@/lib/agent/contract';

export const loadAgentPolicy: LoadAgentPolicy = async () => {
  throw new Error('loadAgentPolicy is not built yet.');
};

export const getAgentPolicyView: GetAgentPolicyView = async () => {
  throw new Error('getAgentPolicyView is not built yet.');
};

export const saveAgentPolicy: SaveAgentPolicy = async () => {
  throw new Error('saveAgentPolicy is not built yet.');
};

export const pauseAgent: PauseAgent = async () => {
  throw new Error('pauseAgent is not built yet.');
};

export const pauseAllAgents: PauseAllAgents = async () => {
  throw new Error('pauseAllAgents is not built yet.');
};

export const agentCeiling: AgentCeiling = async () => {
  throw new Error('agentCeiling is not built yet.');
};

/** The Agents tab's detail page. */
export async function getAgentDetail(_ctx: ServiceContext, _agentId: string): Promise<AgentDetail> {
  throw new Error('getAgentDetail is not built yet.');
}

/** Its last operations and requests, newest first (at most 200). */
export async function listAgentActivity(_ctx: ServiceContext, _agentId: string, _limit = 200): Promise<AgentActivityRow[]> {
  throw new Error('listAgentActivity is not built yet.');
}
