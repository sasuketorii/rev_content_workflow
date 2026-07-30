#!/bin/sh
set -eu

VERSION=0.1.0
NOTEBOOK_REPO_DEFAULT=https://github.com/sasuketorii/notebooklm_mcp_with.git
NOTEBOOK_COMMIT=798513bc08510f257c936d1ddbdd1b935d0c0a0a
NOTEBOOK_PATCH_SHA256=de67f009ad09d6b9c15806d87d5efd85e20164965d5551cbde1b34be09dd4b05
NOTEBOOK_BASE_LOCK_SHA256=2d99cf4f84b0beb609c0779b515234b32c7617611d81b70c525b6fb2de7900ac
NOTEBOOK_PATCHED_LOCK_SHA256=07b8b69e7cb12d86f8abb8b9628e1bd50e91a5ef91728e32060b012fa5976082
REVMAGIC_REPO_DEFAULT=https://github.com/sasuketorii/revmagic.git
REVMAGIC_COMMIT=7fb1cd0d0992abc676656de0b1a170c888c109e9
REVMAGIC_PATCH_SHA256=7a0a501d81cd69de96a64524d965b72d361b11a8da4a08a906795b2aa8d7d086
REVMAGIC_BASE_LOCK_SHA256=a2290a8d9f1678123cdc2cc571ecbd6f1e69b075eddb59d780cb57bd03afe0c9
REVMAGIC_ISOLATED_LOCK_SHA256=7c5e1d6a50c3027f99564f312c517c69def20d120d9bee3aee67c2929457a727

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --help)
      echo "usage: ./install.sh [--dry-run]"
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
case "$(uname -s):$(uname -m)" in
  Darwin:arm64|Darwin:x86_64|Linux:aarch64|Linux:x86_64) ;;
  *) echo "unsupported platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

for command_name in git node npm cargo rustc shasum ffmpeg yt-dlp; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "missing prerequisite: $command_name" >&2
    exit 1
  fi
done

node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<13))process.exit(1)' ||
  { echo "Node.js >=22.13.0 is required" >&2; exit 1; }
cargo --version >/dev/null 2>&1 && rustc --version >/dev/null 2>&1 ||
  { echo "a configured Rust toolchain is required" >&2; exit 1; }

if [ "$(uname -s)" = Darwin ]; then
  DATA_BASE=${XDG_DATA_HOME:-"$HOME/Library/Application Support"}
else
  DATA_BASE=${XDG_DATA_HOME:-"$HOME/.local/share"}
fi
BIN_BASE=${XDG_BIN_HOME:-"$HOME/.local/bin"}
INSTALL_ROOT=$DATA_BASE/rev-content
RELEASE_DIR=$INSTALL_ROOT/releases/$VERSION
CURRENT_LINK=$INSTALL_ROOT/current
BIN_PATH=$BIN_BASE/rev-content
NOTEBOOK_REPO=${REV_CONTENT_NOTEBOOK_REPO:-$NOTEBOOK_REPO_DEFAULT}
REVMAGIC_REPO=${REV_CONTENT_REVMAGIC_REPO:-$REVMAGIC_REPO_DEFAULT}

case "$NOTEBOOK_REPO:$REVMAGIC_REPO" in
  *file://*)
    if [ "${REV_CONTENT_ALLOW_FIXTURE:-0}" != 1 ]; then
      echo "file:// dependency sources require REV_CONTENT_ALLOW_FIXTURE=1" >&2
      exit 1
    fi
    ;;
esac

if [ "$DRY_RUN" -eq 1 ]; then
  printf '%s\n' \
    "rev-content $VERSION install plan" \
    "platform=$(uname -s)/$(uname -m)" \
    "release=$RELEASE_DIR" \
    "launcher=$BIN_PATH" \
    "notebook_commit=$NOTEBOOK_COMMIT" \
    "revmagic_commit=$REVMAGIC_COMMIT" \
    "state and credentials are not created during install"
  exit 0
fi

