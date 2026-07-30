import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Config, ProcessConfig } from "./types.js";

export const DEFAULT_BACKOFF_SECONDS = [5, 15, 30, 60, 120, 300] as const;
export const DEFAULT_READINESS = { maxAttempts: 60, maxElapsedSeconds: 21600 } as const;

function processConfig(value: unknown, label: string): ProcessConfig {
  if (!value || typeof value !== "object") throw new Error(`${label} must be an object`);
  const item = value as Record<string, unknown>;
  if (typeof item.command !== "string" || !item.command) throw new Error(`${label}.command is required`);
  if (!Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`${label}.args must be an argv array`);
  }
  if (item.env !== undefined && (!item.env || typeof item.env !== "object" ||
      Object.values(item.env).some((entry) => typeof entry !== "string"))) {
    throw new Error(`${label}.env must contain strings`);
  }
  return {
    command: item.command,
    args: item.args as string[],
    ...(item.env ? { env: item.env as Record<string, string> } : {}),
    ...(typeof item.timeoutMs === "number" ? { timeoutMs: boundedInteger(item.timeoutMs, label, "timeoutMs", 100, 3600000) } : {}),
    ...(typeof item.stderrMaxBytes === "number"
      ? { stderrMaxBytes: boundedInteger(item.stderrMaxBytes, label, "stderrMaxBytes", 1024, 1048576) } : {})
  };
}

function boundedInteger(value: number, label: string, key: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label}.${key} must be an integer in ${min}..${max}`);
  }
  return value;
}

export async function loadConfig(path: string): Promise<Config> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const rev = raw.revmagic as Record<string, unknown>;
  const note = raw.notebooklm as Record<string, unknown>;
  const required = (object: Record<string, unknown>, key: string): string => {
    if (typeof object?.[key] !== "string" || !object[key]) throw new Error(`missing ${key}`);
    return object[key] as string;
  };
  const backoff = raw.backoffSeconds ?? DEFAULT_BACKOFF_SECONDS;
  if (!Array.isArray(backoff) || backoff.length === 0 ||
      backoff.some((n) => typeof n !== "number" || n <= 0)) throw new Error("invalid backoffSeconds");
  const readiness = raw.readiness && typeof raw.readiness === "object"
    ? raw.readiness as Record<string, unknown> : {};
  return {
    database: resolve(dirname(path), typeof raw.database === "string" ? raw.database : ".runtime/jobs.sqlite"),
    leaseSeconds: typeof raw.leaseSeconds === "number" ? raw.leaseSeconds : 60,
    backoffSeconds: backoff as number[],
    readiness: {
      maxAttempts: typeof readiness.maxAttempts === "number"
        ? boundedInteger(readiness.maxAttempts, "readiness", "maxAttempts", 1, 10000)
        : DEFAULT_READINESS.maxAttempts,
      maxElapsedSeconds: typeof readiness.maxElapsedSeconds === "number"
        ? boundedInteger(readiness.maxElapsedSeconds, "readiness", "maxElapsedSeconds", 1, 2592000)
        : DEFAULT_READINESS.maxElapsedSeconds
    },
    revmagic: {
      ...processConfig(rev, "revmagic"),
      extractTool: required(rev, "extractTool"),
      ...(typeof rev.outputDirectory === "string"
        ? { outputDirectory: resolve(dirname(path), rev.outputDirectory) } : {}),
      ...(typeof rev.optimize === "boolean" ? { optimize: rev.optimize } : {})
    },
    notebooklm: {
      ...processConfig(note, "notebooklm"),
      createTool: required(note, "createTool"),
      searchTool: required(note, "searchTool"),
      getTool: required(note, "getTool"),
      addTool: required(note, "addTool"),
      waitTool: required(note, "waitTool"),
      exportTool: required(note, "exportTool"),
      exportDirectory: resolve(dirname(path), required(note, "exportDirectory"))
    }
  };
}
