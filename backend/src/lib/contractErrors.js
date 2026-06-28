import { ContractError } from './ContractError.js';

export class SimulationError extends ContractError {
  constructor(message, details) {
    super(message, 'SIMULATION_FAILED');
    this.name = 'SimulationError';
    if (details !== undefined) this.details = details;
  }
}

export class TransactionFailedError extends ContractError {
  constructor(message, hash, details) {
    super(message, 'TRANSACTION_FAILED');
    this.name = 'TransactionFailedError';
    if (hash) this.hash = hash;
    if (details !== undefined) this.details = details;
  }
}

export class TransactionTimeoutError extends ContractError {
  constructor(message, hash) {
    super(message, 'TRANSACTION_TIMEOUT');
    this.name = 'TransactionTimeoutError';
    if (hash) this.hash = hash;
  }
}

export class ReturnValueParseError extends ContractError {
  constructor(message, hash, cause) {
    super(message, 'RETURN_VALUE_PARSE_FAILED');
    this.name = 'ReturnValueParseError';
    if (hash) this.hash = hash;
    if (cause) this.cause = cause;
  }
}
