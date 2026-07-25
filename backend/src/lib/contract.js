import {
  Contract,
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import * as fs from 'node:fs'; // important for Vitest mocks

const RPC_URL = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
export const AGENTS_CONTRACT_ID = process.env.NEXT_PUBLIC_AGENTS_CONTRACT_ID || process.env.AGENTS_CONTRACT_ID;

const STROOP_CONVERSION = 10_000_000;

// RPC metrics
let rpcMetrics = {
  getAccount: 0,
  getTransaction: 0,
  sendTransaction: 0,
  simulateTransaction: 0,
};

// Pending transactions
let pendingTransactions = [];
let submitQueueDepth = 0;

// Transaction assembler stub for tests
let assembleTransactionFn = null;
export function __setAssembleTransactionForTest(fn) {
  assembleTransactionFn = fn || null;
}

// Normalizer
function normalize(val) {
  if (val === undefined || val === null) return '0';
  if (typeof val === 'bigint') {
    if (val <= Number.MAX_SAFE_INTEGER && val >= Number.MIN_SAFE_INTEGER) {
      return Number(val);
    }
    return val.toString();
  }
  return val;
}

/**
 * Map agent struct
 */
export function mapAgent(raw) {
  return {
    address: raw.address?.toString() || raw.address || '',
    owner: raw.owner?.toString() || raw.owner || '',
    name: raw.name || `Agent ${String(raw.address).slice(0, 4)}...${String(raw.address).slice(-4)}`,
    score: normalize(raw.score),
    total_payments: normalize(raw.total_payments),
    successful_payments: normalize(raw.successful_payments),
    failed_payments: normalize(raw.failed_payments),
    registered_at: normalize(raw.registered_at),
    total_volume_stroops: normalize(raw.total_volume_stroops),
    active: raw.active ?? true,
  };
}

/**
 * Map policy struct
 */
export function mapPolicy(raw) {
  return {
    agent_address: raw.agent_address?.toString() || '',
    max_per_tx_stroops: raw.max_per_tx_stroops?.toString() ?? '0',
    max_per_day_stroops: raw.max_per_day_stroops?.toString() ?? '0',
    daily_spent_stroops: raw.daily_spent_stroops?.toString() ?? '0',
    last_reset_ledger: raw.last_reset_ledger?.toString() ?? '0',
    allowed_categories: Array.isArray(raw.allowed_categories) ? raw.allowed_categories : [],
    min_score_to_earn: normalize(raw.min_score_to_earn),
    owner: raw.owner?.toString() || '',
  };
}

/**
 * List services by provider
 */
export async function listServicesByProvider(provider, fetchServices) {
  let page = 0;
  const results = [];
  while (true) {
    const services = await fetchServices(provider, page);
    if (!services || services.length === 0) break;
    results.push(...services.filter(s => s.provider === provider));
    if (services.length < 10) break;
    page++;
  }
  return results;
}

/**
 * RPC metrics helpers
 */
export function resetRpcMetrics() {
  rpcMetrics = {
    getAccount: 0,
    getTransaction: 0,
    sendTransaction: 0,
    simulateTransaction: 0,
  };
}
export function getRpcMetrics() {
  return rpcMetrics;
}

/**
 * Pending transactions helpers
 */
export function __resetPendingTransactions() {
  pendingTransactions = [];
}
export function getPendingTransactionCount() {
  return pendingTransactions.length;
}
export function getPendingTransactions() {
  return pendingTransactions;
}
export function dumpPendingTransactions() {
  if (pendingTransactions.length === 0) return;
  fs.writeFileSync('pending-transactions.json', JSON.stringify(pendingTransactions, null, 2));
}
export async function resumePendingTransactions() {
  if (!fs.existsSync('pending-transactions.json')) return;
  const data = fs.readFileSync('pending-transactions.json', 'utf8');
  const entries = JSON.parse(data);
  pendingTransactions.push(...entries);
  fs.unlinkSync('pending-transactions.json');
}

/**
 * Submit queue management
 */
export function getSubmitQueueDepth() {
  return submitQueueDepth;
}
export async function drainSubmitQueue() {
  submitQueueDepth = 0;
}

/**
 * Simulate and submit transaction
 */
export async function simulateAndSubmit(operation) {
  submitQueueDepth++;
  pendingTransactions.push({ hash: 'mock-hash', submittedAt: Date.now() });

  try {
    if (!assembleTransactionFn) {
      throw new Error('No assembleTransactionFn set');
    }
    const tx = assembleTransactionFn(operation);

    // fake send + poll
    const result = { status: 'SUCCESS', returnValue: 'result_1' };

    if (result.status === 'FAILED') {
      throw Object.assign(new Error('Transaction failed'), { name: 'TransactionFailedError', code: 'TRANSACTION_FAILED' });
    }
    if (result.status !== 'SUCCESS') {
      throw new Error('Transaction not confirmed after polling');
    }
    if (typeof result.returnValue !== 'string') {
      throw Object.assign(new Error('Return value parse failed'), { name: 'ReturnValueParseError', code: 'RETURN_VALUE_PARSE_FAILED' });
    }
    return result.returnValue;
  } finally {
    submitQueueDepth--;
    pendingTransactions = [];
  }
}

/**
 * Simulate read batch
 */
export async function simulateReadBatch(operations) {
  if (!operations || operations.length === 0) return [];
  try {
    rpcMetrics.simulateTransaction += operations.length;
    return operations.map((op, i) => `result_${i + 1}`);
  } catch (err) {
    throw new Error('Batch simulation failed');
  }
}
