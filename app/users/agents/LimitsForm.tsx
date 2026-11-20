'use client';
/**
 * An agent's limits (plan 7.1): the most records one request may change, the amount above which
 * two different people must approve (D8), how long a request waits, the folders it may read from
 * or save to, and the email notice when it asks while nobody is signed in (D7).
 *
 * The folder being typed is held by the detail page, not here, so Save changes adds a path that
 * was typed but not added (withTypedFolder) instead of dropping it without a word.
 */
import { FolderPlus, X } from 'lucide-react';
import { AmountInput, Button, Input, Label, toast } from '@/components/ui';
import { RISK_CLASS_LABELS } from '@/lib/agent/operations/types';
import { DEFAULT_BULK_CAP } from '@/lib/agent/policy';
import { BULK_CAP_MAX, EXPIRY_DAYS_MAX, addFolder, allowsBulk, capThatApplies, removeFolder, type PolicyDraft } from './policyDraft';

export default function LimitsForm({
  draft,
  onChange,
  disabled,
  unattended,
  folder,
  onFolderChange,
}: {
  draft: PolicyDraft;
  onChange: (next: PolicyDraft) => void;
  disabled: boolean;
  unattended: boolean;
  /** The folder path being typed, not yet on the list. */
  folder: string;
  onFolderChange: (typed: string) => void;
}) {
  function add() {
    const r = addFolder(draft, folder);
    if (r.error !== null) {
      toast(r.error, 'danger');
      return;
    }
    onChange(r.draft);
    onFolderChange('');
  }

  const bulkAllowed = allowsBulk(draft);
  const cap = capThatApplies(draft);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <Label htmlFor="ag-bulk-cap">Most records one request may change</Label>
        <Input
          id="ag-bulk-cap"
          inputMode="numeric"
          value={draft.bulkCap}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, bulkCap: e.target.value })}
          placeholder={bulkAllowed ? String(DEFAULT_BULK_CAP) : 'No limit'}
        />
        <p className="mt-1 text-xs text-navy/50">
          A request that would change more is refused. Up to {BULK_CAP_MAX.toLocaleString('en-US')}. Empty means no limit, except while
          &quot;{RISK_CLASS_LABELS.bulk}&quot; is Allow anywhere: then there is always one, and empty means {DEFAULT_BULK_CAP}.
        </p>
        <p className="mt-1 text-xs font-medium text-navy/70" data-cap-applies="">
          {cap !== null
            ? `Once saved: at most ${cap.toLocaleString('en-US')} ${cap === 1 ? 'record' : 'records'} in one request.`
            : draft.bulkCap.trim() === ''
              ? 'Once saved: no limit.'
              : `Type a whole number from 1 to ${BULK_CAP_MAX.toLocaleString('en-US')}.`}
        </p>
      </div>
      <div>
        <Label htmlFor="ag-two-person">Two people approve above this amount</Label>
        <AmountInput
          id="ag-two-person"
          value={draft.twoPersonOver}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, twoPersonOver: e.target.value })}
          placeholder="Off"
        />
        <p className="mt-1 text-xs text-navy/50">
          A request for more than this needs a yes from two different people. 0: every amount does. Empty: one person is enough.
        </p>
      </div>
      <div>
        <Label htmlFor="ag-expiry">Days a request waits for an answer</Label>
        <Input
          id="ag-expiry"
          inputMode="numeric"
          value={draft.requestExpiryDays}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, requestExpiryDays: e.target.value })}
        />
        <p className="mt-1 text-xs text-navy/50">
          After that it expires and the agent is told. From 1 to {EXPIRY_DAYS_MAX} days.
        </p>
      </div>
      <div>
        <Label>Email notice</Label>
        <label className={`flex items-start gap-2 rounded p-1.5 ${disabled ? 'opacity-70' : 'cursor-pointer hover:bg-electric/5'}`}>
          <input
            type="checkbox"
            className="mt-1"
            checked={draft.notifyEmail}
            disabled={disabled}
            onChange={(e) => onChange({ ...draft, notifyEmail: e.target.checked })}
          />
          <span>
            <span className="text-sm font-semibold text-navy">Email the Admin when it asks while nobody is signed in</span>
            <span className="block text-xs text-navy/50">
              Off unless ticked, since the notice is itself an email that leaves this computer. It only says that a request is waiting:
              nothing is ever approved by email.
              {!unattended && ' This agent works only while someone is signed in, so it is rarely needed.'}
            </span>
          </span>
        </label>
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor="ag-folder">Folders it may read from or save to</Label>
        {draft.folders.length === 0 ? (
          <p className="mb-2 text-xs text-navy/50">None. The agent cannot read or save files on this computer.</p>
        ) : (
          <ul className="mb-2 space-y-1" aria-label="Folders the agent may use">
            {draft.folders.map((f) => (
              <li key={f} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-1.5">
                <span className="min-w-0 break-all font-mono text-xs text-navy">{f}</span>
                {!disabled && (
                  <Button size="sm" variant="ghost" onClick={() => onChange(removeFolder(draft, f))} title="Remove this folder" aria-label={`Remove ${f}`}>
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!disabled && (
          <div className="flex gap-2">
            <Input
              id="ag-folder"
              value={folder}
              onChange={(e) => onFolderChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder="C:\Users\you\Documents\Receipts"
            />
            <Button variant="secondary" onClick={add}>
              <FolderPlus className="mr-1 h-4 w-4" /> Add folder
            </Button>
          </div>
        )}
        {!disabled && folder.trim() !== '' && (
          <p className="mt-1 text-xs text-amber-800" data-folder-pending="">
            Not on the list yet. Add folder puts it there now; Save changes adds it too.
          </p>
        )}
        <p className="mt-1 text-xs text-navy/50">
          The full path of a folder on this computer, never the folder that holds the company file. Saving a file there always waits for a
          person to say yes.
        </p>
      </div>
    </div>
  );
}
