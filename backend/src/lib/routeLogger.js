import logger from './logger.js';

/**
 * A request-scoped child logger.
 *
 * `req.log` is the child pino-http created for the request, so binding extra
 * fields to it keeps the request id next to the route-specific identifiers on
 * every line a route emits (#670). When the request did not pass through the
 * HTTP logger (a bare router mount in a test), the shared logger is used
 * instead and the request id is bound explicitly.
 *
 * @param {object} req Express request.
 * @param {object} [bindings] Fields bound to every line of the returned logger.
 * @returns {object} A pino-like logger (`info`/`warn`/`error`).
 */
export function getRouteLogger(req, bindings = {}) {
  const requestId = req?.id ?? req?.requestId;
  const base = typeof req?.log?.child === 'function' ? req.log : logger;

  if (typeof base.child !== 'function') return base;

  return base.child({ ...bindings, ...(requestId ? { requestId } : {}) });
}
