import { describe, it, expect, vi } from 'vitest';
import { waitForActivityTxHash } from './waitForActivityTxHash.js';

function makeSleepRecorder() {
  const delays = [];
  const sleep = vi.fn(async (ms) => {
    delays.push(ms);
  });
  return { sleep, delays };
}

describe('waitForActivityTxHash', () => {
  it('returns immediately when the feed already contains a new txHash', async () => {
    const { sleep, delays } = makeSleepRecorder();
    const getFeed = vi.fn(() => [
      { txHash: 'abc123' },
      { txHash: 'old' },
    ]);

    const result = await waitForActivityTxHash(
      getFeed,
      1,
      { maxWaitMs: 8000, initialDelayMs: 250, maxDelayMs: 2000 },
      sleep,
    );

    expect(result).toBe('abc123');
    expect(getFeed).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('uses exponential delays when the txHash appears after multiple checks', async () => {
    const { sleep, delays } = makeSleepRecorder();
    const feeds = [
      [{ txHash: 'old' }],
      [{ txHash: 'old' }],
      [{ txHash: 'newhash', service: 'weather' }, { txHash: 'old' }],
    ];
    const getFeed = vi.fn(() => feeds.shift() ?? feeds[feeds.length - 1]);

    const result = await waitForActivityTxHash(
      getFeed,
      1,
      { maxWaitMs: 8000, initialDelayMs: 250, maxDelayMs: 2000 },
      sleep,
    );

    expect(result).toBe('newhash');
    expect(getFeed).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([250, 500]);
  });

  it('caps delay at pollMaxDelayMs', async () => {
    const { sleep, delays } = makeSleepRecorder();
    let call = 0;
    const getFeed = vi.fn(() => {
      call += 1;
      if (call < 4) {
        return [{ txHash: 'old' }];
      }
      return [{ txHash: 'capped' }, { txHash: 'old' }];
    });

    const result = await waitForActivityTxHash(
      getFeed,
      1,
      { maxWaitMs: 10_000, initialDelayMs: 1000, maxDelayMs: 1500 },
      sleep,
    );

    expect(result).toBe('capped');
    expect(delays).toEqual([1000, 1500, 1500]);
    expect(delays.every((d) => d <= 1500)).toBe(true);
  });

  it('returns an empty string when maxWaitMs is reached without a txHash', async () => {
    const { sleep, delays } = makeSleepRecorder();
    const getFeed = vi.fn(() => [{ txHash: '' }]);

    const result = await waitForActivityTxHash(
      getFeed,
      5,
      { maxWaitMs: 1000, initialDelayMs: 250, maxDelayMs: 500 },
      sleep,
    );

    expect(result).toBe('');
    const totalSlept = delays.reduce((sum, d) => sum + d, 0);
    expect(totalSlept).toBeLessThanOrEqual(1000);
    expect(delays.length).toBeGreaterThan(0);
  });
});
