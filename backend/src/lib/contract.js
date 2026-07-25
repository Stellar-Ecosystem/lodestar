import {
  Contract,
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { sortAgents } from './sort';

// RPC Endpoint and Contract Setup
const RPC_URL = process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const AGENTS_CONTRACT_ID = process.env.NEXT_PUBLIC_AGENTS_CONTRACT_ID || process.env.AGENTS_CONTRACT_ID;

const STROOP_CONVERSION = 10_000_000; // 1 USDC/XLM = 10^7 Stroops

/**
 * Helper to execute read-only contract calls via Stellar RPC
 */
async function simulateContractCall(method, args = []) {
  if (!AGENTS_CONTRACT_ID) {
    throw new Error('AGENTS_NOT_CONFIGURED: AGENTS_CONTRACT_ID is not set in environment variables.');
  }

  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'simulateTransaction',
      params: {
        transaction: new Contract(AGENTS_CONTRACT_ID)
          .call(method, ...args)
          .toXdr(),
      },
    }),
  });

  const json = await response.json();

  if (json.error) {
    throw new Error(`RPC Error: ${json.error.message || 'Unknown error'}`);
  }

  const resultXdr = json.result?.results?.[0]?.xdr;
  if (!resultXdr) {
    return null;
  }

  const scVal = xdr.ScVal.fromXDR(resultXdr, 'base64');
  return scValToNative(scVal);
}

/**
 * Fetches paginated agents list sorted by the chosen option
 */
export async function fetchAgents(page = 0, pageSize = 10, sort = 'score') {
  if (!AGENTS_CONTRACT_ID) {
    throw new Error('AGENTS_NOT_CONFIGURED: Agents contract not configured or not yet deployed.');
  }

  try {
    const rawAgents = await simulateContractCall('get_all_agents');

    let agentList = [];

    if (Array.isArray(rawAgents)) {
      agentList = rawAgents.map((raw) => parseAgentIdentity(raw));
    }

    // Sort agents globally before pagination slice
    const sorted = sortAgents(agentList, sort);
    const total = sorted.length;

    // Slice for local client pagination
    const start = page * pageSize;
    const paginatedAgents = sorted.slice(start, start + pageSize);

    return {
      agents: paginatedAgents,
      total,
      page,
      pageSize,
    };
  } catch (err) {
    console.error('Failed to fetch agents from contract:', err);
    throw new Error(err.message || 'Failed to load registered agents');
  }
}

/**
 * Fetches aggregate statistics for the registry stats bar
 */
export async function fetchAgentStats() {
  if (!AGENTS_CONTRACT_ID) {
    return {
      totalAgents: 0,
      avgScore: 0,
      totalVolume: '0.00',
      topAgent: null,
    };
  }

  try {
    const rawAgents = await simulateContractCall('get_all_agents');

    if (!Array.isArray(rawAgents) || rawAgents.length === 0) {
      return {
        totalAgents: 0,
        avgScore: 0,
        totalVolume: '0.00',
        topAgent: null,
      };
    }

    const agents = rawAgents.map((raw) => parseAgentIdentity(raw));
    const totalAgents = agents.length;

    const totalScore = agents.reduce((acc, a) => acc + (a.score || 0), 0);
    const avgScore = Math.round(totalScore / totalAgents);

    const rawTotalVolumeStroops = agents.reduce(
      (acc, a) => acc + BigInt(a.totalVolumeStroops || 0),
      BigInt(0)
    );
    const totalVolume = (Number(rawTotalVolumeStroops) / STROOP_CONVERSION).toFixed(2);

    // Find agent with highest score
    const topAgent = [...agents].sort((a, b) => b.score - a.score)[0] || null;

    return {
      totalAgents,
      avgScore,
      totalVolume,
      topAgent: topAgent
        ? {
            name: topAgent.name || `${topAgent.address.slice(0, 4)}...${topAgent.address.slice(-4)}`,
            score: topAgent.score,
            address: topAgent.address,
          }
        : null,
    };
  } catch (err) {
    console.warn('Failed to fetch agent stats:', err);
    return {
      totalAgents: 0,
      avgScore: 0,
      totalVolume: '0.00',
      topAgent: null,
    };
  }
}

/**
 * Fetches policy details for a single agent
 */
export async function fetchAgentPolicy(agentAddress) {
  try {
    const addressVal = nativeToScVal(Address.fromString(agentAddress));
    const rawPolicy = await simulateContractCall('get_policy', [addressVal]);
    if (!rawPolicy) return null;

    return {
      maxPerTxStroops: BigInt(rawPolicy.max_per_tx_stroops || 0),
      maxPerDayStroops: BigInt(rawPolicy.max_per_day_stroops || 0),
      dailySpentStroops: BigInt(rawPolicy.daily_spent_stroops || 0),
      lastResetLedger: Number(rawPolicy.last_reset_ledger || 0),
      allowedProviders: rawPolicy.allowed_providers || [],
      minScoreToEarn: Number(rawPolicy.min_score_to_earn || 0),
      owner: rawPolicy.owner,
    };
  } catch (err) {
    console.error(`Failed to fetch policy for agent ${agentAddress}:`, err);
    return null;
  }
}

/**
 * Maps raw Soroban struct responses into clean JavaScript objects
 */
function parseAgentIdentity(raw) {
  const address = raw.address?.toString() || raw.address || '';
  const score = Number(raw.score ?? 100);
  const totalPayments = Number(raw.total_payments ?? 0);
  const successfulPayments = Number(raw.successful_payments ?? 0);
  const failedPayments = Number(raw.failed_payments ?? 0);
  const registeredAtLedger = Number(raw.registered_at_ledger ?? 0);

  return {
    address,
    owner: raw.owner?.toString() || raw.owner || '',
    name: raw.name || `Agent ${address.slice(0, 4)}...${address.slice(-4)}`,
    score,
    totalPayments,
    successfulPayments,
    failedPayments,
    registeredAtLedger,
    totalVolumeStroops: raw.total_volume_stroops ? BigInt(raw.total_volume_stroops) : BigInt(0),
  };
}
