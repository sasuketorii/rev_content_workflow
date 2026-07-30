#!/usr/bin/env node
/* global console, process */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const [command, suppliedRoot] = process.argv.slice(2);
if (!["generate", "verify"].includes(command ?? "") || !suppliedRoot) {
  console.error("usage: hash-tree.mjs generate|verify DIRECTORY");
  process.exit(2);
}
const root = resolve(suppliedRoot);
const manifestPath = join(root, "release-manifest.json");
const checksumPath = join(root, "release-manifest.sha256");

async function filesBelow(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      if (target.startsWith("/") || !resolve(dirname(path), target).startsWith(`${root}${sep}`)) {
        throw new Error(`release symlink escapes root: ${path}`);
      }
      output.push({ path, target });
    } else if (entry.isDirectory()) output.push(...await filesBelow(path));
    else if (entry.isFile() && !["release-manifest.json", "release-manifest.sha256"].includes(entry.name)) {
      output.push({ path });
    }
  }
  return output;
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function snapshot() {
  const entries = (await filesBelow(root)).sort((a, b) => a.path.localeCompare(b.path));
  return Promise.all(entries.map(async (entry) => {
    const stat = await lstat(entry.path);
    const normalized = relative(root, entry.path).split(sep).join("/");
    return {
      path: normalized,
      sha256: entry.target
        ? createHash("sha256").update(entry.target).digest("hex") : await digest(entry.path),
      size: stat.size,
      mode: stat.mode & 0o777,
      ...(entry.target ? { type: "symlink", target: entry.target } : { type: "file" })
    };
  }));
}

if (command === "generate") {
  const manifest = { formatVersion: 1, files: await snapshot() };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  const checksum = await digest(manifestPath);
  await writeFile(checksumPath, `${checksum}  release-manifest.json\n`, { mode: 0o644 });
  console.log(checksum);
} else {
  const checksumLine = await readFile(checksumPath, "utf8");
  const match = checksumLine.match(/^([a-f0-9]{64}) {2}release-manifest\.json\n$/);
  if (!match) throw new Error("release manifest checksum must use a basename-only record");
  if (await digest(manifestPath) !== match[1]) throw new Error("release manifest checksum mismatch");
  const expected = JSON.parse(await readFile(manifestPath, "utf8"));
  const actual = await snapshot();
  if (JSON.stringify(actual) !== JSON.stringify(expected.files)) {
    throw new Error("release tree differs from its manifest");
  }
  console.log(match[1]);
}
