'use client';
/**
 * Try it on a copy (sandbox mode) — lib/services/sandbox.ts.
 *
 * In the real books: one click copies the whole company file and opens the app on the copy.
 * In the sandbox: leave by discarding the copy or keeping it as a training file.
 * In a training file: explains how to get back to the real books.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { FlaskConical, Trash2, Save, RotateCcw, ShieldCheck, Ban } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Input,
  Label,
  Modal,
  PageHeader,
  PageSkeleton,
  toast,
  toastError,
} from '@/components/ui';
import {
  discardSandbox,
  fetchSandboxBanner,
  keepSandbox,
  resumeLeftoverSandbox,
  startSandbox,
  type SandboxBannerStatus,
  type SandboxStatus,
} from '@/lib/sandboxClient';
import { ApiError } from '@/lib/client';

const OFF_IN_SANDBOX = [
  'Sending email (invoices, statements, reminders)',
  'Bank feed downloads',
  'Scheduled reports',
  'Automatic backups of your real file',
  'App update prompts (desktop)',
];

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export default function SandboxPage() {
  const [banner, setBanner] = useState<SandboxBannerStatus | null>(null);
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [denied, setDenied] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | 'start' | 'discard' | 'keep' | string>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [keepOpen, setKeepOpen] = useState(false);
  const [keepName, setKeepName] = useState('');
  const [keepError, setKeepError] = useState<string | null>(null);
  const [deleteLeftover, setDeleteLeftover] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const b = await fetchSandboxBanner();
    setBanner(b);
    try {
      const res = await fetch('/api/sandbox', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setStatus(data as SandboxStatus);
        setDenied(null);
      } else {
        setStatus(null);
        setDenied((data && data.error) || 'You do not have access to this.');
      }
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(kind: string, fn: () => Promise<unknown>) {
    setBusy(kind);
    try {
      await fn();
    } catch (err) {
      toastError(err);
      setBusy(null);
    }
  }

  async function onKeep() {
    setKeepError(null);
    if (!keepName.trim()) {
      setKeepError('Give the training file a name.');
      return;
    }
    setBusy('keep');
    try {
      const r = await keepSandbox(keepName.trim());
      toast(`Kept as the training file "${r.name}". You are back in your real books.`, 'success');
    } catch (err) {
      setKeepError(err instanceof ApiError || err instanceof Error ? err.message : 'The copy could not be kept.');
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="p-8 max-w-3xl mx-auto w-full">
        <PageHeader title="Try it on a copy" icon={FlaskConical} />
        <PageSkeleton rows={4} />
      </div>
    );
  }

  const inSandbox = Boolean(banner?.active && banner.kind === 'sandbox');
  const inTraining = Boolean(banner?.active && banner.kind === 'training');

  return (
    <div className="p-8 max-w-3xl mx-auto w-full">
      <PageHeader title="Try it on a copy" icon={FlaskConical} />

      {inTraining && (
        <Card className="p-6">
          <h2 className="text-lg font-bold text-navy mb-2">This is a training file</h2>
          <p className="text-sm text-navy/70 mb-3">
            {status?.trainingName ? <>&ldquo;{status.trainingName}&rdquo; is </> : 'This is '}a practice copy of
            {status?.sourceName ? <> &ldquo;{status.sourceName}&rdquo;</> : ' your company file'}. Nothing you do here
            changes your real books, and emails, bank feeds, scheduled reports and automatic backups stay off.
          </p>
          <p className="text-sm text-navy/70">
            To go back to your real books, open your real company file from the{' '}
            <Link href="/company-file" className="text-electric font-semibold hover:underline">
              Company File
            </Link>{' '}
            page (desktop: File &gt; Open Company or Recent Companies).
          </p>
        </Card>
      )}

      {inSandbox && (
        <>
          <Card className="p-6 mb-6 border-2 border-orange-400">
            <div className="flex items-start gap-3">
              <FlaskConical className="h-6 w-6 text-orange-600 shrink-0 mt-0.5" aria-hidden="true" />
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-navy">You are working in the sandbox</h2>
                <p className="text-sm text-navy/70 mt-1">
                  This is a copy of {status?.sourceName ? <>&ldquo;{status.sourceName}&rdquo;</> : 'your company file'}
                  {status?.createdAt ? <> made {when(status.createdAt)}</> : null}. Try anything you like — your real books
                  are not touched. When you are done, choose what happens to the copy. Nothing is ever copied back.
                </p>
                {status?.realFileFound === false && (
                  <p className="text-sm text-red-600 mt-2" role="alert">
                    Your real company file cannot be found right now (is its drive connected?). Reconnect it before
                    leaving the sandbox.
                  </p>
                )}
              </div>
            </div>
          </Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card className="p-5 flex flex-col">
              <h3 className="font-bold text-navy flex items-center gap-2">
                <Trash2 className="h-4 w-4 text-red-500" aria-hidden="true" /> Discard sandbox
              </h3>
              <p className="text-sm text-navy/70 mt-1 flex-1">
                Throw the copy away and go back to your real books exactly as you left them.
              </p>
              <Button variant="danger" className="mt-4 self-start" loading={busy === 'discard'} onClick={() => setConfirmDiscard(true)}>
                Discard sandbox
              </Button>
            </Card>
            <Card className="p-5 flex flex-col">
              <h3 className="font-bold text-navy flex items-center gap-2">
                <Save className="h-4 w-4 text-electric" aria-hidden="true" /> Keep as a training file
              </h3>
              <p className="text-sm text-navy/70 mt-1 flex-1">
                Save the copy as its own practice company file (next to your real one), then go back to your real books.
                It is never merged into them.
              </p>
              <Button
                variant="secondary"
                className="mt-4 self-start"
                loading={busy === 'keep'}
                onClick={() => {
                  setKeepName(status?.sourceName ? `${status.sourceName} - Training` : 'Training');
                  setKeepError(null);
                  setKeepOpen(true);
                }}
              >
                Keep as a training file…
              </Button>
            </Card>
          </div>
        </>
      )}

      {!banner?.active && (
        <>
          <Card className="p-6 mb-6">
            <h2 className="text-lg font-bold text-navy">Practise or test a change without risk</h2>
            <p className="text-sm text-navy/70 mt-1">
              One click makes a complete copy of your company file (every company in it) and opens Ironbooks on the copy.
              An orange <strong>SANDBOX</strong> bar stays at the top of every page, and anything you print is stamped
              &ldquo;SANDBOX&rdquo;. Your real books are not changed while you are there.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg bg-slate-50 p-3 text-sm text-navy/80">
                <p className="font-semibold text-navy flex items-center gap-2 mb-1">
                  <Ban className="h-4 w-4 text-orange-600" aria-hidden="true" /> Turned off in the sandbox
                </p>
                <ul className="list-disc pl-5 space-y-0.5">
                  {OFF_IN_SANDBOX.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded-lg bg-slate-50 p-3 text-sm text-navy/80">
                <p className="font-semibold text-navy flex items-center gap-2 mb-1">
                  <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden="true" /> When you leave
                </p>
                <ul className="list-disc pl-5 space-y-0.5">
                  <li>Discard the copy, or</li>
                  <li>Keep it as a training file with a name you choose.</li>
                  <li>Nothing is ever copied back into your real books.</li>
                </ul>
              </div>
            </div>
            {denied ? (
              <p className="text-sm text-navy/70 mt-4 flex items-center gap-2" role="note">
                <Ban className="h-4 w-4 shrink-0" aria-hidden="true" />
                Only an Admin of every company in this file can make a sandbox copy.
              </p>
            ) : (
              <Button className="mt-5" loading={busy === 'start'} onClick={() => run('start', startSandbox)}>
                <FlaskConical className="h-4 w-4" aria-hidden="true" />
                Try it on a copy
              </Button>
            )}
            <p className="text-xs text-navy/50 mt-3">
              Everyone else must be signed out first. In a web browser (not the desktop app) the sandbox lasts until the
              Ironbooks server restarts; the copy then shows below so you can open it again or delete it.
            </p>
          </Card>

          {status && status.leftovers.length > 0 && (
            <Card className="p-6">
              <h2 className="text-lg font-bold text-navy mb-1">Copies left over</h2>
              <p className="text-sm text-navy/70 mb-3">Sandbox copies of this file that were never discarded.</p>
              <ul className="divide-y divide-slate-100">
                {status.leftovers.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                    <span className="text-sm text-navy">
                      Copy of {l.sourceName} <Badge tone="neutral">{when(l.createdAt)}</Badge>
                    </span>
                    <span className="flex gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busy === `resume:${l.id}`}
                        onClick={() => run(`resume:${l.id}`, () => resumeLeftoverSandbox(l.id))}
                      >
                        <RotateCcw className="h-4 w-4" aria-hidden="true" /> Open it again
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleteLeftover(l.id)}>
                        <Trash2 className="h-4 w-4" aria-hidden="true" /> Delete
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmDiscard}
        title="Discard the sandbox?"
        message="The copy and everything you did in it will be deleted, and you will go back to your real books. This cannot be undone."
        confirmLabel="Discard sandbox"
        tone="danger"
        loading={busy === 'discard'}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          run('discard', async () => {
            await discardSandbox();
            toast('Sandbox discarded. You are back in your real books.', 'success');
          });
        }}
      />

      <ConfirmDialog
        open={deleteLeftover !== null}
        title="Delete this copy?"
        message="The left-over sandbox copy will be deleted. Your real books are not affected."
        confirmLabel="Delete copy"
        tone="danger"
        onClose={() => setDeleteLeftover(null)}
        onConfirm={async () => {
          const id = deleteLeftover;
          setDeleteLeftover(null);
          if (!id) return;
          try {
            const res = await fetch(`/api/sandbox/leftovers/${encodeURIComponent(id)}`, { method: 'DELETE' });
            if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'The copy could not be deleted.');
            toast('Copy deleted.', 'success');
            load();
          } catch (err) {
            toastError(err);
          }
        }}
      />

      <Modal
        open={keepOpen}
        onClose={() => setKeepOpen(false)}
        title="Keep as a training file"
        footer={
          <>
            <Button variant="secondary" onClick={() => setKeepOpen(false)}>
              Cancel
            </Button>
            <Button loading={busy === 'keep'} onClick={onKeep}>
              Keep and go back to my books
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onKeep();
          }}
        >
          <Label htmlFor="sandbox-keep-name">Name for the training file</Label>
          <Input
            id="sandbox-keep-name"
            value={keepName}
            maxLength={80}
            onChange={(e) => setKeepName(e.target.value)}
            aria-invalid={keepError ? true : undefined}
            aria-describedby="sandbox-keep-help"
            autoFocus
          />
          <p id="sandbox-keep-help" className={`text-xs mt-2 ${keepError ? 'text-red-600' : 'text-navy/60'}`} role={keepError ? 'alert' : undefined}>
            {keepError ??
              'It is saved next to your real company file and opens like any other company file (File > Open Company). It stays a practice copy: emails and bank feeds stay off there too.'}
          </p>
        </form>
      </Modal>
    </div>
  );
}
