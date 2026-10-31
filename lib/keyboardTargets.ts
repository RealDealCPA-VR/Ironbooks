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
import { activeListRow, listRows, pickShortcutButton } from './shortcuts';

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

// ---------------------------------------------------------------------------
// QuickBooks' Tab order on transaction forms
// ---------------------------------------------------------------------------

/**
 * Marks a transaction form whose Tab order follows QuickBooks (components/KeyboardBase.tsx moves
 * the focus): name → class → template → date → number → the other header fields → the lines →
 * the fields under them → memo → Save & Close → Save & New → the other buttons. Put it anywhere
 * in the form (inside a dialog it orders the whole dialog). The form's own layout is not
 * changed; fields keep their places on screen.
 *
 * Forms whose QuickBooks header order is different (Write Checks: Bank Account → No. → Date →
 * Pay to the Order of; Receive Payments: Received From → Amount → Date → Method → Check # →
 * Memo) give it as the attribute's value — field ids, in order — instead of the name / class /
 * template / date / number rule.
 */
export const QB_TAB_ORDER_ATTR = 'data-qb-tab-order';

/** A header field QuickBooks puts in a fixed place in the Tab order. */
export type QbFieldRole = 'name' | 'class' | 'template' | 'date' | 'number' | 'memo';

/** The order of the header roles (memo is placed separately). */
export const QB_HEADER_ROLES: readonly QbFieldRole[] = ['name', 'class', 'template', 'date', 'number'];

/** A field label as the role rules read it: no "*", "(optional)", trailing colon or extra spaces. */
export function normalizeFieldLabel(label: string): string {
  return label
    .replace(/\*/g, ' ')
    .replace(/\((optional|required)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s:?]+$/, '')
    .trim();
}

const NAME_LABEL = /^(customer(\s*:\s*job|\s*\/\s*job| or job)?|vendor|payee|pay to the order of|received from|employee|name)$/i;
const NOT_THE_TRANSACTION_DATE = /^(due|expir|expect|ship|revers|deliver|discount|start|end|from|to|bill due|paid)/i;
const NUMBER_LABEL = /(#|\bno\.?|\bnumber|\bnum\.?|\bref\.?|\breference)(\s|$|\/)|#$/i;

/**
 * The QuickBooks role of a form field, from its label, its input type and whether it is a
 * document-number field (data-doc-number); null for every other field.
 */
export function qbFieldRole(field: { label: string; type?: string; docNumber?: boolean; tag?: string }): QbFieldRole | null {
  const label = normalizeFieldLabel(field.label);
  const type = (field.type ?? '').toLowerCase();
  if (field.docNumber) return 'number';
  if (/^memo\b/i.test(label)) return 'memo';
  if (/^class\b/i.test(label)) return 'class';
  if (/^(form )?template\b/i.test(label)) return 'template';
  if (type === 'date') return !label || (/date/i.test(label) && !NOT_THE_TRANSACTION_DATE.test(label)) ? 'date' : null;
  if (NAME_LABEL.test(label)) return 'name';
  if (type !== 'checkbox' && type !== 'radio' && NUMBER_LABEL.test(label)) return 'number';
  return null;
}

/** The text that labels a field: aria-label, aria-labelledby, its <label>, else its placeholder. */
export function fieldLabelText(el: HTMLElement): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const text = by
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    if (text) return text;
  }
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length) return labels[0].textContent ?? '';
  return el.getAttribute('placeholder') ?? '';
}

const isFieldEl = (el: HTMLElement) => el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA';
const LINES = '[data-grid-row], [data-list], [data-qb-lines]';

/**
 * The Tab order of a QuickBooks transaction form (QB_TAB_ORDER_ATTR) inside `root` — the dialog,
 * or the marked form on a page:
 *
 *   1. what comes before the first header role (the toolbar, a dialog's close button)
 *   2. name, class, template, date, number — each the first such field above the lines
 *   3. the other header fields and buttons, in page order (a memo the form shows above its lines,
 *      as QuickBooks' checks and bills do, stays here)
 *   4. the lines, in page order
 *   5. the fields under the lines, in page order, then a memo shown under the lines
 *   6. Save & Close, Save & New, then the other buttons after the last field (Cancel, Print, …)
 */
