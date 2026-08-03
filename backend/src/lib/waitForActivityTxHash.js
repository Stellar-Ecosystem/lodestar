/**
 * Poll the activity feed with exponential backoff until a new entry with a
 * txHash appears, or the max wait budget is exhausted.
 *
 * @param {() => Array<{ txHash?: string }>} getFeed
 * @param {number} activityCountBefore
 * @param {{ maxWaitMs: number, initialDelayMs: number, maxDelayMs: number }} options
 * @param {(entry: { txHash?: string }) => boolean} [matchesEntry]
 * @param {(ms: number) => Promise<void>} [sleep]
 * @param {AbortSignal} [signal] — when aborted, the loop breaks and returns ''.
 * @returns {Promise<string>}
 */
export async function waitForActivityTxHash(
  getFeed,
  activityCountBefore,
  { maxWaitMs, initialDelayMs, maxDelayMs },
  matchesEntry,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  signal,
) {
  let elapsedMs = 0;
  let currentDelay = initialDelayMs;

  while (true) {
    // Early exit when the client disconnected mid-request (see demo.js).
    if (signal?.aborted) break;
    const feed = getFeed();
    const addedCount = Math.max(feed.length - activityCountBefore, 0);
    if (addedCount > 0) {
      const recentEntries = feed.slice(0, addedCount);
      const matched = recentEntries.find(
        (entry) => entry?.txHash && (!matchesEntry || matchesEntry(entry)),
      );
      if (matched) return matched.txHash;
    }

    if (elapsedMs >= maxWaitMs) {
      break;
    }

    const delay = Math.min(currentDelay, maxDelayMs, maxWaitMs - elapsedMs);
    if (delay <= 0) {
      break;
    }

    await sleep(delay);
    elapsedMs += delay;
    currentDelay = Math.min(currentDelay * 2, maxDelayMs);
  }

  return '';
}
