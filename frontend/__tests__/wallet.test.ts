jest.mock('@creit-tech/stellar-wallets-kit/sdk', () => ({
  StellarWalletsKit: {
    init: jest.fn(),
    setWallet: jest.fn(),
    fetchAddress: jest.fn(),
  }
}));
jest.mock('@creit-tech/stellar-wallets-kit/modules/freighter', () => ({
  FreighterModule: jest.fn(),
  FREIGHTER_ID: 'freighter',
}));
jest.mock('@creit-tech/stellar-wallets-kit/modules/albedo', () => ({
  AlbedoModule: jest.fn(),
  ALBEDO_ID: 'albedo',
}));
jest.mock('@creit-tech/stellar-wallets-kit/modules/xbull', () => ({
  xBullModule: jest.fn(),
  XBULL_ID: 'xbull',
}));
jest.mock('@creit-tech/stellar-wallets-kit/modules/lobstr', () => ({
  LobstrModule: jest.fn(),
  LOBSTR_ID: 'lobstr',
}));
jest.mock('@creit-tech/stellar-wallets-kit/types', () => ({
  Networks: { TESTNET: 'Test SDF Network ; September 2015' },
}));

import { connectWithWallet, disconnectWallet, WalletErrorType, FREIGHTER_ID } from '../lib/wallet';
import { StellarWalletsKit } from '@creit-tech/stellar-wallets-kit/sdk';

const _origWindowDesc = Object.getOwnPropertyDescriptor(globalThis, 'window');

function restoreGlobals() {
  if (_origWindowDesc) {
    Object.defineProperty(globalThis, 'window', _origWindowDesc);
  }
  if (Object.getOwnPropertyDescriptor(navigator, 'userAgent')) {
    delete (navigator as any).userAgent;
  }
}

describe('wallet connection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    disconnectWallet();
    restoreGlobals();
  });

  afterEach(() => {
    restoreGlobals();
  });

  it('connects successfully and returns address', async () => {
    (StellarWalletsKit.setWallet as jest.Mock).mockResolvedValue(undefined);
    (StellarWalletsKit.fetchAddress as jest.Mock).mockResolvedValue('GABC123');

    const result = await connectWithWallet('freighter');

    expect(result).toBe('GABC123');
    expect(StellarWalletsKit.setWallet).toHaveBeenCalledWith('freighter');
    expect(StellarWalletsKit.fetchAddress).toHaveBeenCalled();
  });

  it('throws UNSUPPORTED_BROWSER when window is undefined', async () => {
    Object.defineProperty(globalThis, 'window', { value: undefined, configurable: true });
    await expect(connectWithWallet('freighter')).rejects.toMatchObject({ type: WalletErrorType.UNSUPPORTED_BROWSER });
  });

  it('throws UNSUPPORTED_BROWSER on mobile freighter', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'iPhone',
      configurable: true,
    });
    await expect(connectWithWallet(FREIGHTER_ID)).rejects.toMatchObject({ type: WalletErrorType.UNSUPPORTED_BROWSER });
  });

  it('throws WALLET_NOT_FOUND when wallet missing', async () => {
    (StellarWalletsKit.setWallet as jest.Mock).mockImplementation(() => Promise.reject(new Error('Freighter is not installed')));
    await expect(connectWithWallet('freighter')).rejects.toMatchObject({ type: WalletErrorType.WALLET_NOT_FOUND });
  });

  it('throws USER_REJECTED when user cancels', async () => {
    (StellarWalletsKit.setWallet as jest.Mock).mockImplementation(() => Promise.reject(new Error('User rejected the request')));
    await expect(connectWithWallet('freighter')).rejects.toMatchObject({ type: WalletErrorType.USER_REJECTED });
  });

  it('throws CONNECTION_FAILED for generic errors', async () => {
    (StellarWalletsKit.setWallet as jest.Mock).mockImplementation(() => Promise.reject(new Error('Network error')));
    await expect(connectWithWallet('freighter')).rejects.toMatchObject({ type: WalletErrorType.CONNECTION_FAILED });
  });
});
