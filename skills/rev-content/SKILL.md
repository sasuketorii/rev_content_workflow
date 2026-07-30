---
name: rev-content
description: Install, authenticate, diagnose, and run the durable RevMagic-to-NotebookLM transcription workflow from this repository. Use when a user gives Codex or Claude Code this repo and asks to set it up, process a media URL, resume a job, inspect status, upgrade, or troubleshoot installation, client MCP registration, browser authentication, or persisted workflow state.
---

# Rev Content

Work from the repository root. Preserve PDFs, `.runtime`, `config.local.json`,
audio, transcripts, browser profiles, and credentials. Never commit or package
those files.

## Set up

1. Read `README.md` or `README.ja.md`, `upstream.lock.json`, and
   `distribution-manifest.json`.
2. Run `./install.sh --dry-run`.
3. Resolve only reported prerequisites. Do not start launchd or background jobs
   on macOS.
4. Run `./install.sh`.
5. Run `rev-content setup --client auto`. Use `both` only when both Codex and
   Claude Code must be registered. Treat any existing registration whose
   command, args, or env do not exactly match as a conflict; do not overwrite it.
6. Ask the user to complete the visible browser login, then run
   `rev-content auth`. Authentication is the only interactive step.
7. Run `rev-content doctor --json`. Do not claim readiness unless `"ok": true`.

## Run

Run `rev-content run URL`. The command persists state before side effects and
resumes through SQLite. Report the terminal job state and transcript receipt.
Do not equate NotebookLM source readiness with transcript completeness.

Use `rev-content status [JOB]` to inspect work and `rev-content resume JOB` to
advance a stopped job. Do not delete or recreate the database to fix a job.

## Troubleshoot

- Run `rev-content doctor --json` first.
- If auth is missing, run `rev-content auth` in the logged-in desktop session.
- If setup reports an MCP conflict, inspect the existing client registration.
  Remove or rename it only with explicit user approval, then rerun setup.
- If a job is `NEEDS_ATTENTION`, inspect `rev-content status JOB`; never
  blindly repeat an ambiguous NotebookLM upload or export.
- Use `rev-content upgrade --check` to show pinned provenance metadata. It
  never installs an update. Reinstall only from a verified release or this repository.
- `rev-content uninstall` removes exact receipt-owned Codex/Claude MCP
  registrations and a receipt-owned Linux timer, then the launcher/current
  pointer, while preserving user state. It fails closed on drift. Use
  `--purge --yes` only after explicit approval to
  delete config, profile, DB, audio, transcripts, and installed releases.
- On Linux only, `rev-content service install` creates user systemd templates.
  It does not enable them automatically. `service remove` disables/stops the
  timer before deleting receipt-owned units.
