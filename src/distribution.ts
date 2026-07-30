import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_BACKOFF_SECONDS, DEFAULT_READINESS, loadConfig } from "./config.js";
import { Engine } from "./engine.js";
import { McpClient } from "./mcp.js";
import { runtimePaths, type RuntimePaths } from "./paths.js";
import { Store } from "./store.js";
import type { Config, Job } from "./types.js";
import {
  addRegistration, getRegistration, removeRegistration, sameSpec,
  type Client, type McpSpec
} from "./registrations.js";

const execFileAsync = promisify(execFile);
const terminal = new Set(["COMPLETED", "COMPLETED_WITH_CAVEAT", "NOOP_VERIFIED", "NEEDS_ATTENTION", "FAILED"]);
interface ManagedRegistration {
  client: Client;
  name: string;
  spec: McpSpec;
}
interface InstallReceipt {
  formatVersion: 1;
  installRoot: string;
  binPath: string;
  launcherSha256: string;
  releaseDir: string;
  releaseManifestSha256: string;
  registrations: Record<string, ManagedRegistration>;
  service?: {
    unitDir: string;
    servicePath: string;
    timerPath: string;
    serviceSha256: string;
    timerSha256: string;
  };
}

export async function writeDefaultConfig(paths = runtimePaths()): Promise<Config> {
  await Promise.all([
    mkdir(paths.configDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.stateDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.transcriptDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.audioDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.profileDir, { recursive: true, mode: 0o700 })
  ]);
  const config: Config = {
    database: paths.database,
    leaseSeconds: 60,
    backoffSeconds: [...DEFAULT_BACKOFF_SECONDS],
    readiness: { ...DEFAULT_READINESS },
    revmagic: {
      command: paths.revmagicMcp, args: [], timeoutMs: 1800000, stderrMaxBytes: 65536,
      extractTool: "url_to_mp3",
      outputDirectory: paths.audioDir, optimize: true
    },
    notebooklm: {
      command: process.execPath,
      args: [paths.notebookEntry],
      timeoutMs: 1200000,
      stderrMaxBytes: 65536,
      env: {
        NOTEBOOK_PROFILE_STRATEGY: "persistent",
        NOTEBOOKLM_PROFILE_DIR: paths.profileDir,
        NOTEBOOKLM_AUDIO_ROOTS: paths.audioDir,
        NOTEBOOKLM_EXPORT_DIR: paths.transcriptDir
      },
      createTool: "create_notebook",
      searchTool: "search_notebooks",
      getTool: "get_notebook",
      addTool: "add_audio_source",
      waitTool: "wait_for_source_ready",
      exportTool: "export_transcript",
      exportDirectory: paths.transcriptDir
    }
  };
  await atomicJson(paths.configFile, config, 0o600);
  return config;
}

export async function setup(
  selection: "auto" | "codex" | "claude" | "both",
  dryRun: boolean,
  paths = runtimePaths()
): Promise<{ clients: Client[]; dryRun: boolean }> {
  const clients = await selectClients(selection);
  const receipt = await loadInstallReceipt(paths);
  const config = defaultConfigFor(paths);
  const wrappers = wrapperBundle(paths, config);
  const desired = clients.flatMap((client) => [
    { client, name: "rev-content-notebooklm", spec: { command: wrappers.notebook.path, args: [], env: {} } },
    { client, name: "revmagic", spec: { command: wrappers.revmagic.path, args: [], env: {} } }
  ]);
  const missing: ManagedRegistration[] = [];
  for (const item of desired) {
    if (!(await commandExists(item.client))) throw new Error(`${item.client} CLI is not available`);
    const actual = await getRegistration(item.client, item.name);
    if (actual && !sameSpec(actual, item.spec)) {
      throw new Error(`${item.client} MCP ${item.name} conflicts with the required command/args/env`);
    }
    if (!actual) missing.push(item);
  }
  if (dryRun) return { clients, dryRun };
  const managedFiles = [paths.configFile, wrappers.notebook.path, wrappers.revmagic.path, paths.installReceipt];
  const before = await snapshotFiles(managedFiles);
  const added: ManagedRegistration[] = [];
  try {
    await writeConfigBundle(paths, config, wrappers);
    for (const item of missing) {
      await addRegistration(item.client, item.name, item.spec);
      added.push(item);
    }
    for (const item of desired) {
      const actual = await getRegistration(item.client, item.name);
      if (!sameSpec(actual, item.spec)) {
        throw new Error(`${item.client} MCP ${item.name} failed read-back verification`);
      }
      receipt.registrations[`${item.client}:${item.name}`] = item;
    }
    await atomicJson(paths.installReceipt, receipt, 0o600);
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const entry of added.reverse()) {
      try { await removeRegistration(entry.client, entry.name); }
      catch (rollbackError) { rollbackErrors.push(`remove ${entry.client}:${entry.name}: ${errorText(rollbackError)}`); }
    }
    try { await restoreFiles(before); }
    catch (rollbackError) { rollbackErrors.push(`restore config: ${errorText(rollbackError)}`); }
    if (rollbackErrors.length) {
      throw new Error(`${errorText(error)}; rollback failures: ${rollbackErrors.join("; ")}`, { cause: error });
    }
    throw error;
  }
  return { clients, dryRun };
}

