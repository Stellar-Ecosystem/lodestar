'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[Lodestar Global Error Boundary]:', error);
  }, [error]);

  return (
    <html lang="en">
      <body className="bg-background text-primary min-h-screen flex items-center justify-center p-6 font-sans">
        <div className="card p-8 max-w-lg w-full text-center border-border shadow-card">
          <div className="w-12 h-12 rounded-full bg-error/10 text-error flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <span className="badge bg-error/10 text-error mb-3">Fatal Error</span>
          <h1 className="text-xl font-semibold mb-2">Application Shell Error</h1>
          <p className="text-secondary text-sm mb-6">
            A critical error occurred while loading the application layout shell.
          </p>
          {error?.message && (
            <div className="bg-background border border-border rounded-lg p-3 text-left mb-6 font-mono text-xs text-secondary overflow-x-auto">
              {error.message}
            </div>
          )}
          <div className="flex justify-center gap-3">
            <button onClick={() => reset()} className="btn-primary">
              Reload Application
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
