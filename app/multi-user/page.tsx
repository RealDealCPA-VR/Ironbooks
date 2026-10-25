'use client';
/**
 * Multi-user — QuickBooks Enterprise-style hosting for this company file.
 *
 *  - Hosting (desktop app on the host computer): share the file with people on your tailnet.
 *  - Who is logged in: active sessions (owner/admin), with "Sign out".
 *  - Single-user mode: required by Condense, Restore, Rebuild and Import while others are on.
 *  - Client side: "Open company on host…" / "Disconnect".
 */
import { useCallback, useEffect, useState } from 'react';
import { Users, Server, Lock, Unlock, LogOut, Link2, Copy } from 'lucide-react';
import { Badge, Button, Card, PageHeader, PageSkeleton, ConfirmDialog, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';

interface Session {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  remoteAddr: string | null;
  userAgent: string | null;
  viaHost: boolean;
  createdAt: string;
  lastSeenAt: string;
  isCurrent: boolean;
}
interface SessionsResponse {
  isAdmin: boolean;
  currentSessionId: string | null;
  activeWindowMinutes: number;
  sessions: Session[];
  connectedCount: number;
  singleUser: { sessionId: string; userName: string; enabledAt: string; isYou: boolean } | null;
}
interface HostingStatus {
  available: boolean;
  hosting: boolean;
  urls: string[];
  tls: boolean;
  dnsName: string | null;
  tailnetIp: string | null;
  port: number;
  bindAll: boolean;
  /** Office-network multi-user mode (a company file on the shared drive; teammates pin this computer's certificate). */
  lan?: boolean;
  /** A single company file is open here (office-network multi-user mode needs one). */
  companyFile?: boolean;
  error: string | null;
  remoteHost: string | null;
}
interface HostingBridge {
  isDesktop?: boolean;
  onMenu?: (cb: (action: string) => void) => () => void;
  hosting?: {
    status: () => Promise<HostingStatus | null>;
    setEnabled: (enable: boolean, mode?: 'office') => Promise<HostingStatus>;
    openConnect: () => Promise<unknown>;
    disconnect: () => Promise<unknown>;
  };
}

function bridge(): HostingBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { bookkeeper?: HostingBridge }).bookkeeper;
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return new Date(iso).toLocaleString();
}

