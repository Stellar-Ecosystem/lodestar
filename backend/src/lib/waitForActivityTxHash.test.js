import { describe, it, expect, vi } from 'vitest';
import { waitForActivityTxHash } from './waitForActivityTxHash.js';

function makeSleepRecorder() {
  const delays = [];
  const sleep = vi.fn(async (ms) => {
    delays.push(ms);
  });
  return { sleep, delays };
}

const defaultOptions = { maxWaitMs: 8000, initialDelayMs: 250, maxDelayMs: 2000 };

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
      defaultOptions,
      undefined,
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
      defaultOptions,
      undefined,
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
      undefined,
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
      undefined,
      sleep,
    );

    expect(result).toBe('');
    const totalSlept = delays.reduce((sum, d) => sum + d, 0);
    expect(totalSlept).toBeLessThanOrEqual(1000);
    expect(delays.length).toBeGreaterThan(0);
  });

  it('aborts an in-flight default sleep and cleans up its timer', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const getFeed = vi.fn(() => []);
      const resultPromise = waitForActivityTxHash(
        getFeed,
        0,
        { maxWaitMs: 1000, initialDelayMs: 100, maxDelayMs: 100 },
        undefined,
        undefined,
        controller.signal,
      );

      // The poll sleep is scheduled: exactly one timer is active.
      expect(vi.getTimerCount()).toBe(1);

      controller.abort();

      // The abort wakes the sleep: the promise resolves and the timer is gone.
      await expect(resultPromise).resolves.toBe('');
      expect(vi.getTimerCount()).toBe(0);
      expect(getFeed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores unrelated new entries when a matcher is provided', async () => {
    const { sleep, delays } = makeSleepRecorder();
    const myId = 'request-a';
    const feeds = [
      [{ txHash: 'other-hash', demoRunId: 'request-b' }],
      [
        { txHash: 'my-hash', demoRunId: myId },
        { txHash: 'other-hash', demoRunId: 'request-b' },
      ],
    ];
    const getFeed = vi.fn(() => feeds.shift() ?? feeds[feeds.length - 1]);

    const result = await waitForActivityTxHash(
      getFeed,
      0,
      defaultOptions,
      (entry) => entry.demoRunId === myId,
      sleep,
    );

    expect(result).toBe('my-hash');
    expect(getFeed).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([250]);
  });
});
