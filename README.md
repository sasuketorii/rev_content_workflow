# Rev Content Workflow

Rev Content turns a media URL into a durable NotebookLM transcription job. It
installs pinned RevMagic and custom NotebookLM MCP sources, registers them with
Codex and/or Claude Code, and preserves workflow progress in a user-local
SQLite database.

[日本語](README.ja.md)

## Requirements

- macOS or Linux on arm64 or x86_64
- Node.js 22.13 or newer, npm, Git
- Rust/Cargo 1.86.0 or newer
- FFmpeg and yt-dlp
- gitleaks for release verification
- Codex CLI and/or Claude Code CLI

The installer builds from exact source commits. Dependencies that declare a
patch contract are checked before patching. RevMagic is built without a patch
from the pinned public `revmagic-runtime` root workspace after its Cargo lock
and license match the packaged copies. The release does not contain this
repository's `node_modules`, `dist`, local runtime files, PDFs, credentials,
browser profile, audio, or transcripts.

## Install

```sh
./install.sh --dry-run
./install.sh
```

Ensure the printed user-local bin directory is on `PATH`, then:

```sh
rev-content setup --client auto
rev-content auth
rev-content doctor --json
rev-content doctor --json --offline
rev-content run 'https://example.com/media'
```

`auth` opens a visible browser. Complete Google authentication yourself; do
not put credentials in config or chat.

`doctor --offline` checks tools, registrations, installed provenance, writable
runtime directories, and `get_health` without calling the live `check_auth`
tool. Its authentication result is the conservative status reported by
`get_health`; plain `doctor` continues to perform the bounded live check.

`setup` accepts `auto`, `codex`, `claude`, or `both`. Registration uses the
official client CLIs. Every existing registration is compared by its actual
command, arguments, and environment before any mutation. A mismatch is a
conflict and is never overwritten.

## Commands

```text
rev-content setup [--client auto|codex|claude|both] [--dry-run]
rev-content auth
rev-content doctor --json
rev-content run URL
rev-content status [JOB]
rev-content resume JOB
rev-content upgrade --check                 # metadata only; never updates
rev-content uninstall [--purge --yes]
rev-content service install|remove|status   # Linux only
```

`run URL` uses the existing durable engine: SQLite WAL, leases, effect
journaling, persisted backoff, exact source reconciliation, and export
receipts. Interrupting the process does not erase the job. Use `status` and
`resume` to continue it.

Readiness polling persists its backoff position, poll count, and start time.
It stops at `readiness.maxAttempts` or `readiness.maxElapsedSeconds` with
`NEEDS_ATTENTION`; it never polls forever or repeats an upload merely because
processing is slow. Every MCP exchange also has a hard process deadline and
bounded diagnostics.

NotebookLM source readiness is not proof of a complete transcript. A workflow
whose export cannot be independently verified ends with a caveat rather than a
false completeness claim.

## User-local data

Config, state, dependency builds, audio, browser profiles, and transcripts use
XDG directories on Linux and Application Support on macOS. `uninstall` first
stops a receipt-owned Linux timer, removes exact receipt-owned Codex/Claude MCP
registrations, then removes the launcher and current pointer while preserving
user state. Modified or unowned registrations and units fail closed.
`--purge --yes` is the only command that removes preserved config,
profiles, databases, audio, transcripts, and installed releases. Back up
anything needed before using it.

`upgrade --check` displays the installed receipt and bundled upstream lock.
It performs no remote lookup and does not claim an update is available.
Updating means running `install.sh` from
a verified release; the installer builds a verified stage and atomically
replaces the installed release.

No launchd job is installed or resumed. Linux systemd user templates are
optional and are not enabled automatically. `service remove` disables and
stops `rev-content.timer` before deleting receipt-owned units.

## Provenance and releases

[`upstream.lock.json`](upstream.lock.json) records source URLs, full commit
pins, lockfile hashes, applicable patch contracts, tool schema sources, and
licenses. RevMagic's contract is explicitly patchless and points to its public
runtime repository.
[`distribution-manifest.json`](distribution-manifest.json) is the release
allowlist and data policy.

Release creation emits a source manifest, CycloneDX SBOM, and a checksum whose
record contains only the archive basename. When the repository has a `HEAD`,
every allowlisted byte must match that commit. Before the first commit, the
same byte hashes are fixed in `source-manifest.json`.

```sh
npm ci
npm run check
npm run release:verify
npm run sbom -- release/rev-content-workflow.cdx.json
npm run release:archive
```

For the full local `file://` source/build contract:

```sh
REV_CONTENT_TEST_NOTEBOOK_REPO=/path/to/notebook-fork \
REV_CONTENT_TEST_REVMAGIC_REPO=/path/to/revmagic-runtime \
./scripts/test-fixture-install.sh
```

The workflow, NotebookLM modifications, and unmodified public RevMagic runtime
are MIT licensed. See `LICENSE` and `LICENSES/`.

The Ubuntu external gate is `.github/workflows/linux-external-gate.yml`. It is
required before a Linux release and covers clean fixture setup, restart
persistence, and the systemd lifecycle contract. It was not executed on this
macOS workstation.
