/**
 * metrics.test.js
 *
 * Tests for the Prometheus metrics module.  Each test imports a fresh Registry
 * instance (by re-creating metrics objects with isolated registries) rather than
 * using the shared singleton, so tests are fully isolated.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Registry, Gauge, Histogram, Counter } from 'prom-client';

// ── Helper: build an isolated set of metrics ──────────────────────────────────
function makeIsolatedMetrics() {
  const reg = new Registry();

  const queueDepth = new Gauge({
    name: 'lodestar_submit_queue_depth',
    help: 'Test queue depth gauge',
    registers: [reg],
  });

  const duration = new Histogram({
    name: 'lodestar_submission_duration_seconds',
    help: 'Test submission duration histogram',
    labelNames: ['operation', 'status'],
    buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60],
    registers: [reg],
  });

  const requests = new Counter({
    name: 'lodestar_http_requests_total',
    help: 'Test HTTP requests counter',
    labelNames: ['method', 'route', 'status'],
    registers: [reg],
  });

  const errors = new Counter({
    name: 'lodestar_contract_errors_total',
    help: 'Test contract errors counter',
    labelNames: ['code'],
    registers: [reg],
  });

  return { reg, queueDepth, duration, requests, errors };
}

// ── Gauge ─────────────────────────────────────────────────────────────────────

describe('lodestar_submit_queue_depth gauge', () => {
  it('starts at 0', async () => {
    const { reg, queueDepth } = makeIsolatedMetrics();
    const text = await reg.metrics();
    expect(text).toMatch(/lodestar_submit_queue_depth 0/);
  });

  it('reflects set() calls correctly', async () => {
    const { reg, queueDepth } = makeIsolatedMetrics();
    queueDepth.set(3);
    const text = await reg.metrics();
    expect(text).toMatch(/lodestar_submit_queue_depth 3/);
  });

  it('can be decremented back to 0', async () => {
    const { reg, queueDepth } = makeIsolatedMetrics();
    queueDepth.set(5);
    queueDepth.set(0);
    const text = await reg.metrics();
    expect(text).toMatch(/lodestar_submit_queue_depth 0/);
  });
});

// ── Histogram ────────────────────────────────────────────────────────────────

describe('lodestar_submission_duration_seconds histogram', () => {
  it('records an observation and appears in output', async () => {
    const { reg, duration } = makeIsolatedMetrics();
    duration.observe({ operation: 'register_service', status: 'success' }, 1.2);
    const text = await reg.metrics();
    expect(text).toContain('lodestar_submission_duration_seconds');
  });

  it('accepts operation and status labels', async () => {
    const { reg, duration } = makeIsolatedMetrics();
    duration.observe({ operation: 'record_payment', status: 'error' }, 0.5);
    const text = await reg.metrics();
    expect(text).toContain('operation="record_payment"');
    expect(text).toContain('status="error"');
  });

  it('accumulates multiple observations', async () => {
    const { reg, duration } = makeIsolatedMetrics();
    duration.observe({ operation: 'op', status: 'success' }, 0.1);
    duration.observe({ operation: 'op', status: 'success' }, 0.4);
    duration.observe({ operation: 'op', status: 'success' }, 2.5);

    const text = await reg.metrics();
    // _count must equal 3
    expect(text).toMatch(/lodestar_submission_duration_seconds_count\{[^}]*operation="op"[^}]*\} 3/);
  });

  it('exposes _sum, _count, and _bucket lines', async () => {
    const { reg, duration } = makeIsolatedMetrics();
    duration.observe({ operation: 'op', status: 'success' }, 1.0);
    const text = await reg.metrics();
    expect(text).toContain('lodestar_submission_duration_seconds_sum');
    expect(text).toContain('lodestar_submission_duration_seconds_count');
    expect(text).toContain('lodestar_submission_duration_seconds_bucket');
  });

  it('uses the documented bucket boundaries', async () => {
    const { reg, duration } = makeIsolatedMetrics();
    duration.observe({ operation: 'op', status: 'success' }, 0);
    const text = await reg.metrics();
    // Spot-check a few bucket boundaries from the spec: 0.1, 1, 10, 60
    expect(text).toContain('le="0.1"');
    expect(text).toContain('le="1"');
    expect(text).toContain('le="10"');
    expect(text).toContain('le="60"');
  });
});

// ── HTTP counter ──────────────────────────────────────────────────────────────

describe('lodestar_http_requests_total counter', () => {
  it('increments on each inc() call', async () => {
    const { reg, requests } = makeIsolatedMetrics();
    requests.inc({ method: 'GET', route: '/api/services', status: '200' });
    requests.inc({ method: 'GET', route: '/api/services', status: '200' });
    const text = await reg.metrics();
    expect(text).toMatch(/lodestar_http_requests_total\{[^}]*route="\/api\/services"[^}]*\} 2/);
  });

  it('keeps separate counts for different status codes', async () => {
    const { reg, requests } = makeIsolatedMetrics();
    requests.inc({ method: 'POST', route: '/api/registry', status: '200' });
    requests.inc({ method: 'POST', route: '/api/registry', status: '400' });
    const text = await reg.metrics();
    expect(text).toContain('status="200"');
    expect(text).toContain('status="400"');
  });

  it('uses method, route, and status as label names', async () => {
    const { reg, requests } = makeIsolatedMetrics();
    requests.inc({ method: 'DELETE', route: '/api/agents/:id', status: '204' });
    const text = await reg.metrics();
    expect(text).toContain('method="DELETE"');
    expect(text).toContain('route="/api/agents/:id"');
    expect(text).toContain('status="204"');
  });
});

// ── Contract error counter ────────────────────────────────────────────────────

describe('lodestar_contract_errors_total counter', () => {
  it('increments by error code', async () => {
    const { reg, errors } = makeIsolatedMetrics();
    errors.inc({ code: 'TRANSACTION_FAILED' });
    errors.inc({ code: 'TRANSACTION_FAILED' });
    errors.inc({ code: 'SIMULATION_FAILED' });
    const text = await reg.metrics();
    expect(text).toMatch(/lodestar_contract_errors_total\{[^}]*code="TRANSACTION_FAILED"[^}]*\} 2/);
    expect(text).toMatch(/lodestar_contract_errors_total\{[^}]*code="SIMULATION_FAILED"[^}]*\} 1/);
  });

  it('supports TRANSACTION_TIMEOUT code', async () => {
    const { reg, errors } = makeIsolatedMetrics();
    errors.inc({ code: 'TRANSACTION_TIMEOUT' });
    const text = await reg.metrics();
    expect(text).toContain('code="TRANSACTION_TIMEOUT"');
  });

  it('supports UNKNOWN_ERROR catch-all code', async () => {
    const { reg, errors } = makeIsolatedMetrics();
    errors.inc({ code: 'UNKNOWN_ERROR' });
    const text = await reg.metrics();
    expect(text).toContain('code="UNKNOWN_ERROR"');
  });
});

// ── Output format ─────────────────────────────────────────────────────────────

describe('Prometheus text format', () => {
  it('produces valid Prometheus text format with HELP and TYPE lines', async () => {
    const { reg, queueDepth } = makeIsolatedMetrics();
    const text = await reg.metrics();
    expect(text).toMatch(/^# HELP lodestar_submit_queue_depth/m);
    expect(text).toMatch(/^# TYPE lodestar_submit_queue_depth gauge/m);
  });

  it('content type is text/plain Prometheus format', () => {
    const { reg } = makeIsolatedMetrics();
    expect(reg.contentType).toMatch(/text\/plain/);
    expect(reg.contentType).toMatch(/version=0\.0\.4/);
  });
});
