/**
 * Agent full access: Standing permission for agents (plan §4.4).
 * STUB: the signatures are the contract (lib/agent/contract.ts); the bodies are still to be written.
 */
import type { CreateGrant, ListGrants, LiveGrants, RevokeGrant, UseGrant } from '@/lib/agent/contract';

export const liveGrants: LiveGrants = async () => {
  throw new Error('liveGrants is not built yet.');
};

export const createGrant: CreateGrant = async () => {
  throw new Error('createGrant is not built yet.');
};

export const revokeGrant: RevokeGrant = async () => {
  throw new Error('revokeGrant is not built yet.');
};

export const useGrant: UseGrant = async () => {
  throw new Error('useGrant is not built yet.');
};

export const listGrants: ListGrants = async () => {
  throw new Error('listGrants is not built yet.');
};
