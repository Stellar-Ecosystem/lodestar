import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import config from '../config.js';
import logger from './logger.js';
import { getRequestId } from './requestContext.js';

// Dedicated audit trail for every transaction the server signs, kept on its
// own file — and therefore its own retention policy — so an incident review
// never has to grep it out of general application logs. See the "Audit
// Logging" section in the root README for the retention/rotation policy.
const AUDIT_LOG_PATH = config.auditLogPath ?? 'audit.log';

// Defense in depth: callers only ever pass public, on-chain call arguments
// (addresses, amounts, category strings) into `args`, but strip anything that
// looks like a secret before it can reach the audit trail regardless.
const SENSITIVE_KEY_PATTERN = /secret|private|passphrase|password|hmac/i;

function redactArgs(args) {
  if (!args || typeof args !== 'object') return args ?? {};
  const safe = {};
  for (const [key, value] of Object.entries(args)) {
    safe[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : value;
  }
  return safe;
}

/**
 * Record exactly one audit entry for a transaction the server has signed
 * (either directly, or as fee-source co-signer of a wallet-signed tx).
 *
 * Written as a single JSON line so the file is queryable by `actor` or
 * `txHash` with any line-oriented JSON tool (jq, a log aggregator, etc.).
 *
 * @param {object} event
 * @param {string|null} event.actor - Stellar address whose authorization the signature represents
 * @param {string|null} event.contractId - contract invoked
 * @param {string} event.function - contract function invoked
 * @param {object} event.args - named, redacted call arguments
 * @param {string|null} event.txHash - transaction hash, if one was assigned
 * @param {string} event.result - e.g. 'success' | 'send_failed' | 'failed_onchain' | 'timeout' | 'bad_seq_retry' | 'return_value_parse_failed' | 'error'
 * @param {{code?: string, message: string}|null} [event.error]
 * @param {string} [event.requestId] - explicit correlation id; falls back to the current request context, then a fresh UUID
 * @returns {object} the record that was written
 */
export function recordAuditEvent(event) {
  const record = {
    timestamp: new Date().toISOString(),
    requestId: event.requestId ?? getRequestId() ?? randomUUID(),
    actor: event.actor ?? null,
    contractId: event.contractId ?? null,
    function: event.function ?? 'unknown',
    args: redactArgs(event.args),
    txHash: event.txHash ?? null,
    result: event.result ?? 'unknown',
    ...(event.error ? { error: { code: event.error.code ?? null, message: event.error.message } } : {}),
  };

  try {
    appendFileSync(AUDIT_LOG_PATH, JSON.stringify(record) + '\n', 'utf-8');
  } catch (err) {
    logger.error({ err, auditLogPath: AUDIT_LOG_PATH }, 'Failed to write audit log entry');
  }

  // Also emit through the structured app logger (tagged `audit: true`) so
  // operators watching combined stdout/log-aggregator output still see it,
  // even if they haven't wired up the dedicated audit file.
  logger.info({ audit: true, ...record }, 'signed_transaction_audit');

  return record;
}

export function getAuditLogPath() {
  return AUDIT_LOG_PATH;
}
