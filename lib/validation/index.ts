/**
 * lib/validation — zod request-body validation for the API layer.
 *
 * ── THE PATTERN (adopt this in every mutating route) ────────────────────────
 *
 * 1. Define a body schema in a per-domain file here (lib/validation/<domain>.ts),
 *    mirroring the service-layer input interface exactly (so `parsed.data` is
 *    assignable to the service input with no casts). Import field helpers from
 *    './helpers' inside domain files (importing './index' there would cycle).
 *
 * 2. In the route handler:
 *
 *      import { zodErrorBody, createWidgetSchema } from '@/lib/validation';
 *
 *      export async function POST(req: NextRequest) {
 *        try {
 *          const ctx = await getServerContext();
 *          const body = await req.json().catch(() => ({}));   // malformed JSON -> field errors, not a 500
 *          const parsed = createWidgetSchema.safeParse(body);
 *          if (!parsed.success) {
 *            return NextResponse.json(zodErrorBody(parsed.error), { status: 400 });
 *          }
 *          const widget = await createWidget(ctx, parsed.data); // schema-typed, no casts
 *          return NextResponse.json(widget, { status: 201 });
 *        } catch (err) {
 *          return errorResponse(err);
 *        }
 *      }
 *
 * 3. Error shape returned on 400 (zodErrorBody):
 *      { error: '<first issue, human readable>',
 *        code: 'VALIDATION',
 *        fields: { fieldName: ['message', ...] },         // zod flatten() fieldErrors
 *        issues: [{ path: 'lines.0.amount', message }] }  // full dotted paths for line grids
 *
 * 4. Shared field helpers (use these instead of re-rolling regexes):
 *      zUuid            — uuid string
 *      zMoney           — string|number decimal, max 2dp (money amounts)
 *      zMoneyPositive   — zMoney and > 0
 *      zDecimal         — string|number decimal, any precision (quantities, rates, fx)
 *      zDecimalPositive — zDecimal and > 0
 *      zDate            — ISO date string -> Date (invalid dates rejected)
 *      zLines(schema)   — non-empty array of line rows
 *
 * 5. For PATCH routes use `schema.partial()` (or a dedicated update schema):
 *    zod omits absent optional keys from the output object, which preserves the
 *    "key absent vs explicitly null" distinction services rely on.
 *
 * Keep validation structural (shape, types, formats). Business rules (tenancy,
 * balance, period-closed, RBAC) stay in the service layer, which still throws
 * ServiceError — routes map those exactly as before. Schemas use zod's default
 * "strip" mode so unknown keys are dropped, never forwarded to services.
 *
 * Adopted so far: accounts, customers, vendors, journal-entries, payments,
 * deposits, transfers, expenses, credit-memos, vendor-credits, estimates,
 * sales-receipts, company (+ closing-date), invoices (+ [id]), bills (+ [id]),
 * items (+ [id]), payroll (+ pay-runs), payroll-items (+ [id]), employees
 * (+ [id]), sales-orders (+ [id] actions), purchase-orders (+ [id] actions),
 * item-receipts (+ [id] actions), bill-payments, recurring (+ run),
 * time-entries (+ [id], bill), jobs (+ [id]), classes, locations, budgets
 * (+ [id]), fixed-assets (+ [id] depreciate), mileage.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export * from './helpers';
export * from './accounts';
export * from './billPayments';
export * from './bills';
export * from './budgets';
export * from './company';
export * from './creditMemos';
export * from './customers';
export * from './deposits';
export * from './dimensions';
export * from './employees';
export * from './estimates';
export * from './expenses';
export * from './fixedAssets';
export * from './invoices';
export * from './itemReceipts';
export * from './items';
export * from './jobs';
export * from './journal';
export * from './mileage';
export * from './payments';
export * from './payroll';
export * from './payrollItems';
export * from './purchaseOrders';
export * from './recurring';
export * from './salesOrders';
export * from './salesReceipts';
export * from './timeEntries';
export * from './transfers';
export * from './vendorCredits';
export * from './vendors';
export * from './inventorySites';
