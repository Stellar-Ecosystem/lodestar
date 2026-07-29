/**
 * Registry service layer — business logic wrapping contract calls.
 *
 * Each function handles the chain interaction and data transformation.
 * The route layer handles HTTP concerns (parsing params, calling validation,
 * mapping errors to HTTP responses).
 */
import {
  listServices,
  listServicesByProvider,
  getService,
  getServiceCount,
  deactivateServiceOnChain,
  updateReputation,
  isAllowedReputationAgent,
  buildUnsignedRegistryTx,
  validatePreparedRegistrySubmission,
  submitSignedRegistryTx,
  SERVICE_MAX_TTL,
  SERVICE_TTL_WARNING_LEDGERS,
} from './contract.js';
import { getCurrentLedgerSequence } from './stellar.js';
import { getReputationHistory } from './reputationHistory.js';
import { ContractError } from './ContractError.js';
import logger from './logger.js';

export const PAGE_SIZE = 20;

/**
 * Annotate a service entry with ttl_warning based on whether its estimated
 * remaining TTL falls below SERVICE_TTL_WARNING_LEDGERS.
 *
 * Omits the field entirely when currentLedger is null (graceful degradation
 * when the ledger fetch fails).
 */
export function annotateTtlWarning(service, currentLedger) {
  if (currentLedger == null) return service;

  const expiryLedger = service.registered_at + SERVICE_MAX_TTL;
  const warningOnset = expiryLedger - SERVICE_TTL_WARNING_LEDGERS;

  return {
    ...service,
    ttl_warning: currentLedger >= warningOnset,
  };
}

/**
 * Fetch and annotate a page of services with TTL warnings.
 * Optionally filters by a search query.
 */
export async function listServicesWithTtl({ category, q, page = 0 } = {}) {
  const [servicesResult, ledgerResult] = await Promise.allSettled([
    listServices({ category: category || undefined, page, pageSize: PAGE_SIZE }),
    getCurrentLedgerSequence(),
  ]);

  if (servicesResult.status === "rejected") throw servicesResult.reason;

  if (ledgerResult.status === "rejected") {
    logger.warn(
      { err: ledgerResult.reason },
      "Failed to fetch current ledger for TTL annotation on listServices",
    );
  }

  const currentLedger =
    ledgerResult.status === "fulfilled" ? ledgerResult.value : null;

  let services = servicesResult.value.map((s) =>
    annotateTtlWarning(s, currentLedger),
  );

  if (q && typeof q === "string" && q.trim()) {
    const query = q.trim().toLowerCase();
    services = services.filter(
      (s) =>
        (s.name && s.name.toLowerCase().includes(query)) ||
        (s.description && s.description.toLowerCase().includes(query)),
    );
  }

  return { services, count: services.length };
}

/**
 * Fetch a single service and annotate with TTL warning.
 */
export async function getServiceWithTtl(id) {
  const [serviceResult, ledgerResult] = await Promise.allSettled([
    getService(id),
    getCurrentLedgerSequence(),
  ]);

  if (serviceResult.status === "rejected") throw serviceResult.reason;

  const service = serviceResult.value;
  if (!service) return null;

  if (ledgerResult.status === "rejected") {
    logger.warn(
      { err: ledgerResult.reason },
      "Failed to fetch current ledger for TTL annotation on getService",
    );
  }

  const currentLedger =
    ledgerResult.status === "fulfilled" ? ledgerResult.value : null;
  return annotateTtlWarning(service, currentLedger);
}

/**
 * List services by provider address with TTL annotations.
 */
export async function listServicesByProviderWithTtl(address) {
  const [servicesResult, ledgerResult] = await Promise.allSettled([
    listServicesByProvider(address),
    getCurrentLedgerSequence(),
  ]);

  if (servicesResult.status === "rejected") throw servicesResult.reason;

  if (ledgerResult.status === "rejected") {
    logger.warn(
      { err: ledgerResult.reason },
      "Failed to fetch current ledger for TTL annotation on listServicesByProvider",
    );
  }

  const currentLedger =
    ledgerResult.status === "fulfilled" ? ledgerResult.value : null;

  const services = servicesResult.value.map((s) =>
    annotateTtlWarning(s, currentLedger),
  );

  return { services, count: services.length };
}

/**
 * Compute global registry stats.
 */
export async function getStats() {
  const totalServices = await getServiceCount();
  const totalPages = Math.ceil(totalServices / PAGE_SIZE);
  let allServices = [];
  for (let i = 0; i < totalPages; i++) {
    const page = await listServices({ page: i, pageSize: PAGE_SIZE });
    allServices.push(...page);
  }

  const categories = [...new Set(allServices.map((s) => s.category))];
  const latestService = allServices.reduce(
    (latest, s) =>
      s.registered_at > (latest?.registered_at ?? 0) ? s : latest,
    null,
  );

  return { totalServices, categories, latestService };
}

/**
 * Deactivate a service on chain.
 */
export function deactivateService(id, providerAddress) {
  return deactivateServiceOnChain(id, providerAddress);
}

/**
 * Prepare a registration transaction (unsigned XDR).
 */
export function prepareRegister(providerAddress, details) {
  return buildUnsignedRegistryTx("register", providerAddress, details);
}

/**
 * Prepare a deactivation transaction (unsigned XDR).
 */
export function prepareDeactivate(providerAddress, id) {
  return buildUnsignedRegistryTx("deactivate", providerAddress, { id });
}

/**
 * Submit a wallet-signed transaction.
 */
export function submitSignedTx(signedXdr, submitToken) {
  validatePreparedRegistrySubmission(submitToken, signedXdr);
  return submitSignedRegistryTx(signedXdr);
}

/**
 * Cast a reputation vote for a service as an allowlisted agent.
 */
export async function castReputationVote(id, positive, agent) {
  if (!isAllowedReputationAgent(agent)) {
    throw new ContractError(
      "This agent is not permitted to vote through the hosted backend. Only registered demo agents may; other agents must submit a wallet-signed transaction.",
      "AGENT_NOT_ALLOWED",
    );
  }

  return updateReputation(id, positive, agent);
}

/**
 * Get reputation history for a service.
 */
export async function getServiceHistory(id) {
  const service = await getService(id);
  if (!service) return null;

  const history = getReputationHistory(id);
  return { service, history };
}
