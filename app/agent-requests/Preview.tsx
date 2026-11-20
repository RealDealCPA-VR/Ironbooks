'use client';
/**
 * Agent requests: what a request does, as Ironbooks worked it out (plan 4.3, 7.2). The ledger
 * entries it would post, the record changes field by field, what would leave the computer (emails,
 * saved files, printing, calls to other computers), the warnings a person would have seen, and what
 * is lost when something is removed.
 *
 * Everything here comes from the trial run the server made, never from the agent's own text, and
 * every value is shown as text: React escapes it, nothing is ever put in as HTML, and nothing the
 * agent or an outsider wrote becomes a link. Invisible formatting characters are taken out first
 * (words.ts plain()), so a file name cannot read backwards.
 *
 * What was not worked out is said to be unknown, never shown as "nothing": an operation Ironbooks
 * cannot run and roll back is described, not tried (its preview has no ledger part and
 * `routePreview.ran` false), and an effect named only from the operation's description says that
 * who it goes to, or where, is not known yet.
 */
import { AlertTriangle, FileDown, Globe, Mail, Printer } from 'lucide-react';
import { Badge } from '@/components/ui';
import { formatDate } from '@/lib/utils';
import type { OperationPreview } from '@/lib/agent/contract';
import type { ApprovalNeeds, EffectPreview } from '@/lib/agent/operations/types';
import {
  amountText,
  emailDomains,
  fieldLabel,
  isDeclaredEffect,
  isUnusualDomain,
  needsLabels,
  networkHost,
  notTriedNote,
  plain,
  recordHeading,
  replyToDomains,
  valueText,
} from './words';

/** "Needs an Admin", "Needs a password" … as small badges. */
export function NeedsChips({ needs }: { needs: ApprovalNeeds | null | undefined }) {
  const labels = needsLabels(needs);
  if (labels.length === 0) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {labels.map((l) => (
        <Badge key={l} tone="warning">
          {l}
        </Badge>
      ))}
    </span>
  );
}

const sectionTitle = 'mb-1 text-xs font-semibold uppercase tracking-wide text-navy/50';

