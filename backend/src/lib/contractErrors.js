import { ContractError } from './ContractError.js';

export const REGISTRY_ERROR_CODES = Object.freeze({
  1: { code: 'INVALID_NAME', message: 'Service name must be 3-64 characters' },
  2: { code: 'INVALID_DESCRIPTION', message: 'Service description must be 10-256 characters' },
  3: { code: 'DUPLICATE_SERVICE', message: 'Active service with same provider and endpoint already exists' },
  4: { code: 'SERVICE_NOT_FOUND', message: 'Service not found' },
  5: { code: 'AGENTS_CONTRACT_NOT_CONFIGURED', message: 'Agents contract is not configured for this registry' },
  6: { code: 'CALLER_NOT_REGISTERED_AGENT', message: 'Caller is not a registered agent' },
  7: { code: 'REPUTATION_VOTE_COOLDOWN', message: 'This agent has voted on this service too recently' },
  8: { code: 'PROVIDER_MISMATCH', message: 'Only the provider that registered this service can deactivate it' },
  9: { code: 'CATEGORY_INDEX_NOT_FOUND', message: 'Category index not found' },
  10: { code: 'INVALID_ENDPOINT', message: 'Service endpoint must be at most 256 characters' },
  11: { code: 'INVALID_CATEGORY', message: 'Service category must be a supported value of 1-32 characters' },
  12: { code: 'REGISTRY_NOT_INITIALIZED', message: 'Registry contract has not been initialized' },
  13: { code: 'REGISTRY_PAUSED', message: 'Registry contract is paused' },
  14: { code: 'REGISTRY_COUNT_OVERFLOW', message: 'Service count exceeds the maximum supported value' },
  15: { code: 'REGISTRY_STORAGE_CORRUPTED', message: 'Registry storage could not be read consistently' },
});

/**
 * Numeric codes of the `AgentError` enum in `contract/agents/src/lib.rs`.
 *
 * Kept separate from `REGISTRY_ERROR_CODES` because the two contracts number
 * their errors independently and the numbers collide: `2` is
 * `ArithmeticOverflow` here and `INVALID_DESCRIPTION` there. Always resolve a
 * code against the contract that produced it — see `extractContractErrorCode`.
 *
 * Append-only: a code is part of the agents contract's ABI and must never be
 * renumbered. Keep in sync with the `#[contracterror]` enum.
 */
export const AGENT_ERROR_CODES = Object.freeze({
  1: { code: 'INVALID_AMOUNT', message: 'Amount must be a positive number of stroops' },
  2: { code: 'ARITHMETIC_OVERFLOW', message: 'Amount exceeds the supported numeric range' },
  3: { code: 'POLICY_NOT_FOUND', message: 'Agent has no spending policy' },
  4: { code: 'AGENT_NOT_FOUND', message: 'Agent is not registered' },
  5: { code: 'AGENT_INACTIVE', message: 'Agent has been deactivated' },
  6: { code: 'AGENT_FLAGGED', message: 'Agent has been flagged by an administrator' },
  7: { code: 'PER_TRANSACTION_LIMIT_EXCEEDED', message: 'Amount exceeds the agent per-transaction spending limit' },
  8: { code: 'DAILY_LIMIT_EXCEEDED', message: 'Amount would exceed the agent daily spending limit' },
});

export const CONTRACT_ERROR_CATALOGS = Object.freeze({
  registry: REGISTRY_ERROR_CODES,
  agents: AGENT_ERROR_CODES,
});

const REGISTRY_ERROR_PATTERNS = [
  /Error\(Contract,\s*#?(\d+)\)/i,
  /ContractError\((\d+)\)/i,
  /contract error[^\d]*(\d+)/i,
  /contract code[^\d]*(\d+)/i,
];

const REGISTRY_ERROR_CODE_KEYS = new Set([
  'contractCode',
  'contract_code',
  'contractErrorCode',
  'contract_error_code',
  'errorCode',
  'error_code',
]);

const REGISTRY_ERROR_CONTAINER_KEYS = new Set([
  'error',
  'message',
  'result',
  'errorResult',
  'diagnosticEvents',
  'events',
  'details',
  'cause',
]);

function contractCodeFromNumber(value, catalog) {
  if (Number.isInteger(value) && catalog[value]) return value;
  return null;
}

function contractCodeFromString(value, catalog) {
  for (const pattern of REGISTRY_ERROR_PATTERNS) {
    const match = pattern.exec(value);
    if (!match) continue;
    const code = contractCodeFromNumber(Number(match[1]), catalog);
    if (code !== null) return code;
  }
  return null;
}

/**
 * Pull a numeric contract error code out of an RPC failure payload.
 *
 * `catalog` scopes the lookup: only codes that the contract in question
 * actually defines are accepted, so a registry code can never be mistaken for
 * an agents code (or the reverse) just because the numbers overlap.
 */
export function extractContractErrorCode(value, catalog, seen = new Set()) {
  const numericCode = contractCodeFromNumber(value, catalog);
  if (numericCode !== null) return numericCode;

  if (typeof value === 'bigint') {
    return contractCodeFromNumber(Number(value), catalog);
  }
  if (typeof value === 'string') {
    return contractCodeFromString(value, catalog);
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return null;
  }
  seen.add(value);

  for (const key of REGISTRY_ERROR_CODE_KEYS) {
    const numericCode = contractCodeFromNumber(Number(value[key]), catalog);
    if (numericCode !== null) return numericCode;
  }

  if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
    const code = contractCodeFromString(value.toString(), catalog);
    if (code !== null) return code;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const code = extractContractErrorCode(item, catalog, seen);
      if (code !== null) return code;
    }
  } else {
    for (const key of REGISTRY_ERROR_CONTAINER_KEYS) {
      const code = extractContractErrorCode(value[key], catalog, seen);
      if (code !== null) return code;
    }
  }

  return null;
}

