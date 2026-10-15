'use client';
/**
 * Last-resort error boundary: catches errors thrown by the ROOT layout itself.
 * It replaces <html>/<body>, so the app's global stylesheet may not be loaded —
 * everything here is inline-styled to render correctly regardless.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f7f9fc',
          fontFamily:
            "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 480,
            width: '100%',
            background: '#ffffff',
            borderRadius: 16,
            borderBottom: '4px solid #2f6df6',
            boxShadow: '0 20px 25px -5px rgba(11,31,58,0.1), 0 8px 10px -6px rgba(11,31,58,0.1)',
            padding: 32,
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 40, lineHeight: 1 }} aria-hidden>
            ⚠️
          </div>
          <h1 style={{ margin: '16px 0 0', fontSize: 24, fontWeight: 800, color: '#0b1f3a' }}>
            Ironbooks hit a snag
          </h1>
          <p style={{ margin: '8px 0 0', fontSize: 14, color: 'rgba(11,31,58,0.6)' }}>
            The application shell failed to load. Your company file on disk is not affected.
          </p>
          {error?.digest && (
            <p style={{ margin: '8px 0 0', fontSize: 12, color: 'rgba(11,31,58,0.4)', fontFamily: 'monospace' }}>
              Error reference: {error.digest}
            </p>
          )}
          <button
            onClick={() => reset()}
            style={{
              marginTop: 24,
              background: '#2f6df6',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '10px 20px',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Reload application
          </button>
        </div>
      </body>
    </html>
  );
}
