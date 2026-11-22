'use client';
/**
 * Agent requests: the approval card (plan 4.3, 4.4, 5.5, 5.8, 7.2, 7.4, 11.2).
 *
 * First who asked and why, in the agent's own words: shown in quotes under "The agent says", as
 * text only, never as fact (an outsider's words can reach the agent through a vendor name or an
 * emailed PDF and steer it). Then what Ironbooks itself worked out from a trial run (Preview.tsx):
 * the summary, the files and computers a desktop request touches (whole paths), the ledger, the
 * record changes, what would leave the computer, warnings and what is lost. Then who may answer it
 * and what the approval needs: the boxes for each secret, the questions a desktop flow would have
 * asked (sent by the server with the request). Then Approve once, Approve similar… (standing
 * permission, ApproveSimilar.tsx, hidden when this person may give none) and Deny with a note the
 * agent reads.
 *
 * Secrets typed here (plan 5.8) live only in their boxes. They are read when Approve is pressed,
 * sent with that one approval (a secret of several parts, such as the sign-in of a protected
 * backup, as the one text lib/agent/guards.ts encodeSecretParts makes), and the boxes are emptied
 * and replaced at once: never in React state, never logged, never stored. A second approval (after
 * the books changed) asks for them again. A mail password's box names the server it goes to.
 * Secrets the run produced are shown once and live only in this card's state, so they are gone
 * when it closes; the page never sees them.
 *
 * The server decides everything again (who may approve, the time limit of standing permission,
 * whether the books changed); this card only asks, and fails closed: anything it cannot show or
 * pass on safely is not approvable here. Approve waits for the card's own fresh copy of the
 * request: the list's copy may be old.
 *
 * "The books changed" (plan 7.4): a request the server marks `stale` says so, and that Approve
 * first shows what would happen now. acceptStale is only ever sent after THIS card got a 'stale'
 * answer and showed the new preview: the next Approve is the person's yes to that preview. A card
 * opened later starts over with a plain Approve, and the server checks the books again and
 * answers 'stale' once more when they moved. "Approve similar…" then takes again from the new
 * preview only what the person had not changed (its amount, the count of a bulk change): a shorter
 * time, fewer uses, other dates or an unticked limit stay as they left them (words.ts
 * rebuildGrantForm). The same second yes is asked when the approval sent the request back with a
 * note instead of running it (lib/agent/operate.ts: dated in a closed period, two people needed,
 * more done once protected values were shown): the card then says so, not that the books changed
 * (words.ts staleKind).
 *
 * An approval the server refuses before anything runs (a password left out, a refusal Ironbooks
 * never lets an agent past, someone else answered first) shows the server's own words, and the card
 * loads the request again so it shows where it now stands; nothing is approvable until it has.
 *
 * While an answer is on its way, or the card shows a secret the run produced, the page does not
 * swap it for the request a link names (onHold): that one opens once this card is closed.
 */
import * as React from 'react';
import Link from 'next/link';
import { Badge, Button, Input, Label, Modal, Select, Spinner, toast } from '@/components/ui';
import { api } from '@/lib/client';
import { formatDate } from '@/lib/utils';
import { sourceFormHref } from '@/lib/reports/drilldown';
import { RISK_CLASS_LABELS, type SecretKind } from '@/lib/agent/operations/types';
import type { EffectReport } from '@/lib/effects';
import type { AgentRequestForPerson, ApproveInput, ApproveResult, FlowQuestion, ProducedSecret } from '@/lib/agent/contract';
import RequestPreview, { DomainChips, NeedsChips, PathParts, UNUSUAL_NOTE } from './Preview';
import ApproveSimilar from './ApproveSimilar';
import ProducedSecrets from './ProducedSecrets';
import { requestsChanged } from './notify';
import {
  AMOUNT_UNKNOWN_WHY,
  ageText,
  amountShown,
  approveFailureText,
  approverLines,
  canGiveGrant,
  clockTime,
  constraintLines,
  desktopLines,
  doneEntryIds,
  durationLabel,
  flowQuestionsOf,
  grantFromForm,
  grantGivenText,
  grantNeverHere,
  grantNotGivenText,
  grantRuleLine,
  initialGrantForm,
  isUnusualDomain,
  isWaiting,
  mailServerOf,
  plain,
  reasonText,
  rebuildGrantForm,
  secretBoxes,
  secretFieldReady,
  secretFieldsOf,
  secretValueOf,
  staleKind,
  waitsForSecondPerson,
  writtenPathOf,
  type GrantForm,
  type SecretPartName,
} from './words';

/** What the card says once the books changed between the ask and the approval (plan 7.4). */
export const STALE_MESSAGE = 'The books changed since the agent asked. This is what would happen now.';
/** What the card says once the approval sent the request back with a note instead of running it. */
export const SENT_BACK_MESSAGE = 'Ironbooks sent this back before running it.';

