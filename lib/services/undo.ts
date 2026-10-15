/**
 * Undo for everything (ux/undo).
 *
 * After a save (create / update), void or delete of a transaction or list record the UI shows a
 * toast with an "Undo" button for 30 seconds. This service is the server side of it:
 *
 *   1. prepareUndo — called BEFORE an update / void / delete: snapshots the record as it is now
 *      (read through the record's own get service) into an `undo_actions` row (status 'pending').
 *   2. commitUndo  — called AFTER the save succeeded: confirms from the audit trail that THIS user
 *      really made that change (after the snapshot was taken), records the record's version right
 *      after the change and arms the token for UNDO_WINDOW_MS. Creates need no prepare step.
 *   3. performUndo — applies the inverse THROUGH THE EXISTING SERVICES, so every ledger guard,
 *      closing-date / fiscal-period rule, reconciliation guard and audit-trail entry applies:
 *        create -> void the transaction (none of these can be deleted) / make the list record
 *                  inactive (the app's "delete"); estimates are marked Rejected, POs voided
 *        update -> the update service is called again with the snapshot taken before the change
 *        delete -> list records are made active again (their data never left)
 *        void   -> a voided posting can't be un-voided safely (its entry is reversed and stock /
 *                  applications were unwound), so the document is re-entered as a NEW copy from
 *                  the pre-void snapshot, keeping its number where the numbering rules allow,
 *                  and the message says so. A voided purchase order (no posting) is simply
 *                  reopened.
 *      An undo is refused with a plain message when: the token belongs to another user or
 *      company, it was already used, the 30 seconds have passed, or the record changed since
 *      the action (record-locking version moved).
 *
 * The token claim, the stale check and the inverse run in ONE database transaction: a failed
 * inverse (closing date, reconciliation, ...) leaves the token usable, so the user can retry
 * with the closing-date password; two clicks can never undo twice.
 */
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  accounts,
  auditLogs,
  billPayments,
  bills,
  creditMemos,
  customers,
  deposits,
  estimates,
  expenses,
  invoices,
  items,
  journalEntries,
  paymentsReceived,
  purchaseOrders,
  salesReceipts,
  transfers,
  undoActions,
  users,
  vendorCredits,
  vendors,
} from '@/lib/db/schema';
import { can } from '@/lib/permissions/model';
import { apiRuleFor } from '@/lib/permissions/routes';
import { permissionDenied } from './access';
import { assertAccountantCopyAllowsPath } from './accountantCopy/routeGate';
import {
  type ServiceContext,
  ServiceError,
  inTransaction,
  notFound,
  validation,
  writeAudit,
} from './_base';
import { versionField, type VersionedEntity } from './concurrency';
import { createInvoice, getInvoice, updateInvoice, voidInvoice, type CreateInvoiceInput } from './invoices';
import { createBill, getBill, updateBill, voidBill, type CreateBillInput } from './bills';
import { createExpense, getExpense, updateExpense, voidExpense, type CreateExpenseInput } from './expenses';
import {
  CASHBACK_LINE_PREFIX,
  RECEIPT_LINE_PREFIX,
  createDeposit,
  getDeposit,
  updateDeposit,
  voidDeposit,
  type CreateDepositInput,
} from './deposits';
import { getPayment, receivePayment, updatePayment, voidPayment, type ReceivePaymentInput } from './payments';
import {
  getBillPayment,
  payBills,
  updateBillPayment,
  voidBillPayment,
  type PayBillsInput,
} from './billPayments';
import { createManualEntry, getEntry, updateEntry, voidEntry, type UpdateEntryInput } from './journal';
import {
  createEstimate,
  getEstimate,
  updateEstimate,
  updateEstimateStatus,
  type CreateEstimateInput,
  type EstimateStatus,
} from './estimates';
import {
  createSalesReceipt,
  getSalesReceipt,
  updateSalesReceipt,
  voidSalesReceipt,
  type CreateSalesReceiptInput,
} from './salesReceipts';
import {
  createCreditMemo,
  getCreditMemo,
  updateCreditMemo,
  voidCreditMemo,
  type CreateCreditMemoInput,
} from './creditMemos';
import {
  createPurchaseOrder,
  getPurchaseOrder,
  updatePurchaseOrder,
  updateStatus as updatePurchaseOrderStatus,
  type UpdatePurchaseOrderInput,
} from './purchaseOrders';
import { createTransfer, getTransfer, updateTransfer, voidTransfer, type CreateTransferInput } from './transfers';
import {
  createVendorCredit,
  getVendorCredit,
  updateVendorCredit,
  voidVendorCredit,
  type CreateVendorCreditInput,
} from './vendorCredits';
import { deactivateCustomer, getCustomer, reactivateCustomer, updateCustomer, type UpdateCustomerInput } from './customers';
import { deactivateVendor, loadVendorUnmasked, reactivateVendor, updateVendor, type UpdateVendorInput } from './vendors';
import { deactivateItem, getItem, updateItem, type UpdateItemInput } from './items';
import { setReorderPoint } from './inventory';
import { deactivateAccount, getAccount, updateAccount } from './accounts';
import { qbAccountTypeOf } from '@/lib/accountTypes';
import { formatCurrency, Money } from '@/lib/money';

/** How long an undo stays available after the action (the toast shows the same countdown). */
export const UNDO_WINDOW_MS = 30_000;
/** Pending / used tokens older than this are pruned whenever a new one is made. */
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
/** A create is matched to its audit-trail row only if that row is this recent. */
const CREATE_MATCH_MS = 20_000;

export type UndoKind = 'create' | 'update' | 'void' | 'delete';
export const UNDO_KINDS: readonly UndoKind[] = ['create', 'update', 'void', 'delete'];

type Snap = Record<string, unknown>;

/** What an inverse did, in plain language. */
export interface UndoOutcome {
  message: string;
  /** Id of a record the undo created (a re-entered copy of a voided document). */
  newId?: string;
  /** True when a voided document was re-entered as a new copy instead of being restored. */
  copy?: boolean;
}

interface Adapter {
  entity: VersionedEntity;
  /** API resource segment: /api/<resource>/<id>. */
  resource: string;
  /** Plain-language noun, e.g. "invoice". */
  noun: string;
  /** List record (customers, vendors, items, accounts) rather than a transaction. */
  list: boolean;
  snapshot(ctx: ServiceContext, id: string): Promise<Snap>;
  /** Short name of the record for messages, e.g. 'invoice INV-1001'. */
  describe(snap: Snap): string;
  undoCreate(ctx: ServiceContext, id: string, snap: Snap): Promise<UndoOutcome>;
  restore(ctx: ServiceContext, id: string, before: Snap, now: Snap): Promise<UndoOutcome>;
  /** Inverse of a void (transactions) — re-enter a copy or reopen. */
  undoVoid?(ctx: ServiceContext, id: string, before: Snap): Promise<UndoOutcome>;
  /** Inverse of a delete (list records are made inactive; this makes them active again). */
  undoDelete?(ctx: ServiceContext, id: string, before: Snap): Promise<UndoOutcome>;
}