RECEIPT_PATH=$INSTALL_ROOT/install-receipt.json
if [ -e "$INSTALL_ROOT" ] || [ -L "$INSTALL_ROOT" ] || [ -e "$BIN_PATH" ] || [ -L "$BIN_PATH" ]; then
  if [ ! -f "$RECEIPT_PATH" ] || [ -L "$RECEIPT_PATH" ]; then
    echo "existing install surface has no verified receipt; refusing to overwrite it" >&2
    exit 1
  fi
  node - "$RECEIPT_PATH" "$INSTALL_ROOT" "$BIN_PATH" "$CURRENT_LINK" <<'NODE'
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { lstatSync, readFileSync, readlinkSync, realpathSync } = require("node:fs");
const { join, resolve, sep } = require("node:path");
const [receiptPath, installRoot, binPath, currentLink] = process.argv.slice(2);
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
const fail = (message) => { throw new Error(`existing install ownership mismatch: ${message}`); };
if (receipt.formatVersion !== 1 || resolve(receipt.installRoot) !== resolve(installRoot) ||
    resolve(receipt.binPath) !== resolve(binPath)) fail("canonical paths");
const rootStat = lstatSync(installRoot);
const binStat = lstatSync(binPath);
const currentStat = lstatSync(currentLink);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("install root type");
if (!binStat.isFile() || binStat.isSymbolicLink()) fail("launcher type");
if (!currentStat.isSymbolicLink()) fail("current pointer type");
const releasesRoot = `${resolve(installRoot, "releases")}${sep}`;
if (typeof receipt.releaseDir !== "string" || !resolve(receipt.releaseDir).startsWith(releasesRoot)) {
  fail("release path");
}
const target = readlinkSync(currentLink);
if (target.startsWith("/") || resolve(installRoot, target) !== resolve(receipt.releaseDir) ||
    realpathSync(currentLink) !== realpathSync(receipt.releaseDir)) fail("current pointer target");
const launcherHash = createHash("sha256").update(readFileSync(binPath)).digest("hex");
if (launcherHash !== receipt.launcherSha256) fail("launcher hash");
const checksum = readFileSync(resolve(receipt.releaseDir, "release-manifest.sha256"), "utf8");
if (checksum !== `${receipt.releaseManifestSha256}  release-manifest.json\n`) fail("manifest checksum record");
const manifestHash = createHash("sha256")
  .update(readFileSync(resolve(receipt.releaseDir, "release-manifest.json"))).digest("hex");
if (manifestHash !== receipt.releaseManifestSha256) fail("manifest hash");
if (receipt.service !== undefined) {
  const canonicalDir = join(process.env.HOME, ".config", "systemd", "user");
  const canonicalService = join(canonicalDir, "rev-content.service");
  const canonicalTimer = join(canonicalDir, "rev-content.timer");
  if (!receipt.service || resolve(receipt.service.unitDir) !== resolve(canonicalDir) ||
      resolve(receipt.service.servicePath) !== resolve(canonicalService) ||
      resolve(receipt.service.timerPath) !== resolve(canonicalTimer)) fail("systemd canonical paths");
  for (const [path, expected] of [
    [canonicalService, receipt.service.serviceSha256],
    [canonicalTimer, receipt.service.timerSha256]
  ]) {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail(`systemd unit type: ${path}`);
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actual !== expected) fail(`systemd unit hash: ${path}`);
  }
  let loadState;
  try {
    loadState = execFileSync("systemctl", [
      "--user", "show", "rev-content.timer", "--property=LoadState", "--value"
    ], { encoding: "utf8" }).trim();
  } catch {
    fail("systemd timer state is unavailable");
  }
  if (loadState !== "loaded") fail(`systemd timer LoadState=${loadState || "empty"}`);
}
NODE
  node "$SCRIPT_DIR/scripts/hash-tree.mjs" verify \
    "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).releaseDir' "$RECEIPT_PATH")" \
    >/dev/null
fi