export function qbTabOrder(root: HTMLElement): HTMLElement[] {
  const all = tabbables(root);
  const inLines = all.map((el) => !!el.closest(LINES));
  const firstLine = inLines.indexOf(true);
  const lastLine = inLines.lastIndexOf(true);
  const headerEnd = firstLine >= 0 ? firstLine : all.length;
  let lastField = -1;
  all.forEach((el, i) => {
    if (isFieldEl(el)) lastField = i;
  });

  // Roles above the lines (the first field of each; the form's own document number — a
  // data-doc-number field — before any other "#" field, such as the customer's P.O. No.).
  const roleOf = new Map<HTMLElement, QbFieldRole>();
  const taken = new Set<QbFieldRole>();
  const docNumber = all.find((el, i) => !inLines[i] && i < headerEnd && el.hasAttribute('data-doc-number'));
  if (docNumber) {
    roleOf.set(docNumber, 'number');
    taken.add('number');
  }
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    if (!isFieldEl(el) || inLines[i] || roleOf.has(el)) continue;
    const role = qbFieldRole({
      label: fieldLabelText(el),
      type: (el as HTMLInputElement).type,
      docNumber: el.hasAttribute('data-doc-number'),
      tag: el.tagName,
    });
    if (!role || taken.has(role)) continue;
    // Above the lines only, except a memo (QuickBooks puts it under the lines on sales forms).
    if (role !== 'memo' && i >= headerEnd) continue;
    taken.add(role);
    roleOf.set(el, role);
  }
  const memo = [...roleOf].find(([, r]) => r === 'memo')?.[0] ?? null;
  const memoBelow = memo !== null && firstLine >= 0 && all.indexOf(memo) > lastLine;

  const header = all.slice(0, headerEnd);
  // The form's own header order (field ids), else QuickBooks' name / class / template / date / number.
  const marker = root.matches(`[${QB_TAB_ORDER_ATTR}]`) ? root : root.querySelector(`[${QB_TAB_ORDER_ATTR}]`);
  const explicit = (marker?.getAttribute(QB_TAB_ORDER_ATTR) ?? '').trim();
  const roleEls = explicit
    ? explicit
        .split(/\s+/)
        .map((id) => root.ownerDocument.getElementById(id))
        .filter((el): el is HTMLElement => !!el && header.includes(el) && !(memoBelow && el === memo))
    : QB_HEADER_ROLES.map((r) => [...roleOf].find(([, role]) => role === r)?.[0]).filter((el): el is HTMLElement => !!el);
  const firstRoleAt = roleEls.length ? Math.min(...roleEls.map((el) => all.indexOf(el))) : headerEnd;
  const before = header.slice(0, firstRoleAt).filter((el) => !roleEls.includes(el));
  const restHeader = header.slice(firstRoleAt).filter((el) => !roleEls.includes(el));
  const lines = firstLine >= 0 ? all.slice(firstLine, lastLine + 1) : [];

  // After the lines: fields (and buttons among them) up to the last field, then the trailing buttons.
  const afterStart = firstLine >= 0 ? lastLine + 1 : headerEnd;
  const tailStart = Math.max(afterStart, lastField + 1);
  const middle = all.slice(afterStart, tailStart).filter((el) => !(memoBelow && el === memo));
  const tail = all.slice(tailStart);
  const descs = tail.map((el) => ({
    label:
      (el.getAttribute('aria-label') || el.textContent || (el as HTMLInputElement).value || el.getAttribute('title') || '').trim(),
    shortcut: el.getAttribute('data-shortcut'),
    disabled: (el as HTMLButtonElement).disabled === true,
  }));
  const saveClose = pickShortcutButton(descs, 'save-close');
  const saveNewRaw = pickShortcutButton(descs, 'save-new');
  const saveNew = saveNewRaw === saveClose ? -1 : saveNewRaw;
  const saves = [saveClose, saveNew].filter((i) => i >= 0).map((i) => tail[i]);
  const otherTail = tail.filter((el) => !saves.includes(el));

  return [...before, ...roleEls, ...restHeader, ...lines, ...middle, ...(memoBelow && memo ? [memo] : []), ...saves, ...otherTail];
}

/**
 * Where Tab (1) or Shift+Tab (-1) goes from `from` on a QuickBooks-ordered form, or undefined
 * when `from` is not on one. Null at either end of a page form (the browser moves on); a dialog
 * wraps around.
 */
export function qbTabStop(from: HTMLElement, dir: 1 | -1): HTMLElement | null | undefined {
  const marker = from.closest(`[${QB_TAB_ORDER_ATTR}]`) as HTMLElement | null;
  const dialog = from.closest('[role="dialog"][aria-modal="true"]') as HTMLElement | null;
  const root = dialog && dialog.querySelector(`[${QB_TAB_ORDER_ATTR}]`) ? dialog : marker;
  if (!root) return undefined;
  const order = qbTabOrder(root);
  const i = order.indexOf(from);
  if (i < 0) return undefined;
  const j = i + dir;
  if (j >= 0 && j < order.length) return order[j];
  return dialog ? (order[(j + order.length) % order.length] ?? null) : null;
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
