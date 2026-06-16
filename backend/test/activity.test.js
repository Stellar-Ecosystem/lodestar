import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  recordActivity,
  getActivityFeed,
  parseActivityPagination,
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_MAX_LIMIT,
  ACTIVITY_MAX_ENTRIES,
} from '../src/lib/activityFeed.js';

// recordActivity mutates a module-level store; seed it so the slicing
// assertions below have a known, full feed to page through.
function seedFeed(count) {
  for (let i = 0; i < count; i++) {
    recordActivity({ timestamp: `t-${i}`, service: `svc-${i}` });
  }
}

test('parseActivityPagination applies sane defaults when params are absent', () => {
  const { limit, offset, errors } = parseActivityPagination({});
  assert.equal(limit, ACTIVITY_DEFAULT_LIMIT);
  assert.equal(offset, 0);
  assert.deepEqual(errors, []);
});

test('parseActivityPagination parses valid limit and offset', () => {
  const { limit, offset, errors } = parseActivityPagination({ limit: '10', offset: '5' });
  assert.equal(limit, 10);
  assert.equal(offset, 5);
  assert.deepEqual(errors, []);
});

test('parseActivityPagination clamps limit to the maximum', () => {
  const { limit, errors } = parseActivityPagination({ limit: String(ACTIVITY_MAX_LIMIT + 100) });
  assert.equal(limit, ACTIVITY_MAX_LIMIT);
  assert.deepEqual(errors, []);
});

test('parseActivityPagination rejects non-positive or non-integer limit', () => {
  for (const bad of ['0', '-1', '1.5', 'abc', '']) {
    const { errors } = parseActivityPagination({ limit: bad });
    assert.ok(errors.length > 0, `expected error for limit=${JSON.stringify(bad)}`);
  }
});

test('parseActivityPagination rejects negative or non-integer offset', () => {
  for (const bad of ['-1', '2.5', 'xyz']) {
    const { errors } = parseActivityPagination({ offset: bad });
    assert.ok(errors.length > 0, `expected error for offset=${JSON.stringify(bad)}`);
  }
});

test('getActivityFeed slicing yields non-overlapping pages', () => {
  seedFeed(ACTIVITY_MAX_ENTRIES);
  const feed = getActivityFeed();
  assert.equal(feed.length, ACTIVITY_MAX_ENTRIES);

  const page1 = feed.slice(0, 10);
  const page2 = feed.slice(10, 20);
  assert.equal(page1.length, 10);
  assert.equal(page2.length, 10);
  assert.notDeepEqual(page1[0], page2[0]);
});

test('recordActivity caps the feed at ACTIVITY_MAX_ENTRIES', () => {
  seedFeed(ACTIVITY_MAX_ENTRIES + 25);
  assert.equal(getActivityFeed().length, ACTIVITY_MAX_ENTRIES);
});
