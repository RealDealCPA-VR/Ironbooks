/**
 * Collections Center > Email > "A statement" (WAVE5C F14). The screen fills "Send to" with the
 * customer's email on file, so a record that holds a list ("ap@acme.test; ar@acme.test") arrives as
 * a typed address. A person sending to the address on file sends as on main: to that list. A typed
 * address that differs is still checked as one address, and an agent's typed address is always
 * checked (one plain address).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { collectionNotes, customers } from '@/lib/db/schema';

const sent: Array<{ to: string }> = [];
vi.mock('./email', async (orig) => {
  const real = await orig<typeof import('./email')>();
  return {
    ...real,
    isConfigured: () => true,
    sendMail: async (opts: { to: string }) => {
      sent.push({ to: opts.to });
    },
  };
});

const { emailCollectionReminder } = await import('./collections');
const { createCustomer } = await import('./customers');
const { makeTestCompany } = await import('./testkit.prefs');
type TestCompany = Awaited<ReturnType<typeof makeTestCompany>>;

const AGENT = { id: '00000000-0000-4000-8000-0000000000e4', name: 'Collections agent', mode: 'post' as const };
const LIST = 'ap@acme.test; ar@acme.test';

let t: TestCompany;
let customerId: string;

beforeAll(async () => {
  t = await makeTestCompany('collections-email');
  customerId = (await createCustomer(t.ctx, { displayName: 'Acme Two Desks', email: 'ap@acme.test' })).id;
  // A list on the record, as an import (or an older version) leaves it: the customer form takes one.
  await t.db.update(customers).set({ email: LIST }).where(eq(customers.id, customerId));
}, 120_000);

afterAll(async () => {
  await t?.cleanup();
});

describe('Collections Center: a statement to the address on file', () => {
  it('a person sends to the list on file, prefilled in "Send to", as before', async () => {
    sent.length = 0;
    const r = await emailCollectionReminder(t.ctx, { customerId, what: 'statement', to: LIST });
    expect(r.sent).toEqual([{ id: customerId, label: 'Statement', to: LIST }]);
    expect(sent.map((s) => s.to)).toEqual([LIST]);
    // The contact is recorded.
    const notes = await t.db.select().from(collectionNotes).where(eq(collectionNotes.customerId, customerId));
    expect(notes.map((n) => n.contactMethod)).toContain('statement');
    // With spaces round it, too.
    await expect(emailCollectionReminder(t.ctx, { customerId, what: 'statement', to: `  ${LIST} ` })).resolves.toMatchObject({
      sent: [{ to: LIST }],
    });
  }, 120_000);

  it('a different typed address is checked as one address, as on a form', async () => {
    sent.length = 0;
    await expect(
      emailCollectionReminder(t.ctx, { customerId, what: 'statement', to: 'ap@acme.test; x@evil.example' }),
    ).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('is not one email address') });
    await expect(emailCollectionReminder(t.ctx, { customerId, what: 'statement', to: 'boss@acme.test' })).resolves.toMatchObject({
      sent: [{ to: 'boss@acme.test' }],
    });
    expect(sent.map((s) => s.to)).toEqual(['boss@acme.test']);
  }, 120_000);

  it("an agent's typed address must be one plain address, even when it is the list on file", async () => {
    sent.length = 0;
    const agentCtx = { ...t.ctx, userId: null, agent: AGENT };
    await expect(emailCollectionReminder(agentCtx, { customerId, what: 'statement', to: LIST })).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    expect(sent).toEqual([]);
  }, 120_000);
});
