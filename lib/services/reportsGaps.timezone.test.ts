/**
 * Report gaps round — review-round-5 leftovers on "today" and time zones (failing tests first).
 *
 *  - The company time-zone preference defaulted to America/New_York and todayInTimeZone fell back
 *    to UTC, so Needs attention / reminders / letters used another "today" than the reports (this
 *    computer's day) for anyone outside Eastern time. With no zone set, both now follow this
 *    computer's zone and day.
 *  - Needs attention showed "You last sent a reminder on …" and the backup age on the UTC day of
 *    the moment (an evening reminder read as tomorrow); real timestamps are now read on the
 *    company's clock, calendar days stay calendar days.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const origTz = vi.hoisted(() => {
  const was = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  return was;
});

import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { auditLogs, companies } from '@/lib/db/schema';
import { resolveCompanyPreferences, todayInTimeZone } from '@/lib/preferences';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { makeTestCompany, type TestCompany } from './testkit.prefs';
import { getAttention } from './attention';
import { BACKUP_HISTORY_FILE } from './backupHistory';

let t: TestCompany;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

beforeAll(async () => {
  t = await makeTestCompany('gaps-tz');
}, 180_000);
afterAll(async () => {
  await t.cleanup();
  if (origTz === undefined) delete process.env.TZ;
  else process.env.TZ = origTz;
});

describe('default time zone = this computer', () => {
  it('a company with no time zone set uses this computer’s zone', () => {
    expect(resolveCompanyPreferences({}).timezone).toBe('America/Los_Angeles');
    expect(resolveCompanyPreferences({ timezone: 'Europe/Paris' }).timezone).toBe('Europe/Paris');
  });

  it('no zone = this computer’s calendar day (it was the UTC day)', () => {
    const evening = new Date('2026-10-27T05:30:00.000Z'); // Oct 26, 10:30 pm Pacific
    expect(todayInTimeZone(undefined, evening)).toBe('2026-10-26');
    expect(todayInTimeZone('Not/AZone', evening)).toBe('2026-10-26');
    expect(todayInTimeZone('America/New_York', evening)).toBe('2026-10-27');
  });
});

describe('Needs attention reads timestamps on the company clock', () => {
  it('a reminder sent on an Eastern evening is "Oct 26", and the backup age counts company days', async () => {
    await t.db.update(companies).set({ settings: { timezone: 'America/New_York' } }).where(eq(companies.id, t.ctx.companyId));
    const cust = await createCustomer(t.ctx, { displayName: 'TZ Slow Payer', email: 'tz@slow.test' });
    const inv = await createInvoice(t.ctx, {
      customerId: cust.id,
      date: day('2026-09-01'),
      dueDate: day('2026-10-01'),
      lines: [{ description: 'Work', quantity: '1', rate: '50.00' }],
    });
    // Sent Oct 26 at 11:30 pm New York (03:30 UTC on the 27th).
    await t.db.insert(auditLogs).values({
      companyId: t.ctx.companyId,
      userId: t.ctx.userId,
      action: 'create',
      entityType: 'payment_reminder',
      entityId: inv.id,
      createdAt: new Date('2026-10-27T03:30:00.000Z'),
    });
    // Last full backup Oct 19 at 11:00 pm New York (03:00 UTC on the 20th): 8 company days before
    // Oct 27 (7 by the UTC day, which hid the reminder).
    fs.writeFileSync(
      path.join(t.dir, BACKUP_HISTORY_FILE),
      JSON.stringify({ records: [{ id: 'b1', at: '2026-10-20T03:00:00.000Z', kind: 'full', source: 'manual', filename: 'x.bka', path: null, sizeBytes: 1, fingerprint: null }] }),
    );
    const res = await getAttention(t.ctx, { today: '2026-10-27', now: new Date('2026-10-27T15:00:00.000Z'), dataDir: t.dir });
    const overdue = res.items.find((i) => i.kind === 'overdue_invoice');
    expect(overdue?.detail).toContain('You last sent a reminder on Oct 26, 2026.');
    const backup = res.items.find((i) => i.kind === 'backup');
    expect(backup?.title).toBe('Back up your books: the last backup was 8 days ago');
    expect(backup?.date).toBe('2026-10-19');
  });
});
