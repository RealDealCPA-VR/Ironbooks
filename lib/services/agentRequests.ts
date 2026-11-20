/**
 * Agent full access: Permission requests: what an agent asked a person to approve (plan §4.3, §7.2, §7.4).
 * STUB: the signatures are the contract (lib/agent/contract.ts); the bodies are still to be written.
 */
import type { ApproveAgentRequest, BatchApprove, CancelAgentRequest, CreateAgentRequest, DenyAgentRequest, ExpireRequests, ListRequestsForAgent, ListRequestsForPerson, PendingCountForPerson, RequestForAgent, RequestForPerson, WaitForDecision } from '@/lib/agent/contract';

export const createAgentRequest: CreateAgentRequest = async () => {
  throw new Error('createAgentRequest is not built yet.');
};

export const requestForAgent: RequestForAgent = async () => {
  throw new Error('requestForAgent is not built yet.');
};

export const listRequestsForAgent: ListRequestsForAgent = async () => {
  throw new Error('listRequestsForAgent is not built yet.');
};

export const cancelAgentRequest: CancelAgentRequest = async () => {
  throw new Error('cancelAgentRequest is not built yet.');
};

export const waitForDecision: WaitForDecision = async () => {
  throw new Error('waitForDecision is not built yet.');
};

export const listRequestsForPerson: ListRequestsForPerson = async () => {
  throw new Error('listRequestsForPerson is not built yet.');
};

export const requestForPerson: RequestForPerson = async () => {
  throw new Error('requestForPerson is not built yet.');
};

export const pendingCountForPerson: PendingCountForPerson = async () => {
  throw new Error('pendingCountForPerson is not built yet.');
};

export const approveAgentRequest: ApproveAgentRequest = async () => {
  throw new Error('approveAgentRequest is not built yet.');
};

export const denyAgentRequest: DenyAgentRequest = async () => {
  throw new Error('denyAgentRequest is not built yet.');
};

export const batchApprove: BatchApprove = async () => {
  throw new Error('batchApprove is not built yet.');
};

export const expireRequests: ExpireRequests = async () => {
  throw new Error('expireRequests is not built yet.');
};
