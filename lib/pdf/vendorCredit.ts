/**
 * Vendor credit PDF (QB "Credit" from Enter Bills): vendor, Ref. No., date, the Expenses-tab and
 * Items-tab lines (item, description, account, qty, cost, amount, class, customer:job) and the
 * credit's remaining balance. Printed with the shared form renderer using the purchase-order
 * layout retitled "CREDIT" (there is no separate vendor-credit template type).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { accounts, classes, customers, items, jobs, vendors } from '@/lib/db/schema';
import type { ServiceContext } from '@/lib/services/_base';
import { getVendorCredit } from '@/lib/services/vendorCredits';
import { defaultDesign } from './design';
import { addressToLines, companyLetterhead } from './forms';
import { renderFormPdf } from './template';

const isoDate = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

export async function buildVendorCreditPdf(
  ctx: ServiceContext,
  id: string,
): Promise<{ bytes: Uint8Array; number: string }> {
  const credit = await getVendorCredit(ctx, id);
  const [vendor] = await ctx.db
    .select({ displayName: vendors.displayName, address: vendors.address })
    .from(vendors)
    .where(and(eq(vendors.companyId, ctx.companyId), eq(vendors.id, credit.vendorId)));

  const ids = <K extends 'accountId' | 'itemId' | 'classId' | 'customerId' | 'jobId'>(k: K) =>
    [...new Set(credit.lines.map((l) => l[k]).filter((x): x is string => Boolean(x)))];
  const nameMap = async <T extends { id: string; name: string }>(rows: Promise<T[]>) =>
    new Map((await rows).map((r) => [r.id, r.name] as const));
  const acctIds = ids('accountId');
  const itemIds = ids('itemId');
  const classIds = ids('classId');
  const custIds = ids('customerId');
  const jobIds = ids('jobId');
  const [acctMap, itemMap, classMap, custMap, jobMap] = await Promise.all([
    acctIds.length
      ? nameMap(
          ctx.db
            .select({ id: accounts.id, name: accounts.code })
            .from(accounts)
            .where(and(eq(accounts.companyId, ctx.companyId), inArray(accounts.id, acctIds))),
        )
      : new Map<string, string>(),
    itemIds.length
      ? nameMap(ctx.db.select({ id: items.id, name: items.name }).from(items).where(inArray(items.id, itemIds)))
      : new Map<string, string>(),
    classIds.length
      ? nameMap(ctx.db.select({ id: classes.id, name: classes.name }).from(classes).where(inArray(classes.id, classIds)))
      : new Map<string, string>(),
    custIds.length
      ? nameMap(
          ctx.db.select({ id: customers.id, name: customers.displayName }).from(customers).where(inArray(customers.id, custIds)),
        )
      : new Map<string, string>(),
    jobIds.length
      ? nameMap(ctx.db.select({ id: jobs.id, name: jobs.name }).from(jobs).where(inArray(jobs.id, jobIds)))
      : new Map<string, string>(),
  ]);

  const design = defaultDesign('purchase_order');
  design.title = 'CREDIT';
  design.footerText = 'Vendor credit — reduces what we owe you.';
  design.fields.number = { show: true, label: 'Ref. No.' };
  design.fields.expectedDate = { show: false, label: 'Expected' };
  design.fields.status = { show: true, label: 'Status' };
  design.fields.shipTo = { show: false, label: 'Ship To' };
  design.fields.memo = { show: true, label: 'Memo' };
  design.columns = design.columns.map((c) => (c.key === 'item' ? { ...c, show: itemIds.length > 0 } : c));

  const company = await companyLetterhead(ctx);
  const number = credit.refNumber ?? '';
  const bytes = await renderFormPdf(
    {
      formType: 'purchase_order',
      company,
      fields: {
        number: number || null,
        date: isoDate(credit.date),
        status: credit.status === 'void' ? 'Void' : `Remaining credit ${credit.unapplied}`,
      },
      parties: { vendor: [vendor?.displayName ?? 'Vendor', ...addressToLines(vendor?.address as Record<string, string> | null)] },
      lines: credit.lines.map((l) => {
        const extra = [
          l.classId ? `Class: ${classMap.get(l.classId) ?? ''}` : '',
          l.customerId ? `Customer: ${custMap.get(l.customerId) ?? ''}${l.jobId ? `:${jobMap.get(l.jobId) ?? ''}` : ''}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return {
          item: l.itemId ? (itemMap.get(l.itemId) ?? '') : '',
          description: [l.description ?? '', extra].filter(Boolean).join(' — ') || '—',
          account: acctMap.get(l.accountId) ?? '',
          quantity: l.quantity != null ? Number(l.quantity) : '',
          rate: l.unitCost ?? '',
          amount: l.amount,
        };
      }),
      totals: [
        { label: 'Credit total', value: credit.total, emphasis: 'total' },
        { label: 'Remaining credit', value: credit.unapplied, emphasis: 'balance' },
      ],
      memo: credit.memo,
    },
    design,
  );
  return { bytes, number: number || credit.id.slice(0, 8) };
}
