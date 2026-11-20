/**
 * Agent requests: tell the title-bar and menu badge (components/AgentRequestsBadge.tsx) that a
 * request was just answered here, so its count changes at once instead of at its next look, up to
 * 20 seconds later.
 */
import { AGENT_REQUESTS_CHANGED_EVENT } from '@/components/AgentRequestsBadge';

export function requestsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(AGENT_REQUESTS_CHANGED_EVENT));
}
