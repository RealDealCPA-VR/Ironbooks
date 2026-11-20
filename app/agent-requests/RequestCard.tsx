'use client';
/**
 * Agent requests: the approval card (plan 4.3, 4.4, 5.8, 7.2, 7.4, 11.2).
 *
 * First who asked and why, in the agent's own words: shown in quotes under "The agent says", as
 * text only, never as fact (an outsider's words can reach the agent through a vendor name or an
 * emailed PDF and steer it). Then what Ironbooks itself worked out from a trial run (Preview.tsx):
 * the summary, the ledger, the record changes, what would leave the computer, warnings and what is
 * lost. Then what the approval needs: a password field for each secret, the questions a desktop
 * flow would have asked. Then Approve once, Approve similar… (standing permission,
 * ApproveSimilar.tsx, hidden when this person may give none) and Deny with a note the agent reads.
 *
 * Secrets typed here (plan 5.8) live only in their password fields. They are read when Approve is
 * pressed, sent with that one approval, and the fields are emptied and replaced at once: never in
 * React state, never logged, never stored. A second approval (after the books changed) asks for
 * them again. Secrets the run produced are shown once and live only in this card's state, so they
 * are gone when it closes; the page never sees them.
 *
 * The server decides everything again (who may approve, the time limit of standing permission,
 * whether the books changed); this card only asks, and fails closed: anything it cannot show or
 * pass on safely is not approvable here. Approve waits for the card's own fresh copy of the
 * request: the list's copy may be old.
 *
 * "The books changed" (plan 7.4) is only ever said, and acceptStale only ever sent, after THIS card
 * got a 'stale' answer and showed the new preview: the next Approve is the person's yes to that
 * preview. A card opened later starts over with a plain Approve, and the server checks the books
 * again and answers 'stale' once more when they moved.
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
import RequestPreview, { NeedsChips } from './Preview';
import ApproveSimilar from './ApproveSimilar';
import ProducedSecrets from './ProducedSecrets';
import { requestsChanged } from './notify';
import {
  ageText,
  amountText,
  canGiveGrant,
  clockTime,
  constraintLines,
  durationLabel,
  flowQuestionsOf,
  grantFromForm,
  initialGrantForm,
  isWaiting,
  plain,
  postedEntryIds,
  reasonText,
  secretFieldsOf,
  type GrantForm,
} from './words';

/** What the card says once the books changed between the ask and the approval (plan 7.4). */
export const STALE_MESSAGE = 'The books changed since the agent asked. This is what would happen now.';

/** Said on a request that asks to see full values (plan 5.9, D6). */
export const REVEAL_NOTE =
  'The agent asks to see full values, such as full Social Security or account numbers. If you approve, it sees them for this one request, and what an agent reads is sent to the AI service that runs it, as it is.';

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : 'Something went wrong';
}

const sectionTitle = 'mb-1 text-xs font-semibold uppercase tracking-wide text-navy/50';

/** An answer that came back from Approve, other than "the books changed". */
interface Outcome {
  status: Exclude<ApproveResult['status'], 'stale'>;
  produced: ProducedSecret[];
  effects: EffectReport[];
  /**
   * Standing permission was asked for with it, for this many minutes. Whether it was given is the
   * request's grantId: the run can go through while the permission is not made.
   */
  grantMinutes: number | null;
  at: Date;
}