// ---------------------------------------------------------------------------
// Snapshot helpers (snapshots are stored as JSON: dates are ISO strings, decimals strings)
// ---------------------------------------------------------------------------

function toJson(v: unknown): Snap {
  return JSON.parse(JSON.stringify(v ?? {}, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))) as Snap;
}
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const reqStr = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const date = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? null : d;
};
const reqDate = (v: unknown): Date => date(v) ?? new Date(NaN);
const bool = (v: unknown): boolean => v === true;
const arr = (v: unknown): Snap[] => (Array.isArray(v) ? (v as Snap[]) : []);
const num = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const isZero = (v: unknown) => {
  try {
    return Money.of((v as string) ?? 0).isZero();
  } catch {
    return true;
  }
};
const money = (v: unknown) => {
  try {
    return formatCurrency(Money.of((v as string) ?? 0));
  } catch {
    return String(v ?? '');
  }
};
function idOf(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as Record<string, unknown>;
  if (typeof r.id === 'string') return r.id;
  for (const v of Object.values(r)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Snap).id === 'string') return (v as Snap).id as string;
  }
  return undefined;
}

/** Inventory site / bin / serial / lot detail carried on stock lines. */
function invDetail(l: Snap) {
  return {
    ...(l.siteId ? { siteId: str(l.siteId) } : {}),
    ...(l.binId ? { binId: str(l.binId) } : {}),
    ...(Array.isArray(l.serialNumbers) && l.serialNumbers.length ? { serialNumbers: l.serialNumbers as string[] } : {}),
    ...(l.lotNumber ? { lotNumber: str(l.lotNumber) } : {}),
    ...(l.lotExpiration ? { lotExpiration: date(l.lotExpiration) } : {}),
  };
}

const docNo = (snap: Snap, ...keys: string[]) => {
  for (const k of keys) if (snap[k] !== null && snap[k] !== undefined && snap[k] !== '') return String(snap[k]);
  return '';
};
const named = (noun: string, no: string) => (no ? `${noun} ${no}` : noun);

/** "Voided X can't be un-voided ..." — the honest message for a re-entered copy. */
function copyMessage(noun: string, before: Snap, created: Snap | null, numberKeys: string[]): string {
  const oldNo = docNo(before, ...numberKeys);
  const newNo = created ? docNo(created, ...numberKeys) : '';
  const same = oldNo && newNo && oldNo === newNo;
  return (
    `A voided ${noun} can't be un-voided, so Undo re-entered it as a new ${noun}` +
    (newNo ? ` (${same ? `same number, ${newNo}` : `number ${newNo}`})` : '') +
    ` with the same details. The voided ${noun}${oldNo ? ` ${oldNo}` : ''} stays in your records marked VOID.`
  );
}

// ---------------------------------------------------------------------------
// Snapshot -> service input mappers
// ---------------------------------------------------------------------------

function invoiceInput(s: Snap): CreateInvoiceInput {
  return {
    refNumber: str(s.refNumber),
    allowDuplicateNumber: true,
    customerId: reqStr(s.customerId),
    date: reqDate(s.date),
    dueDate: date(s.dueDate),
    terms: str(s.terms),
    lines: arr(s.lines).map((l) => ({
      itemId: str(l.itemId),
      accountId: str(l.accountId),
      description: str(l.description),
      quantity: reqStr(l.quantity ?? '1'),
      rate: num(l.rate),
      taxable: l.taxable !== false,
      taxRateId: str(l.taxRateId),
      classId: str(l.classId),
      jobId: str(l.jobId),
      estimateLineId: str(l.estimateLineId),
      ...(l.estimateLineId && l.amount != null ? { amount: String(l.amount) } : {}),
      ...invDetail(l),
    })),
    taxRateId: str(s.taxRateId),
    classId: str(s.classId),
    jobId: str(s.jobId),
    salesRepId: str(s.salesRepId),
    discount: num(s.discount),
    discountType: (str(s.discountType) as 'amount' | 'percent' | null) ?? 'amount',
    retainagePercent: num(s.retainagePercent),
    memo: str(s.memo),
    currency: str(s.currency),
    exchangeRate: num(s.exchangeRate),
    ...(s.status === 'draft' ? { status: 'draft' as const } : {}),
    customFields: (s.customFields as Record<string, string> | null) ?? null,
    shipDate: date(s.shipDate),
    shipVia: str(s.shipVia),
    fob: str(s.fob),
    trackingNumber: str(s.trackingNumber),
    shipTo: (s.shipTo as Record<string, string> | null) ?? null,
    poNumber: str(s.poNumber),
    toBePrinted: bool(s.toBePrinted),
    toBeEmailed: bool(s.toBeEmailed),
    // The user already accepted these warnings when the invoice was first saved.
    overrideCreditLimit: true,
    allowOverBilling: true,
    isStatementCharge: bool(s.isStatementCharge),
  };
}

function billInput(s: Snap): CreateBillInput {
  return {
    vendorId: reqStr(s.vendorId),
    billNumber: str(s.billNumber),
    date: reqDate(s.date),
    dueDate: date(s.dueDate),
    terms: str(s.terms),
    memo: str(s.memo),
    classId: str(s.classId),
    currency: str(s.currency),
    exchangeRate: num(s.exchangeRate),
    checkDuplicateNumber: false,
    lines: arr(s.lines).map((l) => ({
      accountId: str(l.accountId),
      itemId: str(l.itemId),
      description: str(l.description),
      quantity: num(l.quantity),
      amount: num(l.amount),
      classId: str(l.classId),
      customerId: str(l.customerId),
      jobId: str(l.jobId),
      ...invDetail(l),
    })),
  };
}

function expenseInput(s: Snap): CreateExpenseInput {
  return {
    vendorId: str(s.vendorId),
    payeeName: str(s.payeeName),
    date: reqDate(s.date),
    method: (str(s.method) ?? 'check') as CreateExpenseInput['method'],
    reference: str(s.reference),
    paymentAccountId: reqStr(s.paymentAccountId),
    memo: str(s.memo),
    toPrint: bool(s.toPrint),
    currency: str(s.currency),
    exchangeRate: num(s.exchangeRate),
    checkDuplicateNumber: false,
    lines: arr(s.lines).map((l) => ({
      accountId: str(l.accountId),
      itemId: str(l.itemId),
      quantity: num(l.quantity),
      unitCost: num(l.unitCost),
      description: str(l.description),
      amount: num(l.amount),
      classId: str(l.classId),
      customerId: str(l.customerId),
      jobId: str(l.jobId),
      ...invDetail(l),
    })),
  };
}