function Ledger({ preview }: { preview: OperationPreview }) {
  // No ledger part at all: it was not worked out. Only a trial run that posted nothing says "nothing".
  if (!preview.ledger) {
    return <p className="text-sm text-navy/60">What this posts to the ledger was not worked out ahead of time.</p>;
  }
  const entries = preview.ledger.entries ?? [];
  if (entries.length === 0) {
    return <p className="text-sm text-navy/60">Nothing is posted to the ledger.</p>;
  }
  return (
    <div className="space-y-3">
      {entries.map((e, i) => (
        <div key={`${e.journalEntryId}-${i}`} className="rounded-lg border border-slate-200">
          <div className="border-b border-slate-100 px-3 py-1.5 text-xs text-navy/60">
            {e.entryNumber ? `Entry ${e.entryNumber} · ` : ''}
            {formatDate(e.date)}
            {e.description ? ` · ${plain(e.description)}` : ''}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-navy/50">
                <th className="px-3 py-1 text-left font-medium">Account</th>
                <th className="px-3 py-1 text-right font-medium">Debit</th>
                <th className="px-3 py-1 text-right font-medium">Credit</th>
              </tr>
            </thead>
            <tbody>
              {e.lines.map((l, j) => (
                <tr key={j} className="text-navy">
                  <td className="px-3 py-1">
                    {l.accountCode ? `${plain(l.accountCode)} ` : ''}
                    {plain(l.accountName)}
                    {l.entityName ? <span className="text-navy/50"> · {plain(l.entityName)}</span> : null}
                    {l.memo ? <span className="block text-xs text-navy/50">{plain(l.memo)}</span> : null}
                  </td>
                  <td className="px-3 py-1 text-right tabular-nums">{l.debit ? amountText(l.debit) : ''}</td>
                  <td className="px-3 py-1 text-right tabular-nums">{l.credit ? amountText(l.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function Records({ preview }: { preview: OperationPreview }) {
  const records = preview.records ?? [];
  if (records.length === 0) return null;
  return (
    <div>
      <div className={sectionTitle}>Record changes</div>
      <div className="space-y-2">
        {records.map((r, i) => (
          <div key={`${r.kind}-${r.id}-${i}`} className="rounded-lg border border-slate-200">
            <div className="border-b border-slate-100 px-3 py-1.5 text-xs font-semibold text-navy/70">{recordHeading(r.action, r.kind)}</div>
            {r.fields.length === 0 ? (
              <p className="px-3 py-1.5 text-xs text-navy/50">No field changes to show.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-navy/50">
                    <th className="px-3 py-1 text-left font-medium">Field</th>
                    <th className="px-3 py-1 text-left font-medium">Before</th>
                    <th className="px-3 py-1 text-left font-medium">After</th>
                  </tr>
                </thead>
                <tbody>
                  {r.fields.map((f, j) => (
                    <tr key={j} className="align-top text-navy">
                      <td className="px-3 py-1 text-navy/70">{fieldLabel(f.field)}</td>
                      <td className="break-all px-3 py-1 text-navy/60">{valueText(f.before)}</td>
                      <td className="break-all px-3 py-1">{valueText(f.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const domainChip = 'rounded-md bg-amber-100 px-2 py-0.5 text-base font-bold text-amber-900';
const unusualChip = 'rounded-md border-2 border-red-400 bg-red-50 px-2 py-0.5 text-base font-bold text-red-700';

/** Domains, each standing out; one with letters from other alphabets is marked as unusual. */
function DomainChips({ domains, attr }: { domains: string[]; attr: 'data-recipient-domain' | 'data-reply-domain' | 'data-network-host' }) {
  return (
    <>
      {domains.map((d) => (
        <span key={d} {...{ [attr]: '' }} className={isUnusualDomain(d) ? unusualChip : domainChip}>
          {d}
        </span>
      ))}
    </>
  );
}

/** Said under an address that uses letters from other alphabets. */
const UNUSUAL_NOTE =
  'This name uses letters from other alphabets, so it can look like a name you know. It is shown here as it is really spelled. Check it before you approve.';

/** What a described (not tried) effect leaves open, by kind. */
const NOT_KNOWN: Record<EffectPreview['kind'], string> = {
  email: 'Who it goes to is not known ahead of time.',
  file: 'Where it is saved is not known ahead of time.',
  print: 'Which printer it uses is not known ahead of time.',
  network: 'Which computer it contacts is not known ahead of time.',
};

/** One thing that would leave the computer. The recipient's domain and the host stand out (plan 11.2). */
export function EffectLine({ effect }: { effect: EffectPreview }) {
  const Icon = effect.kind === 'email' ? Mail : effect.kind === 'file' ? FileDown : effect.kind === 'print' ? Printer : Globe;
  const declared = isDeclaredEffect(effect);
  const domains = effect.kind === 'email' ? emailDomains(effect) : [];
  const replies = effect.kind === 'email' ? replyToDomains(effect) : [];
  const host = effect.kind === 'network' ? networkHost(effect) : null;
  const unusual = [...domains, ...replies, ...(host ? [host] : [])].some(isUnusualDomain);
  return (
    <li className="rounded-lg border border-slate-200 p-2 text-sm text-navy">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 flex-none text-navy/60" aria-hidden="true" />
        <span className="min-w-0 break-words">{plain(effect.summary)}</span>
      </div>
      {declared && domains.length === 0 && !host ? (
        <p className="mt-1.5 pl-6 text-xs font-semibold text-amber-800">{NOT_KNOWN[effect.kind] ?? 'The details are not known ahead of time.'}</p>
      ) : (
        <>
          {effect.kind === 'email' && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-6">
              <span className="text-xs text-navy/60">{domains.length ? 'Goes to' : 'No recipient is named.'}</span>
              <DomainChips domains={domains} attr="data-recipient-domain" />
            </div>
          )}
          {replies.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-6">
              <span className="text-xs text-navy/60">Replies go to</span>
              <DomainChips domains={replies} attr="data-reply-domain" />
            </div>
          )}
          {host && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-6">
              <span className="text-xs text-navy/60">Sends to</span>
              <DomainChips domains={[host]} attr="data-network-host" />
            </div>
          )}
          {unusual && <p className="mt-1.5 pl-6 text-xs font-semibold text-red-700">{UNUSUAL_NOTE}</p>}
        </>
      )}
    </li>
  );
}

/** The whole preview of a request: ledger, record changes, effects, warnings, loss. */
export default function RequestPreview({ preview }: { preview: OperationPreview | null }) {
  if (!preview) {
    return (
      <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-navy/70">
        Ironbooks could not try this ahead of time, so there is no preview. Read the summary above carefully before you approve.
      </p>
    );
  }
  const effects = preview.effects ?? [];
  const warnings = preview.warnings ?? [];
  const notTried = notTriedNote(preview);
  return (
    <div className="space-y-4">
      {preview.loss && (
        <div role="note" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <div className="font-semibold">What is lost if you approve</div>
          <p className="mt-0.5 whitespace-pre-wrap break-words">{plain(preview.loss)}</p>
        </div>
      )}
      {notTried !== null ? (
        // Described, not tried: nothing below the summary is known about the ledger or the records.
        <div role="note" data-not-tried="" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="font-semibold">Ironbooks did not try this ahead of time</div>
          <p className="mt-0.5">
            So what it posts to the ledger, which records it changes and what it may remove are not known. Read the summary above carefully, and
            approve only if you are sure of what it does.
          </p>
          {notTried && <p className="mt-1 text-xs">Ironbooks&apos; note: {notTried}</p>}
        </div>
      ) : (
        <>
          <div>
            <div className={sectionTitle}>Ledger</div>
            <Ledger preview={preview} />
          </div>
          <Records preview={preview} />
        </>
      )}
      {effects.length > 0 && (
        <div>
          <div className={sectionTitle}>What leaves this computer</div>
          <ul className="space-y-1.5">
            {effects.map((e, i) => (
              <EffectLine key={i} effect={e} />
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" /> Ironbooks would normally ask about this
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {warnings.map((w, i) => (
              <li key={i}>{plain(w.message)}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs">Read these before you approve.</p>
        </div>
      )}
      {preview.truncated && <p className="text-xs text-navy/50">The preview is long, so only part of it is shown.</p>}
    </div>
  );
}