/** How a request that was already answered stands, in one line. */
function decidedText(r: AgentRequestForPerson): string | null {
  const by = r.decidedByName ? plain(r.decidedByName) : '';
  const second = r.secondApproverName ? plain(r.secondApproverName) : '';
  switch (r.status) {
    case 'executed':
      return `Done${by ? `, approved by ${by}` : ''}${second ? ` and ${second}` : ''}.`;
    case 'approved':
      return `Approved${by ? ` by ${by}` : ''}. A second person must also approve before it runs.`;
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
 * Links to what an approved run entered, taken from the run's own answer (words.ts postedEntryIds),
 * and the audit trail. Never from the preview: its entries came from a trial run that was rolled
 * back, so they do not exist.
 */
function DoneLinks({ request }: { request: AgentRequestForPerson }) {
  const entries = postedEntryIds(request);
  return (
    <ul className="mt-1 space-y-0.5">
      {entries.map((id, i) => (
        <li key={id}>
          <Link href={sourceFormHref(id, '/agent-requests')} className="text-electric underline">
            {entries.length === 1 ? 'Open the entry it posted' : `Open entry ${i + 1} of ${entries.length} it posted`}
          </Link>
        </li>
      ))}
      {request.file && <li className="text-navy/80">It made a file: {plain(request.file.name)}</li>}
      <li>
        <Link href="/audit-trail" className="text-electric underline">
          See it in the Audit Trail
        </Link>
      </li>
    </ul>
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

export default function RequestCard({
  id,
  initial,
  onClose,
  onChanged,
}: {
  id: string;
  /** The list's copy, shown while the card loads the latest. Never approvable by itself. */
  initial: AgentRequestForPerson | null;
  onClose: () => void;
  /** The request as it now stands, for the list (never with what the run produced). */
  onChanged: (request: AgentRequestForPerson, stale: boolean) => void;
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
  // Whether each password field has something in it. Never the value itself.
  const [filled, setFilled] = React.useState<Partial<Record<SecretKind, boolean>>>({});
  // New password fields after every send: the old elements, and anything that remembered their
  // value by element (the field-level undo of components/KeyboardBase.tsx), go away with them.
  const [secretRound, setSecretRound] = React.useState(0);
  const [grantForm, setGrantForm] = React.useState<GrantForm | null>(null);
  const [grantError, setGrantError] = React.useState('');
  const [now] = React.useState(() => new Date());
  const secretInputs = React.useRef<Partial<Record<SecretKind, HTMLInputElement | null>>>({});
  const resultRef = React.useRef<HTMLDivElement>(null);
  const onChangedRef = React.useRef(onChanged);
  onChangedRef.current = onChanged;

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
  const secretsReady = secretFields.every((f) => filled[f.kind]);
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

  /** Read the typed secrets and empty their fields: from here on they exist only in the request being sent. */
  function takeSecrets(): Partial<Record<SecretKind, string>> {
    const out: Partial<Record<SecretKind, string>> = {};
    for (const f of secretFields) {
      const el = secretInputs.current[f.kind];
      if (!el) continue;
      if (el.value) out[f.kind] = el.value;
      el.value = '';
    }
    secretInputs.current = {};
    setFilled({});
    setSecretRound((n) => n + 1);
    return out;
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
    const secrets = takeSecrets();
    if (Object.keys(secrets).length) body.secrets = secrets;
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
        setMode(withGrant ? 'similar' : 'main');
      } else {
        setStale(false);
        setMode('main');
        setOutcome({ status: r.status, produced: r.produced ?? [], effects: r.effects ?? [], grantMinutes, at: new Date() });
      }
      window.setTimeout(() => resultRef.current?.focus(), 0);
    } catch (e) {
      setFailure(errMsg(e));
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
                  ? 'Approve what would happen now, and similar'
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
            {stale ? 'Approve what would happen now' : 'Approve once'}
          </Button>
        </>
      );
    }
  }

  const title = request ? `Request from ${plain(request.agentName)}` : 'Agent request';
  const reason = request ? reasonText(request.reason) : '';
  const decided = request && outcome === null ? decidedText(request) : null;
  const amount = request ? amountText(request.amount) : '';

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
                {outcome.grantMinutes && request.grantId ? (
                  <p className="mt-0.5">
                    {plain(request.agentName)} may do more of the same without asking for {durationLabel(outcome.grantMinutes)}, until about{' '}
                    {clockTime(new Date(outcome.at.getTime() + outcome.grantMinutes * 60_000))}. You can take it back in Users &amp; Roles &gt; Agents.
                  </p>
                ) : outcome.grantMinutes ? (
                  <p data-grant-not-given="" className="mt-0.5 text-amber-800">
                    It was done, but standing permission was not given, so {plain(request.agentName)} will ask again next time.
                  </p>
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
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <div className="font-semibold">{STALE_MESSAGE}</div>
                <p className="mt-0.5">Nothing was done. Read it again below, and approve once more only if it is still right.</p>
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
                {request.status === 'executed' && request.kind === 'operation' && <DoneLinks request={request} />}
              </div>
            )}
          </div>
          {/* Outside the status region above: a screen reader announces only its heading, never the value. */}
          {outcome && <ProducedSecrets produced={outcome.produced} />}

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
                {amount && <span className="tabular-nums">Amount {amount}</span>}
                <span>Asked {ageText(request.createdAt).toLowerCase()}</span>
                {isWaiting(request.status) && <span>Waits until {formatDate(request.expiresAt, 'MMM d, yyyy h:mm a')}</span>}
              </div>
              <NeedsChips needs={request.needs} />
            </div>
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
            {request.kind === 'operation' && <RequestPreview preview={request.preview} />}
            {request.input && (
              <details className="text-xs text-navy/60">
                <summary className="cursor-pointer">What the agent sent, as it sent it</summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-slate-200 bg-slate-50 p-2 font-mono">
                  {plain(JSON.stringify(request.input, null, 2)).slice(0, 4000)}
                </pre>
              </details>
            )}
          </section>

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
              {secretFields.map((f) => (
                <div key={`${f.kind}-${secretRound}`}>
                  <Label htmlFor={`secret-${f.kind}`}>{f.label}</Label>
                  <Input
                    id={`secret-${f.kind}`}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby="secret-help"
                    ref={(el) => {
                      secretInputs.current[f.kind] = el;
                    }}
                    onChange={(e) => {
                      const has = e.currentTarget.value.length > 0;
                      setFilled((prev) => (Boolean(prev[f.kind]) === has ? prev : { ...prev, [f.kind]: has }));
                    }}
                  />
                </div>
              ))}
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
            <ApproveSimilar request={request} form={grantForm} onChange={setGrantForm} now={now} error={grantError} />
          )}
          {actionable && fresh && request.kind === 'grant' && !grantOffered && (
            <p role="note" className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-navy/80">
              You cannot give standing permission for this kind of work. Deny it, or let the agent ask each time.
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

          {failure && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {failure}
              {secretFields.length > 0 && actionable ? ' Type the password again to try once more.' : ''}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
