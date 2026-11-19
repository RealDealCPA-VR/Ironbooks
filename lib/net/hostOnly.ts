/**
 * Settings that make the HOST computer connect somewhere (an AI server address, a mail server,
 * the network policy) or that run a connection from it (a connection test, a model download, a
 * tailnet peer list) are changed only at the computer that holds the company file. Through
 * multi-user hosting a signed-in Admin on another computer could otherwise make the host reach
 * its own loopback and office network and read the error text back.
 *
 * "Remote" is the same test every other host-only route uses (lib/net/requestInfo.ts
 * originFromHeaders): a teammate through the multi-user proxy, or a program on this computer
 * outside the Ironbooks window. Reading the settings stays open to them (secrets hidden as
 * always); the pages show these controls read-only with HOST_ONLY_MESSAGE.
 */
import { NextResponse } from 'next/server';
import { originFromHeaders } from '@/lib/net/requestInfo';

export const HOST_ONLY_MESSAGE = 'This can only be changed on the computer that holds the company file.';
export const HOST_ONLY_ACTION_MESSAGE = 'This can only be done on the computer that holds the company file.';

type HeaderSource = { get(name: string): string | null };

/** True when the request did not come from the Ironbooks window on the host computer. */
export function isRemoteRequest(req: { headers: HeaderSource }): boolean {
  return originFromHeaders(req.headers).remote;
}

/** The 403 answer for a host-only change or action asked for from another computer. */
export function hostOnlyResponse(message: string = HOST_ONLY_MESSAGE): NextResponse {
  return NextResponse.json({ error: message, code: 'FORBIDDEN', details: { hostOnly: true } }, { status: 403 });
}
