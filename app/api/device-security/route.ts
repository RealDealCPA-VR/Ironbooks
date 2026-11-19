/**
 * GET /api/device-security — { drive: 'encrypted' | 'not-encrypted' | 'unknown', fileProtected }
 *
 * Company > Security's quiet line about Windows drive encryption (lib/deviceSecurityText.ts): is
 * the drive holding the company file encrypted by Windows (lib/services/deviceSecurity.ts), and is
 * the file protected with passwords. Any signed-in member. The answer is about the computer that
 * holds the file, so a request from another computer gets 'unknown' without anything being run.
 * The page asks for this on its own after the rest has loaded: it never holds the page up.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { getServerContext } from '@/lib/context';
import { routeError } from '@/lib/routeErrors';
import { originFromHeaders } from '@/lib/net/requestInfo';
import { readProtection } from '@/lib/services/fileProtection';
import { driveEncryption } from '@/lib/services/deviceSecurity';
import type { DeviceSecurityDto } from '@/lib/deviceSecurityText';

export async function GET(req: NextRequest) {
  try {
    const ctx = await getServerContext();
    const fileProtected = Boolean(await readProtection(ctx.db));
    const drive = await driveEncryption({ remote: originFromHeaders(req.headers).remote });
    return NextResponse.json({ drive, fileProtected } satisfies DeviceSecurityDto);
  } catch (err) {
    return routeError(err, '/api/device-security');
  }
}
