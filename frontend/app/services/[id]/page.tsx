'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import type { ServiceEntry, Category } from '@/lib/types';
import { fetchServiceById, submitReputation } from '@/lib/contract';

const EXPLORER_URL =
  process.env.NEXT_PUBLIC_EXPLORER_URL ?? 'https://stellar.expert/explorer/testnet';

const CATEGORY_COLORS: Record<Category, string> = {
  search:  'bg-blue-50 text-blue-700',
  weather: 'bg-sky-50 text-sky-700',
  finance: 'bg-emerald-50 text-emerald-700',
  ai:      'bg-violet-50 text-violet-700',
  data:    'bg-amber-50 text-amber-700',
  compute: 'bg-rose-50 text-rose-700',
};

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-background rounded-lg px-4 py-3 border border-border">
      <div className="text-xs text-secondary mb-1">{label}</div>
      <div className="text-sm font-medium mono">{value}</div>
    </div>
  );
}

export default function ServiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [service, setService] = useState<ServiceEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reputation, setReputation] = useState(0);
  const [voting, setVoting] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const svc = await fetchServiceById(Number(id));
      setService(svc);
      setReputation(svc.reputation);
    } catch {
      setError('Service not found');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function vote(positive: boolean) {
    if (voting || !service) return;
    setVoting(true);
    try {
      const res = await submitReputation(service.id, positive);
      setReputation(res.newReputation);
    } catch {
      // ignore
    } finally {
      setVoting(false);
    }
  }

  function copyEndpoint() {
    if (!service) return;
    navigator.clipboard.writeText(service.endpoint);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-12">
        <div className="card p-8 h-64 animate-pulse bg-border/40" />
      </div>
    );
  }

  if (error || !service) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-24 text-center">
        <p className="text-error text-sm mb-4">{error ?? 'Service not found'}</p>
        <Link href="/registry" className="btn-secondary px-5 py-2.5 text-sm">
          Back to registry
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-12">
      <Link
        href="/registry"
        className="text-sm text-secondary hover:text-primary transition-colors mb-8 inline-block"
      >
        ← All services
      </Link>

      <div className="card p-8 flex flex-col gap-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight mb-1">{service.name}</h1>
            {!service.active && (
              <span className="text-xs text-error font-medium">Inactive</span>
            )}
          </div>
          <span className={`badge shrink-0 ${CATEGORY_COLORS[service.category] ?? 'bg-gray-50 text-gray-700'}`}>
            {service.category}
          </span>
        </div>

        {/* Description */}
        <p className="text-sm text-secondary leading-relaxed">{service.description}</p>

        {/* Endpoint */}
        <div>
          <p className="text-xs font-medium text-secondary uppercase tracking-wide mb-2">Endpoint</p>
          <div className="flex items-center gap-2 bg-background rounded-lg px-3 py-2.5 border border-border">
            <span className="mono text-xs text-primary truncate flex-1">{service.endpoint}</span>
            <button
              onClick={copyEndpoint}
              className="text-xs text-secondary hover:text-primary transition-colors shrink-0"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        {/* Meta grid */}
        <div className="grid grid-cols-2 gap-3">
          <MetaRow label="Price" value={`$${service.price_usdc} USDC`} />
          <MetaRow label="Registered at ledger" value={`#${service.registered_at.toLocaleString()}`} />
          <MetaRow
            label="Provider"
            value={
              <a
                href={`${EXPLORER_URL}/account/${service.provider}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline"
              >
                {service.provider.slice(0, 8)}…{service.provider.slice(-6)}
              </a>
            }
          />
          <MetaRow label="Status" value={service.active ? 'Active' : 'Inactive'} />
        </div>

        {/* Reputation */}
        <div className="border-t border-border pt-5">
          <p className="text-xs font-medium text-secondary uppercase tracking-wide mb-3">Reputation</p>
          <div className="flex items-center gap-4">
            <span className={`text-2xl font-semibold mono ${reputation > 0 ? 'text-success' : reputation < 0 ? 'text-error' : 'text-secondary'}`}>
              {reputation > 0 ? '+' : ''}{reputation}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => vote(false)}
                disabled={voting}
                className="btn-secondary px-4 py-2 text-sm text-error border-error/30 hover:bg-error/5 disabled:opacity-40"
              >
                − Downvote
              </button>
              <button
                onClick={() => vote(true)}
                disabled={voting}
                className="btn-secondary px-4 py-2 text-sm text-success border-success/30 hover:bg-success/5 disabled:opacity-40"
              >
                + Upvote
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
