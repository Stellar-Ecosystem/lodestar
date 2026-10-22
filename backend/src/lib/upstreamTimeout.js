/**
 * Deadline for upstream calls (#671).
 *
 * A slow or hanging RPC node must not hold a request open: one degraded
 * dependency then turns into a full outage, because every in-flight request
 * keeps its connection checked out of the pool until the client gives up.
 *
 * The Soroban SDK talks to the RPC node over axios and exposes no abort hook,
 * so the deadline cannot cancel the socket — it stops *waiting* for it. That
 * is exactly what the failure mode needs: the request is answered (504) and
 * the connection is released, while the abandoned call settles on its own
 * later and is discarded.
 */

import { UpstreamTimeoutError } from './contractErrors.js';
import { recordUpstreamTimeout } from './routeMetrics.js';
import logger from './logger.js';

/** Fallback deadline used when a caller does not supply one. */
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 20_000;

/**
 * Run `promise` under a deadline.
 *
 * On expiry the returned promise rejects with an `UpstreamTimeoutError`
 * (`code: 'UPSTREAM_TIMEOUT'`, HTTP 504) and the timeout is counted as a
 * metric so its frequency is visible.
 *
 * @template T
 * @param {Promise<T>} promise The upstream call to bound.
 * @param {{ timeoutMs?: number, label?: string }} [options]
 * @returns {Promise<T>}
 * @throws {UpstreamTimeoutError} when the deadline expires.
 */
export async function withUpstreamTimeout(promise, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const label = options.label ?? 'upstream';

  // The controller makes the deadline explicit: the abort is what marks the
  // call as abandoned, and it is handed to the caller through the error.
  const controller = new AbortController();

  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      recordUpstreamTimeout(label);
      logger.warn({ label, timeoutMs }, 'Upstream call exceeded its deadline');
      reject(
        new UpstreamTimeoutError(
          `Upstream call "${label}" timed out after ${timeoutMs}ms`,
          timeoutMs,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
