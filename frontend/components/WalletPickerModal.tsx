'use client';

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useWallet } from './WalletContext';
import { WALLET_OPTIONS, WalletErrorType } from '@/lib/wallet';

interface Props {
  onClose: () => void;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

export default function WalletPickerModal({ onClose }: Props) {
  const { connect } = useWallet();
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [errorType, setErrorType] = useState<WalletErrorType | null>(null);

  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // On open: move focus into the dialog and mark background content inert.
  // On close: remove inert and restore focus to the element that opened it.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const background: Element[] = [];

    Array.from(document.body.children).forEach((child) => {
      if (child !== overlayRef.current) {
        child.setAttribute('inert', '');
        background.push(child);
      }
    });

    dialogRef.current?.focus();

    return () => {
      background.forEach((el) => el.removeAttribute('inert'));
      previouslyFocused?.focus();
    };
  }, []);

  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;

    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (focusable.length === 0) {
      e.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
      e.preventDefault();
      first.focus();
    }
  }

  async function handleSelect(walletId: string) {
    setLoading(walletId);
    setError('');
    setErrorType(null);
    try {
      await connect(walletId);
      onClose();
    } catch (e: any) {
      if (e?.type) {
        setError(e.message);
        setErrorType(e.type as WalletErrorType);
      } else {
        setError('Unable to connect wallet. Please try again.');
        setErrorType(WalletErrorType.CONNECTION_FAILED);
      }
    } finally {
      setLoading(null);
    }
  }

  const modal = (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 outline-none"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="Connect Wallet"
        tabIndex={-1}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-semibold text-base">Connect Wallet</h2>
          <button
            onClick={onClose}
            className="text-secondary hover:text-primary text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="space-y-2">
          {WALLET_OPTIONS.map((w) => (
            <button
              key={w.id}
              onClick={() => handleSelect(w.id)}
              disabled={loading !== null}
              className="w-full flex items-center gap-4 px-4 py-3 rounded-xl border border-border hover:border-primary hover:bg-background transition-colors text-left disabled:opacity-50"
            >
              <span className="font-medium text-sm flex-1">{w.name}</span>
              {loading === w.id && (
                <span className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full spinner inline-block" />
              )}
            </button>
          ))}
        </div>

        {error && (
          <div className="mt-4">
            <p className="text-xs text-error bg-error/5 border border-error/20 rounded-lg px-3 py-2 mb-3">
              {error}
            </p>
            <div className="flex justify-center gap-3">
              {errorType === WalletErrorType.WALLET_NOT_FOUND && (
                <a
                  href="https://www.freighter.app"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-primary text-xs py-1.5 px-3"
                >
                  Install Freighter
                </a>
              )}
              {errorType === WalletErrorType.UNSUPPORTED_BROWSER && (
                <a
                  href="https://stellar.org/learn/intro-to-stellar"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-primary text-xs py-1.5 px-3"
                >
                  Learn More
                </a>
              )}
              {(errorType === WalletErrorType.USER_REJECTED || errorType === WalletErrorType.CONNECTION_FAILED) && (
                <button
                  onClick={() => setError('')}
                  className="btn-primary text-xs py-1.5 px-3"
                >
                  Retry Connection
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
