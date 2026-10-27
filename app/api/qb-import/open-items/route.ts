/**
 * Open A/R and A/P conversion (QuickBooks cutover).
 *
 * GET  /api/qb-import/open-items — the proof: A/R control vs A/R aging, A/P control vs A/P aging.
 * POST /api/qb-import/open-items
 *   { action: 'preview' | 'import', file?: { name, data(base64) }, items?: OpenItem[],
 *     side?: 'ar' | 'ap', alreadyInGl?: boolean, arAccountId?, apAccountId?, createMissingNames? }
 *   preview — read the Open Invoices / Unpaid Bills report (xlsx / csv / pdf) or the typed-in
 *             balances and show what would be created (nothing is written);
 *   import  — create the invoices / credit memos / bills / vendor credits, netted against the
 *             General Ledger import when alreadyInGl (default), and return the proof.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { assertExclusiveAccess } from '@/lib/services/sessions';
import {
  arApReconciliation,
  importOpenItems,
  previewOpenItems,
  type OpenItemsInput,
} from '@/lib/services/openItemsImport';
import { requireJsonObject, routeError } from '@/lib/routeErrors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await arApReconciliation(ctx));
  } catch (err) {
    return routeError(err, 'qb-import/open-items');
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const body = (await requireJsonObject(req, { optional: true })) as OpenItemsInput & { action?: string };
    const input: OpenItemsInput = {
      file:
        body.file && typeof body.file === 'object'
          ? { name: String(body.file.name ?? ''), data: String(body.file.data ?? '') }
          : null,
      items: Array.isArray(body.items) ? body.items : null,
      side: body.side === 'ap' || body.side === 'ar' ? body.side : null,
      alreadyInGl: typeof body.alreadyInGl === 'boolean' ? body.alreadyInGl : undefined,
      arAccountId: typeof body.arAccountId === 'string' && body.arAccountId ? body.arAccountId : null,
      apAccountId: typeof body.apAccountId === 'string' && body.apAccountId ? body.apAccountId : null,
      createMissingNames: typeof body.createMissingNames === 'boolean' ? body.createMissingNames : undefined,
    };
    if (body.action === 'import') {
      // Bringing in documents changes the books: owner/admin, single-user while others are on.
      await assertExclusiveAccess(ctx, 'Import');
      return NextResponse.json(await importOpenItems(ctx, input));
    }
    return NextResponse.json(await previewOpenItems(ctx, input));
  } catch (err) {
    return routeError(err, 'qb-import/open-items');
  }
}
