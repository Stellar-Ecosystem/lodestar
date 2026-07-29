import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

/**
 * Run `fn` with `requestId` available to any code executed inside it —
 * including nested async calls — via {@link getRequestId}. This lets the
 * signed-transaction audit trail (see lib/auditLog.js) correlate on-chain
 * writes back to the inbound HTTP request without threading a requestId
 * parameter through every contract.js function signature.
 */
export function runWithRequestId(requestId, fn) {
  return als.run({ requestId }, fn);
}

/** The request ID of the currently-executing request, or null outside of one (e.g. a seed script). */
export function getRequestId() {
  return als.getStore()?.requestId ?? null;
}