export function extractRegistryErrorCode(value, seen) {
  return extractContractErrorCode(value, REGISTRY_ERROR_CODES, seen);
}

export function extractAgentErrorCode(value, seen) {
  return extractContractErrorCode(value, AGENT_ERROR_CODES, seen);
}

/**
 * Resolve a numeric contract error code to a `ContractError` using the catalog
 * of the contract that produced it.
 *
 * @param {number} numericCode
 * @param {string} contractName key of `CONTRACT_ERROR_CATALOGS`
 * @returns {ContractError|null} null when the code is not in that catalog
 */
export function contractErrorFromCode(numericCode, contractName) {
  const catalog = CONTRACT_ERROR_CATALOGS[contractName];
  const meta = catalog?.[numericCode];
  if (!meta) return null;
  const err = new ContractError(meta.message, meta.code);
  err.contractErrorCode = numericCode;
  // Alias for callers that want the contract-specific field name.
  if (contractName === 'agents') err.agentErrorCode = numericCode;
  if (contractName === 'registry') err.registryErrorCode = numericCode;
  return err;
}

export function registryErrorFromCode(numericCode) {
  return contractErrorFromCode(numericCode, 'registry');
}

export function agentErrorFromCode(numericCode) {
  return contractErrorFromCode(numericCode, 'agents');
}

export function registryErrorFromHostError(details) {
  return registryErrorFromCode(extractRegistryErrorCode(details));
}

export function agentErrorFromHostError(details) {
  return agentErrorFromCode(extractAgentErrorCode(details));
}

export class SimulationError extends ContractError {
  constructor(message, details, cause) {
    super(message, 'SIMULATION_FAILED');
    this.name = 'SimulationError';
    if (details !== undefined) this.details = details;
    if (cause) this.cause = cause;
  }
}

export class TransactionFailedError extends ContractError {
  constructor(message, hash, details, cause) {
    super(message, 'TRANSACTION_FAILED');
    this.name = 'TransactionFailedError';
    if (hash) this.hash = hash;
    if (details !== undefined) this.details = details;
    if (cause) this.cause = cause;
  }
}

export class TransactionTimeoutError extends ContractError {
  constructor(message, hash, cause) {
    super(message, 'TRANSACTION_TIMEOUT');
    this.name = 'TransactionTimeoutError';
    if (hash) this.hash = hash;
    if (cause) this.cause = cause;
  }
}

export class ReturnValueParseError extends ContractError {
  constructor(message, hash, cause) {
    super(message, 'RETURN_VALUE_PARSE_FAILED');
    this.name = 'ReturnValueParseError';
    if (hash) this.hash = hash;
    if (cause) this.cause = cause;
  }
}

/**
 * Thrown when an RPC call exhausts its retry budget against a throttled or
 * failing endpoint. The original error is attached as `cause` for diagnostics.
 */
export class RpcThrottledError extends ContractError {
  constructor(message, attempts, cause) {
    super(message, 'RPC_THROTTLED');
    this.name = 'RpcThrottledError';
    this.attempts = attempts;
    if (cause) this.cause = cause;
  }
}

/**
 * Route-level error codes that are not Soroban contract codes but still need
 * to be catalogued so clients can branch on a stable identifier.
 */
export const ROUTE_ERROR_CODES = Object.freeze({
  UPSTREAM_TIMEOUT: {
    code: 'UPSTREAM_TIMEOUT',
    status: 504,
    message: 'Upstream call timed out',
  },
});

export class UpstreamTimeoutError extends ContractError {
  constructor(message, timeoutMs, cause) {
    super(message || 'Upstream call timed out', 'UPSTREAM_TIMEOUT');
    this.name = 'UpstreamTimeoutError';
    this.timeoutMs = timeoutMs;
    if (cause) this.cause = cause;
  }
}
