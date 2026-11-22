'use client';
/**
 * Agent requests: the approval center (plan 7.2, AGENT_ACCESS.md "Full access").
 *
 * When an agent's permissions say "Ask" for something it wants to do, the request waits here for a
 * person. The list shows each one in plain words: the agent, what the request does (built by
 * Ironbooks from the operation, never from the agent's text), its kind of work, amount ("Unknown"
 * for work that may move money when Ironbooks could not work it out), age, what approving it needs,
 * a mark when it needs a yes again (the books changed since the agent asked, or an approval sent it
 * back with a note), and its status. Rows this person cannot approve stay listed, greyed, with the
 * reason. Opening a row shows the card
 * (RequestCard.tsx): the agent's reason in its own words, what Ironbooks worked out it would do,
 * and Approve once, Approve similar… and Deny.
 *
 * Approving several at once is offered only for new entries and changes of the same kind of work
 * that Ironbooks could try ahead of time and that one person may approve alone, here (plan 11.2: a
 * prompt-injected agent's many asks must not be one click away); the confirmation lists every one,
 * and each is approved and reported on its own. What is chosen is checked again against the list
 * as it now stands, every time it changes.
 *
 * Who may approve what is decided by the server (lib/services/agentRequests.ts, through
 * GET /api/agent-requests and the routes beside it); this page only presents it. A link may add
 * ?id=<request> to open that request's card at once, and ?agentId=<agent> to start with that
 * agent's requests (the Agents tab's links; the title-bar badge and the desktop notice open the
 * list itself). Both are read from the address as it changes, not only when the page opens: a link
 * followed while the page is already open (the Ask AI panel's "Open in Agent requests") opens its
 * card or changes the filter. Once a card is opened from ?id=, the address drops it, so the same
 * link followed again opens the card again. A link never swaps out a card while its answer is on
 * its way or while it shows a secret the run produced: the request from the link opens once the
 * person closes that card. If someone else answered that request meanwhile, its card opens all the
 * same and shows where it stands (RequestCard loads its own copy first, and nothing on the list's
 * older copy can be answered).
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Bot, RefreshCw } from 'lucide-react';
import { Badge, Button, Card, Label, Modal, PageHeader, PageSkeleton, Select, Table, Td, Th, Tr, toast } from '@/components/ui';
import { api } from '@/lib/client';
import { AREAS, type Area } from '@/lib/permissions/model';
import { RISK_CLASSES, RISK_CLASS_LABELS, type RiskClass } from '@/lib/agent/operations/types';
import type { AgentRequestForPerson, ApproveResult } from '@/lib/agent/contract';
import RequestCard, { type CardHold } from './RequestCard';
import { NeedsChips } from './Preview';
import ProducedSecrets from './ProducedSecrets';
import { requestsChanged } from './notify';
import {
  AMOUNT_UNKNOWN_WHY,
  BATCH_MAX,
  STATUS_FILTERS,
  ageText,
  amountShown,
  amountText,
  batchBlock,
  batchChoice,
  isId,
  isWaiting,
  plain,
  staleKind,
  statusLabel,
  statusTone,
  type StatusFilter,
} from './words';

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : 'Something went wrong';
}

/**
 * Said on a row the server (or an approval here) marks as changed since the agent asked (plan 7.4).
 * Not exported: a Next page file exports only its page.
 */
const STALE_ROW_MARK = 'The books changed since the agent asked. Open it to see what would happen now: it needs your approval again.';
/** The same, for a request an approval sent back with a note instead of running it (words.ts staleKind). */
const SENT_BACK_ROW_MARK = 'An approval sent this back with a note before it ran. Open it to read the note: it needs your approval again.';

/** The agent filter's entry for an agent named by a link whose name is not known here. */
const LINKED_AGENT = 'The agent from the link';

