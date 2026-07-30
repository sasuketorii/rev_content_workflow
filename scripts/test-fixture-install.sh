#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
TEST_ROOT=$(mktemp -d)
ORIGINAL_HOME=$HOME
print_doctor_diagnostics() {
  node - "$TEST_ROOT" "$ORIGINAL_HOME" \
    "$TEST_ROOT/doctor.stdout" "$TEST_ROOT/doctor.stderr" <<'NODE'
const { readFileSync } = require("node:fs");
const [testRoot, originalHome, ...files] = process.argv.slice(2);
for (const path of files) {
  let content = "";
  try { content = readFileSync(path, "utf8"); } catch {}
  content = content.split(testRoot).join("<TEST_ROOT>")
    .split(originalHome).join("<ORIGINAL_HOME>");
  process.stderr.write(`--- ${path.split("/").at(-1)} ---\n${content}`);
}
NODE
}
export CARGO_HOME=${CARGO_HOME:-"$ORIGINAL_HOME/.cargo"}
export RUSTUP_HOME=${RUSTUP_HOME:-"$ORIGINAL_HOME/.rustup"}
export HOME=$TEST_ROOT/home
export XDG_CONFIG_HOME=$TEST_ROOT/config
export XDG_STATE_HOME=$TEST_ROOT/state
export XDG_DATA_HOME=$TEST_ROOT/data
export XDG_BIN_HOME=$TEST_ROOT/bin
export REV_CONTENT_ALLOW_FIXTURE=1
: "${REV_CONTENT_TEST_NOTEBOOK_REPO:?set REV_CONTENT_TEST_NOTEBOOK_REPO to the local NotebookLM fork}"
: "${REV_CONTENT_TEST_REVMAGIC_REPO:?set REV_CONTENT_TEST_REVMAGIC_REPO to the local public RevMagic runtime repository}"
export REV_CONTENT_NOTEBOOK_REPO="file://$REV_CONTENT_TEST_NOTEBOOK_REPO"
export REV_CONTENT_REVMAGIC_REPO="file://$REV_CONTENT_TEST_REVMAGIC_REPO"
mkdir -p "$HOME"
mkdir -p "$XDG_BIN_HOME"
cp "$ROOT/test/fake-client.mjs" "$XDG_BIN_HOME/codex"
chmod 0755 "$XDG_BIN_HOME/codex"
export PATH=$XDG_BIN_HOME:$PATH
export FAKE_CLIENT_STATE=$TEST_ROOT/fake-client-state.json
printf '%s\n' '{"names":{},"adds":0}' >"$FAKE_CLIENT_STATE"
printf '%s\n' 'unrelated user launcher' >"$XDG_BIN_HOME/rev-content"
if "$ROOT/install.sh" >"$TEST_ROOT/collision.stdout" 2>"$TEST_ROOT/collision.stderr"; then
  echo "installer overwrote an unrelated launcher without a receipt" >&2
  exit 1
fi
grep -q "unrelated user launcher" "$XDG_BIN_HOME/rev-content"
rm "$XDG_BIN_HOME/rev-content"
"$ROOT/install.sh"
"$XDG_BIN_HOME/rev-content" setup --client codex
if "$XDG_BIN_HOME/rev-content" doctor --json --offline \
  >"$TEST_ROOT/doctor.stdout" 2>"$TEST_ROOT/doctor.stderr"; then
  echo "offline doctor unexpectedly reported authenticated in a clean fixture" >&2
  print_doctor_diagnostics
  exit 1
fi
if ! node -e '
const d=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));
if(d.config!==true||d.required_tools!==true||d.authenticated!==false||
   d.auth_mode!=="offline_get_health"||d.mcp_error!==undefined||
   d.notebooklm_auth!==undefined||typeof d.notebooklm_health!=="object"||
   d.install_provenance!==true||!d.managed_registrations.every(x=>x.ok)||
   !d.runtime_writable.every(x=>x.ok))process.exit(1)
' "$TEST_ROOT/doctor.stdout"; then
  echo "offline doctor result did not satisfy the fixture contract" >&2
  print_doctor_diagnostics
  exit 1
