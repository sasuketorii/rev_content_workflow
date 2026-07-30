#!/usr/bin/env node
/* global process */
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

const statePath = process.env.FAKE_CLIENT_STATE;
if (!statePath) process.exit(2);
let state;
try { state = JSON.parse(await readFile(statePath, "utf8")); } catch { state = { names: {}, adds: 0 }; }
const args = process.argv.slice(2);
const client = basename(process.argv[1]);
if (args[0] !== "mcp") process.exit(2);
if (args[1] === "get") {
  const spec = state.names[`${client}:${args[2]}`];
  if (!spec) process.exit(1);
  process.stdout.write(`${JSON.stringify({
    ...spec,
    ...(client === "claude" ? { scope: "user" } : {})
  })}\n`);
  process.exit(0);
}
if (args[1] === "add") {
  const separator = args.indexOf("--");
  const before = separator >= 0 ? args.slice(2, separator) : args.slice(2);
  const name = before.filter((value, index) =>
    value !== "--scope" && before[index - 1] !== "--scope" &&
    value !== "--transport" && before[index - 1] !== "--transport" &&
    value !== "--env" && before[index - 1] !== "--env").at(-1);
  if (!name) process.exit(2);
  if (process.env.FAKE_CLIENT_FAIL_NAME === name) process.exit(1);
  const env = {};
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] === "--env" && typeof before[index + 1] === "string") {
      const [key, ...parts] = before[index + 1].split("=");
      env[key] = parts.join("=");
    }
  }
  state.names[`${client}:${name}`] = {
    command: args[separator + 1],
    args: args.slice(separator + 2),
    env
  };
  state.adds += 1;
  await writeFile(statePath, JSON.stringify(state));
  process.exit(0);
}
if (args[1] === "remove") {
  if (process.env.FAKE_CLIENT_FAIL_REMOVE === "1") process.exit(1);
  delete state.names[`${client}:${args.at(-1)}`];
  await writeFile(statePath, JSON.stringify(state));
  process.exit(0);
}
process.exit(2);
