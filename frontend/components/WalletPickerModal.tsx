'use client';

import { useState } from 'react';
import { useWallet } from './WalletContext';
import { WALLET_OPTIONS, WalletErrorType } from '@/lib/wallet';

interface Props {
  onClose: () => void;
}

export default function WalletPickerModal({ onClose }: Props) {
  const { connect } = useWallet();
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [errorType, setErrorType] = useState<WalletErrorType | null>(null);

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-semibold text-base">Connect Wallet</h2>
          <button
            onClick={onClose}
            className="text-secondary hover:text-primary text-xl leading-none"
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
}
