/**
 * Conditional GET at the health and metrics route boundary (#1183).
 *
 * `If-None-Match` uses the weak comparison in RFC 9110: the weak flag is not
 * part of the match, a comma-separated list matches when any member does, and
 * `*` matches whenever a current representation exists. A match is answered
 * with 304 and no body; `ETag` and `Cache-Control` are the same headers the
 * 200 would have sent.
 */

import { createHash } from 'node:crypto';

const ENTITY_TAG = /^(W\/)?"([^"]*)"$/;

/**
 * Weak ETag over the exact bytes sent to the client.
 *
 * @param {string} body
 * @returns {string}
 */
export function computeWeakEtag(body) {
  return `W/"${createHash('sha256').update(body).digest('hex')}"`;
}

/**
 * Opaque tag of one entity-tag, ignoring a leading `W/`.
 * Returns null when `validator` is not a single entity-tag.
 *
 * @param {string} validator
 * @returns {string|null}
 */
function opaqueTag(validator) {
  const match = ENTITY_TAG.exec(validator.trim());
  return match ? match[2] : null;
}

/**
 * Split an If-None-Match list. Quoted tags keep commas that appear inside
 * them. A bare `*` is the wildcard; a quoted `"*"` is an ordinary opaque tag.
 * Malformed members are null.
 *
 * @param {string} header
 * @returns {Array<{ wildcard: true } | { opaque: string } | null>}
 */
function parseIfNoneMatch(header) {
  /** @type {Array<{ wildcard: true } | { opaque: string } | null>} */
  const tags = [];
  const source = header.trim();
  let index = 0;

  while (index < source.length) {
    while (
      index < source.length &&
      (source[index] === ' ' || source[index] === '\t' || source[index] === ',')
    ) {
      index += 1;
    }
    if (index >= source.length) break;

    if (source[index] === '*') {
      const next = source[index + 1];
      if (next === undefined || next === ',' || next === ' ' || next === '\t') {
        tags.push({ wildcard: true });
        index += 1;
        continue;
      }
    }

    // `W/` is case-sensitive. A lowercase prefix is not a weak flag.
    if (source.startsWith('W/', index)) index += 2;

    if (source[index] !== '"') {
      while (index < source.length && source[index] !== ',') index += 1;
      tags.push(null);
      continue;
    }

    index += 1;
    let value = '';
    while (index < source.length && source[index] !== '"') {
      value += source[index];
      index += 1;
    }
    if (source[index] !== '"') {
      tags.push(null);
      break;
    }
    index += 1;
    tags.push({ opaque: value });
  }

  return tags;
}

/**
 * Whether `If-None-Match` selects the current representation.
 * An absent or empty header does not match. Malformed validators are ignored,
 * so a header that cannot be parsed is a 200 rather than an error.
 *
 * @param {string|undefined|null} header
 * @param {string} etag Current representation's entity-tag.
 * @returns {boolean}
 */
export function ifNoneMatchMatches(header, etag) {
  if (typeof header !== 'string') return false;
  const value = header.trim();
  if (value === '') return false;
  if (value === '*') return true;

  const current = opaqueTag(etag);
  if (current === null) return false;

  for (const tag of parseIfNoneMatch(value)) {
    if (!tag) continue;
    if (tag.wildcard || tag.opaque === current) return true;
  }
  return false;
}

/**
 * Send `body` with its validators, or 304 when If-None-Match matches.
 * The 304 keeps `ETag`, `Cache-Control`, and any extra headers, and has no body.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ body: string, etag: string, cacheControl: string, headers?: Record<string, string> }} representation
 * @returns {import('express').Response}
 */
export function sendConditionalJson(req, res, representation) {
  const { body, etag, cacheControl, headers } = representation;
  res.set('Cache-Control', cacheControl);
  res.set('ETag', etag);
  if (headers) {
    for (const [name, value] of Object.entries(headers)) {
      res.set(name, value);
    }
  }

  if (ifNoneMatchMatches(req.get('If-None-Match'), etag)) {
    return res.status(304).end();
  }

  return res.type('application/json').send(body);
}
