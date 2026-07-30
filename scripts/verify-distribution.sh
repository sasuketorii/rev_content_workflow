#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$ROOT"
STAGE=$(mktemp -d)

node - "$STAGE" <<'NODE'
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { copyFileSync, existsSync, mkdirSync, readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const stage = process.argv[2];
const manifest = JSON.parse(readFileSync("distribution-manifest.json", "utf8"));
const lock = JSON.parse(readFileSync("upstream.lock.json", "utf8"));
const failures = [];
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
for (const path of manifest.releaseAllowlist) {
  if (!existsSync(path)) failures.push(`allowlisted file missing: ${path}`);
  else {
    mkdirSync(dirname(join(stage, path)), { recursive: true });
    copyFileSync(path, join(stage, path));
  }
}
for (const dependency of Object.values(lock.dependencies)) {
  if (sha(dependency.patch) !== dependency.patchSha256) failures.push(`patch checksum mismatch: ${dependency.patch}`);
}
if (sha(lock.dependencies.notebooklm.lockfile === "package-lock.json"
  ? "locks/notebooklm-patched.package-lock.json" : lock.dependencies.notebooklm.lockfile) !==
    lock.dependencies.notebooklm.patchedLockfileSha256) failures.push("patched NotebookLM lock mismatch");
if (sha(lock.dependencies.revmagic.isolatedLockfile) !==
    lock.dependencies.revmagic.isolatedLockfileSha256) failures.push("isolated Cargo lock mismatch");
if (manifest.licenseGate?.status !== "PASS") failures.push("license gate is not PASS");
let head;
try {
  head = execFileSync("git", ["rev-parse", "--verify", "HEAD"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {}
if (head) {
  for (const path of manifest.releaseAllowlist) {
    try {
      const committed = execFileSync("git", ["show", `HEAD:${path}`]);
      if (createHash("sha256").update(committed).digest("hex") !== sha(path)) {
        failures.push(`allowlisted source differs from HEAD: ${path}`);
      }
    } catch {
      failures.push(`allowlisted source is not committed at HEAD: ${path}`);
    }
  }
}
if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(JSON.stringify({ head: head ?? null, files: manifest.releaseAllowlist.length }));
NODE
node "$ROOT/scripts/verify-tree.mjs" "$STAGE"
SBOM_CHECK=$(mktemp -d)/rev-content-workflow.cdx.json
node "$ROOT/scripts/generate-sbom.mjs" "$SBOM_CHECK" >/dev/null
node "$ROOT/scripts/validate-sbom.mjs" "$SBOM_CHECK"

if [ "${REV_CONTENT_VERIFY_LOCAL_PATCHES:-0}" = 1 ]; then
  patch_stage=$(mktemp -d)
  git clone --quiet --no-checkout "${REV_CONTENT_NOTEBOOK_REPO:-https://github.com/sasuketorii/notebooklm_mcp_with.git}" "$patch_stage/notebook"
  git -C "$patch_stage/notebook" checkout --quiet --detach 798513bc08510f257c936d1ddbdd1b935d0c0a0a
  git -C "$patch_stage/notebook" apply --check "$ROOT/patches/notebooklm-audio-custom.patch"
  git clone --quiet --no-checkout "${REV_CONTENT_REVMAGIC_REPO:-https://github.com/sasuketorii/revmagic.git}" "$patch_stage/revmagic"
  git -C "$patch_stage/revmagic" checkout --quiet --detach 7fb1cd0d0992abc676656de0b1a170c888c109e9
  git -C "$patch_stage/revmagic" apply --check "$ROOT/patches/revmagic-optimize.patch"
fi
