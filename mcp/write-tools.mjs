/**
 * The tools that change the books, and the reads that go with them.
 *
 * Every change is one named action sent to Ironbooks (POST /api/agent/actions,
 * lib/agent/catalog.ts). What happens to it is decided there, by the role and the policy an Admin
 * gave the agent (AGENT_ACCESS.md):
 *
 *   - refused:            outside the role, or the policy says Never. Nothing is done.
 *   - posted / done:      the policy says Allow (or a standing permission covers it): entered.
 *   - asked:              the policy says Ask: a person approves or denies it in Ironbooks.
 *                         Nothing is entered until then; wait_for_decision waits for the answer.
 *   - needs_confirmation: Ironbooks raised a warning a person would have been asked about; the
 *                         agent may send it again with the matching flag.
 *   ('proposed' is the older word for 'asked', still answered for requests made before.)
 *
 * Two arguments are the same on every one of these tools:
 *
 *   - `dry_run: true` really runs the change inside Ironbooks and rolls it back. The answer shows
 *     the ledger lines it would post, or the reason it would be refused. Nothing is kept.
 *   - `request_id` is the agent's own name for this one change. It is needed for anything that is
 *     kept. Asking again with the same request_id returns the first answer and never enters the
 *     change twice, so a retry after a timeout is always safe.
 *
 * Field names are the tool's own (snake_case) and are turned into the app's on the way out.
 */
import { ToolError } from './protocol.mjs';

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', patternHint: 'must be a date as YYYY-MM-DD' };
const ID = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', patternHint: 'must be an id returned by another tool' };
const MONEY = { type: 'string', pattern: '^\\d{1,13}(\\.\\d{1,2})?$', patternHint: 'must be an amount like 1250.00 (text, at most 2 decimals)' };
const QTY = { type: 'string', pattern: '^-?\\d{1,13}(\\.\\d{1,6})?$', patternHint: 'must be a number like 2 or 1.5 (as text)' };
const TEXT = (max, description) => ({ type: 'string', maxLength: max, description });
const METHODS = ['cash', 'check', 'credit_card', 'ach', 'bank_transfer', 'other'];

export const TRANSACTION_TYPES = ['journal_entry', 'invoice', 'sales_receipt', 'payment', 'bill', 'bill_payment', 'check', 'deposit', 'transfer'];
export const LIST_TYPES = ['customer', 'vendor', 'account', 'item'];

const DRY_RUN = { type: 'boolean', description: 'true: check it and show what it would post, without entering anything. Do this first when you are not sure.' };
const REQUEST_ID = {
  type: 'string',
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:\\-]{2,119}$',
  patternHint: 'must be 3 to 120 letters, digits, dots, dashes, colons or underscores',
  description:
    'Your own name for this one change, for example "bill-acme-2026-03-08". Required unless dry_run is true. Asking again with the same request_id returns the first answer and never enters the change twice; use a new one for each new change.',
};
const EXPECTED = { type: 'string', maxLength: 40, description: 'The updated_at you got when you last read this record. If someone changed it since, the change is refused instead of overwriting theirs.' };

/** `customer_id` → `customerId`, at every depth. Values are left as they are. */
export function camelize(v) {
  if (Array.isArray(v)) return v.map(camelize);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined || val === null) continue;
      out[k.replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase())] = camelize(val);
    }
    return out;
  }
  return v;
}

/** The ledger lines of an answer, compact: one entry per posting, debits first. */
function ledgerOf(answer) {
  const source = answer?.ledger ?? answer?.preview?.ledger;
  const entries = Array.isArray(source?.entries) ? source.entries : [];
  return entries.map((e) => ({
    journal_entry_id: e.journalEntryId,
    date: e.date,
    description: e.description ?? null,
    lines: (e.lines ?? []).map((l) => ({ account: [l.accountCode, l.accountName].filter(Boolean).join(' '), debit: l.debit ?? null, credit: l.credit ?? null, ...(l.memo ? { memo: l.memo } : {}) })),
  }));
}

/** What each outcome means for the agent, in one line. */
const SAID = {
  posted: 'Entered.',
  done: 'Done. Nothing was posted to the ledger.',
  proposed: 'Not entered. Waiting for a person to approve it in Ironbooks.',
  dry_run: 'Not entered. This is what it would do.',
  asked: 'Not done yet. A person must approve it in Ironbooks first.',
  needs_confirmation: 'Not done. Ironbooks raised a warning that a person would have been asked about.',
  refused: 'Refused. Nothing was done.',
};

/** Outcomes where nothing happened yet, so a preview shows what WOULD happen. */
const NOT_YET = new Set(['dry_run', 'asked', 'needs_confirmation']);