/**
 * What the card says of a request the server marks as changed (its preview is already the new one),
 * before this card got a 'stale' answer: the first Approve is the person's word that they saw it.
 */
export const STALE_MARK = 'The books changed since the agent asked.';
export const STALE_MARK_NEXT =
  'The preview below is what would happen now. Read it, then approve: the first approval only confirms you have seen it, and nothing runs until you approve again.';
/** The same, for a request an earlier approval sent back with a note. */
export const SENT_BACK_MARK = 'An earlier approval sent this back with a note before it ran.';
export const SENT_BACK_MARK_NEXT =
  'Read the note below, then approve: the first approval only confirms you have seen it, and nothing runs until you approve again.';

/** Said on a request that asks to see full values (plan 5.9, D6). */
export const REVEAL_NOTE =
  'The agent asks to see full values, such as full Social Security or account numbers. If you approve, it sees them for this one request, and what an agent reads is sent to the AI service that runs it, as it is.';

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : 'Something went wrong';
}

const sectionTitle = 'mb-1 text-xs font-semibold uppercase tracking-wide text-navy/50';

/** An answer that came back from Approve, other than "the books changed" or "not approved". */
interface Outcome {
  status: Exclude<ApproveResult['status'], 'stale' | 'not_approved'>;
  produced: ProducedSecret[];
  effects: EffectReport[];
  /**
   * Standing permission was asked for with it, for this many minutes. Whether it was given is the
   * request's `grant` (or, from an older server, its grantId): the run can go through while the
   * permission is not made.
   */
  grantMinutes: number | null;
  at: Date;
}

/** How a request that was already answered stands, in one line. */
function decidedText(r: AgentRequestForPerson): string | null {
  const by = r.decidedByName ? plain(r.decidedByName) : '';
  const second = r.secondApproverName ? plain(r.secondApproverName) : '';
  if (waitsForSecondPerson(r)) return `Approved by ${by}. A second person must also approve before it runs.`;
  switch (r.status) {
    case 'executed':
      return `Done${by ? `, approved by ${by}` : ''}${second ? ` and ${second}` : ''}.`;
    case 'approved':
      return `Approved${by ? ` by ${by}` : ''}${second ? ` and ${second}` : ''}. Ironbooks is carrying it out now.`;
    case 'denied':
      return `Denied${by ? ` by ${by}` : ''}.`;
    case 'failed':
      return `Approved${by ? ` by ${by}` : ''}, but it did not go through.`;
    case 'expired':
      return 'Nobody answered in time, so it expired. The agent can ask again.';
    case 'cancelled':
      return 'The agent took this request back.';
    default:
      return null;
  }
}

/**
 * Links to what an approved run entered: the entries the server says the committed run created
 * (request.entryIds), or from an older server the ones the run's own answer names (words.ts
 * doneEntryIds). Never from the preview: its entries came from a trial run that was rolled back, so
 * they do not exist. Then the file a desktop request wrote, and the audit trail.
 */
function DoneLinks({ request }: { request: AgentRequestForPerson }) {
  const entries = doneEntryIds(request);
  const written = writtenPathOf(request);
  // For a person without the View flag the run needed, the server sends a note instead of the answer.
  const note = typeof request.result === 'string' ? plain(request.result).trim() : '';
  return (
    <ul className="mt-1 space-y-0.5" data-done-links="">
      {entries.map((id, i) => (
        <li key={id}>
          <Link href={sourceFormHref(id, '/agent-requests')} className="text-electric underline">
            {entries.length === 1 ? 'Open the entry it posted' : `Open entry ${i + 1} of ${entries.length} it posted`}
          </Link>
        </li>
      ))}
      {entries.length === 0 && request.posted === true && <li className="text-navy/80">It posted to the ledger. The Audit Trail shows what.</li>}
      {written && (
        <li className="text-navy/80">
          It wrote{' '}
          <code data-written-path="" className="break-all font-mono text-xs">
            {written}
          </code>
        </li>
      )}
      {request.file && <li className="text-navy/80">It made a file: {plain(request.file.name)}</li>}
      {note && <li className="text-navy/60">{note}</li>}
      <li>
        <Link href="/audit-trail" className="text-electric underline">
          See it in the Audit Trail
        </Link>
      </li>
    </ul>
  );
}

