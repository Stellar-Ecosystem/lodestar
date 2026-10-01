'use client';

import { useEffect, useState } from 'react';
import type { ActivityEntry } from '@/lib/types';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const EXPLORER_URL =
  process.env.NEXT_PUBLIC_EXPLORER_URL ?? 'https://stellar.expert/explorer/testnet';

function truncate(s: string) {
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function timeAgo(iso: string) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export default function ActivityFeed() {
  const INITIAL_VISIBLE = 10;
  const LOAD_MORE_STEP = 10;

  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  async function load(isRetry = false) {
    if (isRetry) setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/demo/activity`);
      if (!res.ok) {
        throw new Error(`API returned status: ${res.status}`);
      }
      const data = (await res.json()) as { activity: ActivityEntry[] };
      setActivity(data.activity);
    } catch (err) {
      console.error(JSON.stringify({ event: 'activity_feed_fetch_failed', error: String(err) }));
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(() => load(), 5_000);
    return () => clearInterval(interval);
  }, []);

  const displayedActivities = activity.slice(0, visibleCount);
  const hasMore = visibleCount < activity.length;

  return (
    <div className="card p-6 h-full flex flex-col">
      <h2 className="font-semibold text-sm mb-4">Live Registry Activity</h2>

      {loading && activity.length === 0 && !error ? (
        <div data-testid="activity-feed-loading" className="flex-1 overflow-hidden space-y-3 pr-1" aria-busy="true">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="border border-border rounded-lg px-4 py-3 space-y-2 animate-pulse">
              <div className="flex items-center justify-between">
                <div className="h-3 w-20 bg-border/60 rounded" />
                <div className="h-3 w-12 bg-border/50 rounded" />
              </div>
              <div className="h-3.5 w-3/4 bg-border/50 rounded" />
              <div className="flex items-center justify-between pt-1">
                <div className="h-3 w-16 bg-border/60 rounded" />
                <div className="h-3 w-14 bg-border/50 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : error && activity.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-secondary text-sm gap-3">
          <p>Failed to load activity</p>
          <button 
            type="button" 
            onClick={() => load(true)} 
            className="btn-secondary text-xs py-1.5 px-4"
          >
            Retry
          </button>
        </div>
      ) : activity.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-secondary text-sm">
          No activity yet
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto space-y-3 pr-1" aria-live="polite" aria-atomic="false">
          {displayedActivities.map((entry, i) => (
            <div
              key={i}
              className="border border-border rounded-lg px-4 py-3 text-xs space-y-1 fade-in"
            >
              <div className="flex items-center justify-between">
                <span className="mono text-secondary">{truncate(entry.agent)}</span>
                <span className="text-secondary">{timeAgo(entry.timestamp)}</span>
              </div>
              <p className="font-medium text-sm truncate">{entry.service}</p>
              <div className="flex items-center justify-between">
                <span className="mono text-accent">${entry.amount} USDC</span>
                {entry.txHash && (
                  <a
                    href={`${EXPLORER_URL}/tx/${entry.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mono text-secondary hover:text-primary transition-colors"
                  >
                    {truncate(entry.txHash)}
                  </a>
                )}
              </div>
            </div>
          ))}
          {hasMore && (
            <div className="pt-2 pb-2 flex justify-center">
              <button
                type="button"
                onClick={() => setVisibleCount((prev) => prev + LOAD_MORE_STEP)}
                disabled={loading}
                className="btn-primary text-xs py-1.5 px-4"
                aria-label="Show more activity entries"
              >
                Show More
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
