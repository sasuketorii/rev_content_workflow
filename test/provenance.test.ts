import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const runVerifier = (metadata: unknown) => new Promise<void>((resolvePromise, rejectPromise) => {
  const child = spawn(process.execPath, [resolve("scripts/verify-revmagic-workspace.mjs")],
    { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.on("error", rejectPromise);
  child.on("close", (code) => {
    if (code === 0) resolvePromise();
    else rejectPromise(new Error(stderr || `workspace verifier exited ${code}`));
  });
  child.stdin.end(JSON.stringify(metadata));
});
const packages = [
  { id: "core 0.2.7 (path+file:///core)", name: "revmagic-core" },
  { id: "cli 0.2.7 (path+file:///cli)", name: "revmagic-cli" },
  { id: "mcp 0.2.7 (path+file:///mcp)", name: "revmagic-mcp" }
];
const [core, cli, mcp] = packages as [
  (typeof packages)[number],
  (typeof packages)[number],
  (typeof packages)[number]
];

test("public patchless RevMagic provenance contains no retired source markers", async () => {
  const result = await promisify(execFile)(
    process.execPath, [resolve("scripts/test-public-provenance.mjs")]
  );
  assert.match(result.stdout, /public patchless RevMagic provenance contract passed/);
});

test("RevMagic workspace verifier accepts the exact three packages in any order", async () => {
  await runVerifier({
    workspace_members: [mcp.id, core.id, cli.id],
    packages
  });
});

test("RevMagic workspace verifier rejects extra, duplicate, and malformed members", async () => {
  const invalid = [
    {
      workspace_members: [...packages.map(({ id }) => id), "extra 1.0.0 (path+file:///extra)"],
      packages: [...packages, { id: "extra 1.0.0 (path+file:///extra)", name: "extra" }]
    },
    { workspace_members: [core.id, core.id, mcp.id], packages },
    { workspace_members: packages.map(({ id }) => id), packages: packages.slice(0, 2) },
    { workspace_members: "not-an-array", packages }
  ];
  for (const metadata of invalid) {
    await assert.rejects(runVerifier(metadata));
  }
});
