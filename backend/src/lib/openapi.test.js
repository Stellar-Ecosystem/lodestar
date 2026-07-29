import { describe, it, expect } from 'vitest';
import { buildOpenApiDocument } from './openapi.js';
import { routes } from '../schemas/index.js';

const doc = buildOpenApiDocument({ version: '9.9.9' });

/** `/services/:id` → `/services/{id}` */
const openApiPath = (path) => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

describe('buildOpenApiDocument', () => {
  it('emits a valid-looking OpenAPI 3.1 envelope', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Lodestar API');
    expect(doc.info.version).toBe('9.9.9');
  });

  it('documents every declared route, and nothing it did not declare', () => {
    const documented = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method} ${path}`),
    );
    const expected = routes.map((r) => `${r.method} ${openApiPath(r.fullPath)}`);

    expect(documented.sort()).toEqual(expected.sort());
  });

  it('gives every operation a summary', () => {
    const unsummarised = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(([, op]) => !op.summary)
        .map(([method]) => `${method} ${path}`),
    );

    expect(unsummarised).toEqual([]);
  });
});

describe('generated from the same schemas the server enforces', () => {
  it('derives path parameters, including their constraints', () => {
    const op = doc.paths['/api/registry/by-provider/{address}'].get;
    const address = op.parameters.find((p) => p.name === 'address');

    expect(address).toMatchObject({
      in: 'path',
      required: true,
      schema: { type: 'string', pattern: '^G[A-Z2-7]{55}$' },
    });
  });

  it('derives request bodies, including lengths and enums', () => {
    const schema =
      doc.paths['/api/registry/prepare-register'].post.requestBody.content[
        'application/json'
      ].schema;

    expect(schema.properties.name).toMatchObject({ minLength: 3, maxLength: 50 });
    expect(schema.properties.category.enum).toEqual([
      'search',
      'weather',
      'finance',
      'ai',
      'data',
      'compute',
    ]);
    expect(schema.required).toContain('providerAddress');
    // `payTo` is optional in the schema, so it must not be required here.
    expect(schema.required).not.toContain('payTo');
  });

  it('documents query parameters as the caller sends them, not as the handler receives them', () => {
    const op = doc.paths['/api/agents/{address}/payment-history'].get;
    const limit = op.parameters.find((p) => p.name === 'limit');

    // The handler gets a number; the wire carries a string. `io: "input"`
    // means the spec describes the wire.
    expect(limit.schema.type).toBe('string');
    expect(limit.required).toBe(false);
  });

  it('documents header parameters', () => {
    const op = doc.paths['/api/agents/{address}/payment'].post;
    const header = op.parameters.find((p) => p.name === 'x-idempotency-key');

    expect(header).toMatchObject({ in: 'header', required: true });
    expect(header.schema).toMatchObject({ maxLength: 255 });
  });

  it('points every operation at the one shared validation-error schema', () => {
    const refs = Object.values(doc.paths).flatMap((methods) =>
      Object.values(methods).map(
        (op) => op.responses['400'].content['application/json'].schema.$ref,
      ),
    );

    expect(new Set(refs)).toEqual(new Set(['#/components/schemas/ValidationError']));
    expect(doc.components.schemas.ValidationError.properties).toMatchObject({
      error: { type: 'string' },
      code: { type: 'string' },
      details: { type: 'array' },
    });
  });

  it('is JSON-serialisable', () => {
    expect(() => JSON.stringify(doc)).not.toThrow();
  });
});
