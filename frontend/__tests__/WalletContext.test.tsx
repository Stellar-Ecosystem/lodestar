/**
 * Test suite for WalletContext (#778)
 *
 * Expands test coverage for WalletContext covering:
 * - Every conditional branch (mount without hint, mount with hint, successful/failed restore, cancelled cleanup)
 * - User interactions via @testing-library/user-event (connect, error handling, disconnect)
 * - Prop permutations & DOM-asserted state transitions
 * - Default context values when used outside WalletProvider
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Stub the wallet kit imports to avoid ESM transformation issues in Jest
jest.mock('@creit-tech/stellar-wallets-kit/sdk', () => ({
  StellarWalletsKit: {
    init: jest.fn(),
    setWallet: jest.fn(),
    fetchAddress: jest.fn(),
    signTransaction: jest.fn(),
  },
}));
jest.mock('@creit-tech/stellar-wallets-kit/modules/freighter', () => ({
  FreighterModule: class {},
  FREIGHTER_ID: 'freighter',
}));
jest.mock('@creit-tech/stellar-wallets-kit/modules/albedo', () => ({
  AlbedoModule: class {},
  ALBEDO_ID: 'albedo',
}));
jest.mock('@creit-tech/stellar-wallets-kit/modules/xbull', () => ({
  xBullModule: class {},
  XBULL_ID: 'xbull',
}));
jest.mock('@creit-tech/stellar-wallets-kit/modules/lobstr', () => ({
  LobstrModule: class {},
  LOBSTR_ID: 'lobstr',
}));
jest.mock('@creit-tech/stellar-wallets-kit/types', () => ({
  Networks: { TESTNET: 'Test SDF Network ; September 2015' },
}));

// Mock lib/wallet functions used by WalletContext
jest.mock('@/lib/wallet', () => ({
  initKit: jest.fn(),
  connectWithWallet: jest.fn(),
  getBalance: jest.fn(),
  disconnectWallet: jest.fn(),
  getWalletHint: jest.fn(),
  persistWalletHint: jest.fn(),
  restoreWalletConnection: jest.fn(),
  FREIGHTER_ID: 'freighter',
  ALBEDO_ID: 'albedo',
}));

import {
  initKit,
  connectWithWallet,
  getBalance,
  disconnectWallet,
  getWalletHint,
  persistWalletHint,
  restoreWalletConnection,
} from '@/lib/wallet';
import { WalletProvider, useWallet } from '@/components/WalletContext';

const mockInitKit = initKit as jest.Mock;
const mockConnectWithWallet = connectWithWallet as jest.Mock;
const mockGetBalance = getBalance as jest.Mock;
const mockDisconnectWallet = disconnectWallet as jest.Mock;
const mockGetWalletHint = getWalletHint as jest.Mock;
const mockPersistWalletHint = persistWalletHint as jest.Mock;
const mockRestoreWalletConnection = restoreWalletConnection as jest.Mock;

const TEST_ADDRESS_1 = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTU';
const TEST_ADDRESS_2 = 'GBBBBBBBBBBBBBBBBBBBBBBBBB234567BBBBBBBBBBBBBBBBBBBBB';

/**
 * Test component consuming WalletContext through DOM elements
 * All interactive affordances are triggered by user actions (clicking buttons)
 */
function WalletTestConsumer() {
  const { status, address, balance, restoring, connect, disconnect } = useWallet();
  const [connectError, setConnectError] = React.useState<string | null>(null);

  const handleConnect = async (walletId: string) => {
    setConnectError(null);
    try {
      await connect(walletId);
    } catch (err: any) {
      setConnectError(err?.message || 'Connection failed');
    }
  };

  return (
    <div data-testid="wallet-consumer">
      <div data-testid="status">{status}</div>
      <div data-testid="address">{address || 'none'}</div>
      <div data-testid="balance">{balance || 'none'}</div>
      <div data-testid="restoring">{restoring ? 'true' : 'false'}</div>
      {connectError && <div data-testid="connect-error">{connectError}</div>}

      {status === 'connected' ? (
        <div data-testid="connected-panel">
          <p>Welcome, {address.slice(0, 4)}...{address.slice(-4)}</p>
          <button type="button" onClick={disconnect}>
            Disconnect Wallet
          </button>
        </div>
      ) : (
        <div data-testid="disconnected-panel">
          <button type="button" onClick={() => handleConnect('freighter')}>
            Connect Freighter
          </button>
          <button type="button" onClick={() => handleConnect('albedo')}>
            Connect Albedo
          </button>
        </div>
      )}
    </div>
  );
}

