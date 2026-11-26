// Agent configuration loading and validation.
//
// Boundary behavior (LDS-2026-191, LDS-2026-193):
// - Configuration is validated once at startup, BEFORE the wallet secret is
//   read and before any signing key is derived. Invalid configuration stops
//   the agent deterministically with a ConfigError that names the offending
//   variable and the reason. Values are never included in error messages, so
//   a misconfigured secret-adjacent setting cannot leak into logs.
// - Missing network passphrase falls back to the passphrase of the selected
//   STELLAR_NETWORK (default: testnet). A passphrase that is set but empty is
//   an error, not a silent default.
// - Contract IDs are optional for the agent (it reaches contracts through the
//   Lodestar backend). When set, each must have the Stellar contract ID shape
//   ("C" followed by 55 base32 characters); a set-but-empty or malformed ID
//   is an error.

export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
export const MAINNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

const NETWORKS = {
  testnet: TESTNET_PASSPHRASE,
  mainnet: MAINNET_PASSPHRASE,
};

// Stellar contract IDs: strkey "C" + 55 base32 (RFC 4648 alphabet) characters.
const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

export class ConfigError extends Error {
  constructor(key, reason) {
    super(`Invalid configuration: ${key} ${reason}`);
    this.name = 'ConfigError';
    this.key = key;
    this.reason = reason;
  }
}

function requiredUrl(env, key) {
  const raw = env[key];
  if (!raw) throw new ConfigError(key, 'is required but not set');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(key, 'must be a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(key, 'must use http or https');
  }
  return raw;
}

function positiveAmount(env, key, fallback) {
  const raw = env[key] ?? fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(key, 'must be a positive number');
  }
  return raw;
}

function intAtLeast(env, key, fallback, min) {
  const raw = env[key] ?? fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(key, `must be an integer >= ${min}`);
  }
  return value;
}

function optionalContractId(env, key) {
  const raw = env[key];
  if (raw === undefined) return undefined;
  if (raw.trim() === '') throw new ConfigError(key, 'is set but empty');
  if (!CONTRACT_ID_RE.test(raw)) {
    throw new ConfigError(key, 'must be a Stellar contract ID ("C" + 55 base32 characters)');
  }
  return raw;
}

// Service-selection thresholds, validated with the same rules at startup and
// when re-read per task (tests adjust them at runtime).
export function readServiceSelection(env = process.env) {
  return {
    minServiceReputation: intAtLeast(env, 'AGENT_MIN_SERVICE_REPUTATION', '0', 0),
    maxServiceRetries: intAtLeast(env, 'AGENT_MAX_SERVICE_RETRIES', '3', 1),
  };
}

export function loadAgentConfig(env = process.env) {
  // Network + passphrase boundary: an unknown network or an explicitly empty
  // passphrase is a startup error; a missing passphrase uses the network's
  // well-known value.
  const network = env.STELLAR_NETWORK ?? 'testnet';
  // Object.hasOwn: a plain lookup would accept inherited names like
  // "constructor" and then return a function as the passphrase.
  if (!Object.hasOwn(NETWORKS, network)) {
    throw new ConfigError('STELLAR_NETWORK', 'must be "testnet" or "mainnet"');
  }
  let networkPassphrase = env.STELLAR_NETWORK_PASSPHRASE;
  if (networkPassphrase === undefined) {
    networkPassphrase = NETWORKS[network];
  } else if (networkPassphrase.trim() === '') {
    throw new ConfigError('STELLAR_NETWORK_PASSPHRASE', 'is set but empty');
  } else if (networkPassphrase !== NETWORKS[network]) {
    // The x402 signer derives the passphrase from the network name; a custom
    // value could never reach the signing path, so accepting it would
    // silently mislead operators.
    throw new ConfigError(
      'STELLAR_NETWORK_PASSPHRASE',
      `must match the ${network} network passphrase (custom passphrases are not supported by the signer)`
    );
  }

  const agentsContractId = optionalContractId(env, 'AGENTS_CONTRACT_ID');
  const usdcContractId = optionalContractId(env, 'USDC_CONTRACT_ID');

  // Service endpoints.
  const rpcUrl = requiredUrl(env, 'STELLAR_RPC_URL');
  const apiUrl = requiredUrl(env, 'LODESTAR_API_URL');

  // Token / spend limits.
  const maxPerTx = positiveAmount(env, 'AGENT_MAX_PER_TX', '0.001');
  const maxPerDay = positiveAmount(env, 'AGENT_MAX_PER_DAY', '1.00');

  // Service selection settings.
  const allowedCategories = (env.AGENT_ALLOWED_CATEGORIES ?? 'weather,search')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedCategories.length === 0) {
    throw new ConfigError('AGENT_ALLOWED_CATEGORIES', 'must list at least one category');
  }
  const { minServiceReputation, maxServiceRetries } = readServiceSelection(env);

  return {
    network,
    // CAIP-2 identifier the @x402/stellar signer understands. Its network map
    // only knows stellar:pubnet and stellar:testnet, so "mainnet" must be
    // translated here rather than interpolated at the call site.
    networkCaip2: network === 'mainnet' ? 'stellar:pubnet' : 'stellar:testnet',
    networkPassphrase,
    agentsContractId,
    usdcContractId,
    rpcUrl,
    apiUrl,
    hmacSecret: env.LODESTAR_HMAC_SECRET ?? '',
    agentName: env.AGENT_NAME ?? 'LodestarAgent',
    agentDesc: env.AGENT_DESC ?? '',
    maxPerTx,
    maxPerDay,
    allowedCategories,
    minServiceReputation,
    maxServiceRetries,
  };
}
