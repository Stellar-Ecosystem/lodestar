import { describe, expect, it } from 'vitest';

import {
  AGENT_ERROR,
  AGENT_ERROR_CODES,
  AGENT_ERROR_SCOPE,
  REGISTRY_ERROR_CODES,
  REGISTRY_ERROR_SCOPE,
  agentErrorFromCode,
  agentErrorFromHostError,
  contractErrorFromHostError,
  extractRegistryErrorCode,
  registryErrorFromCode,
  registryErrorFromHostError,
} from './contractErrors.js';

describe('registry contract error mapping', () => {
  it('documents every registry contract error code', () => {
    expect(Object.keys(REGISTRY_ERROR_CODES).map(Number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it('maps numeric registry codes to API ContractError objects', () => {
    expect(registryErrorFromCode(3)).toMatchObject({
      name: 'ContractError',
      code: 'DUPLICATE_SERVICE',
      message: 'Active service with same provider and endpoint already exists',
      registryErrorCode: 3,
    });
  });

  it('maps the get_service_count failure causes to distinct variants', () => {
    const expected = [
      [14, 'REGISTRY_COUNT_OVERFLOW', 'Service count exceeds the maximum supported value'],
      [15, 'REGISTRY_STORAGE_CORRUPTED', 'Registry storage could not be read consistently'],
    ];

    for (const [code, name, message] of expected) {
      expect(REGISTRY_ERROR_CODES[code]).toMatchObject({ code: name, message });
      expect(registryErrorFromCode(code)).toMatchObject({
        name: 'ContractError',
        code: name,
        message,
        registryErrorCode: code,
      });
    }
  });

  it('extracts registry codes from structured RPC payloads', () => {
    expect(extractRegistryErrorCode({ errorResult: { contractCode: 7 } })).toBe(7);
    expect(extractRegistryErrorCode({ diagnosticEvents: [{ errorCode: 8 }] })).toBe(8);
  });

  it('extracts registry codes from Soroban contract error strings without matching messages', () => {
    expect(extractRegistryErrorCode('HostError: Error(Contract, #4)')).toBe(4);
    expect(extractRegistryErrorCode('transaction failed with ContractError(6)')).toBe(6);
  });

  it('extracts the get_service_count failure variants from host errors', () => {
    expect(registryErrorFromHostError({ contractCode: 14 })).toMatchObject({
      code: 'REGISTRY_COUNT_OVERFLOW',
      registryErrorCode: 14,
    });
    expect(registryErrorFromHostError({ contractCode: 15 })).toMatchObject({
      code: 'REGISTRY_STORAGE_CORRUPTED',
      registryErrorCode: 15,
    });
  });

  it('ignores unknown numeric codes', () => {
    expect(extractRegistryErrorCode({ contractCode: 999 })).toBeNull();
    expect(registryErrorFromHostError({ contractCode: 999 })).toBeNull();
  });
});

describe('agents contract error mapping', () => {
  it('documents every agents contract error code', () => {
    expect(AGENT_ERROR).toEqual({
      INVALID_AMOUNT: 1,
      ARITHMETIC_OVERFLOW: 2,
      AGENT_ALREADY_REGISTERED: 3,
      AGENT_LIST_FULL: 4,
      AGENT_COUNT_OVERFLOW: 5,
      AGENT_NOT_FOUND: 6,
    });
    expect(Object.keys(AGENT_ERROR_CODES).map(Number)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('maps each agents code to a distinct API ContractError with an HTTP status', () => {
    const expected = [
      [1, 'INVALID_AMOUNT', 400],
      [2, 'ARITHMETIC_OVERFLOW', 400],
      [3, 'AGENT_ALREADY_REGISTERED', 409],
      [4, 'AGENT_LIST_FULL', 503],
      [5, 'AGENT_COUNT_OVERFLOW', 503],
      [6, 'AGENT_NOT_FOUND', 404],
    ];

    for (const [numericCode, code, status] of expected) {
      expect(agentErrorFromCode(numericCode)).toMatchObject({
        name: 'ContractError',
        code,
        status,
        contractErrorCode: numericCode,
      });
    }
  });

  it('reports AgentNotFound (code 6, HTTP 404) as its own cause', () => {
    // This is the code that replaces the old in-band `-1` sentinel.
    const err = agentErrorFromHostError({ errorResult: { contractCode: 6 } });
    expect(err).toMatchObject({
      code: 'AGENT_NOT_FOUND',
      status: 404,
      contractErrorCode: 6,
    });
  });

  it('extracts agents codes from host error strings', () => {
    expect(agentErrorFromHostError('HostError: Error(Contract, #6)')).toMatchObject({
      code: 'AGENT_NOT_FOUND',
      contractErrorCode: 6,
    });
  });

  it('ignores unknown numeric codes', () => {
    expect(agentErrorFromCode(999)).toBeNull();
    expect(agentErrorFromHostError({ contractCode: 999 })).toBeNull();
  });
});

describe('scope-aware host error resolution', () => {
  it('resolves the same numeric code against the invoked contract only', () => {
    // Registry code 6 is CALLER_NOT_REGISTERED_AGENT; agents code 6 is
    // AGENT_NOT_FOUND. Resolving against the wrong map would mislabel failures.
    expect(contractErrorFromHostError({ contractCode: 6 }, REGISTRY_ERROR_SCOPE)).toMatchObject({
      code: 'CALLER_NOT_REGISTERED_AGENT',
    });
    expect(contractErrorFromHostError({ contractCode: 6 }, AGENT_ERROR_SCOPE)).toMatchObject({
      code: 'AGENT_NOT_FOUND',
    });
  });

  it('defaults to the registry scope for backwards compatibility', () => {
    expect(contractErrorFromHostError({ contractCode: 6 })).toMatchObject({
      code: 'CALLER_NOT_REGISTERED_AGENT',
    });
  });
});
