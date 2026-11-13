'use client';

/**
 * AI & Automation — per-company AI settings.
 *
 *  - Models: local models on this machine / LAN / Tailscale tailnet (Ollama, LM Studio,
 *    vLLM, llama.cpp) and optional cloud models (Anthropic Claude, OpenAI-compatible APIs).
 *    Test Connection probes the server and fills the model picker. API keys are write-only:
 *    the server stores them encrypted and only ever reports "saved".
 *  - Routing: cloud is OFF by default; each task can be local-only (default),
 *    local-then-cloud or cloud-only. Listed names and identifiers are replaced in cloud calls.
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
  Modal,
  PageHeader,
  PageSkeleton,
  Select,
  toast,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { formatDate } from '@/lib/dates';
import { AI_PRESETS, presetOf, type AiPreset } from '@/lib/ai/presets';

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
  cloudDailyCap: number;
  cloudCallsToday: number;
  autoApplyEnabled: boolean;
  autoApplyThreshold: string;
  llmSuggestEnabled: boolean;
  /** PUT only: why cloud AI is still blocked by Privacy & Network (offline mode, a machine ceiling). */
  networkNotice?: string | null;
}

/** Privacy & Network's verdict for cloud AI (GET /api/network-policy, purposes[ai].cloud). */
interface CloudVerdict {
  allowed: boolean;
  reason: string;
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
  'openai-compatible': 'OpenAI-compatible API (OpenAI, Gemini, Groq, OpenRouter, Mistral, xAI, DeepSeek, LM Studio, vLLM…)',
  anthropic: 'Anthropic Claude',
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
  const [cloudDailyCap, setCloudDailyCap] = useState(500);
  const [autoApplyEnabled, setAutoApplyEnabled] = useState(false);
  const [threshold, setThreshold] = useState(95);
  const [llmSuggestEnabled, setLlmSuggestEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tests, setTests] = useState<Record<string, TestResult | 'running'>>({});
  const [peers, setPeers] = useState<{ available: boolean; reason?: string; peers: Peer[] } | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [cat, setCat] = useState<CategorizerInfo | null>(null);
  const [retraining, setRetraining] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [cloudVerdict, setCloudVerdict] = useState<CloudVerdict | null>(null);
  /** Local presets (Ollama, LM Studio): whether their server answers on this computer right now. */
  const [localStatus, setLocalStatus] = useState<Record<string, { running: boolean; models: number } | 'checking'>>({});

  const [pulling, setPulling] = useState(false);

