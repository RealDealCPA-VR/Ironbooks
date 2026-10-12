/**
 * Preferences take effect (A1/A2): categorized company preferences persist through the
 * Preferences save path (zod schema + whitelist), resolve with defaults, drive server-side
 * defaults (customer/vendor terms, payroll accounts), and My Preferences are per user.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { companySettingsSchema } from '@/lib/validation/company';
import { myPreferencesSchema } from '@/lib/validation/prefs';
import { createCustomer } from './customers';
import { createVendor } from './vendors';
import { updateCompany, getPreferences } from './company';
import { getAllPreferences, getMyPreferences, updateMyPreferences } from './preferences';
import { addMember, makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;

describe('Preferences service (integration)', () => {
  beforeAll(async () => {
    t = await makeTestCompany('prefs');
  });
  afterAll(async () => {
    await t.cleanup();
  });

  it('defaults resolve before anything is saved', async () => {
    const p = await getPreferences(t.ctx);
    expect(p.reportBasis).toBe('accrual');
    expect(p.defaultCustomerTerms).toBe('net_30');
    expect(p.reminders.overdueInvoices.mode).toBe('summary');
  });

  it('persists every new category through the validated save path', async () => {
    const body = {
      requireAccounts: true,
      classTrackingEnabled: true,
      warnUnassignedClass: true,
      warnPastDays: 60,
      warnFutureDays: 10,
      defaultCheckAccountId: t.acct['1000'],
      warnDuplicateCheckNumbers: false,
      estimatesEnabled: true,
      progressInvoicingEnabled: true,
      purchaseOrdersEnabled: false,
      warnDuplicatePoNumbers: false,
      autoApplyPayments: false,
      useUndepositedFunds: false,
      reminders: { overdueInvoices: { mode: 'list', days: 7 }, billsToPay: { mode: 'off', days: 0 } },
      agingFrom: 'transaction_date',
      accountDisplay: 'both',
      defaultShipVia: 'UPS',
      defaultFob: 'Origin',
      priceLevelsEnabled: false,
      salesTaxBasis: 'cash',
      salesTaxFrequency: 'monthly',
      sendForms: { invoice: { subject: 'Your invoice {{number}}', body: 'Hello {{customer.name}}' } },
      firstDayOfWeek: 'sunday',
      trackReimbursedAsIncome: true,
      defaultMarkupPercent: 15,
      multiCurrencyEnabled: true,
      reportBasis: 'cash',
      defaultCustomerTerms: 'net_15',
      defaultVendorTerms: 'net_60',
    };
    const parsed = companySettingsSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    await updateCompany(t.ctx, { settings: parsed.success ? parsed.data : {} });
    const p = await getPreferences(t.ctx);
    expect(p.warnPastDays).toBe(60);
    expect(p.defaultCheckAccountId).toBe(t.acct['1000']);
    expect(p.purchaseOrdersEnabled).toBe(false);
    expect(p.reminders.overdueInvoices).toEqual({ mode: 'list', days: 7 });
    expect(p.reminders.billsToPay.mode).toBe('off');
    expect(p.reminders.checksToPrint.mode).toBe('summary'); // untouched key keeps its default
    expect(p.agingFrom).toBe('transaction_date');
    expect(p.salesTaxBasis).toBe('cash');
    expect(p.sendForms.invoice.subject).toBe('Your invoice {{number}}');
    expect(p.defaultMarkupPercent).toBe(15);
    expect(p.reportBasis).toBe('cash');
  });

  it('the schema rejects bad values', () => {
    expect(companySettingsSchema.safeParse({ warnPastDays: -1 }).success).toBe(false);
    expect(companySettingsSchema.safeParse({ warnPastDays: 1.5 }).success).toBe(false);
    expect(companySettingsSchema.safeParse({ reminders: { nope: { mode: 'list', days: 1 } } }).success).toBe(false);
    expect(companySettingsSchema.safeParse({ salesTaxBasis: 'sometimes' }).success).toBe(false);
    expect(companySettingsSchema.safeParse({ defaultCheckAccountId: 'not-a-uuid' }).success).toBe(false);
    expect(myPreferencesSchema.safeParse({ spellCheckEnabled: 'yes' }).success).toBe(false);
    expect(myPreferencesSchema.safeParse({ unknownPref: true }).success).toBe(false);
  });

  it('new customers and vendors get the default terms preference', async () => {
    const c = await createCustomer(t.ctx, { displayName: 'Terms Customer' });
    expect(c.terms).toBe('net_15');
    const v = await createVendor(t.ctx, { displayName: 'Terms Vendor' });
    expect(v.terms).toBe('net_60');
    // An explicit choice still wins.
    const c2 = await createCustomer(t.ctx, { displayName: 'Explicit Terms', terms: 'due_on_receipt' });
    expect(c2.terms).toBe('due_on_receipt');
  });

  it('My Preferences are per user and do not leak between members', async () => {
    const other = await addMember(t, 'accountant', 'bookkeeper');
    await updateMyPreferences(t.ctx, { spellCheckEnabled: false, reportsRefresh: 'prompt' });
    expect((await getMyPreferences(t.ctx)).spellCheckEnabled).toBe(false);
    expect((await getMyPreferences(other)).spellCheckEnabled).toBe(true);
    await updateMyPreferences(other, { showRemindersAtStartup: true });
    const mine = await getMyPreferences(t.ctx);
    expect(mine.showRemindersAtStartup).toBe(false);
    expect(mine.reportsRefresh).toBe('prompt'); // second save merged, not replaced
    const all = await getAllPreferences(other);
    expect(all.my.showRemindersAtStartup).toBe(true);
    expect(all.company.reportBasis).toBe('cash');
  });

  it('a view-only member may change only their own My Preferences', async () => {
    const viewer = await addMember(t, 'viewer', 'viewer');
    const saved = await updateMyPreferences(viewer, { beepOnRecord: true });
    expect(saved.beepOnRecord).toBe(true);
    await expect(updateCompany(viewer, { settings: { reportBasis: 'accrual' } })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('unknown My Preferences keys are dropped by the service', async () => {
    const saved = await updateMyPreferences(t.ctx, { beepOnRecord: true, ...({ isAdmin: true } as object) });
    expect((saved as unknown as Record<string, unknown>).isAdmin).toBeUndefined();
  });
});
