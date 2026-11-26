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

`GET /healthz` returns **200** while the process is answering. `GET /api/health`
returns **200**, or **304** when `If-None-Match` selects the current representation
(see below). Readiness returns **200** when every required dependency is reachable
and **503** when one is not.

## Conditional GET

`GET /api/health` and `GET /api/metrics` send a weak `ETag` — `W/"` plus the
SHA-256 of the exact JSON bytes — and a `Cache-Control` header. `If-None-Match`
is evaluated at the route boundary with the weak comparison from RFC 9110.
`/healthz` does not take part: orchestrator probes should keep calling it, and
it always returns 200 with a body.

| `If-None-Match` | Status | Body |
| --- | --- | --- |
| The current validator, or the same opaque tag without `W/` | 304 | empty |
| A comma-separated list containing a match | 304 | empty |
| `*` | 304 | empty |
| Absent, empty, stale, or malformed | 200 | JSON representation |

A malformed validator is ignored rather than rejected. A list that also contains
a match still returns 304. `W/` is case-sensitive, so `w/"…"` does not match.

A **304** keeps the `ETag` and `Cache-Control` the **200** would have sent, and
it does not send `Content-Type`. It is not an error.

| Route | `Cache-Control` |
| --- | --- |
| `GET /api/health` | `public, max-age=<HEALTH_CACHE_TTL_SECONDS>, must-revalidate` |
| `GET /api/metrics` | `no-store` |

`no-store` still allows a client that kept the bytes to revalidate. Shared caches
must not store the metrics document.

### Status document

`GET /api/metrics` is the status document. `requests.health` counts health
representations served, **including 304**. `healthCache` is the cache status:
the lookup counters plus `enabled`, `ttlSeconds`, and `key`.

```json
{
  "requests": { "health": 2 },
  "upstreamTimeouts": { "total": 0, "byLabel": {} },
  "healthCache": {
    "lookups": 2,
    "hits": 1,
    "misses": 1,
    "errors": 0,
    "loads": 1,
    "hitRate": 0.5,
    "enabled": false,
    "ttlSeconds": 5,
    "key": "lodestar:health:v1"
  }
}
```

A health **304** increments `requests.health` and the cache counters the same way
a **200** does, because revalidation is still a cache lookup. An idempotent replay
counts as a served request and does not look the cache up again. A metrics **200**
or **304** does not change those counters, so the 304 and the next 200 describe
the same cache status and the same request counters.

### Errors

Health failures use the API error shape and do not reset request counters or
cache status:

| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `IDEMPOTENCY_KEY_INVALID` | `Idempotency-Key` is empty, too long, or not printable ASCII |
| 409 | `IDEMPOTENCY_CONFLICT` | A check with this key is already in flight |
| 500 | `HEALTH_ERROR` | The health payload could not be built |

```json
{ "error": "Health check failed", "code": "HEALTH_ERROR" }
```

`GET /api/metrics` returns 200 or 304 and does not use that error body.

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
