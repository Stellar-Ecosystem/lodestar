import pkg from '@stellar/stellar-sdk';
const {
  Contract,
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  xdr,
  Address,
  nativeToScVal,
  scValToNative,
  rpc,
} = pkg;
import config from '../config.js';
import { getStellarServer, getNetworkPassphrase } from './stellar.js';
import logger from './logger.js';


const TIMEOUT = 30;

function getContract() {
  return new Contract(config.contract.id);
}

function getAgentsContract() {
  if (!config.contract.agentsId) {
    throw new Error('AGENTS_CONTRACT_ID is not set — deploy the agents contract first');
  }
  return new Contract(config.contract.agentsId);
}

function getServerKeypair() {
  return Keypair.fromSecret(config.server.secret);
}

async function simulateAndSubmit(operation) {
  const server = getStellarServer();
  const keypair = getServerKeypair();
  const passphrase = getNetworkPassphrase();

  const account = await server.getAccount(keypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(operation)
    .setTimeout(TIMEOUT)
    .build();

  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    throw new ContractError(`Simulation failed: ${simResult.error}`, 'SIMULATION_FAILED');
  }

  const preparedTx = rpc.assembleTransaction(tx, simResult).build();
  preparedTx.sign(keypair);

  const sendResult = await server.sendTransaction(preparedTx);
  if (sendResult.status === 'ERROR') {
    throw new ContractError(`Transaction failed: ${JSON.stringify(sendResult.errorResult)}`, 'TRANSACTION_FAILED');
  }

  let getResult;
  for (let i = 0; i < 20; i++) {
    try {
      getResult = await server.getTransaction(sendResult.hash);
      if (getResult.status !== 'NOT_FOUND') break;
    } catch (parseErr) {
      // Protocol-22 XDR parse errors on confirmed txs — treat as SUCCESS
      if (parseErr.message?.includes('Bad union switch') || parseErr.message?.includes('XDR')) {
        logger.warn({ hash: sendResult.hash }, 'getTransaction XDR parse error — assuming confirmed');
        return { status: 'SUCCESS', returnValue: null };
      }
      throw parseErr;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (!getResult || getResult.status === 'NOT_FOUND') {
    throw new ContractError(`Transaction not confirmed after polling: ${sendResult.hash}`, 'TRANSACTION_TIMEOUT');
  }

  if (getResult.status === 'FAILED') {
    throw new ContractError(`Transaction failed on-chain: ${sendResult.hash}`, 'ON_CHAIN_FAILURE');
  }

  return getResult;
}

async function simulateRead(operation) {
  const server = getStellarServer();
  const keypair = getServerKeypair();
  const passphrase = getNetworkPassphrase();

  const account = await server.getAccount(keypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: passphrase,
  })
    .addOperation(operation)
    .setTimeout(TIMEOUT)
    .build();

  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    throw new ContractError(`Simulation failed: ${simResult.error}`, 'SIMULATION_FAILED');
  }

  return simResult.result?.retval;
}


export async function listServices({ category, page = 0, pageSize = 20 } = {}) {
  try {
    const contract = getContract();

    const optionArg = category
      ? nativeToScVal(category, { type: 'string' })
      : xdr.ScVal.scvVoid();

    const callOp = contract.call(
      'list_services_page',
      nativeToScVal(page, { type: 'u32' }),
      nativeToScVal(pageSize, { type: 'u32' }),
      optionArg,
    );
    const retval = await simulateRead(callOp);
    if (!retval) return [];

    const vec = scValToNative(retval);
    if (!Array.isArray(vec)) return [];

    return vec.map((item) => ({
      id: Number(item.id),
      name: item.name,
      description: item.description,
      endpoint: item.endpoint,
      price_usdc: item.price_usdc,
      category: item.category,
      provider: item.provider?.toString() ?? item.provider,
      reputation: Number(item.reputation),
      active: item.active,
      registered_at: Number(item.registered_at),
    }));
  } catch (err) {
    logger.error({ err }, 'listServices failed');
    throw err;
  }
}

