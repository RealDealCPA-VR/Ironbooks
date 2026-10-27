/**
 * QuickBooks' Product Information window (F2 / Ctrl+1): what the company file holds — the list
 * totals and the number of transactions — for the open company. The location and size of the
 * company file are added by the route (app/api/product-info/route.ts), which knows the file.
 */
import { and, count, eq } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import {
  accounts,
  classes,
  customers,
  employees,
  items,
  journalEntries,
  otherNames,
  vendors,
} from '@/lib/db/schema';
import type { ServiceContext } from './_base';

export interface ProductInfoCounts {
  /** Journal entries posted (every transaction posts one). */
  transactions: number;
  accounts: number;
  customers: number;
  vendors: number;
  employees: number;
  otherNames: number;
  /** Customers + vendors + employees + other names (QuickBooks' "Total Names"). */
  names: number;
  items: number;
  classes: number;
}

async function countFor(ctx: ServiceContext, table: PgTable, companyId: PgColumn): Promise<number> {
  const [row] = await ctx.db.select({ n: count() }).from(table).where(and(eq(companyId, ctx.companyId)));
  return Number(row?.n ?? 0);
}

export async function productInfoCounts(ctx: ServiceContext): Promise<ProductInfoCounts> {
  const [transactions, acct, cust, vend, emp, other, item, klass] = await Promise.all([
    countFor(ctx, journalEntries, journalEntries.companyId),
    countFor(ctx, accounts, accounts.companyId),
    countFor(ctx, customers, customers.companyId),
    countFor(ctx, vendors, vendors.companyId),
    countFor(ctx, employees, employees.companyId),
    countFor(ctx, otherNames, otherNames.companyId),
    countFor(ctx, items, items.companyId),
    countFor(ctx, classes, classes.companyId),
  ]);
  return {
    transactions,
    accounts: acct,
    customers: cust,
    vendors: vend,
    employees: emp,
    otherNames: other,
    names: cust + vend + emp + other,
    items: item,
    classes: klass,
  };
}
