# Lodestar Backend

## Rate Limiting

The backend uses `express-rate-limit` for anti-spam protection on public write endpoints (e.g., `POST /reputation/:id`, `POST /agents/register`).

### Deployment Considerations

By default, rate limiting uses an in-memory store, which means limits are applied per process. When running multiple replicas behind a load balancer, the effective limit is multiplied by the number of replicas.

To enforce limits in aggregate across multiple instances, configure a shared Redis store by setting the `REDIS_URL` environment variable.

## Demo-run caching

`POST /api/demo-run` caches the on-chain service record in Redis for 15 seconds by default (`DEMO_RUN_CACHE_TTL_SECONDS` overrides the positive-integer TTL). Set `REDIS_URL` to enable the shared cache; if Redis is unavailable, the route falls back to the contract lookup. The paid demo request and activity recording are never cached or skipped. Successful responses include a private `Cache-Control` header and a weak `ETag`; a matching `If-None-Match` receives `304` only after the demo run has executed. Cache lookups and hit rates are emitted as structured `demo_service_cache` logs and are available at `GET /api/demo-run/metrics`.

## Registry provider caching

`GET /api/registry/by-provider/:address` caches provider service listings in Redis for 30 seconds by default (`REGISTRY_CACHE_TTL_SECONDS` overrides the positive-integer TTL). Set `REDIS_URL` to enable the shared cache; if Redis is unavailable, the route falls back to querying the contract and Stellar RPC directly. Successful responses include a `Cache-Control: public, max-age=<ttl>, must-revalidate` header and a weak `ETag`. Conditional requests with a matching `If-None-Match` receive `304 Not Modified` without querying RPC. Cache lookups, hits, misses, and hit rate are emitted as structured `provider_services_cache` logs and are available at `GET /api/registry/metrics` and `GET /api/registry/by-provider/metrics`.

## Demo Scripts

`scripts/demo/boost-scores.js` is a demo-only utility that inflates agent scores for UI demonstrations. It refuses to run unless `DEMO_MODE=true` and rejects any contract ID listed in `contract/deployments.json`. Do not use this script against a real deployment.