/** `allowDuplicateNumber` → `allow_duplicate_number`: the named tools' word for a flag. */
export const snakeFlag = (/** @type {string} */ flag) => flag.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const SECRET_WORDS = {
  closing_password: 'the closing-date password',
  file_password: 'the company file password',
  backup_password: "the backup file's password",
  archive_credentials: "the archive's password",
  new_user_password: "the new user's password",
  mail_password: 'the mail password',
  portal_password: 'the portal password',
  recovery_key: 'the recovery key',
  file_key: 'the file key',
  capability_link: 'the private link',
};
const FLAG_WORDS = {
  sensitivePayroll: 'see sensitive payroll data',
  fullAccountNumbers: 'see full account numbers',
  closedPeriod: 'work in the closed period',
};

/**
 * Who must approve a request, in plain words (lib/agent/operations/types.ts ApprovalNeeds).
 * @param {any} needs
 * @returns {string | null}
 */
export function whoDecides(needs) {
  if (!needs || typeof needs !== 'object') return null;
  const who = needs.fileAdmin ? 'The Admin of the company file' : needs.admin ? 'An Admin' : 'A person who may do this themselves';
  const flags = [...new Set([...(Array.isArray(needs.flags) ? needs.flags : []), ...(needs.flag ? [needs.flag] : [])])].map((f) => FLAG_WORDS[f] ?? f);
  let out = `${who}${flags.length ? ` and may ${flags.join(' and ')}` : ''} must approve it${needs.hostOnly ? ', at the computer that holds the company file' : ''}.`;
  if (needs.twoPerson) out += ' Two different people must approve it.';
  const secrets = Array.isArray(needs.secrets) ? needs.secrets.map((s) => SECRET_WORDS[s] ?? 'a password') : [];
  if (secrets.length) out += ` They type ${secrets.join(' and ')} on their own screen; you never see it, and must not ask for it.`;
  return out;
}

/**
 * How to send a warning's flag again with this tool. `fields`: the tool's own field names (the
 * named tools), or 'confirm' for run_operation.
 */
function resendWith(flag, operation, fields) {
  if (fields === 'confirm') return `confirm: ["${flag}"]`;
  const field = snakeFlag(flag);
  if (Array.isArray(fields) && fields.includes(field)) return `${field}: true`;
  return operation ? `run_operation with operation "${operation}" and confirm: ["${flag}"]` : `the flag ${flag}`;
}

const MAX_PREVIEW_ROWS = 50;

/**
 * What Ironbooks said about a change, in the words an agent can act on: what happened, what would
 * happen (a preview), and what to do next.
 * @param {any} answer  lib/agent/contract.ts AgentOperationAnswer (or the older AgentActionAnswer)
 * @param {{ fields?: string[] | 'confirm' }} [opts]  how a warning's flag is sent again
 */
export function shapeAnswer(answer, opts = {}) {
  const a = answer ?? {};
  const ledger = ledgerOf(a);
  const said = SAID[a.outcome];
  const notYet = NOT_YET.has(a.outcome);
  const preview = a.preview && typeof a.preview === 'object' ? a.preview : null;
  const warnings = (Array.isArray(a.warnings) && a.warnings.length ? a.warnings : Array.isArray(preview?.warnings) ? preview.warnings : []).filter((w) => w && w.flag);
  const effects = Array.isArray(preview?.effects) ? preview.effects : [];
  const records = Array.isArray(preview?.records) ? preview.records : [];
  const done = Array.isArray(a.effects) ? a.effects : [];
  const who = a.outcome === 'asked' ? whoDecides(a.needs) : null;
  const file = a.file && a.file.fileId ? { file_id: a.file.fileId, name: a.file.name, type: a.file.type, size: a.file.size } : null;

  let next;
  if (a.outcome === 'asked') {
    next = a.requestId
      ? `Call wait_for_decision with request_id "${a.requestId}" to wait for the person's answer. Do not send this request again: it is already waiting.`
      : 'list_my_requests shows this request and, later, what the person decided. Do not send it again.';
  } else if (a.outcome === 'proposed') {
    next = 'A person decides in Ironbooks. list_my_requests shows what they decided.';
  } else if (a.outcome === 'needs_confirmation') {
    next =
      'Check each warning. Only if it is right to go ahead, send the same request again with what resend_with says and a NEW request_id; a request sent with a confirmation may need a person to approve it. Otherwise stop and tell the person about the warning.';
  } else if (a.outcome === 'refused') {
    next = 'Do not send it again as it is. get_my_permissions shows what you may do; if the work still needs doing, tell the person what you wanted to do and why.';
  } else if (file) {
    next = `Call get_file with file_id "${file.file_id}" to read the file it made.`;
  }

  return {
    outcome: a.outcome,
    ...(said ? { said } : {}),
    ...(a.replayed ? { repeated: true, note_repeat: 'This request_id was already handled; this is its first answer. Nothing was entered again.' } : {}),
    ...(a.summary ? { summary: a.summary } : {}),
    ...(a.result !== undefined ? { result: a.result } : {}),
    ...(a.proposalId ? { proposal_id: a.proposalId } : {}),
    ...(a.requestId && (a.outcome === 'asked' || a.outcome === 'proposed') ? { request_id: a.requestId } : {}),
    ...(a.status && a.outcome === 'asked' ? { status: a.status } : {}),
    ...(who ? { who_decides: who } : {}),
    ...(notYet ? (a.outcome === 'dry_run' || ledger.length ? { would_post: ledger } : {}) : ledger.length ? { ledger } : {}),
    ...(records.length
      ? { [notYet ? 'would_change' : 'changed']: records.slice(0, MAX_PREVIEW_ROWS).map((r) => ({ kind: r.kind, id: r.id, action: r.action, fields: r.fields })) }
      : {}),
    ...(effects.length ? { [notYet ? 'would_also' : 'also']: effects.map((e) => e.summary) } : {}),
    ...(done.length ? { also_done: done.map((r) => ({ what: r.effect?.summary ?? null, status: r.status, ...(r.error ? { error: r.error } : {}) })) } : {}),
    ...(preview?.loss ? { loss: preview.loss } : {}),
    ...(preview?.routePreview !== undefined && preview?.routePreview !== null ? { route_preview: preview.routePreview } : {}),
    ...(preview?.truncated || records.length > MAX_PREVIEW_ROWS ? { preview_cut_short: true } : {}),
    ...(warnings.length ? { warnings: warnings.map((w) => ({ flag: w.flag, message: w.message, resend_with: resendWith(w.flag, a.operation, opts.fields) })) } : {}),
    ...(file ? { file } : {}),
    ...(a.grantId ? { under_standing_permission: a.grantId } : {}),
    ...(a.note ? { note: a.note } : {}),
    ...(next ? { next } : {}),
  };
}

