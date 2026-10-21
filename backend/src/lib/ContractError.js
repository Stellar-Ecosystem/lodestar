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

export function contractErrorResponse(err, defaultMessage, defaultCode) {
  if (err instanceof ContractError) {
    let status = err.status ?? 400;
    if (err.code === 'TRANSACTION_TIMEOUT') {
      status = 504;
    }
    if (err.code === 'RPC_THROTTLED') {
      status = 503;
    }
    return { status, body: { error: err.message, code: err.code } };
  }
  return { status: 500, body: { error: defaultMessage, code: defaultCode } };
}

export function handleContractError(err, res, defaultMessage, defaultCode) {
  const { status, body } = contractErrorResponse(err, defaultMessage, defaultCode);
  return res.status(status).json(body);
}
