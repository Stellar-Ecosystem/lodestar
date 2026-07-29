#!/usr/bin/env node
/**
 * Emit the OpenAPI document built from `src/schemas/`.
 *
 *   npm run openapi                  # to stdout
 *   npm run openapi -- --out api.json
 *
 * The same document is served live at GET /api/openapi.json, so writing a file
 * is only for committing a snapshot or feeding a client generator.
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { buildOpenApiDocument } from "../src/lib/openapi.js";

const { version } = createRequire(import.meta.url)("../package.json");

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outPath = outIndex === -1 ? null : args[outIndex + 1];

if (outIndex !== -1 && !outPath) {
  console.error("--out requires a file path");
  process.exit(1);
}

const json = JSON.stringify(buildOpenApiDocument({ version }), null, 2);

if (outPath) {
  writeFileSync(outPath, `${json}\n`, "utf-8");
  console.error(`Wrote OpenAPI document to ${outPath}`);
} else {
  process.stdout.write(`${json}\n`);
}