function depositInput(s: Snap): CreateDepositInput {
  const paymentIds: string[] = [];
  const salesReceiptIds: string[] = [];
  const extraLines: NonNullable<CreateDepositInput['extraLines']> = [];
  let cashBack: CreateDepositInput['cashBack'] = null;
  for (const l of arr(s.lines)) {
    const desc = str(l.description) ?? '';
    if (l.paymentId) paymentIds.push(String(l.paymentId));
    else if (desc.startsWith(RECEIPT_LINE_PREFIX)) {
      salesReceiptIds.push(desc.slice(RECEIPT_LINE_PREFIX.length).trim());
    } else if (desc.startsWith(CASHBACK_LINE_PREFIX)) {
      cashBack = { accountId: desc.slice(CASHBACK_LINE_PREFIX.length).trim(), amount: Money.of(String(l.amount)).negated().toFixed(2) };
    } else if (l.accountId) {
      extraLines.push({ accountId: String(l.accountId), amount: String(l.amount), description: str(l.description) });
    }
  }
  return {
    depositAccountId: reqStr(s.depositAccountId),
    date: reqDate(s.date),
    paymentIds,
    salesReceiptIds,
    extraLines,
    cashBack,
    memo: str(s.memo),
    exchangeRate: num(s.exchangeRate),
  };
}

function paymentInput(s: Snap): ReceivePaymentInput {
  const journal = arr(s.journalApplications);
  return {
    customerId: reqStr(s.customerId),
    date: reqDate(s.date),
    method: (str(s.method) ?? 'check') as ReceivePaymentInput['method'],
    reference: str(s.reference),
    amount: reqStr(s.amount),
    depositAccountId: str(s.depositAccountId),
    applications: arr(s.applications).map((a) => ({
      invoiceId: String(a.invoiceId),
      amountApplied: String(a.amountApplied),
      discountAmount: isZero(a.discountAmount) ? null : String(a.discountAmount),
    })),
    credits: arr(s.credits).map((c) => ({ creditMemoId: String(c.creditMemoId), invoiceId: String(c.invoiceId), amount: String(c.amount) })),
    discountAccountId: str(s.discountAccountId),
    memo: str(s.memo),
    currency: str(s.currency),
    exchangeRate: num(s.exchangeRate),
    journalItems: journal
      .filter((j) => j.kind === 'payment')
      .map((j) => ({ journalLineId: String(j.journalLineId), amount: String(j.amount) })),
    journalCredits: journal
      .filter((j) => j.kind === 'invoice_credit' && j.invoiceId)
      .map((j) => ({ journalLineId: String(j.journalLineId), invoiceId: String(j.invoiceId), amount: String(j.amount) })),
    journalOffsets: arr(s.journalOffsets).map((o) => ({
      journalLineId: String(o.journalLineId),
      chargeLineId: String(o.chargeLineId),
      amount: String(o.amount),
    })),
  };
}

function billPaymentInput(s: Snap): PayBillsInput {
  const journal = arr(s.journalApplications);
  const apps = arr(s.applications);
  const discount = isZero(s.discountTotal) ? null : String(s.discountTotal);
  return {
    vendorId: reqStr(s.vendorId),
    date: reqDate(s.date),
    method: (str(s.method) ?? 'check') as PayBillsInput['method'],
    reference: str(s.reference),
    paymentAccountId: reqStr(s.paymentAccountId),
    discountAccountId: discount ? str(s.discountAccountId) : null,
    // Discounts are stored as one total on the entry; it goes back on the first bill.
    applications: apps.map((a, i) => ({
      billId: String(a.billId),
      amountApplied: String(a.amountApplied),
      ...(i === 0 && discount ? { discountTaken: discount } : {}),
    })),
    toPrint: bool(s.toPrint),
    exchangeRate: num(s.exchangeRate),
    checkDuplicateNumber: false,
    journalItems: journal
      .filter((j) => j.kind === 'bill_payment')
      .map((j) => ({ journalLineId: String(j.journalLineId), amount: String(j.amount) })),
    journalCredits: journal
      .filter((j) => j.kind === 'bill_credit' && j.billId)
      .map((j) => ({ journalLineId: String(j.journalLineId), billId: String(j.billId), amount: String(j.amount) })),
    journalOffsets: arr(s.journalOffsets).map((o) => ({
      journalLineId: String(o.journalLineId),
      chargeLineId: String(o.chargeLineId),
      amount: String(o.amount),
    })),
  };
}

function entryInput(s: Snap): UpdateEntryInput {
  return {
    date: reqDate(s.date),
    description: reqStr(s.description),
    reference: str(s.reference),
    isAdjusting: bool(s.isAdjusting),
    lines: arr(s.lines).map((l) => ({
      accountId: String(l.accountId),
      debit: num(l.debit),
      credit: num(l.credit),
      memo: str(l.memo),
      classId: str(l.classId),
      ...(l.entityType && l.entityId
        ? { entityType: l.entityType as 'customer' | 'vendor' | 'employee' | 'other', entityId: String(l.entityId) }
        : {}),
    })),
  };
}

function estimateInput(s: Snap): CreateEstimateInput {
  return {
    refNumber: str(s.refNumber),
    allowDuplicateNumber: true,
    customerId: reqStr(s.customerId),
    date: reqDate(s.date),
    expirationDate: date(s.expirationDate),
    taxRateId: str(s.taxRateId),
    memo: str(s.memo),
    shipTo: (s.shipTo as Record<string, string> | null) ?? null,
    toBePrinted: bool(s.toBePrinted),
    toBeEmailed: bool(s.toBeEmailed),
    lines: arr(s.lines).map((l) => ({
      itemId: str(l.itemId),
      description: str(l.description),
      quantity: reqStr(l.quantity ?? '1'),
      rate: num(l.rate),
      taxable: l.taxable !== false,
      classId: str(l.classId),
    })),
  };
}

function salesReceiptInput(s: Snap): CreateSalesReceiptInput {
  return {
    refNumber: str(s.refNumber),
    allowDuplicateNumber: true,
    customerId: str(s.customerId),
    date: reqDate(s.date),
    taxRateId: str(s.taxRateId),
    depositAccountId: str(s.depositAccountId),
    method: (str(s.method) ?? 'cash') as CreateSalesReceiptInput['method'],
    reference: str(s.reference),
    memo: str(s.memo),
    classId: str(s.classId),
    shipDate: date(s.shipDate),
    shipVia: str(s.shipVia),
    fob: str(s.fob),
    trackingNumber: str(s.trackingNumber),
    shipTo: (s.shipTo as Record<string, string> | null) ?? null,
    poNumber: str(s.poNumber),
    toBePrinted: bool(s.toBePrinted),
    toBeEmailed: bool(s.toBeEmailed),
    lines: arr(s.lines).map((l) => ({
      itemId: str(l.itemId),
      accountId: str(l.accountId),
      description: str(l.description),
      quantity: reqStr(l.quantity ?? '1'),
      rate: num(l.rate),
      taxable: l.taxable !== false,
      taxRateId: str(l.taxRateId),
      ...invDetail(l),
    })),
  };
}

