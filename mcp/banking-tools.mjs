/**
 * The tools for a bank statement: put its lines in the bank feed, deal with each line, reconcile.
 *
 * This is the bookkeeper's month-end routine, in the order the app's own windows do it:
 *
 *   1. import_statement_lines   the statement's lines go into the bank feed. They must add up to
 *                               the change between the opening and the closing balance.
 *   2. get_bank_feed            shows the lines waiting, with a suggested account where the
 *                               company's own rules and history have one, and with entries already
 *                               in the books that a line may belong to.
 *      match_bank_line          a line that is already in the books is linked to that entry;
 *      categorize_bank_line     a line that is not, is entered to an account;
 *      exclude_bank_line        a line that does not belong is set aside.
 *   3. start_reconciliation     for the statement date and ending balance;
 *      get_reconciliation       lists what can be marked as cleared and shows the difference;
 *      mark_cleared             ticks the lines the statement shows;
 *      finish_reconciliation    closes it, only when the difference is exactly 0.00.
 *
 * Putting lines in the feed and working on a reconciliation in progress post nothing to the ledger,
 * so an agent in Propose mode does those itself. Entering a line, matching it, and finishing or
 * undoing a reconciliation go to a person for approval in Propose mode.
 */
import { ToolError } from './protocol.mjs';
import { camelize, shapeAnswer, shapeRecord } from './write-tools.mjs';

const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', patternHint: 'must be a date as YYYY-MM-DD' };
const ID = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$', patternHint: 'must be an id returned by another tool' };
const MONEY = { type: 'string', pattern: '^\\d{1,13}(\\.\\d{1,2})?$', patternHint: 'must be an amount like 1250.00 (text, at most 2 decimals)' };
const SIGNED = { type: 'string', pattern: '^-?\\d{1,13}(\\.\\d{1,2})?$', patternHint: 'must be an amount like -45.10 or 1200.00 (text)' };
const DRY_RUN = { type: 'boolean', description: 'true: check it and show what it would do, without keeping anything.' };
const REQUEST_ID = {
  type: 'string',
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:\\-]{2,119}$',
  patternHint: 'must be 3 to 120 letters, digits, dots, dashes, colons or underscores',
  description: 'Your own name for this one change. Required unless dry_run is true. The same request_id asked again returns the first answer and never does it twice.',
};

function schema(properties, required = []) {
  return { type: 'object', properties: { ...properties, dry_run: DRY_RUN, request_id: REQUEST_ID }, required, additionalProperties: false };
}
const readSchema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

async function send(client, action, input, args) {
  if (args.dry_run !== true && !args.request_id) {
    throw new ToolError('Give a request_id (your own name for this one change), or set dry_run to true to only check it.');
  }
  const answer = shapeAnswer(await client.act({ action, input, ...(args.dry_run === true ? { dryRun: true } : { requestId: args.request_id }) }));
  // A step that only prepares work posts nothing: say so in its own words.
  if (answer.outcome === 'done') answer.said = 'Done. Nothing was posted to the ledger.';
  return answer;
}

function tool({ name, title, description, action, properties, required, destructive = false }) {
  return {
    name,
    title,
    description,
    changes: true,
    destructive,
    inputSchema: schema(properties, required),
    handler: (args, client) => {
      const { dry_run: _d, request_id: _r, ...rest } = args;
      return send(client, action, camelize(rest), args);
    },
  };
}

const asList = (v, key) => (Array.isArray(v) ? v : Array.isArray(v?.[key]) ? v[key] : []);
const day = (v) => (typeof v === 'string' ? v.slice(0, 10) : null);

