/**
 * The phone upload page path (receipt capture). Edge-safe and pure: middleware.ts uses it to let
 * exactly this page through without a session, and the Receipts page uses it to build the QR link.
 */
export const MOBILE_RECEIPT_PREFIX = '/m/receipt/';

/** /m/receipt/<token> — exactly one path segment of token characters, nothing else. */
export function isMobileReceiptPage(pathname: string): boolean {
  return /^\/m\/receipt\/[A-Za-z0-9_-]{1,128}\/?$/.test(pathname);
}

/** Full phone link for a token on a given origin (e.g. https://office-pc.tail1234.ts.net:8443). */
export function mobileReceiptUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}${MOBILE_RECEIPT_PREFIX}${encodeURIComponent(token)}`;
}
