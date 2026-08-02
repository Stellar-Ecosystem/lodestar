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

export function recordActivity(entry) {
  const feed = loadFeed();
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

// Pagination bounds are consumed by the request schemas in `src/schemas/`,
// which is where `limit`/`offset` are now validated and clamped. This module
// owns the feed's storage; it no longer parses query params.