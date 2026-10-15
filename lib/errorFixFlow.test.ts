/**
 * The fix presenter's logic (lib/errorFixFlow.ts, used by useErrorFixes in
 * components/ErrorFixPanel.tsx): an error is shown once, and clicking a Fix button patches the
 * body, copies the change back to the form, and re-submits the patched (prepared) body.
 */
import { describe, expect, it, vi } from 'vitest';
import { reportMode, runFix } from './errorFixFlow';
import type { ErrorFix } from './errorFixes';

describe('reportMode (no duplicate toast + panel)', () => {
  it('errors without fixes toast', () => {
    expect(reportMode(0, true)).toBe('toast');
    expect(reportMode(0, false)).toBe('toast');
  });
  it('with an inline panel the error shows ONLY in the panel', () => {
    expect(reportMode(2, true)).toBe('panel');
  });
  it('without a panel the toast carries the Fix buttons', () => {
    expect(reportMode(1, false)).toBe('toast-with-fixes');
  });
});

type Body = { date: string; lines: { credit: string }[] };

function deps() {
  return {
    navigate: vi.fn(),
    setBusy: vi.fn(),
    onSaved: vi.fn(),
    onError: vi.fn(),
  };
}

const addFix: ErrorFix = {
  id: 'balance-add-2',
  kind: 'patch',
  label: 'Add $40.00 to line 3',
  patch: [{ op: 'add', path: 'lines.2.credit', amount: '40.00' }],
};

describe('runFix (click a Fix button)', () => {
  const payload: Body = { date: '2026-06-01', lines: [{ credit: '0' }, { credit: '10.00' }, { credit: '20.00' }] };

  it('patch fix: applyToForm gets the patched body, resubmit gets it too, panel clears', async () => {
    const d = deps();
    const applyToForm = vi.fn();
    const resubmit = vi.fn().mockResolvedValue(undefined);
    const out = await runFix(addFix, { payload, resubmit, applyToForm }, d);
    expect(out).toBe('saved');
    const patched = applyToForm.mock.calls[0][0] as Body;
    expect(patched.lines[2].credit).toBe('60.00');
    expect(applyToForm.mock.calls[0][1]).toBe(addFix);
    expect(resubmit).toHaveBeenCalledWith(patched);
    expect(payload.lines[2].credit).toBe('20.00'); // the original body is not mutated
    expect(d.setBusy.mock.calls).toEqual([['balance-add-2'], [null]]);
    expect(d.onSaved).toHaveBeenCalledTimes(1);
    expect(d.onError).not.toHaveBeenCalled();
    // applyToForm runs before the save, so the form shows what is being saved.
    expect(applyToForm.mock.invocationCallOrder[0]).toBeLessThan(resubmit.mock.invocationCallOrder[0]);
  });

  it('prepare: resubmit (and a second failure) use the prepared body; the form gets the unprepared one', async () => {
    const d = deps();
    const applyToForm = vi.fn();
    const prepare = (b: Body): Body => ({ ...b, lines: b.lines.filter((l) => Number(l.credit) > 0) });
    const err = new Error('still wrong');
    const resubmit = vi.fn().mockRejectedValue(err);
    const out = await runFix(addFix, { payload, resubmit, applyToForm, prepare }, d);
    expect(out).toBe('failed');
    expect((applyToForm.mock.calls[0][0] as Body).lines).toHaveLength(3);
    const sent = resubmit.mock.calls[0][0] as Body;
    expect(sent.lines.map((l) => l.credit)).toEqual(['10.00', '60.00']);
    expect(d.onError).toHaveBeenCalledWith(err, sent);
    expect(d.onSaved).not.toHaveBeenCalled();
    expect(d.setBusy).toHaveBeenLastCalledWith(null);
  });

  it('retry fix without a patch re-sends the same body (e.g. "Save without a class")', async () => {
    const d = deps();
    const resubmit = vi.fn().mockResolvedValue(undefined);
    await runFix({ id: 'class-skip', kind: 'retry', label: 'Save without a class' }, { payload, resubmit }, d);
    expect(resubmit).toHaveBeenCalledWith(payload);
  });

  it('retry fix with a flag ("Keep 7001 anyway") adds the flag to the body', async () => {
    const d = deps();
    const resubmit = vi.fn().mockResolvedValue(undefined);
    await runFix(
      { id: 'docnum-keep', kind: 'retry', label: 'Keep 7001 anyway', patch: [{ op: 'set', path: 'allowDuplicateNumber', value: true }] },
      { payload, resubmit },
      d,
    );
    expect(resubmit.mock.calls[0][0]).toMatchObject({ allowDuplicateNumber: true, date: '2026-06-01' });
  });

  it('navigate fix opens the page and saves nothing', async () => {
    const d = deps();
    const resubmit = vi.fn();
    const applyToForm = vi.fn();
    const out = await runFix(
      { id: 'period-reopen', kind: 'navigate', label: 'Reopen the period', href: '/fiscal-periods' },
      { payload, resubmit, applyToForm },
      d,
    );
    expect(out).toBe('navigated');
    expect(d.navigate).toHaveBeenCalledWith('/fiscal-periods');
    expect(resubmit).not.toHaveBeenCalled();
    expect(applyToForm).not.toHaveBeenCalled();
    expect(d.setBusy).not.toHaveBeenCalled();
  });
});
