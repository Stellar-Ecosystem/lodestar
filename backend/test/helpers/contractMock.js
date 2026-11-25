import { vi } from 'vitest';

/**
 * A stand-in for `src/lib/contract.js` covering every export the app imports.
 *
 * The integration tests mount the real application, so the contract layer has
 * to be mocked — but the mock must expose the full public surface of the
 * module, otherwise the ESM import of a missing name fails at import time.
 *
 * @returns {object} The mocked module namespace.
 */
export function createContractMock() {
  return {
    // Registry reads and writes
    listServices: vi.fn().mockResolvedValue([]),
    listServicesByProvider: vi.fn().mockResolvedValue([]),
    getService: vi.fn().mockResolvedValue(null),
    getServiceCount: vi.fn().mockResolvedValue(0),
    deactivateServiceOnChain: vi.fn(),
    updateReputation: vi.fn(),
    isAllowedReputationAgent: vi.fn().mockReturnValue(false),
    buildUnsignedRegistryTx: vi.fn(),
    validatePreparedRegistrySubmission: vi.fn(),
    submitSignedRegistryTx: vi.fn(),
    registerServiceOnChain: vi.fn(),

    // Agents
    listAgents: vi.fn().mockResolvedValue([]),
    listAgentsPage: vi.fn().mockResolvedValue([]),
    getAgent: vi.fn().mockResolvedValue(null),
    getAgentPolicy: vi.fn().mockResolvedValue(null),
    getAgentScore: vi.fn().mockResolvedValue(0),
    getAgentCount: vi.fn().mockResolvedValue(0),
    registerAgentOnChain: vi.fn(),
    recordPaymentOnChain: vi.fn(),
    checkSpendingAllowed: vi.fn(),
    isAgentEligible: vi.fn(),
    flagAgentOnChain: vi.fn(),
    deactivateAgentOnChain: vi.fn(),
    adminDeactivateAgentOnChain: vi.fn(),
    updatePolicyOnChain: vi.fn(),
    buildUnsignedAgentTx: vi.fn(),
    submitSignedAgentTx: vi.fn(),
    isAgentRegistered: vi.fn(),

    // Submit queue / pending transactions
    getSubmitQueueDepth: vi.fn().mockReturnValue(0),
    drainSubmitQueue: vi.fn().mockResolvedValue(undefined),
    getPendingTransactionCount: vi.fn().mockReturnValue(0),
    getPendingTransactions: vi.fn().mockReturnValue([]),
    dumpPendingTransactions: vi.fn(),
    resumePendingTransactions: vi.fn().mockResolvedValue(undefined),

    // Constants
    SERVICE_MAX_TTL: 3_110_400,
    SERVICE_TTL_WARNING_LEDGERS: 311_040,
  };
}
