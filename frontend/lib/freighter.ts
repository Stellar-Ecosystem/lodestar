import {
  isConnected,
  getAddress,
  signTransaction,
  getNetworkDetails,
  requestAccess,
} from '@stellar/freighter-api';
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';

/** Thrown when the wallet's active network does not match the app's configured network. */
export class NetworkMismatchError extends Error {
  constructor(public walletNetwork: string, public appNetwork: string) {
    super(
      `Network mismatch: your wallet is set to "${walletNetwork}" but this app is configured for "${appNetwork}". ` +
        `Please switch your wallet to the correct network and try again.`
    );
    this.name = 'NetworkMismatchError';
  }
}

/**
 * Queries Freighter for its currently active network and asserts it matches
 * the passphrase the app is about to sign with. Throws {@link NetworkMismatchError}
 * if they differ. Call this before every signing request.
 *
 * If Freighter is not reachable (e.g. running server-side or extension absent)
 * the check is skipped rather than blocking the call.
 */
export async function assertNetworkMatch(expectedPassphrase: string): Promise<void> {
  // Only runs in the browser where the extension exists.
  if (typeof window === 'undefined') return;

  let details: { networkPassphrase: string; network: string; error?: unknown };
  try {
    details = await getNetworkDetails();
  } catch {
    // Extension not available — let the downstream signTransaction call surface the error.
    return;
  }

  if (details.error) return; // Freighter not connected/ready; skip guard.

  if (details.networkPassphrase !== expectedPassphrase) {
    throw new NetworkMismatchError(
      details.network || details.networkPassphrase,
      expectedPassphrase
    );
  }
}

export function isFreighterInstalled(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      typeof (window as Window & { freighter?: unknown }).freighter !== 'undefined'
    );
  } catch {
    return false;
  }
}

export async function connectWallet(): Promise<string> {
  const connected = await isConnected();
  if (!connected.isConnected) {
    await requestAccess();
  }
  const result = await getAddress();
  if (result.error) {
    throw new Error(result.error);
  }
  return result.address;
}

export async function signTx(xdr: string, network: string): Promise<string> {
  await assertNetworkMatch(network);
  const result = await signTransaction(xdr, { networkPassphrase: network });
  if (result.error) {
    throw new Error(result.error);
  }
  return result.signedTxXdr;
}

// Keypair wallet — signs locally in-memory, no extension required
export function signTxWithKeypair(xdr: string, secret: string): string {
  const keypair = Keypair.fromSecret(secret);
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  tx.sign(keypair);
  return tx.toXDR();
}

export function publicKeyFromSecret(secret: string): string {
  return Keypair.fromSecret(secret).publicKey();
}

export async function getBalance(address: string): Promise<string> {
  try {
    const horizonUrl =
      process.env.NEXT_PUBLIC_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';

    const res = await fetch(`${horizonUrl}/accounts/${address}`);
    if (!res.ok) return '0.0000';

    const data = (await res.json()) as {
      balances: Array<{
        asset_type: string;
        asset_code?: string;
        balance: string;
      }>;
    };

    const usdc = data.balances.find(
      (b) => b.asset_type === 'credit_alphanum4' && b.asset_code === 'USDC'
    );

    return usdc ? parseFloat(usdc.balance).toFixed(4) : '0.0000';
  } catch {
    return '0.0000';
  }
}
