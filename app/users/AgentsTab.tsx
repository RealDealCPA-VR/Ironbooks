'use client';
/**
 * Users & Roles > Agents (AGENT_ACCESS.md; full access plan 7.1): let an AI agent work in this
 * company's books.
 *
 * An Admin gives the agent a name, the same kind of role a person has (Admin included, D1, with a
 * plain warning) and a preset (what it may do without asking; "Ask for every change" unless
 * another is chosen, D2), and gets an access token ONCE, with the settings to paste into Claude
 * Code or Claude Desktop. The list shows each agent's role, preset and last use; opening one shows
 * its detail page (app/users/agents/AgentDetailView.tsx): the policy grid, limits, standing
 * permissions, activity, Pause and Remove. Remove takes its access away at once.
 *
 * The role is the most an agent can ever ask for and the preset what it may do unasked, so the tab
 * says plainly what each choice means for safety (plan 11.1).
 *
 * Agents are made, changed and removed only on the computer that holds the company file; on another
 * computer this tab lists, and an agent can still be paused from there. The rules are enforced in
 * lib/services/agents.ts, agentPolicies.ts and lib/agentContext.ts; this component only presents them.
 *
 * Only an Admin makes or removes an agent, or lets one do more by itself (plan 4.4). Someone else
 * who manages agents sees the list and each agent, and may make one stricter or pause it. The page
 * passes whether the person is an Admin (viewerIsAdmin) when it knows; otherwise the tab asks who
 * is signed in (GET /api/auth/me) itself. When that cannot be told, it shows only what they may do
 * without being an Admin. The server decides either way.
 */
import { useCallback, useEffect, useState } from 'react';
import { Bot, Copy, Plus, Settings2, Trash2 } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, Input, Label, Modal, PageSkeleton, Table, Td, Th, Tr, toast } from '@/components/ui';
import { api } from '@/lib/client';
import type { AgentMode } from '@/lib/permissions/agentAccess';
import { ADMIN_ROLE_KEY } from '@/lib/permissions/model';
import type { AgentPreset } from '@/lib/agent/operations/types';
import AgentDetailView from './agents/AgentDetailView';
import PresetChoice from './agents/PresetChoice';
import {
  ADMIN_ROLE_WARNING,
  ALL_PAUSED_NOTE,
  ALL_PAUSED_TITLE,
  NEW_AGENT_PRESET,
  NOT_ADMIN_LIST_NOTE,
  ROLE_AND_PRESET_NOTE,
  ROLE_HELP,
  adjustedTitle,
  presetLabelOf,
  presetSummary,
  when,
} from './agents/words';

interface Agent {
  id: string;
  name: string;
  roleNames: string[];
  /** What it may do without asking. An older server lists only the mode. */
  preset?: AgentPreset;
  mode: AgentMode;
  /** ISO time a person paused it, or null. */
  pausedAt?: string | null;
  tokenPrefix: string;
  createdAt: string;
  createdByName: string | null;
  lastUsedAt: string | null;
  status: 'active' | 'revoked';
  unattended?: boolean;
  /**
   * How many Allow / Ask / Never settings of its own it has (stored overrides), so the list never
   * shows an adjusted agent as its plain preset (contract §11). Left out by an older server: the
   * list then shows the preset's name, and the detail page the count.
   */
  overrideCount?: number;
}

/** GET /api/agents (contract §11, with what the route adds for this tab). */
interface AgentList {
  agents: Agent[];
  /** Integrated Applications is off: every agent is paused. */
  allPaused?: boolean;
  hostOnly?: boolean;
  unattendedPossible?: boolean;
}
interface Connection {
  command: string;
  args: string[];
  env: Record<string, string>;
  tokenEnv: string;
  installed: boolean;
}
interface RoleOption {
  key: string;
  name: string;
  description: string;
  builtin: boolean;
}

/** The one switch that lets an agent work with nobody at the computer. Off unless ticked. */
export const UNATTENDED_LABEL = 'May work while nobody is signed in';
/** Shown instead of the switch's help when this company file has passwords. */
export const UNATTENDED_NOT_HERE =
  'Not for this company file: it has passwords, so only a person signing in opens it. The agent works while Ironbooks is open and someone has signed in.';
export const UNATTENDED_HELP =
  'Off: the agent works only while this company file is open in Ironbooks and someone has signed in. On: when Ironbooks is closed, it opens this company file by itself with no window, for as long as the agent is working, and closes it again. Anyone who opens Ironbooks or asks for the file from another computer gets it at once. It never does this for a company file with passwords.';

/** What holds for every agent, whatever it may do. */
export const MODES_NOTE =
  'Whatever an agent may do, everything it enters is listed under its name, and it can be paused or removed at any time.';
