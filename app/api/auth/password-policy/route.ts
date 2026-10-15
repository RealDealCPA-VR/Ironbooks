/**
 * GET /api/auth/password-policy — the company file's password rules, so the sign-up, reset and
 * change-password forms can show them (gapsb K). Only the rules (lengths / switches / days) are
 * returned; nothing about any user. Edited by an Admin through /api/users/password-policy.
 */
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getPasswordPolicy } from '@/lib/services/passwordPolicy';
import { describePasswordPolicy } from '@/lib/passwordPolicy';
import { routeError } from '@/lib/routeErrors';

export async function GET() {
  try {
    const policy = await getPasswordPolicy(await getDb());
    return NextResponse.json({ ...policy, description: describePasswordPolicy(policy) });
  } catch (err) {
    return routeError(err, 'GET /api/auth/password-policy');
  }
}
