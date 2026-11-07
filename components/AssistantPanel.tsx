'use client';

/**
 * Bookkeeping assistant slide-over. Plain-language questions; answers are computed from the
 * company's own reports (read-only tools) and cite their sources. Any write the assistant
 * proposes appears as a card that the user must Approve (posted through the normal journal
 * service) or Reject.
 */
import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, Bot, ChevronDown, ChevronRight, Cloud, Send, Sparkles, Wifi, X } from 'lucide-react';
import { Badge, Button, Spinner, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatCurrency } from '@/lib/money';

interface ProposalLine {
  accountCode: string;
  accountName: string;
  /** Customer / vendor on the line (QB Name column), when the proposal carries one. */
  entityName?: string | null;
  debit: string | null;
  credit: string | null;
  memo: string | null;
}

interface Proposal {
  id: string;
  kind: string;
  summary: string;
  status: string;
  payload: { date: string; description: string; lines: ProposalLine[]; totalDebit: string };
  resultRef: string | null;
}

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

interface Reply {
  answer: string;
  toolCalls: ToolCall[];
  proposals: Proposal[];
  unverifiedNumbers: string[];
  mode: 'llm' | 'offline';
  providerId?: string;
  redacted?: boolean;
  notice?: string;
}

type Msg = { role: 'user'; content: string } | { role: 'assistant'; content: string; reply: Reply };

/** The last conversation, kept on this computer so closing the panel does not lose it. */
const THREAD_KEY = 'ironbooks.assistant.thread';
const MAX_SAVED = 40;

function loadThread(): Msg[] {
  try {
    const raw = window.localStorage.getItem(THREAD_KEY);
    const parsed = raw ? (JSON.parse(raw) as Msg[]) : [];
    return Array.isArray(parsed) ? parsed.slice(-MAX_SAVED) : [];
  } catch {
    return [];
  }
}

function saveThread(msgs: Msg[]) {
  try {
    if (msgs.length === 0) window.localStorage.removeItem(THREAD_KEY);
    else window.localStorage.setItem(THREAD_KEY, JSON.stringify(msgs.slice(-MAX_SAVED)));
  } catch {
    /* private window, blocked storage: the thread just is not kept */
  }
}

/**
 * Send a question and read the streamed reply (app/api/ai/assistant?stream=1): tool steps arrive
 * as the model reads reports, then the reply. Falls back to the plain JSON route when the
 * stream cannot be read.
 */
async function askStreaming(
  body: { message: string; history: { role: string; content: string }[] },
  onStep: (label: string) => void,
): Promise<Reply> {
  const res = await fetch('/api/ai/assistant?stream=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, typeof data.error === 'string' ? data.error : 'The assistant could not answer.', typeof data.code === 'string' ? data.code : undefined, data);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reply: Reply | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const lineText = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!lineText) continue;
      const ev = JSON.parse(lineText) as { type: string } & Record<string, unknown>;
      if (ev.type === 'step') onStep(TOOL_LABELS[String(ev.tool)] ?? String(ev.tool));
      else if (ev.type === 'reply') reply = ev as unknown as Reply;
      else if (ev.type === 'error') throw new ApiError(Number(ev.status ?? 500), String(ev.error ?? 'The assistant could not answer.'), typeof ev.code === 'string' ? ev.code : undefined, ev);
    }
  }
  if (!reply) throw new ApiError(500, 'The assistant did not answer.');
  return reply;
}

const STARTERS = [
  'How did we do this month?',
  'Who owes us money?',
  'Which bills are overdue?',
  'What is our cash balance?',
];

const TOOL_LABELS: Record<string, string> = {
  profit_and_loss: 'Profit & Loss',
  balance_sheet: 'Balance Sheet',
  ar_aging: 'A/R Aging',
  ap_aging: 'A/P Aging',
  account_balances: 'Account balances',
  list_accounts: 'Chart of accounts',
  search_transactions: 'Transaction search',
};

