# Liveness and Readiness

The backend exposes two probes that answer different questions (#841). Conflating
them makes an orchestrator route traffic to instances that cannot serve it, and
restart instances whose only problem is a slow upstream.

| Probe | Question | Failure means |
| --- | --- | --- |
| Liveness | Is this process running? | Restart the container |
| Readiness | Can it serve traffic right now? | Stop routing here; do **not** restart |

## Endpoints

| Path | Kind | Checks |
| --- | --- | --- |
| `GET /healthz` | liveness | Nothing external. Returns uptime, queue depth, pending transactions |
| `GET /api/health` | liveness | Nothing external. Returns network and contract id |
| `GET /readyz` | readiness | RPC, and Redis when configured |
| `GET /api/ready` | readiness | Same as `/readyz` |

Liveness always returns **200** while the process is answering. Readiness returns
**200** when every required dependency is reachable and **503** when one is not.

## Readiness semantics

| Dependency | Required | Rationale |
| --- | --- | --- |
| Stellar RPC | yes | Every registry read and write goes through it; without it the backend cannot serve |
| Redis | no | The rate limiter falls back to an in-memory store, so an outage degrades rather than disables the service |

Response:

```jsonc
{
  "ready": true,
  "status": "ready",          // ready | degraded | not_ready
  "checks": [
    { "name": "rpc",   "required": true,  "ok": true, "latencyMs": 42 },
    { "name": "redis", "required": false, "ok": false, "latencyMs": 2000,
      "error": "redis check timed out after 2000ms" }
  ],
  "timestamp": "2026-08-29T10:00:00.000Z"
}
```

`degraded` still returns 200 and keeps serving — only a failed **required**
dependency takes the instance out of rotation.

Every dependency check is bounded by `READINESS_TIMEOUT_MS` (default 2000 ms).
A probe that hangs is worse than one that fails: the orchestrator learns nothing
until its own timeout fires.

## Container wiring

`backend/Dockerfile` declares a `HEALTHCHECK` against **`/healthz`** — Docker
restarts an unhealthy container, so pointing it at readiness would turn a
dependency outage into a restart loop.

`docker-compose.yml` uses the same liveness check, and the frontend now waits on
`condition: service_healthy` rather than `service_started`, so it does not come up
against a backend that has not finished booting.

In an orchestrator that distinguishes the two (Kubernetes, ECS), wire the
liveness probe to `/healthz` and the readiness probe to `/readyz`.

## Health & Metrics Route Boundary Behavior

### `GET /api/health`

`GET /api/health` caches its JSON payload for `HEALTH_CACHE_TTL_SECONDS` (default 5s, Redis-backed when `REDIS_URL` is configured, in-process fallback otherwise) and emits `Cache-Control: public, max-age=<ttl>, must-revalidate` plus a weak `ETag` (`W/"<sha256>"`).

- **Conditional requests (`If-None-Match`)**: Evaluated at the route boundary using RFC 9110 weak comparison (matching weak or strong forms of the current ETag, comma-separated lists, or wildcard `*`). A match returns **`304 Not Modified`** with an empty body while preserving `ETag`, `Cache-Control`, and (on idempotent replay) `Idempotent-Replay: true`.
- **Status & error shapes**:
  - `200 OK`: `{ status, network, contractId, uptimeSeconds, timestamp }`
  - `304 Not Modified`: empty body (cache hit is still recorded on non-replayed requests; replayed `Idempotency-Key` requests do not perform an extra cache lookup)
  - `400 Bad Request`: `{ error, code: "IDEMPOTENCY_KEY_INVALID" }` — rejected before cache lookup; cache status and counters are unchanged
  - `409 Conflict`: `{ error, code: "IDEMPOTENCY_CONFLICT" }` — returned when the same `Idempotency-Key` is already in flight; cache status and counters are unchanged
  - `500 Internal Server Error`: `{ error: "Health check failed", code: "HEALTH_ERROR" }`

### `GET /api/metrics`

`GET /api/metrics` responds with `Cache-Control: no-store` and returns the live process-local request counters alongside the health cache configuration:

- `upstreamTimeouts`: `{ total, byLabel }`
- `healthCache`: `{ lookups, hits, misses, errors, loads, hitRate, enabled, ttlSeconds, key }`
