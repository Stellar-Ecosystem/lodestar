const port = Number(process.env.PORT ?? 3001);
const baseUrl = `http://127.0.0.1:${port}`;
import logger from '../lib/logger.js';

/**
 * Validate and rewrite a demo service endpoint to the internal loopback address.
 *
 * @param {string} originalEndpoint - The raw endpoint URL stored on‑chain.
 * @param {string} category - Either "weather" or "search" (used to pick the allowed path and query keys).
 * @returns {string} - A safe, rewritten URL pointing at 127.0.0.1 with only allowed path/query params.
 * @throws {Error} - Throws with a descriptive message when the endpoint is malformed or disallowed.
 */
export function validateDemoEndpoint(originalEndpoint, category) {
  let urlObj;
  try {
    urlObj = new URL(originalEndpoint);
  } catch (e) {
    logger.warn({ originalEndpoint, reason: 'invalid_url' }, 'Blocked SSRF attempt');
    throw new Error('Invalid endpoint URL');
  }

  // Define allowed path prefixes per category
  const allowlist = {
    weather: '/demo/weather',
    search: '/demo/search',
  };

  const allowedPath = allowlist[category];
  if (!allowedPath) {
    logger.warn({ originalEndpoint, category, reason: 'unknown_category' }, 'Blocked SSRF attempt');
    throw new Error('Endpoint not allowed');
  }

  // Verify the pathname exactly matches the allowed prefix (no extra segments)
  if (!urlObj.pathname.startsWith(allowedPath) || urlObj.pathname !== allowedPath) {
    logger.warn({ originalEndpoint, reason: 'path_not_allowed' }, 'Blocked SSRF attempt');
    throw new Error('Endpoint not allowed');
  }

  // Sanitize query parameters – keep only the whitelisted ones for the category
  const allowedParams = {
    weather: ['lat', 'lon'],
    search: ['q'],
  }[category];

  const sanitized = new URLSearchParams();
  for (const key of allowedParams) {
    if (urlObj.searchParams.has(key)) {
      sanitized.set(key, urlObj.searchParams.get(key));
    }
  }

  // Replace host with internal loopback address
  urlObj.protocol = 'http:';
  urlObj.hostname = '127.0.0.1';
  urlObj.port = String(port);
  urlObj.search = sanitized.toString();

  return urlObj.toString();
}
