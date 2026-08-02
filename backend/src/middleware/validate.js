/**
 * The one place a request is validated.
 *
 * `validate(spec)` reads the declarative schemas a route publishes in
 * `src/schemas/` and turns a failure into a single response shape:
 *
 *   {
 *     "error":  "`name` must be 3-50 characters",   // the first problem, in prose
 *     "code":   "INVALID_BODY",                     // machine-readable
 *     "details": [                                  // every problem found
 *       { "path": "name", "message": "…", "rule": "too_small" }
 *     ]
 *   }
 *
 * `error` and `code` keep the field names the API already returned, so existing
 * clients see no break; `details` is the new part that makes multi-field
 * failures actionable in one round trip.
 *
 * On success the parsed — coerced, trimmed, defaulted — values are attached to
 * `req.valid.{params,query,headers,body}`. Handlers read those and do no
 * checking of their own.
 */
import logger from "../lib/logger.js";

/**
 * Validation order. Path params come first so a bad `:id` is reported before
 * complaints about the body it was carrying.
 */
const SOURCES = ["params", "query", "headers", "body"];

const DEFAULT_CODES = {
  params: "INVALID_PARAMS",
  query: "INVALID_QUERY",
  headers: "INVALID_HEADERS",
  body: "INVALID_BODY",
};

/** Response `code` used when a route declares nothing more specific. */
export const DEFAULT_VALIDATION_CODE = "VALIDATION_ERROR";

/**
 * Flatten zod issues into the stable `details` array.
 *
 * `path` is dotted and array indices are rendered inline (`allowedCategories.0`)
 * so a client can point at the offending field without walking a tree.
 */
export function formatIssues(issues) {
  return issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
    rule: issue.code,
  }));
}

/**
 * Build the response body for a failed source.
 *
 * The reported `code` is, in order of preference: the code the first issue
 * carried (schemas use this to separate "missing" from "malformed"), the code
 * the route declared for this source, then a per-source default.
 */
export function buildValidationError(source, entry, issues) {
  const [first] = issues;
  return {
    error: entry.message ?? first?.message ?? "Invalid request",
    code:
      first?.params?.code ??
      entry.code ??
      DEFAULT_CODES[source] ??
      DEFAULT_VALIDATION_CODE,
    details: formatIssues(issues),
  };
}

/**
 * Normalise a route's schema declaration. A source may be given either as a
 * bare schema or as `{ schema, code, message }`, so the specs stay terse where
 * the defaults are right.
 */
function normalizeEntry(entry) {
  if (!entry) return null;
  return typeof entry.safeParse === "function" ? { schema: entry } : entry;
}

/**
 * Express middleware factory. Accepts a full route spec (`{ request: {…} }`) or
 * the request block on its own, so it reads naturally at either call site.
 */
export function validate(spec) {
  const request = spec?.request ?? spec ?? {};
  const entries = SOURCES.map((source) => [source, normalizeEntry(request[source])]).filter(
    ([, entry]) => entry !== null,
  );

  return function validateRequest(req, res, next) {
    const valid = {};

    for (const [source, entry] of entries) {
      // Headers are always an object; body can be absent when no parser ran.
      const input = source === "body" ? (req.body ?? {}) : req[source];
      const result = entry.schema.safeParse(input);

      if (!result.success) {
        const body = buildValidationError(source, entry, result.error.issues);
        logger.warn(
          { path: req.originalUrl, source, code: body.code, details: body.details },
          "Request failed schema validation",
        );
        return res.status(400).json(body);
      }

      valid[source] = result.data;
    }

    req.valid = valid;
    next();
  };
}

export default validate;