/** The standing permission the server says was given with the approval (it may be narrower than asked). */
function GrantGiven({ request, now }: { request: AgentRequestForPerson; now: Date }) {
  const g = request.grant;
  if (!g) return null;
  const until = Date.parse(g.expiresAt);
  const ended = Number.isFinite(until) && until <= now.getTime();
  const lines = constraintLines(g.constraints);
  return (
    <div data-grant-given="" className="mt-0.5">
      <p>{ended ? 'The standing permission given with it has ended.' : grantGivenText(request.agentName, g)}</p>
      {lines.length > 0 && (
        <ul className="mt-0.5 list-disc pl-5 text-navy/80">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The run went through, and the standing permission asked for with it was not given: why, in the server's words. */
function GrantNotGiven({ request }: { request: AgentRequestForPerson }) {
  return (
    <p data-grant-not-given="" className="mt-0.5 whitespace-pre-wrap break-words text-amber-800">
      {grantNotGivenText(request.agentName, request.grantError)}
    </p>
  );
}

/** What happened to each email, file, print job and call after the run. */
function EffectReports({ reports }: { reports: EffectReport[] }) {
  if (reports.length === 0) return null;
  return (
    <ul className="mt-2 space-y-0.5 text-sm">
      {reports.map((r, i) => (
        <li key={i} className={r.status === 'sent' ? 'text-navy' : 'text-red-600'}>
          {r.status === 'sent' ? 'Done: ' : 'Did not happen: '}
          {plain(r.effect.summary)}
          {r.error ? ` (${plain(r.error)})` : ''}
        </li>
      ))}
    </ul>
  );
}

/** One question of a desktop flow (plan 5.5), answered on the card. Passwords are not asked here. */
function QuestionField({
  q,
  value,
  onChange,
}: {
  q: FlowQuestion;
  value: string | boolean | undefined;
  onChange: (v: string | boolean) => void;
}) {
  const id = `flow-q-${q.id}`;
  const text = plain(q.text);
  if (q.kind === 'yes_no') {
    return (
      <fieldset>
        <legend className="mb-1 text-[13px] font-medium text-navy/70">{text}</legend>
        <div className="flex gap-4 text-sm text-navy">
          <label className="flex items-center gap-1.5">
            <input type="radio" name={id} checked={value === true} onChange={() => onChange(true)} /> Yes
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" name={id} checked={value === false} onChange={() => onChange(false)} /> No
          </label>
        </div>
      </fieldset>
    );
  }
  if (q.kind === 'choice') {
    return (
      <div>
        <Label htmlFor={id}>{text}</Label>
        <Select id={id} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {(q.choices ?? []).map((c) => (
            <option key={c} value={c}>
              {plain(c)}
            </option>
          ))}
        </Select>
      </div>
    );
  }
  return (
    <div>
      <Label htmlFor={id}>{text}</Label>
      <Input id={id} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false} />
      {q.kind === 'path' && <p className="mt-1 text-xs text-navy/50">A folder or file on this computer.</p>}
    </div>
  );
}

/** Where a typed mail password goes (guards.ts puts it into the request's own mail settings). */
function MailServer({ server }: { server: NonNullable<ReturnType<typeof mailServerOf>> }) {
  if (!server.host) {
    return (
      <p data-mail-server="" className="mt-1 text-xs text-navy/60">
        The request names no mail server, so Ironbooks tests its saved settings and the password you type is not sent anywhere.
      </p>
    );
  }
  return (
    <div data-mail-server="" className="mt-1.5 space-y-1 text-xs text-navy/70">
      <div className="flex flex-wrap items-center gap-1.5">
        <span>{server.saved ? 'The password is kept for, and sent to, the mail server' : 'The password you type is sent to the mail server'}</span>
        <DomainChips domains={[server.host]} attr="data-mail-host" />
        {server.port && <span>on port {server.port}</span>}
      </div>
      <p>Check that this is your own mail server: whoever runs that server can read the password.</p>
      {isUnusualDomain(server.host) && <p className="font-semibold text-red-700">{UNUSUAL_NOTE}</p>}
    </div>
  );
}

/**
 * Why a card must not be swapped for another without the person closing it: an answer is on its way
 * ('busy'), or it shows something only once, a secret the run produced ('once').
 */
export type CardHold = 'busy' | 'once' | null;

export default function RequestCard({
  id,
  initial,
  onClose,
  onChanged,
  onHold,
}: {
  id: string;
  /** The list's copy, shown while the card loads the latest. Never approvable by itself. */
  initial: AgentRequestForPerson | null;
  onClose: () => void;
  /** The request as it now stands, for the list (never with what the run produced). */
  onChanged: (request: AgentRequestForPerson, stale: boolean) => void;
  /** Told whenever the card starts or stops holding (CardHold), and null once it is gone. */
  onHold?: (hold: CardHold) => void;
}) {
  const [request, setRequest] = React.useState<AgentRequestForPerson | null>(initial);
  // Whether `request` is the card's own fresh copy from the server (or an approval's answer).
  const [fresh, setFresh] = React.useState(false);
  const [loadError, setLoadError] = React.useState('');
  const [loadRound, setLoadRound] = React.useState(0);
  const [mode, setMode] = React.useState<'main' | 'similar' | 'deny'>('main');
  const [busy, setBusy] = React.useState<'approve' | 'deny' | null>(null);
  const [outcome, setOutcome] = React.useState<Outcome | null>(null);
  // Set only by a 'stale' answer to an approval on this card; the next Approve accepts that preview.
  const [stale, setStale] = React.useState(false);
  const [failure, setFailure] = React.useState('');
  const [note, setNote] = React.useState('');
  const [answers, setAnswers] = React.useState<Record<string, string | boolean>>({});
  // Whether each secret box ("kind:part") has something in it. Never the value itself.
  const [filled, setFilled] = React.useState<Record<string, boolean>>({});
  // New secret boxes after every send: the old elements, and anything that remembered their value
  // by element (the field-level undo of components/KeyboardBase.tsx), go away with them.
  const [secretRound, setSecretRound] = React.useState(0);
  const [grantForm, setGrantForm] = React.useState<GrantForm | null>(null);
  // The books changed and "Approve similar…" was filled in again from the new preview: what the form says about it.
  const [grantRebuilt, setGrantRebuilt] = React.useState<string | null>(null);
  const [grantError, setGrantError] = React.useState('');
  const [now] = React.useState(() => new Date());
  const secretInputs = React.useRef<Record<string, HTMLInputElement | null>>({});
  const resultRef = React.useRef<HTMLDivElement>(null);
  const onChangedRef = React.useRef(onChanged);
  onChangedRef.current = onChanged;
  const onHoldRef = React.useRef(onHold);
  onHoldRef.current = onHold;

  // The page swaps cards when a link names another request; it waits while this one holds (an
  // answer on its way, or a secret shown only here) and opens the other once this one is closed.
  const hold: CardHold = busy ? 'busy' : outcome && outcome.produced.length > 0 ? 'once' : null;
  React.useEffect(() => {
    onHoldRef.current?.(hold);
  }, [hold]);
  React.useEffect(() => () => onHoldRef.current?.(null), []);

  // The latest state of the request: someone else may have answered it, or the books may have
  // changed it, since the list loaded. Nothing is approvable until this copy is here.
  React.useEffect(() => {
    let live = true;
    setLoadError('');
    api
      .get<{ request: AgentRequestForPerson }>(`/api/agent-requests/${encodeURIComponent(id)}`)
      .then((r) => {
        if (!live) return;
        if (!r?.request) {
          setLoadError('Ironbooks did not send this request back.');
          return;
        }
        setRequest(r.request);
        setFresh(true);
        onChangedRef.current(r.request, false);
      })
      .catch((e) => {
        if (live) setLoadError(errMsg(e));
      });
    return () => {
      live = false;
    };
  }, [id, loadRound]);

  React.useEffect(() => {
    if (request && fresh && !grantForm && canGiveGrant(request)) setGrantForm(initialGrantForm(request, now));
  }, [request, fresh, grantForm, now]);

  const questions = request ? flowQuestionsOf(request).filter((q) => q.kind !== 'password') : [];
  const { fields: secretFields, unanswerable } = request ? secretFieldsOf(request) : { fields: [], unanswerable: false };
  const actionable = !!request && isWaiting(request.status) && request.canApprove && outcome === null;
  const grantOffered = !!request && fresh && canGiveGrant(request) && grantForm !== null;
  const secretsReady = secretFields.every((f) => secretFieldReady(f, (n) => !!filled[`${f.kind}:${n}`]));
  const answersReady = questions.every((q) => answers[q.id] !== undefined && answers[q.id] !== '');
  const ready = actionable && fresh && !busy && secretsReady && answersReady && !unanswerable;

  /** Close, unless an answer is on its way: what it brings (a secret the run produced) is shown only here. */
  function tryClose() {
    if (busy) {
      toast('Wait a moment: Ironbooks is still answering. What it sends back is shown only here.', 'info');
      return;
    }
    onClose();
  }

  /**
   * Read the typed secrets and empty their boxes: from here on they exist only in the request being
   * sent. A secret of several parts becomes its one text here (words.ts secretValueOf). An error
   * (two copies of a new password that differ) sends nothing: the boxes are emptied all the same.
   */
  function takeSecrets(): { secrets: Partial<Record<SecretKind, string>> } | { error: string } {
    const out: Partial<Record<SecretKind, string>> = {};
    let error: string | null = null;
    for (const f of secretFields) {
      const read = (name: SecretPartName | 'value') => secretInputs.current[`${f.kind}:${name}`]?.value ?? '';
      const v = secretValueOf(f, read);
      if (v && 'error' in v) error = error ?? v.error;
      else if (v) out[f.kind] = v.value;
    }
    for (const el of Object.values(secretInputs.current)) if (el) el.value = '';
    secretInputs.current = {};
    setFilled({});
    setSecretRound((n) => n + 1);
    return error ? { error } : { secrets: out };
  }

  async function approve(withGrant: boolean) {
    if (!request || !ready) return;
    setFailure('');
    setGrantError('');
    const body: ApproveInput = {};
    let grantMinutes: number | null = null;
    if (withGrant) {
      if (!grantForm) return;
      const built = grantFromForm(grantForm, request.grantMinutesMax);
      if ('error' in built) {
        setGrantError(built.error);
        return;
      }
      body.grant = built.grant;
      grantMinutes = built.grant.minutes;
    }
    if (questions.length) body.answers = Object.fromEntries(questions.map((q) => [q.id, answers[q.id]]));
    if (stale) body.acceptStale = true;
    const taken = takeSecrets();
    if ('error' in taken) {
      setFailure(taken.error);
      return;
    }
    if (Object.keys(taken.secrets).length) body.secrets = taken.secrets;
    setBusy('approve');
    try {
      const r = await api.post<ApproveResult>(`/api/agent-requests/${encodeURIComponent(request.id)}/approve`, body, { noUndo: true });
      setRequest(r.request);
      setFresh(true);
      onChangedRef.current(r.request, r.status === 'stale');
      requestsChanged();
      if (r.status === 'stale') {
        // Nothing ran. The new preview is on screen; approving again is a second, explicit yes.
        setStale(true);
        // "Approve similar…" takes again from the new preview only what the person had not changed
        // (its amount, the count of a bulk change); their own choices stay as they left them.
        const again = canGiveGrant(r.request);
        const rebuilt = again && grantForm ? rebuildGrantForm(grantForm, request, r.request, now) : null;
        setGrantRebuilt(rebuilt?.note ?? null);
        setGrantForm(again ? (rebuilt?.form ?? initialGrantForm(r.request, now)) : null);
        setMode(withGrant && again ? 'similar' : 'main');
      } else if (r.status === 'not_approved') {
        // Nothing ran: say why in the server's words (the request says where it now stands).
        setFailure(plain(r.request.error) || 'It was not approved, and nothing was done. Try again in a moment.');
      } else {
        setStale(false);
        setMode('main');
        setOutcome({ status: r.status, produced: r.produced ?? [], effects: r.effects ?? [], grantMinutes, at: new Date() });
      }
      window.setTimeout(() => resultRef.current?.focus(), 0);
    } catch (e) {
      // Refused before anything ran (a password left out, a refusal no approval gets past, someone
      // else answered first): the server's words as they came, then the request as it now stands.
      // Until that copy is here the one on screen may be out of date, so nothing is approvable on
      // it, and a load that fails says so with Try again.
      setFailure(errMsg(e));
      setFresh(false);
      setLoadRound((n) => n + 1);
    } finally {
      setBusy(null);
    }
  }

  async function deny() {
    if (!request || busy) return;
    setFailure('');
    takeSecrets();
    setBusy('deny');
    const text = note.trim();
    try {
      const r = await api.post<{ request: AgentRequestForPerson }>(
        `/api/agent-requests/${encodeURIComponent(request.id)}/deny`,
        { note: text || null },
        { noUndo: true },
      );
      onChangedRef.current(r.request, false);
      requestsChanged();
      toast(text ? 'Denied. The agent will read your note.' : 'Denied. The agent is told.', 'success');
      onClose();
    } catch (e) {
      setFailure(errMsg(e));
      setBusy(null);
    }
  }

  const close = (
    <Button variant="secondary" onClick={tryClose}>
      Close
    </Button>
  );
  // Why the yes is asked again: the books changed, or the approval sent it back with a note.
  const sentBack = !!request && staleKind(request) === 'note';
  let footer: React.ReactNode = close;
  if (request && actionable) {
    if (mode === 'deny') {
      footer = (
        <>
          <Button variant="secondary" onClick={() => setMode('main')} disabled={!!busy}>
            Back
          </Button>
          <Button variant="danger" loading={busy === 'deny'} onClick={deny}>
            Deny request
          </Button>
        </>
      );
    } else if (mode === 'similar' || request.kind === 'grant') {
      footer = (
        <>
          {request.kind === 'grant' ? (
            <Button variant="secondary" onClick={() => setMode('deny')} disabled={!!busy}>
              Deny…
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => setMode('main')} disabled={!!busy}>
              Back
            </Button>
          )}
          {grantOffered && (
            <Button loading={busy === 'approve'} disabled={!ready} onClick={() => approve(true)}>
              {request.kind === 'grant'
                ? stale
                  ? 'Give permission as it stands now'
                  : 'Give permission'
                : stale
                  ? sentBack
                    ? 'Approve again, and similar'
                    : 'Approve what would happen now, and similar'
                  : 'Approve this and similar'}
            </Button>
          )}
        </>
      );
    } else {
      footer = (
        <>
          <Button variant="secondary" onClick={() => setMode('deny')} disabled={!!busy}>
            Deny…
          </Button>
          {grantOffered && (
            <Button variant="secondary" onClick={() => setMode('similar')} disabled={!!busy}>
              Approve similar…
            </Button>
          )}
          <Button loading={busy === 'approve'} disabled={!ready} onClick={() => approve(false)}>
            {stale ? (sentBack ? 'Approve again' : 'Approve what would happen now') : 'Approve once'}
          </Button>
        </>
      );
    }
  }

  const title = request ? `Request from ${plain(request.agentName)}` : 'Agent request';
  const reason = request ? reasonText(request.reason) : '';
  const decided = request && outcome === null ? decidedText(request) : null;
  const amount = request ? amountShown(request) : null;
  const desktop = request ? desktopLines(request) : [];
  const mail = request ? mailServerOf(request) : null;
  const who = request && isWaiting(request.status) ? approverLines(request.needs) : [];
  const grantRule = request && isWaiting(request.status) ? grantRuleLine(request) : null;
  // The server marks a request whose books changed; until this card was shown the new preview, say so.
  const staleMark = !!request && request.stale === true && !stale && isWaiting(request.status) && outcome === null;

  const retry = (
    <Button size="sm" variant="secondary" onClick={() => setLoadRound((n) => n + 1)}>
      Try again
    </Button>
  );

  return (
    <Modal open onClose={tryClose} title={title} size="lg" confirmChanges={false} footer={footer}>
      {!request ? (
        loadError ? (
          <div role="alert" className="space-y-2 text-sm text-red-600">
            <p>{loadError}</p>
            {retry}
          </div>
        ) : (
          <div className="flex justify-center py-8 text-electric">
            <Spinner />
          </div>
        )
      ) : (
        <div className="space-y-5">
          {/* The list's copy is on screen until the card's own arrives; approving waits for it. */}
          {!fresh && loadError && (
            <div role="alert" data-load-error="" className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <p>
                Ironbooks could not load the latest of this request: {loadError} What is shown may be out of date, so it cannot be approved until it
                loads.
              </p>
              {retry}
            </div>
          )}
          {!fresh && !loadError && isWaiting(request.status) && (
            <p data-card-loading="" className="flex items-center gap-2 text-xs text-navy/60">
              <Spinner className="h-3.5 w-3.5 text-electric" /> Loading the latest of this request…
            </p>
          )}
          {/* How it stands: what the approval just did, or how it was answered before. */}
          <div ref={resultRef} tabIndex={-1} className="space-y-2 outline-none focus-visible:ring-2 focus-visible:ring-electric/25" role="status">
            {outcome?.status === 'executed' && (
              <div className="rounded-lg border border-emerald/30 bg-emerald/10 p-3 text-sm text-navy">
                <div className="font-semibold text-emerald">Done.</div>
                {request.grant ? (
                  <GrantGiven request={request} now={now} />
                ) : request.grantError ? (
                  <GrantNotGiven request={request} />
                ) : outcome.grantMinutes && request.grantId ? (
                  // From a server that does not say what was given: what was asked for, from now.
                  <p className="mt-0.5">
                    {plain(request.agentName)} may do more of the same without asking for {durationLabel(outcome.grantMinutes)}, until about{' '}
                    {clockTime(new Date(outcome.at.getTime() + outcome.grantMinutes * 60_000))}. You can take it back in Users &amp; Roles &gt; Agents.
                  </p>
                ) : outcome.grantMinutes ? (
                  <GrantNotGiven request={request} />
                ) : null}
                {request.kind === 'operation' && <DoneLinks request={request} />}
                <EffectReports reports={outcome.effects} />
              </div>
            )}
            {outcome?.status === 'failed' && (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                <div className="font-semibold">It did not go through.</div>
                <p className="mt-0.5 whitespace-pre-wrap break-words">{plain(request.error) || 'Ironbooks did not say why. Nothing was changed.'}</p>
                <EffectReports reports={outcome.effects} />
              </div>
            )}
            {outcome?.status === 'needs_second_approver' && (
              <div className="rounded-lg border border-electric/30 bg-electric/5 p-3 text-sm text-navy">
                <div className="font-semibold">Your approval is recorded.</div>
                <p className="mt-0.5">A second person must also approve this before it runs. Nothing has changed yet.</p>
              </div>
            )}
            {stale && actionable && (
              <div data-stale-answer={sentBack ? 'note' : 'changed'} className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <div className="font-semibold">{sentBack ? SENT_BACK_MESSAGE : STALE_MESSAGE}</div>
                <p className="mt-0.5">
                  {sentBack
                    ? "Nothing was done. Read Ironbooks' note below, and approve once more only if it is still right."
                    : 'Nothing was done. Read it again below, and approve once more only if it is still right.'}
                </p>
              </div>
            )}
            {decided && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-navy/80">
                <p>
                  {decided}
                  {request.decidedAt ? <span className="text-navy/50"> {formatDate(request.decidedAt, 'MMM d, yyyy h:mm a')}</span> : null}
                </p>
                {request.status === 'denied' && request.note && (
                  <p className="mt-1 whitespace-pre-wrap break-words">Note to the agent: &ldquo;{plain(request.note)}&rdquo;</p>
                )}
                {request.status === 'failed' && request.error && <p className="mt-1 whitespace-pre-wrap break-words text-red-700">{plain(request.error)}</p>}
                {request.status === 'executed' && (request.grant ? <GrantGiven request={request} now={now} /> : request.grantError ? <GrantNotGiven request={request} /> : null)}
                {request.status === 'executed' && request.kind === 'operation' && <DoneLinks request={request} />}
              </div>
            )}
          </div>
          {/* Outside the status region above: a screen reader announces only its heading, never the value. */}
          {outcome && <ProducedSecrets produced={outcome.produced} />}

          {staleMark && (
            <div data-stale-notice={sentBack ? 'note' : 'changed'} className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <div className="font-semibold">{sentBack ? SENT_BACK_MARK : STALE_MARK}</div>
              <p className="mt-0.5">{sentBack ? SENT_BACK_MARK_NEXT : STALE_MARK_NEXT}</p>
            </div>
          )}

          <section aria-labelledby="req-reason-title">
            <h3 id="req-reason-title" className={sectionTitle}>
              The agent says
            </h3>
            {reason ? (
              <blockquote data-agent-reason="" className="whitespace-pre-wrap break-words border-l-4 border-slate-200 pl-3 text-sm italic text-navy/80">
                &ldquo;{reason}&rdquo;
              </blockquote>
            ) : (
              <p className="text-sm text-navy/50">The agent gave no reason.</p>
            )}
            <p className="mt-1 text-xs text-navy/50">These are the agent&apos;s own words, not checked by Ironbooks. What the request really does is below.</p>
          </section>

          <section aria-labelledby="req-what-title" className="space-y-3">
            <h3 id="req-what-title" className={sectionTitle}>
              What Ironbooks worked out
            </h3>
            <div>
              <p data-request-summary="" className="break-words text-base font-semibold text-navy">
                {plain(request.summary)}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-navy/70">
                <Badge tone="info">{RISK_CLASS_LABELS[request.class] ?? plain(request.class)}</Badge>
                {amount &&
                  (amount.unknown ? (
                    <span data-amount-unknown="" className="font-semibold text-amber-800">
                      {amount.text}
                    </span>
                  ) : (
                    <span className="tabular-nums">Amount {amount.text}</span>
                  ))}
                <span>Asked {ageText(request.createdAt).toLowerCase()}</span>
                {isWaiting(request.status) && <span>Waits until {formatDate(request.expiresAt, 'MMM d, yyyy h:mm a')}</span>}
              </div>
              {amount?.unknown && isWaiting(request.status) && <p className="mt-1 text-xs text-navy/60">{AMOUNT_UNKNOWN_WHY}</p>}
              <NeedsChips needs={request.needs} />
            </div>
            {desktop.length > 0 && (
              <div data-desktop-lines="" className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm text-navy">
                {desktop.map((d) => (
                  <div key={d.label}>
                    <div className="text-xs font-medium text-navy/70">{d.label}</div>
                    {d.path ? (
                      <PathParts path={d.value} attr="data-desktop-path" />
                    ) : (
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <DomainChips domains={[d.value]} attr="data-network-host" />
                      </span>
                    )}
                    {!d.path && isUnusualDomain(d.value) && <p className="mt-1 text-xs font-semibold text-red-700">{UNUSUAL_NOTE}</p>}
                  </div>
                ))}
              </div>
            )}
            {request.kind === 'grant' && (
              <div className="rounded-lg border border-slate-200 p-3 text-sm text-navy">
                <div className="font-semibold">The agent asks for standing permission to do this without asking each time.</div>
                {request.grantAsked ? (
                  <ul className="mt-1 list-disc pl-5 text-navy/80">
                    <li>For {durationLabel(request.grantAsked.minutes)}</li>
                    {constraintLines(request.grantAsked.constraints).map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}
            {request.input?.reveal && <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">{REVEAL_NOTE}</p>}
            {request.kind === 'operation' && <RequestPreview preview={request.preview} confirm={request.input?.confirm} />}
            {request.input && (
              <details className="text-xs text-navy/60">
                <summary className="cursor-pointer">What the agent sent, as it sent it</summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-slate-200 bg-slate-50 p-2 font-mono">
                  {plain(JSON.stringify(request.input, null, 2)).slice(0, 4000)}
                </pre>
              </details>
            )}
          </section>

          {(who.length > 0 || grantRule) && (
            <section aria-labelledby="req-who-title">
              <h3 id="req-who-title" className={sectionTitle}>
                Who can answer it
              </h3>
              <ul data-who-approves="" className="space-y-0.5 text-sm text-navy/80">
                {who.map((l) => (
                  <li key={l}>{l}</li>
                ))}
                {grantRule && <li data-grant-rule="">{grantRule}</li>}
              </ul>
            </section>
          )}

          {isWaiting(request.status) && !request.canApprove && (
            <div role="note" className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-navy/80">
              <span className="font-semibold">You cannot approve this one.</span> {plain(request.cannotApproveWhy) || 'Someone else must answer it.'}
            </div>
          )}

          {actionable && (secretFields.length > 0 || questions.length > 0 || unanswerable) && (
            <section aria-labelledby="req-inputs-title" className="space-y-3 rounded-lg border border-slate-200 p-3" data-nav-ignore="">
              <h3 id="req-inputs-title" className="text-sm font-semibold text-navy">
                Before you approve
              </h3>
              {secretFields.map((f) => {
                const single = !f.parts?.length;
                const boxes = secretBoxes(f).map((b) => {
                  const boxId = single ? `secret-${f.kind}` : `secret-${f.kind}-${b.name}`;
                  const key = `${f.kind}:${b.name}`;
                  return (
                    <div key={b.name}>
                      <Label htmlFor={boxId}>{b.label}</Label>
                      <Input
                        id={boxId}
                        type={b.type}
                        autoComplete="off"
                        spellCheck={false}
                        aria-describedby="secret-help"
                        ref={(el) => {
                          secretInputs.current[key] = el;
                        }}
                        onChange={(e) => {
                          const has = e.currentTarget.value.length > 0;
                          setFilled((prev) => (Boolean(prev[key]) === has ? prev : { ...prev, [key]: has }));
                        }}
                      />
                    </div>
                  );
                });
                return (
                  <div key={`${f.kind}-${secretRound}`} data-secret-field={f.kind}>
                    {single ? (
                      boxes
                    ) : (
                      <fieldset className="space-y-2">
                        <legend className="mb-1 text-[13px] font-semibold text-navy/80">{f.label}</legend>
                        {boxes}
                      </fieldset>
                    )}
                    {f.help && <p className="mt-1 text-xs text-navy/50">{f.help}</p>}
                    {f.kind === 'mail_password' && mail && <MailServer server={mail} />}
                  </div>
                );
              })}
              {secretFields.length > 0 && (
                <p id="secret-help" className="text-xs text-navy/50">
                  Used for this one approval only. Ironbooks does not keep it, and the agent never sees it.
                </p>
              )}
              {questions.map((q) => (
                <QuestionField key={q.id} q={q} value={answers[q.id]} onChange={(v) => setAnswers((prev) => ({ ...prev, [q.id]: v }))} />
              ))}
              {unanswerable && (
                <p role="alert" className="text-sm text-red-600">
                  This request asks for a password without saying which one, so it cannot be approved here. Deny it and ask the agent to try another
                  way.
                </p>
              )}
            </section>
          )}

          {actionable && grantForm && (mode === 'similar' || request.kind === 'grant') && grantOffered && (
            <ApproveSimilar request={request} form={grantForm} onChange={setGrantForm} now={now} error={grantError} rebuilt={stale ? grantRebuilt : null} />
          )}
          {actionable && fresh && request.kind === 'grant' && !grantOffered && (
            <p role="note" className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-navy/80">
              {grantNeverHere(request.needs)
                ? `${grantNeverHere(request.needs)} Deny it, and let the agent ask each time.`
                : request.needs?.grantAdminOnly && request.needs.grantable !== 'no'
                  ? 'Only an Admin can give this standing permission. Deny it, or ask an Admin to answer it.'
                  : 'You cannot give standing permission for this kind of work. Deny it, or let the agent ask each time.'}
            </p>
          )}

          {actionable && mode === 'deny' && (
            <section aria-labelledby="req-deny-title" className="space-y-1 rounded-lg border border-slate-200 p-3">
              <h3 id="req-deny-title" className="text-sm font-semibold text-navy">
                Deny this request
              </h3>
              <Label htmlFor="deny-note">Note for the agent (optional)</Label>
              <textarea
                id="deny-note"
                autoFocus
                rows={3}
                maxLength={1000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-navy outline-none transition-shadow focus:border-electric focus:ring-4 focus:ring-electric/20 placeholder:text-navy/35"
                placeholder="Why not, or what to do instead"
              />
              <p className="text-xs text-navy/50">The agent reads this note. Nothing is done.</p>
            </section>
          )}

          {/* Not repeated when the request, loaded again, already says the same as how it ended. */}
          {failure && !(!actionable && plain(request.error).trim() === failure.trim()) && (
            <p role="alert" data-approve-failure="" className="whitespace-pre-wrap break-words rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {/* The boxes were emptied by the send: say to type again, unless the server already says what to type. */}
              {approveFailureText(failure, secretFields.length > 0 && actionable)}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
