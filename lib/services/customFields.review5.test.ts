/**
 * Review round 5 — custom fields (failed before the fix): the change and its audit row commit
 * together. A save that cannot be audited (here a view-only member, whom writeAudit refuses) used
 * to answer "not allowed" AFTER the new value had already been written.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { customers } from '@/lib/db/schema';
import { getCustomFieldDefinitions, setCustomFieldDefinitions, setEntityCustomFields } from './customFields';
import { createCustomer } from './customers';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;

beforeAll(async () => {
  t = await makeTestCompany('r5-cf');
  await setCustomFieldDefinitions(t.ctx, { customer: [{ name: 'Region' }] });
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('review5: custom field values', () => {
  it('a value save refused at audit time changes nothing', async () => {
    const c = await createCustomer(t.ctx, { displayName: 'R5 CF Customer' });
    await setEntityCustomFields(t.ctx, 'customer', c.id, { Region: 'North' });
    const viewer = { ...t.ctx, role: 'viewer' as const };
    await expect(setEntityCustomFields(viewer, 'customer', c.id, { Region: 'South' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const [row] = await t.db.select({ cf: customers.customFields }).from(customers).where(eq(customers.id, c.id));
    expect(row.cf).toEqual({ Region: 'North' });
  });

  it('a definitions save refused at audit time changes nothing', async () => {
    const viewer = { ...t.ctx, role: 'viewer' as const };
    await expect(setCustomFieldDefinitions(viewer, { customer: [{ name: 'Region' }, { name: 'Sneaky' }] })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect((await getCustomFieldDefinitions(t.ctx)).customer).toEqual([{ name: 'Region' }]);
  });
});
