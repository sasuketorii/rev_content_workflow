import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("SBOM hashes are canonical CycloneDX digests and official schema validation has zero errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rev-content-sbom-"));
  const output = join(directory, "bom.json");
  await execFileAsync(process.execPath, [resolve("scripts/generate-sbom.mjs"), output]);
  const validation = await execFileAsync(
    process.execPath, [resolve("scripts/validate-sbom.mjs"), output]
  );
  assert.match(validation.stdout, /0 errors/);
  const sbom = JSON.parse(await readFile(output, "utf8")) as {
    components: Array<{ hashes?: Array<{ alg: string; content: string }> }>;
  };
  const expectedLengths = new Map([["SHA-256", 64], ["SHA-384", 96], ["SHA-512", 128]]);
  const hashes = sbom.components.flatMap((component) => component.hashes ?? []);
  assert.ok(hashes.length > 0);
  for (const hash of hashes) {
    assert.equal(hash.content.length, expectedLengths.get(hash.alg));
    assert.match(hash.content, /^[a-f0-9]+$/);
  }
});

test("npm integrity conversion rejects unknown, ambiguous, and malformed digests", async () => {
  const source = `
    import assert from "node:assert/strict";
    import { npmIntegrityToCycloneDx } from ${JSON.stringify(
      pathToFileURL(resolve("scripts/sbom-hash.mjs")).href
    )};
    const digest = Buffer.alloc(64, 0xab);
    assert.deepEqual(npmIntegrityToCycloneDx("sha512-" + digest.toString("base64")), {
      alg: "SHA-512", content: digest.toString("hex")
    });
    for (const value of [
      "sha1-" + digest.toString("base64"),
      "sha512-not_base64!",
      "sha512-" + digest.toString("base64") + " sha256-AAAA",
      "sha512-YQ=="
    ]) assert.throws(() => npmIntegrityToCycloneDx(value), /integrity/);
  `;
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", source]);
});
