import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  intQueryParam,
  floatQueryParam,
  isValidStellarAddress,
  normalizePriceUsdc,
  positiveIntegerField,
  priceUsdc,
  requiredString,
  serviceIdParam,
  stellarAddress,
} from './common.js';
import { getActivity } from './services.js';
import { ACTIVITY_DEFAULT_LIMIT, ACTIVITY_MAX_LIMIT } from '../lib/activityFeed.js';

/** Parse and return the value, or `null` if the schema rejected the input. */
const parsed = (schema, input) => {
  const result = schema.safeParse(input);
  return result.success ? result.data : null;
};

describe('stellarAddress', () => {
  const VALID = 'GAMASX3TLJIDO42FO3GTX7IQAYN7RJ4U4CXJOROTB7RSV3NGPUEIEQH3';

  it('accepts a well-formed address', () => {
    expect(parsed(stellarAddress(), VALID)).toBe(VALID);
  });

  it.each([
    ['too short', 'GABC'],
    ['wrong prefix', `S${VALID.slice(1)}`],
    ['non-base32 characters', 'GA7FYRB5CREWMDK2VIKVKWSW7V3YCCU3B3UHBJQ6JZ5OC7V7M5D4T8KJ'],
    ['lowercase', VALID.toLowerCase()],
    ['not a string', 42],
    ['absent', undefined],
  ])('rejects %s', (_label, input) => {
    expect(parsed(stellarAddress(), input)).toBeNull();
  });

  it('reports the same message whether the value is missing or malformed', () => {
    const schema = stellarAddress('`agent` must be a valid Stellar address');
    for (const input of [undefined, 'nonsense']) {
      expect(schema.safeParse(input).error.issues[0].message).toBe(
        '`agent` must be a valid Stellar address',
      );
    }
  });

  it('agrees with the predicate form', () => {
    expect(isValidStellarAddress(VALID)).toBe(true);
    expect(isValidStellarAddress('nope')).toBe(false);
    expect(isValidStellarAddress(undefined)).toBe(false);
  });
});

describe('serviceIdParam', () => {
  it('parses a bare positive integer', () => {
    expect(parsed(serviceIdParam(), '7')).toBe(7);
  });

  it.each(['abc', '7abc', '0', '-1', '1.5', '', ' 7', '007'])(
    'rejects %j — a path param is not a `parseInt` prefix match',
    (input) => {
      expect(parsed(serviceIdParam(), input)).toBeNull();
    },
  );

  it('rejects an integer beyond the safe range', () => {
    expect(parsed(serviceIdParam(), '9007199254740993')).toBeNull();
  });
});

describe('positiveIntegerField', () => {
  const schema = positiveIntegerField('id');

  it('accepts a number or a numeric string, always yielding a number', () => {
    expect(parsed(schema, 7)).toBe(7);
    expect(parsed(schema, '7')).toBe(7);
  });

  it.each([0, -1, 1.5, '0', 'abc', '', null, undefined, {}])('rejects %j', (input) => {
    expect(parsed(schema, input)).toBeNull();
  });
});

describe('priceUsdc', () => {
  it('normalises to a canonical decimal string', () => {
    expect(parsed(priceUsdc, 1.5)).toBe('1.5');
    expect(parsed(priceUsdc, '0.0001')).toBe('0.0001');
    expect(parsed(priceUsdc, '12')).toBe('12');
  });

  it.each([
    ['below the minimum', '0.00009'],
    ['zero', '0'],
    ['padded', ' 1.5 '],
    ['leading zeros', '01.5'],
    ['exponent notation', '1e-4'],
    ['not a number', 'free'],
    ['infinite', Infinity],
    ['absent', undefined],
  ])('rejects %s', (_label, input) => {
    expect(parsed(priceUsdc, input)).toBeNull();
  });

  it('matches the standalone normaliser', () => {
    for (const input of ['1.5', '0.00009', 2, 'nope']) {
      expect(parsed(priceUsdc, input)).toBe(normalizePriceUsdc(input));
    }
  });

  it('explains itself instead of falling back to zod default wording', () => {
    // `ctx.addIssue` takes `message`, not `error`; getting that wrong degrades
    // silently to "Invalid input", which says nothing useful to a caller.
    for (const input of ['0.00009', 'free', undefined]) {
      expect(priceUsdc.safeParse(input).error.issues[0].message).toBe(
        '`priceUsdc` must be at least 0.0001',
      );
    }
  });
});