function creditMemoInput(s: Snap): CreateCreditMemoInput {
  return {
    refNumber: str(s.refNumber),
    allowDuplicateNumber: true,
    customerId: reqStr(s.customerId),
    date: reqDate(s.date),
    taxRateId: str(s.taxRateId),
    memo: str(s.memo),
    toBePrinted: bool(s.toBePrinted),
    toBeEmailed: bool(s.toBeEmailed),
    lines: arr(s.lines).map((l) => ({
      itemId: str(l.itemId),
      accountId: str(l.accountId),
      description: str(l.description),
      quantity: reqStr(l.quantity ?? '1'),
      rate: reqStr(l.rate ?? '0'),
      taxable: l.taxable !== false,
      restock: l.restock !== false,
      ...invDetail(l),
    })),
  };
}

/** `keepLineIds`: line ids still on the PO (so received / billed lines keep their link). */
function purchaseOrderInput(s: Snap, keepLineIds: Set<string> | null): UpdatePurchaseOrderInput {
  return {
    refNumber: str(s.refNumber),
    allowDuplicateNumber: true,
    vendorId: reqStr(s.vendorId),
    date: reqDate(s.date),
    expectedDate: date(s.expectedDate),
    memo: str(s.memo),
    lines: arr(s.lines).map((l) => ({
      ...(keepLineIds && l.id && keepLineIds.has(String(l.id)) ? { id: String(l.id) } : {}),
      itemId: str(l.itemId),
      accountId: str(l.accountId),
      description: str(l.description),
      quantity: reqStr(l.quantity ?? '1'),
      rate: reqStr(l.rate ?? '0'),
    })),
  };
}

function transferInput(s: Snap): CreateTransferInput {
  return {
    date: reqDate(s.date),
    fromAccountId: reqStr(s.fromAccountId),
    toAccountId: reqStr(s.toAccountId),
    amount: reqStr(s.amount),
    memo: str(s.memo),
    exchangeRate: num(s.exchangeRate),
    toAmount: num(s.toAmount),
    homeAmount: num(s.homeAmount),
  };
}

function vendorCreditInput(s: Snap): CreateVendorCreditInput {
  return {
    vendorId: reqStr(s.vendorId),
    date: reqDate(s.date),
    memo: str(s.memo),
    refNumber: str(s.refNumber),
    currency: str(s.currency),
    exchangeRate: num(s.exchangeRate),
    lines: arr(s.lines).map((l) => ({
      accountId: str(l.accountId),
      itemId: str(l.itemId),
      quantity: num(l.quantity),
      unitCost: num(l.unitCost),
      description: str(l.description),
      amount: num(l.amount),
      classId: str(l.classId),
      customerId: str(l.customerId),
      jobId: str(l.jobId),
    })),
  };
}

function customerPatch(s: Snap): UpdateCustomerInput {
  return {
    displayName: reqStr(s.displayName),
    companyName: str(s.companyName),
    email: str(s.email),
    phone: str(s.phone),
    billingAddress: (s.billingAddress as UpdateCustomerInput['billingAddress']) ?? null,
    ...(Array.isArray(s.shipToAddresses)
      ? { shipToAddresses: s.shipToAddresses as UpdateCustomerInput['shipToAddresses'] }
      : { shippingAddress: (s.shippingAddress as UpdateCustomerInput['shippingAddress']) ?? null }),
    ...(s.termsId ? { termsId: String(s.termsId) } : { terms: str(s.terms) }),
    creditLimit: num(s.creditLimit),
    taxable: s.taxable !== false,
    taxRateId: str(s.taxRateId),
    parentId: str(s.parentId),
    notes: str(s.notes),
    salesTaxCodeId: str(s.salesTaxCodeId),
    resaleNumber: str(s.resaleNumber),
    taxExemptionReason: str(s.taxExemptionReason),
  };
}

function vendorPatch(s: Snap): UpdateVendorInput {
  return {
    displayName: reqStr(s.displayName),
    companyName: str(s.companyName),
    email: str(s.email),
    phone: str(s.phone),
    address: (s.address as Record<string, string> | null) ?? null,
    ...(s.termsId ? { termsId: String(s.termsId) } : { terms: str(s.terms) }),
    is1099: bool(s.is1099),
    taxId: str(s.taxId),
    defaultExpenseAccountId: str(s.defaultExpenseAccountId),
    notes: str(s.notes),
    prefillAccountIds: Array.isArray(s.prefillAccountIds) ? (s.prefillAccountIds as string[]) : null,
    printOnCheckAs: str(s.printOnCheckAs),
    accountNumber: str(s.accountNumber),
    currency: str(s.currency),
  };
}

