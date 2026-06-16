import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WalletPickerModal from '../components/WalletPickerModal';
import { useWallet } from '../components/WalletContext';
import { WalletError, WalletErrorType } from '../lib/wallet';

jest.mock('../components/WalletContext', () => ({
  useWallet: jest.fn(),
}));

describe('WalletPickerModal', () => {
  const mockConnect = jest.fn();
  const mockOnClose = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (useWallet as jest.Mock).mockReturnValue({ connect: mockConnect });
  });

  it('renders correctly', () => {
    render(<WalletPickerModal onClose={mockOnClose} />);
    expect(screen.getByText('Connect Wallet')).toBeInTheDocument();
    expect(screen.getByText('Freighter')).toBeInTheDocument();
  });

  it('handles WALLET_NOT_FOUND error', async () => {
    mockConnect.mockRejectedValue(new WalletError(WalletErrorType.WALLET_NOT_FOUND, 'Wallet missing'));
    render(<WalletPickerModal onClose={mockOnClose} />);
    
    fireEvent.click(screen.getByText('Freighter'));
    
    await waitFor(() => {
      expect(screen.getByText('Wallet missing')).toBeInTheDocument();
      expect(screen.getByText('Install Freighter')).toBeInTheDocument();
    });
  });

  it('handles UNSUPPORTED_BROWSER error', async () => {
    mockConnect.mockRejectedValue(new WalletError(WalletErrorType.UNSUPPORTED_BROWSER, 'Browser not supported'));
    render(<WalletPickerModal onClose={mockOnClose} />);
    
    fireEvent.click(screen.getByText('Freighter'));
    
    await waitFor(() => {
      expect(screen.getByText('Browser not supported')).toBeInTheDocument();
      expect(screen.getByText('Learn More')).toBeInTheDocument();
    });
  });

  it('handles USER_REJECTED error', async () => {
    mockConnect.mockRejectedValue(new WalletError(WalletErrorType.USER_REJECTED, 'Cancelled'));
    render(<WalletPickerModal onClose={mockOnClose} />);
    
    fireEvent.click(screen.getByText('Freighter'));
    
    await waitFor(() => {
      expect(screen.getByText('Cancelled')).toBeInTheDocument();
      expect(screen.getByText('Retry Connection')).toBeInTheDocument();
    });
  });
});
