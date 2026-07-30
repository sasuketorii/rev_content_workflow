import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { doctor, runUrl, service, setup, uninstall, writeDefaultConfig } from "../src/distribution.js";
import type { RuntimePaths } from "../src/paths.js";
import { McpClient } from "../src/mcp.js";
import { parseRegistration } from "../src/registrations.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rev-content-distribution-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const installRelease = join(root, "data", "rev-content", "releases", "0.1.0");
  await mkdir(bin, { recursive: true });
  await mkdir(join(installRelease, "deps", "notebooklm", "dist"), { recursive: true });
  await mkdir(join(installRelease, "deps", "revmagic", "bin"), { recursive: true });
  const fake = join(bin, "fake-client.mjs");
  await writeFile(fake, await readFile("test/fake-client.mjs"));
  await chmod(fake, 0o755);
  await symlink(fake, join(bin, "codex"));
  await symlink(fake, join(bin, "claude"));
  const statePath = join(root, "clients.json");
  await writeFile(statePath, JSON.stringify({ names: {}, adds: 0 }));
  const paths: RuntimePaths = {
    home,
    configDir: join(root, "config", "rev-content"),
    stateDir: join(root, "state", "rev-content"),
    dataDir: join(root, "data", "rev-content"),
    configFile: join(root, "config", "rev-content", "config.json"),
    database: join(root, "state", "rev-content", "jobs.sqlite"),
    transcriptDir: join(root, "data", "rev-content", "transcripts"),
    audioDir: join(root, "data", "rev-content", "audio"),
    profileDir: join(root, "state", "rev-content", "notebooklm-profile"),
    registrationFile: join(root, "state", "rev-content", "mcp-registrations.json"),
    installReceipt: join(root, "data", "rev-content", "install-receipt.json"),
    binPath: join(bin, "rev-content"),
    installRelease,
    notebookEntry: join(installRelease, "deps", "notebooklm", "dist", "index.js"),
    revmagicMcp: join(installRelease, "deps", "revmagic", "bin", "revmagic-mcp")
  };
  await writeFile(paths.binPath, "owned launcher");
  const launcherSha256 = createHash("sha256").update("owned launcher").digest("hex");
  await writeFile(join(installRelease, "release-manifest.json"), "{\"formatVersion\":1,\"files\":[]}\n");
  const releaseManifestSha256 = createHash("sha256")
    .update("{\"formatVersion\":1,\"files\":[]}\n").digest("hex");
  await writeFile(join(installRelease, "release-manifest.sha256"),
    `${releaseManifestSha256}  release-manifest.json\n`);
  await symlink("releases/0.1.0", join(paths.dataDir, "current"));
  await mkdir(join(installRelease, "packaging", "systemd"), { recursive: true });
  for (const name of ["rev-content.service", "rev-content.timer"]) {
    await writeFile(
      join(installRelease, "packaging", "systemd", `${name}.in`),
      await readFile(join("packaging", "systemd", `${name}.in`))
    );
  }
  await writeFile(paths.installReceipt, `${JSON.stringify({
    formatVersion: 1,
    installRoot: paths.dataDir,
    binPath: paths.binPath,
    launcherSha256,
    releaseDir: installRelease,
    releaseManifestSha256,
    registrations: {}
  })}\n`);
  return { root, bin, statePath, paths };
}

test("default config keeps credentials and artifacts in user-local runtime directories", async () => {
  const { paths } = await fixture();
  const config = await writeDefaultConfig(paths);
  assert.equal(config.database, paths.database);
  assert.equal(config.notebooklm.exportDirectory, paths.transcriptDir);
  assert.equal(config.notebooklm.env?.NOTEBOOKLM_PROFILE_DIR, paths.profileDir);
  assert.equal(config.notebooklm.env?.NOTEBOOKLM_AUDIO_ROOTS, paths.audioDir);
  const mode = (await import("node:fs/promises")).stat(paths.configFile).then((value) => value.mode & 0o777);
  assert.equal(await mode, 0o600);
});

