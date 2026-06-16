import { connectWithWallet, WalletError, WalletErrorType, FREIGHTER_ID } from '../lib/wallet';
import { StellarWalletsKit } from '@creit-tech/stellar-wallets-kit/sdk';

jest.mock('@creit-tech/stellar-wallets-kit/sdk', () => {
  return {
    StellarWalletsKit: {
      init: jest.fn(),
      setWallet: jest.fn(),
      fetchAddress: jest.fn(),
    }
  };
});

describe('wallet connection', () => {
  const originalWindow = global.window;
  const originalNavigator = global.navigator;

  beforeEach(() => {
    jest.clearAllMocks();
    (global as any).window = { ...originalWindow };
    (global as any).navigator = { ...originalNavigator, userAgent: 'Mozilla/5.0' };
  });

  afterAll(() => {
    (global as any).window = originalWindow;
    (global as any).navigator = originalNavigator;
  });

  it('connects successfully', async () => {
    (StellarWalletsKit.fetchAddress as jest.Mock).mockResolvedValue({ address: 'G123' });
    const address = await connectWithWallet(FREIGHTER_ID);
    expect(address).toBe('G123');
  });

  it('throws UNSUPPORTED_BROWSER when window is undefined', async () => {
    (global as any).window = undefined;
    await expect(connectWithWallet(FREIGHTER_ID)).rejects.toMatchObject({
      type: WalletErrorType.UNSUPPORTED_BROWSER
    });
  });

  it('throws UNSUPPORTED_BROWSER on mobile', async () => {
    (global as any).navigator = { userAgent: 'iPhone' };
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
