// Activity feed — in-memory store for demo purposes.
// Kept dependency-free so the feed/pagination logic is unit-testable in
// isolation from Express, x402, and runtime config.

const activityFeed = [];

// Capacity of the in-memory feed and pagination bounds.
export const ACTIVITY_MAX_ENTRIES = 50;
export const ACTIVITY_DEFAULT_LIMIT = 20;
export const ACTIVITY_MAX_LIMIT = ACTIVITY_MAX_ENTRIES;

export function recordActivity(entry) {
  activityFeed.unshift(entry);
  if (activityFeed.length > ACTIVITY_MAX_ENTRIES) activityFeed.pop();
}

export function getActivityFeed() {
  return activityFeed;
}

/**
 * Validate and normalise `limit`/`offset` query params for the activity feed.
 * Missing params fall back to sane defaults; `limit` is clamped to ACTIVITY_MAX_LIMIT.
 * @param {Record<string, unknown>} [query]
 * @returns {{ limit: number, offset: number, errors: string[] }}
 */
export function parseActivityPagination(query = {}) {
  const errors = [];
  let limit = ACTIVITY_DEFAULT_LIMIT;
  let offset = 0;

  if (query.limit !== undefined) {
    const n = Number(query.limit);
    if (!Number.isInteger(n) || n < 1) {
      errors.push('`limit` must be a positive integer');
    } else {
      limit = Math.min(n, ACTIVITY_MAX_LIMIT);
    }
  }

  if (query.offset !== undefined) {
    const n = Number(query.offset);
    if (!Number.isInteger(n) || n < 0) {
      errors.push('`offset` must be a non-negative integer');
    } else {
      offset = n;
    }
  }

  return { limit, offset, errors };
}
