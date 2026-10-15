/**
 * Plaid live bank-feed integration.
 *
 * Uses global `fetch` (no SDK dependency) to call Plaid's REST API directly.
 * All functions degrade gracefully: if PLAID_CLIENT_ID / PLAID_SECRET are not
 * set, `isConfigured()` returns false and every operation that requires Plaid
 * throws a user-friendly ServiceError with code 'VALIDATION'.
 *
 * Environment variables read at call time (never cached at import) so the app
 * can be started without them and configured later.
 *
 *   PLAID_CLIENT_ID  — your Plaid client_id
 *   PLAID_SECRET     — environment-specific secret
 *   PLAID_ENV        — sandbox | development | production  (default: sandbox)
 */

import { and, eq, inArray } from 'drizzle-orm';
import { bankTransactions, bankAccounts } from '@/lib/db/schema';
import { toAmountString } from '@/lib/money';
import { type ServiceContext, ServiceError, validation } from './_base';
import { policyFetch } from '@/lib/net/guard';
import { assertNotSandbox } from './sandboxState';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function getPlaidEnv(): string {
  const e = process.env.PLAID_ENV ?? 'sandbox';
  if (e !== 'sandbox' && e !== 'development' && e !== 'production') return 'sandbox';
  return e;
}

function getBaseUrl(): string {
  return `https://${getPlaidEnv()}.plaid.com`;
}

function getCredentials(): { clientId: string; secret: string } | null {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) return null;
  return { clientId, secret };
}

/** Returns true when the minimum required env vars are present. */
export function isConfigured(): boolean {
  return getCredentials() !== null;
}

function notConfiguredError(): ServiceError {
  return validation(
    'Plaid is not configured. Set PLAID_CLIENT_ID, PLAID_SECRET, and optionally PLAID_ENV (sandbox|development|production) in your environment.',
  );
}

// ---------------------------------------------------------------------------
// Low-level fetch wrapper
// ---------------------------------------------------------------------------

// Every Plaid call goes through the network policy (lib/net/guard.ts): bank feeds stay off
// unless the company is in 'allow-cloud' mode AND has opted in to the 'bank-feeds' purpose.
async function plaidPost<T>(
  ctx: ServiceContext,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const creds = getCredentials();
  if (!creds) throw notConfiguredError();

  const url = `${getBaseUrl()}${path}`;
  const payload = {
    client_id: creds.clientId,
    secret: creds.secret,
    ...body,
  };

  const res = await policyFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    { purpose: 'bank-feeds', ctx },
  );

  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = await res.text();
    }
    const msg =
      typeof detail === 'object' && detail !== null && 'error_message' in detail
        ? (detail as { error_message: string }).error_message
        : `Plaid API error ${res.status}`;
    throw new ServiceError('INTERNAL', msg, detail);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a Plaid Link token that the front-end uses to open the Link widget.
 * The Link token is short-lived (~30 min); do not cache it.
 */
export async function createLinkToken(ctx: ServiceContext): Promise<string> {
  assertNotSandbox('Bank feed sync'); // sandbox mode: no bank connections from a practice copy
  if (!isConfigured()) throw notConfiguredError();

  const data = await plaidPost<{ link_token: string }>(ctx, '/link/token/create', {
    user: { client_user_id: ctx.companyId },
    client_name: 'Ironbooks',
    products: ['transactions'],
    country_codes: ['US'],
    language: 'en',
  });

  return data.link_token;
}

/**
 * Exchange the one-time public token (from the Link `onSuccess` callback) for
 * a permanent access token. The caller is responsible for storing the returned
 * access token; this service intentionally does not persist it (it would need
 * encryption at rest — left as an infrastructure concern).
 */
export async function exchangePublicToken(ctx: ServiceContext, publicToken: string): Promise<string> {
  assertNotSandbox('Bank feed sync'); // sandbox mode: no bank connections from a practice copy
  if (!isConfigured()) throw notConfiguredError();

  const data = await plaidPost<{ access_token: string }>(ctx, '/item/public_token/exchange', {
    public_token: publicToken,
  });

  return data.access_token;
}

// ---------------------------------------------------------------------------
// Transaction sync
// ---------------------------------------------------------------------------

interface PlaidTransaction {
  transaction_id: string;
  date: string; // YYYY-MM-DD
  name: string;
  merchant_name?: string | null;
  amount: number; // Plaid: positive = debit from account, negative = credit
}

interface PlaidSyncResponse {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: Array<{ transaction_id: string }>;
  next_cursor: string;
  has_more: boolean;
}

interface SyncResult {
  imported: number;
  total: number;
}

/**
 * Pull new transactions from Plaid and stage them into `bank_transactions`.
 *
 * Uses `/transactions/sync` (the modern cursor-based endpoint). Deduplication
 * is done on `fitId = transaction_id`; rows that already exist are skipped.
 * Returns { imported, total } where `total` is the count from the current page
 * and `imported` is how many were actually inserted (excluding dupes).
 *
 * NOTE: access tokens must be obtained via `exchangePublicToken` and stored
 * securely by the caller before being passed here.
 */
export async function syncTransactions(
  ctx: ServiceContext,
  params: { accessToken: string; bankAccountId: string },
): Promise<SyncResult> {
  assertNotSandbox('Bank feed sync'); // sandbox mode: no bank connections from a practice copy
  if (!isConfigured()) throw notConfiguredError();

  // Verify the bank account belongs to this company.
  const [bankAcct] = await ctx.db
    .select({ id: bankAccounts.id })
    .from(bankAccounts)
    .where(
      and(
        eq(bankAccounts.id, params.bankAccountId),
        eq(bankAccounts.companyId, ctx.companyId),
      ),
    );
  if (!bankAcct) {
    throw new ServiceError('NOT_FOUND', 'Bank account not found or does not belong to this company.');
  }

  // Fetch one page of new transactions via the sync endpoint.
  const syncData = await plaidPost<PlaidSyncResponse>(ctx, '/transactions/sync', {
    access_token: params.accessToken,
  });

  const incoming = syncData.added ?? [];
  if (incoming.length === 0) {
    return { imported: 0, total: 0 };
  }

  // Collect fitIds from Plaid.
  const fitIds = incoming.map((t) => t.transaction_id);

  // Find which fitIds already exist for this bank account to deduplicate.
  const existing = await ctx.db
    .select({ fitId: bankTransactions.fitId })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.bankAccountId, params.bankAccountId),
        inArray(bankTransactions.fitId, fitIds),
      ),
    );
  const existingSet = new Set(existing.map((r) => r.fitId));

  const toInsert = incoming.filter((t) => !existingSet.has(t.transaction_id));

  if (toInsert.length > 0) {
    // Plaid amounts: positive = money left account (debit), negative = money entered account (credit).
    // We store debits as negative and credits as positive to match the bank statement sign convention
    // used in the existing OFX/CSV importers.
    await ctx.db.insert(bankTransactions).values(
      toInsert.map((t) => ({
        companyId: ctx.companyId,
        bankAccountId: params.bankAccountId,
        fitId: t.transaction_id,
        date: new Date(t.date),
        description: t.name,
        payee: t.merchant_name ?? null,
        // Plaid: positive amount = debit from account → store as negative (outflow).
        amount: toAmountString(-t.amount),
        matched: false,
      })),
    );
  }

  return { imported: toInsert.length, total: incoming.length };
}
