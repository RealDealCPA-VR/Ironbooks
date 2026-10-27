/**
 * Which activity RIGHT a page button needs, read from its label (prefsperms, PARITY K) — the way
 * QuickBooks greys out New / Delete / Print when a role lacks them. Used by
 * components/ActivityGuard.tsx on the page's own activity (lib/permissions/routeActivities.ts).
 *
 * Deliberately narrow: only labels whose meaning is certain. "New …" creates, "Delete …"
 * deletes, "Print …" / "Email …" / "Send …" / "PDF" print. Save / Void / Edit are left alone
 * (they can mean create or modify); the server refuses whatever the role does not allow.
 * Pure (no DOM): tested in lib/permissions/pageAccess.test.ts.
 */
import { activityDef, supportedActions, type ActivityAction } from './activities';

const NEW = /^(\+\s*)?new\b/i;
const DELETE = /^delete\b/i;
const PRINT = /^(print|re-?print|email|e-mail|send|save as pdf|download pdf|pdf)\b/i;

export function buttonRight(label: string | null | undefined, shortcut?: string | null): ActivityAction | null {
  if (shortcut === 'new') return 'create';
  const t = (label ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (NEW.test(t)) return 'create';
  if (DELETE.test(t)) return 'delete';
  if (PRINT.test(t)) return 'print';
  return null;
}

/**
 * May a button needing `right` be used on a page of these activities? Only a right one of the
 * page's activities really HAS can be missing: a "Print" button on a page whose activity has no
 * Print right (Sales Tax Reports, Ask the AI Assistant) prints through some other activity, which
 * the server checks — greying it out would lock everybody out, Admins included.
 */
export function rightAllowed(
  activities: readonly string[],
  permissions: Partial<Record<string, readonly string[]>>,
  right: string,
): boolean {
  const having = activities.filter((k) => {
    const def = activityDef(k);
    return def ? supportedActions(def).includes(right as ActivityAction) : false;
  });
  if (!having.length) return true;
  return having.some((k) => permissions[k]?.includes(right) ?? false);
}

/** Tooltip on a button the role cannot use. */
export function missingRightTitle(right: ActivityAction): string {
  const verb = right === 'create' ? 'create' : right === 'delete' ? 'delete' : right === 'print' ? 'print or email' : right;
  return `Your role cannot ${verb} here. Ask your administrator for access.`;
}