/**
 * shapeAnswer, except that a refusal is a tool error: the agent reads why, and that nothing was done.
 * @param {any} answer
 * @param {{ fields?: string[] | 'confirm' }} [opts]
 */
export function settle(answer, opts = {}) {
  const shaped = shapeAnswer(answer, opts);
  if (shaped.outcome !== 'refused') return shaped;
  const why = typeof shaped.note === 'string' && shaped.note.trim() ? shaped.note.trim() : 'Ironbooks did not allow this.';
  throw new ToolError(`Refused: ${/[.!?]$/.test(why) ? why : `${why}.`} Nothing was done. ${shaped.next}`);
}

function schema(properties, required = []) {
  return { type: 'object', properties: { ...properties, dry_run: DRY_RUN, request_id: REQUEST_ID }, required, additionalProperties: false };
}

/**
 * Send one change. `input` is already in the app's field names. `fields`: the tool's own field
 * names, so a warning can say which of them sends its confirmation.
 */
async function send(client, action, input, args, fields) {
  if (args.dry_run !== true && !args.request_id) {
    throw new ToolError('Give a request_id (your own name for this one change), or set dry_run to true to only check it.');
  }
  return settle(await client.act({ action, input, ...(args.dry_run === true ? { dryRun: true } : { requestId: args.request_id }) }), { fields });
}

/** A tool that enters one new record. `rename` maps tool fields whose app name is not the camelCase of theirs. */
function enterTool({ name, title, description, action, properties, required, rename = {}, destructive = false }) {
  return {
    name,
    title,
    description,
    changes: true,
    destructive,
    inputSchema: schema(properties, required),
    handler: (args, client) => {
      const { dry_run: _d, request_id: _r, ...rest } = args;
      const input = camelize(rest);
      for (const [from, to] of Object.entries(rename)) {
        if (input[from] !== undefined) {
          input[to] = input[from];
          delete input[from];
        }
      }
      return send(client, action, input, args, Object.keys(properties));
    },
  };
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

const NAME_ON_LINE = {
  entity_type: { type: 'string', enum: ['customer', 'vendor', 'employee', 'other'], description: 'What kind of name is on this line. Required, with entity_id, on Accounts Receivable (customer) and Accounts Payable (vendor) lines.' },
  entity_id: { ...ID, description: 'The id of that customer, vendor, employee or other name.' },
};
const JOURNAL_LINE = {
  type: 'object',
  additionalProperties: false,
  required: ['account_id'],
  properties: {
    account_id: { ...ID, description: 'The account (from list_accounts).' },
    debit: { ...MONEY, description: 'Debit amount. Give either debit or credit on a line, never both.' },
    credit: { ...MONEY, description: 'Credit amount.' },
    memo: TEXT(500, 'Memo for this line.'),
    class_id: { ...ID, description: 'Class, if the company tracks classes.' },
    ...NAME_ON_LINE,
  },
};
const SALES_LINE = {
  type: 'object',
  additionalProperties: false,
  required: ['quantity'],
  properties: {
    item_id: { ...ID, description: 'The item sold (from list_items). Give an item, or an income account.' },
    account_id: { ...ID, description: 'The income account, when no item is given.' },
    description: TEXT(500, 'What was sold.'),
    quantity: { ...QTY, description: 'Quantity, as text ("1", "2.5").' },
    rate: { ...QTY, description: 'Price each. Leave out to use the item\'s own price.' },
    taxable: { type: 'boolean', description: 'Whether sales tax applies to this line.' },
    class_id: { ...ID, description: 'Class, if used.' },
  },
};
const COST_LINE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    account_id: { ...ID, description: 'The expense (or asset) account. Give an account, or an item.' },
    item_id: { ...ID, description: 'An item bought, instead of an account.' },
    description: TEXT(500, 'What it was for.'),
    amount: { ...MONEY, description: 'The amount of this line (for an account line).' },
    quantity: { ...QTY, description: 'Quantity (for an item line).' },
    unit_cost: { ...QTY, description: 'Cost each (for an item line).' },
    class_id: { ...ID, description: 'Class, if used.' },
    customer_id: { ...ID, description: 'A customer or job this cost is for, if any.' },
  },
};