export async function getService(id) {
  try {
    const contract = getContract();
    const op = contract.call('get_service', nativeToScVal(BigInt(id), { type: 'u64' }));
    const retval = await simulateRead(op);
    if (!retval) return null;
    const native = scValToNative(retval);
    return {
      id: Number(native.id),
      name: native.name,
      description: native.description,
      endpoint: native.endpoint,
      price_usdc: native.price_usdc,
      category: native.category,
      provider: native.provider?.toString() ?? native.provider,
      reputation: Number(native.reputation),
      active: native.active,
      registered_at: Number(native.registered_at),
    };
  } catch (err) {
    logger.error({ err, id }, 'getService failed');
    return null;
  }
}

export async function getServiceCount() {
  try {
    const contract = getContract();
    const op = contract.call('get_service_count');
    const retval = await simulateRead(op);
    if (!retval) return 0;
    return Number(scValToNative(retval));
  } catch (err) {
    logger.error({ err }, 'getServiceCount failed');
    return 0;
  }
}

/**
 * Update a service's reputation on-chain and record the change history.
 * @param {number} id - The ID of the service to update
 * @param {boolean} positive - Whether to increase (true) or decrease (false) reputation by 1
 * @returns {Promise<number>} The new reputation value
 * @throws {Error} If the contract call fails or service can't be read
 */
export async function updateReputation(id, positive) {
  try {
    const before = await getService(id);
    if (!before) {
      throw new Error(`Service ${id} not found before reputation update`);
    }

    const contract = getContract();
    const op = contract.call(
      'update_reputation',
      nativeToScVal(BigInt(id), { type: 'u64' }),
      nativeToScVal(positive, { type: 'bool' })
    );
    await simulateAndSubmit(op);
    
    const after = await getService(id);
    if (!after) {
      throw new Error(`Failed to read updated reputation for service ${id}`);
    }

    const newReputation = after.reputation;
    const delta = newReputation - before.reputation;

    recordReputationChange(id, Date.now(), delta, newReputation);

    return newReputation;
  } catch (err) {
    logger.error({ err, id, positive }, 'updateReputation failed');
    throw err;
  }
}

export async function registerServiceOnChain(
  name,
  description,
  endpoint,
  priceUsdc,
  category
) {
  try {
    const contract = getContract();
    const keypair = getServerKeypair();
    const providerAddress = Address.fromString(keypair.publicKey());

    const op = contract.call(
      'register_service',
      nativeToScVal(providerAddress, { type: 'address' }),
      nativeToScVal(name, { type: 'string' }),
      nativeToScVal(description, { type: 'string' }),
      nativeToScVal(endpoint, { type: 'string' }),
      nativeToScVal(priceUsdc, { type: 'string' }),
      nativeToScVal(category, { type: 'string' })
    );

    const result = await simulateAndSubmit(op);
    const retval = result.returnValue;
    return retval ? Number(scValToNative(retval)) : null;
  } catch (err) {
    logger.error({ err, name }, 'registerServiceOnChain failed');
    throw err;
  }
}

// ── Agent Credit Scoring ──────────────────────────────────────────────────────

/**
 * Safely convert a BigInt (or other value) to a Number.
 * Falls back to String for values outside the safe integer range
 * to prevent silent precision loss on i128/u64 values.
 */
function toNumber(value) {
  if (typeof value === 'bigint' && (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))) {
    return value.toString();
  }
  return Number(value);
}

export function mapAgent(raw) {
  return {
    address: raw.address?.toString() ?? raw.address,
    name: raw.name,
    description: raw.description,
    owner: raw.owner?.toString() ?? raw.owner,
    score: toNumber(raw.score),
    total_payments: toNumber(raw.total_payments),
    successful_payments: toNumber(raw.successful_payments),
    failed_payments: toNumber(raw.failed_payments),
    total_volume_stroops: String(raw.total_volume_stroops),
    registered_at: toNumber(raw.registered_at),
    last_active: toNumber(raw.last_active),
    active: raw.active,
    flagged: raw.flagged,
    flag_reason: raw.flag_reason ?? '',
  };
}

