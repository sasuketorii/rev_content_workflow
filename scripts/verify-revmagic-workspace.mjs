#!/usr/bin/env node
/* global process */

const expected = ["revmagic-cli", "revmagic-core", "revmagic-mcp"];
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const metadata = JSON.parse(input);
if (!Array.isArray(metadata.workspace_members) || !Array.isArray(metadata.packages) ||
    metadata.workspace_members.length !== expected.length ||
    new Set(metadata.workspace_members).size !== expected.length) {
  throw new Error("RevMagic workspace must contain exactly three unique members");
}
const names = metadata.workspace_members.map((id) => {
  if (typeof id !== "string") throw new Error("RevMagic workspace member id must be a string");
  const matches = metadata.packages.filter((entry) => entry?.id === id);
  if (matches.length !== 1 || typeof matches[0].name !== "string") {
    throw new Error(`RevMagic workspace member is missing or ambiguous: ${id}`);
  }
  return matches[0].name;
});
if (new Set(names).size !== expected.length ||
    JSON.stringify(names.slice().sort()) !== JSON.stringify(expected)) {
  throw new Error(`unexpected RevMagic workspace packages: ${names.join(",")}`);
}
