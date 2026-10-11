'use client';

/**
 * AI & Automation — per-company AI settings.
 *
 *  - Models: local models on this machine / LAN / Tailscale tailnet (Ollama, LM Studio,
 *    vLLM, llama.cpp) and optional cloud models (Anthropic Claude, OpenAI-compatible APIs).
 *    Test Connection probes the server and fills the model picker. API keys are write-only:
 *    the server stores them encrypted and only ever reports "saved".
 *  - Routing: cloud is OFF by default; each task can be local-only (default),
 *    local-then-cloud or cloud-only. Cloud calls are always redacted.
 *  - Automation: learned bank-feed auto-apply threshold and LLM second opinions.
 *  - Learned categorizer status + retrain.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Brain,
  Cloud,
  Cpu,
  Network,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Wifi,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  Input,
  Label,
  PageHeader,
  PageSkeleton,
  Select,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatDate } from '@/lib/dates';

// ---------------------------------------------------------------------------
// Types (mirror lib/services/aiSettings.ts views)
// ---------------------------------------------------------------------------

type Kind = 'ollama' | 'openai-compatible' | 'anthropic';
type Policy = 'local-only' | 'local-then-cloud' | 'cloud-only';
type Task = 'categorize' | 'assistant' | 'error-correction';

interface PublicProvider {
  id: string;
  kind: Kind;
  label: string;
  baseUrl?: string | null;
  model: string;
  enabled: boolean;
  timeoutMs?: number | null;
  hasApiKey: boolean;
  apiKeyUnreadable?: boolean;
  locality: 'local' | 'cloud';
  hostClass: string | null;
  warning: string | null;
}

interface Settings {
  providers: PublicProvider[];
  taskPolicies: Record<Task, Policy>;
  cloudEnabled: boolean;
  autoApplyEnabled: boolean;
  autoApplyThreshold: string;
  llmSuggestEnabled: boolean;
}

/** Editable row: saved providers + new drafts (no id yet). */
interface Draft {
  key: string;
  id?: string;
  kind: Kind;
  label: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyUnreadable?: boolean;
  apiKey: string;
  clearApiKey: boolean;
}

interface TestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  models: { id: string; label?: string }[];
  locality: 'local' | 'cloud';
  hostClass: string | null;
  warning: string | null;
}

interface Peer {
  hostName: string;
  dnsName: string | null;
  ips: string[];
  os: string | null;
  online: boolean;
  self: boolean;
  suggestions: { kind: Kind; label: string; baseUrl: string }[];
}

interface CategorizerInfo {
  status: {
    trained: boolean;
    docs: number;
    vocabulary: number;
    accounts: number;
    onlineAccuracy: number | null;
    onlinePredictions: number;
    trainedAt: string | null;
    updatedAt: string | null;
  };
  autoApplied: { id: string; confidence: string; createdAt: string; entryStatus: string }[];
}

const TASK_LABELS: Record<Task, string> = {
  categorize: 'Transaction categorization',
  assistant: 'Bookkeeping assistant',
  'error-correction': 'Error review suggestions',
};

const POLICY_LABELS: Record<Policy, string> = {
  'local-only': 'Local only (never leaves your network)',
  'local-then-cloud': 'Local first, cloud if local fails',
  'cloud-only': 'Cloud only',
};

const KIND_LABELS: Record<Kind, string> = {
  ollama: 'Ollama',
  'openai-compatible': 'OpenAI-compatible (LM Studio, vLLM, llama.cpp, cloud APIs)',
  anthropic: 'Anthropic Claude (cloud)',
};

let draftSeq = 0;
function newDraft(partial: Partial<Draft>): Draft {
  return {
    key: `d${++draftSeq}`,
    kind: 'ollama',
    label: '',
    baseUrl: '',
    model: '',
    enabled: true,
    hasApiKey: false,
    apiKey: '',
    clearApiKey: false,
    ...partial,
  };
}

function toDraft(p: PublicProvider): Draft {
  return newDraft({
    id: p.id,
    kind: p.kind,
    label: p.label,
    baseUrl: p.baseUrl ?? '',
    model: p.model,
    enabled: p.enabled,
    hasApiKey: p.hasApiKey,
    apiKeyUnreadable: p.apiKeyUnreadable,
  });
}

function draftBody(d: Draft) {
  return {
    ...(d.id ? { id: d.id } : {}),
    kind: d.kind,
    label: d.label.trim() || KIND_LABELS[d.kind],
    baseUrl: d.baseUrl.trim() || null,
    model: d.model.trim(),
    enabled: d.enabled,
    ...(d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : {}),
    ...(d.clearApiKey ? { clearApiKey: true } : {}),
  };
}

