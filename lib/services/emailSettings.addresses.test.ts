/**
 * Email recipients are refused when the mailer would read them as something other than the
 * address(es) they look like (lib/services/emailSettings.ts isEmailAddress / isPlainAddress /
 * recipientProblem), for the payment reminder (attention.ts), a sales form's and a statement's
 * email (salesForms.ts) and the Send Forms settings:
 *  - a person's entry: no "( ) \" < > [ ] \\ :" and, in a field for one recipient, no "," or ";";
 *  - an agent's: plain addresses only (a domain of letters, digits, dots and hyphens), with the
 *    plain message "Send just the email address…", also for the address on a customer's record.
 * nodemailer's own address parser is the judge: every address the check lets through is read by it
 * as exactly that one address.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import addressparser from 'nodemailer/lib/addressparser';
import { customers } from '@/lib/db/schema';

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

const {
  SEND_JUST_THE_ADDRESS,
  SEND_JUST_THE_ADDRESSES,
  isEmailAddress,
  isPlainAddress,
  parseAddressList,
  recipientProblem,
} = await import('./emailSettings');
const { sendPaymentReminder } = await import('./attention');
const { emailCustomerStatement, emailSalesForm } = await import('./salesForms');
const { createCustomer } = await import('./customers');
const { createInvoice } = await import('./invoices');
const { makeTestCompany } = await import('./testkit.prefs');
type TestCompany = Awaited<ReturnType<typeof makeTestCompany>>;

const AGENT = { id: '00000000-0000-4000-8000-0000000000e3', name: 'Mail agent', mode: 'post' as const };
const PERSON = {};
const AN_AGENT = { agent: AGENT };

describe('the address check', () => {
  it('lets through only what nodemailer reads as exactly that one address', () => {
    const taken: string[] = [];
    for (let c = 33; c < 127; c++) {
      const ch = String.fromCharCode(c);
      for (const v of [`a${ch}b@acme.com`, `ab@ac${ch}me.com`, `ab@acme.com${ch}x`, `${ch}ab@acme.com`, `acme.com${ch}x@evil.example`, `ab${ch}@acme.com`]) {
        if (!isEmailAddress(v)) continue;
        taken.push(v);
        expect(addressparser(v), v).toEqual([{ address: v, name: '' }]);
      }
    }
    expect(taken.length).toBeGreaterThan(100); // the check is not just refusing everything
  });

  it('refuses the forms the mailer reads as a comment, a name, a literal, an escape, a group or a second address', () => {
    for (const v of [
      'billing.acme.com(x)@evil.com',
      'billing.acme.com"@evil.com',
      'Name<x@evil.example>',
      'billing.acme.com[x]@evil.com',
      'a\\b@acme.com',
      'acme.com:x@evil.example',
      'a@acme.com,x@evil.example',
      'a@acme.com;x@evil.example',
      'a@acme.com x@evil.example',
    ]) {
      expect(isEmailAddress(v), v).toBe(false);
      expect(isPlainAddress(v), v).toBe(false);
    }
    // Ordinary addresses still pass, for a person and an agent alike.
    for (const v of ["o'brien@acme.com", 'ap+invoices@acme-corp.co.uk', 'a.b@x-y.com']) {
      expect(isEmailAddress(v), v).toBe(true);
      expect(isPlainAddress(v), v).toBe(true);
    }
  });

  it("an agent's address needs a domain of letters, digits, dots and hyphens", () => {
    for (const v of ['ap@acme_corp.com', 'ap@acme.com!x', 'ap@acmé.com', 'ap@acme..com', 'ap@.acme.com']) {
      expect(isPlainAddress(v), v).toBe(false);
    }
    expect(isEmailAddress('ap@acme_corp.com')).toBe(true); // a person may still type it
  });

  it("an agent's address holds no control character or invisible mark before the @ (the approval card leaves them out)", () => {
    for (const v of ['ap‮gro@acme.com', 'a​p@acme.com', 'a\u0001p@acme.com', 'ap­x@acme.com', 'äp@acme.com']) {
      expect(isPlainAddress(v), JSON.stringify(v)).toBe(false);
      expect(recipientProblem(AN_AGENT, v), JSON.stringify(v)).toBe(SEND_JUST_THE_ADDRESS);
    }
    expect(isEmailAddress('äp@acme.com')).toBe(true); // a person may still type it
    expect(isPlainAddress("ap+x_y.z!#$%&'*/=?^`{|}~-1@acme.com")).toBe(true);
  });

  it('says what to do: a person is shown the address, an agent is told to send just the address', () => {
    expect(recipientProblem(PERSON, 'ap@acme.com')).toBeNull();
    expect(recipientProblem(PERSON, 'ap@acme.com, ar@acme.com')).toBe(
      '"ap@acme.com, ar@acme.com" is not one email address. Type just the address, like name@example.com, with no name, quotes or brackets.',
    );
    expect(recipientProblem(PERSON, 'ap@acme.com, ar@acme.com', 'list')).toBeNull();
    expect(recipientProblem(PERSON, 'ap@acme.com, Bob <b@x.com>', 'list')).toBe(
      '"Bob <b@x.com>" is not an email address. Type each address alone, like name@example.com, separated by commas.',
    );
    expect(recipientProblem(AN_AGENT, 'Name<x@evil.example>')).toBe(SEND_JUST_THE_ADDRESS);
    expect(recipientProblem(AN_AGENT, 'ap@acme.com, ar@acme.com')).toBe(SEND_JUST_THE_ADDRESS);
    expect(recipientProblem(AN_AGENT, 'ap@acme.com, ar@acme.com', 'list')).toBeNull();
    expect(recipientProblem(AN_AGENT, 'ap@acme.com, ar@acme_x.com', 'list')).toBe(SEND_JUST_THE_ADDRESSES);
    expect(recipientProblem(AN_AGENT, '  ', 'list')).toBe(SEND_JUST_THE_ADDRESSES);
  });

  it('a copy list typed now gets the new rule; one saved before keeps working', () => {
    expect(() => parseAddressList('a@acme.com, b(c)@acme.com', 'Always send a copy to')).toThrow(
      'Always send a copy to: "b(c)@acme.com" is not an email address.',
    );
    expect(parseAddressList('a@acme.com, b(c)@acme.com', 'Bcc', { saved: true })).toEqual(['a@acme.com', 'b(c)@acme.com']);
    expect(() => parseAddressList('a@acme_x.com', 'Bcc', { ctx: AN_AGENT })).toThrow(`Bcc: ${SEND_JUST_THE_ADDRESSES}`);
    expect(parseAddressList('a@acme_x.com', 'Bcc', { ctx: PERSON })).toEqual(['a@acme_x.com']);
  });
});

describe('the sends refuse such a recipient before anything is sent', () => {
  let t: TestCompany;
  let customerId: string;
  let invoiceId: string;
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  beforeAll(async () => {
    t = await makeTestCompany('svc-addresses');
    const cust = await createCustomer(t.ctx, { displayName: 'Slow Payer', email: 'ap@slow.test' });
    customerId = cust.id;
    const inv = await createInvoice(t.ctx, {
      customerId,
      date: day('2026-01-05'),
      dueDate: day('2026-02-04'),
      lines: [{ description: 'Work', quantity: '1', rate: '120.00' }],
    });
    invoiceId = inv.id;
  }, 180_000);
  afterAll(async () => {
    await t.cleanup();
  });

  const agentCtx = () => ({ ...t.ctx, agent: AGENT });
  const setOnFile = (email: string) => t.db.update(customers).set({ email }).where(eq(customers.id, customerId));

  it('the payment reminder', async () => {
    sent.length = 0;
    await setOnFile('ap@slow.test');
    for (const to of ['ap(x)@slow.test', 'Slow <ap@slow.test>', 'ap@slow.test, x@evil.example', 'ap@slow.test;x@evil.example', 'slow.test:x@evil.example']) {
      await expect(sendPaymentReminder(t.ctx, invoiceId, to), to).rejects.toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('is not one email address') });
      await expect(sendPaymentReminder(agentCtx(), invoiceId, to), to).rejects.toMatchObject({ code: 'VALIDATION', message: SEND_JUST_THE_ADDRESS });
    }
    await expect(sendPaymentReminder(agentCtx(), invoiceId, 'ap@slow_test.com')).rejects.toMatchObject({ message: SEND_JUST_THE_ADDRESS });
    expect(sent).toEqual([]);
    // The address on the customer's record is checked too, and the message says where it came from.
    await setOnFile('Slow <ap@slow.test>');
    await expect(sendPaymentReminder(agentCtx(), invoiceId)).rejects.toMatchObject({
      message: `The email address on Slow Payer's record cannot be used: ${SEND_JUST_THE_ADDRESS}`,
    });
    await setOnFile('ap@slow.test');
    await expect(sendPaymentReminder(t.ctx, invoiceId, 'ap@slow_test.com')).resolves.toMatchObject({ ok: true, to: 'ap@slow_test.com' });
    await expect(sendPaymentReminder(agentCtx(), invoiceId)).resolves.toMatchObject({ ok: true, to: 'ap@slow.test' });
    expect(sent.map((s) => s.to)).toEqual(['ap@slow_test.com', 'ap@slow.test']);
  }, 120_000);

  it("a sales form's email and a statement's", async () => {
    sent.length = 0;
    await setOnFile('ap@slow.test');
    await expect(emailSalesForm(t.ctx, 'invoice', invoiceId, 'Slow <ap@slow.test>')).rejects.toMatchObject({
      code: 'VALIDATION',
      message: '"Slow <ap@slow.test>" is not one email address. Type just the address, like name@example.com, with no name, quotes or brackets.',
    });
    await expect(emailSalesForm(agentCtx(), 'invoice', invoiceId, 'x@evil_example.com')).rejects.toMatchObject({ message: SEND_JUST_THE_ADDRESS });
    // Only spaces typed: refused, as before, saying what to do (no empty quotes).
    await expect(emailSalesForm(t.ctx, 'invoice', invoiceId, '   ')).rejects.toMatchObject({
      code: 'VALIDATION',
      message: "Type an email address, like name@example.com, or leave the address empty to send to the one on the customer's record.",
    });
    // The statement's address field takes one address now, as a form's does.
    await expect(emailCustomerStatement(t.ctx, customerId, { email: 'ap@slow.test, x@evil.example' })).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringContaining('is not one email address'),
    });
    await expect(emailCustomerStatement(agentCtx(), customerId, { email: 'ap@slow.test(x)' })).rejects.toMatchObject({ message: SEND_JUST_THE_ADDRESS });
    expect(sent).toEqual([]);

    // A list on the customer's record: a person's send to it is as before; an agent's is refused
    // unless every address on it is plain.
    await setOnFile('ap@slow.test; ar@slow.test');
    await expect(emailCustomerStatement(t.ctx, customerId)).resolves.toMatchObject({ ok: true, to: 'ap@slow.test; ar@slow.test' });
    await expect(emailCustomerStatement(agentCtx(), customerId)).resolves.toMatchObject({ ok: true, to: 'ap@slow.test; ar@slow.test' });
    await setOnFile('Slow Payer <ap@slow.test>');
    await expect(emailCustomerStatement(agentCtx(), customerId)).rejects.toMatchObject({
      message: `The email address on Slow Payer's record cannot be used: ${SEND_JUST_THE_ADDRESSES}`,
    });
    await expect(emailSalesForm(t.ctx, 'invoice', invoiceId, 'ap@slow.test')).resolves.toMatchObject({ ok: true, to: 'ap@slow.test' });
    expect(sent.map((s) => s.to)).toEqual(['ap@slow.test; ar@slow.test', 'ap@slow.test; ar@slow.test', 'ap@slow.test']);
    await setOnFile('ap@slow.test');
  }, 120_000);
});