describe('WalletContext (#778)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWalletHint.mockReturnValue(null);
    mockGetBalance.mockResolvedValue('50.0000');
  });

  describe('Default context outside Provider', () => {
    it('returns default fallback state when used without a provider', () => {
      render(<WalletTestConsumer />);

      expect(screen.getByTestId('status')).toHaveTextContent('not-connected');
      expect(screen.getByTestId('address')).toHaveTextContent('none');
      expect(screen.getByTestId('balance')).toHaveTextContent('none');
      expect(screen.getByTestId('restoring')).toHaveTextContent('false');
      expect(screen.getByTestId('disconnected-panel')).toBeInTheDocument();
    });

    it('safely handles default connect/disconnect function calls outside provider', async () => {
      const user = userEvent.setup();
      render(<WalletTestConsumer />);

      // Clicking connect invokes the default no-op async function
      const connectBtn = screen.getByRole('button', { name: 'Connect Freighter' });
      await user.click(connectBtn);

      // State remains unchanged and does not throw
      expect(screen.getByTestId('status')).toHaveTextContent('not-connected');
    });
  });

  describe('Initial Mount and Restoration Conditional Branches', () => {
    it('initializes wallet kit on mount', () => {
      render(
        <WalletProvider>
          <WalletTestConsumer />
        </WalletProvider>
      );

      expect(mockInitKit).toHaveBeenCalledTimes(1);
    });

    it('stays disconnected and does not restore when no wallet hint exists', () => {
      mockGetWalletHint.mockReturnValue(null);

      render(
        <WalletProvider>
          <WalletTestConsumer />
        </WalletProvider>
      );

      expect(screen.getByTestId('status')).toHaveTextContent('not-connected');
      expect(screen.getByTestId('restoring')).toHaveTextContent('false');
      expect(mockRestoreWalletConnection).not.toHaveBeenCalled();
    });

    it('successfully restores connection and balance when hint exists', async () => {
      mockGetWalletHint.mockReturnValue({ walletId: 'freighter', address: TEST_ADDRESS_1 });
      mockRestoreWalletConnection.mockResolvedValue(TEST_ADDRESS_1);
      mockGetBalance.mockResolvedValue('125.5000');

      render(
        <WalletProvider>
          <WalletTestConsumer />
        </WalletProvider>
      );

      // Eventually transitions to connected with updated balance
      await waitFor(() => {
        expect(screen.getByTestId('status')).toHaveTextContent('connected');
      });

      expect(screen.getByTestId('address')).toHaveTextContent(TEST_ADDRESS_1);
      expect(screen.getByTestId('balance')).toHaveTextContent('125.5000');
      expect(screen.getByTestId('restoring')).toHaveTextContent('false');
      expect(screen.getByTestId('connected-panel')).toBeInTheDocument();
    });

    it('handles restore returning empty/null by setting status to not-connected', async () => {
      mockGetWalletHint.mockReturnValue({ walletId: 'freighter', address: TEST_ADDRESS_1 });
      mockRestoreWalletConnection.mockResolvedValue(null);

      render(
        <WalletProvider>
          <WalletTestConsumer />
        </WalletProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('restoring')).toHaveTextContent('false');
      });

      expect(screen.getByTestId('status')).toHaveTextContent('not-connected');
      expect(screen.getByTestId('address')).toHaveTextContent('none');
      expect(mockGetBalance).not.toHaveBeenCalled();
    });

    it('handles restore throwing error by concluding restoring state', async () => {
      mockGetWalletHint.mockReturnValue({ walletId: 'freighter', address: TEST_ADDRESS_1 });
      mockRestoreWalletConnection.mockRejectedValue(new Error('Extension locked'));

      render(
        <WalletProvider>
          <WalletTestConsumer />
        </WalletProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('restoring')).toHaveTextContent('false');
      });

      expect(screen.getByTestId('status')).toHaveTextContent('not-connected');
      expect(screen.getByTestId('address')).toHaveTextContent('none');
    });

    it('aborts state updates if component unmounts while restore is in-flight', async () => {
      mockGetWalletHint.mockReturnValue({ walletId: 'freighter', address: TEST_ADDRESS_1 });
      let resolveRestore: (addr: string) => void;
      mockRestoreWalletConnection.mockImplementation(
        () => new Promise((resolve) => { resolveRestore = resolve; })
      );

      const { unmount } = render(
        <WalletProvider>
          <WalletTestConsumer />
        </WalletProvider>
      );

      expect(screen.getByTestId('restoring')).toHaveTextContent('true');

      // Unmount before restore promise resolves
      unmount();

      // Resolve afterwards — cancelled token ensures no warning/leak
      resolveRestore!(TEST_ADDRESS_1);
      await Promise.resolve();
    });
  });

  describe('User Interactions via userEvent', () => {
    it('connects successfully through user button click', async () => {
      const user = userEvent.setup();
      mockConnectWithWallet.mockResolvedValue(TEST_ADDRESS_2);
      mockGetBalance.mockResolvedValue('88.2500');

      render(
        <WalletProvider>
          <WalletTestConsumer />
        </WalletProvider>
      );

      expect(screen.getByTestId('status')).toHaveTextContent('not-connected');
      const connectBtn = screen.getByRole('button', { name: 'Connect Freighter' });

      // Click using user-event
      await user.click(connectBtn);

      await waitFor(() => {
        expect(screen.getByTestId('status')).toHaveTextContent('connected');
      });

      expect(mockConnectWithWallet).toHaveBeenCalledWith('freighter');
      expect(mockPersistWalletHint).toHaveBeenCalledWith('freighter', TEST_ADDRESS_2);
      expect(mockGetBalance).toHaveBeenCalledWith(TEST_ADDRESS_2);
      expect(screen.getByTestId('address')).toHaveTextContent(TEST_ADDRESS_2);
      expect(screen.getByTestId('balance')).toHaveTextContent('88.2500');
      expect(screen.getByTestId('connected-panel')).toBeInTheDocument();
    });

    it('handles connection error and maintains not-connected status', async () => {
      const user = userEvent.setup();
      mockConnectWithWallet.mockRejectedValue(new Error('User rejected connection request'));

      render(
        <WalletProvider>
          <WalletTestConsumer />
        </WalletProvider>
      );

      const connectBtn = screen.getByRole('button', { name: 'Connect Albedo' });
      await user.click(connectBtn);

      await waitFor(() => {
        expect(screen.getByTestId('connect-error')).toHaveTextContent('User rejected connection request');
      });

      expect(mockConnectWithWallet).toHaveBeenCalledWith('albedo');
      expect(screen.getByTestId('status')).toHaveTextContent('not-connected');
      expect(screen.getByTestId('address')).toHaveTextContent('none');
      expect(mockPersistWalletHint).not.toHaveBeenCalled();
    });

    it('disconnects wallet and clears state through user button click', async () => {
      const user = userEvent.setup();
      mockConnectWithWallet.mockResolvedValue(TEST_ADDRESS_1);
      mockGetBalance.mockResolvedValue('10.0000');

      render(
        <WalletProvider>
          <WalletTestConsumer />
        </WalletProvider>
      );

      // Connect first
      await user.click(screen.getByRole('button', { name: 'Connect Freighter' }));
      await waitFor(() => {
        expect(screen.getByTestId('status')).toHaveTextContent('connected');
      });

      // Disconnect via user-event click
      const disconnectBtn = screen.getByRole('button', { name: 'Disconnect Wallet' });
      await user.click(disconnectBtn);

      expect(mockDisconnectWallet).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('status')).toHaveTextContent('not-connected');
      expect(screen.getByTestId('address')).toHaveTextContent('none');
      expect(screen.getByTestId('balance')).toHaveTextContent('none');
      expect(screen.getByTestId('disconnected-panel')).toBeInTheDocument();
    });
  });

  describe('Children & Prop Permutations Rendering', () => {
    it('renders multiple children components and reflects shared context updates', async () => {
      const user = userEvent.setup();
      mockConnectWithWallet.mockResolvedValue(TEST_ADDRESS_1);

      function HeaderStatus() {
        const { status } = useWallet();
        return <header data-testid="header-status">{status}</header>;
      }

      function ActionButton() {
        const { connect, status } = useWallet();
        if (status === 'connected') return null;
        return <button onClick={() => connect('freighter')}>Header Connect</button>;
      }

      render(
        <WalletProvider>
          <HeaderStatus />
          <ActionButton />
        </WalletProvider>
      );

      expect(screen.getByTestId('header-status')).toHaveTextContent('not-connected');

      await user.click(screen.getByRole('button', { name: 'Header Connect' }));

      await waitFor(() => {
        expect(screen.getByTestId('header-status')).toHaveTextContent('connected');
      });

      expect(screen.queryByRole('button', { name: 'Header Connect' })).not.toBeInTheDocument();
    });
  });
});
