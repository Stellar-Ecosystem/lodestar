import { z } from 'zod';

/**
 * Request schemas for the demo service routes.
 *
 * The schema is the route boundary: a malformed request is answered with a
 * 400 and a catalogued error code *before* the route reaches the upstream
 * provider or the contract layer (#675). Previously a typo such as
 * `?lat=abc` was silently swallowed by `parseFloat(...) || default` and the
 * caller got a 200 for a location they never asked for.
 */

// A plain decimal number — no hex, no exponent, no trailing garbage. Written
// as a string pattern because Express hands query parameters over as strings.
const NUMERIC_PATTERN = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;

/**
 * A latitude/longitude that must be a finite number inside `[-max, max]`.
 * Empty strings, non-numeric text and out-of-range values are rejected
 * instead of being replaced by a default.
 */
const coordinate = (name, max) =>
  z
    .union([z.string(), z.number()])
    .transform((value) => (typeof value === 'string' ? value.trim() : value))
    .refine((value) => value !== '' && NUMERIC_PATTERN.test(String(value)), {
      message: `\`${name}\` must be a number`,
    })
    .refine((value) => Math.abs(Number(value)) <= max, {
      message: `\`${name}\` must be between ${-max} and ${max}`,
    })
    .transform((value) => Number(value));

// The route takes no path parameters and no body. Both are still declared so
// a request that carries one is rejected with a 400 instead of being ignored.
export const weatherParamsSchema = z.strictObject({});
export const weatherBodySchema = z.strictObject({});

export const weatherQuerySchema = z.object({
  lat: coordinate('lat', 90).optional(),
  lon: coordinate('lon', 180).optional(),
  demoRunId: z.string().trim().min(1).max(64).optional(),
});

export const weatherRequestSchema = {
  params: weatherParamsSchema,
  query: weatherQuerySchema,
  body: weatherBodySchema,
};

// Error codes are catalogued per source so a client can branch on them.
const SOURCE_ERROR_CODES = {
  params: 'INVALID_PARAMS',
  query: 'INVALID_QUERY',
  body: 'INVALID_BODY',
};

// Coordinate failures keep the code the route already returned, so clients
// that handle `INVALID_COORDINATES` keep working.
const QUERY_FIELD_ERROR_CODES = {
  lat: 'INVALID_COORDINATES',
  lon: 'INVALID_COORDINATES',
};

/**
 * Validate a weather request against the schemas above.
 *
 * @param {object} req Express request.
 * @returns {{ok: true, data: {params: object, query: object, body: object}} | {ok: false, status: number, error: string, code: string, field?: string}}
 */
export function validateWeatherRequest(req) {
  const sources = {
    params: req?.params ?? {},
    query: req?.query ?? {},
    body: req?.body ?? {},
  };

  const data = {};

  for (const [source, schema] of Object.entries(weatherRequestSchema)) {
    const parsed = schema.safeParse(sources[source]);

    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path?.[0];
      const code =
        source === 'query' && field && field in QUERY_FIELD_ERROR_CODES
          ? QUERY_FIELD_ERROR_CODES[field]
          : SOURCE_ERROR_CODES[source];

      return {
        ok: false,
        status: 400,
        error: issue?.message ?? 'Invalid request',
        code,
        field,
      };
    }

    data[source] = parsed.data;
  }

  return { ok: true, data };
}
