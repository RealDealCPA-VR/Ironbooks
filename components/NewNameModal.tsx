'use client';
/**
 * "Name not found" quick add (QB: typing a new name into a register or form asks which list it
 * belongs on). Offers Customer / Vendor / Employee / Other, creates the record through that
 * list's own API and hands back { type, id, label }. "Just this once" keeps the typed text as a
 * one-time payee without adding it to any list.
 */
import { useEffect, useState } from 'react';
import { Briefcase, Store, User, Users } from 'lucide-react';
import { Button, Input, Label, Modal, Select, toast } from '@/components/ui';
import { api, ApiError } from '@/lib/client';

export type NameType = 'customer' | 'vendor' | 'employee' | 'other';

export interface CreatedName {
  type: NameType;
  id: string;
  label: string;
}

const CHOICES: { type: NameType; label: string; hint: string; icon: typeof User }[] = [
  { type: 'vendor', label: 'Vendor', hint: 'You buy from them or pay their bills', icon: Store },
  { type: 'customer', label: 'Customer', hint: 'They buy from you or pay you', icon: Users },
  { type: 'employee', label: 'Employee', hint: 'Someone on your payroll', icon: Briefcase },
  { type: 'other', label: 'Other', hint: 'Owners, lenders, anyone else', icon: User },
];

/** "Jane Q. Smith" → first "Jane Q.", last "Smith" (a one-word name is the last name). */
function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return { first: '', last: parts[0] ?? '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

export function NewNameModal({
  open,
  name,
  suggestedType,
  onClose,
  onCreated,
  onUseOnce,
  types,
}: {
  open: boolean;
  /** The text typed into the payee field. */
  name: string;
  /** Pre-selected list (e.g. Vendor for a payment, Customer for a deposit). */
  suggestedType?: NameType;
  onClose: () => void;
  onCreated: (created: CreatedName) => void;
  /** Keep the typed text as a one-time payee; omit to hide the option. */
  onUseOnce?: () => void;
  /** The lists this field can use (an invoice: Customer only). Default: all four. */
  types?: NameType[];
}) {
  const choices = types?.length ? CHOICES.filter((c) => types.includes(c.type)) : CHOICES;
  const [type, setType] = useState<NameType>(suggestedType ?? 'vendor');
  const [displayName, setDisplayName] = useState(name);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [payType, setPayType] = useState<'hourly' | 'salary' | 'commission'>('hourly');
  const [payRate, setPayRate] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setType(suggestedType ?? 'vendor');
    setDisplayName(name.trim());
    const s = splitName(name);
    setFirst(s.first);
    setLast(s.last);
    setPayType('hourly');
    setPayRate('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function save() {
    setSaving(true);
    try {
      let created: CreatedName;
      if (type === 'employee') {
        if (!first.trim() || !last.trim()) {
          toast('Enter the employee’s first and last name.', 'danger');
          return;
        }
        const e = await api.post<{ id: string }>('/api/employees', {
          firstName: first.trim(),
          lastName: last.trim(),
          payType,
          payRate: payRate.trim() || '0',
        });
        created = { type, id: e.id, label: `${first.trim()} ${last.trim()}` };
      } else {
        const label = displayName.trim();
        if (!label) {
          toast('Enter a name.', 'danger');
          return;
        }
        const path = type === 'customer' ? '/api/customers' : type === 'vendor' ? '/api/vendors' : '/api/lists/other-names';
        const row = await api.post<{ id: string }>(path, type === 'other' ? { name: label } : { displayName: label });
        created = { type, id: row.id, label };
      }
      toast(`${CHOICES.find((c) => c.type === type)!.label} added.`, 'success');
      onCreated(created);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not add the name.', 'danger');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`“${name.trim()}” isn’t in your lists yet`}
      footer={
        <>
          {onUseOnce && (
            <Button variant="secondary" onClick={onUseOnce} disabled={saving} className="mr-auto">
              Just this once
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Add {CHOICES.find((c) => c.type === type)!.label}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {choices.length > 1 && (
        <div>
          <Label>Who is this?</Label>
          <div role="radiogroup" aria-label="Name type" className="grid grid-cols-2 gap-2 mt-1">
            {choices.map((c) => {
              const Icon = c.icon;
              const on = c.type === type;
              return (
                <button
                  key={c.type}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setType(c.type)}
                  className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                    on ? 'border-electric bg-electric/5 text-navy' : 'border-slate-200 text-navy/70 hover:border-electric/50'
                  }`}
                >
                  <Icon className={`h-4 w-4 mt-0.5 ${on ? 'text-electric' : 'text-navy/40'}`} />
                  <span>
                    <span className="block text-sm font-semibold">{c.label}</span>
                    <span className="block text-xs text-navy/50">{c.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        )}

        {type === 'employee' ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="nn-first" required>First name</Label>
                <Input id="nn-first" value={first} onChange={(e) => setFirst(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="nn-last" required>Last name</Label>
                <Input id="nn-last" value={last} onChange={(e) => setLast(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="nn-paytype">Pay type</Label>
                <Select id="nn-paytype" value={payType} onChange={(e) => setPayType(e.target.value as typeof payType)}>
                  <option value="hourly">Hourly</option>
                  <option value="salary">Salary</option>
                  <option value="commission">Commission</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="nn-payrate">Pay rate (optional)</Label>
                <Input id="nn-payrate" inputMode="decimal" placeholder="0.00" value={payRate} onChange={(e) => setPayRate(e.target.value)} />
              </div>
            </div>
            <p className="text-xs text-navy/50">Add tax and payroll details later in the Employee Center.</p>
          </>
        ) : (
          <div>
            <Label htmlFor="nn-name" required>Name</Label>
            <Input id="nn-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            <p className="text-xs text-navy/50 mt-1">You can add the address and other details later.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default NewNameModal;
