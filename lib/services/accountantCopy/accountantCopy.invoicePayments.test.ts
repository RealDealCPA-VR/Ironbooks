/**
 * Accountant's Copy (PARITY I1): deposits that hold the payment recorded on an invoice (its
 * payment-item lines, deposit line `invoicePayment:<id>`).
 *
 *  - the changes file carries them (DepositPayload.invoicePaymentIds) and the import rebuilds the
 *    deposit whole;
 *  - an invoice payment the accountant deposited that the client has since deposited in its own
 *    later deposit, or that is no longer in Undeposited Funds because the invoice was voided, is
 *    predicted by the review and refused by the import with the same words;
 *  - the accountant voiding an invoice whose payment the client deposited is predicted alike.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, closeDb, type DB } from '@/lib/db';
import { accounts, depositLines, deposits, invoices, items, users } from '@/lib/db/schema';
import type { ServiceContext } from '../_base';
import { createCompany } from '../company';
import { createCustomer } from '../customers';
import { createInvoice, voidInvoice } from '../invoices';
import { createDeposit } from '../deposits';
import { trialBalance } from '../reports';
import { accountantCopyStatus, createAccountantCopy, importChangesFile, reviewChangesFile } from './client';
import { exportChangesFile, openAccountantCopyFile } from './accountant';
import { parseChangesFile, serializeChangesFile, type ChangesFileBody } from './format';

const ROOT = path.resolve(process.cwd(), '.bookkeeper-data', 'test-acctcopy-invpay');
const CLIENT_DIR = path.join(ROOT, 'client');
const ACCT_DIR = path.join(ROOT, 'accountant');
const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const DIVIDING = '2026-03-31';

let db: DB;
let ctx: ServiceContext;
let actx: ServiceContext;
const acct: Record<string, string> = {};
const R: Record<string, string> = {};
let changes: Buffer;

type Body = ChangesFileBody;
function only(keep: (t: Body['transactions'][number]) => boolean, extraDocs?: (x: Body['documents'][number]) => boolean): Buffer {
  const { sha256: _s, ...body } = parseChangesFile(changes);
  const b = JSON.parse(JSON.stringify(body)) as Body;
  b.transactions = b.transactions.filter(keep);
  b.documents = b.documents.filter((x) => extraDocs?.(x) ?? false);
  b.applications = [];
  b.reconciliations = [];
  return serializeChangesFile(b);
}

async function refusesWith(buf: Buffer, problem: string) {
  const before = await trialBalance(ctx);
  const err = (await importChangesFile(ctx, buf).then(
    () => null,
    (e: Error) => e,
  )) as Error | null;
  expect(err).not.toBeNull();
  expect(err!.message).toContain(problem);
  expect(await trialBalance(ctx)).toEqual(before);
  expect((await accountantCopyStatus(ctx)).current?.status).toBe('outstanding');
}

describe("Accountant's Copy — deposits of invoice payment-item lines", () => {
  beforeAll(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    db = await getDb(CLIENT_DIR);
    const [user] = await db.insert(users).values({ email: 'invpay@test.local', name: 'Owner', passwordHash: 'x' }).returning();
    const company = await createCompany(db, { name: 'Invoice Payments Co', ownerId: user.id });
    ctx = { db, companyId: company.id, userId: user.id };
    for (const a of await db.select().from(accounts).where(eq(accounts.companyId, company.id))) acct[a.code] = a.id;
    R.acme = (await createCustomer(ctx, { displayName: 'Acme Corp' })).id;
    const [pi] = await db
      .insert(items)
      .values({ companyId: company.id, name: 'Paid at counter', type: 'payment' as never, salesPrice: '0', incomeAccountId: acct['4100'] })
      .returning();
    const inv = async (ref: string, paid: string) =>
      (
        await createInvoice(ctx, {
          customerId: R.acme,
          date: d('2026-03-10'),
          refNumber: ref,
          lines: [
            { description: 'Work', quantity: 1, rate: '100', accountId: acct['4100'], taxable: false },
            { itemId: pi.id, description: 'Paid', quantity: 1, rate: paid, taxable: false },
          ],
        })
      ).id;
    R.invGone = await inv('IP-1', '30'); // no longer in Undeposited Funds in the client's file
    R.invDep = await inv('IP-2', '20'); // the client deposits it in April
    R.invOk = await inv('IP-3', '10'); // nobody else touches it
    R.invVoid = await inv('IP-4', '15'); // the client deposits it in April; the accountant voids the invoice

    const transfer = (await createAccountantCopy(ctx, { dividingDate: DIVIDING, dataDir: CLIENT_DIR })).buffer;
    await openAccountantCopyFile(transfer, ACCT_DIR);
    actx = { db: await getDb(ACCT_DIR), companyId: ctx.companyId, userId: ctx.userId };

    // ---- The client in April ----
    R.clientDep = (await createDeposit(ctx, { depositAccountId: acct['1000'], date: d('2026-04-03'), invoicePaymentIds: [R.invDep, R.invVoid] })).id;
    // The invoice's payment has left Undeposited Funds in the client's file (simulated: the
    // dividing date keeps the client from voiding a March invoice through the services).
    await db.update(invoices).set({ status: 'void' }).where(eq(invoices.id, R.invGone));

    // ---- The accountant, on or before the dividing date ----
    R.depGone = (await createDeposit(actx, { depositAccountId: acct['1000'], date: d('2026-03-31'), invoicePaymentIds: [R.invGone] })).id;
    R.depDep = (await createDeposit(actx, { depositAccountId: acct['1000'], date: d('2026-03-31'), invoicePaymentIds: [R.invDep] })).id;
    R.depOk = (await createDeposit(actx, { depositAccountId: acct['1000'], date: d('2026-03-31'), invoicePaymentIds: [R.invOk] })).id;
    await voidInvoice(actx, R.invVoid);

    changes = (await exportChangesFile(actx, {})).buffer;
  }, 240_000);

  afterAll(async () => {
    for (const dir of [CLIENT_DIR, ACCT_DIR]) await closeDb(dir).catch(() => undefined);
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('the changes file carries the invoice payments a deposit holds', () => {
    const t = parseChangesFile(changes).transactions.find((x) => x.type === 'deposit' && x.id === R.depOk);
    expect(t && t.type === 'deposit' && t.op !== 'void' ? t.after.invoicePaymentIds : null).toEqual([R.invOk]);
  });

  it('an invoice payment no longer in Undeposited Funds: predicted, and the import refuses alike', async () => {
    const buf = only((t) => t.type === 'deposit' && t.id === R.depGone);
    const r = await reviewChangesFile(ctx, buf);
    const p = r.items.find((i) => i.key === `deposit:add:${R.depGone}`)?.problem ?? null;
    expect(p).toMatch(/has been voided in your file, so the payment on it is no longer in Undeposited Funds/);
    expect(r.canImport).toBe(false);
    await refusesWith(buf, p!);
  });

  it('an invoice payment the client deposited in April: predicted with the client deposit, the import refuses alike', async () => {
    const buf = only((t) => t.type === 'deposit' && t.id === R.depDep);
    const r = await reviewChangesFile(ctx, buf);
    const p = r.items.find((i) => i.key === `deposit:add:${R.depDep}`)?.problem ?? null;
    expect(p).toMatch(/Your payment on invoice #IP-2 .*is already in your deposit of \$35\.00 on 2026-04-03/);
    await refusesWith(buf, p!);
  });

  it('the accountant voiding an invoice whose payment the client deposited: predicted, the import refuses alike', async () => {
    const buf = only(() => false, (x) => x.type === 'invoice' && x.op === 'void' && x.id === R.invVoid);
    const r = await reviewChangesFile(ctx, buf);
    const p = r.items.find((i) => i.key === `invoice:void:${R.invVoid}`)?.problem ?? null;
    expect(p).toMatch(/your deposit of \$35\.00 on 2026-04-03 .*can't be voided/);
    await refusesWith(buf, p!);
  });

  it('a deposit nobody else touched imports whole, invoice payment included', async () => {
    const buf = only((t) => t.type === 'deposit' && t.id === R.depOk);
    const r = await reviewChangesFile(ctx, buf);
    expect(r.items.find((i) => i.key === `deposit:add:${R.depOk}`)?.problem ?? null).toBeNull();
    await importChangesFile(ctx, buf);
    const lines = await db
      .select({ depositId: depositLines.depositId, amount: depositLines.amount, total: deposits.total })
      .from(depositLines)
      .innerJoin(deposits, eq(deposits.id, depositLines.depositId))
      .where(eq(depositLines.description, `invoicePayment:${R.invOk}`));
    expect(lines).toHaveLength(1);
    expect(lines[0].total).toBe('10.00');
    expect((await trialBalance(ctx)).balanced).toBe(true);
  });
});