/** The words of lib/net/hostOnly.ts HOST_ONLY_MESSAGE (a server module this page cannot import). */
const HOST_ONLY_MESSAGE = 'This can only be changed on the computer that holds the company file.';
export const AGENT_PRIVACY_NOTE =
  'What an agent reads is sent to the AI service that runs it, as it is. With an AI model on your own computer or network, nothing leaves.';

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : 'Something went wrong';
}

/**
 * Whether the person at this window is an Admin (GET /api/auth/me). Anything else, a failed read
 * included, counts as not: the controls that would let an agent do more stay off. Cosmetic only:
 * the server holds the same rule (lib/services/agents.ts, agentPolicies.ts).
 */
async function readViewerIsAdmin(): Promise<boolean> {
  try {
    const me = await api.get<{ isAdmin?: unknown } | null>('/api/auth/me');
    return me?.isAdmin === true;
  } catch {
    return false;
  }
}

const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/** The command that adds the connector to Claude Code. */
export function claudeCodeCommand(c: Connection, token: string): string {
  const env = [`--env ${c.tokenEnv}=${token}`, ...Object.entries(c.env).map(([k, v]) => `--env ${k}=${v}`)].join(' ');
  return `claude mcp add ironbooks ${env} -- ${[c.command, ...c.args].map(quote).join(' ')}`;
}

