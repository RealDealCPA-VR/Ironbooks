'use client';
/**
 * Privacy & Network — the company's local-only network policy (lib/net/policy.ts).
 *
 * Plain-language view of what (if anything) can leave this computer, the three modes
 * (offline / local network + tailnet / allow chosen cloud services), the per-service cloud
 * opt-ins, and the recent outbound activity log. Owners/admins can change it; everyone can see it.
 */
import { useCallback, useEffect, useState } from 'react';
import { Network, ShieldCheck, WifiOff, Cloud, Check, X } from 'lucide-react';
import { Badge, Button, Card, PageHeader, PageSkeleton, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';

type Mode = 'offline' | 'tailnet-only' | 'allow-cloud';
type Purpose = 'ai' | 'email' | 'bank-feeds' | 'updates';

interface Decision {
  allowed: boolean;
  reason: string;
  host: string;
}
interface PurposeRow {
  purpose: Purpose;
  label: string;
  sends: string;
  destinations: string;
  cloud: Decision;
}
interface LogEntry {
  at: string;
  purpose: Purpose;
  host: string;
  hostClass: string;
  allowed: boolean;
  reason: string;
}
interface PolicyResponse {
  policy: { mode: Mode; cloudOptIn: Record<Purpose, boolean> };
  canEdit: boolean;
  ceiling: Mode | null;
  effectiveMode: Mode;
  purposes: PurposeRow[];
  recent: LogEntry[];
}

const MODES: { id: Mode; title: string; body: string; icon: typeof WifiOff }[] = [
  {
    id: 'offline',
    title: 'Offline',
    body: 'Nothing leaves this computer. Email, bank feeds, AI and update checks are all off.',
    icon: WifiOff,
  },
  {
    id: 'tailnet-only',
    title: 'Local network + tailnet (recommended)',
    body:
      'Connections stay on your own network and your private Tailscale network — for example multi-user hosting, a mail relay or an AI model on a computer you own. Nothing goes to the internet except the app update check (version number only), which you can turn off below.',
    icon: ShieldCheck,
  },
  {
    id: 'allow-cloud',
    title: 'Allow cloud services I choose',
    body:
      'Same as above, plus the specific internet services you turn on below. Each one only sends what is listed, only when you use it.',
    icon: Cloud,
  },
];

interface NetworkBridge {
  network?: { refresh?: () => Promise<unknown> };
}

export default function PrivacyNetworkPage() {
  const [data, setData] = useState<PolicyResponse | null>(null);
  const [mode, setMode] = useState<Mode>('tailnet-only');
  const [optIn, setOptIn] = useState<Record<Purpose, boolean>>({
    ai: false,
    email: false,
    'bank-feeds': false,
    updates: true,
  });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.get<PolicyResponse>('/api/network-policy');
      setData(d);
      setMode(d.policy.mode);
      setOptIn(d.policy.cloudOptIn);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load privacy settings.', 'danger');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dirty =
    data !== null &&
    (mode !== data.policy.mode ||
      (Object.keys(optIn) as Purpose[]).some((p) => optIn[p] !== data.policy.cloudOptIn[p]));

  async function save() {
    setSaving(true);
    try {
      const d = await api.put<PolicyResponse>('/api/network-policy', { mode, cloudOptIn: optIn });
      setData(d);
      toast('Privacy & Network settings saved.', 'success');
      // Desktop: let the window load Plaid Link only if bank feeds are now allowed.
      const b = (window as unknown as { bookkeeper?: NetworkBridge }).bookkeeper;
      b?.network?.refresh?.().catch(() => {});
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  if (!data) {
    return (
      <div className="p-8 max-w-4xl mx-auto w-full">
        <PageHeader title="Privacy & Network" icon={Network} />
        <PageSkeleton rows={6} />
      </div>
    );
  }

  const readOnly = !data.canEdit;

  return (
    <div className="p-8 max-w-4xl mx-auto w-full">
      <PageHeader title="Privacy & Network" icon={Network} />

      <Card className="p-6 mb-6">
        <p className="text-navy font-semibold">Your books stay on this computer.</p>
        <p className="text-sm text-navy/60 mt-1">
          BookKeeper AI keeps the company file on this machine and never stores client data in the
          cloud. These settings decide whether the app may connect to anything else, and for what.
          {readOnly && ' Only an owner or admin can change them.'}
        </p>
        {data.ceiling && (
          <p className="text-sm mt-3 rounded-lg bg-gold/15 text-yellow-900 px-3 py-2">
            This computer is limited to <strong>{MODES.find((m) => m.id === data.ceiling)?.title}</strong> by
            its administrator (BKA_NETWORK_MODE). Settings below cannot go beyond that.
          </p>
        )}
      </Card>

      <h2 className="text-lg font-bold text-navy mb-3">Network mode</h2>
      <div className="grid gap-3 mb-8">
        {MODES.map((m) => {
          const Icon = m.icon;
          const selected = mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              disabled={readOnly}
              onClick={() => setMode(m.id)}
              className={`text-left rounded-2xl border p-4 flex gap-4 items-start transition-colors ${
                selected ? 'border-electric bg-electric/5' : 'border-slate-200 bg-white hover:bg-slate-50'
              } disabled:cursor-default`}
              aria-pressed={selected}
            >
              <Icon className={`h-6 w-6 mt-0.5 shrink-0 ${selected ? 'text-electric' : 'text-navy/40'}`} />
              <span>
                <span className="block font-semibold text-navy">{m.title}</span>
                <span className="block text-sm text-navy/60 mt-0.5">{m.body}</span>
              </span>
            </button>
          );
        })}
      </div>

      <h2 className="text-lg font-bold text-navy mb-1">What could leave this computer</h2>
      <p className="text-sm text-navy/60 mb-3">
        Each service is off unless you turn it on here <em>and</em> choose “Allow cloud services I
        choose” above. App update checks are the exception: they send no company data, so they are on
        unless you turn them off (or choose Offline).
      </p>
      <Card className="divide-y divide-slate-100 mb-8">
        {data.purposes.map((p) => {
          // Update checks work in any mode but offline; everything else needs allow-cloud.
          const modeAllows = p.purpose === 'updates' ? mode !== 'offline' : mode === 'allow-cloud';
          const enabled = modeAllows && optIn[p.purpose];
          return (
            <div key={p.purpose} className="p-5 flex gap-4 items-start justify-between">
              <div className="min-w-0">
                <p className="font-semibold text-navy flex items-center gap-2">
                  {p.label}
                  <Badge tone={p.cloud.allowed ? 'warning' : 'success'}>
                    {p.cloud.allowed ? 'Cloud allowed' : 'Stays local'}
                  </Badge>
                </p>
                <p className="text-sm text-navy/60 mt-1">
                  <span className="font-medium text-navy/70">Sends: </span>
                  {p.sends}
                </p>
                <p className="text-xs text-navy/40 mt-1">To: {p.destinations}</p>
              </div>
              <label className="flex items-center gap-2 text-sm font-medium text-navy shrink-0 pt-1">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-electric"
                  checked={optIn[p.purpose]}
                  disabled={readOnly || !modeAllows}
                  onChange={(e) => setOptIn({ ...optIn, [p.purpose]: e.target.checked })}
                />
                {enabled ? 'On' : 'Off'}
              </label>
            </div>
          );
        })}
      </Card>

      {!readOnly && (
        <div className="flex justify-end gap-2 mb-10">
          <Button variant="secondary" disabled={!dirty || saving} onClick={load}>
            Discard changes
          </Button>
          <Button disabled={!dirty} loading={saving} onClick={save}>
            Save
          </Button>
        </div>
      )}

      <h2 className="text-lg font-bold text-navy mb-1">Recent network activity</h2>
      <p className="text-sm text-navy/60 mb-3">
        Every connection the app tried to make for this company since it started — destination and
        purpose only, never the content.
      </p>
      <Card className="p-0 overflow-hidden">
        {data.recent.length === 0 ? (
          <p className="p-6 text-sm text-navy/50">No outbound connections have been attempted.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-navy/60 text-left">
              <tr>
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Purpose</th>
                <th className="px-4 py-2 font-medium">Destination</th>
                <th className="px-4 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.recent.map((r, i) => (
                <tr key={i} title={r.reason}>
                  <td className="px-4 py-2 text-navy/60 whitespace-nowrap">{new Date(r.at).toLocaleString()}</td>
                  <td className="px-4 py-2">{r.purpose}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {r.host || '—'} <span className="text-navy/40">({r.hostClass})</span>
                  </td>
                  <td className="px-4 py-2">
                    {r.allowed ? (
                      <span className="inline-flex items-center gap-1 text-emerald"><Check className="h-4 w-4" /> Allowed</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-red-600"><X className="h-4 w-4" /> Blocked</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
