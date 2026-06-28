// Activity feed — persisted to a JSON file so entries survive server restarts.
// Kept dependency-free so the feed/pagination logic is unit-testable in
// isolation from Express, x402, and runtime config.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ACTIVITY_FEED_DIR || join(__dirname, '../../data');
const FEED_FILE = join(DATA_DIR, 'activityFeed.json');

// Capacity of the feed and pagination bounds.
export const ACTIVITY_MAX_ENTRIES = 50;
export const ACTIVITY_DEFAULT_LIMIT = 20;
export const ACTIVITY_MAX_LIMIT = ACTIVITY_MAX_ENTRIES;

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadFeed() {
  ensureDataDir();
  if (!existsSync(FEED_FILE)) return [];
  const raw = readFileSync(FEED_FILE, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`[activityFeed] Feed file contains invalid format: expected array, got ${typeof parsed}`);
  }
  return parsed;
}

function saveFeed(feed) {
  ensureDataDir();
  writeFileSync(FEED_FILE, JSON.stringify(feed, null, 2), 'utf-8'); // let errors bubble up
}

const rawMax = Number(process.env.ACTIVITY_FEED_MAX_PER_AGENT);
const MAX_PER_AGENT = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : 5;

export function recordActivity(entry) {
  const feed = loadFeed();
  const agent = entry.agent || 'unknown';
  const maxPerAgent = MAX_PER_AGENT;

  // Count how many consecutive entries from the top belong to this agent
  let consecutive = 0;
  for (const e of feed) {
    if ((e.agent || 'unknown') === agent) {
      consecutive++;
    } else {
      break;
    }
  }

  // If this agent already has maxPerAgent consecutive entries at the top,
  // trim the block to maxPerAgent so no single agent monopolizes the
  // visible history. This also handles existing persisted feeds that may
  // already have more than maxPerAgent consecutive entries from one agent.
  if (consecutive >= maxPerAgent) {
    feed.splice(maxPerAgent - 1, consecutive - maxPerAgent + 1);
  }

  feed.unshift(entry);
  if (feed.length > ACTIVITY_MAX_ENTRIES) feed.pop();
  try {
    saveFeed(feed);
  } catch (err) {
    console.error('[activityFeed] Failed to persist feed:', err.message);
    throw err; // propagate so callers know persistence failed
  }
}

export function getActivityFeed() {
  try {
    return loadFeed();
  } catch (err) {
    console.error('[activityFeed] Failed to load feed:', err.message);
    throw err; // propagate so callers can handle appropriately
  }
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