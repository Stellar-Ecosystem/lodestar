'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function ServicesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[Lodestar Services Error Boundary]:', error);
  }, [error]);

  return (
    <div className="max-w-4xl mx-auto px-6 py-16 text-center">
      <div className="card p-8 max-w-lg mx-auto border-border shadow-card fade-in">
        <div className="w-10 h-10 rounded-full bg-error/10 text-error flex items-center justify-center mx-auto mb-4">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <span className="badge bg-error/10 text-error mb-3">Service Error</span>
        <h2 className="text-xl font-semibold mb-2">Unable to load Service Details</h2>
        <p className="text-secondary text-sm mb-6 leading-relaxed">
          Failed to retrieve details for this service from the contract. The service may be unregistered or the RPC connection timed out.
        </p>

        {error?.message && (
          <div className="bg-background border border-border rounded-lg p-3 text-left mb-6 font-mono text-xs text-secondary overflow-x-auto">
            {error.message}
          </div>
        )}

        <div className="flex items-center justify-center gap-3">
          <button onClick={() => reset()} className="btn-primary">
            Retry Loading Service
          </button>
          <Link href="/registry" className="btn-secondary">
            Back to Registry
          </Link>
        </div>
      </div>
    </div>
  );
}