mkdir -p "$INSTALL_ROOT/releases" "$BIN_BASE"
STAGE=$(mktemp -d "$INSTALL_ROOT/.install-$VERSION.XXXXXX")
PREVIOUS=
if [ -L "$CURRENT_LINK" ]; then PREVIOUS=$(readlink "$CURRENT_LINK" || true); fi
SWITCHED=0
COMMITTED=0
RELEASE_REPLACED=0
BACKUP_CREATED=0
LAUNCHER_SWITCHED=0
RECEIPT_SWITCHED=0
BACKUP_RELEASE=$INSTALL_ROOT/.release-backup-$VERSION-$$
cleanup() {
  cleanup_failed=0
  if [ "$RECEIPT_SWITCHED" -eq 1 ] && [ "$COMMITTED" -eq 0 ]; then
    if [ -f "$STAGE/previous-install-receipt.json" ]; then
      mv -f "$STAGE/previous-install-receipt.json" "$RECEIPT_PATH" || cleanup_failed=1
    else
      rm -f "$RECEIPT_PATH"
    fi
  fi
  if [ "$LAUNCHER_SWITCHED" -eq 1 ] && [ "$COMMITTED" -eq 0 ]; then
    if [ -f "$STAGE/previous-launcher" ]; then
      mv -f "$STAGE/previous-launcher" "$BIN_PATH" || cleanup_failed=1
    else
      rm -f "$BIN_PATH"
    fi
  fi
  if [ "$SWITCHED" -eq 1 ] && [ "$COMMITTED" -eq 0 ]; then
    rollback_link=$INSTALL_ROOT/.rollback-$$
    if [ -n "$PREVIOUS" ]; then
      ln -s "$PREVIOUS" "$rollback_link"
      mv -f "$rollback_link" "$CURRENT_LINK" || cleanup_failed=1
    else
      rm -f "$CURRENT_LINK"
    fi
  fi
  if [ "$COMMITTED" -eq 0 ] && [ "$RELEASE_REPLACED" -eq 1 ]; then
    rm -rf "$RELEASE_DIR" || cleanup_failed=1
  fi
  if [ "$COMMITTED" -eq 0 ] && [ "$BACKUP_CREATED" -eq 1 ]; then
    if [ -d "$BACKUP_RELEASE" ]; then
      mv "$BACKUP_RELEASE" "$RELEASE_DIR" || {
        echo "rollback failed: could not restore $BACKUP_RELEASE to $RELEASE_DIR" >&2
        cleanup_failed=1
      }
    else
      echo "rollback failed: release backup is missing: $BACKUP_RELEASE" >&2
      cleanup_failed=1
    fi
  fi
  rm -rf "$STAGE" || cleanup_failed=1
  [ "$cleanup_failed" -eq 0 ]
}
on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if ! cleanup; then exit 1; fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

verify_sha256() {
  expected=$1
  path=$2
  actual=$(shasum -a 256 "$path" | awk '{print $1}')
  if [ "$actual" != "$expected" ]; then
    echo "checksum mismatch: $path" >&2
    exit 1
  fi
}

verify_sha256 "$NOTEBOOK_PATCH_SHA256" "$SCRIPT_DIR/patches/notebooklm-audio-custom.patch"
verify_sha256 "$REVMAGIC_PATCH_SHA256" "$SCRIPT_DIR/patches/revmagic-optimize.patch"
if [ -e "$RELEASE_DIR" ]; then
  node "$SCRIPT_DIR/scripts/hash-tree.mjs" verify "$RELEASE_DIR" >/dev/null
fi

