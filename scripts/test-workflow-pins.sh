#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
WORKFLOW=$ROOT/.github/workflows/linux-external-gate.yml

if grep -Eq 'uses:[[:space:]]+[^[:space:]]+@([^[:space:]]{0,39}|[^0-9a-f][^[:space:]]*)$' "$WORKFLOW"; then
  echo "workflow contains an action that is not pinned to a full commit SHA" >&2
  exit 1
fi
if grep -Eq 'curl[^|]*\|' "$WORKFLOW"; then
  echo "workflow pipes curl output into another process" >&2
  exit 1
fi
test "$(grep -c 'uses:' "$WORKFLOW")" -eq 2
grep -q 'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' "$WORKFLOW"
grep -q 'uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020' "$WORKFLOW"
grep -q 'node-version: "22.13.0"' "$WORKFLOW"
grep -q 'gitleaks_8.28.0_linux_x64.tar.gz' "$WORKFLOW"
grep -q 'a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb' "$WORKFLOW"
echo "workflow pin contract passed"
