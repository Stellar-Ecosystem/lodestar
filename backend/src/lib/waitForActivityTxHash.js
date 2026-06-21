/**
 * Poll the activity feed with exponential backoff until a new entry with a
 * txHash appears, or the max wait budget is exhausted.
 *
 * @param {() => Array<{ txHash?: string }>} getFeed
 * @param {number} activityCountBefore
 * @param {{ maxWaitMs: number, initialDelayMs: number, maxDelayMs: number }} options
 * @param {(ms: number) => Promise<void>} [sleep]
 * @returns {Promise<string>}
 */
export async function waitForActivityTxHash(
  getFeed,
  activityCountBefore,
  { maxWaitMs, initialDelayMs, maxDelayMs },
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  let elapsedMs = 0;
  let currentDelay = initialDelayMs;

  while (true) {
    const feed = getFeed();
    const newest = feed[0];
    if (feed.length > activityCountBefore && newest?.txHash) {
      return newest.txHash;
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
