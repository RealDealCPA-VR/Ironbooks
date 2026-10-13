/**
 * QuickBooks IIF migration fidelity (L1-L5): full account hierarchy with colliding leaf names,
 * every QB item type incl. group components and assembly BOMs, CUST / VEND / EMP fields,
 * "Customer:Job" → sub-customer + job, and the other-list registry (imported vs deferred).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import {
  accounts,
  assemblyComponents,
  customerTypes,
  customers,
  employees,
  items,
  jobs,
  journalEntries,
  journalEntryLines,
  salesReps,
  taxRates,
  users,
  vendorTypes,
  vendors,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { trialBalance } from './reports';
import { importIIF, parseIIF, parseIifAddress } from './qbImport';

const TEST_DIR = path.resolve(process.cwd(), '.bookkeeper-data', 'test-qbimport-fidelity-w2');
let db: DB;
let ctx: ServiceContext;

const row = (...cells: string[]) => cells.join('\t');

const IIF = [
  row('!ACCNT', 'NAME', 'ACCNTTYPE', 'DESC', 'ACCNUM', 'HIDDEN'),
  row('ACCNT', 'Operating Bank', 'BANK', '', '1020', 'N'),
  row('ACCNT', 'Automobile', 'EXP', 'Car costs', '6150', 'N'),
  row('ACCNT', 'Automobile:Fuel', 'EXP', '', '6110', 'N'),
  row('ACCNT', 'Truck:Fuel', 'EXP', '', '6210', 'N'), // parent "Truck" is not declared
  row('ACCNT', 'Product Sales', 'INC', '', '4010', 'N'),
  row('ACCNT', 'Old Account', 'EXP', '', '6990', 'Y'),
  row('ACCNT', 'Estimates', 'NONPOSTING', '', '', 'N'),
  row('!CTYPE', 'NAME'),
  row('CTYPE', 'Retail'),
  row('CTYPE', 'Retail:Online'),
  row('!VTYPE', 'NAME'),
  row('VTYPE', 'Supplier'),
  row('!SALESREP', 'INITIALS', 'ASSOCIATEDNAME', 'NAMETYPE'),
  row('SALESREP', 'JS', 'John Smith', 'OTHERNAME'),
  row('!TERMS', 'NAME', 'DUEDAYS'),
  row('TERMS', 'Net 15', '15'),
  row('!SHIPMETH', 'NAME'),
  row('SHIPMETH', 'UPS'),
  row('!CUSTNAMEDICT', 'INDEX', 'LABEL', 'CUSTOMER', 'VENDOR', 'EMPLOYEE'),
  row('CUSTNAMEDICT', '0', 'Region', 'Y', 'N', 'N'),
  row('!CUST', 'NAME', 'COMPANYNAME', 'BADDR1', 'BADDR2', 'BADDR3', 'SADDR1', 'SADDR2', 'SADDR3', 'PHONE1', 'PHONE2', 'FAXNUM', 'EMAIL', 'CONT1', 'CTYPE', 'TERMS', 'TAXABLE', 'LIMIT', 'REP', 'HIDDEN', 'NOTE', 'CUSTFLD1', 'JOBSTART'),
  row('CUST', 'Acme', 'Acme Corp', 'Acme Corp', '1 Main St', 'Springfield, IL 62701', 'Acme Warehouse', '9 Dock Rd', 'Joliet, IL 60431', '555-0100', '555-0101', '555-0199', 'ap@acme.test', 'Pat Buyer', 'Retail:Online', 'Net 15', 'N', '5,000.00', 'JS', 'N', 'Good customer', 'Midwest', ''),
  row('CUST', 'Acme:Kitchen Remodel', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Y', '', '', 'N', '', '', '2/1/2026'),
  row('CUST', 'Gone Inc', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Y', '', '', 'Y', '', '', ''),
  row('!VEND', 'NAME', 'COMPANYNAME', 'ADDR1', 'ADDR2', 'ADDR3', 'VTYPE', 'PHONE1', 'EMAIL', 'TERMS', 'TAXID', '1099', 'HIDDEN', 'CONT1'),
  row('VEND', 'Supply Co', 'Supply Company LLC', 'Supply Company LLC', '22 Mill Rd', 'Dayton, OH 45402', 'Supplier', '555-3000', 'bills@supply.test', 'Net 30', '12-3456789', 'Y', 'N', 'Sam Seller'),
  row('!INVITEM', 'NAME', 'INVITEMTYPE', 'DESC', 'PRICE', 'COST', 'ACCNT', 'COGSACCNT', 'ASSETACCNT', 'TAXABLE'),
  row('INVITEM', 'Delivery', 'OTHC', 'Delivery charge', '25.00', '', 'Product Sales', '', '', 'N'),
  row('INVITEM', 'Promo', 'DISC', 'Promotion', '10%', '', 'Product Sales', '', '', 'N'),
  row('INVITEM', 'Deposit', 'PMT', 'Customer deposit', '', '', '', '', '', 'N'),
  row('INVITEM', 'Subtotal', 'SUBT', 'Subtotal', '', '', '', '', '', 'N'),
  row('INVITEM', 'State Tax', 'STAX', 'State sales tax', '8.25%', '', '', '', '', 'N'),
  row('INVITEM', 'Widget', 'PART', 'Widget', '10.00', '4.00', 'Product Sales', '', '', 'Y'),
  row('INVITEM', 'Gadget', 'PART', 'Gadget', '20.00', '8.00', 'Product Sales', '', '', 'Y'),
  row('INVITEM', 'Kit', 'GRP', 'Starter kit', '', '', '', '', '', 'Y'),
  row('INVITEM', 'Assembled', 'ASSEMBLY', 'Assembled unit', '50.00', '', 'Product Sales', '', '', 'Y'),
  row('!INVITEMCOMP', 'PARENT', 'COMPONENT', 'QNTY'),
  row('INVITEMCOMP', 'Kit', 'Widget', '2'),
  row('INVITEMCOMP', 'Kit', 'Gadget', '1'),
  row('INVITEMCOMP', 'Assembled', 'Widget', '3'),
  row('!EMP', 'NAME', 'FIRSTNAME', 'LASTNAME', 'ADDR1', 'CITY', 'STATE', 'ZIP', 'SSNO', 'PHONE1', 'EMAIL', 'HIREDATE', 'PAYTYPE', 'PAYRATE', 'FILINGSTATUS', 'HIDDEN'),
  row('EMP', 'Doe, Jane', 'Jane', 'Doe', '5 Elm St', 'Austin', 'TX', '78701', '123456789', '555-2000', 'jane@doe.test', '3/1/2020', 'Salary', '65,000.00', 'Head of Household', 'N'),
  row('!TRNS', 'TRNSID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO'),
  row('!SPL', 'SPLID', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO'),
  row('!ENDTRNS'),
  row('TRNS', '', 'GENERAL JOURNAL', '1/31/2026', 'Automobile:Fuel', '', '100.00', 'GJ1', 'Fuel for both vehicles'),
  row('SPL', '', 'GENERAL JOURNAL', '1/31/2026', 'Truck:Fuel', '', '50.00', 'GJ1', ''),
  row('SPL', '', 'GENERAL JOURNAL', '1/31/2026', 'Operating Bank', '', '-150.00', 'GJ1', ''),
  row('ENDTRNS'),
  // Leaf-only reference to a colliding name: must NOT guess.
  row('TRNS', '', 'GENERAL JOURNAL', '2/28/2026', 'Fuel', '', '10.00', 'GJ2', 'Ambiguous'),
  row('SPL', '', 'GENERAL JOURNAL', '2/28/2026', 'Operating Bank', '', '-10.00', 'GJ2', ''),
  row('ENDTRNS'),
].join('\r\n');

describe('IIF migration fidelity', () => {
  let counts: Awaited<ReturnType<typeof importIIF>>;

  beforeAll(async () => {
    db = await getDb(TEST_DIR);
    const [user] = await db.insert(users).values({ email: 'iiffid@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'IIF Fidelity Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    counts = await importIIF(ctx, IIF);
  });

  afterAll(async () => {
    await closeDb(TEST_DIR);
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  const acct = async (code: string) => {
    const [r] = await ctx.db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, code)));
    return r;
  };

  it('parses QB address lines into city / state / zip', () => {
    expect(parseIifAddress(['Acme Corp', '1 Main St', 'Springfield, IL 62701'])).toEqual({
      line1: 'Acme Corp',
      line2: '1 Main St',
      city: 'Springfield',
      state: 'IL',
      zip: '62701',
    });
    const parsed = parseIIF(IIF);
    expect(parsed.customers[0].fields?.Region).toBe('Midwest');
    expect(Object.keys(parsed.lists).sort()).toEqual(['CTYPE', 'SALESREP', 'SHIPMETH', 'TERMS', 'VTYPE']);
  });

  it('L1: builds the hierarchy (parents first, implicit parents created) and keeps colliding leaves apart', async () => {
    const auto = await acct('6150');
    const autoFuel = await acct('6110');
    const truckFuel = await acct('6210');
    expect(autoFuel.name).toBe('Fuel');
    expect(truckFuel.name).toBe('Fuel');
    expect(autoFuel.parentId).toBe(auto.id);
    const [truck] = await ctx.db.select().from(accounts).where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.name, 'Truck')));
    expect(truck).toBeTruthy();
    expect(truck.type).toBe('expense');
    expect(truckFuel.parentId).toBe(truck.id);
    expect((await acct('6990')).isActive).toBe(false); // HIDDEN
    // wave2 foundation: QB non-posting accounts import as the 'non_posting' subtype (they never
    // carry amounts or reach reports) instead of being skipped.
    const [estimatesAcct] = await ctx.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.name, 'Estimates')));
    expect(estimatesAcct?.subtype).toBe('non_posting');
    expect((await acct('1020')).subtype).toBe('checking');
    expect((await acct('4010')).type).toBe('revenue'); // QB's own "INC" code
  });

  it('L1: transactions post to the account named by its FULL path; leaf-only collisions are refused', async () => {
    const [je] = await ctx.db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.reference, 'GJ1')));
    expect(je).toBeTruthy();
    const lines = await ctx.db.select().from(journalEntryLines).where(eq(journalEntryLines.journalEntryId, je.id));
    const by = new Map(lines.map((l) => [l.accountId, l]));
    expect(by.get((await acct('6110')).id)?.debit).toBe('100.00');
    expect(by.get((await acct('6210')).id)?.debit).toBe('50.00');
    const gj2 = await ctx.db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.reference, 'GJ2')));
    expect(gj2).toHaveLength(0);
    expect(counts.issues.some((i) => i.entity === 'transaction' && /matches more than one account/.test(i.message))).toBe(true);
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });

  it('L2: maps every QB item type, with group components and assembly BOMs', async () => {
    const rows = await ctx.db.select().from(items).where(eq(items.companyId, ctx.companyId));
    const type = (n: string) => rows.find((r) => r.name === n)?.type;
    expect(type('Delivery')).toBe('other_charge');
    expect(type('Promo')).toBe('discount');
    expect(type('Deposit')).toBe('payment');
    expect(type('Subtotal')).toBe('subtotal');
    expect(type('State Tax')).toBe('sales_tax');
    expect(type('Kit')).toBe('bundle');
    expect(type('Assembled')).toBe('inventory');
    expect(rows.find((r) => r.name === 'Promo')?.description).toContain('10%');
    const id = (n: string) => rows.find((r) => r.name === n)!.id;
    const bom = await ctx.db.select().from(assemblyComponents).where(eq(assemblyComponents.companyId, ctx.companyId));
    const kit = bom.filter((b) => b.assemblyItemId === id('Kit'));
    expect(kit.map((b) => [b.componentItemId, Number(b.quantity)]).sort()).toEqual(
      [[id('Widget'), 2], [id('Gadget'), 1]].sort(),
    );
    expect(bom.find((b) => b.assemblyItemId === id('Assembled'))?.componentItemId).toBe(id('Widget'));
    const [rate] = await ctx.db.select().from(taxRates).where(and(eq(taxRates.companyId, ctx.companyId), eq(taxRates.name, 'State Tax')));
    expect(rate.rate).toBe('0.082500');
  });

  it('L3: customer fields, type, job hierarchy, inactive flag and custom fields', async () => {
    const rows = await ctx.db.select().from(customers).where(eq(customers.companyId, ctx.companyId));
    const acme = rows.find((c) => c.displayName === 'Acme')!;
    expect(acme.companyName).toBe('Acme Corp');
    expect(acme.billingAddress).toMatchObject({ city: 'Springfield', state: 'IL', zip: '62701' });
    expect(acme.shippingAddress).toMatchObject({ line1: 'Acme Warehouse', line2: '9 Dock Rd', city: 'Joliet', state: 'IL', zip: '60431' });
    expect(acme.terms).toBe('net_15');
    expect(acme.taxable).toBe(false);
    expect(acme.creditLimit).toBe('5000.00');
    expect(acme.email).toBe('ap@acme.test');
    expect(acme.notes).toBe('Good customer');
    expect(acme.customFields).toMatchObject({ Region: 'Midwest', Contact: 'Pat Buyer', 'Alt. Phone': '555-0101', Fax: '555-0199', Rep: 'JS' });
    const [online] = await ctx.db.select().from(customerTypes).where(and(eq(customerTypes.companyId, ctx.companyId), eq(customerTypes.name, 'Online')));
    expect(acme.customerTypeId).toBe(online.id);
    expect(online.parentId).not.toBeNull();

    const job = rows.find((c) => c.displayName === 'Acme:Kitchen Remodel')!;
    expect(job.parentId).toBe(acme.id);
    const [jobRow] = await ctx.db.select().from(jobs).where(and(eq(jobs.companyId, ctx.companyId), eq(jobs.name, 'Kitchen Remodel')));
    expect(jobRow.customerId).toBe(acme.id);
    expect(jobRow.startDate?.toISOString().slice(0, 10)).toBe('2026-02-01');
    expect(counts.jobs).toBe(1);
    expect(rows.find((c) => c.displayName === 'Gone Inc')!.isActive).toBe(false);
  });

  it('L3: vendor 1099 flag, tax id, type, terms and contact', async () => {
    const [v] = await ctx.db.select().from(vendors).where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.displayName, 'Supply Co')));
    expect(v.is1099).toBe(true);
    expect(v.taxId).toBe('12-3456789');
    expect(v.terms).toBe('net_30');
    expect(v.address).toMatchObject({ street: 'Supply Company LLC', city: 'Dayton', state: 'OH', zip: '45402' });
    expect(v.customFields).toMatchObject({ Contact: 'Sam Seller' });
    const [t] = await ctx.db.select().from(vendorTypes).where(and(eq(vendorTypes.companyId, ctx.companyId), eq(vendorTypes.name, 'Supplier')));
    expect(v.vendorTypeId).toBe(t.id);
  });

  it('L5: employee address, normalized SSN, hire date, pay and W-4', async () => {
    const [e] = await ctx.db.select().from(employees).where(and(eq(employees.companyId, ctx.companyId), eq(employees.lastName, 'Doe')));
    expect(e.firstName).toBe('Jane');
    expect(e.ssn).toBe('123-45-6789');
    expect(e.address).toMatchObject({ line1: '5 Elm St', city: 'Austin', state: 'TX', zip: '78701' });
    expect(e.hireDate?.toISOString().slice(0, 10)).toBe('2020-03-01');
    expect(e.payType).toBe('salary');
    expect(e.payRate).toBe('65000.00');
    expect(e.phone).toBe('555-2000');
    expect(e.w4).toMatchObject({ filingStatus: 'head_of_household' });
  });

  it('L4: registry lists import into their tables (TERMS / SHIPMETH de-duplicated against the defaults)', async () => {
    expect(counts.lists.CTYPE).toBe(2);
    expect(counts.lists.VTYPE).toBe(1);
    expect(counts.lists.SALESREP).toBe(1);
    const reps = await ctx.db.select().from(salesReps).where(eq(salesReps.companyId, ctx.companyId));
    expect(reps.map((r) => r.name)).toContain('John Smith');
    // TERMS and SHIPMETH now import into their lists; 'Net 15' and 'UPS' are QB defaults that
    // already exist, so nothing is added and nothing is deferred.
    expect(counts.deferred.map((d) => d.list)).toEqual([]);
    expect(counts.lists.TERMS).toBe(0);
    expect(counts.lists.SHIPMETH).toBe(0);
  });

  it('re-importing the same file creates nothing new', async () => {
    const again = await importIIF(ctx, IIF);
    expect(again.accounts).toBe(0);
    expect(again.customers).toBe(0);
    expect(again.vendors).toBe(0);
    expect(again.items).toBe(0);
    expect(again.employees).toBe(0);
    expect(again.jobs).toBe(0);
    expect(again.transactions).toBe(0);
    expect(again.lists.CTYPE ?? 0).toBe(0);
  });
});
