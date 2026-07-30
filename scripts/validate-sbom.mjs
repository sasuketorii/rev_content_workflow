#!/usr/bin/env node
/* global console, process */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import validation from "@cyclonedx/cyclonedx-library/Validation";
import spec from "@cyclonedx/cyclonedx-library/Spec";

const { JsonValidator } = validation;
const { Version } = spec;

const expectedSchemaHashes = new Map([
  ["bom-1.5.SNAPSHOT.schema.json", "7e88444a06e0924f13dc3833cda313872c772763b47a4e1ac55e77992b8f0a44"],
  ["spdx.SNAPSHOT.schema.json", "ea6e844ee6fba1e93473d94834d0ee0996970533497935f932f73d488ffdf4a3"],
  ["jsf-0.82.SNAPSHOT.schema.json", "8bae002c25e723db7ee1f26afde680ae1a2b1a8f6b4b4b0fd65dc3becb090aae"]
]);
const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("@cyclonedx/cyclonedx-library/package.json"));
for (const [name, expected] of expectedSchemaHashes) {
  const bytes = await readFile(join(packageRoot, "res", "schema", name));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`pinned CycloneDX schema hash mismatch: ${name}`);
}

const input = process.argv[2];
if (!input) throw new Error("usage: validate-sbom.mjs SBOM.json");
const document = await readFile(input, "utf8");
const error = await new JsonValidator(Version.v1dot5).validate(document);
if (error !== null) {
  console.error(JSON.stringify(error, null, 2));
  process.exit(1);
}
console.log("CycloneDX 1.5 schema validation: 0 errors");
