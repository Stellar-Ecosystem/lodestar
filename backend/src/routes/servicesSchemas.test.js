import { describe, it, expect } from 'vitest';
import { validateWeatherRequest } from './servicesSchemas.js';

function request({ params = {}, query = {}, body = {} } = {}) {
  return { params, query, body };
}

describe('validateWeatherRequest', () => {
  it('accepts an empty request and falls back to the defaults', () => {
    const result = validateWeatherRequest(request());

    expect(result.ok).toBe(true);
    expect(result.data.query).toEqual({});
  });

  it('accepts valid coordinates', () => {
    const result = validateWeatherRequest(request({ query: { lat: '10.5', lon: '-20.25' } }));

    expect(result.ok).toBe(true);
    expect(result.data.query.lat).toBe(10.5);
    expect(result.data.query.lon).toBe(-20.25);
  });

  it('keeps a zero coordinate instead of replacing it with the default', () => {
    const result = validateWeatherRequest(request({ query: { lat: '0', lon: '0' } }));

    expect(result.ok).toBe(true);
    expect(result.data.query.lat).toBe(0);
    expect(result.data.query.lon).toBe(0);
  });

  it.each([
    ['a missing value', { lat: '' }],
    ['a wrong type', { lat: 'abc' }],
    ['a partially numeric value', { lat: '12abc' }],
    ['a repeated parameter', { lat: ['1', '2'] }],
    ['an out-of-range latitude', { lat: '91' }],
    ['an out-of-range longitude', { lon: '-181' }],
  ])('rejects %s with INVALID_COORDINATES', (_case, query) => {
    const result = validateWeatherRequest(request({ query }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.code).toBe('INVALID_COORDINATES');
  });

  it('rejects an over-long demoRunId with INVALID_QUERY', () => {
    const result = validateWeatherRequest(
      request({ query: { demoRunId: 'a'.repeat(65) } }),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_QUERY');
  });

  it('rejects an unexpected body with INVALID_BODY', () => {
    const result = validateWeatherRequest(request({ body: { unexpected: true } }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.code).toBe('INVALID_BODY');
  });

  it('rejects unexpected path parameters with INVALID_PARAMS', () => {
    const result = validateWeatherRequest(request({ params: { unexpected: '1' } }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.code).toBe('INVALID_PARAMS');
  });
});