export async function authenticate(paths = runtimePaths()): Promise<unknown> {
  const config = await loadConfig(paths.configFile);
  return new McpClient(config.notebooklm).call("setup_auth", { show_browser: true });
}

export async function doctor(paths = runtimePaths()): Promise<Record<string, unknown>> {
  const checks: Record<string, unknown> = {
    node: { ok: nodeCompatible(), version: process.versions.node },
    ffmpeg: await commandExists("ffmpeg"),
    yt_dlp: await commandExists("yt-dlp"),
    config: await exists(paths.configFile),
    notebook_entry: await exists(paths.notebookEntry),
    revmagic_mcp: await exists(paths.revmagicMcp),
    state_dir: paths.stateDir
  };
  try {
    const receipt = await loadInstallReceipt(paths);
    await verifyInstallOwnership(receipt, paths);
    await verifyReleaseTree(receipt.releaseDir);
    checks.install_provenance = true;
    checks.managed_registrations = (await Promise.all(
      Object.values(receipt.registrations).map(async (item) => ({
        client: item.client,
        name: item.name,
        ok: sameSpec(await getRegistration(item.client, item.name), item.spec)
      }))
    ));
  } catch (error) {
    checks.install_provenance = false;
    checks.install_error = errorText(error);
  }
  const runtimeDirectories = [
    paths.configDir, paths.stateDir, paths.dataDir, paths.transcriptDir, paths.audioDir, paths.profileDir
  ];
  checks.runtime_writable = await Promise.all(runtimeDirectories.map(async (path) => ({
    path,
    ok: await access(path, constants.W_OK).then(() => true, () => false)
  })));
  if (checks.config) {
    try {
      const config = await loadConfig(paths.configFile);
      const signal = AbortSignal.timeout(15_000);
      const revTimeout = Math.min(config.revmagic.timeoutMs ?? 15_000, 15_000);
      const noteTimeout = Math.min(config.notebooklm.timeoutMs ?? 15_000, 15_000);
      const rev = await new McpClient(config.revmagic).listTools(signal, revTimeout);
      const notebook = new McpClient(config.notebooklm);
      const noteTools = await notebook.listTools(signal, noteTimeout);
      const health = await notebook.call("get_health", {}, signal, noteTimeout);
      const auth = await notebook.call("check_auth", { timeout_ms: noteTimeout }, signal, noteTimeout);
      const revNames = toolNames(rev);
      const noteNames = toolNames(noteTools);
      const requiredNotebook = [
        "get_health", "check_auth", "setup_auth", "create_notebook", "search_notebooks",
        "get_notebook", "add_audio_source", "wait_for_source_ready", "export_transcript"
      ];
      checks.revmagic_tools = [...revNames].sort();
      checks.notebooklm_tools = [...noteNames].sort();
      checks.required_tools = revNames.has(config.revmagic.extractTool) &&
        requiredNotebook.every((name) => noteNames.has(name));
      checks.notebooklm_health = health;
      checks.notebooklm_auth = auth;
      checks.authenticated = findBoolean(auth, "authenticated") ?? false;
    } catch (error) {
      checks.mcp_error = error instanceof Error ? error.message : String(error);
    }
  }
  const ok = Boolean((checks.node as { ok: boolean }).ok && checks.config &&
    checks.ffmpeg && checks.yt_dlp && checks.install_provenance &&
    checks.notebook_entry && checks.revmagic_mcp && checks.required_tools &&
    checks.authenticated && !checks.mcp_error &&
    (checks.managed_registrations as Array<{ ok: boolean }> | undefined)?.every((item) => item.ok) &&
    (checks.runtime_writable as Array<{ ok: boolean }>).every((item) => item.ok));
  return { ok, ...checks };
}

