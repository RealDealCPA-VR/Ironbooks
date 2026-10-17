/**
 * Review round 4 — Accountant's Copy regressions (each failed before its fix):
 *  A  a check paid to an Other Names payee keeps that payee through the copy (edit and new check);
 *  B  the review predicts what the import refuses: a fiscal period the client closed (closing one on
 *     or before the dividing date is now refused while the copy is out), an account type change on
 *     an account the client has since used, a rename to a name the client has since taken, an
 *     invoice whose recorded payment the client has since deposited, a purchase order the client
 *     has since billed; the client can't make a list entry inactive while the copy is out;
 *     Working Trial Balance adjustments work in the copy and travel (workpaper notes are warned
 *     about); the transfer file of an outstanding copy can be saved again.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, expenses, fiscalPeriods, items, journalEntries, purchaseOrderLines, users } from '@/lib/db/schema';
import type { ServiceContext } from './_base';
import { createCompany } from './company';
import { createAccount, updateAccount } from './accounts';
import { createCustomer, updateCustomer } from './customers';
import { createExpense, updateExpense } from './expenses';
import { createInvoice, updateInvoice } from './invoices';
import { createVendor } from './vendors';
import { convertToBill, createPurchaseOrder, updatePurchaseOrder } from './purchaseOrders';
import { createDeposit } from './deposits';
import { createManualEntry } from './journal';
import { closePeriod } from './fiscalPeriods';
import { createEntry, updateEntry } from './lists/simpleLists';
import { updateItem } from './items';
import { createBin, createSite, updateBin, updateSite } from './inventorySites';
import { createBillingRateLevel, updateBillingRateLevel } from './lists/billingRates';
import { createPriceLevel, updatePriceLevel } from './pricing';
import { postAdjustingEntry, saveWtbNote } from './accountant/workingTrialBalance';
import { accountantCopyStatus, createAccountantCopy, importChangesFile, reviewChangesFile, saveTransferFileAgain } from './accountantCopy/client';
import { accountantChanges, exportChangesFile, openAccountantCopyFile } from './accountantCopy/accountant';
import { parseChangesFile, serializeChangesFile, type ChangesFileBody } from './accountantCopy/format';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-review4-acctcopy');
const CLIENT_DIR = path.join(ROOT, 'client');
const ACCT_A = path.join(ROOT, 'acct-a');
const ACCT_B = path.join(ROOT, 'acct-b');
const ACCT_D = path.join(ROOT, 'acct-d');
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);

let db: DB;
let ctx: ServiceContext;
const acct: Record<string, string> = {};
const R: Record<string, string> = {};

/** The changes file cut down to what `keep` picks. */
function only(buf: Buffer, keep: (b: ChangesFileBody) => ChangesFileBody): Buffer {
  const { sha256: _s, ...body } = parseChangesFile(buf);
  return serializeChangesFile(keep(JSON.parse(JSON.stringify(body)) as ChangesFileBody));
}
const empty = (b: ChangesFileBody): ChangesFileBody => ({
  ...b, accounts: [], classes: [], transactions: [], names: [], documents: [], applications: [], reconciliations: [], note: 'x',
});
type Txn = ChangesFileBody['transactions'][number];
const jeNamed = (desc: string) => (t: Txn) => t.type === 'journal_entry' && t.op === 'add' && t.after.description === desc;

