#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { McpClient } from "./mcp.js";
import { fileReceipt, findString } from "./util.js";

const execFileAsync = promisify(execFile);

function usage(): never {
  console.error(`usage: rev-content-job --config FILE COMMAND
commands:
  doctor
  submit URL [KEY]
  import-current-job URL NOTEBOOK_ID NOTEBOOK_URL SOURCE_NAME AUDIO_PATH SHA256 [KEY]
  recover-with-replacement ORIGIN_JOB AUDIO_PATH SHA256 [KEY]
  recover-with-segments ORIGIN_JOB MANIFEST_JSON [KEY]
  fence-before-effects JOB REASON
  fence JOB REASON
  run-once [JOB]
  resume JOB
  status [JOB]
  run`);
  process.exit(2);
}

const args = process.argv.slice(2);
const configIndex = args.indexOf("--config");
if (configIndex < 0 || !args[configIndex + 1]) usage();
const configPath = args[configIndex + 1]!;
args.splice(configIndex, 2);
const command = args.shift();
if (!command) usage();
const config = await loadConfig(configPath);
const store = new Store(config.database);
const engine = new Engine(config, store);
try {
  if (command === "doctor") {
    await access(config.database).catch(() => undefined);
    const signal = AbortSignal.timeout(15_000);
    const rev = await new McpClient(config.revmagic).listTools(signal, 15_000).catch((error) => ({ error: String(error) }));
    const noteClient = new McpClient(config.notebooklm);
    const note = await noteClient.listTools(signal, 15_000).catch((error) => ({ error: String(error) }));
    const health = await noteClient.call("get_health", {}).catch((error) => ({ error: String(error) }));
    const authPreflight = await noteClient.call("check_auth", { timeout_ms: 15000 }, signal, 15_000)
      .catch((error) => ({ error: String(error) }));
    const revNames = toolNames(rev);
    const noteNames = toolNames(note);
    const missing = [
      ...(!revNames.has(config.revmagic.extractTool) ? [`revmagic:${config.revmagic.extractTool}`] : []),
      ...[
        config.notebooklm.createTool, config.notebooklm.searchTool, config.notebooklm.getTool,
        config.notebooklm.addTool, config.notebooklm.waitTool, config.notebooklm.exportTool
      ].filter((name) => !noteNames.has(name)).map((name) => `notebooklm:${name}`)
    ];
    console.log(JSON.stringify({
      ok: missing.length === 0,
      database: config.database,
      missing,
      notebook_profile_strategy: config.notebooklm.env?.NOTEBOOK_PROFILE_STRATEGY ?? "auto",
      notebook_health: health,
      notebook_auth_preflight: authPreflight,
      revmagic: rev,
      notebooklm: note
    }, null, 2));
    if (missing.length) process.exitCode = 1;
  } else if (command === "submit") {
    const url = args[0];
    if (!url) usage();
    const key = args[1] ?? createHash("sha256").update(url).digest("hex");
    console.log(JSON.stringify(store.submit(url, key), null, 2));
  } else if (command === "import-current-job") {
    const [url, notebookId, notebookUrl, sourceName, audioPath, expectedHash, suppliedKey] = args;
    if (!url || !notebookId || !notebookUrl || !sourceName || !audioPath || !expectedHash) usage();
    if (!/^[a-f0-9]{64}$/i.test(expectedHash)) throw new Error("SHA256 must contain exactly 64 hex characters");
    const receipt = await fileReceipt(audioPath);
    if (receipt.hash !== expectedHash.toLowerCase()) {
      throw new Error(`audio SHA256 mismatch: expected ${expectedHash.toLowerCase()}, got ${receipt.hash}`);
    }
    const client = new McpClient(config.notebooklm);
    const metadata = await client.call(config.notebooklm.getTool, { id: notebookId });
    const actualUrl = findString(metadata, ["url", "notebook_url"]);
    if (!actualUrl || canonicalNotebookUrl(actualUrl) !== canonicalNotebookUrl(notebookUrl)) {
      throw new Error(`notebook URL mismatch for library id ${notebookId}`);
    }
    const readiness = await client.call(config.notebooklm.waitTool, {
      notebook_id: notebookId,
      notebook_url: notebookUrl,
      source_names: [sourceName],
      timeout_ms: 0
    });
    const sourceStatuses = exactSourceStatuses(readiness, sourceName);
    if (sourceStatuses.length !== 1) {
      throw new Error(`source cannot be safely adopted; exact source matches=${sourceStatuses.length}`);
    }
    const status = sourceStatuses[0]!;
    if (!["ready", "processing", "completed", "in_progress", "error"].includes(status)) {
      throw new Error(`source cannot be safely adopted; readiness status=${status}`);
    }
    const initialState = status === "error" ? "NEEDS_ATTENTION" as const : "WAIT_READY" as const;
    const key = suppliedKey ?? createHash("sha256")
      .update([url, notebookId, notebookUrl, sourceName, receipt.hash].join("\n")).digest("hex");
    const job = store.adopt({
      url,
      key,
      audioPath: receipt.path,
      audioHash: receipt.hash,
      notebookId,
      notebookUrl,
      sourceName,
      notebookEvidence: metadata,
      sourceEvidence: readiness,
      initialState,
      ...(status === "error" ? { lastError: "adopted source has a row-local NotebookLM error" } : {})
    });
    console.log(JSON.stringify({ job, readiness_probe: readiness }, null, 2));
  } else if (command === "recover-with-replacement") {
    const [originJobId, audioPath, expectedHash, suppliedKey] = args;
    if (!originJobId || !audioPath || !expectedHash) usage();
    if (!/^[a-f0-9]{64}$/i.test(expectedHash)) throw new Error("SHA256 must contain exactly 64 hex characters");
    const receipt = await fileReceipt(audioPath);
    if (receipt.hash !== expectedHash.toLowerCase()) {
      throw new Error(`replacement SHA256 mismatch: expected ${expectedHash.toLowerCase()}, got ${receipt.hash}`);
    }
    const key = suppliedKey ?? createHash("sha256")
      .update([originJobId, receipt.path, receipt.hash].join("\n")).digest("hex");
    console.log(JSON.stringify(store.recoverWithReplacement({
      originJobId,
      key,
      audioPath: receipt.path,
      audioHash: receipt.hash
    }), null, 2));
  } else if (command === "recover-with-segments") {
    const [originJobId, manifestPath, suppliedKey] = args;
    if (!originJobId || !manifestPath) usage();
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (!Array.isArray(manifest) || manifest.length < 2 || manifest.length > 10) {
      throw new Error("segment manifest must be an array with 2..10 entries");
    }
    const segments = [];
    let totalBytes = 0;
    for (const [index, value] of manifest.entries()) {
      if (!value || typeof value !== "object") throw new Error(`invalid segment ${index}`);
      const item = value as Record<string, unknown>;
      if (typeof item.path !== "string" || typeof item.sha256 !== "string" ||
          typeof item.source_name !== "string" || !/^[a-f0-9]{64}$/i.test(item.sha256)) {
        throw new Error(`invalid segment ${index}`);
      }
      const receipt = await fileReceipt(item.path);
      if (receipt.hash !== item.sha256.toLowerCase()) {
        throw new Error(`segment ${index} SHA256 mismatch`);
      }
      const media = await probeAudio(receipt.path);
      if (media.sampleRate !== 24000 || media.channels !== 1 ||
          media.bitRate < 60000 || media.bitRate > 68000) {
        throw new Error(
          `segment ${index} must be 24000 Hz mono and approximately 64 kbps; ` +
          `got ${media.sampleRate} Hz, ${media.channels} channel(s), ${media.bitRate} bps`
        );
      }
      totalBytes += receipt.size;
      segments.push({
        audioPath: receipt.path,
        audioHash: receipt.hash,
        sourceName: item.source_name
      });
    }
    if (totalBytes > 60_000_000) {
      throw new Error(`segment total size exceeds 60000000 bytes: ${totalBytes}`);
    }
    const key = suppliedKey ?? createHash("sha256")
      .update([originJobId, ...segments.map((segment) => segment.audioHash)].join("\n")).digest("hex");
    console.log(JSON.stringify(store.recoverWithSegments({
      originJobId,
      key,
      segments
    }), null, 2));
  } else if (command === "fence-before-effects") {
    const [jobId, reason] = args;
    if (!jobId || !reason) usage();
    console.log(JSON.stringify(store.fenceBeforeEffects(jobId, reason), null, 2));
  } else if (command === "fence") {
    const [jobId, reason] = args;
    if (!jobId || !reason) usage();
    console.log(JSON.stringify(store.fence(jobId, reason), null, 2));
  } else if (command === "run-once") {
    console.log(JSON.stringify(await engine.runOnce(args[0]), null, 2));
  } else if (command === "resume") {
    const id = args[0];
    if (!id) usage();
    const job = store.get(id);
    if (!job) throw new Error(`unknown job: ${id}`);
    store.reschedule(id);
    console.log(JSON.stringify(await engine.runOnce(id), null, 2));
  } else if (command === "status") {
    console.log(JSON.stringify(args[0] ? store.get(args[0]) : store.list(), null, 2));
  } else if (command === "run") {
    const owner = randomUUID();
    void owner;
    for (;;) {
      const job = await engine.runOnce();
      if (!job) {
        const next = store.list()
          .filter((item) => !terminalState(item.state))
          .map((item) => Date.parse(item.next_attempt_at))
          .sort((a, b) => a - b)[0];
        const delay = next === undefined ? 1000 : Math.max(250, Math.min(5000, next - Date.now()));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  } else usage();
} finally {
  store.close();
}

function terminalState(state: string): boolean {
  return ["COMPLETED", "COMPLETED_WITH_CAVEAT", "NOOP_VERIFIED", "NEEDS_ATTENTION", "FAILED"].includes(state);
}

function toolNames(value: unknown): Set<string> {
  if (!value || typeof value !== "object") return new Set();
  const tools = (value as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return new Set();
  return new Set(tools.flatMap((tool) =>
    tool && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string"
      ? [(tool as { name: string }).name] : []));
}

function canonicalNotebookUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "notebooklm.google.com") {
    throw new Error("invalid NotebookLM URL");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function exactSourceStatuses(value: unknown, exactName: string): string[] {
  const statuses: string[] = [];
  const visit = (entry: unknown): void => {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child);
      return;
    }
    const object = entry as Record<string, unknown>;
    if (object.name === exactName && typeof object.status === "string") {
      statuses.push(object.status.toLowerCase());
    }
    for (const child of Object.values(object)) visit(child);
  };
  visit(value);
  return statuses;
}

async function probeAudio(path: string): Promise<{
  sampleRate: number;
  channels: number;
  bitRate: number;
}> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=sample_rate,channels,bit_rate",
    "-of", "json",
    path
  ]);
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ sample_rate?: string; channels?: number; bit_rate?: string }>;
  };
  const stream = parsed.streams?.[0];
  const sampleRate = Number(stream?.sample_rate);
  const channels = Number(stream?.channels);
  const bitRate = Number(stream?.bit_rate);
  if (![sampleRate, channels, bitRate].every(Number.isFinite)) {
    throw new Error(`ffprobe returned incomplete audio metadata for ${path}`);
  }
  return { sampleRate, channels, bitRate };
}