fi
if "$XDG_BIN_HOME/rev-content" run https://example.test/unauthenticated >"$TEST_ROOT/run.json" 2>"$TEST_ROOT/run.stderr"; then
  echo "unauthenticated run unexpectedly succeeded" >&2
  exit 1
fi
test ! -e "$XDG_STATE_HOME/rev-content/jobs.sqlite"
cp "$ROOT/test/fake-systemctl.mjs" "$XDG_BIN_HOME/systemctl"
chmod 0755 "$XDG_BIN_HOME/systemctl"
export FAKE_SYSTEMCTL_LOG=$TEST_ROOT/systemctl.log
(
  cd "$ROOT"
  node --input-type=module -e \
    'const [{service},{runtimePaths}]=await Promise.all([import("./dist/src/distribution.js"),import("./dist/src/paths.js")]);await service("install",{...runtimePaths(),installRelease:process.cwd()},"linux")'
)
node -e 'const r=require(process.argv[1]);if(!r.service)process.exit(1)' \
  "$XDG_DATA_HOME/rev-content/install-receipt.json"
OLD_CURRENT=$(readlink "$XDG_DATA_HOME/rev-content/current")
OLD_RELEASE_MANIFEST=$(shasum -a 256 "$XDG_DATA_HOME/rev-content/releases/0.1.0/release-manifest.json" | awk '{print $1}')
if REV_CONTENT_TEST_TERM_AFTER_BACKUP=1 "$ROOT/install.sh" \
  >"$TEST_ROOT/rollback.stdout" 2>"$TEST_ROOT/rollback.stderr"; then
  echo "injected install failure unexpectedly succeeded" >&2
  exit 1
fi
test "$(readlink "$XDG_DATA_HOME/rev-content/current")" = "$OLD_CURRENT"
test "$(shasum -a 256 "$XDG_DATA_HOME/rev-content/releases/0.1.0/release-manifest.json" | awk '{print $1}')" = "$OLD_RELEASE_MANIFEST"
test -z "$(find "$XDG_DATA_HOME/rev-content" -maxdepth 1 -name '.release-backup-*' -print -quit)"
test -z "$(find "$XDG_DATA_HOME/rev-content" -maxdepth 1 -name '.install-*' -print -quit)"
"$ROOT/install.sh"
node -e 'const r=require(process.argv[1]);if(!r.service)process.exit(1)' \
  "$XDG_DATA_HOME/rev-content/install-receipt.json"
test -x "$XDG_BIN_HOME/rev-content"
TAMPERED=$XDG_DATA_HOME/rev-content/releases/0.1.0/distribution-manifest.json
cp "$TAMPERED" "$TEST_ROOT/distribution-manifest.backup"
printf '%s\n' 'tamper' >>"$TAMPERED"
if "$ROOT/install.sh" >"$TEST_ROOT/tampered-reinstall.stdout" 2>"$TEST_ROOT/tampered-reinstall.stderr"; then
  echo "tampered installed release was reused" >&2
  exit 1
fi
cp "$TEST_ROOT/distribution-manifest.backup" "$TAMPERED"
test -x "$XDG_BIN_HOME/rev-content"
test -x "$XDG_DATA_HOME/rev-content/current/deps/revmagic/bin/revmagic-mcp"
test -f "$XDG_DATA_HOME/rev-content/current/deps/notebooklm/dist/index.js"
"$XDG_BIN_HOME/rev-content" uninstall
test ! -e "$XDG_BIN_HOME/rev-content"
test ! -e "$HOME/.config/systemd/user/rev-content.service"
test ! -e "$HOME/.config/systemd/user/rev-content.timer"
grep -q 'disable.*--now.*rev-content.timer' "$FAKE_SYSTEMCTL_LOG"
test -f "$XDG_CONFIG_HOME/rev-content/config.json"
test -f "$XDG_DATA_HOME/rev-content/install-receipt.json"
echo "fixture install contract passed: $TEST_ROOT"
