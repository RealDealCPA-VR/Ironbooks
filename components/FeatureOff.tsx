'use client';
/**
 * Shown instead of a page whose feature is turned off in Preferences (lib/preferences.ts
 * FEATURE_GATES) — QB removes those forms from its menus; someone arriving by a bookmark or an
 * old link gets a plain explanation and the way to turn it back on.
 */
import Link from 'next/link';
import { ToggleLeft } from 'lucide-react';
import { Card } from '@/components/ui';
import { featureOffMessage, type FeatureGate } from '@/lib/preferences';

export default function FeatureOff({ gate }: { gate: FeatureGate }) {
  return (
    <div className="p-6 lg:p-10 flex justify-center">
      <Card className="max-w-lg w-full p-8 text-center">
        <ToggleLeft className="mx-auto h-10 w-10 text-navy/30" aria-hidden="true" />
        <h1 className="mt-3 text-xl font-extrabold text-navy">{gate.label} turned off</h1>
        <p className="mt-2 text-sm text-navy/60" role="status">
          {featureOffMessage(gate)}
        </p>
        <p className="mt-1 text-xs text-navy/40">Anything you already entered is kept and still shows in your reports.</p>
        <div className="mt-5 flex justify-center gap-3">
          <Link
            href="/settings"
            className="rounded-lg bg-electric px-4 py-2 text-sm font-semibold text-white hover:bg-electric/90 outline-none focus-visible:ring-2 focus-visible:ring-electric/50"
          >
            Open Preferences
          </Link>
          <Link
            href="/dashboard"
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-navy hover:bg-slate-50 outline-none focus-visible:ring-2 focus-visible:ring-electric/50"
          >
            Go to Home
          </Link>
        </div>
      </Card>
    </div>
  );
}
