#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
SERVICE=$ROOT/packaging/systemd/rev-content.service.in
TIMER=$ROOT/packaging/systemd/rev-content.timer.in
grep -F 'ExecStart=@REV_CONTENT_BIN@ worker --once' "$SERVICE" >/dev/null
grep -F 'ReadWritePaths=-@STATE_DIR@' "$SERVICE" >/dev/null
grep -F 'ReadWritePaths=-@DATA_DIR@' "$SERVICE" >/dev/null
if grep -F 'ProtectHome=' "$SERVICE" >/dev/null; then
  echo "ProtectHome conflicts with user-local runtime paths" >&2
  exit 1
fi
grep -F 'OnUnitActiveSec=1min' "$TIMER" >/dev/null
if command -v systemd-analyze >/dev/null 2>&1; then
  temp_dir=$(mktemp -d)
  sed -e 's|@REV_CONTENT_BIN@|/usr/bin/true|' \
    -e 's|@CONFIG_DIR@|/tmp/rev-content-config|' \
    -e 's|@STATE_DIR@|/tmp/rev-content-state|' \
    -e 's|@DATA_DIR@|/tmp/rev-content-data|' "$SERVICE" >"$temp_dir/rev-content.service"
  cp "$TIMER" "$temp_dir/rev-content.timer"
  systemd-analyze verify "$temp_dir/rev-content.service" "$temp_dir/rev-content.timer"
fi
echo "systemd unit contract passed"
