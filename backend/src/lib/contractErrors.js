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
 * Numeric discriminants of the agents contract `AgentError` enum
 * (`contract/agents/src/lib.rs`). They are `#[repr(u32)]` values, so the numbers
 * are part of the on-chain ABI and must never be reordered.
 */
export const AGENT_ERROR = Object.freeze({
  INVALID_AMOUNT: 1,
  ARITHMETIC_OVERFLOW: 2,
  AGENT_ALREADY_REGISTERED: 3,
  AGENT_LIST_FULL: 4,
  AGENT_COUNT_OVERFLOW: 5,
  AGENT_NOT_FOUND: 6,
});

/**
 * Error map for the agents contract. Mirrors `AgentError` one-to-one and adds
 * the HTTP status each cause maps to, so callers can tell the causes apart
 * without parsing a message.
 *
 * The numeric codes overlap `REGISTRY_ERROR_CODES` (both are `#[repr(u32)]`
 * enums on different contracts), so a host error must be resolved against the
 * map for the contract that was actually invoked — see `AGENT_ERROR_SCOPE`.
 */
export const AGENT_ERROR_CODES = Object.freeze({
  1: { code: 'INVALID_AMOUNT', status: 400, message: 'Payment amount must be greater than zero' },
  2: { code: 'ARITHMETIC_OVERFLOW', status: 400, message: 'Payment amount exceeds the supported range' },
  3: { code: 'AGENT_ALREADY_REGISTERED', status: 409, message: 'Agent already registered' },
  4: { code: 'AGENT_LIST_FULL', status: 503, message: 'Agent registry is full' },
  5: { code: 'AGENT_COUNT_OVERFLOW', status: 503, message: 'Agent registry count overflow' },
  6: { code: 'AGENT_NOT_FOUND', status: 404, message: 'Agent not found' },
});

/**
 * Marks a contract error map so `simulateRead` can tell which contract an
 * invocation targeted and resolve the numeric code against the right map.
 */
export const AGENT_ERROR_SCOPE = Object.freeze({
  errorCodes: AGENT_ERROR_CODES,
  name: 'agents',
});

export const REGISTRY_ERROR_SCOPE = Object.freeze({
  errorCodes: REGISTRY_ERROR_CODES,
  name: 'registry',
});

const CONTRACT_ERROR_PATTERNS = [
  /Error\(Contract,\s*#?(\d+)\)/i,
  /ContractError\((\d+)\)/i,
  /contract error[^\d]*(\d+)/i,
  /contract code[^\d]*(\d+)/i,
];

const CONTRACT_ERROR_CODE_KEYS = new Set([
  'contractCode',
  'contract_code',
  'contractErrorCode',
  'contract_error_code',
  'errorCode',
  'error_code',
]);

const CONTRACT_ERROR_CONTAINER_KEYS = new Set([
  'error',
  'message',
  'result',
  'errorResult',
  'diagnosticEvents',
  'events',
  'details',
  'cause',
]);

function codeFromNumber(value, errorCodes) {
  if (Number.isInteger(value) && errorCodes[value]) return value;
  return null;
}

function codeFromString(value, errorCodes) {
  for (const pattern of CONTRACT_ERROR_PATTERNS) {
    const match = pattern.exec(value);
    if (!match) continue;
    const code = codeFromNumber(Number(match[1]), errorCodes);
    if (code !== null) return code;
  }
  return null;
}

function extractErrorCode(value, errorCodes, seen) {
  const numericCode = codeFromNumber(value, errorCodes);
  if (numericCode !== null) return numericCode;

  if (typeof value === 'bigint') {
    return codeFromNumber(Number(value), errorCodes);
  }
  if (typeof value === 'string') {
    return codeFromString(value, errorCodes);
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return null;
  }
  seen.add(value);

  for (const key of CONTRACT_ERROR_CODE_KEYS) {
    const numericCode = codeFromNumber(Number(value[key]), errorCodes);
    if (numericCode !== null) return numericCode;
  }

  if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
    const code = codeFromString(value.toString(), errorCodes);
    if (code !== null) return code;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const code = extractErrorCode(item, errorCodes, seen);
      if (code !== null) return code;
    }
  } else {
    for (const key of CONTRACT_ERROR_CONTAINER_KEYS) {
      const code = extractErrorCode(value[key], errorCodes, seen);
      if (code !== null) return code;
    }
  }

  return null;
}

export function extractRegistryErrorCode(value, seen = new Set()) {
  return extractErrorCode(value, REGISTRY_ERROR_CODES, seen);
}

export function contractErrorFromCode(numericCode, errorCodes) {
  const meta = errorCodes[numericCode];
  if (!meta) return null;
  const err = new ContractError(meta.message, meta.code, meta.status);
  err.contractErrorCode = numericCode;
  return err;
}

export function registryErrorFromCode(numericCode) {
  const err = contractErrorFromCode(numericCode, REGISTRY_ERROR_CODES);
  if (err) err.registryErrorCode = err.contractErrorCode;
  return err;
}

export function agentErrorFromCode(numericCode) {
  return contractErrorFromCode(numericCode, AGENT_ERROR_CODES);
}

export function registryErrorFromHostError(details) {
  return registryErrorFromCode(extractRegistryErrorCode(details));
}

export function agentErrorFromHostError(details) {
  return agentErrorFromCode(extractErrorCode(details, AGENT_ERROR_CODES, new Set()));
}

/**
 * Resolve a Soroban host error against the map for the contract that produced
 * it. Passing the wrong scope silently reports another contract's error, so
 * call sites must state which contract they invoked.
 */
export function contractErrorFromHostError(details, scope = REGISTRY_ERROR_SCOPE) {
  const code = extractErrorCode(details, scope.errorCodes, new Set());
  return code === null ? null : contractErrorFromCode(code, scope.errorCodes);
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
