import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RuntimePaths {
  home: string;
  configDir: string;
  stateDir: string;
  dataDir: string;
  configFile: string;
  database: string;
  transcriptDir: string;
  audioDir: string;
  profileDir: string;
  registrationFile: string;
  installReceipt: string;
  binPath: string;
  installRelease: string;
  notebookEntry: string;
  revmagicMcp: string;
}

export function runtimePaths(env = process.env): RuntimePaths {
  const home = env.HOME || homedir();
  const configBase = env.XDG_CONFIG_HOME || (platform() === "darwin"
    ? join(home, "Library", "Application Support") : join(home, ".config"));
  const stateBase = env.XDG_STATE_HOME || (platform() === "darwin"
    ? join(home, "Library", "Application Support") : join(home, ".local", "state"));
  const dataBase = env.XDG_DATA_HOME || (platform() === "darwin"
    ? join(home, "Library", "Application Support") : join(home, ".local", "share"));
  const configDir = join(configBase, "rev-content");
  const stateDir = join(stateBase, "rev-content");
  const dataDir = join(dataBase, "rev-content");
  const binBase = env.XDG_BIN_HOME || join(home, ".local", "bin");
  const thisFile = fileURLToPath(import.meta.url);
  const installRelease = resolve(dirname(thisFile), "../../..");
  return {
    home,
    configDir,
    stateDir,
    dataDir,
    configFile: env.REV_CONTENT_CONFIG || join(configDir, "config.json"),
    database: join(stateDir, "jobs.sqlite"),
    transcriptDir: join(dataDir, "transcripts"),
    audioDir: join(dataDir, "audio"),
    profileDir: join(stateDir, "notebooklm-profile"),
    registrationFile: join(stateDir, "mcp-registrations.json"),
    installReceipt: join(dataDir, "install-receipt.json"),
    binPath: join(binBase, "rev-content"),
    installRelease,
    notebookEntry: join(dataDir, "current", "deps", "notebooklm", "dist", "index.js"),
    revmagicMcp: join(dataDir, "current", "deps", "revmagic", "bin", "revmagic-mcp")
  };
}