function HostBadge({ hostClass, locality }: { hostClass: string | null; locality: 'local' | 'cloud' }) {
  if (locality === 'cloud') {
    return (
      <Badge tone="warning">
        <Cloud className="inline h-3 w-3 mr-1" />
        Cloud · redacted
      </Badge>
    );
  }
  const label = hostClass === 'tailnet' ? 'Tailnet' : hostClass === 'loopback' ? 'This computer' : 'Local network';
  return (
    <Badge tone="success">
      <Wifi className="inline h-3 w-3 mr-1" />
      {label}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AiSettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [policies, setPolicies] = useState<Record<Task, Policy>>({
    categorize: 'local-only',
    assistant: 'local-only',
    'error-correction': 'local-only',
  });
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [autoApplyEnabled, setAutoApplyEnabled] = useState(false);
  const [threshold, setThreshold] = useState(95);
  const [llmSuggestEnabled, setLlmSuggestEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tests, setTests] = useState<Record<string, TestResult | 'running'>>({});
  const [peers, setPeers] = useState<{ available: boolean; reason?: string; peers: Peer[] } | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [cat, setCat] = useState<CategorizerInfo | null>(null);
  const [retraining, setRetraining] = useState(false);

  const apply = useCallback((s: Settings) => {
    setSettings(s);
    setDrafts(s.providers.map(toDraft));
    setPolicies(s.taskPolicies);
    setCloudEnabled(s.cloudEnabled);
    setAutoApplyEnabled(s.autoApplyEnabled);
    setThreshold(Math.round(Number(s.autoApplyThreshold) * 100));
    setLlmSuggestEnabled(s.llmSuggestEnabled);
  }, []);

  const loadCategorizer = useCallback(async () => {
    try {
      setCat(await api.get<CategorizerInfo>('/api/ai/categorizer'));
    } catch {
      /* non-critical */
    }
  }, []);

  useEffect(() => {
    api
      .get<Settings>('/api/ai/settings')
      .then(apply)
      .catch((err) => toast(err instanceof ApiError ? err.message : 'Failed to load AI settings.', 'danger'));
    loadCategorizer();
  }, [apply, loadCategorizer]);

  function patchDraft(key: string, patch: Partial<Draft>) {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }

  async function save() {
    setSaving(true);
    try {
      const s = await api.put<Settings>('/api/ai/settings', {
        providers: drafts.map(draftBody),
        taskPolicies: policies,
        cloudEnabled,
        autoApplyEnabled,
        autoApplyThreshold: (threshold / 100).toFixed(2),
        llmSuggestEnabled,
      });
      apply(s);
      toast('AI settings saved.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Save failed.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function test(d: Draft) {
    setTests((t) => ({ ...t, [d.key]: 'running' }));
    try {
      const r = await api.post<TestResult>('/api/ai/test', draftBody(d));
      setTests((t) => ({ ...t, [d.key]: r }));
      if (r.ok && !d.model && r.models[0]) patchDraft(d.key, { model: r.models[0].id });
    } catch (err) {
      setTests((t) => {
        const next = { ...t };
        delete next[d.key];
        return next;
      });
      toast(err instanceof ApiError ? err.message : 'Test failed.', 'danger');
    }
  }

  async function discover() {
    setDiscovering(true);
    try {
      setPeers(await api.get('/api/ai/tailnet'));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Discovery failed.', 'danger');
    } finally {
      setDiscovering(false);
    }
  }

  async function retrain() {
    setRetraining(true);
    try {
      const r = await api.post<{ summary: { docs: number } }>('/api/ai/categorizer', { action: 'retrain' });
      toast(`Retrained on ${r.summary.docs} categorized lines.`, 'success');
      await loadCategorizer();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Retrain failed.', 'danger');
    } finally {
      setRetraining(false);
    }
  }

  if (!settings) return <PageSkeleton />;

  const hasLocal = drafts.some((d) => d.enabled && d.kind !== 'anthropic');
  const dirty =
    JSON.stringify(drafts.map(draftBody)) !== JSON.stringify(settings.providers.map((p) => draftBody(toDraft(p)))) ||
    JSON.stringify(policies) !== JSON.stringify(settings.taskPolicies) ||
    cloudEnabled !== settings.cloudEnabled ||
    autoApplyEnabled !== settings.autoApplyEnabled ||
    threshold !== Math.round(Number(settings.autoApplyThreshold) * 100) ||
    llmSuggestEnabled !== settings.llmSuggestEnabled;

  return (
    <main className="min-h-screen bg-gradient-to-br from-offwhite via-[#e8ecf3] to-slate-100 p-8 font-sans">
      <PageHeader
        title="AI & Automation"
        icon={Sparkles}
        action={
          <Button onClick={save} loading={saving} disabled={!dirty}>
            Save changes
          </Button>
        }
      />

      <Card className="p-6 mb-6 bg-navy/[0.03]">
        <p className="text-sm text-navy/80 leading-relaxed">
          <strong>Your books stay on your computers.</strong> AI runs on a model server you control — this PC,
          your office network, or any machine on your Tailscale network (for example{' '}
          <code className="text-xs bg-white px-1 rounded">http://gpu-box.tail1234.ts.net:11434</code>). Cloud
          models are optional and off unless you turn them on below; before anything is sent to a cloud model, names,
          emails, phone numbers, tax IDs, account numbers and addresses are replaced with placeholders.
        </p>
      </Card>

      {/* ------------------------------------------------------------ Models */}
      <Card className="p-6 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="text-lg font-bold text-navy flex items-center gap-2">
            <Cpu className="h-5 w-5 text-electric" /> AI models
          </h2>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={discover} loading={discovering}>
              <Network className="h-4 w-4" /> Find models on my tailnet
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setDrafts((p) => [...p, newDraft({ kind: 'ollama', label: 'Local model', baseUrl: 'http://localhost:11434' })])}
            >
              <Plus className="h-4 w-4" /> Local model
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setDrafts((p) => [...p, newDraft({ kind: 'anthropic', label: 'Claude (cloud)', model: 'claude-sonnet-5-5' })])}
            >
              <Plus className="h-4 w-4" /> Cloud model
            </Button>
          </div>
        </div>

        {peers && (
          <div className="mb-5 rounded-xl border border-slate-200 p-4">
            {!peers.available ? (
              <p className="text-sm text-navy/60">
                Tailscale discovery unavailable: {peers.reason} You can still type a tailnet address (100.x.y.z or
                name.your-tailnet.ts.net) below.
              </p>
            ) : (
              <div className="space-y-2">
                <div className="text-xs font-bold uppercase tracking-wider text-navy/40">Machines on your tailnet</div>
                {peers.peers.map((p) => (
                  <div key={`${p.hostName}-${p.ips[0]}`} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className={`h-2 w-2 rounded-full ${p.online ? 'bg-emerald' : 'bg-slate-300'}`} />
                    <span className="font-semibold text-navy">{p.hostName}</span>
                    <span className="text-navy/40 text-xs">{p.dnsName ?? p.ips[0]}{p.self ? ' (this computer)' : ''}</span>
                    {p.online &&
                      p.suggestions.map((s) => (
                        <button
                          key={s.baseUrl}
                          type="button"
                          className="text-xs rounded-full border border-electric/30 text-electric px-2 py-0.5 hover:bg-electric/5"
                          onClick={() =>
                            setDrafts((prev) => [
                              ...prev,
                              newDraft({ kind: s.kind, label: `${s.label} on ${p.hostName}`, baseUrl: s.baseUrl }),
                            ])
                          }
                        >
                          + {s.label}
                        </button>
                      ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {drafts.length === 0 ? (
          <p className="text-sm text-navy/50 py-6 text-center">
            No AI model yet. Everything still works — suggestions come from the built-in learned categorizer, and the
            assistant answers basic questions from your reports. Add a local model for smarter help.
          </p>
        ) : (
          <div className="space-y-4">
            {drafts.map((d) => {
              const t = tests[d.key];
              const saved = settings.providers.find((p) => p.id === d.id);
              const isCloud = d.kind === 'anthropic' || (t && t !== 'running' ? t.locality === 'cloud' : saved?.locality === 'cloud');
              return (
                <div key={d.key} className="rounded-xl border border-slate-200 p-4">
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                    <div className="md:col-span-3">
                      <Label>Type</Label>
                      <Select value={d.kind} onChange={(e) => patchDraft(d.key, { kind: e.target.value as Kind })}>
                        {(Object.keys(KIND_LABELS) as Kind[]).map((k) => (
                          <option key={k} value={k}>
                            {KIND_LABELS[k]}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="md:col-span-3">
                      <Label>Name</Label>
                      <Input value={d.label} placeholder="e.g. GPU box" onChange={(e) => patchDraft(d.key, { label: e.target.value })} />
                    </div>
                    <div className="md:col-span-6">
                      <Label>{d.kind === 'anthropic' ? 'Base URL (optional)' : 'Server URL'}</Label>
                      <Input
                        value={d.baseUrl}
                        placeholder={
                          d.kind === 'ollama'
                            ? 'http://gpu-box.tail1234.ts.net:11434'
                            : d.kind === 'openai-compatible'
                              ? 'http://100.101.1.5:1234/v1'
                              : 'https://api.anthropic.com'
                        }
                        onChange={(e) => patchDraft(d.key, { baseUrl: e.target.value })}
                      />
                    </div>
                    <div className="md:col-span-4">
                      <Label>Model</Label>
                      {t && t !== 'running' && t.models.length > 0 ? (
                        <Select value={d.model} onChange={(e) => patchDraft(d.key, { model: e.target.value })}>
                          {!t.models.some((m) => m.id === d.model) && <option value={d.model}>{d.model || 'Pick a model…'}</option>}
                          {t.models.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.id}
                              {m.label ? ` (${m.label})` : ''}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <Input
                          value={d.model}
                          placeholder={d.kind === 'anthropic' ? 'claude-sonnet-5-5' : 'Test connection to list models'}
                          onChange={(e) => patchDraft(d.key, { model: e.target.value })}
                        />
                      )}
                    </div>
                    <div className="md:col-span-4">
                      <Label>API key {d.kind === 'anthropic' ? '' : '(optional)'}</Label>
                      <Input
                        type="password"
                        autoComplete="off"
                        value={d.apiKey}
                        placeholder={
                          d.apiKeyUnreadable
                            ? 'Saved key unreadable — re-enter'
                            : d.hasApiKey && !d.clearApiKey
                              ? '•••••••• saved (type to replace)'
                              : 'Not set'
                        }
                        onChange={(e) => patchDraft(d.key, { apiKey: e.target.value, clearApiKey: false })}
                      />
                      {d.hasApiKey && !d.clearApiKey && (
                        <button type="button" className="text-xs text-red-500 mt-1 hover:underline" onClick={() => patchDraft(d.key, { clearApiKey: true, apiKey: '' })}>
                          Remove saved key
                        </button>
                      )}
                    </div>
                    <div className="md:col-span-4 flex items-center gap-2 justify-end">
                      <label className="flex items-center gap-2 text-sm text-navy/70 mr-auto">
                        <input type="checkbox" checked={d.enabled} onChange={(e) => patchDraft(d.key, { enabled: e.target.checked })} />
                        Enabled
                      </label>
                      <Button variant="secondary" size="sm" loading={t === 'running'} onClick={() => test(d)}>
                        Test connection
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Remove model"
                        onClick={() => setDrafts((prev) => prev.filter((x) => x.key !== d.key))}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                    {t && t !== 'running' ? (
                      <>
                        <HostBadge hostClass={t.hostClass} locality={t.locality} />
                        {t.ok ? (
                          <Badge tone="success">Connected · {t.latencyMs} ms · {t.models.length} model(s)</Badge>
                        ) : (
                          <Badge tone="danger">Failed: {t.error}</Badge>
                        )}
                        {t.warning && (
                          <span className="inline-flex items-center gap-1 text-yellow-800 text-xs">
                            <AlertTriangle className="h-3.5 w-3.5" /> {t.warning}
                          </span>
                        )}
                      </>
                    ) : saved ? (
                      <>
                        <HostBadge hostClass={saved.hostClass} locality={saved.locality} />
                        {saved.warning && (
                          <span className="inline-flex items-center gap-1 text-yellow-800 text-xs">
                            <AlertTriangle className="h-3.5 w-3.5" /> {saved.warning}
                          </span>
                        )}
                      </>
                    ) : null}
                    {isCloud && !cloudEnabled && (
                      <span className="text-xs text-navy/50">Not used until “Allow cloud AI” is on.</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* ----------------------------------------------------------- Routing */}
      <Card className="p-6 mb-6">
        <h2 className="text-lg font-bold text-navy flex items-center gap-2 mb-4">
          <Cloud className="h-5 w-5 text-electric" /> Where AI runs
        </h2>
        <label className="flex items-start gap-3 mb-5 cursor-pointer">
          <input type="checkbox" className="mt-1" checked={cloudEnabled} onChange={(e) => setCloudEnabled(e.target.checked)} />
          <span>
            <span className="font-semibold text-navy text-sm">Allow cloud AI for this company</span>
            <span className="block text-xs text-navy/60">
              Off by default. When on, tasks set to use the cloud send REDACTED text (no names, contact details, tax IDs,
              account numbers or addresses). Cloud providers are asked not to store requests; nothing is saved by
              BookKeeper AI outside this computer.
            </span>
          </span>
        </label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {(Object.keys(TASK_LABELS) as Task[]).map((task) => (
            <div key={task}>
              <Label>{TASK_LABELS[task]}</Label>
              <Select value={policies[task]} onChange={(e) => setPolicies((p) => ({ ...p, [task]: e.target.value as Policy }))}>
                {(Object.keys(POLICY_LABELS) as Policy[]).map((p) => (
                  <option key={p} value={p} disabled={p !== 'local-only' && !cloudEnabled}>
                    {POLICY_LABELS[p]}
                  </option>
                ))}
              </Select>
            </div>
          ))}
        </div>
        {!hasLocal && (
          <p className="mt-4 text-xs text-navy/50">
            Tip: with no local model, “Local only” tasks fall back to built-in offline behavior.
          </p>
        )}
      </Card>

      {/* -------------------------------------------------------- Automation */}
      <Card className="p-6 mb-6">
        <h2 className="text-lg font-bold text-navy flex items-center gap-2 mb-4">
          <Sparkles className="h-5 w-5 text-electric" /> Automation
        </h2>
        <label className="flex items-start gap-3 mb-4 cursor-pointer">
          <input type="checkbox" className="mt-1" checked={autoApplyEnabled} onChange={(e) => setAutoApplyEnabled(e.target.checked)} />
          <span>
            <span className="font-semibold text-navy text-sm">Auto-categorize confident bank-feed transactions</span>
            <span className="block text-xs text-navy/60">
              On the Bank Review screen, “Auto-apply confident” posts lines the learned categorizer is at least this sure
              about. Each one is logged in the audit trail and can be undone with Unmatch.
            </span>
          </span>
        </label>
        <div className="flex items-center gap-4 mb-5 max-w-lg">
          <Label className="mb-0 whitespace-nowrap">Confidence threshold</Label>
          <input
            type="range"
            min={50}
            max={100}
            step={1}
            value={threshold}
            disabled={!autoApplyEnabled}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="flex-1"
          />
          <span className="font-semibold text-navy tabular-nums w-12 text-right">{threshold}%</span>
        </div>
        <label className="flex items-start gap-3 cursor-pointer">
          <input type="checkbox" className="mt-1" checked={llmSuggestEnabled} onChange={(e) => setLlmSuggestEnabled(e.target.checked)} />
          <span>
            <span className="font-semibold text-navy text-sm">Offer “Ask AI” for low-confidence transactions</span>
            <span className="block text-xs text-navy/60">
              The AI model can only pick from your existing chart of accounts, and its picks are never auto-posted.
            </span>
          </span>
        </label>
      </Card>

      {/* -------------------------------------------------- Learned categorizer */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-navy flex items-center gap-2">
            <Brain className="h-5 w-5 text-electric" /> Learned categorizer
          </h2>
          <Button variant="secondary" size="sm" onClick={retrain} loading={retraining}>
            <RefreshCw className="h-4 w-4" /> Retrain now
          </Button>
        </div>
        <p className="text-sm text-navy/60 mb-4">
          Learns from how you categorize bills, checks, expenses and bank transactions — entirely on this computer. It
          updates automatically every time you categorize something.
        </p>
        {cat ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <Stat label="Lines learned" value={cat.status.docs.toLocaleString()} />
            <Stat label="Accounts known" value={cat.status.accounts.toLocaleString()} />
            <Stat
              label="Recent accuracy"
              value={
                cat.status.onlineAccuracy === null
                  ? '—'
                  : `${Math.round(cat.status.onlineAccuracy * 100)}% (${cat.status.onlinePredictions})`
              }
            />
            <Stat label="AI auto-posted" value={String(cat.autoApplied.length)} sub={cat.status.updatedAt ? `updated ${formatDate(cat.status.updatedAt)}` : undefined} />
          </div>
        ) : (
          <p className="text-sm text-navy/40">Loading…</p>
        )}
      </Card>
    </main>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl bg-slate-50 border border-slate-100 p-3">
      <div className="text-xs text-navy/50">{label}</div>
      <div className="text-lg font-bold text-navy">{value}</div>
      {sub && <div className="text-[11px] text-navy/40">{sub}</div>}
    </div>
  );
}
