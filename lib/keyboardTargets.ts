/**
 * What a QuickBooks key acts on, read from the page: the selected list row, the open form, the
 * list that has focus. Shared by components/KeyboardCommands.tsx (Ctrl+E / D / P / Y / H / Q / U /
 * G / O / V), components/AppShell.tsx (Ctrl+R on a highlighted account) and the window keys.
 *
 * Rows say what they are through data attributes, so every list gets the keys without its own code:
 *   data-journal-entry   the journal entry behind the row (Ctrl+Y / Ctrl+H)
 *   data-quick-report    the QuickReport link for the name or account (Ctrl+Q)
 *   data-register        the account's register (Ctrl+R / Ctrl+U on the Chart of Accounts)
 *   data-use-href        what "use the list item" (Ctrl+U) opens for the row
 *   data-transfer-href   the register of the transaction's other account (Ctrl+G in a register)
 *   data-copy-transaction  JSON of a register transaction Ctrl+O copies
 */
import { activeListRow, listRows } from './shortcuts';

const DIALOG = '[role="dialog"][aria-modal="true"], [role="alertdialog"]';

/** The open modal dialog in use: the one holding focus, else the last one on the page; or null. */
export function openDialog(doc: Document = document): HTMLElement | null {
  const focused = (doc.activeElement as HTMLElement | null)?.closest?.(DIALOG) as HTMLElement | null;
  if (focused) return focused;
  const dialogs = Array.from(doc.querySelectorAll<HTMLElement>(DIALOG));
  return dialogs.length ? dialogs[dialogs.length - 1] : null;
}

/** Focus is on the page itself (nothing focused), not on a control. */
export function onPageBody(target: HTMLElement | null): boolean {
  return !target || target === document.body || target === document.documentElement || target.tagName === 'MAIN';
}

/** The page's first list that has rows (outside dialogs). */
export function firstList(): HTMLElement | null {
  const main = document.querySelector('main') ?? document.body;
  return (
    Array.from(main.querySelectorAll<HTMLElement>('[data-list]')).find(
      (l) => !l.closest('[role="dialog"]') && listRows(l).length > 0,
    ) ?? null
  );
}

/** The list a command acts on: the one holding focus, else (nothing focused, no dialog) the page's first. */
export function currentList(target: HTMLElement | null, dialog: HTMLElement | null): HTMLElement | null {
  const own = target?.closest?.('[data-list]') as HTMLElement | null;
  // A dialog drawn inside a list (a report's QuickZoom window) is not part of that list.
  const box = target?.closest?.('[role="dialog"]');
  if (own && (!box || box.contains(own))) return own;
  return !dialog && onPageBody(target) ? firstList() : null;
}

/** The selected row: the row holding focus (a button in it), else the list's highlighted row. */
export function selectedRow(target: HTMLElement | null, dialog: HTMLElement | null): HTMLElement | null {
  const list = currentList(target, dialog);
  if (!list) return null;
  const own = target?.closest?.('tr') as HTMLElement | null;
  if (own && listRows(list).includes(own)) return own;
  return activeListRow(list);
}

/** The open form: the top dialog, else the form / data-shortcut-scope holding focus. */
export function formScope(target: HTMLElement | null, dialog: HTMLElement | null): HTMLElement | null {
  return dialog ?? (target?.closest?.('form, [data-shortcut-scope]') as HTMLElement | null);
}

const TABBABLE = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';

/** The elements Tab stops on inside `scope`, in page order (visible, enabled, tabIndex >= 0). */
export function tabbables(scope: ParentNode): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => {
    if ((el as HTMLButtonElement).disabled || el.tabIndex < 0) return false;
    if (el instanceof HTMLInputElement && el.type === 'hidden') return false;
    if (el.closest('[inert], [aria-hidden="true"]')) return false;
    return el.getClientRects().length > 0;
  });
}

/**
 * The next (1) or previous (-1) Tab stop after `from`: within its dialog (wrapping, as the
 * dialog's own Tab trap does), else on the page (null at either end, so the browser moves on).
 */
export function nextTabStop(from: HTMLElement, dir: 1 | -1): HTMLElement | null {
  const dialog = from.closest('[role="dialog"][aria-modal="true"]') as HTMLElement | null;
  const list = tabbables(dialog ?? document);
  const i = list.indexOf(from);
  if (i < 0) return null;
  const j = i + dir;
  if (j >= 0 && j < list.length) return list[j];
  return dialog ? list[(j + list.length) % list.length] ?? null : null;
}