// ---------------------------------------------------------------------------
// Entering
// ---------------------------------------------------------------------------

const ENTER = [
  enterTool({
    name: 'enter_journal_entry',
    title: 'Enter a journal entry',
    action: 'enter_journal_entry',
    description:
      'Enter a general journal entry: two or more lines whose debits equal their credits. Use it for adjusting entries, accruals, depreciation and corrections, not for everyday documents (use enter_invoice, enter_bill, write_check… for those, so customers, vendors and checks stay right). Lines on Accounts Receivable or Accounts Payable must name the customer or vendor. Nothing dated on or before the closing date can be entered.',
    required: ['date', 'description', 'lines'],
    properties: {
      date: { ...DATE, description: 'The entry date.' },
      description: TEXT(500, 'What the entry is for.'),
      reference: TEXT(100, 'Entry number. Leave out to let Ironbooks number it.'),
      is_adjusting: { type: 'boolean', description: 'Mark it as an adjusting entry.' },
      lines: { type: 'array', minItems: 2, maxItems: 200, items: JOURNAL_LINE, description: 'The lines. Total debits must equal total credits.' },
    },
  }),
  enterTool({
    name: 'enter_invoice',
    title: 'Enter an invoice',
    action: 'enter_invoice',
    description:
      'Enter an invoice to a customer. It posts to Accounts Receivable and income (and sales tax, when the company charges it). Check with find_transactions that it is not already entered. If the customer would go over their credit limit the answer says so; send override_credit_limit to go ahead.',
    required: ['customer_id', 'date', 'lines'],
    properties: {
      customer_id: { ...ID, description: 'The customer (from list_customers).' },
      date: { ...DATE, description: 'Invoice date.' },
      due_date: { ...DATE, description: 'Due date. Leave out to use the terms.' },
      ref_number: TEXT(50, 'Invoice number. Leave out for the next number.'),
      terms: TEXT(50, 'Payment terms, for example "Net 30".'),
      memo: TEXT(1000, 'Memo.'),
      po_number: TEXT(100, 'The customer\'s P.O. number.'),
      class_id: { ...ID, description: 'Class for the whole invoice, if used.' },
      override_credit_limit: { type: 'boolean', description: 'Enter it even though it takes the customer over their credit limit.' },
      lines: { type: 'array', minItems: 1, maxItems: 200, items: SALES_LINE, description: 'What is being invoiced.' },
    },
  }),
  enterTool({
    name: 'enter_sales_receipt',
    title: 'Enter a sales receipt',
    action: 'enter_sales_receipt',
    description:
      'Enter a sale that was paid on the spot (no invoice). The money goes to Undeposited Funds unless you name a deposit account; if it goes to Undeposited Funds, put it in the bank later with make_deposit.',
    required: ['date', 'lines'],
    properties: {
      customer_id: { ...ID, description: 'The customer, if known.' },
      date: { ...DATE, description: 'Date of the sale.' },
      ref_number: TEXT(50, 'Receipt number. Leave out for the next number.'),
      deposit_account_id: { ...ID, description: 'The bank account the money went into. Leave out for Undeposited Funds.' },
      method: { type: 'string', enum: METHODS, description: 'How it was paid.' },
      reference: TEXT(100, 'Check or reference number.'),
      memo: TEXT(1000, 'Memo.'),
      class_id: { ...ID, description: 'Class, if used.' },
      lines: { type: 'array', minItems: 1, maxItems: 200, items: SALES_LINE, description: 'What was sold.' },
    },
  }),
  enterTool({
    name: 'receive_payment',
    title: 'Receive a customer payment',
    action: 'receive_payment',
    description:
      'Record money received from a customer and apply it to their open invoices (list_invoices shows them). Any amount not applied stays as a credit for the customer. The money goes to Undeposited Funds unless you name a deposit account.',
    required: ['customer_id', 'date', 'method', 'amount'],
    properties: {
      customer_id: { ...ID, description: 'The customer.' },
      date: { ...DATE, description: 'Date received.' },
      method: { type: 'string', enum: METHODS, description: 'How it was paid.' },
      reference: TEXT(100, 'Check or reference number.'),
      amount: { ...MONEY, description: 'Total received.' },
      deposit_account_id: { ...ID, description: 'Bank account it went into. Leave out for Undeposited Funds.' },
      memo: TEXT(1000, 'Memo.'),
      applications: {
        type: 'array',
        maxItems: 200,
        description: 'Which invoices it pays.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['invoice_id', 'amount_applied'],
          properties: {
            invoice_id: { ...ID, description: 'The invoice.' },
            amount_applied: { ...MONEY, description: 'How much of the payment goes to it.' },
            discount_amount: { ...MONEY, description: 'Early-payment discount given on it, if any.' },
          },
        },
      },
    },
  }),
  enterTool({
    name: 'enter_bill',
    title: 'Enter a bill',
    action: 'enter_bill',
    description:
      'Enter a bill from a vendor, to pay later. It posts to Accounts Payable and the expense accounts on its lines. If the same bill number already exists for that vendor it is refused; check with find_transactions first. For something paid right away, use write_check instead.',
    required: ['vendor_id', 'date', 'lines'],
    properties: {
      vendor_id: { ...ID, description: 'The vendor (from list_vendors).' },
      bill_number: TEXT(100, 'The number on the vendor\'s bill.'),
      date: { ...DATE, description: 'Bill date.' },
      due_date: { ...DATE, description: 'Due date. Leave out to use the terms.' },
      terms: TEXT(50, 'Terms, for example "Net 30".'),
      memo: TEXT(1000, 'Memo.'),
      class_id: { ...ID, description: 'Class, if used.' },
      allow_duplicate_number: { type: 'boolean', description: 'Enter it even though this vendor already has a bill with that number.' },
      lines: { type: 'array', minItems: 1, maxItems: 200, items: COST_LINE, description: 'What the bill is for.' },
    },
  }),
  enterTool({
    name: 'pay_bills',
    title: 'Pay bills',
    action: 'pay_bills',
    description:
      'Pay one or more open bills of ONE vendor (list_bills with unpaid_only shows what is open). It posts to Accounts Payable and the bank or card account. A check from a bank account gets the next check number unless you give one or mark it to print.',
    required: ['vendor_id', 'date', 'method', 'payment_account_id', 'applications'],
    properties: {
      vendor_id: { ...ID, description: 'The vendor.' },
      date: { ...DATE, description: 'Payment date.' },
      method: { type: 'string', enum: METHODS, description: 'How it is paid.' },
      payment_account_id: { ...ID, description: 'The bank or credit card account it is paid from.' },
      reference: TEXT(100, 'Check number or reference.'),
      to_print: { type: 'boolean', description: 'Put the check in the print queue instead of numbering it now.' },
      discount_account_id: { ...ID, description: 'Account for early-payment discounts, when any discount_taken is given.' },
      applications: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        description: 'Which bills are paid.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['bill_id', 'amount_applied'],
          properties: {
            bill_id: { ...ID, description: 'The bill.' },
            amount_applied: { ...MONEY, description: 'How much is paid on it.' },
            discount_taken: { ...MONEY, description: 'Discount taken on it, if any.' },
          },
        },
      },
    },
  }),
  enterTool({
    name: 'write_check',
    title: 'Write a check or enter a charge',
    action: 'write_check',
    description:
      'Record money spent directly: a check, a cash expense, or a credit card charge (method "credit_card", with a credit card account as payment_account_id; is_refund for a card credit). Not for paying a bill already entered (use pay_bills). Name the payee by vendor_id, or by payee_name for a one-off.',
    required: ['date', 'method', 'payment_account_id', 'lines'],
    properties: {
      vendor_id: { ...ID, description: 'The vendor paid.' },
      payee_name: TEXT(255, 'The payee, when it is not a vendor on the list.'),
      date: { ...DATE, description: 'Date.' },
      method: { type: 'string', enum: ['check', 'cash', 'credit_card'], description: 'check, cash or credit_card.' },
      payment_account_id: { ...ID, description: 'The bank account (check, cash) or credit card account (credit_card).' },
      reference: TEXT(100, 'Check number. Leave out for the next number.'),
      to_print: { type: 'boolean', description: 'Put the check in the print queue.' },
      is_refund: { type: 'boolean', description: 'A credit card credit (refund) instead of a charge.' },
      memo: TEXT(1000, 'Memo.'),
      lines: { type: 'array', minItems: 1, maxItems: 200, items: COST_LINE, description: 'What it was for.' },
    },
  }),
  enterTool({
    name: 'make_deposit',
    title: 'Make a deposit',
    action: 'make_deposit',
    description:
      'Deposit money into a bank account: payments and sales receipts waiting in Undeposited Funds (undeposited_funds lists them), and any other money (extra_lines, for example a refund or owner contribution). Group what went to the bank together, so the deposit matches the bank statement.',
    required: ['deposit_account_id', 'date'],
    properties: {
      deposit_account_id: { ...ID, description: 'The bank account.' },
      date: { ...DATE, description: 'Deposit date.' },
      payment_ids: { type: 'array', maxItems: 500, items: { ...ID }, description: 'Customer payments to include (from undeposited_funds).' },
      sales_receipt_ids: { type: 'array', maxItems: 500, items: { ...ID }, description: 'Sales receipts to include.' },
      memo: TEXT(1000, 'Memo.'),
      extra_lines: {
        type: 'array',
        maxItems: 100,
        description: 'Other money in the deposit.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['account_id', 'amount'],
          properties: { account_id: { ...ID, description: 'The account it came from.' }, amount: { ...MONEY, description: 'Amount.' }, description: TEXT(500, 'What it is.'), ...NAME_ON_LINE },
        },
      },
    },
  }),
  enterTool({
    name: 'transfer_funds',
    title: 'Transfer funds',
    action: 'transfer_funds',
    description: 'Move money between two of the company\'s own accounts (for example checking to savings, or checking to pay down a credit card).',
    required: ['date', 'from_account_id', 'to_account_id', 'amount'],
    properties: {
      date: { ...DATE, description: 'Date.' },
      from_account_id: { ...ID, description: 'The account the money leaves.' },
      to_account_id: { ...ID, description: 'The account it goes to.' },
      amount: { ...MONEY, description: 'Amount.' },
      memo: TEXT(1000, 'Memo.'),
    },
  }),
  enterTool({
    name: 'add_customer',
    title: 'Add a customer',
    action: 'add_customer',
    description: 'Add a customer to the list. Search first (list_customers) so the same customer is not added twice under another spelling.',
    required: ['name'],
    rename: { name: 'displayName' },
    properties: {
      name: TEXT(255, 'The customer\'s name as it should appear on the list.'),
      company_name: TEXT(255, 'Company name.'),
      email: TEXT(255, 'Email.'),
      phone: TEXT(50, 'Phone.'),
      terms: TEXT(50, 'Usual payment terms.'),
      notes: TEXT(2000, 'Notes.'),
    },
  }),
  enterTool({
    name: 'add_vendor',
    title: 'Add a vendor',
    action: 'add_vendor',
    description: 'Add a vendor to the list. Search first (list_vendors) so the same vendor is not added twice.',
    required: ['name'],
    rename: { name: 'displayName' },
    properties: {
      name: TEXT(255, 'The vendor\'s name as it should appear on the list.'),
      company_name: TEXT(255, 'Company name.'),
      email: TEXT(255, 'Email.'),
      phone: TEXT(50, 'Phone.'),
      terms: TEXT(50, 'Usual payment terms.'),
      is_1099: { type: 'boolean', description: 'The vendor gets a 1099.' },
      default_expense_account_id: { ...ID, description: 'The expense account usually used for this vendor.' },
      notes: TEXT(2000, 'Notes.'),
    },
  }),
  enterTool({
    name: 'add_account',
    title: 'Add an account',
    action: 'add_account',
    description:
      'Add an account to the chart of accounts. Look at list_accounts first: a new account is rarely needed, and the type decides where it shows on the reports.',
    required: ['name', 'account_type'],
    rename: { accountType: 'qbType', number: 'code' },
    properties: {
      name: TEXT(255, 'Account name.'),
      account_type: {
        type: 'string',
        maxLength: 40,
        description:
          'The account type as on the chart of accounts: Bank, Accounts Receivable, Other Current Asset, Fixed Asset, Other Asset, Accounts Payable, Credit Card, Other Current Liability, Long Term Liability, Equity, Income, Cost of Goods Sold, Expense, Other Income, Other Expense.',
      },
      number: TEXT(50, 'Account number. Leave out for the next free number.'),
      parent_id: { ...ID, description: 'Make it a sub-account of this account.' },
      description: TEXT(500, 'Description.'),
    },
  }),
  enterTool({
    name: 'add_item',
    title: 'Add an item',
    action: 'add_item',
    description: 'Add an item (something the company sells or buys) to the item list. Opening stock for an inventory item is entered in Ironbooks itself, not here.',
    required: ['name'],
    properties: {
      name: TEXT(255, 'Item name.'),
      type: { type: 'string', enum: ['service', 'inventory', 'non_inventory', 'other_charge', 'discount'], description: 'What kind of item (default service).' },
      description: TEXT(500, 'Description shown on sales forms.'),
      sales_price: { ...QTY, description: 'Usual price.' },
      purchase_cost: { ...QTY, description: 'Usual cost.' },
      income_account_id: { ...ID, description: 'Income account for sales of it.' },
      expense_account_id: { ...ID, description: 'Expense or cost of goods sold account for purchases of it.' },
      taxable: { type: 'boolean', description: 'Sales tax applies.' },
    },
  }),
  enterTool({
    name: 'add_class',
    title: 'Add a class',
    action: 'add_class',
    description: 'Add a class (a department, location or line of business the company tracks income and expenses by).',
    required: ['name'],
    properties: { name: TEXT(255, 'Class name.'), parent_id: { ...ID, description: 'Make it a sub-class of this class.' } },
  }),
];

