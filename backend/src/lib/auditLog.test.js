import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../config.js', () => ({
  default: { auditLogPath: 'test-audit.log' },
}));

const { mockAppendFileSync } = vi.hoisted(() => ({ mockAppendFileSync: vi.fn() }));
vi.mock('node:fs', () => ({ appendFileSync: mockAppendFileSync }));

const { mockLoggerInfo, mockLoggerError } = vi.hoisted(() => ({
  mockLoggerInfo: vi.fn(),
  mockLoggerError: vi.fn(),
}));
vi.mock('./logger.js', () => ({
  default: { info: mockLoggerInfo, error: mockLoggerError },
}));

const { mockGetRequestId } = vi.hoisted(() => ({ mockGetRequestId: vi.fn(() => null) }));
vi.mock('./requestContext.js', () => ({ getRequestId: mockGetRequestId }));

import { recordAuditEvent, getAuditLogPath } from './auditLog.js';

describe('auditLog', () => {
  beforeEach(() => {
    mockAppendFileSync.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerError.mockReset();
    mockGetRequestId.mockReset().mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes exactly one JSON line to the configured audit log path', () => {
    recordAuditEvent({
      actor: 'GACTOR',
      contractId: 'CCONTRACT',
      function: 'register_service',
      args: { provider: 'GACTOR', name: 'Test' },
      txHash: 'abc123',
      result: 'success',
    });

    expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
    const [path, line, encoding] = mockAppendFileSync.mock.calls[0];
    expect(path).toBe('test-audit.log');
    expect(encoding).toBe('utf-8');
    expect(line.endsWith('\n')).toBe(true);

    const record = JSON.parse(line);
    expect(record.actor).toBe('GACTOR');
    expect(record.contractId).toBe('CCONTRACT');
    expect(record.function).toBe('register_service');
    expect(record.args).toEqual({ provider: 'GACTOR', name: 'Test' });
    expect(record.txHash).toBe('abc123');
    expect(record.result).toBe('success');
    expect(typeof record.timestamp).toBe('string');
    expect(typeof record.requestId).toBe('string');
  });

  it('is queryable by actor and by txHash (both are top-level fields)', () => {
    const record = recordAuditEvent({
      actor: 'GQUERYABLE',
      function: 'record_payment',
      args: {},
      txHash: 'txhash-for-query',
      result: 'success',
    });
    expect(record.actor).toBe('GQUERYABLE');
    expect(record.txHash).toBe('txhash-for-query');
  });

  it('uses the explicit requestId when provided, without consulting request context', () => {
    const record = recordAuditEvent({
      requestId: 'explicit-id',
      function: 'flag_agent',
      args: {},
      result: 'success',
    });
    expect(record.requestId).toBe('explicit-id');
    expect(mockGetRequestId).not.toHaveBeenCalled();
  });

  it('falls back to the current request context requestId when none is explicit', () => {
    mockGetRequestId.mockReturnValue('from-context');
    const record = recordAuditEvent({ function: 'flag_agent', args: {}, result: 'success' });
    expect(record.requestId).toBe('from-context');
  });

  it('generates a fresh requestId when neither explicit nor context is available', () => {
    mockGetRequestId.mockReturnValue(null);
    const a = recordAuditEvent({ function: 'flag_agent', args: {}, result: 'success' });
    const b = recordAuditEvent({ function: 'flag_agent', args: {}, result: 'success' });
    expect(a.requestId).toEqual(expect.any(String));
    expect(a.requestId).not.toBe(b.requestId);
  });

  it('redacts any argument whose key looks like a secret', () => {
    const record = recordAuditEvent({
      function: 'update_policy',
      args: {
        agent_address: 'GABC',
        server_secret: 'SUPERSECRETSEED',
        callerPrivateKey: 'SANOTHERSECRET',
        hmacSignature: 'deadbeef',
        password: 'hunter2',
        min_score_to_earn: 100,
      },
      result: 'success',
    });
    expect(record.args).toEqual({
      agent_address: 'GABC',
      server_secret: '[redacted]',
      callerPrivateKey: '[redacted]',
      hmacSignature: '[redacted]',
      password: '[redacted]',
      min_score_to_earn: 100,
    });
  });

  it('includes error code and message only for non-success results', () => {
    const success = recordAuditEvent({ function: 'register_agent', args: {}, result: 'success' });
    expect(success.error).toBeUndefined();

    const failed = recordAuditEvent({
      function: 'register_agent',
      args: {},
      result: 'failed_onchain',
      error: { code: 'TRANSACTION_FAILED', message: 'boom' },
    });
    expect(failed.error).toEqual({ code: 'TRANSACTION_FAILED', message: 'boom' });
  });

  it('still emits the record via the app logger even if the file write fails', () => {
    mockAppendFileSync.mockImplementation(() => {
      throw new Error('disk full');
    });
    recordAuditEvent({ function: 'register_agent', args: {}, result: 'success' });
    expect(mockLoggerError).toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ audit: true, function: 'register_agent' }),
      'signed_transaction_audit',
    );
  });

  it('exposes the configured audit log path', () => {
    expect(getAuditLogPath()).toBe('test-audit.log');
  });
});
