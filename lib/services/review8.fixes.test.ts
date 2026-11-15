/**
 * Review loop 8 fixes (imports / exports, A/P):
 *  - Batch Enter refuses decimal-comma amounts instead of reading them 100x too large;
 *  - IIF dates a month doesn't have are refused; IIF is written in Windows-1252;
 *  - a customer CSV keeps "Customer:Job"; an account CSV without numbers matches by full name;
 *  - list export needs the Payroll right for employees.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { accounts, customers } from '@/lib/db/schema';
import { unionRoles, type RoleDefinition } from '@/lib/permissions/model';
import { encodeWindows1252 } from '@/lib/textEncode';
import type { ServiceContext } from './_base';
import { normalizeAmount } from './accountant/batchEnterParse';
import { importAccountsCSV, importCustomersCSV, parseIifDate } from './qbImport';
import { exportList } from './listExport';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;

beforeAll(async () => {
  t = await makeTestCompany('review8');
}, 120_000);
afterAll(async () => {
  await t.cleanup();
});

describe('parsing', () => {
  it('Batch Enter: thousands groups only', () => {
    expect(normalizeAmount('12,50')).toBeNull();
    expect(normalizeAmount('1 234,56')).toBeNull();
    expect(normalizeAmount('1,234.56')).toBe('1234.56');
    expect(normalizeAmount('  $ 1,000 ')).toBe('1000');
    expect(normalizeAmount('(12.00)')).toBe('-12.00');
    expect(normalizeAmount('-1,234.56')).toBe('-1234.56');
    expect(normalizeAmount('--5')).toBeNull();
  });

  it('IIF dates: no rolling into the next month', () => {
    expect(parseIifDate('4/31/2026')).toBeNull();
    expect(parseIifDate('2/30/2024')).toBeNull();
    expect(parseIifDate('2/29/2024')?.toISOString().slice(0, 10)).toBe('2024-02-29');
  });

  it('IIF text in Windows-1252', () => {
    expect([...encodeWindows1252('Café €5')]).toEqual([0x43, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x35]);
    expect([...encodeWindows1252('✓')]).toEqual([0x3f]);
  });
});

describe('list imports', { timeout: 120_000 }, () => {
  it('a "Customer:Job" row keeps its parent', async () => {
    await importCustomersCSV(t.ctx, 'Name\nAcme R8\nAcme R8:Kitchen\nBeta R8:Deck\n', { displayName: 'Name' });
    const rows = await t.db.select().from(customers).where(eq(customers.companyId, t.ctx.companyId));
    const acme = rows.find((r) => r.displayName === 'Acme R8')!;
    const kitchen = rows.find((r) => r.displayName === 'Acme R8:Kitchen')!;
    const beta = rows.find((r) => r.displayName === 'Beta R8');
    expect(kitchen.parentId).toBe(acme.id);
    expect(beta).toBeTruthy(); // created for its job
    expect(rows.find((r) => r.displayName === 'Beta R8:Deck')?.parentId).toBe(beta!.id);
  });

  it('an account list without numbers matches the chart by full name (any case)', async () => {
    const before = await t.db.select({ id: accounts.id }).from(accounts).where(eq(accounts.companyId, t.ctx.companyId));
    const seeded = await t.db.select().from(accounts).where(and(eq(accounts.companyId, t.ctx.companyId), eq(accounts.code, '6300')));
    const res = await importAccountsCSV(t.ctx, `Name,Type\n${seeded[0].name.toUpperCase()},Expense\n`, { name: 'Name', type: 'Type' });
    expect(res.skipped).toBe(1);
    const after = await t.db.select({ id: accounts.id }).from(accounts).where(eq(accounts.companyId, t.ctx.companyId));
    expect(after.length).toBe(before.length);
  });
});

describe('list export', () => {
  it('employees need the Payroll right; "all" leaves them out without it', async () => {
    const role = { key: 'custom-fu', name: 'FU', description: '', builtin: false, flags: {}, permissions: { file_utilities: ['view', 'print'], customers: ['view'] } } as unknown as RoleDefinition;
    const limited: ServiceContext = { ...t.ctx, access: unionRoles([role]) };
    await expect(exportList(limited, 'employees', 'csv')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const iif = await exportList(limited, 'all', 'iif');
    expect(Buffer.from(iif.body as Buffer).toString('latin1')).not.toMatch(/^!EMP/m);
  });
});
