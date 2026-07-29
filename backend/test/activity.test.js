import { describe, it, expect } from 'vitest';

import {
  recordActivity,
  getActivityFeed,
  ACTIVITY_MAX_ENTRIES,
} from '../src/lib/activityFeed.js';

// recordActivity mutates a module-level store; seed it so the slicing
// assertions below have a known, full feed to page through.
function seedFeed(count) {
  for (let i = 0; i < count; i++) {
    recordActivity({ timestamp: `t-${i}`, service: `svc-${i}` });
  }
}

// `limit`/`offset` parsing now lives in the activity route's request schema;
// its equivalent of these cases is in src/schemas/common.test.js.

describe('activity feed store', () => {
  it('getActivityFeed slicing yields non-overlapping pages', () => {
    seedFeed(ACTIVITY_MAX_ENTRIES);
    const feed = getActivityFeed();
    expect(feed.length).toBe(ACTIVITY_MAX_ENTRIES);

    const page1 = feed.slice(0, 10);
    const page2 = feed.slice(10, 20);
    expect(page1.length).toBe(10);
    expect(page2.length).toBe(10);
    expect(page1[0]).not.toEqual(page2[0]);
  });

  it('recordActivity caps the feed at ACTIVITY_MAX_ENTRIES', () => {
    seedFeed(ACTIVITY_MAX_ENTRIES + 25);
    expect(getActivityFeed().length).toBe(ACTIVITY_MAX_ENTRIES);
  });
});
