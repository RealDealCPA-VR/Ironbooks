/**
 * P1 controls — independent tester: record locking end to end (service getter -> JSON -> client
 * version cache -> header -> withVersionCheck), and changes made through side paths.
 *
 *  - What the GET route returns must carry the version the client caches (payments come back
 *    wrapped with applications; accounts carry editedAt), and that version must be accepted.
 *  - Applying an unapplied payment to an invoice (POST action, not version-checked) still makes
 *    another user's open copy of the payment stale.
 *  - A refused (stale) save writes nothing: TB, A/R and the record are unchanged.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { paymentsReceived, users, userCompanies } from '@/lib/db/schema';
import { ServiceError, type ServiceContext } from './_base';
import { makeTestCompany, type TestCompany } from './testkit.prefs';
import { createCustomer } from './customers';
import { createInvoice, getInvoice } from './invoices';
import { applyPayment, getPayment, receivePayment, updatePayment } from './payments';
import { getAccount, updateAccount } from './accounts';
import { postJournalEntry } from './posting';
import { trialBalance } from './reports';
import { parseVersion, withVersionCheck } from './concurrency';
import { api } from '@/lib/client';

let t: TestCompany;
let alice: ServiceContext;
let bob: ServiceContext;
let customerId: string;
const D = (s: string) => new Date(`${s}T12:00:00Z`);

/** Simulate: the page GETs `url` (served by `load`), then PATCHes it; returns the version header sent. */
async function versionHeaderAfterLoad(url: string, load: () => Promise<unknown>): Promise<string | undefined> {
  const body = JSON.stringify(await load());
  const sent: Array<Record<string, string> | undefined> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_u: string, init?: RequestInit) => {
      sent.push(init?.headers as Record<string, string> | undefined);
      return new Response(init?.method && init.method !== 'GET' ? '{}' : body, { status: 200 });
    }),
  );
  await api.get(url);
  await api.patch(url, {});
  return sent[1]?.['x-expected-updated-at'];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeAll(async () => {
  t = await makeTestCompany('p1-tester-lock');
  alice = t.ctx;
  const [ub] = await t.db.insert(users).values({ email: `bob-${Date.now()}@lock.local`, name: 'Bob', passwordHash: 'x' }).returning();
  await t.db.insert(userCompanies).values({ userId: ub.id, companyId: t.ctx.companyId, role: 'admin' });
  bob = { db: t.db, companyId: t.ctx.companyId, userId: ub.id };
  customerId = (await createCustomer(alice, { displayName: 'Lock Customer' } as never)).id;
}, 180_000);

afterAll(async () => {
  await t.cleanup();
});

describe('record locking end to end', () => {
  it('a payment opened from GET /api/payments/:id carries a version the server accepts', async () => {
    const pay = await receivePayment(alice, {
      customerId,
      date: D('2026-03-01'),
      method: 'check',
      amount: '40.00',
      depositAccountId: t.acct['1000'],
      applications: [],
    } as never);
    const id = (pay as { payment?: { id: string }; id?: string }).payment?.id ?? (pay as { id: string }).id;
    const header = await versionHeaderAfterLoad(`/api/payments/${id}`, () => getPayment(alice, id));
    expect(header).toBeDefined();
    const [row] = await t.db.select().from(paymentsReceived).where(eq(paymentsReceived.id, id));
    expect(header).toBe(row.updatedAt.toISOString());
    // The version the client sends is accepted for a save.
    await withVersionCheck(alice, 'payment_received', id, parseVersion(header), (c) =>
      updatePayment(c, id, {
        customerId,
        date: D('2026-03-01'),
        method: 'check',
        amount: '40.00',
        memo: 'first save',
        depositAccountId: t.acct['1000'],
        applications: [],
      } as never),
    );
  });

  it('accounts: the editedAt version from GET /api/accounts/:id survives a posting and is accepted', async () => {
    const id = t.acct['6400'];
    const header = await versionHeaderAfterLoad(`/api/accounts/${id}`, () => getAccount(alice, id));
    expect(header).toBeDefined();
    await postJournalEntry(bob, {
      date: D('2026-03-02'),
      description: 'Rent',
      lines: [
        { accountId: id, debit: '900.00' },
        { accountId: t.acct['1000'], credit: '900.00' },
      ],
    });
    await withVersionCheck(alice, 'account', id, parseVersion(header), (c) => updateAccount(c, id, { name: 'Rent Expense' } as never));
    // Bob had it open from before Alice's rename: refused.
    const err = await withVersionCheck(bob, 'account', id, parseVersion(header), (c) =>
      updateAccount(c, id, { name: 'Rent & Lease' } as never),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('CONFLICT');
    expect((await getAccount(alice, id)).name).toBe('Rent Expense');
  });

  it('applying a payment (POST action) makes an open copy stale; the stale save changes nothing', async () => {
    const inv = await createInvoice(alice, {
      customerId,
      date: D('2026-03-05'),
      lines: [{ description: 'Service', quantity: 1, rate: '100.00' }],
    } as never);
    const pay = await receivePayment(alice, {
      customerId,
      date: D('2026-03-06'),
      method: 'check',
      amount: '100.00',
      depositAccountId: t.acct['1000'],
      applications: [],
    } as never);
    const id = (pay as { payment?: { id: string }; id?: string }).payment?.id ?? (pay as { id: string }).id;
    const [opened] = await t.db.select().from(paymentsReceived).where(eq(paymentsReceived.id, id));

    await applyPayment(alice, { paymentId: id, applications: [{ invoiceId: inv.id, amountApplied: '100.00' }] } as never);
    const tbBefore = await trialBalance(alice, D('2026-12-31'));
    const invBefore = await getInvoice(alice, inv.id);

    const err = await withVersionCheck(bob, 'payment_received', id, opened.updatedAt, (c) =>
      updatePayment(c, id, {
        customerId,
        date: D('2026-03-06'),
        method: 'check',
        amount: '60.00',
        depositAccountId: t.acct['1000'],
        applications: [],
      } as never),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('CONFLICT');
    expect((err as ServiceError).message).toMatch(/changed by/i);

    const tbAfter = await trialBalance(alice, D('2026-12-31'));
    expect(tbAfter.totals).toEqual(tbBefore.totals);
    expect(tbAfter.balanced).toBe(true);
    const invAfter = await getInvoice(alice, inv.id);
    expect((invAfter as { balanceDue: string }).balanceDue).toBe((invBefore as { balanceDue: string }).balanceDue);
    const [still] = await t.db.select().from(paymentsReceived).where(eq(paymentsReceived.id, id));
    expect(still.amount).toBe('100.00');
  });
});
