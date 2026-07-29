import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import WalletConnect from '../components/WalletConnect';
import { useWallet } from '../components/WalletContext';

jest.mock('../components/WalletContext', () => ({
  useWallet: jest.fn(),
}));

jest.mock('../components/WalletPickerModal', () => {
  return function MockModal({ onClose }: { onClose: () => void }) {
    return (
      <div data-testid="picker-modal">
        <button onClick={onClose}>Close</button>
      </div>
    );
  };
});

describe('WalletConnect', () => {
  const mockDisconnect = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows connect button when not connected', () => {
    (useWallet as jest.Mock).mockReturnValue({
      status: 'not-connected',
      address: '',
      balance: '',
      disconnect: mockDisconnect,
    });

    render(<WalletConnect />);
    expect(screen.getByText('Connect Wallet')).toBeInTheDocument();
  });

  it('shows address and disconnect button when connected', () => {
    (useWallet as jest.Mock).mockReturnValue({
      status: 'connected',
      address: 'GABCDEFGHIJKLMNOP',
      balance: '100.0000',
      disconnect: mockDisconnect,
    });

    render(<WalletConnect />);
    expect(screen.getByText('GABC...MNOP')).toBeInTheDocument();
    expect(screen.getByText('100.0000 USDC')).toBeInTheDocument();
  });

  it('calls disconnect when disconnect button is clicked', () => {
    (useWallet as jest.Mock).mockReturnValue({
      status: 'connected',
      address: 'GABCDEFGHIJKLMNOP',
      balance: '100.0000',
      disconnect: mockDisconnect,
    });

    render(<WalletConnect />);
    fireEvent.click(screen.getByText('×'));
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
  });

  it('opens wallet picker modal on connect button click', () => {
    (useWallet as jest.Mock).mockReturnValue({
      status: 'not-connected',
      address: '',
      balance: '',
      disconnect: mockDisconnect,
    });

    render(<WalletConnect />);
    fireEvent.click(screen.getByText('Connect Wallet'));
    expect(screen.getByTestId('picker-modal')).toBeInTheDocument();
  });
});
