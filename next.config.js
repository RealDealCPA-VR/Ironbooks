const path = require('node:path')

const isDev = process.env.NODE_ENV !== 'production'

/**
 * Content-Security-Policy (local-only data guarantee). Pages may load scripts, styles, fonts,
 * images and data only from the app itself — no CDNs, web fonts or analytics. The single
 * exception is Plaid Link (bank feeds), which the server only lets start once the company has
 * opted in to cloud bank feeds; the desktop shell additionally blocks *.plaid.com in the
 * renderer until then (electron/security.js). 'unsafe-inline' scripts are required by Next's
 * inline hydration payload; 'unsafe-eval' and ws: only in `next dev` (hot reload).
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''} https://cdn.plaid.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? ' ws: wss:' : ''} https://*.plaid.com`,
  "frame-src 'self' blob: https://*.plaid.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ')

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  // App version for the sidebar footer, from package.json (the version electron-updater compares).
  env: { NEXT_PUBLIC_APP_VERSION: require('./package.json').version },
  // 'standalone' emits .next/standalone/server.js which the Electron main process launches
  // as the desktop app's local backend (bundling the accounting engine + PGlite).
  output: 'standalone',
  // This app lives in a subfolder with a parent lockfile; pin the tracing root so the
  // standalone bundle is rooted at this project, not the parent directory.
  outputFileTracingRoot: path.join(__dirname),
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  // PGlite ships a wasm/native asset; keep it external so Next traces it for standalone.
  // pdfjs-dist (QuickBooks PDF report import) loads its worker module at runtime; bundling it
  // breaks that lookup, so it is required from node_modules as-is.
  serverExternalPackages: ['@electric-sql/pglite', 'pdfjs-dist'],
  // No "X-Powered-By: Next.js" fingerprint on a server that may be shared on the tailnet.
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

module.exports = nextConfig
