/**
 * OpenAPI 3.1 document generated from the route schemas in `src/schemas/`.
 *
 * Nothing here restates what a route accepts — every parameter, every request
 * body, every constraint is derived from the same zod schema `validate()`
 * enforces at runtime, so the spec cannot drift from the implementation.
 */
import { z } from "zod";
import { routes } from "../schemas/index.js";
import { DEFAULT_VALIDATION_CODE } from "../middleware/validate.js";

const OPENAPI_VERSION = "3.1.0";

/**
 * zod's JSON Schema emitter, pinned to the *input* side of each schema — a
 * caller sends `"12"` even where the handler receives `12` after coercion.
 * `unrepresentable: "any"` keeps a schema that has no JSON Schema equivalent
 * from aborting the whole document.
 */
function toJsonSchema(schema) {
  const jsonSchema = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    target: "draft-2020-12",
  });
  delete jsonSchema.$schema;
  return jsonSchema;
}

/** `/services/:id` → `/services/{id}`. */
function toOpenApiPath(path) {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** A source may be declared bare or as `{ schema, code, message }`. */
function schemaOf(entry) {
  if (!entry) return null;
  return typeof entry.safeParse === "function" ? entry : entry.schema;
}

/**
 * Expand an object schema into one OpenAPI parameter per property.
 * Path parameters are always required; query and header parameters inherit
 * requiredness from the schema itself.
 */
function toParameters(entry, location) {
  const schema = schemaOf(entry);
  if (!schema) return [];

  const jsonSchema = toJsonSchema(schema);
  const required = new Set(jsonSchema.required ?? []);

  return Object.entries(jsonSchema.properties ?? {}).map(([name, property]) => {
    const { description, ...rest } = property;
    return {
      name,
      in: location,
      required: location === "path" ? true : required.has(name),
      ...(description ? { description } : {}),
      schema: rest,
    };
  });
}

function toRequestBody(entry) {
  const schema = schemaOf(entry);
  if (!schema) return undefined;

  return {
    required: true,
    content: { "application/json": { schema: toJsonSchema(schema) } },
  };
}

/**
 * The one error shape every failed validation returns. Declared as a zod schema
 * so it is generated the same way as everything else.
 */
export const validationErrorSchema = z
  .object({
    error: z.string().describe("The first problem found, in prose"),
    code: z
      .string()
      .describe(`Machine-readable code, e.g. INVALID_BODY or ${DEFAULT_VALIDATION_CODE}`),
    details: z
      .array(
        z.object({
          path: z.string().describe("Dotted path to the offending field"),
          message: z.string().describe("What is wrong with it"),
          rule: z.string().describe("The constraint that failed"),
        }),
      )
      .describe("Every problem found, not just the first"),
  })
  .describe("Returned with HTTP 400 whenever a request fails its schema");

/**
 * Build the OpenAPI document.
 *
 * @param {object} [options]
 * @param {string} [options.version] - Value for `info.version`.
 * @param {Array<{url: string, description?: string}>} [options.servers]
 */
export function buildOpenApiDocument({ version = "1.0.0", servers } = {}) {
  const paths = {};

  for (const route of routes) {
    const path = toOpenApiPath(route.fullPath);
    const parameters = [
      ...toParameters(route.request?.params, "path"),
      ...toParameters(route.request?.query, "query"),
      ...toParameters(route.request?.headers, "header"),
    ];
    const requestBody = toRequestBody(route.request?.body);

    paths[path] ??= {};
    paths[path][route.method] = {
      summary: route.summary,
      ...(route.tags ? { tags: route.tags } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody ? { requestBody } : {}),
      responses: {
        200: { description: "Success" },
        400: {
          description: "The request failed its schema",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ValidationError" },
            },
          },
        },
      },
    };
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "Lodestar API",
      version,
      description:
        "Service discovery and agent payments on Stellar. Generated from the " +
        "request schemas in src/schemas/ — the same schemas the server enforces.",
    },
    ...(servers ? { servers } : {}),
    paths,
    components: {
      schemas: { ValidationError: toJsonSchema(validationErrorSchema) },
    },
  };
}

export default buildOpenApiDocument;
