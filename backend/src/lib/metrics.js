/**
 * metrics.js — Prometheus instrumentation for the Lodestar backend.
 *
 * Exports a single prom-client Registry plus the individual metric objects
 * so that instrumentation sites (contract.js, index.js) can import only what
 * they need without reaching into the registry directly.
 *
 * Metric catalogue
 * ────────────────
 * lodestar_submit_queue_depth          Gauge     Current submit-queue depth (queued + in-flight)
 * lodestar_submission_duration_seconds Histogram End-to-end Soroban submission latency
 * lodestar_http_requests_total         Counter   HTTP requests by method, route, and status
 * lodestar_contract_errors_total       Counter   Contract-layer errors by error code
 *
 * All metric names and labels are documented in docs/metrics.md.
 */

import { Registry, Gauge, Histogram, Counter, collectDefaultMetrics } from 'prom-client';

// Use a dedicated registry so tests can create isolated instances and the
// default global registry is not polluted when the module is imported.
export const register = new Registry();

register.setDefaultLabels({ app: 'lodestar-backend' });

// ── Default Node.js / process metrics (CPU, memory, event-loop lag, etc.) ────
collectDefaultMetrics({ register });

// ── Submit-queue depth ────────────────────────────────────────────────────────

/**
 * Point-in-time depth of the Soroban transaction submit queue.
 * Includes both tasks waiting in the queue and the one currently executing.
 * Alert on sustained high values — a growing queue means the RPC is slow or
 * the backend is processing more transactions than it can handle.
 */
export const submitQueueDepth = new Gauge({
  name: 'lodestar_submit_queue_depth',
  help: 'Current depth of the Soroban transaction submit queue (queued + in-flight)',
  registers: [register],
});

// ── Submission latency histogram ─────────────────────────────────────────────

/**
 * End-to-end latency of a Soroban transaction submission, measured from the
 * moment the task enters _simulateAndSubmit to when getTransaction confirms
 * the result.  Labelled by operation so you can compare simulate_and_submit
 * (registry write) vs record_payment, etc.
 *
 * Buckets cover the typical range: 0.1 s (fast) → 60 s (near-timeout).
 */
export const submissionDuration = new Histogram({
  name: 'lodestar_submission_duration_seconds',
  help: 'End-to-end duration of a Soroban transaction submission in seconds',
  labelNames: ['operation', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60],
  registers: [register],
});

// ── Per-route HTTP request counter ───────────────────────────────────────────

/**
 * Total HTTP requests handled by the backend, labelled by HTTP method,
 * normalised route path, and response status code.
 *
 * Route is normalised to the Express pattern (e.g. /api/services/:id) so
 * cardinality stays bounded even with many distinct IDs in the URL.
 */
export const httpRequestsTotal = new Counter({
  name: 'lodestar_http_requests_total',
  help: 'Total HTTP requests handled, labelled by method, route, and status code',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

// ── Contract error counter ────────────────────────────────────────────────────

/**
 * Counts errors thrown by the contract layer, keyed by the error code string
 * defined in ContractError (SIMULATION_FAILED, TRANSACTION_FAILED,
 * TRANSACTION_TIMEOUT, RETURN_VALUE_PARSE_FAILED) plus a catch-all
 * UNKNOWN_ERROR bucket for unexpected throws.
 *
 * Use this to alert on a spike in TRANSACTION_FAILED or TRANSACTION_TIMEOUT
 * which indicates RPC instability or sequence-number races.
 */
export const contractErrorsTotal = new Counter({
  name: 'lodestar_contract_errors_total',
  help: 'Total contract-layer errors, labelled by error code',
  labelNames: ['code'],
  registers: [register],
});
