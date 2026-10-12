/**
 * Lead Center (J8) and Letters / labels / envelopes (J15).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { eq } from 'drizzle-orm';
import { customers } from '@/lib/db/schema';
import { updateCompany } from './company';
import { createCustomer } from './customers';
import { createInvoice } from './invoices';
import { createTodo, listTodos } from './todos';
import { convertLeadToCustomer, createLead, deleteLead, listLeads, updateLead } from './leads';
import {
  BUILTIN_LETTERS,
  createLetterTemplate,
  deleteLetterTemplate,
  envelopesPdf,
  labelsPdf,
  listLetterTemplates,
  listRecipients,
  mergeLetters,
  prepareLettersPdf,
  updateLetterTemplate,
} from './letters';
import { makeTestCompany, type TestCompany } from './testkit.prefs';

let t: TestCompany;
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const pages = async (b: Uint8Array) => (await PDFDocument.load(b)).getPageCount();

beforeAll(async () => {
  t = await makeTestCompany('leads');
  await updateCompany(t.ctx, {
    settings: { addressLine1: '9 Elm St', city: 'Peoria', state: 'IL', zip: '61602', phone: '555-0100' },
  });
});
afterAll(async () => {
  await t.cleanup();
});

describe('Lead Center (integration)', () => {

  it('creates and edits leads with contacts', async () => {
    await expect(createLead(t.ctx, { name: ' ' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(createLead(t.ctx, { name: 'X', email: 'not-an-email' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const lead = await createLead(t.ctx, {
      name: 'Pat Prospect',
      companyName: 'Prospect LLC',
      status: 'hot',
      address: { line1: '1 Oak', city: 'Peoria', state: 'IL', zip: '61602' },
      contacts: [{ name: 'Pat', email: 'pat@prospect.test' }, { name: '' }],
    });
    expect(lead.contacts).toEqual([{ name: 'Pat', email: 'pat@prospect.test' }]);
    const upd = await updateLead(t.ctx, lead.id, { status: 'warm', notes: 'Met at expo' });
    expect(upd.status).toBe('warm');
  });

  it('converts a lead to a customer and moves its to-dos', async () => {
    const [lead] = await listLeads(t.ctx);
    await createTodo(t.ctx, { title: 'Send quote', entityType: 'lead', entityId: lead.id });
    const { customerId } = await convertLeadToCustomer(t.ctx, lead.id);
    const [cust] = await t.db.select().from(customers).where(eq(customers.id, customerId));
    expect(cust.displayName).toBe('Prospect LLC');
    expect(cust.email).toBe('pat@prospect.test'); // from the first contact
    expect(cust.billingAddress).toMatchObject({ line1: '1 Oak' });
    expect(await listTodos(t.ctx, { entityType: 'customer', entityId: customerId })).toHaveLength(1);
    expect(await listTodos(t.ctx, { entityType: 'lead', entityId: lead.id })).toHaveLength(0);
    expect((await listLeads(t.ctx)).some((l) => l.id === lead.id)).toBe(false);
    expect((await listLeads(t.ctx, { includeConverted: true })).some((l) => l.id === lead.id)).toBe(true);
    await expect(convertLeadToCustomer(t.ctx, lead.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(deleteLead(t.ctx, lead.id)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('a failed conversion leaves the lead untouched', async () => {
    await createCustomer(t.ctx, { displayName: 'Dup Name' });
    const lead = await createLead(t.ctx, { name: 'Dup Name' });
    await expect(convertLeadToCustomer(t.ctx, lead.id)).rejects.toBeTruthy();
    expect((await listLeads(t.ctx)).find((l) => l.id === lead.id)?.convertedCustomerId).toBeNull();
    await deleteLead(t.ctx, lead.id);
  });
});

describe('Letters, labels and envelopes (integration)', () => {
  let lateId: string;
  let paidUpId: string;

  beforeAll(async () => {
    const late = await createCustomer(t.ctx, {
      displayName: 'Slow Payer Inc',
      billingAddress: { line1: '22 Pine Rd', city: 'Normal', state: 'IL', zip: '61761' },
    });
    lateId = late.id;
    paidUpId = (await createCustomer(t.ctx, { displayName: 'Prompt Payer' })).id;
    await createInvoice(t.ctx, {
      customerId: late.id,
      date: day('2026-03-01'),
      dueDate: day('2026-03-31'),
      lines: [{ description: 'Spring work', quantity: '1', rate: '450.00' }],
    });
    await createInvoice(t.ctx, {
      customerId: paidUpId,
      date: day('2026-06-10'),
      dueDate: day('2026-07-10'),
      lines: [{ description: 'Current work', quantity: '1', rate: '20.00' }],
    });
  });

  it('finds customers overdue by at least N days (aging from the due date)', async () => {
    const overdue = await listRecipients(t.ctx, { type: 'customer', overdueDays: 30, today: '2026-06-15' });
    expect(overdue.map((r) => r.name)).toEqual(['Slow Payer Inc']);
    expect(overdue[0].overdueBalance).toBe('450.00');
    expect(overdue[0].daysOverdue).toBe(76);
    expect(overdue[0].addressLines).toEqual(['22 Pine Rd', 'Normal, IL 61761']);
    // Aging from the transaction date makes the same invoice older.
    await updateCompany(t.ctx, { settings: { agingFrom: 'transaction_date' } as never });
    const byTxn = await listRecipients(t.ctx, { type: 'customer', overdueDays: 100, today: '2026-06-15' });
    expect(byTxn.map((r) => r.name)).toEqual(['Slow Payer Inc']);
    await updateCompany(t.ctx, { settings: { agingFrom: 'due_date' } as never });
  });

  it('merges collection letters with the recipient and company details', async () => {
    const [letter] = await mergeLetters(t.ctx, {
      recipientType: 'customer',
      recipientIds: [lateId],
      templateId: 'builtin:collection-firm',
      signer: 'Dana',
      date: '2026-06-15',
    });
    expect(letter.body).toContain('Dear Slow Payer Inc');
    expect(letter.body).toContain('$450.00');
    expect(letter.body).toMatch(/Invoice \d+/);
    expect(letter.body).toContain('555-0100');
    expect(letter.body).toContain('June 15, 2026');
    expect(letter.body).toContain('Dana');
    expect(letter.body).not.toMatch(/\{\{/);
  });

  it('manages company letter templates beside the built-ins', async () => {
    const mine = await createLetterTemplate(t.ctx, { category: 'customer', name: 'Holiday hours', body: 'Dear {{recipient.name}}, we close Dec 24.' });
    const list = await listLetterTemplates(t.ctx);
    expect(list.length).toBe(BUILTIN_LETTERS.length + 1);
    await updateLetterTemplate(t.ctx, mine.id, { body: 'Dear {{recipient.name}}, closed Dec 24-26.' });
    const [m] = await mergeLetters(t.ctx, { recipientType: 'customer', recipientIds: [paidUpId], templateId: mine.id });
    expect(m.body).toBe('Dear Prompt Payer, closed Dec 24-26.');
    await expect(updateLetterTemplate(t.ctx, 'builtin:customer-thanks', { body: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await deleteLetterTemplate(t.ctx, mine.id);
    await expect(mergeLetters(t.ctx, { recipientType: 'customer', recipientIds: [paidUpId], templateId: mine.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('prints letters, Avery labels and envelopes as PDF', async () => {
    const ids = [lateId, paidUpId];
    expect(await pages(await prepareLettersPdf(t.ctx, { recipientType: 'customer', recipientIds: ids, templateId: 'builtin:customer-thanks' }))).toBe(2);
    expect(await pages(await labelsPdf(t.ctx, { recipientType: 'customer', recipientIds: ids }))).toBe(1);
    // Starting at the last label on the sheet pushes the second label to a new sheet.
    expect(await pages(await labelsPdf(t.ctx, { recipientType: 'customer', recipientIds: ids, startPosition: 30 }))).toBe(2);
    expect(await pages(await envelopesPdf(t.ctx, { recipientType: 'customer', recipientIds: ids }))).toBe(2);
    await expect(prepareLettersPdf(t.ctx, { recipientType: 'customer', recipientIds: [] })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('lists vendors, employees and leads as recipients too', async () => {
    expect(Array.isArray(await listRecipients(t.ctx, { type: 'vendor' }))).toBe(true);
    expect(Array.isArray(await listRecipients(t.ctx, { type: 'employee' }))).toBe(true);
    expect(Array.isArray(await listRecipients(t.ctx, { type: 'lead' }))).toBe(true);
    await expect(listRecipients(t.ctx, { type: 'robot' as never })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
