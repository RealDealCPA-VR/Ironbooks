/**
 * Review round 5 — templates and custom fields under concurrent saves (each failed before its fix):
 *  A  two people making different invoice templates the default at the same moment leave exactly
 *     one default (clear-old + set-new is one transaction);
 *  B  two custom-field values saved at once on the same customer both stick (the values are merged
 *     in the database, not read-modify-written);
 *  C  saving custom-field definitions never overwrites another company setting saved in the
 *     meantime (e.g. the closing date): only the customFields key is written.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { companies, customers, formTemplates } from '@/lib/db/schema';
import type { DB } from '@/lib/db';
import { createFormTemplate, updateFormTemplate } from './formTemplates';
import { setCustomFieldDefinitions, setEntityCustomFields } from './customFields';
import { createCustomer } from './customers';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;

beforeAll(async () => {
  t = await makeTestCompany('r5-tpl');
}, 180_000);
afterAll(async () => {
  await t.cleanup();
});

describe('review5: concurrent saves', () => {
  it('A: one default invoice template after two simultaneous "make default"', async () => {
    const a = await createFormTemplate(t.ctx, { formType: 'invoice', name: 'R5 A' });
    const b = await createFormTemplate(t.ctx, { formType: 'invoice', name: 'R5 B' });
    await Promise.all([
      updateFormTemplate(t.ctx, a.id, { isDefault: true }),
      updateFormTemplate(t.ctx, b.id, { isDefault: true }),
    ]);
    const defaults = await t.db
      .select({ id: formTemplates.id })
      .from(formTemplates)
      .where(and(eq(formTemplates.companyId, t.ctx.companyId), eq(formTemplates.formType, 'invoice'), eq(formTemplates.isDefault, true)));
    expect(defaults).toHaveLength(1);
  });

  it('B: two values saved at once on one customer both stick', async () => {
    await setCustomFieldDefinitions(t.ctx, { customer: [{ name: 'Region' }, { name: 'Rep' }] });
    const c = await createCustomer(t.ctx, { displayName: 'R5 Fields Customer' });
    await Promise.all([
      setEntityCustomFields(t.ctx, 'customer', c.id, { Region: 'West' }),
      setEntityCustomFields(t.ctx, 'customer', c.id, { Rep: 'Dana' }),
    ]);
    const [row] = await t.db.select({ f: customers.customFields }).from(customers).where(eq(customers.id, c.id));
    expect(row.f).toEqual({ Region: 'West', Rep: 'Dana' });
  });

  it('C: saving definitions keeps a closing date saved in the meantime', async () => {
    // Another user's save lands between this save's read of the settings and its write.
    let interleaved = false;
    const db = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'update') {
          return (table: unknown) => {
            const builder = target.update(table as typeof companies);
            if (table !== companies || interleaved) return builder;
            interleaved = true;
            return {
              set: (values: Record<string, unknown>) => ({
                where: async (where: unknown) => {
                  await target.execute(
                    sql`UPDATE companies SET settings = coalesce(settings, '{}'::jsonb) || '{"closingDate":"2026-03-31"}'::jsonb WHERE id = ${t.ctx.companyId}`,
                  );
                  return builder.set(values as never).where(where as never);
                },
              }),
            };
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as DB;
    await setCustomFieldDefinitions({ ...t.ctx, db }, { vendor: [{ name: 'Account #' }] });
    expect(interleaved).toBe(true);
    const [co] = await t.db.select({ s: companies.settings }).from(companies).where(eq(companies.id, t.ctx.companyId));
    const s = co.s as Record<string, unknown>;
    expect(s.closingDate).toBe('2026-03-31');
    expect((s.customFields as { vendor: Array<{ name: string }> }).vendor).toEqual([{ name: 'Account #' }]);
  });
});
