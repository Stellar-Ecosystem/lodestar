'use client';

import { useState } from 'react';
import useSWR from 'swr';
import ServiceCard from '@/components/ServiceCard';
import ServiceCardSkeleton from '@/components/ServiceCardSkeleton';
import { fetchServices } from '@/lib/contract';
import { filterServices, sortServices } from '@/lib/registry';
import type { Category, SortOption } from '@/lib/types';

const CATEGORIES: { label: string; value: Category | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Search', value: 'search' },
  { label: 'Weather', value: 'weather' },
  { label: 'Finance', value: 'finance' },
  { label: 'AI', value: 'ai' },
  { label: 'Data', value: 'data' },
  { label: 'Compute', value: 'compute' },
];

const SORTS: { label: string; value: SortOption }[] = [
  { label: 'Newest', value: 'newest' },
  { label: 'Highest Reputation', value: 'reputation' },
  { label: 'Lowest Price', value: 'price' },
];

export default function RegistryPage() {
  const [activeCategory, setActive] = useState<Category | 'all'>('all');
  const [sort, setSort]             = useState<SortOption>('newest');
  const [query, setQuery]           = useState('');

  // SWR replaces the manual setInterval poll: it dedupes concurrent requests,
  // revalidates every 30s, and only re-renders when the returned data changes.
  const { data: services = [], isLoading: loading, error: swrError, mutate } = useSWR(
    ['services', activeCategory],
    () => fetchServices(activeCategory === 'all' ? undefined : activeCategory),
    { refreshInterval: 30_000, revalidateOnFocus: false, keepPreviousData: true }
  );

  const error = swrError
    ? swrError instanceof Error
      ? swrError.message
      : 'Failed to load'
    : null;

  const sorted = sortServices(services, sort);
  const filtered = filterServices(sorted, query);

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      {/* Header */}
      <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Service Registry</h1>
          <span className="badge bg-primary text-white mono">
            {filtered.length}
          </span>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by service name or description"
            className="w-full sm:w-80 border border-border rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortOption)}
            className="border border-border rounded-lg px-3 py-2 text-sm bg-background focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Category tabs */}
      <div className="flex flex-wrap gap-2 mb-8">
        {CATEGORIES.map((c) => (
          <button
            key={c.value}
            onClick={() => setActive(c.value)}
            className={`px-4 py-1.5 rounded-full text-sm border transition-colors ${
              activeCategory === c.value
                ? 'bg-primary text-white border-primary'
                : 'border-border text-secondary hover:border-primary hover:text-primary'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* Grid */}
      {loading ? (
        <div className="grid sm:grid-cols-2 gap-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <ServiceCardSkeleton key={i} />
          ))}
        </div>
      ) : error && services.length === 0 ? (
        <div className="card p-8 text-center">
          <p className="text-error text-sm mb-2">{error}</p>
          <button
            onClick={() => mutate()}
            aria-label="Retry"
            className="mt-3 px-4 py-2 text-sm rounded-lg border border-border bg-background hover:bg-border/40 transition-colors"
          >
            Retry
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-24 text-secondary">
          <p className="text-base font-medium">No services found</p>
          <p className="text-sm mt-2">
            {query.trim()
              ? `No services match "${query.trim()}". Try a different name or description keyword.`
              : activeCategory !== 'all'
                ? `No active services in the "${activeCategory}" category.`
                : 'The registry is empty. Be the first to register a service.'}
          </p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-5">
          {filtered.map((svc) => (
            <ServiceCard key={svc.id} service={svc} />
          ))}
        </div>
      )}
    </div>
  );
}
