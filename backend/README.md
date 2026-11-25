# Lodestar Backend

## Rate Limiting

The backend uses `express-rate-limit` for anti-spam protection on public write endpoints (e.g., `POST /reputation/:id`, `POST /agents/register`).

### Deployment Considerations

By default, rate limiting uses an in-memory store, which means limits are applied per process. When running multiple replicas behind a load balancer, the effective limit is multiplied by the number of replicas.

To enforce limits in aggregate across multiple instances, configure a shared Redis store by setting the `REDIS_URL` environment variable.

## Demo-run caching

`POST /api/demo-run` caches the on-chain service record in Redis for 15 seconds by default (`DEMO_RUN_CACHE_TTL_SECONDS` overrides the positive-integer TTL). Set `REDIS_URL` to enable the shared cache; if Redis is unavailable, the route falls back to the contract lookup. The paid demo request and activity recording are never cached or skipped. Successful responses include a private `Cache-Control` header and a weak `ETag`; a matching `If-None-Match` receives `304` only after the demo run has executed. Cache lookups and hit rates are emitted as structured `demo_service_cache` logs and are available at `GET /api/demo-run/metrics`.

## Request deadlines, caching and throttling

`POST /api/reputation/:id` gives up on a slow RPC node after `REPUTATION_TIMEOUT_MS` (default 20000) and answers `504 UPSTREAM_TIMEOUT`; the expiry is counted and exposed at `GET /api/metrics`. `GET /api/health` is cached for `HEALTH_CACHE_TTL_SECONDS` (default 5, Redis-backed when `REDIS_URL` is set), serves `Cache-Control` + `ETag`, answers a matching `If-None-Match` with `304`, and replays a repeat carrying the same `Idempotency-Key` for `HEALTH_IDEMPOTENCY_TTL_SECONDS` (default 300). `GET /demo/weather` is throttled by the shared limiter at `WEATHER_RATE_LIMIT_MAX` per `WEATHER_RATE_LIMIT_WINDOW_MS` (default 30 per 60 s per IP) and answers `429` with `Retry-After`.

## Demo Scripts

`scripts/demo/boost-scores.js` is a demo-only utility that inflates agent scores for UI demonstrations (supporting up to 100 agents on Stellar testnet). Before reading or signing any on-chain transaction, it validates `DEMO_MODE=true`, testnet network settings (`STELLAR_NETWORK=testnet`, `STELLAR_NETWORK_PASSPHRASE`, and non-mainnet `STELLAR_RPC_URL`), Stellar addresses (`SERVER_STELLAR_ADDRESS`, optional `PAYMENT_ADDRESS`, and `SERVER_STELLAR_SECRET` in live mode), token settings (`USDC_CONTRACT_ID`), and service/contract settings (`CONTRACT_ID`, `AGENTS_CONTRACT_ID`, optional `FACILITATOR_URL`), rejecting any contract ID listed in `contract/deployments.json` or `KNOWN_NON_DEMO_CONTRACT_IDS`. Invalid or mainnet configuration fails closed deterministically before reading or signing and never logs secret values. When seeding up to 100 agents on testnet, agents are ordered deterministically by `registered_at` (with `address` tie-breaking), `boost()` returns a structured summary (`processedCount`, `boostedCount`, `skippedCount`, `totalPayments`, and per-agent `results`), and re-runs are idempotent — agents already at or above their target score are skipped with `0` payments. Do not use this script against a real deployment.
