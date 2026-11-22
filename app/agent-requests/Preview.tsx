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
 * who it goes to, or where, is not known yet. A run that voids or deletes entries posts no new one,
 * yet changes the ledger: the ledger part names what it voids or deletes, with the amounts. Each
 * entry says what the run does to it (posts it, or voids, deletes or changes one already in the
 * books) from the bridge's own `touched` mark, never from its description, which an agent may
 * have written; an entry the run makes is labelled New. Each line names who it is for and its
 * class when the preview has them. Voided or deleted records that post nothing (an estimate line,
 * a list entry) are named with the record changes, not the ledger. A file that would be saved is
 * shown with its whole path, its folder and its file name each readable on its own.
 *
 * Warnings (plan 5.6): the ones the route raised, in its own words, each marked when the agent
 * sent the flag that goes past it, and any flag the agent sent that no warning shown names, said in
 * Ironbooks' words, so the person sees every question the agent answered for them.
 */
import { AlertTriangle, FileDown, Globe, Mail, Printer } from 'lucide-react';
import { Badge } from '@/components/ui';
import { formatDate } from '@/lib/utils';
import type { OperationPreview } from '@/lib/agent/contract';
import type { ApprovalNeeds, EffectPreview } from '@/lib/agent/operations/types';
import {
  amountText,
  emailDomains,
  entryDescription,
  entryTouched,
  entryWords,
  fieldLabel,
  filePathOf,
  isDeclaredEffect,
  isUnusualDomain,
  ledgerRemovals,
  lineNameAndClass,
  needsLabels,
  networkHost,
  notTriedNote,
  notTriedText,
  pathParts,
  plain,
  recordHeading,
  recordRemovals,
  removalText,
  replyToDomains,
  valueText,
  warningLines,
  type LedgerRemoval,
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

/**
 * What the run voids or deletes (words.ts ledgerRemovals, recordRemovals): a void takes an entry
 * out of the ledger without posting a new one, so the ledger part names them, with their amounts,
 * instead of saying nothing is posted. Records that post nothing are named with the record changes.
 */
function Removals({ groups, title, attr }: { groups: LedgerRemoval[]; title: string; attr: 'data-ledger-removals' | 'data-record-removals' }) {
  if (groups.length === 0) return null;
  return (
    <div {...{ [attr]: '' }} className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <div className="font-semibold">{title}</div>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {groups.map((g) => (
          <li key={`${g.action}-${g.kind}`} className="tabular-nums">
            {removalText(g)}
          </li>
        ))}
      </ul>
    </div>
  );
}

const ENTRY_FRAME = { gone: 'rounded-lg border border-red-200', changed: 'rounded-lg border border-amber-300', new: 'rounded-lg border border-slate-200' } as const;
const ENTRY_LABEL = { gone: 'font-semibold text-red-700', changed: 'font-semibold text-amber-800', new: 'font-semibold text-navy/70' } as const;

function Ledger({ preview }: { preview: OperationPreview }) {
  // No ledger part at all: it was not worked out. Only a trial run that posted nothing says "nothing".
  if (!preview.ledger) {
    return <p className="text-sm text-navy/60">What this posts to the ledger was not worked out ahead of time.</p>;
  }
  const entries = preview.ledger.entries ?? [];
  const removed = ledgerRemovals(preview);
  if (entries.length === 0) {
    // "Nothing is posted" only when the run takes nothing out either.
    if (removed.length > 0) {
      return (
        <div className="space-y-2">
          <p className="text-sm text-navy/60">No new entry is posted to the ledger.</p>
          <Removals groups={removed} title="It voids or deletes" attr="data-ledger-removals" />
        </div>
      );
    }
    return <p className="text-sm text-navy/60">Nothing is posted to the ledger.</p>;
  }
  return (
    <div className="space-y-3">
      {entries.map((e, i) => {
        // What the run does to the entry: posts it, or voids, deletes or changes one that was in the
        // books (the bridge's `touched` mark). The description is shown, never read for this.
        const how = entryTouched(e);
        const words = entryWords(e);
        const description = entryDescription(e);
        const gone = how === 'voided' ? 'void' : how === 'deleted' ? 'deleted' : undefined;
        return (
          <div key={`${e.journalEntryId}-${i}`} data-entry={how ?? 'new'} data-entry-gone={gone} className={ENTRY_FRAME[words.tone]}>
            <div className="border-b border-slate-100 px-3 py-1.5 text-xs text-navy/60">
              <span data-entry-label="" className={ENTRY_LABEL[words.tone]}>
                {words.label}
              </span>
              {' · '}
              {e.entryNumber ? `Entry ${e.entryNumber} · ` : ''}
              {formatDate(e.date)}
              {description ? ` · ${description}` : ''}
              {words.note && <span className={`block ${ENTRY_LABEL[words.tone]}`}>{words.note}</span>}
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
                {e.lines.map((l, j) => {
                  const { name, className } = lineNameAndClass(l);
                  return (
                    <tr key={j} className="align-top text-navy">
                      <td className="px-3 py-1">
                        {l.accountCode ? `${plain(l.accountCode)} ` : ''}
                        {plain(l.accountName)}
                        {name || className ? (
                          <span data-line-who="" className="block text-xs text-navy/60">
                            {name ? <span data-line-name="">Name: {name}</span> : null}
                            {name && className ? ' · ' : null}
                            {className ? <span data-line-class="">Class: {className}</span> : null}
                          </span>
                        ) : null}
                        {l.memo ? <span className="block text-xs text-navy/50">{plain(l.memo)}</span> : null}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums">{l.debit ? amountText(l.debit) : ''}</td>
                      <td className="px-3 py-1 text-right tabular-nums">{l.credit ? amountText(l.credit) : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
      <Removals groups={removed} title="It also voids or deletes" attr="data-ledger-removals" />
    </div>
  );
}

function Records({ preview }: { preview: OperationPreview }) {
  const records = preview.records ?? [];
  const removed = recordRemovals(preview);
  if (records.length === 0 && removed.length === 0) return null;
  return (
    <div>
      <div className={sectionTitle}>Record changes</div>
      <div className="space-y-2">
        <Removals groups={removed} title="It voids or deletes these records" attr="data-record-removals" />
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
export function DomainChips({
  domains,
  attr,
}: {
  domains: string[];
  attr: 'data-recipient-domain' | 'data-reply-domain' | 'data-network-host' | 'data-mail-host';
}) {
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
export const UNUSUAL_NOTE =
  'This name uses letters from other alphabets, so it can look like a name you know. It is shown here as it is really spelled. Check it before you approve.';

/** What a described (not tried) effect leaves open, by kind. */
const NOT_KNOWN: Record<EffectPreview['kind'], string> = {
  email: 'Who it goes to is not known ahead of time.',
  file: 'Where it is saved is not known ahead of time.',
  print: 'Which printer it uses is not known ahead of time.',
  network: 'Which computer it contacts is not known ahead of time.',
};

/**
 * A whole path, as its file name and its folder, each in full and readable on its own (words.ts
 * pathParts): a long folder wraps, and the name is never lost at the end of a line. The element
 * carries the whole path too, as written.
 */
export function PathParts({ path, attr }: { path: string; attr: 'data-file-path' | 'data-desktop-path' }) {
  const { folder, name } = pathParts(path);
  const code = 'block break-all rounded border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-xs text-navy';
  return (
    <div {...{ [attr]: plain(path).trim() }} className="mt-0.5 space-y-1">
      {name !== null && (
        <div>
          <span className="text-xs text-navy/60">File name</span>
          <code data-path-name="" className={`${code} font-semibold`}>
            {name}
          </code>
        </div>
      )}
      {folder !== null && (
        <div>
          <span className="text-xs text-navy/60">{name !== null ? 'In the folder' : 'Folder'}</span>
          <code data-path-folder="" className={code}>
            {folder}
          </code>
        </div>
      )}
    </div>
  );
}

/** One thing that would leave the computer. The recipient's domain and the host stand out (plan 11.2). */
export function EffectLine({ effect }: { effect: EffectPreview }) {
  const Icon = effect.kind === 'email' ? Mail : effect.kind === 'file' ? FileDown : effect.kind === 'print' ? Printer : Globe;
  const declared = isDeclaredEffect(effect);
  const domains = effect.kind === 'email' ? emailDomains(effect) : [];
  const replies = effect.kind === 'email' ? replyToDomains(effect) : [];
  const host = effect.kind === 'network' ? networkHost(effect) : null;
  // A file is shown with the whole path it is written to: the summary shortens the folder.
  const filePath = effect.kind === 'file' ? filePathOf(effect) : null;
  const replaces = effect.kind === 'file' && (effect.detail as Record<string, unknown> | undefined)?.replaces === true;
  const unusual = [...domains, ...replies, ...(host ? [host] : [])].some(isUnusualDomain);
  return (
    <li className="rounded-lg border border-slate-200 p-2 text-sm text-navy">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 flex-none text-navy/60" aria-hidden="true" />
        <span className="min-w-0 break-words">{plain(effect.summary)}</span>
      </div>
      {filePath && (
        <div className="mt-1.5 pl-6">
          <span className="text-xs font-medium text-navy/70">Written to</span>
          <PathParts path={filePath} attr="data-file-path" />
          {replaces && <p className="mt-1 text-xs font-semibold text-red-700">It replaces the file that is already there.</p>}
        </div>
      )}
      {declared && domains.length === 0 && !host && !filePath ? (
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

/**
 * The warnings a person would have been asked about in the window, and what the agent said to
 * them (plan 5.6, words.ts warningLines). Approving is the person's own yes to each.
 */
function Warnings({ preview, confirm }: { preview: OperationPreview | null; confirm: unknown }) {
  const { warnings, acceptedAhead } = warningLines(preview, confirm);
  if (warnings.length === 0 && acceptedAhead.length === 0) return null;
  return (
    <div data-warnings="" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <div className="flex items-center gap-1.5 font-semibold">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        {warnings.length > 0 ? 'Ironbooks would normally ask about this' : 'The agent said to go ahead past a warning'}
      </div>
      {warnings.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {warnings.map((w, i) => (
            <li key={i} data-warning={w.accepted ? 'accepted' : ''}>
              {w.message}
              {w.accepted && <span className="font-semibold"> The agent said to go ahead anyway.</span>}
            </li>
          ))}
        </ul>
      )}
      {acceptedAhead.length > 0 && (
        <div data-accepted-ahead="" className="mt-1">
          <p>
            {warnings.length > 0
              ? 'The agent also said to go ahead if Ironbooks warns that:'
              : 'The agent said to go ahead if Ironbooks warns that:'}
          </p>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
            {acceptedAhead.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-1 text-xs">Read these before you approve: approving is your own yes to each of them.</p>
    </div>
  );
}

/**
 * The whole preview of a request: ledger, record changes, effects, warnings, loss. `confirm` is the
 * agent's own list of warnings it said yes to (OperationInput.confirm).
 */
export default function RequestPreview({ preview, confirm }: { preview: OperationPreview | null; confirm?: unknown }) {
  if (!preview) {
    return (
      <div className="space-y-4">
        <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-navy/70">
          Ironbooks could not try this ahead of time, so there is no preview. Read the summary above carefully before you approve.
        </p>
        <Warnings preview={null} confirm={confirm} />
      </div>
    );
  }
  const effects = preview.effects ?? [];
  const notTried = notTriedNote(preview);
  const note = notTriedText(notTried);
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
          <div className="font-semibold">What this does is not shown ahead of time</div>
          <p className="mt-0.5">
            What it posts to the ledger, which records it changes and what it may remove are not known here. Read the summary above carefully, and
            approve only if you are sure of what it does.
          </p>
          {note && (
            <p data-not-tried-note="" className="mt-1 whitespace-pre-wrap break-words">
              <span className="font-semibold">Why: </span>
              {note}
            </p>
          )}
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
      <Warnings preview={preview} confirm={confirm} />
      {preview.truncated && <p className="text-xs text-navy/50">The preview is long, so only part of it is shown.</p>}
    </div>
  );
}
