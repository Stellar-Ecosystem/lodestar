import { AsyncLocalStorage } from 'node:async_hooks';
import pino from 'pino';
import config from '../config.js';

export const requestContext = new AsyncLocalStorage();

export function createLogger(destination) {
  const options = {
    level: config.logLevel,
    mixin() {
      const context = requestContext.getStore();

      return context?.requestId
        ? { requestId: context.requestId }
        : {};
    },
    ...(!destination && config.nodeEnv === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true },
          },
        }
      : {}),
  };

  return pino(options, destination);
}

export function getRequestLogger(req) {
  const context = requestContext.getStore();
  const requestId = context?.requestId || req?.id;
  const bindings = {};

  if (requestId) {
    bindings.requestId = requestId;
  }

  const callerAddress = req?.ip ? req.ip : req?.socket?.remoteAddress;
  if (callerAddress) {
    bindings.callerAddress = callerAddress;
  }

  return createLogger().child(bindings);
}

export function logRequestCompletion(log, { outcome, durationMs, ...rest }) {
  const payload = {
    outcome,
    durationMs,
    ...rest,
  };

  if (outcome === 'success') {
    log.info(payload, 'request completed');
  } else {
    log.warn(payload, 'request completed');
  }
}

const logger = createLogger();

export default logger;