// ---------------------------------------------------------------------------
// Editing, voiding, making inactive
// ---------------------------------------------------------------------------

const CHANGES = {
  type: 'object',
  additionalProperties: true,
  description:
    'The whole record as it should now be, with the same fields as the tool that enters that kind (enter_invoice for an invoice, write_check for a check…). Read it first with get_transaction and send everything back with your changes: fields left out are cleared, and lines not listed are removed.',
};

const EDIT = [
  {
    name: 'edit_transaction',
    title: 'Edit a transaction',
    changes: true,
    destructive: false,
    description:
      'Change a transaction that is already entered. Read it first (get_transaction), then send the whole record back with your changes and the updated_at you read. A change to amounts, accounts or the date voids the old posting and posts a new one; a journal entry edited that way comes back with a new id. Nothing on or before the closing date can be changed, and a transaction with payments applied or already reconciled may be refused.',
    inputSchema: schema(
      { type: { type: 'string', enum: TRANSACTION_TYPES, description: 'What kind of transaction.' }, id: { ...ID, description: 'Its id.' }, expected_updated_at: EXPECTED, changes: CHANGES },
      ['type', 'id', 'changes'],
    ),
    handler: (a, c) => send(c, `edit_${a.type}`, { id: a.id, ...(a.expected_updated_at ? { expectedUpdatedAt: a.expected_updated_at } : {}), changes: camelize(a.changes) }, a),
  },
  {
    name: 'void_transaction',
    title: 'Void a transaction',
    changes: true,
    destructive: true,
    description:
      'Void a transaction: it stays on the books with zero effect, and its number is kept. This is how a mistake is removed; nothing is ever deleted. An invoice or bill with payments applied must have those payments voided first. Nothing on or before the closing date can be voided.',
    inputSchema: schema({ type: { type: 'string', enum: TRANSACTION_TYPES, description: 'What kind of transaction.' }, id: { ...ID, description: 'Its id.' }, expected_updated_at: EXPECTED }, ['type', 'id']),
    handler: (a, c) => send(c, `void_${a.type}`, { id: a.id, ...(a.expected_updated_at ? { expectedUpdatedAt: a.expected_updated_at } : {}) }, a),
  },
  {
    name: 'edit_list_entry',
    title: 'Edit a customer, vendor, account or item',
    changes: true,
    destructive: false,
    description:
      'Change a customer, vendor, account or item. Send only the fields that change, with the same names as the tool that adds that kind (add_customer, add_vendor, add_account, add_item).',
    inputSchema: schema(
      {
        type: { type: 'string', enum: LIST_TYPES, description: 'Which list.' },
        id: { ...ID, description: 'The entry\'s id.' },
        expected_updated_at: EXPECTED,
        changes: { type: 'object', additionalProperties: true, description: 'The fields to change.' },
      },
      ['type', 'id', 'changes'],
    ),
    handler: (a, c) => {
      const changes = camelize(a.changes);
      // The list tools call these fields by a plainer name than the app does.
      if ((a.type === 'customer' || a.type === 'vendor') && changes.name !== undefined) {
        changes.displayName = changes.name;
        delete changes.name;
      }
      if (a.type === 'account' && changes.accountType !== undefined) {
        changes.qbType = changes.accountType;
        delete changes.accountType;
      }
      return send(c, `edit_${a.type}`, { id: a.id, ...(a.expected_updated_at ? { expectedUpdatedAt: a.expected_updated_at } : {}), changes }, a);
    },
  },
  {
    name: 'deactivate_list_entry',
    title: 'Make a list entry inactive',
    changes: true,
    destructive: true,
    description:
      'Make a customer, vendor, account, item or class inactive: it is hidden from lists and forms, and everything already entered with it stays as it is. Nothing is deleted. An account with a balance cannot be made inactive.',
    inputSchema: schema({ type: { type: 'string', enum: [...LIST_TYPES, 'class'], description: 'Which list.' }, id: { ...ID, description: 'The entry\'s id.' }, expected_updated_at: EXPECTED }, ['type', 'id']),
    handler: (a, c) => send(c, `deactivate_${a.type}`, a.type === 'class' ? { id: a.id } : { id: a.id, ...(a.expected_updated_at ? { expectedUpdatedAt: a.expected_updated_at } : {}) }, a),
  },
];

