import { randomUUID } from 'node:crypto';
import { runWithRequestId } from '../lib/requestContext.js';

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Assigns (or propagates) a request ID for every inbound request, exposes it
 * as `req.requestId` and the `X-Request-Id` response header, and makes it
 * available to any code running downstream — including the signed-transaction
 * audit trail — via AsyncLocalStorage, without threading it through every
 * function signature between a route handler and lib/contract.js.
 */
export function requestIdMiddleware(req, res, next) {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const requestId = typeof incoming === 'string' && incoming.trim() ? incoming.trim() : randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  runWithRequestId(requestId, next);
}
