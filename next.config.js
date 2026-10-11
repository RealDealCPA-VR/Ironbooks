const path = require('node:path')

/** @type {import('next').NextConfig} */
const nextConfig = {
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
}

module.exports = nextConfig
