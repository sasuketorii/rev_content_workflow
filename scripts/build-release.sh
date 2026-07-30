#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
OUT=${1:-"$ROOT/release"}
"$ROOT/scripts/verify-distribution.sh"
mkdir -p "$OUT"
STAGE=$(mktemp -d)

node - "$STAGE" <<'NODE'
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const stage = process.argv[2];
const release = JSON.parse(readFileSync("distribution-manifest.json", "utf8"));
const files = release.releaseAllowlist.slice().sort();
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
for (const path of files) {
  mkdirSync(dirname(join(stage, path)), { recursive: true });
  copyFileSync(path, join(stage, path));
}
let head = null;
try {
  head = execFileSync("git", ["rev-parse", "--verify", "HEAD"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {}
const manifest = {
  formatVersion: 1,
  gitHead: head,
  files: files.map((path) => ({ path, sha256: sha(path), size: statSync(path).size }))
};
writeFileSync(join(stage, "source-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
NODE
node "$ROOT/scripts/verify-tree.mjs" "$STAGE"
cp "$STAGE/source-manifest.json" "$OUT/source-manifest.json"
node "$ROOT/scripts/generate-sbom.mjs" "$OUT/rev-content-workflow.cdx.json"
node "$ROOT/scripts/validate-sbom.mjs" "$OUT/rev-content-workflow.cdx.json"

find "$STAGE" -type f -exec touch -t 197001010000 {} +
LIST=$(mktemp)
(cd "$STAGE" && find . -type f | LC_ALL=C sort >"$LIST")
TAR_PATH=$OUT/rev-content-workflow-0.1.0.tar
(cd "$STAGE" && COPYFILE_DISABLE=1 tar -cf "$TAR_PATH" -T "$LIST")
gzip -n -f "$TAR_PATH"
ARCHIVE=$OUT/rev-content-workflow-0.1.0.tar.gz
(cd "$OUT" && shasum -a 256 "$(basename "$ARCHIVE")" >"$(basename "$ARCHIVE").sha256")

EXTRACTED=$(mktemp -d)
tar -xzf "$ARCHIVE" -C "$EXTRACTED"
node "$ROOT/scripts/verify-tree.mjs" "$EXTRACTED"
cmp "$OUT/source-manifest.json" "$EXTRACTED/source-manifest.json"
node - "$EXTRACTED" <<'NODE'
const { createHash } = require("node:crypto");
const { readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const root = process.argv[2];
const manifest = JSON.parse(readFileSync(join(root, "source-manifest.json"), "utf8"));
for (const file of manifest.files) {
  const path = join(root, file.path);
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (hash !== file.sha256 || statSync(path).size !== file.size) {
    throw new Error(`archive differs from source manifest: ${file.path}`);
  }
}
NODE
(cd "$OUT" && shasum -a 256 -c "$(basename "$ARCHIVE").sha256")
COMPANIONS=$(mktemp -d)
cp "$OUT/source-manifest.json" "$OUT/rev-content-workflow.cdx.json" \
  "$OUT/$(basename "$ARCHIVE").sha256" "$COMPANIONS/"
node "$ROOT/scripts/verify-tree.mjs" "$COMPANIONS"
echo "created $ARCHIVE"