mkdir -p "$STAGE/release/app" "$STAGE/release/deps"
git clone --quiet --no-checkout "$NOTEBOOK_REPO" "$STAGE/notebook-src"
git -C "$STAGE/notebook-src" checkout --quiet --detach "$NOTEBOOK_COMMIT"
test "$(git -C "$STAGE/notebook-src" rev-parse HEAD)" = "$NOTEBOOK_COMMIT"
verify_sha256 "$NOTEBOOK_BASE_LOCK_SHA256" "$STAGE/notebook-src/package-lock.json"
git -C "$STAGE/notebook-src" apply --check "$SCRIPT_DIR/patches/notebooklm-audio-custom.patch"
git -C "$STAGE/notebook-src" apply "$SCRIPT_DIR/patches/notebooklm-audio-custom.patch"
verify_sha256 "$NOTEBOOK_PATCHED_LOCK_SHA256" "$STAGE/notebook-src/package-lock.json"
(
  cd "$STAGE/notebook-src"
  npm ci
  npm run build
  npm prune --omit=dev
)
mkdir -p "$STAGE/release/deps/notebooklm"
cp -R "$STAGE/notebook-src/dist" "$STAGE/notebook-src/node_modules" "$STAGE/release/deps/notebooklm/"
cp "$STAGE/notebook-src/package.json" "$STAGE/notebook-src/package-lock.json" \
  "$STAGE/notebook-src/LICENSE" "$STAGE/release/deps/notebooklm/"

git clone --quiet --no-checkout "$REVMAGIC_REPO" "$STAGE/revmagic-src"
git -C "$STAGE/revmagic-src" checkout --quiet --detach "$REVMAGIC_COMMIT"
test "$(git -C "$STAGE/revmagic-src" rev-parse HEAD)" = "$REVMAGIC_COMMIT"
verify_sha256 "$REVMAGIC_BASE_LOCK_SHA256" "$STAGE/revmagic-src/Cargo.lock"
git -C "$STAGE/revmagic-src" apply --check "$SCRIPT_DIR/patches/revmagic-optimize.patch"
git -C "$STAGE/revmagic-src" apply "$SCRIPT_DIR/patches/revmagic-optimize.patch"
mkdir -p "$STAGE/revmagic-build/crates"
cp -R "$STAGE/revmagic-src/crates/revmagic-core" \
  "$STAGE/revmagic-src/crates/revmagic-cli" \
  "$STAGE/revmagic-src/crates/revmagic-mcp" "$STAGE/revmagic-build/crates/"
verify_sha256 "$REVMAGIC_ISOLATED_LOCK_SHA256" "$SCRIPT_DIR/locks/revmagic-isolated.Cargo.lock"
cp "$SCRIPT_DIR/locks/revmagic-isolated.Cargo.lock" "$STAGE/revmagic-build/Cargo.lock"
{
  printf '%s\n' '[workspace]' 'resolver = "2"' 'members = ['
  printf '%s\n' '  "crates/revmagic-core",' '  "crates/revmagic-cli",' '  "crates/revmagic-mcp",'
  printf '%s\n' ']'
} >"$STAGE/revmagic-build/Cargo.toml"
(
  cd "$STAGE/revmagic-build"
  cargo build --locked --release -p revmagic-cli -p revmagic-mcp
)
mkdir -p "$STAGE/release/deps/revmagic/bin"
cp "$STAGE/revmagic-build/target/release/revmagic-cli" "$STAGE/release/deps/revmagic/bin/"
cp "$STAGE/revmagic-build/target/release/revmagic-mcp" "$STAGE/release/deps/revmagic/bin/"
cp "$STAGE/revmagic-src/LICENSE" "$STAGE/release/deps/revmagic/"

(
  cd "$SCRIPT_DIR"
  npm ci
  npm run build
)
cp -R "$SCRIPT_DIR/dist" "$STAGE/release/app/"
cp "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/config.example.json" "$STAGE/release/app/"
cp "$SCRIPT_DIR/upstream.lock.json" "$SCRIPT_DIR/distribution-manifest.json" "$STAGE/release/"
cp -R "$SCRIPT_DIR/packaging" "$STAGE/release/"
node "$SCRIPT_DIR/scripts/hash-tree.mjs" generate "$STAGE/release" >/dev/null
node "$SCRIPT_DIR/scripts/generate-sbom.mjs" "$STAGE/release/sbom.cdx.json" "$STAGE/release" >/dev/null
node "$SCRIPT_DIR/scripts/hash-tree.mjs" generate "$STAGE/release" >/dev/null
RELEASE_MANIFEST_SHA=$(node "$SCRIPT_DIR/scripts/hash-tree.mjs" verify "$STAGE/release")