describe('every schema explains its own failures', () => {
  const cases = [
    ['priceUsdc', priceUsdc, 'free'],
    ['positiveIntegerField', positiveIntegerField('id'), 'nope'],
    ['floatQueryParam', floatQueryParam({ field: 'lat', min: -90, max: 90 }), 'abc'],
    ['serviceIdParam', serviceIdParam(), 'abc'],
    ['stellarAddress', stellarAddress(), 'abc'],
    ['intQueryParam', intQueryParam({ field: 'page' }), 'abc'],
    ['requiredString', requiredString('name', { min: 3 }), 'a'],
  ];

  it.each(cases)('%s produces a specific message', (_name, schema, badInput) => {
    const { message } = schema.safeParse(badInput).error.issues[0];
    expect(message).not.toBe('Invalid input');
    expect(message.length).toBeGreaterThan(10);
  });
});

describe('requiredString', () => {
  it('trims before measuring, and returns the trimmed value', () => {
    const schema = requiredString('name', { min: 3, max: 5 });
    expect(parsed(schema, '  abc  ')).toBe('abc');
    expect(parsed(schema, '  ab  ')).toBeNull();
    expect(parsed(schema, 'abcdef')).toBeNull();
  });

  it('rejects a whitespace-only value', () => {
    expect(parsed(requiredString('reason'), '   ')).toBeNull();
  });
});

describe('intQueryParam', () => {
  const schema = intQueryParam({ field: 'page', defaultValue: 0 });

  it('applies the default when absent', () => {
    expect(parsed(schema, undefined)).toBe(0);
  });

  it('parses a numeric string to a number', () => {
    expect(parsed(schema, '3')).toBe(3);
  });

  it.each(['abc', '-1', '1.5', ''])('rejects %j', (input) => {
    expect(parsed(schema, input)).toBeNull();
  });

  it('clamps rather than rejects at the top end', () => {
    const clamped = intQueryParam({ field: 'pageSize', min: 1, max: 100, defaultValue: 12 });
    expect(parsed(clamped, '5000')).toBe(100);
    expect(parsed(clamped, '0')).toBeNull();
  });
});

describe('floatQueryParam', () => {
  const schema = floatQueryParam({ field: 'lat', min: -90, max: 90, defaultValue: 40.7128 });

  it('applies the default when absent', () => {
    expect(parsed(schema, undefined)).toBe(40.7128);
  });

  it('keeps an explicit zero instead of falling back to the default', () => {
    // The hand-rolled version used `parseFloat(x) || default`, which silently
    // turned lat=0 into the default.
    expect(parsed(schema, '0')).toBe(0);
  });

  it('accepts the inclusive bounds', () => {
    expect(parsed(schema, '90')).toBe(90);
    expect(parsed(schema, '-90')).toBe(-90);
  });

  it.each(['91', '-91', 'abc', '', 'NaN'])('rejects %j', (input) => {
    expect(parsed(schema, input)).toBeNull();
  });
});

// These cases previously lived against `parseActivityPagination`, which the
// activity route's schema replaced.
describe('activity pagination', () => {
  const schema = getActivity.request.query.schema;

  it('applies sane defaults when params are absent', () => {
    expect(parsed(schema, {})).toEqual({ limit: ACTIVITY_DEFAULT_LIMIT, offset: 0 });
  });

  it('parses valid limit and offset', () => {
    expect(parsed(schema, { limit: '10', offset: '5' })).toEqual({ limit: 10, offset: 5 });
  });

  it('clamps limit to the maximum', () => {
    expect(parsed(schema, { limit: String(ACTIVITY_MAX_LIMIT + 100) })).toEqual({
      limit: ACTIVITY_MAX_LIMIT,
      offset: 0,
    });
  });

  it.each(['0', '-1', '1.5', 'abc', ''])('rejects limit=%j', (limit) => {
    expect(parsed(schema, { limit })).toBeNull();
  });

  it.each(['-1', '2.5', 'xyz'])('rejects offset=%j', (offset) => {
    expect(parsed(schema, { offset })).toBeNull();
  });

  it('names the offending field in its message', () => {
    const { error } = schema.safeParse({ limit: '-1' });
    expect(error.issues[0].message).toBe('`limit` must be a positive integer');
  });
});

describe('schemas strip unknown keys', () => {
  it('does not pass caller-supplied extras through to handlers', () => {
    const schema = z.object({ name: requiredString('name') });
    expect(parsed(schema, { name: 'ok', isAdmin: true })).toEqual({ name: 'ok' });
  });
});
