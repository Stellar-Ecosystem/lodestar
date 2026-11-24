import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeWeakEtag, ifNoneMatchMatches } from './conditionalRequest.js';

const BODY = '{"status":"ok"}';
const ETAG = computeWeakEtag(BODY);
const OPAQUE = createHash('sha256').update(BODY).digest('hex');

describe('computeWeakEtag (#1183)', () => {
  it('is a weak validator over the exact bytes', () => {
    expect(ETAG).toBe(`W/"${OPAQUE}"`);
    expect(computeWeakEtag(BODY)).toBe(ETAG);
    expect(computeWeakEtag(`${BODY} `)).not.toBe(ETAG);
  });
});

describe('ifNoneMatchMatches (#1183)', () => {
  it('matches a weak validator, its strong form, a list, and *', () => {
    expect(ifNoneMatchMatches(ETAG, ETAG)).toBe(true);
    expect(ifNoneMatchMatches(`"${OPAQUE}"`, ETAG)).toBe(true);
    expect(ifNoneMatchMatches(`W/"${OPAQUE}"`, `"${OPAQUE}"`)).toBe(true);
    expect(ifNoneMatchMatches(`W/"${'0'.repeat(64)}", "${OPAQUE}"`, ETAG)).toBe(
      true,
    );
    expect(
      ifNoneMatchMatches(`"${OPAQUE}", W/"${'ab'.repeat(32)}"`, ETAG),
    ).toBe(true);
    expect(ifNoneMatchMatches('*', ETAG)).toBe(true);
    expect(ifNoneMatchMatches(' * ', ETAG)).toBe(true);
    expect(ifNoneMatchMatches(`W/"other", *`, ETAG)).toBe(true);
  });

  it('does not match an absent, stale, or malformed header', () => {
    expect(ifNoneMatchMatches(undefined, ETAG)).toBe(false);
    expect(ifNoneMatchMatches(null, ETAG)).toBe(false);
    expect(ifNoneMatchMatches('', ETAG)).toBe(false);
    expect(ifNoneMatchMatches('   ', ETAG)).toBe(false);
    expect(ifNoneMatchMatches('W/"stale"', ETAG)).toBe(false);
    expect(ifNoneMatchMatches('not-a-validator', ETAG)).toBe(false);
    expect(ifNoneMatchMatches('*foo', ETAG)).toBe(false);
    expect(ifNoneMatchMatches(`w/"${OPAQUE}"`, ETAG)).toBe(false);
    expect(ifNoneMatchMatches('"unterminated', ETAG)).toBe(false);
  });

  it('ignores a malformed list member when another member matches', () => {
    expect(ifNoneMatchMatches(`not-a-validator, "${OPAQUE}"`, ETAG)).toBe(true);
  });

  it('does not treat a quoted asterisk as the wildcard', () => {
    expect(ifNoneMatchMatches('"*"', ETAG)).toBe(false);
    expect(ifNoneMatchMatches('"*"', 'W/"*"')).toBe(true);
  });

  it('keeps commas that are part of the opaque tag', () => {
    const etag = 'W/"ab,cd"';
    expect(ifNoneMatchMatches('W/"ab,cd"', etag)).toBe(true);
    expect(ifNoneMatchMatches('"ab,cd"', etag)).toBe(true);
    expect(ifNoneMatchMatches('W/"ab", W/"cd"', etag)).toBe(false);
  });
});
