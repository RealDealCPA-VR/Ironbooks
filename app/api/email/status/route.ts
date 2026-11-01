/**
 * GET /api/email/status
 *
 * Whether this company can send email, so the screens can offer Email or explain how to set it up.
 * prefsperms: the mail server is set up in the company file (Preferences > Send Forms); this
 * computer's SMTP environment variables are the fallback. Any member may ask (it says nothing
 * secret): { configured, source: 'file' | 'environment' | 'none', fromEmail, useSenderAddress }.
 */
import { NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { getEmailStatus } from '@/lib/services/emailSettings';
import { routeError } from '@/lib/routeErrors';

export async function GET() {
  try {
    const ctx = await getServerContext();
    return NextResponse.json(await getEmailStatus(ctx));
  } catch (err) {
    return routeError(err, 'GET /api/email/status');
  }
}