function Sources({ calls }: { calls: ToolCall[] }) {
  const [open, setOpen] = React.useState(false);
  if (calls.length === 0) return null;
  return (
    <div className="mt-2 text-xs">
      <button type="button" className="inline-flex items-center gap-1 text-navy/50 hover:text-electric" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Sources: {calls.map((c) => TOOL_LABELS[c.tool] ?? c.tool).join(', ')}
      </button>
      {open && (
        <div className="mt-1 space-y-2">
          {calls.map((c, i) => (
            <div key={i} className="rounded-lg bg-slate-50 border border-slate-100 p-2">
              <div className="font-semibold text-navy/70">
                {TOOL_LABELS[c.tool] ?? c.tool}{' '}
                <span className="font-normal text-navy/40">{Object.keys(c.args).length ? JSON.stringify(c.args) : ''}</span>
              </div>
              {c.error ? (
                <div className="text-red-500">{c.error}</div>
              ) : (
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] text-navy/60">
                  {JSON.stringify(c.result, null, 1)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProposalCard({ p, onChange }: { p: Proposal; onChange: (p: Proposal) => void }) {
  const [busy, setBusy] = React.useState<'approve' | 'reject' | null>(null);
  async function act(action: 'approve' | 'reject') {
    setBusy(action);
    try {
      const r = await api.post<{ proposal: Proposal }>(`/api/ai/proposals/${p.id}`, { action });
      onChange(r.proposal);
      toast(action === 'approve' ? 'Journal entry posted.' : 'Proposal dismissed.', action === 'approve' ? 'success' : 'info');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Action failed.', 'danger');
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="mt-2 rounded-xl border border-gold/40 bg-gold/5 p-3 text-xs">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="font-semibold text-navy">Proposed journal entry · {p.payload.date}</span>
        <Badge tone={p.status === 'approved' ? 'success' : p.status === 'rejected' ? 'neutral' : 'warning'}>
          {p.status === 'pending' ? 'Needs your approval' : p.status}
        </Badge>
      </div>
      <div className="text-navy/70 mb-2">{p.payload.description}</div>
      <table className="w-full">
        <thead>
          <tr className="text-navy/40">
            <th className="text-left font-medium">Account</th>
            <th className="text-right font-medium">Debit</th>
            <th className="text-right font-medium">Credit</th>
          </tr>
        </thead>
        <tbody>
          {p.payload.lines.map((l, i) => (
            <tr key={i} className="text-navy">
              <td>
                {l.accountCode} {l.accountName}
                {l.entityName ? <span className="text-navy/50"> · {l.entityName}</span> : null}
              </td>
              <td className="text-right tabular-nums">{l.debit ? formatCurrency(l.debit) : ''}</td>
              <td className="text-right tabular-nums">{l.credit ? formatCurrency(l.credit) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.status === 'pending' ? (
        <div className="mt-3 flex gap-2 justify-end">
          <Button size="sm" variant="secondary" loading={busy === 'reject'} disabled={!!busy} onClick={() => act('reject')}>
            Reject
          </Button>
          <Button size="sm" loading={busy === 'approve'} disabled={!!busy} onClick={() => act('approve')}>
            Approve &amp; post
          </Button>
        </div>
      ) : p.status === 'approved' && p.resultRef ? (
        <div className="mt-2 text-emerald font-semibold">
          Posted. <Link href="/journal" className="underline">View in Journal</Link>
        </div>
      ) : null}
    </div>
  );
}

export default function AssistantPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [messages, setMessages] = React.useState<Msg[]>([]);
  const [input, setInput] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  /** What the model is reading right now ("Looking at Profit & Loss…"). */
  const [stepLabel, setStepLabel] = React.useState<string | null>(null);
  /** Proposals from earlier conversations still waiting for an answer. */
  const [pending, setPending] = React.useState<Proposal[]>([]);
  const restored = React.useRef(false);
  const endRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  React.useEffect(() => {
    if (!open) return;
    if (!restored.current) {
      restored.current = true;
      setMessages(loadThread());
    }
    // Proposals the model made earlier (this or another session) that nobody has answered yet.
    api
      .get<{ proposals: Proposal[] }>('/api/ai/proposals?status=pending')
      .then((r) => setPending(r.proposals))
      .catch(() => setPending([]));
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { role: 'user', content: message }]);
    setInput('');
    setBusy(true);
    setStepLabel(null);
    try {
      const reply = await askStreaming({ message, history }, (label) => setStepLabel(label));
      setMessages((prev) => {
        const next: Msg[] = [...prev, { role: 'assistant', content: reply.answer, reply }];
        saveThread(next);
        return next;
      });
      if (reply.proposals.length) setPending((p) => p.filter((x) => !reply.proposals.some((n) => n.id === x.id)));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'The assistant could not answer.', 'danger');
      setMessages((prev) => prev.slice(0, -1));
      setInput(message);
    } finally {
      setBusy(false);
      setStepLabel(null);
    }
  }

  function clearThread() {
    setMessages([]);
    saveThread([]);
  }

  function updateProposal(msgIdx: number, p: Proposal) {
    setMessages((prev) =>
      prev.map((m, i) =>
        i === msgIdx && m.role === 'assistant'
          ? { ...m, reply: { ...m.reply, proposals: m.reply.proposals.map((x) => (x.id === p.id ? p : x)) } }
          : m,
      ),
    );
  }

  if (!open) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 top-[var(--titlebar-h)] z-40 flex justify-end" role="dialog" aria-modal="true" aria-label="Bookkeeping assistant">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative z-10 h-full w-full max-w-md bg-white shadow-2xl border-l border-slate-100 flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-electric/10 text-electric flex items-center justify-center">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <div className="font-bold text-navy leading-tight">Ask about your books</div>
              <div className="text-[11px] text-navy/40">Answers come from your own reports</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {messages.length > 0 && (
              <button type="button" onClick={clearThread} className="text-xs text-navy/40 hover:text-navy" title="Start a new conversation">
                New chat
              </button>
            )}
            <button onClick={onClose} aria-label="Close assistant" className="text-navy/40 hover:text-navy">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {pending.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-navy/60">Waiting for your approval ({pending.length})</div>
              {pending.map((p) => (
                <ProposalCard key={p.id} p={p} onChange={(np) => setPending((prev) => (np.status === 'pending' ? prev.map((x) => (x.id === np.id ? np : x)) : prev.filter((x) => x.id !== np.id)))} />
              ))}
            </div>
          )}
          {messages.length === 0 && (
            <div className="text-sm text-navy/60">
              <p className="mb-3">
                Ask a question in plain English. I can read your reports but I can’t change anything — if you ask me to
                record something, I’ll prepare it for you to approve.
              </p>
              <p className="mb-3 text-xs text-navy/50">
                Works with ChatGPT, Claude, Gemini or a free model on this computer — set up once in{' '}
                <Link href="/ai-settings" onClick={onClose} className="text-electric underline">
                  AI &amp; Automation
                </Link>
                .
              </p>
              <div className="flex flex-wrap gap-2">
                {STARTERS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => send(s)}
                    className="rounded-full border border-electric/30 text-electric text-xs px-3 py-1 hover:bg-electric/5"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-electric text-white px-3 py-2 text-sm whitespace-pre-wrap">{m.content}</div>
              </div>
            ) : (
              <div key={i} className="max-w-[95%]">
                <div className="rounded-2xl rounded-bl-sm bg-slate-50 border border-slate-100 px-3 py-2 text-sm text-navy whitespace-pre-wrap">
                  {m.content}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {m.reply.mode === 'offline' ? (
                    <>
                      <Badge tone="neutral">Basic answer (no AI model)</Badge>
                      <Link href="/ai-settings" onClick={onClose} className="text-[11px] text-electric underline">
                        Connect your AI for full answers
                      </Link>
                    </>
                  ) : m.reply.redacted ? (
                    <Badge tone="warning">
                      <Cloud className="inline h-3 w-3 mr-1" />
                      Cloud · names hidden
                    </Badge>
                  ) : (
                    <Badge tone="success">
                      <Wifi className="inline h-3 w-3 mr-1" />
                      Local model
                    </Badge>
                  )}
                </div>
                {m.reply.notice && <div className="mt-1 text-[11px] text-navy/50">{m.reply.notice}</div>}
                {m.reply.unverifiedNumbers.length > 0 && (
                  <div className="mt-1 flex items-start gap-1 text-[11px] text-yellow-800">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
                    Couldn’t verify {m.reply.unverifiedNumbers.join(', ')} against your reports — double-check before relying on it.
                  </div>
                )}
                <Sources calls={m.reply.toolCalls} />
                {m.reply.proposals.map((p) => (
                  <ProposalCard key={p.id} p={p} onChange={(np) => updateProposal(i, np)} />
                ))}
              </div>
            ),
          )}
          {busy && (
            <div className="flex items-center gap-2 text-sm text-navy/50" role="status">
              <Spinner className="h-4 w-4" /> {stepLabel ? `Looking at ${stepLabel}…` : 'Thinking…'}
            </div>
          )}
          <div ref={endRef} />
        </div>

        <form
          className="border-t border-slate-100 p-3 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <textarea
            ref={inputRef}
            rows={2}
            value={input}
            maxLength={4000}
            placeholder="e.g. What were our biggest expenses last month?"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            className="flex-1 resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm text-navy outline-none focus:border-electric focus:ring-2 focus:ring-electric/30"
          />
          <Button type="submit" size="sm" disabled={busy || !input.trim()} aria-label="Send">
            <Send className="h-4 w-4" />
          </Button>
        </form>
        <div className="px-4 pb-3 text-[10px] text-navy/30 flex items-center gap-1">
          <Sparkles className="h-3 w-3" /> Configure models in <Link href="/ai-settings" className="underline" onClick={onClose}>AI &amp; Automation</Link>
        </div>
      </div>
    </div>
  );
}