test("doctor rejects a current pointer that drifts from the receipt release", async () => {
  const { paths } = await fixture();
  const current = join(paths.dataDir, "current");
  const other = join(paths.dataDir, "releases", "other");
  await mkdir(other, { recursive: true });
  await unlink(current);
  await symlink("releases/other", current);
  const result = await doctor(paths);
  assert.equal(result.ok, false);
  assert.equal(result.install_provenance, false);
  assert.match(String(result.install_error), /current install pointer/);
  assert.equal(await readFile(paths.binPath, "utf8"), "owned launcher");
});

test("Claude 2.1.220 text registration accepts only User config scope", () => {
  const output = [
    "rev-content-notebooklm:",
    "  Scope: User config (available in all your projects)",
    "  Status: ✓ Connected",
    "  Type: stdio",
    "  Command: /bin/echo",
    "  Args:",
    "  Environment:"
  ].join("\n");
  assert.deepEqual(parseRegistration("claude", output), {
    command: "/bin/echo",
    args: [],
    env: {}
  });
  for (const scope of [
    "Local config (private to you in this project)",
    "Project config (shared via .mcp.json)",
    "user config (available in all your projects)"
  ]) {
    assert.throws(
      () => parseRegistration("claude", output.replace(
        "User config (available in all your projects)", scope
      )),
      /scope is not user config/
    );
  }
});

test("setup registers both clients once and reinstall is idempotent", async () => {
  const { bin, statePath, paths } = await fixture();
  const previousPath = process.env.PATH;
  const previousState = process.env.FAKE_CLIENT_STATE;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.FAKE_CLIENT_STATE = statePath;
  try {
    await setup("both", false, paths);
    await setup("both", false, paths);
    const state = JSON.parse(await readFile(statePath, "utf8")) as { adds: number };
    assert.equal(state.adds, 4);
  } finally {
    process.env.PATH = previousPath;
    if (previousState === undefined) delete process.env.FAKE_CLIENT_STATE;
    else process.env.FAKE_CLIENT_STATE = previousState;
  }
});

test("setup fails closed on an existing registration without a receipt", async () => {
  const { bin, statePath, paths } = await fixture();
  await writeFile(statePath, JSON.stringify({
    names: { "codex:rev-content-notebooklm": { command: "/wrong", args: [], env: {} } }, adds: 0
  }));
  const previousPath = process.env.PATH;
  const previousState = process.env.FAKE_CLIENT_STATE;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.FAKE_CLIENT_STATE = statePath;
  try {
    await assert.rejects(setup("codex", false, paths), /conflicts with the required command/);
  } finally {
    process.env.PATH = previousPath;
    if (previousState === undefined) delete process.env.FAKE_CLIENT_STATE;
    else process.env.FAKE_CLIENT_STATE = previousState;
  }
});

test("setup rolls back registrations added before a later client failure", async () => {
  const { bin, statePath, paths } = await fixture();
  const previousPath = process.env.PATH;
  const previousState = process.env.FAKE_CLIENT_STATE;
  const previousFailure = process.env.FAKE_CLIENT_FAIL_NAME;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.FAKE_CLIENT_STATE = statePath;
  process.env.FAKE_CLIENT_FAIL_NAME = "revmagic";
  await mkdir(paths.configDir, { recursive: true });
  await writeFile(paths.configFile, "original-config");
  try {
    await assert.rejects(setup("codex", false, paths));
    const state = JSON.parse(await readFile(statePath, "utf8")) as { names: Record<string, unknown> };
    assert.deepEqual(state.names, {});
    const receipt = JSON.parse(await readFile(paths.installReceipt, "utf8")) as {
      registrations: Record<string, unknown>;
    };
    assert.deepEqual(receipt.registrations, {});
    assert.equal(await readFile(paths.configFile, "utf8"), "original-config");
  } finally {
    process.env.PATH = previousPath;
    if (previousState === undefined) delete process.env.FAKE_CLIENT_STATE;
    else process.env.FAKE_CLIENT_STATE = previousState;
    if (previousFailure === undefined) delete process.env.FAKE_CLIENT_FAIL_NAME;
    else process.env.FAKE_CLIENT_FAIL_NAME = previousFailure;
  }
});

