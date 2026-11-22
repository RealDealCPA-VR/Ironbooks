'use client';
/**
 * Agent requests: the "Approve similar…" form (plan 4.4). Standing permission lets the agent do
 * more of the same operation without asking, within the limits the person ticks, until the time
 * runs out. It is never "always": changing what an agent may do for good is the Admin's job in
 * Users & Roles > Agents, not something an approval card can do.
 *
 * The form opens with every limit that fits the request ticked and filled from it (words.ts
 * initialGrantForm), and never offers more time than this person may give (grantMinutesMax, worked
 * out by the server, which checks it again). When the books changed, the card takes again from the
 * new preview only what the person had not changed (its amount and count: words.ts
 * rebuildGrantForm), and the form says what it did.
 */
import { AmountInput, Input, Label, Select } from '@/components/ui';
import type { AgentRequestForPerson } from '@/lib/agent/contract';
import { dayRange, durationOptions, plain, type GrantForm } from './words';

export default function ApproveSimilar({
  request,
  form,
  onChange,
  now,
  error,
  rebuilt = null,
}: {
  request: AgentRequestForPerson;
  form: GrantForm;
  onChange: (form: GrantForm) => void;
  /** When the card opened: the times in the choices count from it. */
  now: Date;
  error: string;
  /** The books changed and the form was filled in again: what was kept and what was taken anew. */
  rebuilt?: string | null;
}) {
  const options = durationOptions(request.grantMinutesMax, request.kind === 'grant' ? (request.grantAsked?.minutes ?? null) : null, now);
  const set = (patch: Partial<GrantForm>) => onChange({ ...form, ...patch });
  const agent = plain(request.agentName);
  const tick = 'mt-0.5 h-4 w-4 flex-none';
  const row = 'flex items-start gap-2 text-sm text-navy';
  return (
    <section aria-labelledby="similar-title" className="space-y-3 rounded-lg border border-electric/30 bg-electric/[.03] p-3">
      <div>
        <h3 id="similar-title" className="text-sm font-semibold text-navy">
          {request.kind === 'grant' ? 'Give standing permission' : 'Approve this and similar requests'}
        </h3>
        <p className="mt-0.5 text-xs text-navy/60">
          {agent} may then do more of the same kind of work without asking, within the limits ticked below, until the time runs out. You can take
          it back at any time in Users &amp; Roles &gt; Agents.
        </p>
        {rebuilt && (
          <p data-similar-rebuilt="" className="mt-1 text-xs font-semibold text-amber-800">
            {rebuilt}
          </p>
        )}
      </div>
      <div className="max-w-xs">
        <Label htmlFor="similar-minutes">For how long</Label>
        <Select id="similar-minutes" autoFocus value={String(form.minutes)} onChange={(e) => set({ minutes: Number(e.target.value) })}>
          {options.map((o) => (
            <option key={o.minutes} value={o.minutes}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-[13px] font-medium text-navy/70">Only when</legend>
        <div className={row}>
          <input id="similar-amount-on" type="checkbox" className={tick} checked={form.amountOn} onChange={(e) => set({ amountOn: e.target.checked })} />
          <span className="flex flex-wrap items-center gap-2">
            <label htmlFor="similar-amount-on">The amount is at or below</label>
            <AmountInput
              aria-label="Largest amount"
              className="w-32 py-1"
              value={form.amount}
              disabled={!form.amountOn}
              onChange={(e) => set({ amount: e.target.value })}
            />
          </span>
        </div>
        {form.entityIds.length > 0 && (
          <label className={row}>
            <input type="checkbox" className={tick} checked={form.entitiesOn} onChange={(e) => set({ entitiesOn: e.target.checked })} />
            <span>
              {request.kind === 'grant'
                ? `It is for the ${form.entityIds.length === 1 ? 'customer, vendor or name' : `${form.entityIds.length} customers, vendors or names`} the agent named`
                : 'It is for the same customer, vendor or name as this request'}
            </span>
          </label>
        )}
        {form.accountIds.length > 0 && (
          <label className={row}>
            <input type="checkbox" className={tick} checked={form.accountsOn} onChange={(e) => set({ accountsOn: e.target.checked })} />
            <span>
              {request.kind === 'grant'
                ? `It is for the ${form.accountIds.length === 1 ? 'account' : `${form.accountIds.length} accounts`} the agent named`
                : `It is for the same ${form.accountIds.length === 1 ? 'account' : 'accounts'} as this request`}
            </span>
          </label>
        )}
        {form.datesOffered && (
          <label className={row}>
            <input type="checkbox" className={tick} checked={form.datesOn} onChange={(e) => set({ datesOn: e.target.checked })} />
            <span>It is dated {dayRange(form.dateFrom, form.dateTo)}</span>
          </label>
        )}
        <div className={row}>
          <input id="similar-uses-on" type="checkbox" className={tick} checked={form.usesOn} onChange={(e) => set({ usesOn: e.target.checked })} />
          <span className="flex flex-wrap items-center gap-2">
            <label htmlFor="similar-uses-on">At most this many times</label>
            <Input
              aria-label="Most times"
              type="number"
              min={1}
              max={10000}
              className="w-24 py-1"
              value={form.uses}
              disabled={!form.usesOn}
              onChange={(e) => set({ uses: e.target.value })}
            />
          </span>
        </div>
        {(form.countRequired || form.countOffered) && (
          <div className={row}>
            <input
              id="similar-count-on"
              type="checkbox"
              className={tick}
              checked={form.countRequired || form.countOn}
              disabled={form.countRequired}
              onChange={(e) => set({ countOn: e.target.checked })}
            />
            <span className="flex flex-wrap items-center gap-2">
              <label htmlFor="similar-count-on">At most this many records each time</label>
              <Input
                aria-label="Most records each time"
                type="number"
                min={1}
                className="w-24 py-1"
                value={form.count}
                disabled={!form.countRequired && !form.countOn}
                onChange={(e) => set({ count: e.target.value })}
              />
              {form.countRequired && <span className="text-xs text-navy/50">Always limited when many records change at once.</span>}
            </span>
          </div>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