function itemPatch(s: Snap): UpdateItemInput {
  return {
    name: reqStr(s.name),
    sku: str(s.sku),
    type: s.type as UpdateItemInput['type'],
    description: str(s.description),
    salesPrice: num(s.salesPrice),
    purchaseCost: num(s.purchaseCost),
    incomeAccountId: str(s.incomeAccountId),
    expenseAccountId: str(s.expenseAccountId),
    assetAccountId: str(s.assetAccountId),
    taxable: s.taxable !== false,
    unitOfMeasure: str(s.unitOfMeasure),
    isActive: s.isActive !== false,
    barcode: str(s.barcode),
    trackingMode: (str(s.trackingMode) ?? 'none') as UpdateItemInput['trackingMode'],
    weight: num(s.weight),
    preferredVendorId: str(s.preferredVendorId),
    salesTaxCodeId: str(s.salesTaxCodeId),
    uomSetId: str(s.uomSetId),
  };
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/** Transactions whose void is a ledger reversal: undo re-enters a copy. */
function ledgerDoc(params: {
  entity: VersionedEntity;
  resource: string;
  noun: string;
  numberKeys: string[];
  get: (ctx: ServiceContext, id: string) => Promise<unknown>;
  void: (ctx: ServiceContext, id: string) => Promise<unknown>;
  update: (ctx: ServiceContext, id: string, s: Snap) => Promise<unknown>;
  create: (ctx: ServiceContext, s: Snap) => Promise<unknown>;
  describe?: (s: Snap) => string;
}): Adapter {
  const describe = params.describe ?? ((s: Snap) => named(params.noun, docNo(s, ...params.numberKeys)));
  return {
    entity: params.entity,
    resource: params.resource,
    noun: params.noun,
    list: false,
    snapshot: async (ctx, id) => toJson(await params.get(ctx, id)),
    describe,
    async undoCreate(ctx, id, snap) {
      await params.void(ctx, id);
      return { message: `Undone: ${describe(snap)} was voided. (Saved transactions can't be deleted; the void keeps the record of it.)` };
    },
    async restore(ctx, id, before) {
      await params.update(ctx, id, before);
      return { message: `Undone: your changes to ${describe(before)} were reversed.` };
    },
    async undoVoid(ctx, _id, before) {
      const created = await params.create(ctx, before);
      const newId = idOf(created);
      let createdSnap: Snap | null = null;
      if (newId) {
        try {
          createdSnap = toJson(await params.get(ctx, newId));
        } catch {
          createdSnap = null;
        }
      }
      return { message: copyMessage(params.noun, before, createdSnap, params.numberKeys), newId, copy: true };
    },
  };
}

const ADAPTERS: Record<string, Adapter> = {
  invoices: ledgerDoc({
    entity: 'invoice',
    resource: 'invoices',
    noun: 'invoice',
    numberKeys: ['refNumber', 'invoiceNumber'],
    get: getInvoice,
    void: voidInvoice,
    update: (ctx, id, s) => updateInvoice(ctx, id, invoiceInput(s)),
    create: (ctx, s) => createInvoice(ctx, invoiceInput(s)),
  }),
  bills: ledgerDoc({
    entity: 'bill',
    resource: 'bills',
    noun: 'bill',
    numberKeys: ['billNumber'],
    get: getBill,
    void: voidBill,
    update: (ctx, id, s) => updateBill(ctx, id, billInput(s)),
    create: (ctx, s) => createBill(ctx, billInput(s)),
    describe: (s) => (s.billNumber ? `bill ${s.billNumber}` : `bill for ${money(s.total)}`),
  }),
  expenses: ledgerDoc({
    entity: 'expense',
    resource: 'expenses',
    noun: 'check / expense',
    numberKeys: ['reference'],
    get: getExpense,
    void: voidExpense,
    update: (ctx, id, s) => updateExpense(ctx, id, expenseInput(s)),
    create: (ctx, s) => createExpense(ctx, expenseInput(s)),
    describe: (s) =>
      s.method === 'check'
        ? `check${s.reference ? ` ${s.reference}` : ''} for ${money(s.total)}`
        : `expense${s.reference ? ` ${s.reference}` : ''} for ${money(s.total)}`,
  }),
  deposits: ledgerDoc({
    entity: 'deposit',
    resource: 'deposits',
    noun: 'deposit',
    numberKeys: [],
    get: getDeposit,
    void: voidDeposit,
    update: (ctx, id, s) => updateDeposit(ctx, id, depositInput(s)),
    create: (ctx, s) => createDeposit(ctx, depositInput(s)),
    describe: (s) => `deposit of ${money(s.total)}`,
  }),
  payments: ledgerDoc({
    entity: 'payment_received',
    resource: 'payments',
    noun: 'customer payment',
    numberKeys: ['reference'],
    get: getPayment,
    void: voidPayment,
    update: (ctx, id, s) => updatePayment(ctx, id, paymentInput(s)),
    create: (ctx, s) => receivePayment(ctx, paymentInput(s)),
    describe: (s) => `customer payment of ${money(s.amount)}${s.reference ? ` (ref ${s.reference})` : ''}`,
  }),
  'bill-payments': ledgerDoc({
    entity: 'bill_payment',
    resource: 'bill-payments',
    noun: 'bill payment',
    numberKeys: ['reference'],
    get: getBillPayment,
    void: voidBillPayment,
    update: (ctx, id, s) => updateBillPayment(ctx, id, billPaymentInput(s)),
    create: (ctx, s) => payBills(ctx, billPaymentInput(s)),
    describe: (s) => `bill payment of ${money(s.amount)}${s.reference ? ` (ref ${s.reference})` : ''}`,
  }),
  'journal-entries': ledgerDoc({
    entity: 'journal_entry',
    resource: 'journal-entries',
    noun: 'journal entry',
    numberKeys: ['entryNumber'],
    get: getEntry,
    void: voidEntry,
    update: (ctx, id, s) => updateEntry(ctx, id, entryInput(s)),
    create: (ctx, s) => createManualEntry(ctx, entryInput(s)),
    describe: (s) => `journal entry #${s.entryNumber}`,
  }),
  'sales-receipts': ledgerDoc({
    entity: 'sales_receipt',
    resource: 'sales-receipts',
    noun: 'sales receipt',
    numberKeys: ['refNumber', 'receiptNumber'],
    get: getSalesReceipt,
    void: voidSalesReceipt,
    update: (ctx, id, s) => updateSalesReceipt(ctx, id, salesReceiptInput(s)),
    create: (ctx, s) => createSalesReceipt(ctx, salesReceiptInput(s)),
  }),
  'credit-memos': ledgerDoc({
    entity: 'credit_memo',
    resource: 'credit-memos',
    noun: 'credit memo',
    numberKeys: ['refNumber', 'memoNumber'],
    get: getCreditMemo,
    void: voidCreditMemo,
    update: (ctx, id, s) => updateCreditMemo(ctx, id, creditMemoInput(s)),
    create: (ctx, s) => createCreditMemo(ctx, creditMemoInput(s)),
  }),
  transfers: ledgerDoc({
    entity: 'transfer',
    resource: 'transfers',
    noun: 'transfer',
    numberKeys: [],
    get: getTransfer,
    void: voidTransfer,
    update: (ctx, id, s) => updateTransfer(ctx, id, transferInput(s)),
    create: (ctx, s) => createTransfer(ctx, transferInput(s)),
    describe: (s) => `transfer of ${money(s.amount)}`,
  }),
  'vendor-credits': ledgerDoc({
    entity: 'vendor_credit',
    resource: 'vendor-credits',
    noun: 'vendor credit',
    numberKeys: ['refNumber'],
    get: getVendorCredit,
    void: voidVendorCredit,
    update: (ctx, id, s) => updateVendorCredit(ctx, id, vendorCreditInput(s)),
    create: (ctx, s) => createVendorCredit(ctx, vendorCreditInput(s)),
    describe: (s) => (s.refNumber ? `vendor credit ${s.refNumber}` : `vendor credit of ${money(s.total)}`),
  }),

  estimates: {
    entity: 'estimate',
    resource: 'estimates',
    noun: 'estimate',
    list: false,
    snapshot: async (ctx, id) => toJson(await getEstimate(ctx, id)),
    describe: (s) => named('estimate', docNo(s, 'refNumber', 'estimateNumber')),
    async undoCreate(ctx, id, snap) {
      // Estimates have no delete; Rejected takes it out of every open-estimate list.
      await updateEstimateStatus(ctx, id, 'rejected');
      return { message: `Undone: ${this.describe(snap)} was marked Rejected (estimates can't be deleted).` };
    },
    async restore(ctx, id, before, now) {
      const sameBody =
        JSON.stringify(estimateInput({ ...before, status: null })) === JSON.stringify(estimateInput({ ...now, status: null }));
      if (!sameBody) await updateEstimate(ctx, id, estimateInput(before));
      if (before.status !== now.status && before.status) {
        await updateEstimateStatus(ctx, id, before.status as EstimateStatus);
      }
      return { message: `Undone: your changes to ${this.describe(before)} were reversed.` };
    },
  },

  'purchase-orders': {
    entity: 'purchase_order',
    resource: 'purchase-orders',
    noun: 'purchase order',
    list: false,
    snapshot: async (ctx, id) => toJson(await getPurchaseOrder(ctx, id)),
    describe: (s) => named('purchase order', docNo(s, 'refNumber', 'poNumber')),
    async undoCreate(ctx, id, snap) {
      await updatePurchaseOrderStatus(ctx, id, 'void');
      return { message: `Undone: ${this.describe(snap)} was voided (purchase orders can't be deleted).` };
    },
    async restore(ctx, id, before, now) {
      const current = new Set(arr(now.lines).map((l) => String(l.id)));
      await updatePurchaseOrder(ctx, id, purchaseOrderInput(before, current));
      return { message: `Undone: your changes to ${this.describe(before)} were reversed.` };
    },
    async undoVoid(ctx, id, before) {
      // A purchase order never posts, so its void is just a status: reopen it.
      await updatePurchaseOrderStatus(ctx, id, before.status === 'closed' ? 'closed' : 'open');
      return { message: `Undone: ${this.describe(before)} is open again.` };
    },
  },

  customers: {
    entity: 'customer',
    resource: 'customers',
    noun: 'customer',
    list: true,
    snapshot: async (ctx, id) => toJson(await getCustomer(ctx, id)),
    describe: (s) => `customer “${s.displayName}”`,
    async undoCreate(ctx, id, snap) {
      await deactivateCustomer(ctx, id);
      return { message: `Undone: ${this.describe(snap)} was removed from your active customers (made inactive).` };
    },
    async restore(ctx, id, before, now) {
      await updateCustomer(ctx, id, customerPatch(before));
      if (before.isActive !== now.isActive) {
        if (before.isActive === false) await deactivateCustomer(ctx, id);
        else await reactivateCustomer(ctx, id);
      }
      return { message: `Undone: your changes to ${this.describe(before)} were reversed.` };
    },
    async undoDelete(ctx, id, before) {
      await reactivateCustomer(ctx, id);
      return { message: `Undone: ${this.describe(before)} is active again.` };
    },
  },

  vendors: {
    entity: 'vendor',
    resource: 'vendors',
    noun: 'vendor',
    list: true,
    snapshot: async (ctx, id) => toJson(await loadVendorUnmasked(ctx, id)),
    describe: (s) => `vendor “${s.displayName}”`,
    async undoCreate(ctx, id, snap) {
      await deactivateVendor(ctx, id);
      return { message: `Undone: ${this.describe(snap)} was removed from your active vendors (made inactive).` };
    },
    async restore(ctx, id, before, now) {
      await updateVendor(ctx, id, vendorPatch(before));
      if (before.isActive !== now.isActive) {
        if (before.isActive === false) await deactivateVendor(ctx, id);
        else await reactivateVendor(ctx, id);
      }
      return { message: `Undone: your changes to ${this.describe(before)} were reversed.` };
    },
    async undoDelete(ctx, id, before) {
      await reactivateVendor(ctx, id);
      return { message: `Undone: ${this.describe(before)} is active again.` };
    },
  },

  items: {
    entity: 'item',
    resource: 'items',
    noun: 'item',
    list: true,
    snapshot: async (ctx, id) => toJson(await getItem(ctx, id)),
    describe: (s) => `item “${s.name}”`,
    async undoCreate(ctx, id, snap) {
      await deactivateItem(ctx, id);
      return { message: `Undone: ${this.describe(snap)} was removed from your active items (made inactive).` };
    },
    async restore(ctx, id, before, now) {
      await updateItem(ctx, id, itemPatch(before));
      // The items PATCH route sets the reorder point through setReorderPoint, not updateItem.
      const was = str(before.reorderPoint);
      const is = str(now.reorderPoint);
      if ((was === null ? null : Money.of(was).toFixed(4)) !== (is === null ? null : Money.of(is).toFixed(4))) {
        await setReorderPoint(ctx, id, was);
      }
      return { message: `Undone: your changes to ${this.describe(before)} were reversed.` };
    },
    async undoDelete(ctx, id, before) {
      await updateItem(ctx, id, { isActive: true });
      return { message: `Undone: ${this.describe(before)} is active again.` };
    },
  },

  accounts: {
    entity: 'account',
    resource: 'accounts',
    noun: 'account',
    list: true,
    snapshot: async (ctx, id) => toJson(await getAccount(ctx, id)),
    describe: (s) => `account “${s.name}”`,
    async undoCreate(ctx, id, snap) {
      await deactivateAccount(ctx, id);
      return { message: `Undone: ${this.describe(snap)} was removed from your active accounts (made inactive).` };
    },
    async restore(ctx, id, before, now) {
      // A subtype alone is read against the account's CURRENT type, so when the change moved
      // the account to another QB account type, pass the earlier QB type too. (Left out when the
      // type did not change, so legacy type/subtype pairs restore exactly as stored.)
      const subtype = str(before.subtype);
      const wasQb = qbAccountTypeOf({ type: reqStr(before.type), subtype });
      const isQb = qbAccountTypeOf({ type: reqStr(now.type), subtype: str(now.subtype) });
      await updateAccount(ctx, id, {
        name: reqStr(before.name),
        ...(wasQb !== isQb ? { qbType: wasQb } : {}),
        subtype,
        parentId: str(before.parentId),
        description: str(before.description),
        taxLine: str(before.taxLine),
        isActive: before.isActive !== false,
      });
      return { message: `Undone: your changes to ${this.describe(before)} were reversed.` };
    },
    async undoDelete(ctx, id, before) {
      await updateAccount(ctx, id, { isActive: true });
      return { message: `Undone: ${this.describe(before)} is active again.` };
    },
  },
};

/** API resources Undo supports (used by the client to decide which saves get an Undo toast). */
export const UNDOABLE_RESOURCES = Object.keys(ADAPTERS);

export function adapterFor(resource: string): Adapter {
  const a = ADAPTERS[resource];
  if (!a) throw validation(`Undo is not available for "${resource}".`);
  return a;
}

// ---------------------------------------------------------------------------
// Versions (record locking) — same columns lib/services/concurrency.ts compares
// ---------------------------------------------------------------------------

const VERSION_TABLES = {
  invoice: invoices,
  bill: bills,
  journal_entry: journalEntries,
  customer: customers,
  vendor: vendors,
  item: items,
  estimate: estimates,
  sales_receipt: salesReceipts,
  credit_memo: creditMemos,
  purchase_order: purchaseOrders,
  expense: expenses,
  deposit: deposits,
  transfer: transfers,
  payment_received: paymentsReceived,
  bill_payment: billPayments,
  vendor_credit: vendorCredits,
  account: accounts,
} as const;

async function currentVersion(ctx: ServiceContext, entity: VersionedEntity, id: string): Promise<Date | null> {
  const t = (VERSION_TABLES as Record<string, unknown>)[entity] as typeof customers | undefined;
  if (!t) return null;
  const col = (t as unknown as Record<string, typeof customers.updatedAt>)[versionField(entity)];
  const [row] = await ctx.db
    .select({ v: col })
    .from(t)
    .where(and(eq(t.id, id), eq(t.companyId, ctx.companyId)));
  return row?.v ?? null;
}

// ---------------------------------------------------------------------------
// Permissions: the undo of an action needs the permission of the inverse action
// ---------------------------------------------------------------------------

function assertRoutePermission(ctx: ServiceContext, path: string, method: string): void {
  if (!ctx.access) return; // trusted internal context (tests, jobs)
  const rule = apiRuleFor(path, method);
  if (rule === null) throw new ServiceError('FORBIDDEN', 'You do not have permission to undo this.');
  if (rule === 'public' || rule === 'self' || rule === 'member') return;
  if (!can(ctx.access, rule.area, rule.action)) throw permissionDenied(rule.area, rule.action);
}

/** The API call the inverse of `kind` corresponds to (for the permission check). */
function inversePermission(a: Adapter, kind: UndoKind, id: string): [string, string] {
  const one = `/api/${a.resource}/${id}`;
  if (kind === 'create') {
    if (a.resource === 'purchase-orders') return [one, 'POST']; // void action
    if (a.resource === 'estimates') return [one, 'PATCH']; // status change
    return [one, 'DELETE'];
  }
  if (kind === 'update') return [one, a.resource === 'invoices' || a.resource === 'payments' || a.resource === 'sales-receipts' || a.resource === 'credit-memos' ? 'PUT' : 'PATCH'];
  if (kind === 'delete') return [one, 'PATCH'];
  // void: a copy is a create (purchase orders are reopened in place)
  return a.resource === 'purchase-orders' ? [one, 'POST'] : [`/api/${a.resource}`, 'POST'];
}

function requireUser(ctx: ServiceContext): string {
  if (!ctx.userId) throw new ServiceError('FORBIDDEN', 'Sign in to use Undo.');
  return ctx.userId;
}

function assertKind(a: Adapter, kind: string): asserts kind is UndoKind {
  if (!UNDO_KINDS.includes(kind as UndoKind)) throw validation(`Unknown undo kind "${kind}".`);
  if (kind === 'void' && !a.undoVoid) throw validation(`A ${a.noun} can't be voided.`);
  if (kind === 'delete' && !a.undoDelete) throw validation(`A ${a.noun} is voided, not deleted.`);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertId(id: unknown, what = 'record'): asserts id is string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw validation(`That ${what} id is not valid.`);
}

// ---------------------------------------------------------------------------
// prepare / commit
// ---------------------------------------------------------------------------

export interface PreparedUndo {
  token: string;
}

/**
 * Snapshot a record BEFORE an update / void / delete. Returns a pending token the client passes
 * to commitUndo once the save succeeded. Read-only for the books (the token row is the only write).
 */
export async function prepareUndo(
  ctx: ServiceContext,
  input: { resource: string; kind: string; id: string },
): Promise<PreparedUndo> {
  const userId = requireUser(ctx);
  const a = adapterFor(input.resource);
  assertKind(a, input.kind);
  if (input.kind === 'create') throw validation('A new record needs no snapshot; commit it after saving.');
  assertId(input.id);
  assertRoutePermission(ctx, `/api/${a.resource}/${input.id}`, 'GET');
  const snap = await a.snapshot(ctx, input.id);
  await pruneOld(ctx);
  const [row] = await ctx.db
    .insert(undoActions)
    .values({
      companyId: ctx.companyId,
      userId,
      entityType: a.entity,
      entityId: input.id,
      kind: input.kind,
      status: 'pending',
      label: a.describe(snap),
      snapshot: snap,
    })
    .returning({ id: undoActions.id });
  return { token: row.id };
}

async function pruneOld(ctx: ServiceContext): Promise<void> {
  await ctx.db
    .delete(undoActions)
    .where(and(eq(undoActions.companyId, ctx.companyId), lt(undoActions.createdAt, new Date(Date.now() - PRUNE_AFTER_MS))));
}

/** True when the newest audit-trail row for the record was written by someone else. */
async function lastChangedByOther(ctx: ServiceContext, entity: string, id: string, userId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ userId: auditLogs.userId })
    .from(auditLogs)
    .where(and(eq(auditLogs.companyId, ctx.companyId), eq(auditLogs.entityType, entity), eq(auditLogs.entityId, id)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  return Boolean(row && row.userId !== userId);
}

/** Newest audit-trail row for the record written by this user at/after `since`. */
async function auditSince(
  ctx: ServiceContext,
  entity: string,
  id: string,
  userId: string,
  since: Date,
  actions?: string[],
) {
  const conds = [
    eq(auditLogs.companyId, ctx.companyId),
    eq(auditLogs.entityType, entity),
    eq(auditLogs.entityId, id),
    eq(auditLogs.userId, userId),
    gte(auditLogs.createdAt, since),
  ];
  if (actions?.length) conds.push(inArray(auditLogs.action, actions as never[]));
  const [row] = await ctx.db
    .select()
    .from(auditLogs)
    .where(and(...conds))
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  return row ?? null;
}

export interface ArmedUndo {
  token: string;
  label: string;
  kind: UndoKind;
  /** ISO time after which the server refuses the undo. */
  expiresAt: string;
  /** Plain-language toast text, e.g. "Invoice INV-1001 saved." */
  message: string;
}

const VERB: Record<UndoKind, string> = { create: 'saved', update: 'changed', void: 'voided', delete: 'made inactive' };

/**
 * Arm an undo once the action succeeded. For update / void / delete pass the token from
 * prepareUndo; for a create pass the new record's id (or nothing: the newest record of that
 * type this user created in the last few seconds is used — only when no id is supplied; a
 * supplied id that this user did not just create is refused, never swapped for another record). The audit trail must show that THIS
 * user changed the record after the snapshot — otherwise nothing is armed.
 */
export async function commitUndo(
  ctx: ServiceContext,
  input: { resource: string; kind: string; token?: string | null; id?: string | null },
): Promise<ArmedUndo> {
  const userId = requireUser(ctx);
  const a = adapterFor(input.resource);
  assertKind(a, input.kind);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + UNDO_WINDOW_MS);
  const notDone = () =>
    new ServiceError('CONFLICT', `There is nothing to undo: the ${a.noun} was not changed by you just now.`);

  if (input.kind === 'create') {
    const supplied = input.id !== undefined && input.id !== null && input.id !== '';
    let id = supplied && typeof input.id === 'string' && UUID_RE.test(input.id) ? input.id : null;
    const recent = new Date(Date.now() - CREATE_MATCH_MS);
    // An id was given but it is not a record this user just created (a wrong nested id, or two
    // quick saves): never guess another record — offering to undo something else is worse than
    // offering nothing.
    if (supplied && !id) throw notDone();
    let created = id ? await auditSince(ctx, a.entity, id, userId, recent, ['create']) : null;
    if (supplied && !created) throw notDone();
    if (!supplied) {
      // No id in the response: use the newest record of this type the user created a moment ago.
      const [row] = await ctx.db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.companyId, ctx.companyId),
            eq(auditLogs.entityType, a.entity),
            eq(auditLogs.userId, userId),
            eq(auditLogs.action, 'create'),
            gte(auditLogs.createdAt, recent),
          ),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(1);
      created = row ?? null;
      id = row?.entityId ?? null;
    }
    if (!created || !id) throw notDone();
    // Someone else already changed the new record: undoing would throw their work away.
    if (await lastChangedByOther(ctx, a.entity, id, userId)) throw notDone();
    const snap = await a.snapshot(ctx, id);
    const version = await currentVersion(ctx, a.entity, id);
    await pruneOld(ctx);
    const label = a.describe(snap);
    const [row] = await ctx.db
      .insert(undoActions)
      .values({
        companyId: ctx.companyId,
        userId,
        entityType: a.entity,
        entityId: id,
        kind: 'create',
        status: 'armed',
        label,
        snapshot: snap,
        afterVersion: version,
        armedAt: now,
        expiresAt,
      })
      .returning({ id: undoActions.id });
    return { token: row.id, label, kind: 'create', expiresAt: expiresAt.toISOString(), message: `${cap(label)} ${VERB.create}.` };
  }

  assertId(input.token, 'undo');
  const [tok] = await ctx.db
    .select()
    .from(undoActions)
    .where(and(eq(undoActions.id, input.token), eq(undoActions.companyId, ctx.companyId)));
  if (!tok || tok.userId !== userId) throw notFound('Undo');
  if (tok.status !== 'pending' || tok.kind !== input.kind || tok.entityType !== a.entity) throw notDone();
  let entityId = tok.entityId!;
  const audit = await auditSince(ctx, a.entity, entityId, userId, tok.createdAt);
  if (!audit || (await lastChangedByOther(ctx, a.entity, entityId, userId))) throw notDone();
  // Editing a journal entry replaces it with a new entry (lib/services/journal.ts updateEntry).
  if (a.entity === 'journal_entry' && input.kind === 'update') {
    const replacedBy = (audit.newValues as { replacedBy?: unknown } | null)?.replacedBy;
    if (typeof replacedBy === 'string') entityId = replacedBy;
  }
  const version = await currentVersion(ctx, a.entity, entityId);
  const [armed] = await ctx.db
    .update(undoActions)
    .set({ status: 'armed', entityId, afterVersion: version, armedAt: now, expiresAt })
    .where(and(eq(undoActions.id, tok.id), eq(undoActions.status, 'pending')))
    .returning();
  if (!armed) throw notDone();
  const label = tok.label ?? a.noun;
  return {
    token: tok.id,
    label,
    kind: input.kind,
    expiresAt: expiresAt.toISOString(),
    message: `${cap(label)} ${VERB[input.kind]}.`,
  };
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------
// performUndo
// ---------------------------------------------------------------------------

