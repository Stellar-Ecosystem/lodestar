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

jest.mock('../lib/wallet', () => {
  const actual = jest.requireActual('../lib/wallet');
  return { ...actual, connectWithWallet: jest.fn() };
});

import { connectWithWallet, disconnectWallet, WalletError, WalletErrorType, FREIGHTER_ID } from '../lib/wallet';
import { StellarWalletsKit } from '@creit-tech/stellar-wallets-kit/sdk';

const realConnectWithWallet = jest.requireActual('../lib/wallet').connectWithWallet as typeof connectWithWallet;

describe('wallet connection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (connectWithWallet as jest.Mock).mockImplementation(realConnectWithWallet);
  });

  it('connects successfully', async () => {
    (StellarWalletsKit.fetchAddress as jest.Mock).mockResolvedValue({ address: 'G123' });
    const address = await connectWithWallet(FREIGHTER_ID);
    expect(address).toBe('G123');
  });

  it('throws UNSUPPORTED_BROWSER when window is undefined', async () => {
    (connectWithWallet as jest.Mock).mockRejectedValue(
      new WalletError(WalletErrorType.UNSUPPORTED_BROWSER, 'Window is not defined. Are you running on the server?')
    );
    await expect(connectWithWallet(FREIGHTER_ID)).rejects.toMatchObject({
      type: WalletErrorType.UNSUPPORTED_BROWSER
    });
  });

  it('throws UNSUPPORTED_BROWSER on mobile', async () => {
    (connectWithWallet as jest.Mock).mockRejectedValue(
      new WalletError(WalletErrorType.UNSUPPORTED_BROWSER, 'This browser does not support Stellar wallet extensions.')
    );
    await expect(connectWithWallet(FREIGHTER_ID)).rejects.toMatchObject({
      type: WalletErrorType.UNSUPPORTED_BROWSER
    });
  });

  it('throws WALLET_NOT_FOUND when extension is missing', async () => {
    (StellarWalletsKit.fetchAddress as jest.Mock).mockRejectedValue(new Error('Freighter is not installed'));
    await expect(connectWithWallet(FREIGHTER_ID)).rejects.toMatchObject({
      type: WalletErrorType.WALLET_NOT_FOUND
    });
  });

  it('throws USER_REJECTED when user cancels', async () => {
    (StellarWalletsKit.fetchAddress as jest.Mock).mockRejectedValue(new Error('User rejected the request'));
    await expect(connectWithWallet(FREIGHTER_ID)).rejects.toMatchObject({
      type: WalletErrorType.USER_REJECTED
    });
  });

  it('throws CONNECTION_FAILED for other errors', async () => {
    (StellarWalletsKit.fetchAddress as jest.Mock).mockRejectedValue(new Error('Network error'));
    await expect(connectWithWallet(FREIGHTER_ID)).rejects.toMatchObject({
      type: WalletErrorType.CONNECTION_FAILED
    });
  });
});

describe('wallet disconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (connectWithWallet as jest.Mock).mockImplementation(realConnectWithWallet);
    disconnectWallet();
  });

  it('resets kit state so next connect re-initializes', async () => {
    (StellarWalletsKit.fetchAddress as jest.Mock).mockResolvedValue({ address: 'G123' });

    await connectWithWallet(FREIGHTER_ID);
    expect(StellarWalletsKit.init).toHaveBeenCalledTimes(1);

    disconnectWallet();
    jest.clearAllMocks();

    await connectWithWallet(FREIGHTER_ID);
    expect(StellarWalletsKit.init).toHaveBeenCalledTimes(1);
  });

  it('logs disconnect event', () => {
    const spy = jest.spyOn(console, 'info').mockImplementation();
    disconnectWallet();
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ event: 'wallet_disconnected' }));
    spy.mockRestore();
  });
});
