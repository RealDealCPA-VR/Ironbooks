'use client';

/**
 * Scheduled Reports: run a memorized report (or a whole group) every day, week or month and
 * save the export (CSV or Excel) into a folder on this computer. The desktop app checks for due
 * schedules automatically; "Run due reports now" does it on demand. A schedule can also email
 * its files to the people listed in "Email to" (QB "Send report as e-mail"): the email goes out
 * through the company's Send Forms / email settings, only with the company's network opt-in for
 * an outside mail server, and never from a sandbox copy. Without recipients files stay here.
 *
 * Agent full access: a schedule an agent set up or changed (or whose report an agent changed) does
 * not run until a person has looked at it, because it would run unattended with its creator's full
 * access and email whoever is on it (lib/services/memorizedReports.ts, AGENT_SCHEDULE_HELD_MESSAGE).
 * Such a row says "Waiting for you: an agent set this up" and offers "Confirm recipients": saving
 * the recipients is the one step that ends that wait. Pause and Resume do not, and the row says so.
 *
 * Whether a schedule waits for a person is the server's call, made from the audit trail each time
 * the list is loaded (`waitingForAPerson`, lib/services/memorizedReports.ts listReportSchedules),
 * so that it is the same after a reload, in another window and for another person; the page never
 * guesses it from what happened on this page. The stored message is only what the schedule's last
 * run said (the timer rewrites it when the reason it is held for changes), so the row shows the
 * current reason from the server's answer (shownRow). A listing without that answer (an older
 * server) is read from the stored message instead (agentHoldNow), which errs towards waiting.
 * test/dom/agentChrome.dom.tsx pins both.
 */
