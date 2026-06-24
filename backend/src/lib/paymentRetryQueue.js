/**
 * In-memory retry queue for recordPaymentOnChain calls.
 *
 * When the on-chain record call fails (transient RPC error, timeout, etc.) the
 * score update is silently dropped — agents accumulate payments on-chain out of
 * sync with their real scores. This queue retries failed calls up to MAX_ATTEMPTS
 * with exponential backoff before giving up and logging a permanent failure.
 *
 * The queue is in-process only. Entries are lost on restart, which is acceptable:
 * a process restart is rare, and the alternative (SQLite/file persistence) adds
 * significant complexity. The queue handles transient RPC failures during normal
 * operation.
 */

import logger from './logger.js';

const MAX_ATTEMPTS = 5;
const INITIAL_DELAY_MS = 5_000;
const MAX_DELAY_MS = 80_000;
const POLL_INTERVAL_MS = 5_000;

let _nextId = 1;
const _queue = new Map(); // id → entry

let _timer = null;

function scheduleWorker() {
  if (_timer !== null) return;
  _timer = setInterval(processQueue, POLL_INTERVAL_MS);
  // Don't block process exit waiting for retries
  if (typeof _timer.unref === 'function') _timer.unref();
}

async function processQueue() {
  if (_queue.size === 0) return;
  const now = Date.now();
  for (const [id, entry] of _queue) {
    if (entry.nextRetryAt > now) continue;

    try {
      await entry.fn();
      logger.info(
        { id, agentAddress: entry.agentAddress, attempt: entry.attempts },
        'paymentRetryQueue: record succeeded on retry',
      );
      _queue.delete(id);
    } catch (err) {
      entry.attempts += 1;
      if (entry.attempts >= MAX_ATTEMPTS) {
        logger.error(
          { err, id, agentAddress: entry.agentAddress, attempts: entry.attempts },
          'paymentRetryQueue: giving up after max retries — agent score will drift',
        );
        _queue.delete(id);
      } else {
        const delay = Math.min(INITIAL_DELAY_MS * 2 ** (entry.attempts - 1), MAX_DELAY_MS);
        entry.nextRetryAt = Date.now() + delay;
        logger.warn(
          { err, id, agentAddress: entry.agentAddress, attempt: entry.attempts, retryInMs: delay },
          'paymentRetryQueue: retry scheduled',
        );
      }
    }
  }
}

/**
 * Enqueue a recordPaymentOnChain call for retry.
 *
 * @param {string} agentAddress - Used only for logging context
 * @param {() => Promise<void>} fn - The async function to retry
 */
export function enqueuePaymentRecord(agentAddress, fn) {
  const id = _nextId++;
  _queue.set(id, {
    id,
    agentAddress,
    fn,
    attempts: 1,
    nextRetryAt: Date.now() + INITIAL_DELAY_MS,
  });
  scheduleWorker();
  return id;
}

export function getQueueSize() {
  return _queue.size;
}
