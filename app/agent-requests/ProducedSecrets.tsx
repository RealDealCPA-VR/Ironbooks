'use client';
/**
 * Agent requests: a secret an approved run produced (a reset user's temporary password, a new
 * recovery key), shown to the approver once (plan 5.8).
 *
 * The agent's answer never holds it, and Ironbooks keeps no copy. It lives only in the state of the
 * card or results dialog that shows it, so it is gone when that closes; nothing here stores, logs
 * or sends it anywhere but the clipboard, and only when the person presses Copy.
 *
 * Only the heading line is announced (role="alert"): the value itself stays out of every live
 * region, so a screen reader does not read a password aloud the moment it appears. The person
 * moves to it, or presses Copy, when they are ready.
 */
import { Copy, KeyRound } from 'lucide-react';
import { Button, toast } from '@/components/ui';
import type { ProducedSecret } from '@/lib/agent/contract';
import { plain } from './words';

/** The words every produced secret is shown with. */
export const NOT_SHOWN_AGAIN = 'This will not be shown again';

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.', 'success');
  } catch {
    toast('Could not copy. Select the text and copy it yourself.', 'danger');
  }
}

export default function ProducedSecrets({ produced }: { produced: ProducedSecret[] }) {
  if (produced.length === 0) return null;
  return (
    <div data-produced-secrets="" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <div role="alert" className="flex items-center gap-1.5 font-semibold">
        <KeyRound className="h-4 w-4" aria-hidden="true" /> Copy {produced.length === 1 ? 'this' : 'these'} now. {NOT_SHOWN_AGAIN}.
      </div>
      <div className="mt-2 space-y-2">
        {produced.map((p, i) => (
          <div key={i}>
            <div className="text-xs font-medium">{plain(p.label)}</div>
            <div className="mt-0.5 flex items-center gap-2">
              <code data-produced-secret="" className="min-w-0 flex-1 select-all break-all rounded border border-amber-200 bg-white px-2 py-1 font-mono text-sm text-navy">
                {p.value}
              </code>
              <Button size="sm" variant="secondary" onClick={() => copy(p.value)} aria-label={`Copy ${plain(p.label)}`}>
                <Copy className="h-4 w-4" aria-hidden="true" /> Copy
              </Button>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs">Ironbooks keeps no copy, and the agent never sees it. Keep it somewhere safe, or give it to the person it is for.</p>
    </div>
  );
}
