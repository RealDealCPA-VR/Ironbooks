/**
 * P1 controls — re-test round 2 (independent tester): queuing a closed-period paycheck to print
 * needs the closing date password (fix 30fce5e).
 *
 *  - A batch mixing an open-period and a closed-period paycheck, without the password, is refused
 *    as a whole: neither paycheck is flagged and no audit row is written (atomic).
 *  - The boundary: a paycheck dated ON the closing date is closed; the day after is open.
 *  - Re-queuing a paycheck already in the queue changes nothing, so it needs no password and
 *    records no new exception.
 *  - A paycheck with no journal entry, dated in the closed period, is refused too (the date is
 *    enough).
 *  - A voided closed-period paycheck is refused as void (not prompted for a password) and another
 *    company's paycheck is not found, even with the password.
 *  - The trial balance never moves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLogs, employees, paychecks } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { makeTestCompany, type TestCompany } from './testkit.prefs';
import { postJournalEntry } from './posting';
import { queuePaychecks } from './printQueue';
import { setClosingDate } from './company';
import { trialBalance } from './reports';
import { closingDateExceptionReport } from './accountant/auditReports';

let t: TestCompany;
let other: TestCompany;
let over: ServiceContext;
let employeeId: string;
const D = (s: string) => new Date(`${s}T12:00:00Z`);

async function paycheck(date: string, opts: { posted?: boolean; voided?: boolean } = {}) {
  const posted = opts.posted ?? true;
  const entry = posted
    ? await postJournalEntry(t.ctx, {
        date: D(date),
        description: `Paycheck ${date}`,
        lines: [
          { accountId: t.acct['6500'], debit: '100.00' },
          { accountId: t.acct['1000'], credit: '100.00' },
        ],
      })
    : null;
  const [pc] = await t.ctx.db
    .insert(paychecks)
    .values({
      companyId: t.ctx.companyId,
      employeeId,
      payDate: D(date),
      grossPay: '100.00',
      totalTaxes: '0.00',
      netPay: '100.00',
      postedEntryId: entry?.id ?? null,
      voidedAt: opts.voided ? new Date() : null,
    } as never)
    .returning();
  return { pc, entryId: entry?.id ?? null };
}

async function flagged(id: string) {
  return (await t.ctx.db.select().from(paychecks).where(eq(paychecks.id, id)))[0].toPrint;
}

async function auditCount(id: string) {
  return (
    await t.ctx.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'paycheck'), eq(auditLogs.entityId, id)))
  ).length;
}

beforeAll(async () => {
  other = await makeTestCompany('p1-print-r2-other');
  t = await makeTestCompany('p1-print-r2');
  over = { ...t.ctx, closingDateOverride: true };
  const [emp] = await t.ctx.db
    .insert(employees)
    .values({ companyId: t.ctx.companyId, firstName: 'Retest', lastName: 'Two' })
    .returning();
  employeeId = emp.id;
  await postJournalEntry(t.ctx, {
    date: D('2026-01-01'),
    description: 'Opening',
    lines: [
      { accountId: t.acct['1000'], debit: '5000.00' },
      { accountId: t.acct['3900'], credit: '5000.00' },
    ],
  });
}, 180_000);

afterAll(async () => {
  await t.cleanup();
  await other.cleanup();
});

describe('queue paychecks vs the closing date (re-test)', () => {
  it('a mixed open/closed batch without the password is refused whole; with it both are queued', async () => {
    await setClosingDate(t.ctx, { closingDate: null } as never);
    const open = await paycheck('2026-02-01');
    const closed = await paycheck('2026-01-31'); // ON the closing date
    await setClosingDate(t.ctx, { closingDate: '2026-01-31', password: 'pw' } as never);
    const tb = (await trialBalance(t.ctx, D('2026-12-31'))).rows;
    const auditsBefore = [await auditCount(open.pc.id), await auditCount(closed.pc.id)];

    await expect(queuePaychecks(t.ctx, [open.pc.id, closed.pc.id])).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    await expect(queuePaychecks(t.ctx, [closed.pc.id, open.pc.id])).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    expect(await flagged(open.pc.id)).toBe(false);
    expect(await flagged(closed.pc.id)).toBe(false);
    expect([await auditCount(open.pc.id), await auditCount(closed.pc.id)]).toEqual(auditsBefore);
    expect((await closingDateExceptionReport(t.ctx)).rows.some((r) => r.entryId === closed.entryId)).toBe(false);

    // The day after the closing date is open: no password needed.
    await queuePaychecks(t.ctx, [open.pc.id]);
    expect(await flagged(open.pc.id)).toBe(true);
    expect((await closingDateExceptionReport(t.ctx)).rows.some((r) => r.entryId === open.entryId)).toBe(false);

    await queuePaychecks(over, [open.pc.id, closed.pc.id]);
    expect(await flagged(closed.pc.id)).toBe(true);
    const exceptions = (await closingDateExceptionReport(t.ctx)).rows.filter((r) => r.entryId === closed.entryId);
    expect(exceptions.length).toBe(1);

    // Re-queuing an already-queued closed-period paycheck changes nothing: no password, no new exception.
    await queuePaychecks(t.ctx, [closed.pc.id]);
    expect((await closingDateExceptionReport(t.ctx)).rows.filter((r) => r.entryId === closed.entryId).length).toBe(1);
    expect((await trialBalance(t.ctx, D('2026-12-31'))).rows).toEqual(tb);
  });

  it('a closed-period paycheck with no journal entry is refused by its date', async () => {
    await setClosingDate(t.ctx, { closingDate: null } as never);
    const { pc } = await paycheck('2026-01-20', { posted: false });
    await setClosingDate(t.ctx, { closingDate: '2026-01-31', password: 'pw' } as never);
    await expect(queuePaychecks(t.ctx, [pc.id])).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    expect(await flagged(pc.id)).toBe(false);
    await queuePaychecks(over, [pc.id]);
    expect(await flagged(pc.id)).toBe(true);
  });

  it('a voided closed-period paycheck is refused as void; another company cannot queue it even with the password', async () => {
    await setClosingDate(t.ctx, { closingDate: null } as never);
    const voided = await paycheck('2026-01-21', { voided: true });
    const live = await paycheck('2026-01-22');
    await setClosingDate(t.ctx, { closingDate: '2026-01-31', password: 'pw' } as never);
    await expect(queuePaychecks(t.ctx, [voided.pc.id])).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(queuePaychecks(over, [voided.pc.id])).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await flagged(voided.pc.id)).toBe(false);

    const stranger: ServiceContext = { ...other.ctx, closingDateOverride: true };
    await expect(queuePaychecks(stranger, [live.pc.id])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await flagged(live.pc.id)).toBe(false);
    expect(await auditCount(live.pc.id)).toBe(0);
  });
});
