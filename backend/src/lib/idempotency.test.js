import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as idempotency from './idempotency.js';

beforeEach(() => {
  idempotency._reset();
  vi.useFakeTimers();
});

afterEach(() => {
  idempotency._reset();
  vi.useRealTimers();
});

describe('isValidIdempotencyKey', () => {
  it('accepts valid keys', () => {
    expect(idempotency.isValidIdempotencyKey('abc-123')).toBe(true);
    expect(idempotency.isValidIdempotencyKey('x')).toBe(true);
    expect(idempotency.isValidIdempotencyKey('A'.repeat(255))).toBe(true);
  });

  it('rejects empty keys', () => {
    expect(idempotency.isValidIdempotencyKey('')).toBe(false);
  });

  it('rejects keys over 255 chars', () => {
    expect(idempotency.isValidIdempotencyKey('A'.repeat(256))).toBe(false);
  });

  it('rejects keys with spaces or control chars', () => {
    expect(idempotency.isValidIdempotencyKey('abc def')).toBe(false);
    expect(idempotency.isValidIdempotencyKey('abc\ndef')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(idempotency.isValidIdempotencyKey(123)).toBe(false);
    expect(idempotency.isValidIdempotencyKey(null)).toBe(false);
    expect(idempotency.isValidIdempotencyKey(undefined)).toBe(false);
  });
});

describe('getEntry / markPending / markComplete / markFailed', () => {
  it('returns null for unknown key', () => {
    expect(idempotency.getEntry('unknown')).toBeNull();
  });

  it('returns entry for a pending key', () => {
    idempotency.markPending('key-1');
    const entry = idempotency.getEntry('key-1');
    expect(entry).not.toBeNull();
    expect(entry.status).toBe('pending');
    expect(entry.result).toBeNull();
  });

  it('returns null for an expired entry (lazy expiry)', () => {
    idempotency.markPending('key-1');
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    expect(idempotency.getEntry('key-1')).toBeNull();
  });

  it('marks key as complete', () => {
    idempotency.markPending('key-1');
    idempotency.markComplete('key-1', { newScore: 42 });
    const entry = idempotency.getEntry('key-1');
    expect(entry.status).toBe('complete');
    expect(entry.result).toEqual({ newScore: 42 });
  });

  it('marks key as failed', () => {
    idempotency.markPending('key-1');
    idempotency.markFailed('key-1', { httpStatus: 402, error: 'Insufficient', code: 'insufficient_funds' });
    const entry = idempotency.getEntry('key-1');
    expect(entry.status).toBe('failed');
    expect(entry.result.httpStatus).toBe(402);
  });

  it('markComplete on unknown key is a no-op', () => {
    idempotency.markComplete('unknown', { newScore: 1 });
    expect(idempotency.getEntry('unknown')).toBeNull();
  });

  it('markFailed on unknown key is a no-op', () => {
    idempotency.markFailed('unknown', { httpStatus: 402, error: '', code: '' });
    expect(idempotency.getEntry('unknown')).toBeNull();
  });
});

describe('purgeExpired', () => {
  it('removes expired entries on manual purge', () => {
    idempotency.markPending('old-key');
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    idempotency.markPending('fresh-key');
    idempotency._purgeNow();
    expect(idempotency._size()).toBe(1);
    expect(idempotency.getEntry('fresh-key')).not.toBeNull();
  });

  it('does not remove live entries on manual purge', () => {
    idempotency.markPending('key-1');
    idempotency._purgeNow();
    expect(idempotency._size()).toBe(1);
  });

  it('runs on the scheduled timer and removes expired entries', () => {
    idempotency._startTimer();
    idempotency.markPending('expire-me');
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);

    vi.advanceTimersByTime(60_000);

    expect(idempotency.getEntry('expire-me')).toBeNull();
    expect(idempotency._size()).toBe(0);
  });

  it('scheduled timer does not remove live entries', () => {
    idempotency._startTimer();
    idempotency.markPending('keep-me');
    vi.advanceTimersByTime(60_000);
    expect(idempotency._size()).toBe(1);
    expect(idempotency.getEntry('keep-me')).not.toBeNull();
  });
});

describe('_reset', () => {
  it('clears all entries and stops the timer', () => {
    idempotency._startTimer();
    idempotency.markPending('key-1');
    expect(idempotency._size()).toBe(1);
    idempotency._reset();
    expect(idempotency._size()).toBe(0);
    expect(idempotency.getEntry('key-1')).toBeNull();
  });
});

// ── #1259 / LDS-2026-172 ─────────────────────────────────────────────────────
// markFailed must keep the key replayable even when the entry was purged while
// the payment was in-flight, so a retry cannot spend extra allowance or corrupt
// the agent score by re-executing the chain call.

describe('markFailed — replay safety on entry expiry', () => {
  it('upserts a failed entry when the key was purged mid-flight', () => {
    const result = { httpStatus: 500, error: 'chain error', code: 'RECORD_ERROR' };

    // Key never marked pending — simulates purge between markPending and markFailed
    idempotency.markFailed('purged-key', result);

    const entry = idempotency.getEntry('purged-key');
    expect(entry).not.toBeNull();
    expect(entry.status).toBe('failed');
    expect(entry.result).toEqual(result);
  });

  it('a retry after failure replays the error, not a fresh chain call', () => {
    const result = { httpStatus: 400, error: 'Insufficient allowance', code: 'INSUFFICIENT_ALLOWANCE' };

    idempotency.markPending('pay-key');
    idempotency.markFailed('pay-key', result);

    // Simulate a retry: getEntry should return the failed record
    const entry = idempotency.getEntry('pay-key');
    expect(entry).not.toBeNull();
    expect(entry.status).toBe('failed');
    expect(entry.result.httpStatus).toBe(400);
    expect(entry.result.code).toBe('INSUFFICIENT_ALLOWANCE');
  });

  it('upserted failure entry expires normally after TTL', () => {
    const result = { httpStatus: 500, error: 'err', code: 'ERR' };
    idempotency.markFailed('expire-fail-key', result, 5000);

    vi.advanceTimersByTime(5001);
    expect(idempotency.getEntry('expire-fail-key')).toBeNull();
  });
});