export async function runUrl(url: string, paths = runtimePaths()): Promise<Job> {
  validateSourceUrl(url);
  const config = await loadConfig(paths.configFile);
  await workflowPreflight(config);
  const store = new Store(config.database);
  const engine = new Engine(config, store);
  const key = createHash("sha256").update(url).digest("hex");
  const submitted = store.submit(url, key);
  try {
    for (;;) {
      const current = store.get(submitted.id)!;
      if (terminal.has(current.state)) return current;
      const due = Date.parse(current.next_attempt_at);
      if (due > Date.now()) await delay(Math.min(5000, due - Date.now()));
      await engine.runOnce(current.id);
    }
  } finally {
    store.close();
  }
}

export async function status(jobId: string | undefined, paths = runtimePaths()): Promise<Job | Job[] | undefined> {
  const config = await loadConfig(paths.configFile);
  const store = new Store(config.database);
  try { return jobId ? store.get(jobId) : store.list(); } finally { store.close(); }
}

export async function resume(jobId: string, paths = runtimePaths()): Promise<Job | undefined> {
  const config = await loadConfig(paths.configFile);
  const store = new Store(config.database);
  try {
    if (!store.get(jobId)) throw new Error(`unknown job: ${jobId}`);
    store.reschedule(jobId);
    return await new Engine(config, store).runOnce(jobId);
  } finally { store.close(); }
}

export async function runOnce(paths = runtimePaths()): Promise<Job | undefined> {
  const config = await loadConfig(paths.configFile);
  const store = new Store(config.database);
  try { return await new Engine(config, store).runOnce(); } finally { store.close(); }
}

export async function upgradeCheck(paths = runtimePaths()): Promise<unknown> {
  const receipt = await readJson<InstallReceipt | undefined>(paths.installReceipt, undefined);
  return {
    updatePerformed: false,
    installedReleaseDir: receipt?.releaseDir,
    installedReleaseManifestSha256: receipt?.releaseManifestSha256,
    bundledUpstreamLock: await readJson(
      join(paths.installRelease, "upstream.lock.json"),
      { error: "bundled upstream lock missing" }
    ),
    remoteLookupPerformed: false,
    action: "Run a verified release install.sh to update atomically; --check never changes installed files."
  };
}

export async function uninstall(
  options: { purge: boolean; yes: boolean } = { purge: false, yes: false },
  paths = runtimePaths()
): Promise<{ preserved: string[]; purged: boolean }> {
  if (options.purge && !options.yes) throw new Error("--purge requires --yes confirmation");
  const receipt = await loadInstallReceipt(paths);
  await verifyInstallOwnership(receipt, paths);
  const registrations = Object.values(receipt.registrations);
  for (const item of registrations) {
    const actual = await getRegistration(item.client, item.name);
    if (!sameSpec(actual, item.spec)) {
      throw new Error(`managed registration changed; refusing uninstall: ${item.client}:${item.name}`);
    }
  }
  if (receipt.service) await removeManagedService(receipt, paths);
  const removed: ManagedRegistration[] = [];
  try {
    for (const item of registrations) {
      await removeRegistration(item.client, item.name);
      removed.push(item);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const item of removed.reverse()) {
      try { await addRegistration(item.client, item.name, item.spec); }
      catch (rollbackError) { rollbackErrors.push(`${item.client}:${item.name}: ${errorText(rollbackError)}`); }
    }
    throw new Error(`${errorText(error)}${rollbackErrors.length
      ? `; rollback failures: ${rollbackErrors.join("; ")}` : ""}`, { cause: error });
  }
  await rm(paths.binPath, { force: true });
  const current = join(paths.dataDir, "current");
  await rm(current, { force: true });
  const preserved = [paths.configDir, paths.stateDir, paths.transcriptDir, paths.audioDir, paths.profileDir];
  if (options.purge) {
    await Promise.all([rm(paths.configDir, { recursive: true, force: true }),
      rm(paths.stateDir, { recursive: true, force: true }),
      rm(paths.dataDir, { recursive: true, force: true })]);
  }
  return { preserved: options.purge ? [] : preserved, purged: options.purge };
}

