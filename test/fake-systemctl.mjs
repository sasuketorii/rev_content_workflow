#!/usr/bin/env node
/* global process */
import { appendFile } from "node:fs/promises";

const log = process.env.FAKE_SYSTEMCTL_LOG;
if (!log) process.exit(2);
const args = process.argv.slice(2);
await appendFile(log, `${JSON.stringify(args)}\n`);
if (args.includes("show") && args.some((arg) => arg.includes("LoadState"))) {
  process.stdout.write("loaded\n");
}
if (process.env.FAKE_SYSTEMCTL_FAIL_DISABLE === "1" && args.includes("disable")) {
  process.stderr.write("injected disable failure\n");
  process.exit(1);
}
