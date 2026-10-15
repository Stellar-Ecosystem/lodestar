import pkg from "@stellar/stellar-sdk";
const { rpc, Networks, Keypair } = pkg;
import config from "../config.js";
import logger from "./logger.js";
import { RpcThrottledError } from "./contractErrors.js";

let _server = null;

/**
 * Heuristic to decide whether an RPC error is transient and worth retrying.
 *
 * Public Stellar RPC endpoints return 429 when rate-limited and 5xx on
 * infrastructure blips. Network-level errors (ECONNRESET, ETIMEDOUT, etc.)
 * are also transient. All of these are safe to retry on Soroban reads and
 * idempotent sends.
 */
function isRetryableRpcError(err) {
  if (!err) return false;

  // Direct HTTP status on the error object (common in axios/fetch wrappers)
  const status = err.status ?? err.response?.status;
  if (status === 429 || (status >= 500 && status < 600)) return true;

  // Status buried in a nested response body (Stellar SDK shape)
  if (err.response?.data?.status) {
    const s = err.response.data.status;
    if (s === 429 || (s >= 500 && s < 600)) return true;
  }

  // Message-based detection for libraries that fold status into the message
  const msg = (err.message ?? '').toLowerCase();
  if (/\b429\b/.test(msg)) return true;
  if (/\b5\d{2}\b/.test(msg)) return true;

  // Network-level transient errors
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' ||
      err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' ||
      err.code === 'EPIPE') return true;

  return false;
}

/**
 * Jittered exponential backoff helper.
 *
 * @param {number} attempt - zero-based attempt index
 * @param {number} baseDelayMs
 * @param {number} maxDelayMs
 * @returns {number} delay in milliseconds
 */
function backoffDelay(attempt, baseDelayMs, maxDelayMs) {
  const exponential = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  // ±50 % jitter spreads retries across the rate-limit window so concurrent
  // requests don't all land on the same tick and re-trigger the throttle.
  const jitter = 0.5 + Math.random();
  return Math.round(exponential * jitter);
}

/**
 * Call `fn` with jittered exponential backoff on retryable errors.
 *
 * @param {() => Promise<any>} fn - the RPC call to execute
 * @param {string} methodName - RPC method name (for log context)
 * @param {number} maxRetries
 * @param {number} baseDelayMs
 * @param {number} maxDelayMs
 * @returns {Promise<any>}
 * @throws {RpcThrottledError} when the retry budget is exhausted
 */
async function withRpcRetry(fn, methodName, maxRetries, baseDelayMs, maxDelayMs) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (!isRetryableRpcError(err) || attempt >= maxRetries) {
        // Re-throw non-retryable errors immediately — only wrap exhausted
        // retries in RpcThrottledError.
        if (!isRetryableRpcError(err)) {
          throw err;
        }
        break;
      }

      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      logger.warn(
        {
          method: methodName,
          attempt: attempt + 1,
          maxRetries,
          delayMs: delay,
          error: err.message ?? String(err),
        },
        'Retrying RPC call after transient error',
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  logger.error(
    {
      method: methodName,
      attempts: maxRetries + 1,
      error: lastError?.message ?? String(lastError),
    },
    'RPC call failed after exhausting retries',
  );

  throw new RpcThrottledError(
    `RPC call '${methodName}' failed after ${maxRetries + 1} attempt(s): ${lastError?.message ?? String(lastError)}`,
    maxRetries + 1,
    lastError,
  );
}

/**
 * Wrap a Stellar RPC server instance with retry logic so every method call
 * gets jittered exponential backoff on transient 429/5xx failures.
 */
function createRetryingServer(server, opts = {}) {
  const maxRetries = opts.maxRetries ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const maxDelayMs = opts.maxDelayMs ?? 5_000;
  return new Proxy(server, {
    get(target, propKey) {
      const origValue = Reflect.get(target, propKey, target);
      if (typeof origValue === 'function') {
        return function (...args) {
          return withRpcRetry(
            () => origValue.apply(target, args),
            String(propKey),
            maxRetries,
            baseDelayMs,
            maxDelayMs,
          );
        };
      }
      return origValue;
    },
  });
}

/**
 * Return the singleton Stellar RPC server, creating it on first call.
 *
 * The instance is wrapped with jittered exponential backoff so every method
 * transparently retries on transient 429 / 5xx failures (see `config.rpcRetry`
 * for the default limits: up to 4 retries, 200 ms base delay, 5 s cap).
 *
 * **Concurrency**: safe to call concurrently. The lazy-init check is
 * synchronous and single-threaded (Node.js event loop), so two concurrent
 * callers cannot create two separate server instances — the second caller
 * will see the instance set by the first.
 *
 * @returns {rpc.Server} The retry-wrapped Stellar RPC server instance.
 */
export function getStellarServer() {
  if (!_server) {
    const rawServer = new rpc.Server(config.stellar.rpcUrl, {
      allowHttp: config.stellar.rpcUrl.startsWith("http://"),
    });
    _server = createRetryingServer(rawServer, config.rpcRetry);
  }
  return _server;
}

/**
 * Reset the singleton server instance back to `null`.
 *
 * **Not part of the public API.** Exported exclusively so test suites can
 * isolate each test case by forcing `getStellarServer` to construct a fresh
 * instance on its next call. Never call this in production code.
 *
 * **Concurrency**: not concurrency-safe. Tests that call this function must
 * ensure no concurrent code is holding a reference to the old server or
 * calling `getStellarServer` at the same time.
 */