export async function service(
  action: string, paths = runtimePaths(), platform: NodeJS.Platform = process.platform
): Promise<unknown> {
  if (platform !== "linux") throw new Error("service is optional on Linux only; macOS launchd is not installed");
  const userDir = join(paths.home, ".config", "systemd", "user");
  const sourceDir = join(paths.installRelease, "packaging", "systemd");
  if (action === "install") {
    const receipt = await loadInstallReceipt(paths);
    await mkdir(userDir, { recursive: true });
    const servicePath = join(userDir, "rev-content.service");
    const timerPath = join(userDir, "rev-content.timer");
    const snapshots = await snapshotFiles([servicePath, timerPath, paths.installReceipt]);
    try {
      for (const name of ["rev-content.service", "rev-content.timer"]) {
        const body = (await readFile(join(sourceDir, `${name}.in`), "utf8"))
        .replaceAll("@REV_CONTENT_BIN@", paths.binPath)
        .replaceAll("@CONFIG_DIR@", paths.configDir)
        .replaceAll("@STATE_DIR@", paths.stateDir)
        .replaceAll("@DATA_DIR@", paths.dataDir);
        await atomicWrite(join(userDir, name), body, 0o644);
      }
      await runSystemctl(["--user", "daemon-reload"]);
      receipt.service = {
        unitDir: userDir,
        servicePath,
        timerPath,
        serviceSha256: await sha256File(servicePath),
        timerSha256: await sha256File(timerPath)
      };
      await atomicJson(paths.installReceipt, receipt, 0o600);
    } catch (error) {
      try { await restoreFiles(snapshots); }
      catch (rollbackError) {
        throw new Error(
          `${errorText(error)}; service install rollback failed: ${errorText(rollbackError)}`,
          { cause: rollbackError }
        );
      }
      throw error;
    }
    return { installed: userDir, note: "run systemctl --user daemon-reload && systemctl --user enable --now rev-content.timer" };
  }
  if (action === "remove") {
    const receipt = await loadInstallReceipt(paths);
    if (receipt.service) await removeManagedService(receipt, paths);
    else {
      const unmanaged = await Promise.all(["rev-content.service", "rev-content.timer"]
        .map((name) => exists(join(userDir, name))));
      if (unmanaged.some(Boolean)) {
        throw new Error("systemd unit files exist without a managed receipt; refusing removal");
      }
      await disableTimerAllowMissing();
      await runSystemctl(["--user", "daemon-reload"]);
    }
    return { removed: true, preserved_state: paths.stateDir };
  }
  if (action === "status") {
    const result = await execFileAsync("systemctl", ["--user", "status", "rev-content.timer"], { timeout: 15000 });
    return { stdout: result.stdout, stderr: result.stderr };
  }
  throw new Error("service requires install, remove, or status");
}

async function removeManagedService(receipt: InstallReceipt, paths: RuntimePaths): Promise<void> {
  const managed = receipt.service;
  if (!managed) return;
  const canonicalDir = join(paths.home, ".config", "systemd", "user");
  const canonicalService = join(canonicalDir, "rev-content.service");
  const canonicalTimer = join(canonicalDir, "rev-content.timer");
  if (resolve(managed.unitDir) !== resolve(canonicalDir) ||
      resolve(managed.servicePath) !== resolve(canonicalService) ||
      resolve(managed.timerPath) !== resolve(canonicalTimer) ||
      await sha256File(canonicalService) !== managed.serviceSha256 ||
      await sha256File(canonicalTimer) !== managed.timerSha256) {
    throw new Error("managed systemd ownership mismatch; refusing removal");
  }
  await disableTimerAllowMissing();
  const snapshots = await snapshotFiles([canonicalService, canonicalTimer, paths.installReceipt]);
  try {
    await Promise.all([rm(canonicalService, { force: true }), rm(canonicalTimer, { force: true })]);
    await runSystemctl(["--user", "daemon-reload"]);
    delete receipt.service;
    await atomicJson(paths.installReceipt, receipt, 0o600);
  } catch (error) {
    try { await restoreFiles(snapshots); }
    catch (rollbackError) {
      throw new Error(
        `${errorText(error)}; service removal rollback failed: ${errorText(rollbackError)}`,
        { cause: rollbackError }
      );
    }
    throw error;
  }
}

