/**
 * GET /api/users/permissions-report — Users & Roles reports (QB Enterprise "View Permissions").
 *
 *   ?kind=roles      role permissions side by side (?keys=admin,bookkeeper; empty = every role)
 *   ?kind=users      users' effective permissions side by side (?keys=<user ids>; empty = all)
 *   ?kind=user_list  every user with roles, status, two-factor and last sign-in
 *   ?kind=role_list  every role with its description and who holds it
 *   &format=csv      download the report as CSV (needs the Print right of the report)
 *
 * Mapped to Users & Roles > View Permissions Reports (lib/permissions/routeActivities.ts).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { contentDisposition } from '@/lib/fileDownload';
import {
  PERMISSIONS_REPORT_KINDS,
  permissionsReportCsv,
  roleListReport,
  rolePermissionsReport,
  userListReport,
  userPermissionsReport,
  type PermissionsReportKind,
} from '@/lib/services/permissionReports';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const sp = req.nextUrl.searchParams;
    const kind = (sp.get('kind') ?? 'roles') as PermissionsReportKind;
    if (!PERMISSIONS_REPORT_KINDS.includes(kind)) {
      return NextResponse.json({ error: 'Pick a report: roles, users, user_list or role_list.', code: 'VALIDATION' }, { status: 400 });
    }
    const keys = (sp.get('keys') ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, 50);
    if (sp.get('format') === 'csv') {
      const { filename, csv } = await permissionsReportCsv(ctx, kind, keys);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': contentDisposition(filename),
          'Cache-Control': 'no-store',
        },
      });
    }
    if (kind === 'roles') return NextResponse.json(await rolePermissionsReport(ctx, keys));
    if (kind === 'users') return NextResponse.json(await userPermissionsReport(ctx, keys));
    if (kind === 'user_list') return NextResponse.json({ rows: await userListReport(ctx) });
    return NextResponse.json({ rows: await roleListReport(ctx) });
  } catch (err) {
    return routeError(err, 'GET /api/users/permissions-report');
  }
}
