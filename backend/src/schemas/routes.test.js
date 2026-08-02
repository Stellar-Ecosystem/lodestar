import { describe, it, expect, vi } from 'vitest';

// The routers pull in config, the chain client, and the x402 stack at import
// time. None of that matters here — this suite only inspects how the routers
// are wired — so it is all stubbed out.
// A namespace that answers any named import with a stub. `then` must stay
// undefined, or `await import()` mistakes the namespace for a promise.
// Hoisted because `vi.mock` factories run before the module body.
const { anyExport } = vi.hoisted(() => ({
  anyExport: () =>
    new Proxy({}, { get: (_target, prop) => (prop === 'then' ? undefined : vi.fn()) }),
}));

vi.mock('../lib/contract.js', anyExport);
vi.mock('../lib/stellar.js', anyExport);
vi.mock('../lib/reputationHistory.js', () => ({ getReputationHistory: vi.fn() }));
vi.mock('../lib/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../config.js', () => ({
  default: {
    contract: { agentsId: 'CAAA' },
    server: { address: 'GAAA', secret: 'secret' },
    stellar: { rpcUrl: 'https://rpc.example', network: 'testnet' },
    rateLimit: { payment: { max: 10, windowMs: 1000 }, write: { max: 10, windowMs: 1000 } },
    x402: { facilitatorUrl: 'https://facilitator.example', weatherPrice: '0.001', searchPrice: '0.001', payTo: 'GAAA' },
    demoRun: { pollMaxWaitMs: 1, pollInitialDelayMs: 1, pollMaxDelayMs: 1 },
  },
}));
vi.mock('../middleware/rateLimiter.js', () => ({
  writeRateLimiter: () => (_req, _res, next) => next(),
}));
vi.mock('../middleware/paymentRateLimiter.js', () => ({
  paymentRateLimiter: () => (_req, _res, next) => next(),
}));
vi.mock('@x402/express', () => ({
  paymentMiddlewareFromConfig: () => (_req, _res, next) => next(),
}));
vi.mock('@x402/core/server', () => ({ HTTPFacilitatorClient: vi.fn(() => ({})) }));
vi.mock('@x402/core/client', () => ({ x402Client: vi.fn(() => ({ register: vi.fn() })), x402HTTPClient: vi.fn(() => ({})) }));
vi.mock('@x402/stellar', () => ({ createEd25519Signer: vi.fn() }));
vi.mock('@x402/stellar/exact/server', () => ({ ExactStellarScheme: vi.fn(() => ({})) }));
vi.mock('@x402/stellar/exact/client', () => ({ ExactStellarScheme: vi.fn(() => ({})) }));

const [{ routes: allRoutes }, agentsRouter, demoRouter, registryRouter, servicesRouter] =
  await Promise.all([
    import('./index.js'),
    import('../routes/agents.js').then((m) => m.default),
    import('../routes/demo.js').then((m) => m.default),
    import('../routes/registry.js').then((m) => m.default),
    import('../routes/services.js').then((m) => m.default),
  ]);

/**
 * Walk an Express router's stack and describe every route it registers:
 * `{ key: 'get /services/:id', validated: true }`.
 */
function registeredRoutes(router) {
  return router.stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route.methods).map((method) => ({
        method,
        path: layer.route.path,
        // `validate()` names its middleware, which is what makes this checkable.
        validated: layer.route.stack.some((h) => h.name === 'validateRequest'),
      })),
    );
}

const ROUTERS = {
  '/api': [registryRouter, agentsRouter, demoRouter],
  '/demo': [servicesRouter],
};

/** `get /api/services/:id` — the identity a route is matched on below. */
const key = ({ method, basePath, path }) => `${method} ${basePath}${path}`;

const registered = Object.entries(ROUTERS).flatMap(([basePath, routers]) =>
  routers.flatMap((router) =>
    registeredRoutes(router).map((route) => ({ ...route, basePath })),
  ),
);

const declared = allRoutes.map((route) => ({
  method: route.method,
  path: route.path,
  basePath: route.basePath,
  hasRequestSchema: Object.keys(route.request ?? {}).length > 0,
}));

describe('route schema coverage', () => {
  it('finds the routes at all (guards against a vacuous suite)', () => {
    expect(registered.length).toBeGreaterThanOrEqual(34);
    expect(declared.length).toBe(registered.length);
  });

  it('declares a schema for every route the routers register', () => {
    const declaredKeys = new Set(declared.map(key));
    const undeclared = registered.map(key).filter((k) => !declaredKeys.has(k));

    expect(undeclared).toEqual([]);
  });

  it('registers every route it declares a schema for', () => {
    const registeredKeys = new Set(registered.map(key));
    const missing = declared.map(key).filter((k) => !registeredKeys.has(k));

    expect(missing).toEqual([]);
  });

  it('runs the validation middleware on every route that accepts input', () => {
    const needsValidation = new Set(
      declared.filter((r) => r.hasRequestSchema).map(key),
    );
    const unvalidated = registered
      .filter((r) => needsValidation.has(key(r)) && !r.validated)
      .map(key);

    expect(unvalidated).toEqual([]);
  });
});