test("setup detects a modified existing registration before changing config", async () => {
  const { bin, statePath, paths } = await fixture();
  const previousPath = process.env.PATH;
  const previousState = process.env.FAKE_CLIENT_STATE;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.FAKE_CLIENT_STATE = statePath;
  try {
    await setup("codex", false, paths);
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      names: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    state.names["codex:revmagic"]!.command = "/tampered";
    await writeFile(statePath, JSON.stringify(state));
    await writeFile(paths.configFile, "sentinel-config");
    await assert.rejects(setup("codex", false, paths), /conflicts/);
    assert.equal(await readFile(paths.configFile, "utf8"), "sentinel-config");
  } finally {
    process.env.PATH = previousPath;
    if (previousState === undefined) delete process.env.FAKE_CLIENT_STATE;
    else process.env.FAKE_CLIENT_STATE = previousState;
  }
});

test("setup reports rollback failures instead of swallowing them", async () => {
  const { bin, statePath, paths } = await fixture();
  const saved = {
    path: process.env.PATH,
    state: process.env.FAKE_CLIENT_STATE,
    failure: process.env.FAKE_CLIENT_FAIL_NAME,
    remove: process.env.FAKE_CLIENT_FAIL_REMOVE
  };
  process.env.PATH = `${bin}:${saved.path ?? ""}`;
  process.env.FAKE_CLIENT_STATE = statePath;
  process.env.FAKE_CLIENT_FAIL_NAME = "revmagic";
  process.env.FAKE_CLIENT_FAIL_REMOVE = "1";
  try {
    await assert.rejects(setup("codex", false, paths), /rollback failures: remove codex:rev-content-notebooklm/);
  } finally {
    process.env.PATH = saved.path;
    for (const [key, value] of [
      ["FAKE_CLIENT_STATE", saved.state],
      ["FAKE_CLIENT_FAIL_NAME", saved.failure],
      ["FAKE_CLIENT_FAIL_REMOVE", saved.remove]
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("uninstall removes canonical launcher/current pointer and preserves config and state", async () => {
  const { paths } = await fixture();
  const launcher = paths.binPath;
  const current = join(paths.dataDir, "current");
  await mkdir(paths.stateDir, { recursive: true });
  await mkdir(paths.configDir, { recursive: true });
  const result = await uninstall({ purge: false, yes: false }, paths);
  assert.ok(result.preserved.includes(paths.stateDir));
  assert.ok(result.preserved.includes(paths.configDir));
  await assert.rejects(readFile(launcher));
  await assert.rejects(readFile(current));
});

test("run rejects unauthenticated NotebookLM before DB creation or RevMagic extraction", async () => {
  const { root, paths } = await fixture();
  const statePath = join(root, "preflight-state.json");
  await writeFile(statePath, JSON.stringify({ authenticated: false, calls: {} }));
  const fake = join(process.cwd(), "test", "preflight-mcp.mjs");
  const processConfig = (role: string) => ({
    command: process.execPath,
    args: [fake],
    env: { FAKE_PREFLIGHT_STATE: statePath, FAKE_PREFLIGHT_ROLE: role }
  });
  await mkdir(paths.configDir, { recursive: true });
  await writeFile(paths.configFile, JSON.stringify({
    database: paths.database,
    leaseSeconds: 60,
    backoffSeconds: [1],
    readiness: { maxAttempts: 3, maxElapsedSeconds: 3600 },
    revmagic: { ...processConfig("rev"), extractTool: "url_to_mp3", outputDirectory: paths.audioDir },
    notebooklm: {
      ...processConfig("note"),
      createTool: "create_notebook", searchTool: "search_notebooks", getTool: "get_notebook",
      addTool: "add_audio_source", waitTool: "wait_for_source_ready", exportTool: "export_transcript",
      exportDirectory: paths.transcriptDir
    }
  }));
  await assert.rejects(runUrl("https://example.test/media", paths), /authentication preflight failed/);
  const state = JSON.parse(await readFile(statePath, "utf8")) as { calls: Record<string, number> };
  assert.equal(state.calls.url_to_mp3 ?? 0, 0);
  await assert.rejects(readFile(paths.database));
});

test("MCP hard deadline kills and reaps a silent process group", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "rev-content-silent-mcp-"));
  const pidFile = join(root, "pids");
  const client = new McpClient({
    command: process.execPath,
    args: [join(process.cwd(), "test", "silent-mcp.mjs")],
    env: { SILENT_MCP_PID_FILE: pidFile },
    timeoutMs: 150,
    stderrMaxBytes: 1024
  });
  const started = Date.now();
  await assert.rejects(client.listTools(), /hard deadline exceeded/);
  assert.ok(Date.now() - started < 2_000);
  const pids = (await readFile(pidFile, "utf8")).trim().split("\n").map(Number);
  assert.equal(pids.length, 2);
  for (const pid of pids) {
    assert.throws(() => process.kill(pid, 0), (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ESRCH");
  }
});

test("uninstall ignores REV_CONTENT_BIN and cannot delete an arbitrary file", async () => {
  const { root, paths } = await fixture();
  const victim = join(root, "victim.txt");
  await writeFile(victim, "keep");
  const previous = process.env.REV_CONTENT_BIN;
  process.env.REV_CONTENT_BIN = victim;
  try {
    await uninstall({ purge: false, yes: false }, paths);
    assert.equal(await readFile(victim, "utf8"), "keep");
  } finally {
    if (previous === undefined) delete process.env.REV_CONTENT_BIN;
    else process.env.REV_CONTENT_BIN = previous;
  }
});

test("purge requires explicit --yes confirmation", async () => {
  const { paths } = await fixture();
  await assert.rejects(uninstall({ purge: true, yes: false }, paths), /requires --yes/);
});

test("uninstall refuses a managed registration that was modified", async () => {
  const { bin, statePath, paths } = await fixture();
  const previousPath = process.env.PATH;
  const previousState = process.env.FAKE_CLIENT_STATE;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.FAKE_CLIENT_STATE = statePath;
  try {
    await setup("codex", false, paths);
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      names: Record<string, { command: string }>;
    };
    state.names["codex:revmagic"]!.command = "/modified";
    await writeFile(statePath, JSON.stringify(state));
    await assert.rejects(uninstall({ purge: false, yes: false }, paths), /managed registration changed/);
    assert.equal(await readFile(paths.binPath, "utf8"), "owned launcher");
  } finally {
    process.env.PATH = previousPath;
    if (previousState === undefined) delete process.env.FAKE_CLIENT_STATE;
    else process.env.FAKE_CLIENT_STATE = previousState;
  }
});

test("systemd removal disables the timer before deleting units and fails closed", async () => {
  const { root, bin, paths } = await fixture();
  const systemctl = join(bin, "systemctl");
  await writeFile(systemctl, await readFile("test/fake-systemctl.mjs"));
  await chmod(systemctl, 0o755);
  const log = join(root, "systemctl.log");
  const saved = {
    path: process.env.PATH,
    log: process.env.FAKE_SYSTEMCTL_LOG,
    fail: process.env.FAKE_SYSTEMCTL_FAIL_DISABLE
  };
  process.env.PATH = `${bin}:${saved.path ?? ""}`;
  process.env.FAKE_SYSTEMCTL_LOG = log;
  try {
    await service("install", paths, "linux");
    const unitDir = join(paths.home, ".config", "systemd", "user");
    const servicePath = join(unitDir, "rev-content.service");
    const timerPath = join(unitDir, "rev-content.timer");
    await service("remove", paths, "linux");
    await assert.rejects(readFile(servicePath));
    await assert.rejects(readFile(timerPath));
    await service("remove", paths, "linux");
    const calls = (await readFile(log, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls.slice(1, 3), [
      ["--user", "disable", "--now", "rev-content.timer"],
      ["--user", "daemon-reload"]
    ]);
    assert.ok(!calls.some((args) => args.includes("enable") || args.includes("start") || args.includes("restart")));

    await service("install", paths, "linux");
    process.env.FAKE_SYSTEMCTL_FAIL_DISABLE = "1";
    await assert.rejects(service("remove", paths, "linux"), /injected disable failure/);
    assert.match(await readFile(servicePath, "utf8"), /rev-content/);
    assert.match(await readFile(timerPath, "utf8"), /OnUnitActiveSec/);
  } finally {
    process.env.PATH = saved.path;
    if (saved.log === undefined) delete process.env.FAKE_SYSTEMCTL_LOG;
    else process.env.FAKE_SYSTEMCTL_LOG = saved.log;
    if (saved.fail === undefined) delete process.env.FAKE_SYSTEMCTL_FAIL_DISABLE;
    else process.env.FAKE_SYSTEMCTL_FAIL_DISABLE = saved.fail;
  }
});