/** How one request of a batch went, in a few words. */
function batchOutcome(r: ApproveResult): string {
  switch (r.status) {
    case 'executed':
      return 'Done.';
    case 'failed':
      return `Did not go through. ${plain(r.request.error) || 'Nothing was changed.'}`;
    case 'needs_second_approver':
      return 'Recorded. A second person must also approve it.';
    case 'stale':
      // The approval can also send a tried request back with a note (the closing date moved since
      // the ask, for one): said as the row and the card say it (words.ts staleKind).
      return staleKind(r.request) === 'note'
        ? 'Not done: Ironbooks sent this back with a note before it ran. Open it to read the note, then approve it on its own.'
        : 'Not done: the books changed since the agent asked. Open it to see what would happen now.';
    case 'not_approved':
      return `Not approved, and nothing was done. ${plain(r.request.error) || 'It is still waiting: open it to answer it on its own.'}`;
  }
}

export default function AgentRequestsPage() {
  // The page reads its address (useSearchParams), which needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <AgentRequestsContent />
    </Suspense>
  );
}

function AgentRequestsContent() {
  const [status, setStatus] = useState<StatusFilter>('pending');
  const [requests, setRequests] = useState<AgentRequestForPerson[] | null>(null);
  const [error, setError] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [classFilter, setClassFilter] = useState<RiskClass | ''>('');
  const [areaFilter, setAreaFilter] = useState<Area | ''>('');
  const [selected, setSelected] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  // Requests an approval here was told the books changed for, for a server that does not mark
  // them itself (request.stale). Only for the list's mark and the batch rule: a card never starts
  // from it (RequestCard.tsx), so a later Approve is always checked against the books again.
  const [staleIds, setStaleIds] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  // What a batch approval did. Held only while its dialog is open: it can carry produced secrets.
  const [batchResults, setBatchResults] = useState<ApproveResult[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ requests: AgentRequestForPerson[] }>(`/api/agent-requests?status=${encodeURIComponent(status)}`);
      setRequests(Array.isArray(res?.requests) ? res.requests : []);
      setError('');
    } catch (e) {
      setError(errMsg(e));
      setRequests([]);
    }
  }, [status]);
  useEffect(() => {
    load();
  }, [load]);

  // A link that names one request (?id=) opens its card; one that names an agent (?agentId=, the
  // Agents tab's link) shows that agent's requests. Read each time the address changes, so a link
  // followed while the page is open works too. Only well-formed ids.
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const linkedId = params?.get('id') ?? null;
  const linkedAgent = params?.get('agentId') ?? null;
  // Whether the open card may not be swapped now (RequestCard CardHold), and the request a link
  // named meanwhile: it opens once the person closes that card, so an answer on its way, or a
  // secret shown only on that card, is never lost to a link.
  const cardHold = useRef<CardHold>(null);
  const nextId = useRef<string | null>(null);
  const onHold = useCallback((hold: CardHold) => {
    cardHold.current = hold;
  }, []);
  const closeCard = useCallback(() => {
    const next = nextId.current;
    nextId.current = null;
    cardHold.current = null;
    setOpenId(next);
  }, []);
  useEffect(() => {
    if (!isId(linkedId)) return;
    const id = linkedId.toLowerCase();
    if (openId && openId !== id && cardHold.current) {
      nextId.current = id;
      toast(
        cardHold.current === 'busy'
          ? 'Ironbooks is still answering the request that is open. The one from the link opens when you close it.'
          : 'The request that is open shows a secret that is not shown again. The one from the link opens when you close it.',
        'info',
      );
    } else {
      nextId.current = null;
      setOpenId(id);
    }
    // Drop ?id= from the address (keeping the rest), so following the same link again is a change.
    const rest = new URLSearchParams(params?.toString() ?? '');
    rest.delete('id');
    const query = rest.toString();
    router.replace(`${pathname || '/agent-requests'}${query ? `?${query}` : ''}`, { scroll: false });
    // Only a new ?id= opens a card; the rest is read when it is used.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedId]);
  useEffect(() => {
    if (isId(linkedAgent)) setAgentFilter(linkedAgent.toLowerCase());
  }, [linkedAgent]);

  /** A request changed on its card (or in a batch): show it as it now stands. */
  const changed = useCallback((r: AgentRequestForPerson, stale: boolean) => {
    setRequests((prev) => (prev ? prev.map((x) => (x.id === r.id ? r : x)) : prev));
    setStaleIds((prev) => {
      if (stale) return prev.includes(r.id) ? prev : [...prev, r.id];
      return isWaiting(r.status) ? prev : prev.filter((x) => x !== r.id);
    });
    if (r.status !== 'pending' || !r.canApprove) setSelected((prev) => prev.filter((x) => x !== r.id));
  }, []);

  // The list as it stands, with the requests an approval here found changed marked as such.
  const listed = useMemo(
    () => (requests ?? []).map((r) => (staleIds.includes(r.id) && r.stale !== true && isWaiting(r.status) ? { ...r, stale: true } : r)),
    [requests, staleIds],
  );

  // Every agent seen since the page opened, so a chosen agent stays in the filter when another
  // status has no request of theirs.
  const [agentNames, setAgentNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!requests?.length) return;
    setAgentNames((prev) => {
      const missing = requests.filter((r) => prev[r.agentId] === undefined);
      if (missing.length === 0) return prev;
      const next = { ...prev };
      for (const r of missing) next[r.agentId] = plain(r.agentName);
      return next;
    });
  }, [requests]);
  // An agent named by a link with nothing in this list: its name from its newest request of any
  // status, asked once, so the filter says whose requests it shows.
  const lookedUp = useRef(new Set<string>());
  useEffect(() => {
    if (!agentFilter || requests === null || agentNames[agentFilter] !== undefined || lookedUp.current.has(agentFilter)) return;
    lookedUp.current.add(agentFilter);
    let live = true;
    api
      .get<{ requests: AgentRequestForPerson[] }>(`/api/agent-requests?status=all&agentId=${encodeURIComponent(agentFilter)}&limit=1`)
      .then((res) => {
        const found = (Array.isArray(res?.requests) ? res.requests : []).find((r) => r.agentId === agentFilter);
        if (live && found) setAgentNames((prev) => (prev[found.agentId] === undefined ? { ...prev, [found.agentId]: plain(found.agentName) } : prev));
      })
      .catch(() => {
        // The filter still works; it is only named less well.
      });
    return () => {
      live = false;
    };
  }, [agentFilter, agentNames, requests]);
  const agents = useMemo(() => Object.entries(agentNames).sort((a, b) => a[1].localeCompare(b[1])), [agentNames]);
  const agentName = agentFilter ? (agentNames[agentFilter] ?? null) : null;

  const shown = listed.filter(
    (r) => (!agentFilter || r.agentId === agentFilter) && (!classFilter || r.class === classFilter) && (!areaFilter || r.area === areaFilter),
  );
  // What is chosen, checked again against the list as it stands now: only these are listed and sent.
  const chosen = batchChoice(listed, selected);
  const chosenOperation = chosen[0]?.operation ?? null;

  // A chosen request that no longer qualifies (answered meanwhile, moved to a stricter kind of
  // work or marked changed by "the books changed", gone after Refresh) drops out of the choice.
  useEffect(() => {
    if (!requests) return;
    setSelected((prev) => {
      const keep = batchChoice(listed, prev).map((r) => r.id);
      return keep.length === prev.length ? prev : keep;
    });
  }, [requests, listed]);

  function toggle(r: AgentRequestForPerson, on: boolean) {
    setSelected((prev) => {
      if (!on) return prev.filter((x) => x !== r.id);
      if (prev.includes(r.id) || prev.length >= BATCH_MAX) return prev;
      return [...prev, r.id];
    });
  }

  async function approveChosen() {
    const ids = chosen.map((r) => r.id);
    if (ids.length === 0) return;
    setBatchBusy(true);
    try {
      const res = await api.post<{ results: ApproveResult[] }>('/api/agent-requests/batch-approve', { ids }, { noUndo: true });
      const results = Array.isArray(res?.results) ? res.results : [];
      for (const r of results) changed(r.request, r.status === 'stale');
      requestsChanged();
      setSelected([]);
      setConfirming(false);
      setBatchResults(results);
      const done = results.filter((r) => r.status === 'executed').length;
      toast(done === results.length ? `${done} done.` : `${done} of ${results.length} done. See what happened to the others.`, done === results.length ? 'success' : 'info');
    } catch (e) {
      toast(errMsg(e), 'danger');
    } finally {
      setBatchBusy(false);
    }
  }

  const openRequest = openId ? (listed.find((r) => r.id === openId) ?? null) : null;
  const filtered = !!agentFilter || !!classFilter || !!areaFilter;

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Agent requests"
        icon={Bot}
        action={
          <Button variant="secondary" onClick={() => load()} title="Look for new requests">
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
          </Button>
        }
      />
      <Card className="mb-4 p-4 text-sm text-navy/70">
        <p>
          An agent asks here before it does something its permissions do not let it do on its own. Open a request to see what it would do, worked
          out by Ironbooks, before you approve or deny it.
        </p>
        <p className="mt-1 text-xs text-navy/50">
          The agent&apos;s reason is shown in quotes. It is the agent&apos;s explanation, not a fact Ironbooks has checked. What an agent may do
          without asking is set in{' '}
          <Link href="/users" className="text-electric underline">
            Users &amp; Roles &gt; Agents
          </Link>
          .
        </p>
      </Card>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-56">
          <Label htmlFor="ar-status">Status</Label>
          <Select
            id="ar-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as StatusFilter);
              setSelected([]);
            }}
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-56">
          <Label htmlFor="ar-agent">Agent</Label>
          <Select id="ar-agent" value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)}>
            <option value="">All agents</option>
            {agents.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
            {agentFilter && agentName === null && <option value={agentFilter}>{LINKED_AGENT}</option>}
          </Select>
        </div>
        <div className="w-56">
          <Label htmlFor="ar-class">Kind of work</Label>
          <Select id="ar-class" value={classFilter} onChange={(e) => setClassFilter(e.target.value as RiskClass | '')}>
            <option value="">All kinds</option>
            {RISK_CLASSES.map((c) => (
              <option key={c} value={c}>
                {RISK_CLASS_LABELS[c]}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-56">
          <Label htmlFor="ar-area">Area</Label>
          <Select id="ar-area" value={areaFilter} onChange={(e) => setAreaFilter(e.target.value as Area | '')}>
            <option value="">All areas</option>
            {AREAS.map((a) => (
              <option key={a.key} value={a.key}>
                {a.label}
              </option>
            ))}
          </Select>
        </div>
        {chosen.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" onClick={() => setSelected([])}>
              Clear
            </Button>
            <Button onClick={() => setConfirming(true)}>Approve chosen ({chosen.length})…</Button>
          </div>
        )}
      </div>

      {error && <Card className="mb-4 p-4 text-sm text-red-600">{error}</Card>}

      {requests === null ? (
        <PageSkeleton />
      ) : shown.length === 0 ? (
        !error && (
          <Card className="p-6 text-center text-sm text-navy/50">
            {status === 'pending' && !filtered
              ? 'Nothing is waiting for you. When an agent asks to do something that needs a person, it shows up here.'
              : agentFilter
                ? `No requests from ${agentName ?? 'this agent'} match. Choose another status, or All agents.`
                : 'No requests match.'}
          </Card>
        )
      ) : (
        <Card className="p-0">
          <Table>
            <thead>
              <tr>
                <Th className="w-10">
                  <span className="sr-only">Choose to approve together</span>
                </Th>
                <Th>Agent</Th>
                <Th>Request</Th>
                <Th>Kind of work</Th>
                <Th numeric>Amount</Th>
                <Th>Asked</Th>
                <Th>Status</Th>
                <Th className="text-right">
                  <span className="sr-only">Open</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const isChosen = chosen.some((c) => c.id === r.id);
                const block = isChosen
                  ? null
                  : (batchBlock(r, chosenOperation) ??
                    (chosen.length >= BATCH_MAX ? `At most ${BATCH_MAX} requests can be approved together.` : null));
                const summary = plain(r.summary);
                const waiting = isWaiting(r.status);
                const isStale = r.stale === true && waiting;
                const amount = amountShown(r);
                const whyId = `ar-why-${r.id}`;
                // While some are chosen, say on screen why this one cannot join them (its own reason
                // is already shown when this person cannot approve it at all).
                const showWhy = block !== null && chosen.length > 0 && waiting && r.canApprove;
                return (
                  <Tr
                    key={r.id}
                    data-list-label={`${plain(r.agentName)} ${summary}`}
                    data-request-row={r.id}
                    // Greyed: still waiting, but for someone else to answer.
                    className={waiting && !r.canApprove ? 'opacity-60' : ''}
                  >
                    <Td className="w-10">
                      {/* Not `disabled`: a disabled box cannot take the keyboard's focus, and its reason would never be heard. */}
                      <input
                        type="checkbox"
                        aria-label={`Choose to approve together: ${summary}`}
                        aria-disabled={block !== null ? true : undefined}
                        aria-describedby={block !== null ? whyId : undefined}
                        title={block ?? 'Choose to approve together'}
                        className={block !== null ? 'cursor-not-allowed opacity-40' : undefined}
                        checked={isChosen}
                        onChange={(e) => {
                          if (block !== null) {
                            toast(block, 'info');
                            return;
                          }
                          toggle(r, e.target.checked);
                        }}
                      />
                    </Td>
                    <Td>
                      <span className="font-semibold">{plain(r.agentName)}</span>
                    </Td>
                    <Td>
                      <span className="block break-words">{summary}</span>
                      <NeedsChips needs={r.needs} />
                      {isStale && (
                        <span data-stale-mark={staleKind(r)} className="mt-1 block text-xs font-semibold text-amber-700">
                          {staleKind(r) === 'note' ? SENT_BACK_ROW_MARK : STALE_ROW_MARK}
                        </span>
                      )}
                      {!r.canApprove && waiting && (
                        <span className="mt-1 block text-xs text-navy/60">{plain(r.cannotApproveWhy) || 'You cannot approve this one.'}</span>
                      )}
                      {block !== null && (
                        <span id={whyId} data-batch-why="" className={showWhy ? 'mt-1 block text-xs text-navy/60' : 'sr-only'}>
                          {showWhy ? 'Not with the chosen ones: ' : 'Cannot be chosen to approve together: '}
                          {block}
                        </span>
                      )}
                    </Td>
                    <Td>
                      <Badge tone="info">{RISK_CLASS_LABELS[r.class] ?? plain(r.class)}</Badge>
                    </Td>
                    <Td numeric>
                      {amount?.unknown ? (
                        <span data-amount-unknown="" className="text-xs text-navy/60" title={AMOUNT_UNKNOWN_WHY}>
                          Unknown
                        </span>
                      ) : (
                        (amount?.text ?? '')
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-sm" title={new Date(r.createdAt).toLocaleString()}>
                      {ageText(r.createdAt)}
                    </Td>
                    <Td>
                      <Badge tone={statusTone(r)}>{statusLabel(r)}</Badge>
                    </Td>
                    <Td className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => setOpenId(r.id)} title="Open this request">
                        Open
                      </Button>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}

      {openId && (
        <RequestCard key={openId} id={openId} initial={openRequest} onClose={closeCard} onChanged={changed} onHold={onHold} />
      )}

      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Approve ${chosen.length} ${chosen.length === 1 ? 'request' : 'requests'}`}
        size="lg"
        confirmChanges={false}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button loading={batchBusy} disabled={chosen.length === 0} onClick={approveChosen}>
              Approve all {chosen.length}
            </Button>
          </>
        }
      >
        <p className="text-sm text-navy/70">
          Each one is approved and carried out on its own, as if you approved it from its card. Read the list: approving many at once is where
          mistakes slip through.
        </p>
        <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto" data-batch-list="">
          {chosen.map((r) => (
            <li key={r.id} className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-navy">
              <span className="font-semibold">{plain(r.agentName)}</span>: {plain(r.summary)}
              {r.amount ? <span className="ml-2 tabular-nums text-navy/70">{amountText(r.amount)}</span> : null}
            </li>
          ))}
        </ul>
      </Modal>

      {batchResults && (
        <Modal
          open
          onClose={() => setBatchResults(null)}
          title="What happened"
          size="lg"
          confirmChanges={false}
          footer={
            <Button variant="secondary" onClick={() => setBatchResults(null)}>
              Close
            </Button>
          }
        >
          <ul className="space-y-2" data-batch-results="">
            {batchResults.map((r, i) => (
              <li key={`${r.request.id}-${i}`} data-batch-result={r.status} className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-navy">
                <div>{plain(r.request.summary)}</div>
                <div className={r.status === 'executed' ? 'text-emerald' : r.status === 'failed' ? 'text-red-600' : 'text-amber-700'}>{batchOutcome(r)}</div>
                {r.produced?.length ? (
                  <div className="mt-2">
                    <ProducedSecrets produced={r.produced} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </main>
  );
}
