import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.CONTRACT_ID = process.env.CONTRACT_ID ?? 'C'.repeat(56);
process.env.SERVER_STELLAR_ADDRESS = process.env.SERVER_STELLAR_ADDRESS ?? `G${'A'.repeat(55)}`;
process.env.SERVER_STELLAR_SECRET = process.env.SERVER_STELLAR_SECRET ?? 'S'.repeat(56);
process.env.STELLAR_RPC_URL = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
process.env.STELLAR_NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015';
process.env.FACILITATOR_URL = process.env.FACILITATOR_URL ?? 'https://www.x402.org/facilitator';
process.env.USDC_CONTRACT_ID = process.env.USDC_CONTRACT_ID ?? 'C'.repeat(56);

const { createListServicesCache } = await import('./contract.js');

const noopLogger = {
  debug() {},
};

test('listServices cache reuses fulfilled values until the TTL expires', async () => {
  let calls = 0;
  let time = 1000;
  const cachedListServices = createListServicesCache(
    async () => {
      calls += 1;
      return [{ id: calls, name: `service-${calls}` }];
    },
    { ttlMs: 5000, now: () => time, log: noopLogger }
  );

  assert.deepEqual(await cachedListServices(), [{ id: 1, name: 'service-1' }]);
  assert.deepEqual(await cachedListServices(), [{ id: 1, name: 'service-1' }]);
  assert.equal(calls, 1);

  time += 5001;

  assert.deepEqual(await cachedListServices(), [{ id: 2, name: 'service-2' }]);
  assert.equal(calls, 2);
});

test('listServices cache coalesces concurrent requests for the same category', async () => {
  let calls = 0;
  let resolveFetch;
  const fetchStarted = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const cachedListServices = createListServicesCache(
    async () => {
      calls += 1;
      await fetchStarted;
      return [{ id: 7, category: 'weather' }];
    },
    { ttlMs: 5000, now: () => 1000, log: noopLogger }
  );

  const first = cachedListServices('weather');
  const second = cachedListServices('weather');

  resolveFetch();

  assert.deepEqual(await Promise.all([first, second]), [
    [{ id: 7, category: 'weather' }],
    [{ id: 7, category: 'weather' }],
  ]);
  assert.equal(calls, 1);
});

test('listServices cache keeps categories isolated', async () => {
  const calls = [];
  const cachedListServices = createListServicesCache(
    async (category) => {
      calls.push(category ?? 'all');
      return [{ category: category ?? 'all' }];
    },
    { ttlMs: 5000, now: () => 1000, log: noopLogger }
  );

  assert.deepEqual(await cachedListServices(), [{ category: 'all' }]);
  assert.deepEqual(await cachedListServices('weather'), [{ category: 'weather' }]);
  assert.deepEqual(await cachedListServices('weather'), [{ category: 'weather' }]);
  assert.deepEqual(calls, ['all', 'weather']);
});

test('listServices cache clears failed in-flight requests so callers can retry', async () => {
  let calls = 0;
  const cachedListServices = createListServicesCache(
    async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('rpc unavailable');
      }
      return [{ id: 2 }];
    },
    { ttlMs: 5000, now: () => 1000, log: noopLogger }
  );

  await assert.rejects(() => cachedListServices(), /rpc unavailable/);
  assert.deepEqual(await cachedListServices(), [{ id: 2 }]);
  assert.equal(calls, 2);
});

test('listServices cache can be disabled with a zero TTL while still deduping in-flight calls', async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const cachedListServices = createListServicesCache(
    async () => {
      calls += 1;
      await pending;
      return [{ id: calls }];
    },
    { ttlMs: 0, now: () => 1000, log: noopLogger }
  );

  const first = cachedListServices();
  const second = cachedListServices();
  release();

  assert.deepEqual(await Promise.all([first, second]), [[{ id: 1 }], [{ id: 1 }]]);
  assert.deepEqual(await cachedListServices(), [{ id: 2 }]);
  assert.equal(calls, 2);
});

test('listServices cache invalidation prevents stale in-flight responses from being stored', async () => {
  let calls = 0;
  let releaseFirst;
  const firstPending = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const cachedListServices = createListServicesCache(
    async () => {
      calls += 1;
      if (calls === 1) {
        await firstPending;
      }
      return [{ id: calls }];
    },
    { ttlMs: 5000, now: () => 1000, log: noopLogger }
  );

  const first = cachedListServices();
  cachedListServices.clear();
  releaseFirst();

  assert.deepEqual(await first, [{ id: 1 }]);
  assert.deepEqual(await cachedListServices(), [{ id: 2 }]);
  assert.equal(calls, 2);
});

test('listServices cache stale in-flight success does not delete newer cached values', async () => {
  let calls = 0;
  let releaseFirst;
  const firstPending = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const cachedListServices = createListServicesCache(
    async () => {
      calls += 1;
      const id = calls;
      if (id === 1) {
        await firstPending;
      }
      return [{ id }];
    },
    { ttlMs: 5000, now: () => 1000, log: noopLogger }
  );

  const staleFirst = cachedListServices();
  cachedListServices.clear();

  assert.deepEqual(await cachedListServices(), [{ id: 2 }]);
  releaseFirst();
  assert.deepEqual(await staleFirst, [{ id: 1 }]);
  assert.deepEqual(await cachedListServices(), [{ id: 2 }]);
  assert.equal(calls, 2);
});

test('listServices cache stale in-flight failure does not delete newer cached values', async () => {
  let calls = 0;
  let rejectFirst;
  const firstPending = new Promise((_resolve, reject) => {
    rejectFirst = reject;
  });
  const cachedListServices = createListServicesCache(
    async () => {
      calls += 1;
      const id = calls;
      if (id === 1) {
        await firstPending;
      }
      return [{ id }];
    },
    { ttlMs: 5000, now: () => 1000, log: noopLogger }
  );

  const staleFirst = cachedListServices();
  cachedListServices.clear();

  assert.deepEqual(await cachedListServices(), [{ id: 2 }]);
  rejectFirst(new Error('stale rpc failure'));
  await assert.rejects(() => staleFirst, /stale rpc failure/);
  assert.deepEqual(await cachedListServices(), [{ id: 2 }]);
  assert.equal(calls, 2);
});
