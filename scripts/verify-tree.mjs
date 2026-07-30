#!/usr/bin/env node
/* global console, process */
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("usage: verify-tree.mjs DIRECTORY");
const failures = [];
const forbiddenPath = /(^|\/)(\.DS_Store|\.runtime|node_modules|dist|config\.local(?:\.json)?|cookies?(?:\.json)?|chrome-profile|browser-profile|profiles?)(\/|$)|\.(?:pdf|sqlite3?|sqlite-(?:shm|wal)|db|db-(?:shm|wal)|duckdb|mp3|mp4|m4a|wav|flac|aac|ogg|opus|webm|mov|avi|mkv)$/i;
const absolutePath = /(?:^|[\s"'=(])(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|\/root(?:\/|\s)|[A-Za-z]:\\Users\\[^\\\s]+|\\\\[^\\\s]+\\[^\\\s]+)/m;
const secretPatterns = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /\b(?:sk|sk-proj)-[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bASIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/
];

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
    else failures.push(`non-regular release entry: ${relative(root, path)}`);
  }
  return files;
}

for (const path of await walk(root)) {
  const name = relative(root, path).split(sep).join("/");
  if (forbiddenPath.test(name)) failures.push(`forbidden release path: ${name}`);
  const buffer = await readFile(path);
  if (buffer.includes(0)) continue;
  const text = buffer.toString("utf8");
  if (absolutePath.test(text)) failures.push(`absolute workstation path in ${name}`);
  if (secretPatterns.some((pattern) => pattern.test(text))) failures.push(`secret-like value in ${name}`);
}
try {
  execFileSync("gitleaks", ["dir", "--no-banner", "--redact", "--exit-code", "1", root],
    { stdio: ["ignore", "ignore", "pipe"] });
} catch (error) {
  if ((error && typeof error === "object" && "code" in error &&
      (error.code === "ENOENT" || error.code === 127))) {
    failures.push("gitleaks is required for release verification");
  } else {
    failures.push("gitleaks detected a secret");
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`verified ${root}`);
