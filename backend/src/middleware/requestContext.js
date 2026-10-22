import { randomUUID } from 'node:crypto';
import pinoHttp from 'pino-http';
import logger, { requestContext } from '../lib/logger.js';

function getRequestId(req) {
  const inboundId = req.headers['x-request-id'];

  if (typeof inboundId === 'string' && inboundId.trim()) {
    return inboundId.trim();
  }

  return randomUUID();
}

export function createRequestLogger(baseLogger = logger) {
  return pinoHttp({
    logger: baseLogger,
    genReqId(req, res) {
      const requestId = getRequestId(req);
      res.setHeader('X-Request-Id', requestId);
      return requestId;
    },
    // Emit one structured completion line per request with duration and outcome.
    // Request id is included by pino-http as req.id. Avoid logging secrets or bodies.
    customLogLevel(req, res, err) {
      if (err) {
        return 'error';
      }
      if (res.statusCode >= 500) {
        return 'error';
      }
      if (res.statusCode >= 400) {
        return 'warn';
      }
      return 'info';
    },
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url,
          // Caller address for correlation.
          remoteAddress: req.ipaddress || req.socket?.remoteAddress,
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
    // Attach outcome field to the completion line.
    customProps(req, res) {
      return {
        outcome: res.statusCode >= 400 ? 'failure' : 'success',
      };
    },
  });
}

export const requestLogger = createRequestLogger();

export function requestContextMiddleware(req, res, next) {
  const requestId = req.id;

  res.setHeader('X-Request-Id', requestId);

  const originalJson = res.json.bind(res);

  res.json = (body) => {
    if (
      res.statusCode >= 400 &&
      body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      body.requestId === undefined
    ) {
      body = { ...body, requestId };
    }

    return originalJson(body);
  };

  requestContext.run({ requestId }, next);
}
