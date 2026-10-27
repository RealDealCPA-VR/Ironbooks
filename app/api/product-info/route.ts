/**
 * GET /api/product-info — QuickBooks' Product Information window (F2 / Ctrl+1,
 * components/ProductInfo.tsx): the version, the company file (its location and size — only to
 * this computer, never to teammates connected through multi-user hosting), and what it holds.
 *
 * Any member of the company (read-only; nothing here is a business record).
 */
import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { resolveDataDir } from '@/lib/db';
import { companyFilePath } from '@/lib/services/companyFileSave';
import { productInfoCounts } from '@/lib/services/productInfo';
import { getRequestOrigin } from '@/lib/net/requestInfo';
import { routeError } from '@/lib/routeErrors';

/** Total size of a file, or of every file under a folder (bytes); null when it can't be read. */
function sizeOf(p: string): number | null {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return null;
    let total = 0;
    const stack = [p];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) stack.push(full);
        else if (ent.isFile()) total += fs.statSync(full).size;
      }
    }
    return total;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const ctx = await getServerContext();
    const counts = await productInfoCounts(ctx);
    const { remote } = await getRequestOrigin();
    const file = companyFilePath();
    const location = file ?? resolveDataDir();
    return NextResponse.json({
      version: process.env.NEXT_PUBLIC_APP_VERSION ?? null,
      node: process.versions.node,
      database: 'PostgreSQL (PGlite, embedded)',
      singleFile: Boolean(file),
      fileName: path.basename(location),
      location: remote ? null : location,
      dataFolder: remote ? null : resolveDataDir(),
      sizeBytes: remote ? null : sizeOf(location),
      remote,
      counts,
    });
  } catch (err) {
    return routeError(err, 'product-info');
  }
}
