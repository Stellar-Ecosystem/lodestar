# Lodestar Backend — Prometheus Metrics

The backend exposes a Prometheus scrape endpoint at **`GET /metrics`** in the standard text exposition format (version 0.0.4).

---

## Endpoint

```
GET /metrics
Content-Type: text/plain; version=0.0.4; charset=utf-8
```

No authentication is required.  If the backend is deployed behind a reverse proxy it is recommended to block external access to `/metrics` at the proxy layer.

---

## Metric Catalogue

### `lodestar_submit_queue_depth` — Gauge

Current depth of the Soroban transaction submit queue.  Counts both tasks waiting in the queue **and** the one task currently executing (concurrency = 1).

| Label | Description |
|-------|-------------|
| `app` | Always `lodestar-backend` (default label) |

**When to alert**: a value that stays above `2` for more than 30 seconds indicates the RPC is slow or the backend is handling more write operations than it can process sequentially.

---

### `lodestar_submission_duration_seconds` — Histogram

End-to-end duration of a Soroban transaction submission, from the moment `simulateAndSubmit` starts executing inside the queue to when `getTransaction` confirms the result (success or error).

| Label | Values | Description |
|-------|--------|-------------|
| `operation` | e.g. `register_service`, `record_payment`, `update_reputation`, `unknown` | Name of the contract operation being submitted |
| `status` | `success`, `error` | Whether the submission completed without a contract error |

**Buckets (seconds)**: `0.1, 0.5, 1, 2, 5, 10, 20, 30, 60`

**Derived metrics available**:
- `lodestar_submission_duration_seconds_count` — total number of submissions
- `lodestar_submission_duration_seconds_sum` — total accumulated duration
- `lodestar_submission_duration_seconds_bucket{le="..."}` — cumulative bucket counts

---

### `lodestar_http_requests_total` — Counter

Total HTTP requests handled by the backend since the last process start.

| Label | Description |
|-------|-------------|
| `method` | HTTP method (`GET`, `POST`, `DELETE`, …) |
| `route` | Express route pattern (e.g. `/api/services`, `/api/agents/:id`) — **not** the raw URL, so cardinality is bounded |
| `status` | HTTP response status code as a string (`"200"`, `"400"`, `"500"`, …) |

---

### `lodestar_contract_errors_total` — Counter

Contract-layer errors thrown inside `simulateAndSubmit`, keyed by error code.

| Label | Known values | Description |
|-------|-------------|-------------|
| `code` | `SIMULATION_FAILED` | Soroban simulation returned an error (bad input, insufficient balance, etc.) |
| | `TRANSACTION_FAILED` | `sendTransaction` returned ERROR or `getTransaction` returned FAILED |
| | `TRANSACTION_TIMEOUT` | Transaction was not confirmed after 20 polling attempts (~30 s) |
| | `RETURN_VALUE_PARSE_FAILED` | Transaction succeeded on-chain but the XDR return value could not be decoded |
| | `UNKNOWN_ERROR` | Any other unexpected throw from the submission path |

---

### Default Node.js / process metrics

`collectDefaultMetrics` is called on the same registry, so all standard prom-client process metrics are included (`process_cpu_seconds_total`, `nodejs_heap_size_used_bytes`, `nodejs_event_loop_lag_seconds`, etc.).

---

## Sample Prometheus Alert Rules

```yaml
# prometheus/alerts.yml
groups:
  - name: lodestar-backend
    rules:

      # Queue has been growing for 2 minutes — RPC may be degraded.
      - alert: LodestarSubmitQueueHigh
        expr: lodestar_submit_queue_depth > 5
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Lodestar submit queue depth is high ({{ $value }})"
          description: >
            The Soroban transaction submit queue has been above 5 for 2 minutes.
            This usually means the RPC endpoint is slow.  Check /healthz and
            the Stellar Horizon/Soroban status page.

      # Any transaction timeout in the last 5 minutes.
      - alert: LodestarTransactionTimeout
        expr: increase(lodestar_contract_errors_total{code="TRANSACTION_TIMEOUT"}[5m]) > 0
        labels:
          severity: warning
        annotations:
          summary: "Lodestar Soroban transaction timed out"
          description: >
            At least one Soroban transaction was not confirmed within the
            polling window.  The transaction may still confirm on-chain.
            Check pending-transactions.json on the backend host.

      # Sustained error rate across all contract operations.
      - alert: LodestarContractErrorRateHigh
        expr: >
          rate(lodestar_contract_errors_total[5m])
          / rate(lodestar_submission_duration_seconds_count[5m]) > 0.1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Lodestar contract error rate is above 10 %"
          description: >
            More than 10 % of Soroban submissions are failing.
            Check lodestar_contract_errors_total by code for the breakdown.

      # p95 submission latency above 15 s.
      - alert: LodestarSubmissionLatencyHigh
        expr: >
          histogram_quantile(0.95,
            rate(lodestar_submission_duration_seconds_bucket[5m])
          ) > 15
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Lodestar p95 submission latency is above 15 s"
          description: >
            The 95th-percentile Soroban submission latency exceeds 15 seconds.
            Normal latency is 2–5 s.  This may indicate RPC congestion or
            repeated txBAD_SEQ retries.
```

---

## Sample Grafana Queries

```promql
# Current queue depth
lodestar_submit_queue_depth

# p50 / p95 / p99 submission latency (last 5 min)
histogram_quantile(0.50, rate(lodestar_submission_duration_seconds_bucket[5m]))
histogram_quantile(0.95, rate(lodestar_submission_duration_seconds_bucket[5m]))
histogram_quantile(0.99, rate(lodestar_submission_duration_seconds_bucket[5m]))

# Submission throughput (successful submissions per second)
rate(lodestar_submission_duration_seconds_count{status="success"}[1m])

# Contract error rate by code
rate(lodestar_contract_errors_total[5m])

# HTTP request rate by route and status
rate(lodestar_http_requests_total[1m])

# HTTP error rate (5xx)
sum(rate(lodestar_http_requests_total{status=~"5.."}[5m])) by (route)
```

---

## Docker / Compose Scrape Config

If running with the agent `docker-compose.yml`, add a Prometheus service and scrape config:

```yaml
# prometheus/prometheus.yml
scrape_configs:
  - job_name: lodestar-backend
    static_configs:
      - targets: ["backend:3001"]
    metrics_path: /metrics
    scrape_interval: 15s
```