const READS = [
  {
    name: 'list_bank_accounts',
    title: 'Bank and card accounts',
    description:
      'The bank and credit card accounts set up for statements and reconciling: id (the bank_account_id the other banking tools ask for), bank name, the last four digits of the account number, the ledger account behind it, and the date and balance it was last reconciled to. Start here for any statement or reconciliation.',
    inputSchema: readSchema({}),
    handler: async (_a, c) => {
      const rows = asList(await c.get('/api/bank-accounts'), 'bankAccounts').map((r) => ({
        bank_account_id: r.id, bank: r.bankName, account_number: r.accountNumber ?? null, ledger_account_id: r.accountId,
        ledger_account: [r.glAccountCode, r.glAccountName].filter(Boolean).join(' '), kind: r.glAccountSubtype === 'credit_card' || r.glAccountType === 'liability' ? 'card' : 'bank',
        last_reconciled_date: day(r.lastReconciledDate), last_reconciled_balance: r.lastReconciledBalance ?? null, ...(r.currency ? { currency: r.currency } : {}),
      }));
      return { count: rows.length, bank_accounts: rows };
    },
  },
  {
    name: 'get_bank_feed',
    title: 'Bank feed lines',
    description:
      'The statement lines in the bank feed of one account. By default the ones waiting for review, each with a suggested account (from the company\'s own bank rules and its history, never from an AI service) and with entries already in the books it may belong to. A positive amount is money into the account, a negative one money out. For each line decide: match_bank_line if it is already in the books, categorize_bank_line if it is not, exclude_bank_line if it does not belong.',
    inputSchema: readSchema(
      {
        bank_account_id: { ...ID, description: 'The bank account (from list_bank_accounts).' },
        show: { type: 'string', enum: ['to_review', 'matched', 'excluded', 'all'], description: 'Which lines (default to_review).' },
        max_rows: { type: 'integer', minimum: 1, maximum: 2000, description: 'Most lines to return (default 200).' },
      },
      ['bank_account_id'],
    ),
    handler: async (a, c) => {
      const filter = { to_review: 'unreviewed', matched: 'matched', excluded: 'excluded', all: 'all' }[a.show ?? 'to_review'];
      const lines = asList(await c.get('/api/bank-transactions', { bankAccountId: a.bank_account_id, filter }), 'transactions');
      const limit = a.max_rows ?? 200;
      const reviewing = filter === 'unreviewed';
      let suggestions = new Map();
      let matches = {};
      if (reviewing && lines.length) {
        const s = (await c.act({ action: 'bank_feed_suggestions', input: { bankAccountId: a.bank_account_id } }))?.result?.suggestions ?? [];
        suggestions = new Map(s.map((x) => [x.bank_transaction_id, x]));
        matches = (await c.get('/api/bank-transactions/matches', { bankAccountId: a.bank_account_id }))?.matches ?? {};
      }
      const rows = lines.slice(0, limit).map((l) => {
        const s = suggestions.get(l.id);
        const m = asList(matches[l.id]).slice(0, 3);
        return {
          bank_transaction_id: l.id, date: day(l.date), description: l.description, payee: l.payee ?? null, amount: l.amount,
          status: l.excluded ? 'excluded' : l.matched ? 'matched' : 'to_review',
          ...(l.matchedEntryId ? { journal_entry_id: l.matchedEntryId } : {}),
          ...(s?.account_id ? { suggested_account_id: s.account_id, suggested_account: s.account, why: s.reason, confidence: s.confidence } : {}),
          ...(m.length ? { possible_matches: m.map((x) => ({ journal_entry_id: x.entryId, date: day(x.date), description: x.description, number: x.reference ?? null, amount: x.amount, confidence: x.confidence })) } : {}),
        };
      });
      return { count: lines.length, lines: rows, ...(lines.length > limit ? { truncated: true, note: `Showing the first ${limit} of ${lines.length} lines.` } : {}) };
    },
  },
  {
    name: 'reconcile_status',
    title: 'Where a reconciliation stands',
    description:
      'For one bank account: the date and balance it was last reconciled to (the beginning balance of the next statement), whether a reconciliation is in progress and its id, and any discrepancy between the last reconciled balance and what the cleared entries add up to now (someone changed a reconciled transaction).',
    inputSchema: readSchema({ bank_account_id: { ...ID, description: 'The bank account (from list_bank_accounts).' } }, ['bank_account_id']),
    handler: async (a, c) => {
      const info = await c.get('/api/reconciliations/info', { bankAccountId: a.bank_account_id });
      const all = asList(await c.get('/api/reconciliations'), 'reconciliations').filter((r) => r.bankAccountId === a.bank_account_id);
      const open = all.find((r) => r.status === 'in_progress');
      const last = all.filter((r) => r.status === 'completed').sort((x, y) => String(y.statementDate).localeCompare(String(x.statementDate)))[0];
      return {
        bank_account_id: a.bank_account_id,
        account: [info.glAccountCode, info.glAccountName].filter(Boolean).join(' '),
        kind: info.isCreditCard ? 'card' : 'bank',
        last_reconciled_date: day(info.lastReconciledDate),
        beginning_balance: info.beginningBalance ?? null,
        ...(info.discrepancy && Number(info.discrepancy) !== 0 ? { discrepancy: info.discrepancy, note: 'A reconciled transaction was changed since the last reconciliation. Look into it before reconciling the next statement.' } : {}),
        in_progress: open ? { reconciliation_id: open.id, statement_date: day(open.statementDate), statement_balance: open.statementBalance } : null,
        last_finished: last ? { reconciliation_id: last.id, statement_date: day(last.statementDate), statement_balance: last.statementBalance } : null,
      };
    },
  },
  {
    name: 'get_reconciliation',
    title: 'A reconciliation: lines and difference',
    description:
      'A reconciliation in progress: the statement balance, the cleared balance so far, the difference still to find, and every line that can be marked as cleared (date, number, description, debit or credit, whether it is marked). Mark the ones the statement shows with mark_cleared until the difference is 0.00.',
    inputSchema: readSchema(
      { reconciliation_id: { ...ID, description: 'The reconciliation (from start_reconciliation or reconcile_status).' }, only_uncleared: { type: 'boolean', description: 'List only lines not yet marked.' }, max_rows: { type: 'integer', minimum: 1, maximum: 5000, description: 'Most lines to return (default 1000).' } },
      ['reconciliation_id'],
    ),
    handler: async (a, c) => {
      const p = await c.get(`/api/reconciliations/${a.reconciliation_id}`);
      let lines = asList(await c.get(`/api/reconciliations/${a.reconciliation_id}/clearable`), 'lines');
      if (a.only_uncleared) lines = lines.filter((l) => !l.isCleared);
      const limit = a.max_rows ?? 1000;
      return {
        reconciliation_id: a.reconciliation_id, statement_balance: p.statementBalance, cleared_balance: p.clearedBalance, difference: p.difference,
        can_finish: Number(p.difference) === 0,
        line_count: lines.length,
        lines: lines.slice(0, limit).map((l) => ({ line_id: l.journalEntryLineId, journal_entry_id: l.journalEntryId, date: day(l.date), number: l.reference ?? null, description: l.description, debit: l.debit ?? null, credit: l.credit ?? null, cleared: l.isCleared === true })),
        ...(lines.length > limit ? { truncated: true } : {}),
      };
    },
  },
];

