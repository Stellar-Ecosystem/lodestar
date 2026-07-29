/**
 * Persistent idempotency store for the payment route using SQLite.
 *
 * Keys expire after TTL_MS (default 24 h). Entries are pruned lazily on
 * every lookup so the table never grows unboundedly during a normal workday.
 *
 * Lifecycle of a key:
 *   'pending'  — request is in-flight; a concurrent retry gets 409
 *   'complete' — request finished; replays cached response with 200
 *   'failed'   — request threw; replays the error response
 *
 * Using SQLite provides persistence across restarts and replicas, solving the
 * issue where in-memory storage would lose state on process restart or in
 * multi-replica deployments.
 */

import Database from 'better-sqlite3';
import config from '../config.js';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = config.idempotencyDbPath.startsWith('./')
  ? `${__dirname}/../../${config.idempotencyDbPath}`
  : config.idempotencyDbPath;

// Ensure the data directory exists
const dbDir = dirname(dbPath);
mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Create the idempotency table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS idempotency (
    key TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    result TEXT,
    expiresAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_expiresAt ON idempotency(expiresAt);
`);

/**
 * Validate that `key` is a non-empty string of at most 255 characters
 * containing only safe printable ASCII (printable minus control chars).
 * This mirrors the convention used by Stripe and most payment APIs.
 *
 * @param {string} key
 * @returns {boolean}
 */
export function isValidIdempotencyKey(key) {
  return (
    typeof key === 'string' &&
    key.length >= 1 &&
    key.length <= 255 &&
    /^[\x21-\x7E]+$/.test(key) // printable ASCII, no spaces/control chars
  );
}

/**
 * Remove entries whose TTL has passed.
 * Called on every lookup to avoid unbounded growth without a background timer.
 */
function purgeExpired() {
  const now = Date.now();
  const stmt = db.prepare('DELETE FROM idempotency WHERE expiresAt <= ?');
  stmt.run(now);
}

/**
 * Look up an existing entry for `key`.
 * Returns the entry if it exists and has not expired, otherwise `null`.
 *
 * @param {string} key
 * @returns {{ status: string, result: object | null } | null}
 */
export function getEntry(key) {
  purgeExpired();
  const stmt = db.prepare('SELECT status, result, expiresAt FROM idempotency WHERE key = ?');
  const row = stmt.get(key);
  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    const deleteStmt = db.prepare('DELETE FROM idempotency WHERE key = ?');
    deleteStmt.run(key);
    return null;
  }
  return {
    status: row.status,
    result: row.result ? JSON.parse(row.result) : null,
  };
}

/**
 * Reserve `key` as pending (in-flight).
 * Must only be called after confirming no live entry exists.
 *
 * @param {string} key
 */
export function markPending(key) {
  const stmt = db.prepare('INSERT INTO idempotency (key, status, result, expiresAt) VALUES (?, ?, ?, ?)');
  stmt.run(key, 'pending', null, Date.now() + TTL_MS);
}

/**
 * Resolve a pending key with a successful result.
 *
 * @param {string} key
 * @param {{ newScore: number }} result
 */
export function markComplete(key, result) {
  const stmt = db.prepare('UPDATE idempotency SET status = ?, result = ? WHERE key = ?');
  stmt.run('complete', JSON.stringify(result), key);
}

/**
 * Resolve a pending key with a failure result so retries get the same error.
 *
 * @param {string} key
 * @param {{ httpStatus: number, error: string, code: string }} result
 */
export function markFailed(key, result) {
  const stmt = db.prepare('UPDATE idempotency SET status = ?, result = ? WHERE key = ?');
  stmt.run('failed', JSON.stringify(result), key);
}

/** Exposed for testing only — resets internal state. */
export function _reset() {
  db.exec('DELETE FROM idempotency');
}