export function mapPolicy(raw) {
  return {
    agent_address: raw.agent_address?.toString() ?? raw.agent_address,
    max_per_tx_stroops: String(raw.max_per_tx_stroops),
    max_per_day_stroops: String(raw.max_per_day_stroops),
    allowed_categories: Array.isArray(raw.allowed_categories) ? raw.allowed_categories : [],
    min_score_to_earn: toNumber(raw.min_score_to_earn),
    daily_spent_stroops: String(raw.daily_spent_stroops),
    last_reset_ledger: toNumber(raw.last_reset_ledger),
  };
}

export async function listAgents(limit = 50) {
  try {
    const contract = getAgentsContract();
    const op = contract.call('list_agents', nativeToScVal(limit, { type: 'u32' }));
    const retval = await simulateRead(op);
    if (!retval) return [];
    const vec = scValToNative(retval);
    if (!Array.isArray(vec)) return [];
    return vec.map(mapAgent);
  } catch (err) {
    logger.error({ err }, 'listAgents failed');
    throw err;
  }
}

export async function listAgentsPage(page = 0, pageSize = 20) {
  try {
    const contract = getAgentsContract();
    const op = contract.call(
      'list_agents_page',
      nativeToScVal(page, { type: 'u32' }),
      nativeToScVal(pageSize, { type: 'u32' })
    );
    const retval = await simulateRead(op);
    if (!retval) return [];
    const vec = scValToNative(retval);
    if (!Array.isArray(vec)) return [];
    return vec.map(mapAgent);
  } catch (err) {
    logger.error({ err, page, pageSize }, 'listAgentsPage failed');
    throw err;
  }
}

export async function getAgent(agentAddress) {
  try {
    const contract = getAgentsContract();
    const op = contract.call(
      'get_agent',
      nativeToScVal(Address.fromString(agentAddress), { type: 'address' })
    );
    const retval = await simulateRead(op);
    if (!retval) return null;
    const native = scValToNative(retval);
    if (!native) return null;
    return mapAgent(native);
  } catch (err) {
    logger.error({ err, agentAddress }, 'getAgent failed');
    return null;
  }
}

export async function getAgentPolicy(agentAddress) {
  try {
    const contract = getAgentsContract();
    const op = contract.call(
      'get_policy',
      nativeToScVal(Address.fromString(agentAddress), { type: 'address' })
    );
    const retval = await simulateRead(op);
    if (!retval) return null;
    const native = scValToNative(retval);
    if (!native) return null;
    return mapPolicy(native);
  } catch (err) {
    logger.error({ err, agentAddress }, 'getAgentPolicy failed');
    return null;
  }
}

export async function getAgentScore(agentAddress) {
  try {
    const contract = getAgentsContract();
    const op = contract.call(
      'get_score',
      nativeToScVal(Address.fromString(agentAddress), { type: 'address' })
    );
    const retval = await simulateRead(op);
    if (!retval) return -1;
    return Number(scValToNative(retval));
  } catch (err) {
    logger.error({ err, agentAddress }, 'getAgentScore failed');
    return -1;
  }
}

export async function getAgentCount() {
  try {
    const contract = getAgentsContract();
    const op = contract.call('get_agent_count');
    const retval = await simulateRead(op);
    if (!retval) return 0;
    return Number(scValToNative(retval));
  } catch (err) {
    logger.error({ err }, 'getAgentCount failed');
    return 0;
  }
}

export async function registerAgentOnChain(agentAddress, name, description) {
  try {
    const contract = getAgentsContract();
    const keypair = getServerKeypair();
    const ownerAddress = Address.fromString(keypair.publicKey());
    const agentAddr = Address.fromString(agentAddress);

    const op = contract.call(
      'register_agent',
      nativeToScVal(agentAddr, { type: 'address' }),
      nativeToScVal(name, { type: 'string' }),
      nativeToScVal(description, { type: 'string' }),
      nativeToScVal(ownerAddress, { type: 'address' })
    );

    const result = await simulateAndSubmit(op);
    const retval = result.returnValue;
    return retval ? Number(scValToNative(retval)) : null;
  } catch (err) {
    logger.error({ err, agentAddress, name }, 'registerAgentOnChain failed');
    throw err;
  }
}

