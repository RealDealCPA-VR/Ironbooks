'use client';
/**
 * <MemorizeButton docType="invoice" getTemplate={() => payload} defaultName="Monthly retainer" />
 *
 * QB "Memorize Transaction" (Ctrl+M) from any form: saves the form's current contents as a
 * memorized transaction (POST /api/recurring) with a schedule. The payload is exactly the
 * create-input the form would post, so each entry later goes through the same service and rules.
 *
 * `getTemplate` returns the payload, or a string explaining what is missing.
 */
import * as React from 'react';
import { Bookmark } from 'lucide-react';
import { Button, Input, Label, Modal, Select, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';
import { MEMORIZE_SHORTCUT } from '@/lib/shortcuts';
import { usePreferences } from '@/lib/usePreferences';

export type MemorizableDocType =
  | 'invoice'
  | 'bill'
  | 'journal_entry'
  | 'expense'
  | 'check'
  | 'sales_receipt'
  | 'credit_memo'
  | 'deposit'
  | 'transfer'
  | 'purchase_order';

const FREQUENCIES: Array<[string, string]> = [
  ['daily', 'Daily'],
  ['weekly', 'Weekly'],
  ['biweekly', 'Every two weeks'],
  ['every_four_weeks', 'Every four weeks'],
  ['semimonthly', 'Twice a month'],
  ['monthly', 'Monthly'],
  ['bimonthly', 'Every two months'],
  ['quarterly', 'Quarterly'],
  ['semiannually', 'Twice a year'],
  ['yearly', 'Yearly'],
  ['never', 'No schedule'],
];

export default function MemorizeButton({
  docType,
  getTemplate,
  defaultName,
  disabled,
  /** Listen for Ctrl+M while mounted (only one form should be open at a time). */
  shortcut = true,
}: {
  docType: MemorizableDocType;
  getTemplate: () => Record<string, unknown> | string;
  defaultName?: string;
  disabled?: boolean;
  shortcut?: boolean;
}) {
  const { today } = usePreferences();
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [payload, setPayload] = React.useState<Record<string, unknown> | null>(null);
  const [name, setName] = React.useState('');
  const [mode, setMode] = React.useState<'automatic' | 'remind' | 'never'>('remind');
  const [frequency, setFrequency] = React.useState('monthly');
  const [nextDate, setNextDate] = React.useState(today);
  const [groupName, setGroupName] = React.useState('');
  const [remaining, setRemaining] = React.useState('');
  const [daysInAdvance, setDaysInAdvance] = React.useState('0');

  const start = React.useCallback(() => {
    if (disabled) return;
    const t = getTemplate();
    if (typeof t === 'string') {
      toast(t, 'danger');
      return;
    }
    setPayload(t);
    setName(defaultName ?? '');
    setNextDate(today);
    setOpen(true);
  }, [disabled, getTemplate, defaultName, today]);

  // Ctrl+M (QB Memorize) — works from inside form fields too.
  const startRef = React.useRef(start);
  startRef.current = start;
  React.useEffect(() => {
    if (!shortcut) return;
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === MEMORIZE_SHORTCUT) {
        e.preventDefault();
        startRef.current();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [shortcut]);

  async function save() {
    if (!payload) return;
    if (!name.trim()) {
      toast('Give the memorized transaction a name', 'danger');
      return;
    }
    setSaving(true);
    try {
      await api.post('/api/recurring', {
        name: name.trim(),
        docType,
        frequency,
        nextRunDate: nextDate,
        mode,
        groupName: groupName.trim() || null,
        remaining: remaining === '' ? null : Number(remaining),
        daysInAdvance: Number(daysInAdvance || '0'),
        template: payload,
      });
      toast(`Memorized "${name.trim()}". Find it under Memorized Transactions.`, 'success');
      setOpen(false);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not memorize this transaction', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={start} disabled={disabled} title="Memorize (Ctrl+M)">
        <Bookmark className="h-4 w-4" /> Memorize
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Memorize Transaction"
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void save()} loading={saving}>
              Memorize
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <Label htmlFor="mem-name">Name</Label>
            <Input id="mem-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Monthly rent" />
          </div>
          <div>
            <Label htmlFor="mem-mode">How should it be entered?</Label>
            <Select id="mem-mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="remind">Add to my Reminders list</option>
              <option value="never">Don&apos;t remind me</option>
              <option value="automatic">Automate transaction entry</option>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="mem-freq">How often</Label>
              <Select id="mem-freq" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                {FREQUENCIES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="mem-next">Next date</Label>
              <Input id="mem-next" type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="mem-group">Group</Label>
              <Input id="mem-group" value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="Optional" />
            </div>
            <div>
              <Label htmlFor="mem-remaining">Number remaining</Label>
              <Input
                id="mem-remaining"
                inputMode="numeric"
                placeholder="No limit"
                value={remaining}
                onChange={(e) => setRemaining(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
              />
            </div>
            <div>
              <Label htmlFor="mem-days">Days in advance</Label>
              <Input
                id="mem-days"
                inputMode="numeric"
                value={daysInAdvance}
                onChange={(e) => setDaysInAdvance(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
              />
            </div>
          </div>
          <p className="text-xs text-navy/50">
            Each entry is dated on its scheduled date and saved through the normal form, so every
            accounting rule still applies.
          </p>
        </div>
      </Modal>
    </>
  );
}
