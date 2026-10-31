/**
 * Feature round (accountant) — J7 Reminders: Almost Due Invoices, Overdue vs due bills, Paychecks
 * to Print, Assemblies to Build and Payroll Liabilities due, each driven by Preferences >
 * Reminders; and section totals in HOME currency (review-5 leftover: foreign balances were added
 * to home ones as if they were dollars).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { paychecks } from '@/lib/db/schema';
import { updateCompany } from './company';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { createInvoice } from './invoices';
import { createBill } from './bills';
import { createItem } from './items';
import { createPendingBuild, setBom } from './assemblies';
import { setReorderPoint } from './inventory';
import { createEmployee, createPayRun } from './payroll';
import { upsertCurrency } from './currencies';
import { getReminders } from './reminders';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
const TODAY = '2026-06-15';
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
let customerId: string;
let vendorId: string;

describe('J7 Reminders: the rest of QB\'s list', () => {
  beforeAll(async () => {
    t = await makeTestCompany('j7reminders');
    customerId = (await createCustomer(t.ctx, { displayName: 'Prompt Payer' })).id;
    vendorId = (await createVendor(t.ctx, { displayName: 'Supply Co' })).id;
    // Almost due (in 3 days), overdue (May 1) and far-off (August) invoices.
    await createInvoice(t.ctx, { customerId, date: day('2026-06-01'), dueDate: day('2026-06-18'), lines: [{ description: 'Soon', quantity: '1', rate: '70.00' }] });
    await createInvoice(t.ctx, { customerId, date: day('2026-04-01'), dueDate: day('2026-05-01'), lines: [{ description: 'Late', quantity: '1', rate: '300.00' }] });
    await createInvoice(t.ctx, { customerId, date: day('2026-06-10'), dueDate: day('2026-08-30'), lines: [{ description: 'Later', quantity: '1', rate: '20.00' }] });
    // A bill overdue since June 10 and one due June 20.
    await createBill(t.ctx, { vendorId, date: day('2026-05-20'), dueDate: day('2026-06-10'), lines: [{ accountId: t.acct['6600'], amount: '40.00' }] });
    await createBill(t.ctx, { vendorId, date: day('2026-06-01'), dueDate: day('2026-06-20'), lines: [{ accountId: t.acct['6600'], amount: '120.00' }] });
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('Almost Due Invoices lists invoices due within the window, not the overdue ones', async () => {
    const r = await getReminders(t.ctx, { today: TODAY });
    const s = r.sections.find((x) => x.key === 'almostDueInvoices')!;
    expect(s.count).toBe(1);
    expect(s.total).toBe('70.00');
    expect(s.items[0].date).toBe('2026-06-18');
  });

  it('overdue bills and bills coming due are listed apart (and together when Overdue bills is off)', async () => {
    let r = await getReminders(t.ctx, { today: TODAY });
    const overdue = r.sections.find((x) => x.key === 'overdueBills')!;
    const due = r.sections.find((x) => x.key === 'billsToPay')!;
    expect(overdue.total).toBe('40.00');
    expect(due.total).toBe('120.00');
    await updateCompany(t.ctx, { settings: { reminders: { overdueBills: { mode: 'off', days: 0 } } } });
    r = await getReminders(t.ctx, { today: TODAY });
    expect(r.sections.find((x) => x.key === 'overdueBills')).toBeUndefined();
    expect(r.sections.find((x) => x.key === 'billsToPay')!.total).toBe('160.00');
    await updateCompany(t.ctx, { settings: { reminders: { overdueBills: { mode: 'summary', days: 0 } } } });
  });

  it('Assemblies to Build: pending builds and assemblies at their build point', async () => {
    const part = await createItem(t.ctx, { name: 'Widget part', type: 'inventory', salesPrice: '1.00', purchaseCost: '0.50' } as never);
    const kit = await createItem(t.ctx, { name: 'Widget kit', type: 'inventory', salesPrice: '10.00', purchaseCost: '0', reorderPoint: '5' } as never);
    const box = await createItem(t.ctx, { name: 'Gift box', type: 'inventory', salesPrice: '12.00', purchaseCost: '0', reorderPoint: '2' } as never);
    await setReorderPoint(t.ctx, kit.id, '5');
    await setReorderPoint(t.ctx, box.id, '2');
    await setBom(t.ctx, kit.id, [{ componentItemId: part.id, quantity: '2' }] as never);
    await setBom(t.ctx, box.id, [{ componentItemId: part.id, quantity: '1' }] as never);
    await createPendingBuild(t.ctx, { assemblyItemId: box.id, quantity: '3', date: day('2026-06-14') } as never);
    const r = await getReminders(t.ctx, { today: TODAY });
    const s = r.sections.find((x) => x.key === 'assembliesToBuild')!;
    expect(s.count).toBe(2);
    expect(s.items.some((i) => /^Pending build: 3 × Gift box/.test(i.label))).toBe(true);
    expect(s.items.some((i) => /^Widget kit: 0 on hand \(build point 5\)/.test(i.label))).toBe(true);
  });

  it('Paychecks to Print and Payroll Liabilities due', async () => {
    const emp = await createEmployee(t.ctx, { firstName: 'Pat', lastName: 'Lee', payType: 'salary', payRate: '52000.00' } as never);
    const { results } = await createPayRun(t.ctx, { payDate: day('2026-05-29'), periodsPerYear: 26, employees: [{ employeeId: emp.id }] } as never);
    const pcId = (results as Array<{ paycheckId?: string; paycheck?: { id: string } }>).map((x) => x.paycheckId ?? x.paycheck?.id).find(Boolean)!;
    await t.db.update(paychecks).set({ toPrint: true }).where(eq(paychecks.id, pcId));
    await createPayRun(t.ctx, { payDate: day('2026-06-12'), periodsPerYear: 26, employees: [{ employeeId: emp.id }] } as never);

    const r = await getReminders(t.ctx, { today: TODAY });
    const toPrint = r.sections.find((x) => x.key === 'paychecksToPrint')!;
    expect(toPrint.count).toBe(1);
    expect(toPrint.items[0].label).toBe('Paycheck to Pat Lee');

    const liab = r.sections.find((x) => x.key === 'liabilitiesDue')!;
    // May's withholdings are due June 15; June's are due July 15 (outside the 5-day window).
    expect(liab.items.length).toBeGreaterThan(0);
    expect(liab.items.every((i) => i.date === '2026-06-15')).toBe(true);
    await updateCompany(t.ctx, { settings: { reminders: { liabilitiesDue: { mode: 'summary', days: 40 } } } });
    const later = (await getReminders(t.ctx, { today: TODAY })).sections.find((x) => x.key === 'liabilitiesDue')!;
    expect(later.items.some((i) => i.date === '2026-07-15')).toBe(true);
  });

  it('section totals count foreign documents at their home value', async () => {
    await updateCompany(t.ctx, { settings: { multiCurrencyEnabled: true } });
    await upsertCurrency(t.ctx, { code: 'EUR', name: 'Euro', rateToBase: '1.1' });
    const euro = (await createCustomer(t.ctx, { displayName: 'Euro Client', currency: 'EUR' } as never)).id;
    await createInvoice(t.ctx, {
      customerId: euro,
      date: day('2026-06-01'),
      dueDate: day('2026-06-17'),
      currency: 'EUR',
      exchangeRate: '1.5',
      lines: [{ description: 'EU work', quantity: '1', rate: '100.00' }],
    });
    const r = await getReminders(t.ctx, { today: TODAY });
    const s = r.sections.find((x) => x.key === 'almostDueInvoices')!;
    // 70.00 home + EUR 100.00 at 1.5 = 150.00 home → 220.00 (not 170.00).
    expect(s.total).toBe('220.00');
    const eu = s.items.find((i) => i.currency === 'EUR')!;
    expect(eu.amount).toBe('100.00');
    expect(eu.homeAmount).toBe('150.00');
  });
});