export async function recordPaymentOnChain(agentAddress, amountStroops, success) {
  try {
    const contract = getAgentsContract();
    const agentAddr = Address.fromString(agentAddress);

    const op = contract.call(
      'record_payment',
      nativeToScVal(agentAddr, { type: 'address' }),
      nativeToScVal(BigInt(amountStroops), { type: 'i128' }),
      nativeToScVal(success, { type: 'bool' })
    );

    await simulateAndSubmit(op);
    return true;
  } catch (err) {
    logger.error({ err, agentAddress }, 'recordPaymentOnChain failed');
    throw err;
  }
}

export async function isAgentEligible(agentAddress, minScore) {
  try {
    const contract = getAgentsContract();
    const op = contract.call(
      'is_eligible',
      nativeToScVal(Address.fromString(agentAddress), { type: 'address' }),
      nativeToScVal(minScore, { type: 'i32' })
    );
    const retval = await simulateRead(op);
    if (!retval) return false;
    return Boolean(scValToNative(retval));
  } catch (err) {
    logger.error({ err, agentAddress, minScore }, 'isAgentEligible failed');
    return false;
  }
}

export async function checkSpendingAllowed(agentAddress, amountStroops) {
  try {
    const contract = getAgentsContract();
    const op = contract.call(
      'check_spending_allowed',
      nativeToScVal(Address.fromString(agentAddress), { type: 'address' }),
      nativeToScVal(BigInt(amountStroops), { type: 'i128' })
    );
    const retval = await simulateRead(op);
    if (!retval) return false;
    return Boolean(scValToNative(retval));
  } catch (err) {
    logger.error({ err, agentAddress }, 'checkSpendingAllowed failed');
    return false;
  }
}

export async function flagAgentOnChain(agentAddress, reason, callerAddress) {
  try {
    const contract = getAgentsContract();
    const keypair = getServerKeypair();
    const caller = Address.fromString(callerAddress ?? keypair.publicKey());

    const op = contract.call(
      'flag_agent',
      nativeToScVal(Address.fromString(agentAddress), { type: 'address' }),
      nativeToScVal(reason, { type: 'string' }),
      nativeToScVal(caller, { type: 'address' })
    );

    await simulateAndSubmit(op);
    return true;
  } catch (err) {
    logger.error({ err, agentAddress, reason }, 'flagAgentOnChain failed');
    throw err;
  }
}

export async function deactivateAgentOnChain(agentAddress, callerAddress) {
  try {
    const contract = getAgentsContract();
    const keypair = getServerKeypair();
    const caller = Address.fromString(callerAddress ?? keypair.publicKey());

    const op = contract.call(
      'deactivate_agent',
      nativeToScVal(Address.fromString(agentAddress), { type: 'address' }),
      nativeToScVal(caller, { type: 'address' })
    );

    await simulateAndSubmit(op);
    return true;
  } catch (err) {
    logger.error({ err, agentAddress }, 'deactivateAgentOnChain failed');
    throw err;
  }
}

export async function updatePolicyOnChain(
  agentAddress,
  maxPerTxStroops,
  maxPerDayStroops,
  allowedCategories,
  minScoreToEarn,
  callerAddress
) {
  try {
    const contract = getAgentsContract();
    const keypair = getServerKeypair();
    const caller = Address.fromString(callerAddress ?? keypair.publicKey());

    const op = contract.call(
      'update_policy',
      nativeToScVal(Address.fromString(agentAddress), { type: 'address' }),
      nativeToScVal(BigInt(maxPerTxStroops), { type: 'i128' }),
      nativeToScVal(BigInt(maxPerDayStroops), { type: 'i128' }),
      nativeToScVal(allowedCategories, { type: 'string' }),
      nativeToScVal(minScoreToEarn, { type: 'i32' }),
      nativeToScVal(caller, { type: 'address' })
    );

    await simulateAndSubmit(op);
    return true;
  } catch (err) {
    logger.error({ err, agentAddress }, 'updatePolicyOnChain failed');
    throw err;
  }
}