// ---------------------------------------------------------------------------
// The reads that go with them
// ---------------------------------------------------------------------------

const READ_PATHS = {
  journal_entry: '/api/journal-entries/',
  invoice: '/api/invoices/',
  sales_receipt: '/api/sales-receipts/',
  payment: '/api/payments/',
  bill: '/api/bills/',
  bill_payment: '/api/bill-payments/',
  check: '/api/expenses/',
  deposit: '/api/deposits/',
  transfer: '/api/transfers/',
  customer: '/api/customers/',
  vendor: '/api/vendors/',
  account: '/api/accounts/',
  item: '/api/items/',
};

const DROP = new Set(['companyId', 'createdAt', 'customFields', 'postedEntryId']);
const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const isDay = (k) => /(^|_)date$|_on$/.test(k);

/** A record as Ironbooks returns it, in the tools' field names, without internal fields. */
export function shapeRecord(v) {
  if (Array.isArray(v)) return v.map(shapeRecord);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (DROP.has(k) || val === null || val === undefined || val === '') continue;
      const key = snake(k);
      out[key] = typeof val === 'string' && isDay(key) && /^\d{4}-\d{2}-\d{2}T/.test(val) ? val.slice(0, 10) : shapeRecord(val);
    }
    if (v.postedEntryId) out.journal_entry_id = v.postedEntryId;
    return out;
  }
  return v;
}