export function __resetStellarServer() {
  _server = null;
}

/**
 * Fetch the sequence number of the most recently closed ledger.
 *
 * Used by the registry route to compute transaction validity windows (e.g.
 * checking whether a submitted XDR is approaching ledger expiry).
 *
 * **Concurrency**: safe to call concurrently. Each call issues an independent
 * RPC request; they do not share mutable state.
 *
 * @returns {Promise<number>} The current ledger sequence number.
 * @throws {RpcThrottledError} If the underlying RPC call fails after exhausting
 *   all retry attempts (transient 429 / 5xx / network errors).
 * @throws {Error} For any non-retryable RPC error (e.g. malformed response,
 *   authentication failure) — propagated from the Stellar SDK without wrapping.
 */
export async function getCurrentLedgerSequence() {
  const ledger = await getStellarServer().getLatestLedger();
  return ledger.sequence;
}

/**
 * Return the Stellar network passphrase for the configured network.
 *
 * Reads `config.stellar.network` at call time: `"mainnet"` maps to
 * `Networks.PUBLIC`; every other value (including `"testnet"`) maps to
 * `Networks.TESTNET`.
 *
 * **Concurrency**: safe to call concurrently — pure computation, no shared
 * mutable state.
 *
 * @returns {string} The network passphrase string (e.g.
 *   `"Public Global Stellar Network ; September 2015"` or
 *   `"Test SDF Network ; September 2015"`).
 */
export function getNetworkPassphrase() {
  if (config.stellar.network === "mainnet") {
    return Networks.PUBLIC;
  }
  return Networks.TESTNET;
}

/**
 * Return the Stellar contract ID of the USDC token on the configured network.
 *
 * The value comes directly from `config.stellar.usdcContractId`, which is
 * populated from the `USDC_CONTRACT_ID` environment variable. The variable is
 * listed in the required-vars guard in `config.js`, so the server will not
 * start without it; this function therefore never returns `undefined` in a
 * correctly configured environment.
 *
 * **Concurrency**: safe to call concurrently — returns a frozen config value,
 * no shared mutable state.
 *
 * @returns {string} The USDC token contract ID (a Stellar contract address).
 */
export function getUSDCContractId() {
  return config.stellar.usdcContractId;
}

/**
 * Probe RPC server connectivity and optional server-account reachability.
 *
 * Performs two sequential checks:
 * 1. **RPC connectivity** — calls `getNetwork()`. If this fails the function
 *    returns immediately with `status: "unhealthy"`.
 * 2. **Account reachability** — calls `getAccount()` with the key from
 *    `config.server.secret`. Skipped (and `status` set to `"degraded"`) when
 *    `config.server.secret` is not set. A failure here also sets
 *    `status: "degraded"` rather than `"unhealthy"` because the RPC layer
 *    itself is still functional.
 *
 * **Concurrency**: safe to call concurrently. Each invocation uses the shared
 * singleton server but creates its own result object; there is no shared
 * mutable state between concurrent calls. Note that concurrent health checks
 * each issue their own RPC requests — callers responsible for latency-sensitive
 * contexts should debounce or cache the result externally.
 *
 * **Never throws.** All errors are caught internally and surfaced via the
 * returned object's `error` / `contract.error` fields. This makes the function
 * safe to call from health-check middleware without a try/catch.
 *
 * @returns {Promise<{
 *   rpc: { reachable: boolean, latency: number },
 *   contract: { reachable: boolean | null, latency?: number, message?: string, error?: string },
 *   status: "healthy" | "degraded" | "unhealthy",
 *   error: string | null,
 *   timestamp: string
 * }>}
 */
export async function checkRpcHealth() {
  const result = {
    rpc: { reachable: false, latency: 0 },
    contract: { reachable: false },
    status: "unhealthy",
    error: null,
    timestamp: new Date().toISOString(),
  };

  try {
    const server = getStellarServer();
    const startTime = Date.now();

    // Test basic RPC connectivity by fetching network details
    await server.getNetwork();
    result.rpc.latency = Date.now() - startTime;
    result.rpc.reachable = true;
    logger.debug(
      { latency: result.rpc.latency },
      "RPC server health check passed",
    );
  } catch (err) {
    result.error = err.message;
    logger.warn({ error: result.error }, "RPC server health check failed");
    return result;
  }

  try {
    // Test contract reachability by attempting to fetch server account
    const server = getStellarServer();
    const startTime = Date.now();

    // Use the server keypair from config if available
    if (!config.server?.secret) {
      result.contract.reachable = null;
      result.contract.message =
        "Contract check skipped (no server key available)";
      result.status = "degraded";
      logger.debug("Contract health check skipped");
      return result;
    }

    const keypair = Keypair.fromSecret(config.server.secret);
    const account = await server.getAccount(keypair.publicKey());
    result.contract.latency = Date.now() - startTime;
    result.contract.reachable = true;
    result.status = "healthy";
    logger.debug(
      { latency: result.contract.latency },
      "Contract health check passed",
    );
  } catch (err) {
    result.contract.error = err.message;
    result.status = "degraded";
    logger.warn(
      { error: result.contract.error },
      "Contract health check failed",
    );
  }

  return result;
}