  /** Ollama is running but has no model: download a small starter one (no command line). */
  async function downloadStarter() {
    setPulling(true);
    toast('Downloading llama3.2 into Ollama (about 2 GB) — this can take a few minutes.', 'info');
    try {
      const r = await api.post<{ model: string }>('/api/ai/pull', { baseUrl: 'http://localhost:11434' });
      toast(`${r.model} is ready. Add Ollama and Save changes.`, 'success');
      setLocalStatus((m) => ({ ...m, ollama: { running: true, models: 1 } }));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'The download did not finish.', 'danger');
    } finally {
      setPulling(false);
    }
  }

  /** Opening the picker pings the local servers, so the cards say "Running" or "Not running". */
  function openPicker() {
    setPickerOpen(true);
    for (const pr of AI_PRESETS) {
      if (pr.where !== 'this computer' || !pr.baseUrl) continue;
      setLocalStatus((m) => ({ ...m, [pr.id]: 'checking' }));
      api
        .post<TestResult>('/api/ai/test', { kind: pr.kind, label: pr.name, baseUrl: pr.baseUrl, model: '', enabled: true, timeoutMs: 3000 })
        .then((r) => setLocalStatus((m) => ({ ...m, [pr.id]: { running: r.ok, models: r.models.length } })))
        .catch(() => setLocalStatus((m) => ({ ...m, [pr.id]: { running: false, models: 0 } })));
    }
  }

  const loadCloudVerdict = useCallback(async () => {
    try {
      const d = await api.get<{ purposes: { purpose: string; cloud: CloudVerdict }[] }>('/api/network-policy');
      const ai = d.purposes.find((x) => x.purpose === 'ai');
      setCloudVerdict(ai ? ai.cloud : null);
    } catch {
      /* non-critical */
    }
  }, []);

  const apply = useCallback((s: Settings) => {
    setSettings(s);
    setDrafts(s.providers.map(toDraft));
    setPolicies(s.taskPolicies);
    setCloudEnabled(s.cloudEnabled);
    setCloudDailyCap(s.cloudDailyCap);
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
    loadCloudVerdict();
  }, [apply, loadCategorizer, loadCloudVerdict]);

  /**
   * "Add AI": a preset becomes a provider row ready to test. A cloud AI also turns cloud on and,
   * when there is no local model to try first, points every task at the cloud — the three
   * dropdowns below would otherwise stay "Local only" and the new AI would never be used.
   */
  function addPreset(preset: AiPreset) {
    const draft = newDraft({ kind: preset.kind, label: preset.name, baseUrl: preset.baseUrl, model: preset.defaultModel });
    setDrafts((prev) => [...prev, draft]);
    setPickerOpen(false);
    // A local server that is already running: list its models straight away (no key to paste first).
    if (preset.where === 'this computer' && preset.baseUrl) {
      const st = localStatus[preset.id];
      if (st && st !== 'checking' && st.running) void test(draft);
    }
    if (preset.where === 'cloud') {
      setCloudEnabled(true);
      // Tasks still "Local only" would never use the AI just added: local first (when there is a
      // local model), then this cloud AI.
      setPolicies((p) => {
        const next = { ...p };
        for (const t of Object.keys(next) as Task[]) if (next[t] === 'local-only') next[t] = 'local-then-cloud';
        return next;
      });
      toast(`${preset.name} added. Paste your API key, then Test connection and Save changes.`, 'info');
    } else {
      toast(`${preset.name} added. Test connection to pick a model, then Save changes.`, 'info');
    }
  }

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
        cloudDailyCap,
        autoApplyEnabled,
        autoApplyThreshold: (threshold / 100).toFixed(2),
        llmSuggestEnabled,
      });
      apply(s);
      toast('AI settings saved.', 'success');
      if (s.networkNotice) toast(s.networkNotice, 'danger');
      loadCloudVerdict();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Save failed.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function test(d: Draft) {
    setTests((t) => ({ ...t, [d.key]: 'running' }));
    try {
      // With "Allow cloud AI" ticked, testing a cloud AI also allows it under Privacy & Network.
      const r = await api.post<TestResult>('/api/ai/test', { ...draftBody(d), allowCloud: cloudEnabled });
      if (r.ok && r.locality === 'cloud') loadCloudVerdict();
      setTests((t) => ({ ...t, [d.key]: r }));
      const chatModel = r.models.find((m) => !/embed|whisper|tts|dall-e|moderation|rerank|audio|image/i.test(m.id)) ?? r.models[0];
      if (r.ok && !d.model && chatModel) patchDraft(d.key, { model: chatModel.id });
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
    cloudDailyCap !== settings.cloudDailyCap ||
    autoApplyEnabled !== settings.autoApplyEnabled ||
    threshold !== Math.round(Number(settings.autoApplyThreshold) * 100) ||
    llmSuggestEnabled !== settings.llmSuggestEnabled;

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
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
          <strong>Use the AI you already have.</strong> Add ChatGPT, Claude, Gemini and others with your own API key,
          or a free model that runs on this computer (Ollama, LM Studio) so nothing leaves your PC. Cloud AI is off until
          you allow it below. When it is on, the question and the report figures it needs are sent; before that, the
          names on your customer, vendor and employee lists, emails, phone numbers, tax IDs, account numbers and
          addresses are replaced with placeholders (other free text, such as a bank line&apos;s description, is sent as
          is). A model on another computer in your office or on your Tailscale network works too.
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
              <Network className="h-4 w-4" /> Find models on other computers (Tailscale)
            </Button>
            <Button size="sm" onClick={openPicker}>
              <Plus className="h-4 w-4" /> Add AI…
            </Button>
          </div>
        </div>

        <Modal open={pickerOpen} onClose={() => setPickerOpen(false)} title="Which AI do you use?" size="lg">
          <p className="mb-4 text-sm text-navy/60">
            Pick the one you already have an account for, or a free model that runs on this computer. You can add more
            than one.
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {AI_PRESETS.map((pr) => (
              <button
                key={pr.id}
                type="button"
                onClick={() => addPreset(pr)}
                className="flex items-start gap-3 rounded-xl border border-slate-200 p-3 text-left hover:border-electric hover:bg-electric/5 focus-visible:ring-2 focus-visible:ring-electric outline-none"
              >
                <span className="mt-0.5 shrink-0 text-electric">{pr.where === 'cloud' ? <Cloud className="h-4 w-4" /> : <Cpu className="h-4 w-4" />}</span>
                <span>
                  <span className="block text-sm font-semibold text-navy">{pr.name}</span>
                  <span className="block text-xs text-navy/55">{pr.blurb}</span>
                  <span className="mt-1 block text-[11px] text-navy/40">
                    {pr.where === 'cloud' ? 'Cloud · needs an API key · names and numbers are hidden before sending' : 'Runs on this computer · free · nothing leaves your PC'}
                  </span>
                  {pr.id === 'ollama' &&
                    localStatus.ollama &&
                    localStatus.ollama !== 'checking' &&
                    localStatus.ollama.running &&
                    localStatus.ollama.models === 0 && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!pulling) void downloadStarter();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            if (!pulling) void downloadStarter();
                          }
                        }}
                        className="mt-1 inline-block rounded-full border border-electric/40 px-2 py-0.5 text-[11px] font-semibold text-electric hover:bg-electric/5"
                      >
                        {pulling ? 'Downloading llama3.2…' : 'Download a starter model (llama3.2, ~2 GB)'}
                      </span>
                    )}
                  {pr.where === 'this computer' && pr.baseUrl && localStatus[pr.id] && (
                    <span className="mt-1 block text-[11px]">
                      {localStatus[pr.id] === 'checking' ? (
                        <span className="text-navy/40">Checking…</span>
                      ) : (localStatus[pr.id] as { running: boolean; models: number }).running ? (
                        <span className="text-emerald">Running on this computer · {(localStatus[pr.id] as { models: number }).models} model(s) ready</span>
                      ) : (
                        <span className="text-yellow-800">
                          Not running. {pr.getLabel ? `${pr.getLabel} ↗ (opens the download page after you add it)` : ''}
                        </span>
                      )}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </Modal>

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
          <div className="py-6 text-center">
            <p className="text-sm text-navy/60">
              No AI connected yet. Everything still works — suggestions come from the built-in learned categorizer, and
              the assistant answers basic questions from your reports.
            </p>
            <p className="mt-1 text-sm text-navy/60">
              Connect ChatGPT, Claude, Gemini or a free model on this computer for smarter help.
            </p>
            <Button className="mt-4" onClick={openPicker}>
              <Plus className="h-4 w-4" /> Add AI…
            </Button>
          </div>
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
                      <Label>API key {d.kind === 'anthropic' || presetOf(d)?.needsKey ? '' : '(optional)'}</Label>
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
                      {(() => {
                        const pr = presetOf(d);
                        if (!pr?.getUrl) return null;
                        return (
                          <a href={pr.getUrl} target="_blank" rel="noreferrer" className="mt-1 block text-xs text-electric hover:underline">
                            {pr.getLabel} ↗
                          </a>
                        );
                      })()}
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
              Off by default. When on, tasks set to use the cloud send text with listed names, contact details, tax IDs,
              account numbers and addresses replaced by placeholders. OpenAI is asked not to store requests; other
              services keep requests under their own terms. Ironbooks saves nothing outside this computer. Saving (or
              testing a cloud AI) with this on also allows AI under Privacy &amp; Network.
            </span>
            {cloudVerdict && (
              <span className={`mt-1 block text-xs ${cloudVerdict.allowed ? 'text-emerald' : 'text-navy/50'}`}>
                Privacy &amp; Network: {cloudVerdict.allowed ? 'cloud AI is allowed.' : cloudVerdict.reason}
              </span>
            )}
          </span>
        </label>
        <div className="mb-5 flex flex-wrap items-center gap-3 text-sm">
          <Label className="mb-0 whitespace-nowrap">Daily limit on cloud AI calls</Label>
          <Input
            type="number"
            min={0}
            step={50}
            value={cloudDailyCap}
            onChange={(e) => setCloudDailyCap(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            className="w-28"
            aria-label="Daily limit on cloud AI calls"
          />
          <span className="text-xs text-navy/50">
            0 = no limit · Used today: <strong className="text-navy">{settings.cloudCallsToday}</strong>. A spend guard: when the
            limit is reached, cloud AI pauses until tomorrow and local models and built-in behavior carry on.
          </span>
        </div>
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
              Right after a bank file is imported (and from “Auto-apply confident” on Bank Review), lines the learned
              categorizer is at least this sure about are posted for you. Each one is logged in the audit trail and can be
              undone with Unmatch. On by default at 95% for new companies.
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
