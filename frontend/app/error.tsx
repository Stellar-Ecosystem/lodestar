'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[Lodestar Root Error Boundary]:', error);
  }, [error]);

  return (
    <div className="max-w-4xl mx-auto px-6 py-20 text-center">
      <div className="card p-8 md:p-12 max-w-xl mx-auto border-border shadow-card fade-in">
        <div className="w-12 h-12 rounded-full bg-error/10 text-error flex items-center justify-center mx-auto mb-6">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>

        <span className="badge bg-error/10 text-error mb-4">Application Error</span>

        <h2 className="text-2xl font-semibold tracking-tight text-primary mb-3">
          Something went wrong
        </h2>

        <p className="text-secondary text-sm mb-6 leading-relaxed">
          Lodestar encountered an unexpected error while rendering this page. This may be due to a temporary Soroban contract read failure, RPC node issue, or network disruption.
        </p>

        {error?.message && (
          <div className="bg-background border border-border rounded-lg p-3 text-left mb-6 font-mono text-xs text-secondary overflow-x-auto">
            <span className="text-primary font-medium">Diagnostic Error: </span>
            {error.message}
            {error.digest && <div className="text-secondary/70 mt-1">Digest: {error.digest}</div>}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={() => reset()}
            className="btn-primary"
          >
            Try again
          </button>
          <Link href="/registry" className="btn-secondary">
            Return to Registry
          </Link>
        </div>
      </div>
    </div>
  );
}
