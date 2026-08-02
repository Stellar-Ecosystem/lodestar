import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import WalletPickerModal from '../components/WalletPickerModal';
import { useWallet } from '../components/WalletContext';
import { WalletError, WalletErrorType } from '../lib/wallet';

jest.mock('../components/WalletContext', () => ({
  useWallet: jest.fn(),
}));

jest.mock('@/lib/wallet', () => {
  class MockWalletError extends Error {
    type: string;
    constructor(type: string, message: string) {
      super(message);
      this.name = 'WalletError';
      this.type = type;
    }
  }

  return {
    WALLET_OPTIONS: [
      { id: 'freighter', name: 'Freighter' },
      { id: 'albedo',    name: 'Albedo' },
      { id: 'xbull',     name: 'xBull' },
      { id: 'lobstr',    name: 'Lobstr' },
    ],
    WalletError: MockWalletError,
    WalletErrorType: {
      WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
      UNSUPPORTED_BROWSER: 'UNSUPPORTED_BROWSER',
      USER_REJECTED: 'USER_REJECTED',
      CONNECTION_FAILED: 'CONNECTION_FAILED',
    },
  };
});

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

  it('moves focus into the dialog when opened', () => {
    render(<WalletPickerModal onClose={mockOnClose} />);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('traps Tab navigation within the dialog', () => {
    render(<WalletPickerModal onClose={mockOnClose} />);
    const dialog = screen.getByRole('dialog');
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button, a[href]'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    // Shift+Tab from the first focusable wraps to the last
    first.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    // Tab from the last focusable wraps to the first
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    // Tab from the dialog itself moves to the first focusable
    dialog.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    // Shift+Tab from the dialog itself moves to the last focusable
    dialog.focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('closes the dialog on Escape', () => {
    render(<WalletPickerModal onClose={mockOnClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('marks background content inert while open and unmarks it on close', () => {
    const { unmount } = render(<WalletPickerModal onClose={mockOnClose} />);
    const overlay = screen.getByRole('dialog').parentElement;
    const background = Array.from(document.body.children).filter(
      (el) => el !== overlay
    );

    expect(background.length).toBeGreaterThan(0);
    background.forEach((el) => expect(el).toHaveAttribute('inert'));

    unmount();
    background.forEach((el) => expect(el).not.toHaveAttribute('inert'));
  });

  it('restores focus to the previously focused element when it closes', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open';
    document.body.appendChild(opener);

    try {
      opener.focus();

      const { unmount } = render(<WalletPickerModal onClose={mockOnClose} />);
      expect(document.activeElement).not.toBe(opener);

      unmount();
      expect(document.activeElement).toBe(opener);
    } finally {
      opener.remove();
    }
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

  it('has no accessibility violations', async () => {
    render(<WalletPickerModal onClose={mockOnClose} />);
    const dialog = screen.getByRole('dialog');
    const results = await axe(dialog);
    expect(results).toHaveNoViolations();
  });
});
