#!/usr/bin/env node
/* global console, process */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { npmIntegrityToCycloneDx, sha256HexToCycloneDx } from "./sbom-hash.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workflowLock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const notebookLockPath = join(root, "locks", "notebooklm-patched.package-lock.json");
const notebookLock = JSON.parse(await readFile(notebookLockPath, "utf8"));
const cargoLockPath = join(root, "locks", "revmagic-isolated.Cargo.lock");
const cargoLock = await readFile(cargoLockPath, "utf8");
const upstream = JSON.parse(await readFile(join(root, "upstream.lock.json"), "utf8"));
const sha = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const components = [];

function addNpm(lock, scope) {
  for (const [path, value] of Object.entries(lock.packages ?? {})) {
    const name = path ? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length) : lock.name;
    if (!name || !value.version) continue;
    components.push({
      type: path ? "library" : "application",
      group: scope,
      name,
      version: value.version,
      licenses: value.license ? [{ license: { id: value.license } }] : undefined,
      hashes: value.integrity !== undefined
        ? [npmIntegrityToCycloneDx(value.integrity, `${scope}:${name}@${value.version}`)]
        : undefined
    });
  }
}
addNpm(workflowLock, "rev-content");
addNpm(notebookLock, "notebooklm-patched");

for (const block of cargoLock.split("\n[[package]]\n").slice(1)) {
  const name = block.match(/^name = "([^"]+)"/m)?.[1];
  const version = block.match(/^version = "([^"]+)"/m)?.[1];
  const checksum = block.match(/^checksum = "([^"]+)"/m)?.[1];
  if (name && version) {
    components.push({
      type: "library", group: "revmagic-isolated", name, version,
      hashes: checksum ? [sha256HexToCycloneDx(checksum, `cargo:${name}@${version}`)] : undefined
    });
  }
}
for (const [name, value] of Object.entries(upstream.dependencies)) {
  components.push({
    type: "application", name, version: value.commit,
    licenses: [{ license: { id: value.license } }],
    externalReferences: [{ type: "vcs", url: value.repository }]
  });
}

const releaseRoot = process.argv[3];
if (releaseRoot) {
  const manifest = JSON.parse(await readFile(join(releaseRoot, "release-manifest.json"), "utf8"));
  for (const file of manifest.files) {
    if (/^deps\/revmagic\/bin\/[^/]+$/.test(file.path) ||
        file.path === "deps/notebooklm/dist/index.js") {
      components.push({
        type: "file", name: file.path, version: upstream.generatedFor,
        hashes: [sha256HexToCycloneDx(file.sha256, `release:${file.path}`)]
      });
    }
  }
}

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    component: { type: "application", name: workflowLock.name, version: workflowLock.version },
    properties: [
      { name: "rev-content:notebooklm-patched-lock-sha256", value: await sha(notebookLockPath) },
      { name: "rev-content:revmagic-isolated-lock-sha256", value: await sha(cargoLockPath) }
    ]
  },
  components: [...new Map(components.map((component) =>
    [JSON.stringify(component), component])).values()]
};
const output = process.argv[2] ?? "release/rev-content-workflow.cdx.json";
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(sbom, null, 2)}\n`);
console.log(output);
