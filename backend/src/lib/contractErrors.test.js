import { describe, expect, it } from 'vitest';

import {
  AGENT_ERROR_CODES,
  REGISTRY_ERROR_CODES,
  extractAgentErrorCode,
  extractContractErrorCode,
  extractRegistryErrorCode,
  agentErrorFromCode,
  agentErrorFromHostError,
  contractErrorFromCode,
  registryErrorFromCode,
  registryErrorFromHostError,
} from './contractErrors.js';

describe('registry contract error mapping', () => {
  it('documents every registry contract error code', () => {
    expect(Object.keys(REGISTRY_ERROR_CODES).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
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
      [12, 'SERVICE_COUNT_OVERVIEW', 'Service count exceeds the maximum supported value'],
      [13, 'SERVICE_COUNT_STORAGE_CORRUPTED', 'Service count storage is corrupted'],
    ];

    for (const [code, name, message] of expected) {
      expect(REGISTRY_ERROR_CODES[code]).toMatchObject({ name, message });
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
    expect(registryErrorFromHostError({ contractCode: 12 })).toMatchObject({
      code: 'SERVICE_COUNT_OVERVIEW',
      registryErrorCode: 12,
    });
    expect(registryErrorFromHostError({ contractCode: 13 })).toMatchObject({
      code: 'SERVICE_COUNT_STORAGE_CORRUPTED',
      registryErrorCode: 13,
    });
  });

  it('ignores unknown numeric codes', () => {
    expect(extractRegistryErrorCode({ contractCode: 999 })).toBeNull();
    expect(registryErrorFromHostError({ contractCode: 999 })).toBeNull();
  });
});

describe('agents contract error mapping', () => {
  it('documents every agents contract error code', () => {
    expect(Object.keys(AGENT_ERROR_CODES).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('gives every check_spending_allowed cause its own variant and code', () => {
    const causes = [
      [1, 'INVALID_AMOUNT'],
      [2, 'ARITHMETIC_OVERFLOW'],
      [3, 'POLICY_NOT_FOUND'],
      [4, 'AGENT_NOT_FOUND'],
      [5, 'AGENT_INACTIVE'],
      [6, 'AGENT_FLAGGED'],
      [7, 'PER_TRANSACTION_LIMIT_EXCEEDED'],
      [8, 'DAILY_LIMIT_EXCEEDED'],
    ];

    for (const [code, name] of causes) {
      expect(AGENT_ERROR_CODES[code]).toMatchObject({ code: name });
      expect(agentErrorFromCode(code)).toMatchObject({
        name: 'ContractError',
        code: name,
        agentErrorCode: code,
      });
    }
  });

  it('does not collapse distinct causes onto a shared code', () => {
    const codes = causes_for(AGENT_ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('reuses the InvalidAmount and ArithmeticOverflow codes record_payment already reports', () => {
    // 1 and 2 predate the spending-policy guard and are already deployed, so
    // the guard must report the same numbers for the same meanings.
    expect(AGENT_ERROR_CODES[1].code).toBe('INVALID_AMOUNT');
    expect(AGENT_ERROR_CODES[2].code).toBe('ARITHMETIC_OVERFLOW');
  });

  it('extracts agents codes from structured RPC payloads and error strings', () => {
    expect(extractAgentErrorCode({ errorResult: { contractCode: 8 } })).toBe(8);
    expect(extractAgentErrorCode('HostError: Error(Contract, #7)')).toBe(7);
    expect(agentErrorFromHostError({ diagnosticEvents: [{ errorCode: 5 }] })).toMatchObject({
      code: 'AGENT_INACTIVE',
      agentErrorCode: 5,
    });
  });

  it('ignores codes the agents contract does not define', () => {
    expect(extractAgentErrorCode({ contractCode: 9 })).toBeNull();
    expect(agentErrorFromCode(9)).toBeNull();
    expect(agentErrorFromHostError({ contractCode: 999 })).toBeNull();
  });

  it('resolves overlapping numbers against the contract that produced them', () => {
    // Code 2 means ArithmeticOverflow for the agents contract and
    // INVALID_DESCRIPTION for the registry contract. A shared, unscoped lookup
    // would report the wrong cause here.
    expect(agentErrorFromCode(2)).toMatchObject({ code: 'ARITHMETIC_OVERFLOW' });
    expect(registryErrorFromCode(2)).toMatchObject({ code: 'INVALID_DESCRIPTION' });

    expect(extractAgentErrorCode({ contractCode: 2 })).toBe(2);
    expect(extractRegistryErrorCode({ contractCode: 2 })).toBe(2);
  });

  it('never resolves a code that the scoped contract does not define', () => {
    // 8 is DAILY_LIMIT_EXCEEDED for agents and PROVIDER_MISMATCH for the
    // registry: same number, two different causes.
    expect(agentErrorFromCode(8)).toMatchObject({ code: 'DAILY_LIMIT_EXCEEDED' });
    expect(registryErrorFromCode(8)).toMatchObject({ code: 'PROVIDER_MISMATCH' });
  });

  it('exposes a catalog-scoped extractor for callers that own the contract id', () => {
    expect(extractContractErrorCode({ contractCode: 6 }, AGENT_ERROR_CODES)).toBe(6);
    expect(extractContractErrorCode({ contractCode: 6 }, REGISTRY_ERROR_CODES)).toBe(6);
    expect(extractContractErrorCode({ contractCode: 8 }, AGENT_ERROR_CODES)).toBe(8);
  });

  it('does not let registry-only codes leak into the agents catalog', () => {
    // 9-15 exist on the registry but not on the agents contract, so an
    // agents-scoped lookup must not invent a cause for them.
    for (const code of [9, 10, 11, 12, 13, 14, 15]) {
      expect(extractAgentErrorCode({ contractCode: code })).toBeNull();
      expect(extractContractErrorCode({ contractCode: code }, AGENT_ERROR_CODES)).toBeNull();
    }
  });

  it('resolves through a named catalog and tags the error for that contract', () => {
    expect(contractErrorFromCode(2, 'agents')).toMatchObject({
      code: 'ARITHMETIC_OVERFLOW',
      contractErrorCode: 2,
      agentErrorCode: 2,
    });
    expect(contractErrorFromCode(2, 'registry')).toMatchObject({
      code: 'INVALID_DESCRIPTION',
      contractErrorCode: 2,
      registryErrorCode: 2,
    });
  });

  it('returns null for an unknown contract name or code instead of guessing', () => {
    expect(contractErrorFromCode(2, 'not-a-contract')).toBeNull();
    expect(contractErrorFromCode(99, 'agents')).toBeNull();
  });
});

function causes_for(catalog) {
  return Object.values(catalog).map((entry) => entry.code);
}