if [ -e "$RELEASE_DIR" ]; then
  node "$SCRIPT_DIR/scripts/hash-tree.mjs" verify "$RELEASE_DIR" >/dev/null
  mv "$RELEASE_DIR" "$BACKUP_RELEASE"
  BACKUP_CREATED=1
  if [ "${REV_CONTENT_TEST_FAIL_AFTER_BACKUP:-0}" = 1 ]; then
    echo "injected failure after release backup" >&2
    exit 97
  fi
  if [ "${REV_CONTENT_TEST_TERM_AFTER_BACKUP:-0}" = 1 ]; then
    echo "injected TERM after release backup" >&2
    kill -TERM "$$"
  fi
fi
mv "$STAGE/release" "$RELEASE_DIR"
RELEASE_REPLACED=1

LAUNCHER_TMP=$BIN_BASE/.rev-content-$$
{
  printf '%s\n' '#!/bin/sh'
  printf '%s\n' 'set -eu'
  printf '%s\n' 'if [ "$(uname -s)" = Darwin ]; then DATA_BASE=${XDG_DATA_HOME:-"$HOME/Library/Application Support"}; else DATA_BASE=${XDG_DATA_HOME:-"$HOME/.local/share"}; fi'
  printf '%s\n' 'exec node "$DATA_BASE/rev-content/current/app/dist/src/distribution-cli.js" "$@"'
} >"$LAUNCHER_TMP"
chmod 0755 "$LAUNCHER_TMP"
LAUNCHER_SHA=$(shasum -a 256 "$LAUNCHER_TMP" | awk '{print $1}')
if [ -f "$BIN_PATH" ]; then cp "$BIN_PATH" "$STAGE/previous-launcher"; fi
if [ -f "$RECEIPT_PATH" ]; then cp "$RECEIPT_PATH" "$STAGE/previous-install-receipt.json"; fi
NEW_LINK=$INSTALL_ROOT/.current-$VERSION-$$
ln -s "releases/$VERSION" "$NEW_LINK"
mv -f "$NEW_LINK" "$CURRENT_LINK"
SWITCHED=1
mv -f "$LAUNCHER_TMP" "$BIN_PATH"
LAUNCHER_SWITCHED=1
node - "$STAGE/install-receipt.json" "$INSTALL_ROOT" "$BIN_PATH" "$LAUNCHER_SHA" "$RELEASE_DIR" "$RELEASE_MANIFEST_SHA" "$STAGE/previous-install-receipt.json" <<'NODE'
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const [output, installRoot, binPath, launcherSha256, releaseDir, releaseManifestSha256, previousPath] = process.argv.slice(2);
let registrations = {};
let service;
if (existsSync(previousPath)) {
  const previous = JSON.parse(readFileSync(previousPath, "utf8"));
  if (previous.installRoot !== installRoot || previous.binPath !== binPath ||
      !previous.registrations || typeof previous.registrations !== "object") {
    throw new Error("existing install receipt ownership mismatch");
  }
  registrations = previous.registrations;
  service = previous.service;
}
writeFileSync(output, `${JSON.stringify({
  formatVersion: 1,
  installRoot,
  binPath,
  launcherSha256,
  releaseDir,
  releaseManifestSha256,
  registrations,
  ...(service ? { service } : {})
}, null, 2)}\n`, { mode: 0o600 });
NODE
mv -f "$STAGE/install-receipt.json" "$RECEIPT_PATH"
RECEIPT_SWITCHED=1
COMMITTED=1
if [ -d "$BACKUP_RELEASE" ]; then rm -rf "$BACKUP_RELEASE"; fi
BACKUP_CREATED=0

trap - EXIT HUP INT TERM
cleanup
echo "installed rev-content $VERSION at $RELEASE_DIR"
echo "next: $BIN_PATH setup --client auto && $BIN_PATH auth && $BIN_PATH doctor --json"
