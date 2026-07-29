jest.mock('@stellar/freighter-api', () => ({
  isConnected: jest.fn(),
  getAddress: jest.fn(),
  signTransaction: jest.fn(),
  getNetworkDetails: jest.fn(),
  requestAccess: jest.fn(),
}));

import {
  getNetworkDetails,
  signTransaction,
} from '@stellar/freighter-api';
import {
  assertNetworkMatch,
  isFreighterInstalled,
  NetworkMismatchError,
  signTx,
} from '../lib/freighter';

const mockedGetNetworkDetails = getNetworkDetails as jest.MockedFunction<
  typeof getNetworkDetails
>;
const mockedSignTransaction = signTransaction as jest.MockedFunction<
  typeof signTransaction
>;

describe('frontend/lib/freighter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    if (typeof window !== 'undefined') {
      delete (window as any).freighter;
    }
  });

  it('detects when Freighter is installed by window.freighter', () => {
    Object.defineProperty(window, 'freighter', {
      value: {},
      configurable: true,
    });
    expect(isFreighterInstalled()).toBe(true);
  });

  it('returns false when Freighter is not installed', () => {
    expect(isFreighterInstalled()).toBe(false);
  });

  it('skips the check when Freighter network details cannot be fetched', async () => {
    mockedGetNetworkDetails.mockRejectedValue(new Error('No extension'));
    await expect(assertNetworkMatch('Test SDF Network ; September 2015')).resolves.toBeUndefined();
  });

  it('skips the check when Freighter returns an error payload', async () => {
    mockedGetNetworkDetails.mockResolvedValue({
      networkPassphrase: 'Test SDF Network ; September 2015',
      network: 'Testnet',
      error: 'not connected',
    });
    await expect(assertNetworkMatch('Test SDF Network ; September 2015')).resolves.toBeUndefined();
  });

  it('throws NetworkMismatchError when the wallet network differs', async () => {
    mockedGetNetworkDetails.mockResolvedValue({
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
      network: 'Public',
    });
    await expect(assertNetworkMatch('Test SDF Network ; September 2015')).rejects.toThrow(NetworkMismatchError);
  });

  it('resolves successfully when the wallet network matches', async () => {
    mockedGetNetworkDetails.mockResolvedValue({
      networkPassphrase: 'Test SDF Network ; September 2015',
      network: 'Testnet',
    });
    await expect(assertNetworkMatch('Test SDF Network ; September 2015')).resolves.toBeUndefined();
  });

  it('calls Freighter signTransaction and returns the signed XDR', async () => {
    mockedGetNetworkDetails.mockResolvedValue({
      networkPassphrase: 'Test SDF Network ; September 2015',
      network: 'Testnet',
    });
    mockedSignTransaction.mockResolvedValue({
      signedTxXdr: 'signed-xdr',
    });

    const result = await signTx('unsigned-xdr', 'Test SDF Network ; September 2015');
    expect(result).toBe('signed-xdr');
    expect(mockedSignTransaction).toHaveBeenCalledWith('unsigned-xdr', {
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
  });

  it('throws when Freighter signTransaction returns an error', async () => {
    mockedGetNetworkDetails.mockResolvedValue({
      networkPassphrase: 'Test SDF Network ; September 2015',
      network: 'Testnet',
    });
    mockedSignTransaction.mockResolvedValue({
      error: 'Unable to sign',
    } as any);

    await expect(signTx('unsigned-xdr', 'Test SDF Network ; September 2015')).rejects.toThrow('Unable to sign');
  });
});
