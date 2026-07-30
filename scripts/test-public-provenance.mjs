#!/usr/bin/env node
/* global console */
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFile(resolve(root, path));
const manifest = JSON.parse(await read("distribution-manifest.json"));
const upstream = JSON.parse(await read("upstream.lock.json"));
const revmagic = upstream.dependencies?.revmagic;
const expected = {
  repository: "https://github.com/sasuketorii/revmagic-runtime.git",
  commit: "4f4bbcf565e2fb0da968971eb9f485a74bf3cac2",
  lock: "e03b200f5991fc97c3146d0e5e710d061f31c136d58a837ff95fa01c5d79b5da",
  license: "f5e10e376c4fab85036c3b25e4609a9c70e736ddd88c3f4a88d8b55e21fd7acb",
  sourceContract: "patchless public root workspace with exactly revmagic-core, revmagic-cli, and revmagic-mcp"
};
if (revmagic?.repository !== expected.repository || revmagic?.commit !== expected.commit ||
    revmagic?.verifiedLockfileSha256 !== expected.lock ||
    revmagic?.lockfileSha256 !== expected.lock ||
    revmagic?.licenseSha256 !== expected.license ||
    revmagic?.sourceContract !== expected.sourceContract ||
    "patch" in revmagic || "patchSha256" in revmagic) {
  throw new Error("RevMagic public patchless provenance contract mismatch");
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (sha256(await read(revmagic.verifiedLockfile)) !== expected.lock ||
    sha256(await read(revmagic.licenseFile)) !== expected.license) {
  throw new Error("RevMagic packaged lock or license differs from public provenance");
}
for (const path of [
  "install.sh",
  "scripts/verify-distribution.sh",
  ".github/workflows/linux-external-gate.yml"
]) {
  const content = (await read(path)).toString("utf8");
  if (!content.includes(expected.repository) || !content.includes(expected.commit)) {
    throw new Error(`RevMagic public repository or commit pin missing from ${path}`);
  }
}
const installer = (await read("install.sh")).toString("utf8");
for (const contract of [
  expected.lock,
  expected.license,
  "cargo metadata --locked --no-deps --format-version 1",
  "node \"$SCRIPT_DIR/scripts/verify-revmagic-workspace.mjs\"",
  "cargo build --locked --release -p revmagic-cli -p revmagic-mcp"
]) {
  if (!installer.includes(contract)) {
    throw new Error(`RevMagic install contract missing: ${contract}`);
  }
}
const forbidden = [
  "https://github.com/sasuketorii/" + "revmagic.git",
  "7fb1cd0d0992abc676656de0b1a170c8" + "88c109e9",
  "7a0a501d81cd69de96a64524d965b72d" + "361b11a8da4a08a906795b2aa8d7d086",
  "patches/" + "revmagic-optimize.patch"
];
for (const path of manifest.releaseAllowlist) {
  const content = (await read(path)).toString("utf8");
  const marker = forbidden.find((value) => content.includes(value));
  if (marker) throw new Error(`retired RevMagic provenance marker in ${path}`);
}
await access(resolve(root, "patches", "revmagic-" + "optimize.patch")).then(
  () => { throw new Error("retired RevMagic patch still exists"); },
  () => undefined
);
console.log("public patchless RevMagic provenance contract passed");