async function disableTimerAllowMissing(): Promise<void> {
  try {
    await runSystemctl(["--user", "disable", "--now", "rev-content.timer"]);
  } catch (error) {
    const text = errorText(error).toLowerCase();
    if (!/(not loaded|not found|does not exist|no such file)/.test(text)) throw error;
  }
}

async function runSystemctl(args: string[]): Promise<void> {
  try {
    await execFileAsync("systemctl", args, { timeout: 15_000 });
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string };
    throw new Error(
      `systemctl ${args.join(" ")} failed: ${detail.stderr ?? detail.stdout ?? errorText(error)}`,
      { cause: error }
    );
  }
}

function defaultConfigFor(paths: RuntimePaths): Config {
  return {
    database: paths.database, leaseSeconds: 60, backoffSeconds: [...DEFAULT_BACKOFF_SECONDS],
    readiness: { ...DEFAULT_READINESS },
    revmagic: {
      command: paths.revmagicMcp, args: [], timeoutMs: 1800000, stderrMaxBytes: 65536,
      extractTool: "url_to_mp3",
      outputDirectory: paths.audioDir, optimize: true
    },
    notebooklm: {
      command: process.execPath, args: [paths.notebookEntry], timeoutMs: 1200000, stderrMaxBytes: 65536,
      env: { NOTEBOOKLM_PROFILE_DIR: paths.profileDir, NOTEBOOKLM_AUDIO_ROOTS: paths.audioDir,
        NOTEBOOKLM_EXPORT_DIR: paths.transcriptDir },
      createTool: "create_notebook", searchTool: "search_notebooks", getTool: "get_notebook",
      addTool: "add_audio_source", waitTool: "wait_for_source_ready", exportTool: "export_transcript",
      exportDirectory: paths.transcriptDir
    }
  };
}

async function selectClients(selection: "auto" | "codex" | "claude" | "both"): Promise<Client[]> {
  if (selection === "both") return ["codex", "claude"];
  if (selection !== "auto") return [selection];
  const found: Client[] = [];
  for (const client of ["codex", "claude"] as const) if (await commandExists(client)) found.push(client);
  if (!found.length) throw new Error("neither codex nor claude CLI is available");
  return found;
}

async function commandExists(command: string): Promise<boolean> {
  const search = process.env.PATH?.split(process.platform === "win32" ? ";" : ":") ?? [];
  for (const dir of search) if (await exists(join(dir, command))) return true;
  return false;
}

function wrapperBundle(paths: RuntimePaths, config: Config): {
  notebook: { path: string; body: string };
  revmagic: { path: string; body: string };
} {
  const directory = join(paths.configDir, "bin");
  const validate = (value: string) => {
    if (/[\0\r\n]/.test(value)) throw new Error("runtime path contains a forbidden control character");
    return value;
  };
  const quote = (value: string) => `'${validate(value).replaceAll("'", "'\\''")}'`;
  const noteEnv = Object.entries(config.notebooklm.env ?? {}).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `export ${key}=${quote(value)}`).join("\n");
  return {
    notebook: {
      path: join(directory, "notebooklm-mcp"),
      body: `#!/bin/sh\nset -eu\n${noteEnv}\nexec ${quote(config.notebooklm.command)} ${config.notebooklm.args.map(quote).join(" ")}\n`
    },
    revmagic: {
      path: join(directory, "revmagic-mcp"),
      body: `#!/bin/sh\nset -eu\nexec ${quote(config.revmagic.command)}\n`
    }
  };
}