/** The entry for Claude Desktop's configuration file. */
export function claudeDesktopConfig(c: Connection, token: string): string {
  return JSON.stringify({ mcpServers: { ironbooks: { command: c.command, args: c.args, env: { [c.tokenEnv]: token, ...c.env } } } }, null, 2);
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied.`, 'success');
  } catch {
    toast('Could not copy. Select the text and copy it yourself.', 'danger');
  }
}

function CopyBlock({ label, text, what }: { label: string; text: string; what: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <Label>{label}</Label>
        <Button size="sm" variant="ghost" onClick={() => copy(text, what)}>
          <Copy className="mr-1 h-4 w-4" /> Copy
        </Button>
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-navy">
        {text}
      </pre>
    </div>
  );
}

function NewAgent({
  roles,
  unattendedPossible,
  onClose,
  onMade,
}: {
  roles: RoleOption[];
  unattendedPossible: boolean;
  onClose: () => void;
  onMade: (token: string, connection: Connection | null, name: string, unattended: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [roleKeys, setRoleKeys] = useState<string[]>([]);
  const [preset, setPreset] = useState<AgentPreset>(NEW_AGENT_PRESET);
  const [unattended, setUnattended] = useState(false);
  const [busy, setBusy] = useState(false);
  const withAdmin = roleKeys.includes(ADMIN_ROLE_KEY);

  async function save() {
    setBusy(true);
    try {
      const alone = unattended && unattendedPossible;
      const made = await api.post<{ token: string; connection: Connection | null }>('/api/agents', { name, roleKeys, preset, unattended: alone });
      onMade(made.token, made.connection, name.trim(), alone);
    } catch (e) {
      toast(errMsg(e), 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New agent"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!name.trim() || roleKeys.length === 0} data-shortcut="save">
            Make agent
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="ag-name">Name</Label>
          <Input id="ag-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Month-end assistant" />
          <p className="mt-1 text-xs text-navy/50">Shown in the audit trail next to anything the agent does.</p>
        </div>
        <div>
          <Label>Role</Label>
          <div className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto rounded-lg border border-slate-200 p-2 sm:grid-cols-2">
            {roles.map((r) => (
              <label key={r.key} className="flex cursor-pointer items-start gap-2 rounded p-1.5 hover:bg-electric/5">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={roleKeys.includes(r.key)}
                  onChange={(e) => setRoleKeys(e.target.checked ? [...roleKeys, r.key] : roleKeys.filter((k) => k !== r.key))}
                />
                <span>
                  <span className="text-sm font-semibold text-navy">{r.name}</span>
                  {!r.builtin && <span className="ml-1 text-xs text-navy/40">(custom)</span>}
                  <span className="block text-xs text-navy/50">{r.description}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-navy/50">{ROLE_HELP}</p>
          {withAdmin && (
            <p className="mt-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-900" role="note" data-admin-warning="">
              {ADMIN_ROLE_WARNING}
            </p>
          )}
        </div>
        <div>
          <Label>What it may do without asking</Label>
          <PresetChoice value={preset} onChange={setPreset} name="ag-preset" />
          <p className="mt-1 text-xs text-navy/50">
            You can change this, and each kind of work one by one, at any time: open the agent from the list. {MODES_NOTE}
          </p>
        </div>
        <p className="text-xs text-navy/60">{ROLE_AND_PRESET_NOTE}</p>
        <div>
          <Label>When it may work</Label>
          <label className={`flex items-start gap-2 rounded p-1.5 ${unattendedPossible ? 'cursor-pointer hover:bg-electric/5' : 'opacity-70'}`}>
            <input
              type="checkbox"
              className="mt-1"
              checked={unattended && unattendedPossible}
              disabled={!unattendedPossible}
              onChange={(e) => setUnattended(e.target.checked)}
            />
            <span>
              <span className="text-sm font-semibold text-navy">{UNATTENDED_LABEL}</span>
              <span className="block text-xs text-navy/50">{unattendedPossible ? UNATTENDED_HELP : UNATTENDED_NOT_HERE}</span>
            </span>
          </label>
        </div>
        <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">{AGENT_PRIVACY_NOTE}</p>
      </div>
    </Modal>
  );
}

function TokenOnce({
  name,
  token,
  connection,
  unattended,
  onClose,
}: {
  name: string;
  token: string;
  connection: Connection | null;
  unattended: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title={`${name} is ready`}
      size="lg"
      footer={
        <Button onClick={onClose} data-shortcut="save">
          I have copied it
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-navy">
          This is the agent&apos;s access token. <strong>It is shown only now.</strong> Ironbooks keeps no copy it could show again; if it is
          lost, remove the agent and make a new one.
        </p>
        <CopyBlock label="Access token" text={token} what="Token" />
        {connection ? (
          <>
            <CopyBlock label="Claude Code: run this once in a terminal" text={claudeCodeCommand(connection, token)} what="Command" />
            <CopyBlock label="Claude Desktop: add this to its configuration file" text={claudeDesktopConfig(connection, token)} what="Configuration" />
          </>
        ) : (
          <p className="text-sm text-navy/60">The connector that ships with Ironbooks was not found on this computer. See AGENT_ACCESS.md.</p>
        )}
        <p className="text-xs text-navy/50">
          {unattended
            ? 'The agent works while this company file is open in Ironbooks on this computer, and when Ironbooks is closed it opens the file by itself for as long as the agent is working. Keep the token like a password.'
            : 'The agent works while this company file is open in Ironbooks on this computer and someone has signed in. Keep the token like a password.'}
        </p>
      </div>
    </Modal>
  );
}

export default function AgentsTab({
  roles,
  viewerIsAdmin: given,
}: {
  roles: RoleOption[];
  /**
   * Whether the person at this window is an Admin, when the page already knows (Users & Roles asks
   * GET /api/auth/me itself); null while it is still asking. Left out, the tab asks on its own.
   * Cosmetic either way: the server holds the same rule.
   */
  viewerIsAdmin?: boolean | null;
}) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [hostOnly, setHostOnly] = useState(false);
  const [unattendedPossible, setUnattendedPossible] = useState(true);
  /** Integrated Applications is off: every agent is paused, whatever its own switch says. */
  const [allPaused, setAllPaused] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [made, setMade] = useState<{ name: string; token: string; connection: Connection | null; unattended: boolean } | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /** The agent whose detail page is open, or null for the list. */
  const [openId, setOpenId] = useState<string | null>(null);
  /** What GET /api/auth/me said, when the page did not say it (null: not known yet). */
  const [asked, setAsked] = useState<boolean | null>(null);
  /** The person at this window is an Admin (null: not known yet). */
  const viewerIsAdmin = given !== undefined ? given : asked;
  const askSelf = given === undefined;

  useEffect(() => {
    if (!askSelf) return;
    let live = true;
    readViewerIsAdmin().then((v) => {
      if (live) setAsked(v);
    });
    return () => {
      live = false;
    };
  }, [askSelf]);

  const load = useCallback(async () => {
    try {
      const res = await api.get<AgentList>('/api/agents');
      const list = Array.isArray(res.agents) ? res.agents : [];
      setAgents(list);
      setHostOnly(Boolean(res.hostOnly));
      setUnattendedPossible(res.unattendedPossible !== false);
      setError('');
      // The list says it itself (contract §11): every agent is paused while it is true.
      setAllPaused(list.length > 0 && res.allPaused === true);
    } catch (e) {
      setError(errMsg(e));
      setAgents([]);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      await api.del(`/api/agents/${removing.id}`);
      toast(`${removing.name} no longer has access.`, 'success');
      setRemoving(null);
      if (openId === removing.id) setOpenId(null);
      await load();
    } catch (e) {
      toast(errMsg(e), 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (agents === null || viewerIsAdmin === null) return <PageSkeleton />;
  /** Only an Admin makes or removes an agent, and only at the computer that holds the file. */
  const mayMake = viewerIsAdmin && !hostOnly;

  const removeDialog = (
    <ConfirmDialog
      open={!!removing}
      title="Remove agent"
      message={`${removing?.name} will stop working at once. What it did stays in the audit trail under its name.`}
      confirmLabel="Remove"
      tone="danger"
      loading={busy}
      onConfirm={remove}
      onClose={() => setRemoving(null)}
    />
  );

  if (openId) {
    return (
      <>
        <AgentDetailView
          key={openId}
          agentId={openId}
          hostOnly={hostOnly}
          viewerIsAdmin={viewerIsAdmin}
          onBack={() => {
            setOpenId(null);
            load();
          }}
          onRemove={setRemoving}
        />
        {removeDialog}
      </>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-start gap-3">
          <Bot className="mt-0.5 h-5 w-5 text-electric" />
          <div className="min-w-0 flex-1 text-sm text-navy/70">
            <p>
              An agent is an AI assistant you let work in these books, the way you would add a bookkeeper: with a name and a role. It connects
              through Ironbooks on this computer only, and everything it does is listed under its name.
            </p>
            <p className="mt-1 text-xs text-navy/50">{ROLE_AND_PRESET_NOTE}</p>
            <p className="mt-1 text-xs text-navy/50">{MODES_NOTE}</p>
          </div>
          {mayMake && (
            <Button onClick={() => setAdding(true)}>
              <Plus className="mr-1 h-4 w-4" /> New agent
            </Button>
          )}
        </div>
        {hostOnly && <p className="mt-3 text-sm text-amber-700">{HOST_ONLY_MESSAGE}</p>}
        {!viewerIsAdmin && (
          <p className="mt-3 text-sm text-navy/60" data-not-admin="">
            {NOT_ADMIN_LIST_NOTE}
          </p>
        )}
        {allPaused && (
          <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-all-paused="">
            {ALL_PAUSED_NOTE}
          </p>
        )}
      </Card>
      {error && <Card className="p-4 text-sm text-red-600">{error}</Card>}
      {agents.length === 0 ? (
        !error && <Card className="p-6 text-center text-sm text-navy/50">No agents. Nothing outside Ironbooks can read this company.</Card>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Role</Th>
              <Th>May</Th>
              <Th>Token</Th>
              <Th>Last used</Th>
              <Th>Status</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <Tr key={a.id} className={a.status === 'active' ? '' : 'opacity-60'}>
                <Td>
                  <button
                    type="button"
                    className="text-left font-semibold text-navy hover:text-electric hover:underline"
                    onClick={() => setOpenId(a.id)}
                    title="Open this agent's settings"
                  >
                    {a.name}
                  </button>
                  <span className="block text-xs text-navy/40">
                    Made {when(a.createdAt)}
                    {a.createdByName ? ` by ${a.createdByName}` : ''}
                  </span>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {a.roleNames.length ? a.roleNames.map((r) => <Badge key={r}>{r}</Badge>) : <span className="text-xs text-navy/40">Role removed</span>}
                  </div>
                </Td>
                <Td>
                  <span data-preset-of={a.id} title={adjustedTitle(a.overrideCount)}>
                    {presetSummary(presetLabelOf(a), a.overrideCount) || a.mode}
                  </span>
                  {a.unattended && unattendedPossible && <span className="block text-xs text-navy/50">Also while nobody is signed in</span>}
                </Td>
                <Td className="font-mono text-xs">{a.tokenPrefix}…</Td>
                <Td className="text-sm">{when(a.lastUsedAt)}</Td>
                <Td>
                  {a.status !== 'active' ? (
                    <Badge tone="void">Removed</Badge>
                  ) : a.pausedAt ? (
                    <Badge tone="warning">Paused</Badge>
                  ) : allPaused ? (
                    <span title={ALL_PAUSED_TITLE}>
                      <Badge tone="warning">Paused</Badge>
                      <span className="block text-xs text-navy/50">All agents</span>
                    </span>
                  ) : (
                    <Badge tone="success">Active</Badge>
                  )}
                </Td>
                <Td className="text-right whitespace-nowrap">
                  <Button size="sm" variant="ghost" onClick={() => setOpenId(a.id)} title="Open this agent's settings" aria-label={`Open ${a.name}`}>
                    <Settings2 className="h-4 w-4" />
                  </Button>
                  {a.status === 'active' && mayMake && (
                    <Button size="sm" variant="ghost" onClick={() => setRemoving(a)} title="Remove this agent's access">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      {adding && (
        <NewAgent
          roles={roles}
          unattendedPossible={unattendedPossible}
          onClose={() => setAdding(false)}
          onMade={(token, connection, name, unattended) => {
            setAdding(false);
            setMade({ name, token, connection, unattended });
            load();
          }}
        />
      )}
      {made && <TokenOnce name={made.name} token={made.token} connection={made.connection} unattended={made.unattended} onClose={() => setMade(null)} />}
      {removeDialog}
    </div>
  );
}