import { useCallback, useEffect, useState } from 'react';
import { Bot, CalendarClock, Mail, Pause, Play, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Input, Label, Modal, PageHeader, Select, Table, Td, Th, Tr, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { todayISO } from '@/lib/dates';

interface Schedule {
  id: string;
  name: string;
  memorizedReportId: string | null;
  groupId: string | null;
  frequency: 'daily' | 'weekly' | 'monthly';
  nextRunAt: string;
  format: 'csv' | 'xlsx';
  folder: string | null;
  isActive: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastMessage: string | null;
  emailTo: string | null;
  /**
   * Waits for a person because an agent set it up or changed it, as the server decides it now
   * (memorizedReports' schedulesWaitingForAPerson, sent by GET /api/report-schedules). A listing
   * without it (an older server) is read from the stored message instead (agentHoldNow).
   */
  waitingForAPerson?: boolean;
}
interface Option {
  id: string;
  name: string;
}

const today = () => todayISO();

/**
 * A schedule's last result: red only when it failed. "held" (an emailing schedule waiting until
 * internet services are allowed for this file on this computer, or one an agent set up waiting for
 * a person) is a wait, not an error.
 */
function lastStatusTone(status: string | null): 'success' | 'warning' | 'danger' {
  if (status === 'ok') return 'success';
  if (status === 'partial' || status === 'held') return 'warning';
  return 'danger';
}

/**
 * How the message the timer stores on a schedule held for an agent begins
 * (AGENT_SCHEDULE_HELD_MESSAGE in lib/services/memorizedReports.ts, which a page cannot import).
 * test/agentChrome.dom.test.ts checks that the two still agree.
 */
const AGENT_HOLD_START = 'Waiting for a person: an agent';
/**
 * Shown in place of an agent hold's stored message once the server says nobody needs to look: the
 * timer keeps that message until the schedule next runs or is held for another reason. It claims
 * nothing about the next run, which may still be held for another reason (internet services).
 */
const AGENT_HOLD_RELEASED = 'A person confirmed this schedule after an agent changed it. Its next run shows here.';
/** Shown when the server says an agent hold applies but the stored message is about something else. */
const AGENT_HOLD_NOW =
  'Waiting for a person: an agent set up or changed this schedule or a report it runs. Check the report and who it emails, then choose Confirm recipients and Save.';

/**
 * Whether the schedule waits for a person because of an agent, now: the server's answer. A listing
 * that does not carry it (an older server) is read from the stored message, which can be out of
 * date: it is what the last run said. It then errs towards waiting, which only asks a person to
 * look again.
 */
function agentHoldNow(s: Schedule): boolean {
  if (typeof s.waitingForAPerson === 'boolean') return s.waitingForAPerson;
  return s.lastStatus === 'held' && !!s.lastMessage?.startsWith(AGENT_HOLD_START);
}

/**
 * The row as shown, so a held row always gives its current reason: a stored agent-hold message the
 * server says no longer applies says so instead, and an agent hold the server reports over a stored
 * message about something else (the internet hold) is said as the agent hold, the one that decides
 * first.
 */
function shownRow(s: Schedule, forAgent: boolean): Schedule {
  const storedForAgent = !!s.lastMessage?.startsWith(AGENT_HOLD_START);
  if (s.lastStatus !== 'held' || forAgent === storedForAgent) return s;
  return { ...s, lastMessage: forAgent ? AGENT_HOLD_NOW : AGENT_HOLD_RELEASED };
}

/**
 * What saving the recipients did, from the list as the server gives it right after: `confirming`
 * when the dialog was opened on a schedule waiting for a person. Without the server's answer it
 * says only what is sure (a person's save is recorded as a confirmation), and why the row may not
 * change: it still shows the message stored by the schedule's last run.
 */
function recipientsSavedMessage(confirming: boolean, now: Schedule | undefined): string {
  if (!confirming) return 'Recipients saved.';
  if (now?.waitingForAPerson === false) return 'Recipients confirmed. It no longer waits for you.';
  if (now?.waitingForAPerson === true) return 'Recipients saved, but it still waits for a person: an agent changed it again. Check it and confirm its recipients once more.';
  return 'Recipients confirmed. This row shows the schedule’s last run, so it may still say it waits for you.';
}

export default function ScheduledReportsPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [folder, setFolder] = useState('');
  const [reports, setReports] = useState<Option[]>([]);
  const [groups, setGroups] = useState<Option[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', target: '', frequency: 'monthly', startDate: today(), format: 'csv', folder: '', emailTo: '' });
  // "Email to" of an existing schedule (null = dialog closed). `confirm`: opened from "Confirm
  // recipients" (or the envelope) on a schedule waiting for a person, which Save confirms.
  const [mailEdit, setMailEdit] = useState<{ s: Schedule; value: string; confirm: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  /** Load the list (and what the schedules run); the schedules as loaded, or null when it failed. */
  const load = useCallback(async (): Promise<Schedule[] | null> => {
    try {
      const [s, m] = await Promise.all([
        api.get<{ schedules: Schedule[]; exportFolder: string }>('/api/report-schedules'),
        api.get<{ reports: Option[]; groups: Option[] }>('/api/memorized-reports?withGroups=1'),
      ]);
      setSchedules(s.schedules);
      setFolder(s.exportFolder);
      setReports(m.reports);
      setGroups(m.groups);
      return s.schedules;
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not load scheduled reports.', 'danger');
      return null;
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const [kind, id] = form.target.split(':');
      await api.post('/api/report-schedules', {
        name: form.name,
        memorizedReportId: kind === 'r' ? id : null,
        groupId: kind === 'g' ? id : null,
        frequency: form.frequency,
        startDate: form.startDate,
        format: form.format,
        folder: form.folder || undefined,
        emailTo: form.emailTo.trim() || null,
      });
      setOpen(false);
      setForm({ name: '', target: '', frequency: 'monthly', startDate: today(), format: 'csv', folder: '', emailTo: '' });
      await load();
      toast('Schedule saved.', 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save the schedule.', 'danger');
    } finally {
      setBusy(false);
    }
  };

  const runDue = async () => {
    setBusy(true);
    try {
      const d = await api.post<{ results: { name: string; status: string; files: string[]; message?: string }[] }>('/api/report-schedules/run-due');
      if (d.results.length === 0) toast('Nothing is due right now.', 'info');
      else
        toast(
          d.results.map((r) => `${r.name}: ${r.status === 'ok' ? `${r.files.length} file(s) saved` : r.message}`).join(' · '),
          d.results.every((r) => r.status === 'ok') ? 'success' : d.results.every((r) => r.status === 'ok' || r.status === 'held') ? 'info' : 'danger',
        );
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not run the schedules.', 'danger');
    } finally {
      setBusy(false);
    }
  };

  // A person saving the recipients is what ends the wait of a schedule an agent set up (the server
  // records it as a confirmation); nothing else on this page does. What the row then says comes
  // from the list loaded right after, not from this page's memory of the save.
  const saveRecipients = async () => {
    if (!mailEdit) return;
    const id = mailEdit.s.id;
    const confirming = mailEdit.confirm;
    setBusy(true);
    try {
      await api.patch(`/api/report-schedules/${id}`, { emailTo: mailEdit.value.trim() || null });
      setMailEdit(null);
      const now = (await load())?.find((x) => x.id === id);
      toast(recipientsSavedMessage(confirming, now), now?.waitingForAPerson === true ? 'info' : 'success');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save the recipients.', 'danger');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (s: Schedule) => {
    try {
      await api.patch(`/api/report-schedules/${s.id}`, { isActive: !s.isActive });
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not update.', 'danger');
    }
  };
  // Deleting asks first (the row's Delete button, and Ctrl+D on a highlighted row).
  const [removing, setRemoving] = useState<Schedule | null>(null);
  const remove = async (s: Schedule) => {
    try {
      await api.del(`/api/report-schedules/${s.id}`);
      setRemoving(null);
      await load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not delete.', 'danger');
    }
  };

  const targetName = (s: Schedule) =>
    s.groupId ? `Group: ${groups.find((g) => g.id === s.groupId)?.name ?? '?'}` : reports.find((r) => r.id === s.memorizedReportId)?.name ?? '?';

  return (
    <main className="min-h-screen bg-offwhite p-8 font-sans">
      <PageHeader
        title="Scheduled Reports"
        icon={CalendarClock}
        action={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={runDue} loading={busy}>
              <Play className="h-4 w-4" /> Run due reports now
            </Button>
            <Button onClick={() => setOpen(true)} disabled={reports.length === 0 && groups.length === 0}>
              <Plus className="h-4 w-4" /> New schedule
            </Button>
          </div>
        }
      />
      <p className="text-sm text-navy/60 -mt-4 mb-6">
        Files are saved on this computer in <code className="rounded bg-white px-1">{folder || '…'}</code>. A schedule with people in
        &ldquo;Email to&rdquo; also emails them the files, using your Send Forms email settings; without recipients nothing leaves this computer.
      </p>
      <Card className="p-0 overflow-hidden">
        {schedules.length === 0 ? (
          <EmptyState icon={CalendarClock} title="No scheduled reports" message="Memorize a report first, then schedule it here." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Runs</Th>
                <Th>Report</Th>
                <Th>Next run</Th>
                <Th>Last run</Th>
                <Th>Format</Th>
                <Th>Email to</Th>
                <Th>{''}</Th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((raw) => {
                const forAgent = agentHoldNow(raw);
                const s = shownRow(raw, forAgent);
                return (
                  <Tr key={s.id}>
                    <Td>
                      {s.name} {!s.isActive && <Badge tone="warning">Paused</Badge>}
                      {forAgent && (
                        <span
                          className="mt-1 flex items-center"
                          data-agent-hold
                          title="It does not run until a person confirms its recipients. Pausing or resuming it does not count."
                        >
                          <Badge tone="info" className="inline-flex items-center gap-1">
                            <Bot className="h-3 w-3" aria-hidden="true" /> Waiting for you: an agent set this up
                          </Badge>
                        </span>
                      )}
                    </Td>
                    <Td className="capitalize">{s.frequency}</Td>
                    <Td>{targetName(s)}</Td>
                    <Td>{new Date(s.nextRunAt).toLocaleDateString()}</Td>
                    <Td>
                      {s.lastRunAt ? (
                        <>
                          <span title={s.lastMessage ?? ''}>
                            {new Date(s.lastRunAt).toLocaleDateString()}{' '}
                            <Badge tone={lastStatusTone(s.lastStatus)}>{s.lastStatus}</Badge>
                          </span>
                          {/* Held is not a failure: it waits for internet services to be allowed on this
                              computer, or for a person to confirm what an agent set up. The reason shown
                              is the current one (shownRow). */}
                          {s.lastStatus === 'held' && s.lastMessage && <p className="mt-1 max-w-[18rem] text-xs text-navy/70">{s.lastMessage}</p>}
                        </>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td className="uppercase">{s.format}{s.folder ? ` → ${s.folder}` : ''}</Td>
                    <Td className="text-sm text-navy/70 max-w-[14rem] truncate" title={s.emailTo ?? ''}>
                      {s.emailTo ?? <span className="text-navy/40">Files only</span>}
                    </Td>
                    <Td className="whitespace-nowrap">
                      {forAgent && (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="mr-1"
                          onClick={() => setMailEdit({ s, value: s.emailTo ?? '', confirm: true })}
                          aria-label={`Confirm recipients of ${s.name}`}
                          data-confirm-recipients
                        >
                          Confirm recipients
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setMailEdit({ s, value: s.emailTo ?? '', confirm: forAgent })}
                        aria-label={`Email recipients of ${s.name}`}
                      >
                        <Mail className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => toggle(s)}
                        aria-label={s.isActive ? `Pause ${s.name}` : `Resume ${s.name}`}
                        title={forAgent ? 'Pausing or resuming does not let it run: confirm its recipients.' : undefined}
                      >
                        {s.isActive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setRemoving(s)} aria-label={`Delete ${s.name}`}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <ConfirmDialog
        open={removing !== null}
        title="Delete this schedule?"
        message={removing ? `“${removing.name}” will no longer run. Files it already saved are kept.` : undefined}
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => removing && void remove(removing)}
        onClose={() => setRemoving(null)}
      />

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Schedule a report"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={create} loading={busy} disabled={!form.name.trim() || !form.target}>
              Save schedule
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <Label htmlFor="sc-name">Schedule name</Label>
            <Input id="sc-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Month-end pack" />
          </div>
          <div>
            <Label htmlFor="sc-target">What to run</Label>
            <Select id="sc-target" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })}>
              <option value="">Choose a memorized report or group…</option>
              {groups.length > 0 && (
                <optgroup label="Groups">
                  {groups.map((g) => (
                    <option key={g.id} value={`g:${g.id}`}>
                      {g.name}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Reports">
                {reports.map((r) => (
                  <option key={r.id} value={`r:${r.id}`}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="sc-freq">How often</Label>
              <Select id="sc-freq" value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
                <option value="daily">Every day</option>
                <option value="weekly">Every week</option>
                <option value="monthly">Every month</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="sc-start">First run</Label>
              <Input id="sc-start" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="sc-format">File type</Label>
              <Select id="sc-format" value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}>
                <option value="csv">CSV (one file per report)</option>
                <option value="xlsx">Excel (one workbook)</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="sc-folder">Sub-folder (optional)</Label>
              <Input id="sc-folder" value={form.folder} onChange={(e) => setForm({ ...form, folder: e.target.value })} placeholder="Scheduled" />
            </div>
          </div>
          <div>
            <Label htmlFor="sc-email">Email to (optional)</Label>
            <Input
              id="sc-email"
              value={form.emailTo}
              onChange={(e) => setForm({ ...form, emailTo: e.target.value })}
              placeholder="owner@example.com, accountant@example.com"
              autoComplete="off"
            />
            <p className="text-xs text-navy/50 mt-1">Each run also emails the files to these people, separated by commas. Leave blank to only save files.</p>
          </div>
          <p className="text-xs text-navy/50">Dates saved in the memorized report are used as-is each time it runs.</p>
        </div>
      </Modal>

      <Modal
        open={mailEdit !== null}
        onClose={() => setMailEdit(null)}
        title={mailEdit ? (mailEdit.confirm ? `Confirm who “${mailEdit.s.name}” emails` : `Email “${mailEdit.s.name}” to`) : 'Email to'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setMailEdit(null)}>
              Cancel
            </Button>
            <Button onClick={saveRecipients} loading={busy}>
              Save
            </Button>
          </>
        }
      >
        {mailEdit?.confirm && (
          <p className="mb-3 rounded-md bg-electric/5 px-3 py-2 text-sm text-navy/80" data-confirm-note>
            An agent set up or changed this schedule, or a report it runs ({targetName(mailEdit.s)}). It runs on its own and
            emails whoever is listed here, so it waits for you. Check the report and these addresses, then choose Save so it
            no longer waits for you. Pausing or resuming it does not.
          </p>
        )}
        <Label htmlFor="sc-email-edit">Email addresses</Label>
        <Input
          id="sc-email-edit"
          value={mailEdit?.value ?? ''}
          onChange={(e) => mailEdit && setMailEdit({ ...mailEdit, value: e.target.value })}
          placeholder="owner@example.com, accountant@example.com"
          autoComplete="off"
          autoFocus
        />
        <p className="text-xs text-navy/50 mt-1">Separate addresses with commas. Clear the box to stop emailing and only save files.</p>
      </Modal>
    </main>
  );
}