async function writeConfigBundle(
  paths: RuntimePaths,
  config: Config,
  wrappers: ReturnType<typeof wrapperBundle>
): Promise<void> {
  await Promise.all([
    mkdir(paths.configDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.stateDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.transcriptDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.audioDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.profileDir, { recursive: true, mode: 0o700 })
  ]);
  await atomicJson(paths.configFile, config, 0o600);
  for (const wrapper of [wrappers.notebook, wrappers.revmagic]) {
    await atomicWrite(wrapper.path, wrapper.body, 0o700);
    await chmod(wrapper.path, 0o700);
  }
}

interface FileSnapshot {
  path: string;
  content?: Uint8Array;
  mode?: number;
}

async function snapshotFiles(paths: string[]): Promise<FileSnapshot[]> {
  return Promise.all(paths.map(async (path) => {
    try {
      const metadata = await stat(path);
      return { path, content: await readFile(path), mode: metadata.mode & 0o777 };
    } catch {
      return { path };
    }
  }));
}

async function restoreFiles(snapshots: FileSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    if (snapshot.content === undefined) {
      await rm(snapshot.path, { force: true });
    } else {
      await mkdir(dirname(snapshot.path), { recursive: true });
      const temporary = `${snapshot.path}.rollback-${process.pid}`;
      await writeFile(temporary, snapshot.content, { mode: snapshot.mode });
      await rename(temporary, snapshot.path);
    }
  }
}

async function loadInstallReceipt(paths: RuntimePaths): Promise<InstallReceipt> {
  const receipt = await readJson<InstallReceipt | undefined>(paths.installReceipt, undefined);
  if (!receipt || receipt.formatVersion !== 1 || !receipt.registrations ||
      typeof receipt.installRoot !== "string" || typeof receipt.binPath !== "string") {
    throw new Error("verified install receipt is missing; rerun install.sh");
  }
  if (resolve(receipt.installRoot) !== resolve(paths.dataDir) ||
      resolve(receipt.binPath) !== resolve(paths.binPath)) {
    throw new Error("install receipt paths do not match canonical user-local paths");
  }
  return receipt;
}

async function verifyInstallOwnership(receipt: InstallReceipt, paths: RuntimePaths): Promise<void> {
  if (await sha256File(paths.binPath) !== receipt.launcherSha256) {
    throw new Error("launcher ownership hash mismatch");
  }
  const releasesRoot = `${resolve(paths.dataDir, "releases")}/`;
  if (!resolve(receipt.releaseDir).startsWith(releasesRoot)) throw new Error("release path escapes install root");
  const current = join(paths.dataDir, "current");
  const currentMetadata = await lstat(current);
  if (!currentMetadata.isSymbolicLink()) {
    throw new Error("current install pointer is not a symlink");
  }
  const target = await readlink(current);
  if (target.startsWith("/") || resolve(paths.dataDir, target) !== resolve(receipt.releaseDir) ||
      await realpath(current) !== await realpath(receipt.releaseDir)) {
    throw new Error("current install pointer does not match the receipt release");
  }
  const manifestPath = join(receipt.releaseDir, "release-manifest.json");
  const checksumPath = join(receipt.releaseDir, "release-manifest.sha256");
  const checksum = await readFile(checksumPath, "utf8");
  if (checksum !== `${receipt.releaseManifestSha256}  release-manifest.json\n` ||
      await sha256File(manifestPath) !== receipt.releaseManifestSha256) {
    throw new Error("installed release manifest ownership mismatch");
  }
}