const WRITES = [
  {
    name: 'import_statement_lines',
    title: 'Put a statement\'s lines in the bank feed',
    changes: true,
    destructive: false,
    description:
      'Put the lines of a bank or credit card statement into the bank feed of one account, to be reviewed line by line. Give every line of the statement with its date, description and amount, and the statement\'s opening and closing balance: the lines must add up to the change between the two, or the import is refused and tells you by how much they are off. Bank account: a deposit is positive, a withdrawal negative. Credit card: a charge is negative, a payment or credit positive. Lines already in the feed are skipped, so importing the same statement again adds nothing. This posts nothing to the ledger.',
    inputSchema: schema(
      {
        bank_account_id: { ...ID, description: 'The bank account (from list_bank_accounts).' },
        statement_kind: { type: 'string', enum: ['bank', 'card'], description: 'A bank statement or a credit card statement.' },
        opening_balance: { ...SIGNED, description: 'The statement\'s opening balance.' },
        closing_balance: { ...SIGNED, description: 'The statement\'s closing balance.' },
        acknowledge_difference: { type: 'boolean', description: 'Import even though the lines do not add up to the statement. Only when you know why they differ.' },
        filename: { type: 'string', maxLength: 200, description: 'A name for this import, for example "Checking 2026-03 statement".' },
        lines: {
          type: 'array',
          minItems: 1,
          maxItems: 5000,
          description: 'Every line of the statement.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['date', 'description', 'amount'],
            properties: {
              date: { ...DATE, description: 'The line\'s date.' },
              description: { type: 'string', maxLength: 500, description: 'The description as printed on the statement.' },
              amount: { ...SIGNED, description: 'Signed amount, as text: money in positive, money out negative.' },
              payee: { type: 'string', maxLength: 255, description: 'The payee, if the statement names one.' },
            },
          },
        },
      },
      ['bank_account_id', 'statement_kind', 'opening_balance', 'closing_balance', 'lines'],
    ),
    handler: (a, c) =>
      send(
        c,
        'import_statement_lines',
        {
          bankAccountId: a.bank_account_id, kind: a.statement_kind, openingBalance: a.opening_balance, closingBalance: a.closing_balance,
          ...(a.acknowledge_difference ? { acknowledgeDifference: true } : {}), ...(a.filename ? { filename: a.filename } : {}), rows: a.lines,
        },
        a,
      ),
  },
  tool({
    name: 'categorize_bank_line',
    title: 'Enter a bank feed line',
    action: 'categorize_bank_line',
    description:
      'Enter a bank feed line that is not in the books yet: it posts to the bank account and to the account you name (for example a withdrawal to an expense account). Use match_bank_line instead when the transaction is already entered (a check you wrote, a deposit you made), or it will be in the books twice. Not for lines that pay a bill or a customer\'s invoice: use pay_bills or receive_payment and then match the line.',
    required: ['bank_transaction_id', 'account_id'],
    properties: {
      bank_transaction_id: { ...ID, description: 'The line (from get_bank_feed).' },
      account_id: { ...ID, description: 'The account it goes to (from list_accounts).' },
      payee: { type: 'string', maxLength: 255, description: 'Payee.' },
      memo: { type: 'string', maxLength: 500, description: 'Memo.' },
      class_id: { ...ID, description: 'Class, if used.' },
    },
  }),
  tool({
    name: 'match_bank_line',
    title: 'Match a bank feed line to an entry',
    action: 'match_bank_line',
    description: 'Link a bank feed line to the entry already in the books for it (get_bank_feed lists possible_matches). Nothing new is posted. The entry must be for the same amount on that bank account.',
    required: ['bank_transaction_id', 'journal_entry_id'],
    properties: { bank_transaction_id: { ...ID, description: 'The line.' }, journal_entry_id: { ...ID, description: 'The entry it belongs to.' } },
  }),
  tool({
    name: 'unmatch_bank_line',
    title: 'Undo a bank feed match',
    action: 'unmatch_bank_line',
    destructive: true,
    description: 'Put a matched or entered bank feed line back to review. If the line was entered from the feed (categorize_bank_line), its entry is voided; if it was matched to an existing entry, only the link is removed.',
    required: ['bank_transaction_id'],
    properties: { bank_transaction_id: { ...ID, description: 'The line.' } },
  }),
  tool({
    name: 'exclude_bank_line',
    title: 'Set a bank feed line aside',
    action: 'exclude_bank_line',
    description: 'Set a bank feed line aside because it does not belong in the books (a duplicate download, a line of another account). It is kept and can be put back with restore. This posts nothing.',
    required: ['bank_transaction_id'],
    properties: { bank_transaction_id: { ...ID, description: 'The line.' }, restore: { type: 'boolean', description: 'true: put an excluded line back to review.' } },
  }),
  tool({
    name: 'start_reconciliation',
    title: 'Start a reconciliation',
    action: 'start_reconciliation',
    description:
      'Start reconciling one bank or card account to a statement: give the statement\'s date and ending balance. One reconciliation can be in progress per account. Check reconcile_status first: the statement\'s opening balance should equal the beginning balance shown there. This posts nothing.',
    required: ['bank_account_id', 'statement_date', 'statement_balance'],
    properties: {
      bank_account_id: { ...ID, description: 'The bank account (from list_bank_accounts).' },
      statement_date: { ...DATE, description: 'The statement\'s ending date.' },
      statement_balance: { ...SIGNED, description: 'The statement\'s ending balance.' },
    },
  }),
  {
    name: 'mark_cleared',
    title: 'Mark lines as cleared',
    changes: true,
    destructive: false,
    description:
      'In a reconciliation in progress, mark the lines the statement shows as cleared (or unmark them). The answer gives the cleared balance and the difference left. Keep going until the difference is 0.00. This posts nothing.',
    inputSchema: schema(
      {
        reconciliation_id: { ...ID, description: 'The reconciliation.' },
        line_ids: { type: 'array', minItems: 1, maxItems: 20000, items: { ...ID }, description: 'The line_id of each line (from get_reconciliation).' },
        cleared: { type: 'boolean', description: 'true to mark as cleared (default), false to unmark.' },
      },
      ['reconciliation_id', 'line_ids'],
    ),
    handler: (a, c) => send(c, 'set_cleared', { reconciliationId: a.reconciliation_id, journalEntryLineIds: a.line_ids, isCleared: a.cleared !== false }, a),
  },
  tool({
    name: 'update_reconciliation_statement',
    title: 'Correct the statement date or balance',
    action: 'update_reconciliation_statement',
    description: 'Correct the statement date or ending balance of a reconciliation in progress. Moving the date earlier unmarks lines dated after it.',
    required: ['reconciliation_id'],
    properties: {
      reconciliation_id: { ...ID, description: 'The reconciliation.' },
      statement_date: { ...DATE, description: 'The right statement date.' },
      statement_balance: { ...SIGNED, description: 'The right ending balance.' },
    },
  }),
  {
    name: 'add_statement_adjustments',
    title: 'Enter the statement\'s bank fee and interest',
    changes: true,
    destructive: false,
    description: 'Enter the service charge and the interest shown on the statement, once per reconciliation. Each posts to the bank account and the account you name, and is marked as cleared.',
    inputSchema: schema(
      {
        reconciliation_id: { ...ID, description: 'The reconciliation.' },
        service_charge: { ...MONEY, description: 'The bank\'s service charge.' },
        service_charge_account_id: { ...ID, description: 'The expense account for the service charge.' },
        interest_earned: { ...MONEY, description: 'Interest the bank paid.' },
        interest_account_id: { ...ID, description: 'The income account for the interest.' },
      },
      ['reconciliation_id'],
    ),
    handler: (a, c) => {
      if ((a.service_charge && !a.service_charge_account_id) || (a.interest_earned && !a.interest_account_id)) throw new ToolError('Give the account each amount goes to.');
      if (!a.service_charge && !a.interest_earned) throw new ToolError('Give a service charge, interest earned, or both.');
      return send(
        c,
        'add_statement_adjustments',
        {
          reconciliationId: a.reconciliation_id,
          ...(a.service_charge ? { serviceCharge: { amount: a.service_charge, accountId: a.service_charge_account_id } } : {}),
          ...(a.interest_earned ? { interestEarned: { amount: a.interest_earned, accountId: a.interest_account_id } } : {}),
        },
        a,
      );
    },
  },
  tool({
    name: 'finish_reconciliation',
    title: 'Finish a reconciliation',
    action: 'finish_reconciliation',
    description:
      'Finish a reconciliation. Only possible when the difference is exactly 0.00 (get_reconciliation shows it); the books are never forced to agree with an adjustment. The cleared lines become reconciled, and the account\'s last reconciled date and balance move to this statement.',
    required: ['reconciliation_id'],
    properties: { reconciliation_id: { ...ID, description: 'The reconciliation.' } },
  }),
  tool({
    name: 'cancel_reconciliation',
    title: 'Cancel a reconciliation in progress',
    action: 'cancel_reconciliation',
    destructive: true,
    description: 'Cancel a reconciliation that is still in progress: its cleared marks are dropped. Entries posted for the statement\'s fee or interest stay.',
    required: ['reconciliation_id'],
    properties: { reconciliation_id: { ...ID, description: 'The reconciliation.' } },
  }),
  tool({
    name: 'undo_last_reconciliation',
    title: 'Undo the last finished reconciliation',
    action: 'undo_last_reconciliation',
    destructive: true,
    description: 'Undo the last finished reconciliation of an account, so it can be done again: its lines go back to cleared-not-reconciled and the last reconciled date and balance go back to the statement before.',
    required: ['bank_account_id'],
    properties: {
      bank_account_id: { ...ID, description: 'The bank account.' },
      expect_statement_date: { ...DATE, description: 'The statement date you believe is the last one. If it is not, nothing is undone.' },
    },
  }),
];

export const BANKING_READ_TOOLS = READS;
export const BANKING_WRITE_TOOLS = WRITES;
export { shapeRecord };