/** An attribute of the selected row, or null. */
export function selectedRowAttr(target: HTMLElement | null, dialog: HTMLElement | null, attr: string): string | null {
  return selectedRow(target, dialog)?.getAttribute(attr) || null;
}

// ---------------------------------------------------------------------------
// Ctrl+U on a list row: QuickBooks' "Use" — a new form for that customer, vendor or item
// ---------------------------------------------------------------------------

const AMOUNT_RE = /^\d{1,13}(\.\d{1,4})?$/;

/**
 * The data-use-prefill a list row carries: Ctrl+U opens a new invoice for a customer, a new bill
 * for a vendor, or a new invoice with the item on its first line (with its sales price and
 * description), through the command bar's prefill hand-off (lib/commands/prefill.ts).
 */
export function listItemPrefill(
  use:
    | { customerId: string }
    | { vendorId: string }
    | { item: { id: string; name: string; description?: string | null; salesPrice?: string | null } },
): string {
  if ('customerId' in use) return JSON.stringify({ kind: 'invoice', customerId: use.customerId, lines: [] });
  if ('vendorId' in use) return JSON.stringify({ kind: 'bill', vendorId: use.vendorId, lines: [] });
  const { item } = use;
  const line: Record<string, string> = { itemId: item.id, itemName: item.name.slice(0, 255), quantity: '1' };
  if (item.description) line.description = item.description.slice(0, 1000);
  if (item.salesPrice && AMOUNT_RE.test(item.salesPrice)) line.rate = item.salesPrice;
  return JSON.stringify({ kind: 'invoice', lines: [line] });
}

// ---------------------------------------------------------------------------
// Ctrl+O / Ctrl+V in a register: QuickBooks' Copy Transaction / Paste Transaction
// ---------------------------------------------------------------------------

/** A register transaction as Ctrl+O copies it (rows carry it as data-copy-transaction JSON). */
export interface CopiedTransaction {
  /** Payee / description shown on the row. */
  payee: string;
  /** The other account (a single-account transaction; splits are not copied to the blank line). */
  accountId: string;
  accountLabel: string;
  memo: string;
  /** Which of the register's amount columns it is in. */
  side: 'increase' | 'decrease';
  amount: string;
}

/** Sent on window with the copied transaction for the register's blank line (components/RegisterEntryRow.tsx). */
export const PASTE_TRANSACTION_EVENT = 'ironbooks:paste-transaction';

let copiedTransaction: CopiedTransaction | null = null;

export function setCopiedTransaction(t: CopiedTransaction | null) {
  copiedTransaction = t;
}
export function getCopiedTransaction(): CopiedTransaction | null {
  return copiedTransaction;
}

/** A row's data-copy-transaction, checked; null when it is missing or malformed. */
export function parseCopiedTransaction(raw: string | null): CopiedTransaction | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<CopiedTransaction>;
    if (typeof d.accountId !== 'string' || !d.accountId) return null;
    if (d.side !== 'increase' && d.side !== 'decrease') return null;
    if (typeof d.amount !== 'string' || !/^\d+(\.\d+)?$/.test(d.amount)) return null;
    return {
      payee: typeof d.payee === 'string' ? d.payee : '',
      accountId: d.accountId,
      accountLabel: typeof d.accountLabel === 'string' ? d.accountLabel : '',
      memo: typeof d.memo === 'string' ? d.memo : '',
      side: d.side,
      amount: d.amount,
    };
  } catch {
    return null;
  }
}

/**
 * Where Ctrl+V pastes a copied transaction: the register's blank line, when the cursor is on it
 * and nothing has been typed there yet, or when the register itself (not a field) has the focus.
 * Anywhere else Ctrl+V pastes text as usual.
 */
export function pasteTransactionTarget(target: HTMLElement | null): HTMLElement | null {
  const entry = target?.closest?.('[data-register-entry]') as HTMLElement | null;
  if (entry) return entry.hasAttribute('data-blank') ? entry : null;
  const list = target?.matches?.('[data-list]') ? target : null;
  const inList = list?.querySelector<HTMLElement>('[data-register-entry]');
  return inList && inList.hasAttribute('data-blank') ? inList : null;
}
