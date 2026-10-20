# Lodestar Backend

## Rate Limiting

The backend uses `express-rate-limit` for anti-spam protection on public write endpoints (e.g., `POST /reputation/:id`, `POST /agents/register`).

### Deployment Considerations

By default, rate limiting uses an in-memory store, which means limits are applied per process. When running multiple replicas behind a load balancer, the effective limit is multiplied by the number of replicas.

To enforce limits in aggregate across multiple instances, configure a shared Redis store by setting the `REDIS_URL` environment variable.

## Build-tx caching

`Post /agents/:address/build-tx` caches the constructed transaction payload in Redis for a short TTL to avoid repeated R-PC round trips for identical reads. The default TTL is 15 seconds and is configurable via the `BUILD_TX_CACHE_TTL_SECONDS` environment variable (a positive integer number of seconds). Set `REDIS_URL` to enable the shared cache; if Redis is unavailable, the route falls back to building the transaction directly from the contract / R-PC.

Cache keys include the route path and the request parameters (address and relevant query options), so different requests never share an entry. Successful responses include a `Cache-Control` header with a short `max-age` matching the configured TTL and a weak `ETag`; a request whose `If-None-Match` matches the current response receives a `304` without rebuilding the transaction. Cache lookups and hit rates are emitted as structured `build_tx_cache` logs and exposed at `GET /agents/build-tx/metrics`.

## Demo-run caching

`POST /api/demo-run` caches the on-chain service record in Redis for 15 seconds by default (`DEMO_RUN_CACHE_TTL_SECONDS` overrides the positive-integer TTL). Set `REDIS_URL` to enable the shared cache; if Redis is unavailable, the route falls back to the contract lookup. The paid demo request and activity recording are never cached or skipped. Successful responses include a private `Cache-Control` header and a weak `ETag`; a matching `If-None-Match` receives `304` only after the demo run has executed. Cache lookups and hit rates are emitted as structured `demo_service_cache` logs and are available at `GET /api/demo-run/metrics`.

## Demo Scripts
 `scripts/demo/boost-scores.js` is a demo-only utility that inflates agent scores for UI demonstrations. It refuses to run unless `DEMO_MODE=true` and rejects any contract ID listed in `contract/deployments.json`. Do not use this script against a real deployment.