describe("review4: Accountant's Copy", () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(CLIENT_DIR);
    const [user] = await db.insert(users).values({ email: 'r4ac@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Review4 AC Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
    await createManualEntry(ctx, {
      date: d('2026-01-02'),
      description: 'Owner investment',
      lines: [{ accountId: acct['1000'], debit: '10000.00' }, { accountId: acct['3000'], credit: '10000.00' }],
    });
    R.water = String((await createEntry(ctx, 'other-names', { name: 'City Water Dept' })).id);
    R.check = (
      await createExpense(ctx, {
        otherNameId: R.water, date: d('2026-03-10'), method: 'check', reference: '501', paymentAccountId: acct['1000'],
        lines: [{ accountId: acct['6300'], amount: '80' }],
      })
    ).id;
    // Mistyped by the client as an expense; not used before the dividing date.
    R.prepaid = (await createAccount(ctx, { code: '1450', name: 'Prepaid Insurance', qbType: 'expense' })).id;
    R.beta = (await createCustomer(ctx, { displayName: 'Beta LLC' })).id;
    R.landlord = String((await createEntry(ctx, 'other-names', { name: 'Landlord LLC' })).id);
    // An invoice whose payment was recorded on the invoice itself (payment item, in Undeposited Funds).
    const [pi] = await db
      .insert(items)
      .values({ companyId: company.id, name: 'Paid at counter', type: 'payment' as never, salesPrice: '0', incomeAccountId: acct['4100'] })
      .returning();
    R.payItem = pi.id;
    R.invPay = (
      await createInvoice(ctx, {
        customerId: R.beta, date: d('2026-03-10'), refNumber: 'IP-1',
        lines: [
          { description: 'Work', quantity: 1, rate: '100', accountId: acct['4100'], taxable: false },
          { itemId: pi.id, description: 'Paid', quantity: 1, rate: '20', taxable: false },
        ],
      })
    ).id;
    // A March purchase order (account line).
    R.vendor = (await createVendor(ctx, { displayName: 'Supplier Co' })).id;
    R.po = (
      await createPurchaseOrder(ctx, {
        vendorId: R.vendor, date: d('2026-03-05'), refNumber: 'PO-1', lines: [{ accountId: acct['6300'], description: 'Toner', quantity: 1, rate: 100 }],
      })
    ).id;
    const [widget] = await db.insert(items).values({ companyId: company.id, name: 'Widget', type: 'service' as never, salesPrice: '10' }).returning();
    R.widget = widget.id;
    // More list entries (made inactive while the copy is out, below).
    await createSite(ctx, { name: 'Main' });
    R.annex = (await createSite(ctx, { name: 'Annex' })).id;
    R.bin = (await createBin(ctx, { siteId: R.annex, name: 'A1' })).id;
    R.rateLevel = (await createBillingRateLevel(ctx, { name: 'Standard', type: 'fixed_rate', fixedRate: '100' })).id;
    R.priceLevel = (await createPriceLevel(ctx, { name: 'Wholesale', type: 'fixed_percent', percent: -10 })).id;
  }, 240_000);

  afterAll(async () => {
    for (const dir of [CLIENT_DIR, ACCT_A, ACCT_B, ACCT_D]) await closeDb(dir).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('A: a check written to an Other Names payee keeps that payee through the copy (edit and new check)', async () => {
    const transfer = (await createAccountantCopy(ctx, { dividingDate: '2026-03-31', dataDir: CLIENT_DIR })).buffer;
    await openAccountantCopyFile(transfer, ACCT_A);
    const actx: ServiceContext = { db: await getDb(ACCT_A), companyId: ctx.companyId, userId: ctx.userId };
    // The accountant reclassifies the client's check (the form keeps its Other Names payee) …
    await updateExpense(actx, R.check, {
      otherNameId: R.water, payeeName: 'City Water Dept', date: d('2026-03-10'), method: 'check', reference: '501',
      paymentAccountId: acct['1000'], lines: [{ accountId: acct['6600'], amount: '80' }],
    });
    // … and writes a new one to the same payee.
    await createExpense(actx, {
      otherNameId: R.water, date: d('2026-03-20'), method: 'check', reference: '502', paymentAccountId: acct['1000'],
      lines: [{ accountId: acct['6600'], amount: '45' }],
    });

    const changes = (await exportChangesFile(actx, {})).buffer;
    const review = await reviewChangesFile(ctx, changes);
    expect(review.canImport).toBe(true);
    await importChangesFile(ctx, changes);

    const [edited] = await db.select().from(expenses).where(eq(expenses.id, R.check));
    const [added] = await db.select().from(expenses).where(and(eq(expenses.companyId, ctx.companyId), eq(expenses.reference, '502')));
    expect({ edited: edited.otherNameId, added: added.otherNameId, payee: added.payeeName, account: edited.paymentAccountId }).toEqual({
      edited: R.water,
      added: R.water,
      payee: 'City Water Dept',
      account: acct['1000'],
    });
  }, 240_000);

  describe('B: what the review predicts, the import does', () => {
    let actx: ServiceContext;
    let changes: Buffer;

    beforeAll(async () => {
      const transfer = (await createAccountantCopy(ctx, { dividingDate: '2026-03-31', dataDir: CLIENT_DIR })).buffer;
      await openAccountantCopyFile(transfer, ACCT_B);
      actx = { db: await getDb(ACCT_B), companyId: ctx.companyId, userId: ctx.userId };

      // ---- The client keeps working after the copy was made ----
      R.closeFeb = await closePeriod(ctx, { periodStart: new Date('2026-02-01T00:00:00.000Z'), periodEnd: new Date('2026-02-28T00:00:00.000Z') }).then(
        () => 'closed',
        (e: Error) => e.message,
      );
      R.closeMay = await closePeriod(ctx, { periodStart: new Date('2026-05-01T00:00:00.000Z'), periodEnd: new Date('2026-05-31T00:00:00.000Z') }).then(
        () => 'closed',
        (e: Error) => e.message,
      );
      // A period closed before that rule existed (or before the copy was made in another file).
      await db.insert(fiscalPeriods).values({
        companyId: ctx.companyId, periodStart: new Date('2026-02-01T00:00:00.000Z'), periodEnd: new Date('2026-02-28T00:00:00.000Z'), isClosed: true, closedAt: new Date(), closedBy: ctx.userId,
      });
      await createExpense(ctx, {
        payeeName: 'Insurer', date: d('2026-04-05'), method: 'check', reference: '601', paymentAccountId: acct['1000'],
        lines: [{ accountId: R.prepaid, amount: '1200' }],
      });
      await createCustomer(ctx, { displayName: 'Gamma Inc' });
      // The list editor's Make inactive toggle (PATCH isActive) while the copy is out.
      R.inactivated = await updateEntry(ctx, 'other-names', R.landlord, { isActive: false }).then(() => 'made inactive', (e: Error) => e.message);
      R.itemInactivated = await updateItem(ctx, R.widget, { isActive: false }).then(() => 'made inactive', (e: Error) => e.message);
      const tryInactive = (p: Promise<unknown>) => p.then(() => 'made inactive', (e: Error) => e.message);
      R.siteInactivated = await tryInactive(updateSite(ctx, R.annex, { isActive: false }));
      R.binInactivated = await tryInactive(updateBin(ctx, R.bin, { isActive: false }));
      R.rateInactivated = await tryInactive(updateBillingRateLevel(ctx, R.rateLevel, { name: 'Standard', type: 'fixed_rate', fixedRate: '100', isActive: false }));
      R.priceInactivated = await tryInactive(updatePriceLevel(ctx, R.priceLevel, { name: 'Wholesale', type: 'fixed_percent', percent: -10, isActive: false }));
      // Edits that keep the entry active still go through.
      R.siteRenamed = await updateSite(ctx, R.annex, { name: 'Annex 2' }).then((s) => s.name, (e: Error) => e.message);
      await createDeposit(ctx, { depositAccountId: acct['1000'], date: d('2026-04-03'), invoicePaymentIds: [R.invPay] });
      await convertToBill(ctx, R.po, { date: d('2026-04-06'), billNumber: 'PO-1 bill' });

      // ---- The accountant's work (all on or before the dividing date) ----
      // The counter payment recorded on the March invoice was really $25.
      await updateInvoice(actx, R.invPay, {
        customerId: R.beta, date: d('2026-03-10'), refNumber: 'IP-1',
        lines: [
          { description: 'Work', quantity: 1, rate: '100', accountId: acct['4100'], taxable: false },
          { itemId: R.payItem, description: 'Paid', quantity: 1, rate: '25', taxable: false },
        ],
      });
      const [poLine] = await actx.db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, R.po));
      await updatePurchaseOrder(actx, R.po, {
        vendorId: R.vendor, date: d('2026-03-05'), refNumber: 'PO-1', memo: 'Approved by the accountant',
        lines: [{ id: poLine.id, accountId: acct['6300'], description: 'Toner', quantity: 1, rate: 100 }],
      });
      await createManualEntry(actx, {
        date: d('2026-02-15'),
        description: 'February accrual',
        lines: [{ accountId: acct['6300'], debit: '25.00' }, { accountId: acct['3000'], credit: '25.00' }],
      });
      await createManualEntry(actx, {
        date: d('2026-03-31'),
        description: 'March rent accrual',
        lines: [{ accountId: acct['6400'], debit: '900.00' }, { accountId: acct['3000'], credit: '900.00', entityType: 'other', entityId: R.landlord }],
      });
      await updateAccount(actx, R.prepaid, { qbType: 'other_current_asset' });
      await updateCustomer(actx, R.beta, { displayName: 'Gamma Inc' });
      // Working Trial Balance: an adjusting entry and a workpaper note.
      await postAdjustingEntry(actx, {
        date: d('2026-03-31'),
        description: 'Year-end accrual (WTB)',
        lines: [{ accountId: acct['6300'], debit: '10.00' }, { accountId: acct['3000'], credit: '10.00' }],
      });
      await saveWtbNote(actx, { accountId: acct['6300'], periodEnd: '2026-03-31', workpaperRef: 'WP-7', note: 'Tie to vendor statement' });
      changes = (await exportChangesFile(actx, {})).buffer;
    }, 240_000);

    /** The review names the problem and the import refuses the same file. */
    async function predictedRefusal(buf: Buffer, key: (k: string) => boolean, problem: RegExp) {
      const review = await reviewChangesFile(ctx, buf);
      expect(review.items.find((i) => key(i.key))?.problem ?? null).toMatch(problem);
      expect(review.canImport).toBe(false);
      const err = await importChangesFile(ctx, buf).then(() => null, (e: Error) => e);
      expect(err?.message ?? null).toMatch(/Nothing was imported/);
      expect((await accountantCopyStatus(ctx)).current?.status).toBe('outstanding');
    }

    it('B1: closing a fiscal period on or before the dividing date is refused while the copy is out (later ones are fine)', () => {
      expect(R.closeFeb).toMatch(/Accountant's Copy.*can't be closed/);
      expect(R.closeMay).toBe('closed');
    });

    it('B1: a change dated in a period the client closed anyway is flagged by the review', async () => {
      await predictedRefusal(
        only(changes, (b) => ({ ...empty(b), transactions: b.transactions.filter(jeNamed('February accrual')) })),
        (k) => k.startsWith('journal_entry:add:'),
        /accounting period Feb 1, 2026 – Feb 28, 2026 is closed \(Fiscal Periods\).*reopen that period/,
      );
    });

    it('B2: an account type change on an account the client has since used is flagged', async () => {
      await predictedRefusal(
        only(changes, (b) => ({ ...empty(b), accounts: b.accounts })),
        (k) => k === `account:${R.prepaid}`,
        /Your file has transactions in this account \(the first dated 2026-04-05\), so its account type can't be changed to Other Current Asset/,
      );
    });

    it('B3: a rename to a name the client has since given another customer is flagged', async () => {
      await predictedRefusal(
        only(changes, (b) => ({ ...empty(b), names: b.names })),
        (k) => k === `customer:edit:${R.beta}`,
        /Your file already has another customer named "Gamma Inc"/,
      );
    });

    it('B5: an invoice whose recorded payment the client has since deposited is flagged', async () => {
      await predictedRefusal(
        only(changes, (b) => ({ ...empty(b), documents: b.documents.filter((x) => x.type === 'invoice') })),
        (k) => k === `invoice:edit:${R.invPay}`,
        /your deposit of \$20\.00 on 2026-04-03 .*the payment recorded on it can't change its amount/,
      );
    });

    it('B6: a purchase order the client has since billed is flagged', async () => {
      await predictedRefusal(
        only(changes, (b) => ({ ...empty(b), documents: b.documents.filter((x) => x.type === 'purchase_order') })),
        (k) => k === `purchase_order:edit:${R.po}`,
        /Since the dividing date your file has received or billed items on this purchase order .*it is now closed/,
      );
    });

    it('B7: the client cannot make a list entry or an item inactive while the copy is out', async () => {
      expect({ otherName: R.inactivated, item: R.itemInactivated }).toEqual({
        otherName: expect.stringMatching(/Accountant's Copy/),
        item: expect.stringMatching(/Accountant's Copy/),
      });
      const review = await reviewChangesFile(ctx, only(changes, (b) => ({ ...empty(b), transactions: b.transactions.filter(jeNamed('March rent accrual')) })));
      expect(review.canImport).toBe(true);
    });

    it('B7: nor an inventory site, a bin, a billing rate level or a price level (other edits still go through)', () => {
      const refused = expect.stringMatching(/Accountant's Copy.*can't be deleted or made inactive/);
      expect({ site: R.siteInactivated, bin: R.binInactivated, rate: R.rateInactivated, price: R.priceInactivated, renamed: R.siteRenamed }).toEqual({
        site: refused,
        bin: refused,
        rate: refused,
        price: refused,
        renamed: 'Annex 2',
      });
    });

    it('B4: Working Trial Balance adjustments travel as adjusting General Journal entries; workpaper notes are warned about', async () => {
      const c = await accountantChanges(actx);
      const wtb = c.transactions.find(jeNamed('Year-end accrual (WTB)'));
      expect(wtb && wtb.op === 'add' && wtb.type === 'journal_entry' ? wtb.after.isAdjusting : null).toBe(true);
      expect(c.warnings.some((w) => /Working Trial Balance workpaper/.test(w))).toBe(true);
      expect(parseChangesFile(changes).warnings.some((w) => /Working Trial Balance workpaper/.test(w))).toBe(true);
    });

    it('D: the transfer file of the outstanding copy can be saved again; it opens as the same copy and its changes import', async () => {
      const again = await saveTransferFileAgain(ctx, { dataDir: CLIENT_DIR });
      const opened = await openAccountantCopyFile(again.buffer, ACCT_D);
      const status = await accountantCopyStatus(ctx);
      expect(opened.copyId).toBe(status.current?.id);
      expect(opened.dividingDate).toBe('2026-03-31');
      const dctx: ServiceContext = { db: await getDb(ACCT_D), companyId: ctx.companyId, userId: ctx.userId };
      await createManualEntry(dctx, {
        date: d('2026-03-30'),
        description: 'From the second transfer file',
        lines: [{ accountId: acct['6300'], debit: '5.00' }, { accountId: acct['3000'], credit: '5.00' }],
      });
      const review = await reviewChangesFile(ctx, (await exportChangesFile(dctx, {})).buffer);
      expect(review.canImport).toBe(true);
    }, 240_000);

    it('the clean changes import (WTB adjustment and the entry naming the Other Name)', async () => {
      const buf = only(changes, (b) => ({ ...empty(b), transactions: b.transactions.filter((t) => jeNamed('Year-end accrual (WTB)')(t) || jeNamed('March rent accrual')(t)) }));
      expect((await reviewChangesFile(ctx, buf)).canImport).toBe(true);
      await importChangesFile(ctx, buf);
      const [je] = await db
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.companyId, ctx.companyId), eq(journalEntries.description, 'Year-end accrual (WTB)')));
      expect({ status: je?.status, adjusting: je?.isAdjusting }).toEqual({ status: 'posted', adjusting: true });
      expect((await accountantCopyStatus(ctx)).mode).toBe('none');
    });
  });
});