async function verifyReleaseTree(root: string): Promise<void> {
  const manifest = await readJson<{ formatVersion?: number; files?: Array<{
    path: string; sha256: string; size: number; mode: number; type: "file" | "symlink"; target?: string;
  }> }>(join(root, "release-manifest.json"), {});
  if (manifest.formatVersion !== 1 || !Array.isArray(manifest.files)) {
    throw new Error("release tree manifest is invalid");
  }
  const entries: Array<{ path: string; target?: string }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        if (target.startsWith("/") || !resolve(dirname(path), target).startsWith(`${resolve(root)}${sep}`)) {
          throw new Error(`release symlink escapes root: ${path}`);
        }
        entries.push({ path, target });
      } else if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && !["release-manifest.json", "release-manifest.sha256"].includes(entry.name)) {
        entries.push({ path });
      } else if (!entry.isFile()) throw new Error(`unsupported release entry: ${path}`);
    }
  };
  await walk(root);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const actual = await Promise.all(entries.map(async (entry) => {
    const metadata = await lstat(entry.path);
    return {
      path: relative(root, entry.path).split(sep).join("/"),
      sha256: entry.target
        ? createHash("sha256").update(entry.target).digest("hex")
        : await sha256File(entry.path),
      size: metadata.size,
      mode: metadata.mode & 0o777,
      ...(entry.target ? { type: "symlink" as const, target: entry.target } : { type: "file" as const })
    };
  }));
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new Error("release tree differs from its manifest");
  }
}

async function workflowPreflight(config: Config): Promise<void> {
  const notebook = new McpClient(config.notebooklm);
  const signal = AbortSignal.timeout(15_000);
  const revTimeout = Math.min(config.revmagic.timeoutMs ?? 15_000, 15_000);
  const noteTimeout = Math.min(config.notebooklm.timeoutMs ?? 15_000, 15_000);
  const [revTools, noteTools] = await Promise.all([
    new McpClient(config.revmagic).listTools(signal, revTimeout),
    notebook.listTools(signal, noteTimeout)
  ]);
  const rev = toolDefinitions(revTools);
  const note = toolDefinitions(noteTools);
  requireToolSchema(rev, config.revmagic.extractTool, ["url"]);
  requireToolSchema(note, config.notebooklm.createTool, []);
  requireToolSchema(note, config.notebooklm.searchTool, []);
  requireToolSchema(note, config.notebooklm.getTool, []);
  requireToolSchema(note, config.notebooklm.addTool, ["file_paths"]);
  requireToolSchema(note, config.notebooklm.waitTool, ["source_names"]);
  requireToolSchema(note, config.notebooklm.exportTool, ["source_name"]);
  requireToolSchema(note, "check_auth", []);
  const auth = await notebook.call("check_auth", { timeout_ms: noteTimeout }, signal, noteTimeout);
  if (findBoolean(auth, "authenticated") !== true) {
    throw new Error("NotebookLM live authentication preflight failed; run rev-content auth first");
  }
}

function toolDefinitions(value: unknown): Map<string, Record<string, unknown>> {
  const tools = value && typeof value === "object" ? (value as { tools?: unknown }).tools : undefined;
  if (!Array.isArray(tools)) return new Map();
  return new Map(tools.flatMap((tool) =>
    tool && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string"
      ? [[(tool as { name: string }).name, tool as Record<string, unknown>] as const] : []));
}

function requireToolSchema(
  definitions: Map<string, Record<string, unknown>>,
  name: string,
  requiredProperties: string[]
): void {
  const definition = definitions.get(name);
  const schema = definition?.inputSchema;
  if (!schema || typeof schema !== "object") throw new Error(`required MCP tool schema missing: ${name}`);
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" ||
      requiredProperties.some((property) => !(property in properties))) {
    throw new Error(`required MCP tool schema incompatible: ${name}`);
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return fallback; }
}

async function atomicJson(path: string, value: unknown, mode: number): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

async function atomicWrite(path: string, value: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, value, { mode });
  await rename(temporary, path);
}

function nodeCompatible(): boolean {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major! > 22 || (major === 22 && minor! >= 13);
}

function validateSourceUrl(value: string): void {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("URL must use http or https");
  if (url.username || url.password) throw new Error("URL credentials are not accepted");
}

function toolNames(value: unknown): Set<string> {
  if (!value || typeof value !== "object") return new Set();
  const tools = (value as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return new Set();
  return new Set(tools.flatMap((tool) =>
    tool && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string"
      ? [(tool as { name: string }).name] : []));
}

function findBoolean(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (!Array.isArray(value) && typeof (value as Record<string, unknown>)[key] === "boolean") {
    return (value as Record<string, boolean>)[key];
  }
  for (const child of Object.values(value)) {
    const found = findBoolean(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(50, ms)));