const asList = (v, key) => (Array.isArray(v) ? v : Array.isArray(v?.[key]) ? v[key] : []);
const MAX_ROWS = { type: 'integer', minimum: 1, maximum: 2000, description: 'Most rows to return (default 300).' };
function capped(rows, max, key) {
  const limit = max ?? 300;
  return { count: rows.length, [key]: rows.slice(0, limit), ...(rows.length > limit ? { truncated: true, note: `Showing the first ${limit} of ${rows.length}.` } : {}) };
}

const READS = [
  {
    name: 'get_transaction',
    title: 'Read one record in full',
    description:
      'Read one transaction or list entry in full, with its lines: a journal entry, invoice, sales receipt, customer payment, bill, bill payment, check or charge, deposit, transfer, customer, vendor, account or item. Use it before edit_transaction, and keep the updated_at it returns to send back with your change.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['type', 'id'], properties: { type: { type: 'string', enum: Object.keys(READ_PATHS), description: 'What kind of record.' }, id: { ...ID, description: 'Its id.' } } },
    handler: async (a, c) => {
      const res = await c.get(`${READ_PATHS[a.type]}${a.id}`);
      const record = res?.entry ?? res?.item ?? res?.expense ?? res;
      if (!record || typeof record !== 'object') throw new ToolError('That record was not found.');
      // `kind` and not `type`: accounts and items have a type of their own.
      return { kind: a.type, ...shapeRecord(record) };
    },
  },
  {
    name: 'list_invoices',
    title: 'Invoices',
    description: 'Invoices, optionally for one customer or one status (open, partial, paid, overdue, void, draft): id, number, date, due date, total and balance due. Use it to find the invoices a payment should be applied to.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        customer_id: { ...ID, description: 'Only this customer.' },
        status: { type: 'string', enum: ['draft', 'open', 'partial', 'paid', 'overdue', 'void'], description: 'Only this status.' },
        unpaid_only: { type: 'boolean', description: 'Only invoices with a balance due.' },
        max_rows: MAX_ROWS,
      },
    },
    handler: async (a, c) => {
      let rows = asList(await c.get('/api/invoices', { customerId: a.customer_id, status: a.status }), 'invoices').map((r) => ({
        id: r.id, number: r.refNumber ?? (r.invoiceNumber !== undefined ? String(r.invoiceNumber) : null), customer_id: r.customerId, date: String(r.date ?? '').slice(0, 10),
        due_date: r.dueDate ? String(r.dueDate).slice(0, 10) : null, total: r.total, balance_due: r.balanceDue, status: r.status,
      }));
      if (a.unpaid_only) rows = rows.filter((r) => Number(r.balance_due) > 0 && r.status !== 'void' && r.status !== 'draft');
      return capped(rows, a.max_rows, 'invoices');
    },
  },
  {
    name: 'list_bills',
    title: 'Bills',
    description: 'Bills, optionally for one vendor or one status: id, the vendor\'s bill number, date, due date, total and balance due.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        vendor_id: { ...ID, description: 'Only this vendor.' },
        status: { type: 'string', enum: ['open', 'partial', 'paid', 'overdue', 'void'], description: 'Only this status.' },
        unpaid_only: { type: 'boolean', description: 'Only bills with a balance due.' },
        max_rows: MAX_ROWS,
      },
    },
    handler: async (a, c) => {
      let rows = asList(await c.get('/api/bills', { vendorId: a.vendor_id, status: a.status }), 'bills').map((r) => ({
        id: r.id, number: r.billNumber ?? null, vendor_id: r.vendorId, date: String(r.date ?? '').slice(0, 10), due_date: r.dueDate ? String(r.dueDate).slice(0, 10) : null,
        total: r.total, balance_due: r.balanceDue, status: r.status,
      }));
      if (a.unpaid_only) rows = rows.filter((r) => Number(r.balance_due) > 0 && r.status !== 'void');
      return capped(rows, a.max_rows, 'bills');
    },
  },
  {
    name: 'undeposited_funds',
    title: 'Money waiting to be deposited',
    description: 'Customer payments and sales receipts sitting in Undeposited Funds, waiting to be put in the bank with make_deposit: id, kind, date, name, reference and amount.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    handler: async (_a, c) => shapeRecord(await c.get('/api/deposits/undeposited')),
  },
  // list_my_proposals is now an alias of list_my_requests (mcp/operations-tools.mjs).
];

export const WRITE_TOOLS = [...ENTER, ...EDIT];
export const WRITE_READ_TOOLS = READS;