export default function MultiUserPage() {
  const [data, setData] = useState<SessionsResponse | null>(null);
  const [hosting, setHosting] = useState<HostingStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmOthers, setConfirmOthers] = useState(false);
  const [confirmSingle, setConfirmSingle] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get<SessionsResponse>('/api/sessions'));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load sessions.', 'danger');
    }
    const h = bridge()?.hosting;
    if (h) h.status().then(setHosting).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    const off = bridge()?.onMenu?.((action) => {
      if (action === 'hosting-changed') load();
    });
    return () => {
      clearInterval(timer);
      if (typeof off === 'function') off();
    };
  }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Something went wrong.', 'danger');
    } finally {
      setBusy(null);
      load();
    }
  }

  if (!data) {
    return (
      <div className="p-8 max-w-4xl mx-auto w-full">
        <PageHeader title="Multi-user" icon={Users} />
        <PageSkeleton rows={6} />
      </div>
    );
  }

  const single = data.singleUser;
  const others = data.sessions.filter((s) => !s.isCurrent);
  // People working through this computer's hosting (they are disconnected when it stops).
  const remoteNames = [...new Set(others.filter((s) => s.viaHost).map((s) => s.userName))];
  const stopHosting = () =>
    run(
      'host',
      () => bridge()!.hosting!.setEnabled(false),
      hosting?.lan ? 'Single-user mode: others now have to ask to come in.' : 'Multi-user access stopped.',
    );

  return (
    <div className="p-8 max-w-4xl mx-auto w-full">
      <PageHeader title="Multi-user" icon={Users} />

      {/* ---- Hosting (desktop only) ---- */}
      {hosting && hosting.remoteHost && (
        <Card className="p-6 mb-6">
          <p className="text-lg font-bold text-navy flex items-center gap-2">
            <Link2 className="h-5 w-5 text-electric" /> Connected to a host
          </p>
          <p className="text-sm text-navy/60 mt-1">
            You are working in the company file hosted at <span className="font-mono">{hosting.remoteHost}</span>.
            The data stays on that computer.
          </p>
          <div className="mt-4">
            <Button variant="secondary" onClick={() => bridge()?.hosting?.disconnect()}>
              Disconnect and open my local company
            </Button>
          </div>
        </Card>
      )}

      {hosting && hosting.available && (
        <Card className="p-6 mb-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-lg font-bold text-navy flex items-center gap-2">
                <Server className="h-5 w-5 text-electric" /> Host multi-user access
              </p>
              <p className="text-sm text-navy/60 mt-1 max-w-xl">
                {hosting.lan
                  ? 'Multi-user mode is on for your office network: teammates who open this company file from the shared drive are connected to it through this computer. Keep Ironbooks open here while they work.'
                  : hosting.companyFile
                    ? 'In an office, keep the company file on a shared drive. While you are in it, anyone else who opens it asks you to let them in; Switch to Multi-user Mode lets them straight in. To work with people outside the office, host it on your private Tailscale network instead. Either way up to 40 people can work at the same time, each with their own user name.'
                    : 'In an office, keep the company file on a shared drive: when someone else opens it while you are in it, Ironbooks asks you to let them in (multi-user mode on your office network). To work with people outside the office, host it here for your private Tailscale network. Either way up to 40 people can work at the same time, each with their own user name.'}
              </p>
            </div>
            <Badge tone={hosting.hosting ? 'success' : 'neutral'}>{hosting.hosting ? 'Hosting' : 'Off'}</Badge>
          </div>

          {hosting.hosting && (
            <div className="mt-4 rounded-xl bg-slate-50 border border-slate-200 p-4">
              <p className="text-sm font-semibold text-navy mb-2">
                {hosting.lan
                  ? 'Teammates just open the company file from the shared drive; Ironbooks connects them to this computer at'
                  : 'On each teammate’s computer: File → Open company on host…, then enter'}
              </p>
              {hosting.urls.map((u) => (
                <div key={u} className="flex items-center gap-2">
                  <code className="text-sm text-navy">{u}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => navigator.clipboard?.writeText(u).then(() => toast('Copied.', 'success'))}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <p className="text-xs text-navy/50 mt-2">
                {hosting.lan
                  ? "Encrypted (HTTPS) with this computer's own certificate. Teammates' Ironbooks checks it is exactly this computer before connecting."
                  : hosting.tls
                    ? 'Encrypted with a Tailscale HTTPS certificate.'
                    : 'Plain HTTP inside your tailnet (Tailscale encrypts all traffic between devices). Enable HTTPS certificates in the Tailscale admin console for an extra layer.'}
                {hosting.bindAll && ' Listening on all network interfaces (private addresses only).'}
              </p>
            </div>
          )}
          {hosting.error && !hosting.hosting && (
            <p className="mt-4 text-sm text-red-600">{hosting.error}</p>
          )}

          <div className="mt-4 flex gap-2">
            {hosting.hosting ? (
              <Button
                variant="secondary"
                loading={busy === 'host'}
                onClick={() => (remoteNames.length > 0 ? setConfirmSingle(true) : stopHosting())}
              >
                {hosting.lan ? 'Switch to Single-user Mode' : 'Stop hosting'}
              </Button>
            ) : hosting.companyFile ? (
              <>
                <Button
                  loading={busy === 'office'}
                  disabled={!data.isAdmin}
                  onClick={() => run('office', () => bridge()!.hosting!.setEnabled(true, 'office'))}
                >
                  Switch to Multi-user Mode
                </Button>
                <Button
                  variant="secondary"
                  loading={busy === 'host'}
                  disabled={!data.isAdmin}
                  onClick={() => run('host', () => bridge()!.hosting!.setEnabled(true))}
                >
                  Host on Tailscale
                </Button>
              </>
            ) : (
              <Button
                loading={busy === 'host'}
                disabled={!data.isAdmin}
                onClick={() => run('host', () => bridge()!.hosting!.setEnabled(true))}
              >
                Start hosting
              </Button>
            )}
            <Button variant="ghost" onClick={() => bridge()?.hosting?.openConnect()}>
              Open company on another host…
            </Button>
          </div>
        </Card>
      )}

      {/* ---- Single-user mode ---- */}
      <Card className="p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-lg font-bold text-navy flex items-center gap-2">
              {single ? <Lock className="h-5 w-5 text-gold" /> : <Unlock className="h-5 w-5 text-navy/40" />}
              Keep everyone else out
            </p>
            <p className="text-sm text-navy/60 mt-1 max-w-xl">
              {single
                ? single.isYou
                  ? 'You have the company file to yourself. Others are kept out until you let them back in.'
                  : `${single.userName} is keeping everyone else out of the company file for maintenance.`
                : "Condense Data, Restore, Rebuild Data and Import need everyone else out of the company file (QuickBooks' single-user mode). While this is on, nobody else can sign in."}
            </p>
          </div>
          <Badge tone={single ? 'warning' : 'neutral'}>{single ? 'On' : 'Off'}</Badge>
        </div>
        {data.isAdmin && (
          <div className="mt-4 flex gap-2">
            {single ? (
              <Button
                variant="secondary"
                loading={busy === 'single'}
                onClick={() =>
                  run('single', () => api.post('/api/single-user', { enabled: false }), 'Others can sign in again.')
                }
              >
                Let others back in
              </Button>
            ) : (
              <Button
                loading={busy === 'single'}
                disabled={!data.currentSessionId}
                title={data.currentSessionId ? undefined : 'Sign in with a user account to keep everyone else out.'}
                onClick={() =>
                  run('single', () => api.post('/api/single-user', { enabled: true }), 'Everyone else is kept out.')
                }
              >
                Keep everyone else out
              </Button>
            )}
            {!single && others.length > 0 && (
              <Button variant="danger" onClick={() => setConfirmOthers(true)}>
                Sign out everyone else
              </Button>
            )}
          </div>
        )}
      </Card>

      {/* ---- Who is logged in ---- */}
      <h2 className="text-lg font-bold text-navy mb-1">Who is logged in</h2>
      <p className="text-sm text-navy/60 mb-3">
        {data.connectedCount} {data.connectedCount === 1 ? 'session' : 'sessions'} active in the last{' '}
        {data.activeWindowMinutes} minutes.
        {!data.isAdmin && ' Only an owner or admin can see who.'}
      </p>
      <Card className="p-0 overflow-hidden">
        {data.sessions.length === 0 ? (
          <p className="p-6 text-sm text-navy/50">
            No signed-in sessions. (Working without a user account? Add users under Settings to use
            multi-user mode.)
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-navy/60 text-left">
              <tr>
                <th className="px-4 py-2 font-medium">User</th>
                <th className="px-4 py-2 font-medium">From</th>
                <th className="px-4 py-2 font-medium">Signed in</th>
                <th className="px-4 py-2 font-medium">Last activity</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.sessions.map((s) => (
                <tr key={s.id}>
                  <td className="px-4 py-2">
                    <span className="font-medium text-navy">{s.userName}</span>{' '}
                    {s.isCurrent && <Badge tone="info">you</Badge>}
                    {single?.sessionId === s.id && <Badge tone="warning">single-user</Badge>}
                    <div className="text-xs text-navy/40">{s.userEmail}</div>
                  </td>
                  <td className="px-4 py-2 text-navy/70">
                    {s.viaHost ? <span className="font-mono text-xs">{s.remoteAddr}</span> : 'This computer'}
                  </td>
                  <td className="px-4 py-2 text-navy/60 whitespace-nowrap">{new Date(s.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-2 text-navy/60 whitespace-nowrap">{ago(s.lastSeenAt)}</td>
                  <td className="px-4 py-2 text-right">
                    {!s.isCurrent && data.isAdmin && (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy === s.id}
                        onClick={() =>
                          run(s.id, () => api.del(`/api/sessions/${s.id}`), `${s.userName} was signed out.`)
                        }
                      >
                        <LogOut className="h-4 w-4" /> Sign out
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <ConfirmDialog
        open={confirmSingle}
        title={hosting?.lan ? 'Switch to single-user mode?' : 'Stop hosting?'}
        message={`${remoteNames.join(', ')} ${remoteNames.length === 1 ? 'is' : 'are'} working in this company file from another computer and will be disconnected. Ask them to finish what they are entering first: anything they have not saved is lost.`}
        confirmLabel={hosting?.lan ? 'Switch to Single-user Mode' : 'Stop hosting'}
        tone="danger"
        onClose={() => setConfirmSingle(false)}
        onConfirm={() => {
          setConfirmSingle(false);
          stopHosting();
        }}
      />
      <ConfirmDialog
        open={confirmOthers}
        title="Sign out everyone else?"
        message={`${others.length} other ${others.length === 1 ? 'session' : 'sessions'} will be signed out. Unsaved work in their open windows will be lost.`}
        confirmLabel="Sign them out"
        tone="danger"
        onClose={() => setConfirmOthers(false)}
        onConfirm={() => {
          setConfirmOthers(false);
          run('others', () => api.post('/api/sessions', { action: 'sign-out-others' }), 'Other users were signed out.');
        }}
      />
    </div>
  );
}
