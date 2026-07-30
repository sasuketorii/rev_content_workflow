#!/usr/bin/env node
import {
  authenticate, doctor, resume, runOnce, runUrl, service, setup, status, uninstall, upgradeCheck
} from "./distribution.js";

function usage(): never {
  console.error(`usage: rev-content COMMAND
  setup [--client auto|codex|claude|both] [--dry-run]
  auth
  doctor [--json]
  run URL
  status [JOB]
  resume JOB
  upgrade --check
  uninstall [--purge --yes]
  service install|remove|status
  worker --once`);
  process.exit(2);
}

const args = process.argv.slice(2);
const command = args.shift();
if (!command) usage();

try {
  let result: unknown;
  if (command === "setup") {
    const clientIndex = args.indexOf("--client");
    const client = clientIndex >= 0 ? args[clientIndex + 1] : "auto";
    if (!["auto", "codex", "claude", "both"].includes(client ?? "")) usage();
    result = await setup(client as "auto" | "codex" | "claude" | "both", args.includes("--dry-run"));
  } else if (command === "auth") {
    result = await authenticate();
  } else if (command === "doctor") {
    result = await doctor();
    if (!(result as { ok: boolean }).ok) process.exitCode = 1;
  } else if (command === "run") {
    if (!args[0]) usage();
    result = await runUrl(args[0]);
  } else if (command === "status") {
    result = await status(args[0]);
  } else if (command === "resume") {
    if (!args[0]) usage();
    result = await resume(args[0]);
  } else if (command === "upgrade" && args[0] === "--check") {
    result = await upgradeCheck();
  } else if (command === "uninstall") {
    result = await uninstall({ purge: args.includes("--purge"), yes: args.includes("--yes") });
  } else if (command === "service") {
    if (!args[0]) usage();
    result = await service(args[0]);
  } else if (command === "worker" && args[0] === "--once") {
    result = await runOnce();
  } else usage();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
