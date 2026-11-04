'use client';
/**
 * QuickBooks Enterprise permissions in the screens (prefsperms, PARITY K). Mounted once by
 * components/AppShell.tsx:
 *
 *  - <NoAccess /> replaces a page the signed-in role cannot view (its activity, e.g. Receive
 *    Payments, or its area) — the server refuses its data anyway; this says why in plain words.
 *  - useActivityButtons() greys out the page's New / Delete / Print / Email buttons when the role
 *    lacks that right on the page's activity (lib/permissions/buttonRights.ts), with a tooltip.
 *    Buttons inside `data-activity-skip` (removing an unsaved grid row) are left alone.
 *
 * COSMETIC: every API route is enforced on the server (lib/permissions/enforce.ts).
 */
import * as React from 'react';
import Link from 'next/link';
import { ShieldOff } from 'lucide-react';
import { Card } from '@/components/ui';
import { pageAccessFor } from '@/lib/permissions/routes';
import { canSeePage, hasActivityRights, type PermissionMap } from '@/lib/permissions/pageAccess';
import { buttonRight, missingRightTitle, rightAllowed } from '@/lib/permissions/buttonRights';
import { activityLabel } from '@/lib/permissions/activities';

/** True when the role may not open this page (unknown permissions → false). */
export function pageBlocked(pathname: string, permissions: PermissionMap): boolean {
  return Boolean(permissions) && !canSeePage(pathname, permissions);
}

export function NoAccess({ pathname }: { pathname: string }) {
  const need = pageAccessFor(pathname);
  const what = need?.activities?.length ? need.activities.map(activityLabel).join(' or ') : null;
  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <Card className="mx-auto mt-12 max-w-lg p-8 text-center">
        <ShieldOff className="mx-auto mb-3 h-10 w-10 text-navy/30" aria-hidden="true" />
        <h1 className="text-xl font-bold text-navy">You don&apos;t have access to this page</h1>
        <p className="mt-2 text-sm text-navy/60">
          {what ? `Your role does not include ${what}.` : 'Your role does not include this part of the company file.'} Ask
          your administrator to change your role under Users &amp; Roles.
        </p>
        <Link href="/dashboard" className="mt-5 inline-block text-sm font-semibold text-electric hover:underline">
          Go to Home
        </Link>
      </Card>
    </main>
  );
}

const MARK = 'data-activity-locked';

/** Grey out the page's buttons its activity does not allow (re-applied as the page changes). */
export function useActivityButtons(pathname: string, permissions: PermissionMap): void {
  React.useEffect(() => {
    if (!permissions || !hasActivityRights(permissions)) return;
    const need = pageAccessFor(pathname.split('?')[0]);
    const activities = need?.activities;
    if (!activities?.length) return;
    const allowed = (right: string) => rightAllowed(activities, permissions, right);
    const root = document.querySelector('main') ?? document.body;
    const apply = () => {
      for (const el of Array.from(root.querySelectorAll<HTMLButtonElement>('button'))) {
        if (el.closest('[role="dialog"]')) continue; // dialogs belong to whatever opened them
        if (el.closest('header') || el.closest('nav')) continue; // the shell's own controls
        // Editing an unsaved grid (removing a typed row) is not the Delete right on saved records.
        if (el.closest('[data-activity-skip]')) continue;
        const right = buttonRight(el.getAttribute('aria-label') || el.textContent, el.getAttribute('data-shortcut'));
        if (!right || allowed(right)) continue;
        // Only an enabled button is touched, so re-applying never loops (React re-enabling it on
        // a re-render is seen through the 'disabled' attribute and greyed out again).
        if (!el.disabled) {
          el.disabled = true;
          el.setAttribute(MARK, el.getAttribute('title') ?? '');
          el.title = missingRightTitle(right);
        }
      }
    };
    apply();
    const obs = new MutationObserver(() => apply());
    obs.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    return () => {
      obs.disconnect();
      // Leaving the page (or new rights): give back any button this page greyed out that is
      // still on screen (the shell's own buttons outlive the page).
      for (const el of Array.from(root.querySelectorAll<HTMLButtonElement>(`button[${MARK}]`))) {
        const title = el.getAttribute(MARK);
        el.disabled = false;
        el.removeAttribute(MARK);
        if (title) el.setAttribute('title', title);
        else el.removeAttribute('title');
      }
    };
  }, [pathname, permissions]);
}
