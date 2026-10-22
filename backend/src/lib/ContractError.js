export class ContractError extends Error {
  /**
   * @param {string} message human-readable description sent to the client
   * @param {string} code stable machine-readable identifier
   * @param {number} [status] HTTP status this cause maps to. Errors built from
   *   a contract error map carry the status the map declares for that
   *   discriminant; everything else defaults to 400.
   */
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Error codes emitted by `POST /registry/submit-signed-tx` (see
 * `backend/src/routes/registry.js`). Kept here so the OpenAPI fragment and the
 * handler share one source of truth for the documented error surface.
 *
 * @type {ReadonlyArray<{ code: string, status: number, description: string }>}
 */
export const SUBMIT_SIGNED_TX_ERROR_CODES = Object.freeze([
  {
    code: 'INVALID_REQUEST',
    status: 400,
    description: 'Request body is missing or malformed (e.g. `signedTxXdr` absent or not a string).',
  },
  {
    code: 'INVALID_SIGNED_TX',
    status: 400,
    description: 'The supplied signed transaction envelope could not be decoded or parsed.',
  },
  {
    code: 'CONTRACT_ERROR',
    status: 400,
    description: 'The contract rejected the transaction; `error` carries the contract message.',
  },
  {
    code: 'TRANSACTION_TIMEOUT',
    status: 504,
    description: 'The transaction was not confirmed before the submission deadline.',
  },
  {
    code: 'RPC_THROTTLED',
    status: 503,
    description: 'The upstream RPC endpoint throttled the submission; retry later.',
  },
  {
    code: 'INTERNAL_ERROR',
    status: 500,
    description: 'Unexpected server failure while submitting the signed transaction.',
  },
]);

export function handleContractError(err, res, defaultMessage, defaultCode) {
  if (err instanceof ContractError) {
    let status = err.status ?? 400;
    if (err.code === 'TRANSACTION_TIMEOUT') {
      status = 504;
    }
    if (err.code === 'RPC_THROTTLED') {
      status = 503;
    }
    return res.status(status).json({ error: err.message, code: err.code });
  }
  return res.status(500).json({ error: defaultMessage, code: defaultCode });
}