export interface UndoResult extends UndoOutcome {
  token: string;
  entityType: string;
  entityId: string | null;
  kind: UndoKind;
}

async function userName(ctx: ServiceContext, id: string | null): Promise<string | null> {
  if (!id) return null;
  const [u] = await ctx.db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, id));
  return u ? u.name || u.email : null;
}

/** Undo an armed action. See the module comment for every rule it enforces. */
export async function performUndo(ctx: ServiceContext, token: string): Promise<UndoResult> {
  const userId = requireUser(ctx);
  assertId(token, 'undo');
  const [tok] = await ctx.db
    .select()
    .from(undoActions)
    .where(and(eq(undoActions.id, token), eq(undoActions.companyId, ctx.companyId)));
  if (!tok) throw notFound('Undo');
  if (tok.userId !== userId) {
    throw new ServiceError('FORBIDDEN', 'Only the person who made this change can undo it.');
  }
  if (tok.status === 'undone') throw new ServiceError('CONFLICT', 'This change was already undone.');
  if (tok.status !== 'armed') throw new ServiceError('CONFLICT', 'This change can’t be undone.');
  if (!tok.expiresAt || tok.expiresAt.getTime() < Date.now()) {
    throw new ServiceError(
      'CONFLICT',
      'Too late to undo: Undo is available for 30 seconds after a change. Open the record to change it back by hand.',
    );
  }
  const a = Object.values(ADAPTERS).find((x) => x.entity === tok.entityType);
  if (!a || !tok.entityId) throw new ServiceError('CONFLICT', 'This change can’t be undone.');
  const kind = tok.kind as UndoKind;
  const entityId = tok.entityId;
  const [path, method] = inversePermission(a, kind, entityId);
  assertRoutePermission(ctx, path, method);
  // Accountant's Copy (accountant side): only undo what the copy could have saved itself.
  await assertAccountantCopyAllowsPath(ctx.db, ctx.companyId, path);

  const result = await inTransaction(ctx, async (tx) => {
    // Claim the token first: a second click (or a second tab) finds nothing to claim.
    const [claimed] = await tx.db
      .update(undoActions)
      .set({ status: 'undone', undoneAt: new Date() })
      .where(and(eq(undoActions.id, tok.id), eq(undoActions.status, 'armed')))
      .returning();
    if (!claimed) throw new ServiceError('CONFLICT', 'This change was already undone.');

    // Record locking: refuse when anyone (including this user) changed the record since.
    const version = await currentVersion(tx, a.entity, entityId);
    if (!version && tok.afterVersion) throw new ServiceError('CONFLICT', `Can't undo: the ${a.noun} no longer exists.`);
    if (tok.afterVersion && version && version.getTime() !== tok.afterVersion.getTime()) {
      const [last] = await tx.db
        .select({ userId: auditLogs.userId, at: auditLogs.createdAt })
        .from(auditLogs)
        .where(and(eq(auditLogs.companyId, tx.companyId), eq(auditLogs.entityType, a.entity), eq(auditLogs.entityId, entityId)))
        .orderBy(desc(auditLogs.createdAt))
        .limit(1);
      const who = last?.userId === userId ? 'you' : ((await userName(tx, last?.userId ?? null)) ?? 'someone else');
      throw new ServiceError(
        'CONFLICT',
        `Can't undo: this ${a.noun} was changed again by ${who} after your change, so undoing could overwrite that. Open it to check and change it by hand.`,
        { staleUndo: true },
      );
    }

    const before = (tok.snapshot ?? {}) as Snap;
    let outcome: UndoOutcome;
    if (kind === 'create') outcome = await a.undoCreate(tx, entityId, before);
    else if (kind === 'update') outcome = await a.restore(tx, entityId, before, await a.snapshot(tx, entityId));
    else if (kind === 'void') outcome = await a.undoVoid!(tx, entityId, before);
    else outcome = await a.undoDelete!(tx, entityId, before);

    await tx.db.update(undoActions).set({ result: outcome as never }).where(eq(undoActions.id, tok.id));
    await writeAudit(tx, {
      action: 'update',
      entityType: 'undo',
      entityId: tok.id,
      oldValues: { kind, entityType: a.entity, entityId, label: tok.label },
      newValues: { undone: true, ...outcome },
    });
    return outcome;
  });

  return { token: tok.id, entityType: a.entity, entityId, kind, ...result };
}
