import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { ROUTE_METHOD_HEADER, ROUTE_PATH_HEADER } from '@/lib/permissions/headers';
import { isMobileReceiptPage } from '@/lib/receipts/mobilePath';

/**
 * Route protection. Edge-safe: only checks for the presence of the session cookie (signature is
 * verified in the Node runtime by lib/auth). Unauthenticated page requests are redirected to /login.
 *
 * Every request that continues (API and pages) is stamped with its pathname + method
 * (ROUTE_PATH_HEADER / ROUTE_METHOD_HEADER, overwriting any client-supplied value). getServerContext
 * reads the stamp to enforce the declarative permission map in lib/permissions/routes.ts — the
 * full session/permission checks live server-side.
 */
// '/unlock' must be public: it renders before login (the file-password gate below skips it),
// so the session gate must never bounce it to /login — that would loop on a fresh install.
const PUBLIC_PREFIXES = ['/login', '/signup', '/onboarding', '/reset-password', '/unlock'];

/** Continue, stamping the request with its (server-observed) path + method. */
function pass(req: NextRequest) {
  const h = new Headers(req.headers);
  h.set(ROUTE_PATH_HEADER, req.nextUrl.pathname);
  h.set(ROUTE_METHOD_HEADER, req.method);
  return NextResponse.next({ request: { headers: h } });
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // API routes: no redirects (handlers answer with JSON 401/403); just stamp for getServerContext.
  if (pathname === '/api' || pathname.startsWith('/api/')) return pass(req);

  // Employee self-service portal has its own session (bka_portal) and is exempt from the
  // company-file lock (employees authenticate with their own portal login).
  if (pathname === '/portal/login') return pass(req);
  if (pathname === '/portal' || pathname.startsWith('/portal/')) {
    if (!req.cookies.get('bka_portal')) {
      const url = req.nextUrl.clone();
      url.pathname = '/portal/login';
      return NextResponse.redirect(url);
    }
    return pass(req);
  }

  // Receipt capture phone page: opened from a QR code on a phone that has no session and can't
  // unlock the file. The page is static; the token in its URL is checked by its one API route
  // (/api/receipts/mobile/[token], mapped 'public'), which can only add receipts to one company.
  if (isMobileReceiptPage(pathname)) return pass(req);

  // Company-file lock (QB-style "open this file" password). If this launch hasn't been unlocked,
  // send page navigation to /unlock — which auto-passes instantly when no file password is set,
  // and otherwise prompts. This runs before the login gate so the file password comes first.
  // (getServerContext enforces the lock for API routes.)
  if (pathname !== '/unlock' && !req.cookies.get('bka_unlock')) {
    const url = req.nextUrl.clone();
    url.pathname = '/unlock';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (
    pathname === '/' ||
    PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))
  ) {
    return pass(req);
  }

  if (!req.cookies.get('bka_session')) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return pass(req);
}

// Run on API + page routes — exclude Next internals and static assets.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
