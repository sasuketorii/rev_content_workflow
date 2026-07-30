import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { ProcessConfig } from "./types.js";

interface Response {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STDERR_MAX_BYTES = 65_536;

export class McpClient {
  constructor(private readonly config: ProcessConfig) {}

  async call(
    tool: string, args: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number
  ): Promise<unknown> {
    return this.exchange("tools/call", { name: tool, arguments: args }, true, signal, timeoutMs);
  }

  async listTools(signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    return this.exchange("tools/list", {}, false, signal, timeoutMs);
  }

  private async exchange(
    method: string,
    params: Record<string, unknown>,
    unwrapTool: boolean,
    signal?: AbortSignal,
    timeoutOverride?: number
  ): Promise<unknown> {
    signal?.throwIfAborted();
    const timeoutMs = timeoutOverride ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const stderrLimit = this.config.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES;
    const child = spawn(this.config.command, this.config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.config.env },
      shell: false,
      detached: process.platform !== "win32"
    });
    let exited = false;
    let stderr = Buffer.alloc(0);
    child.stderr.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderr = Buffer.concat([stderr, bytes]);
      if (stderr.length > stderrLimit) stderr = stderr.subarray(stderr.length - stderrLimit);
    });
    const exitPromise = new Promise<void>((resolve) => {
      child.once("exit", () => {
        exited = true;
        resolve();
      });
    });
    let stopReject!: (error: Error) => void;
    const stopped = new Promise<never>((_, reject) => { stopReject = reject; });
    const pending = new Map<number, {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }>();
    const fail = (error: Error): void => {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      stopReject(error);
    };
    child.once("error", (error) => fail(error));
    child.once("exit", (code, exitSignal) => {
      fail(new Error(
        `MCP exited before response (code=${code}, signal=${exitSignal}): ${stderr.toString("utf8").trim()}`
      ));
    });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: Response;
      try { message = JSON.parse(line) as Response; } catch { return; }
      if (message.id === undefined) return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`MCP ${message.error.code}: ${message.error.message}`));
      else waiter.resolve(message.result);
    });

    let sequence = 0;
    const request = (requestMethod: string, requestParams: unknown): Promise<unknown> => {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method: requestMethod, params: requestParams })}\n`,
          (error) => {
            if (!error) return;
            pending.delete(id);
            reject(error);
          }
        );
      });
    };

    const deadline = setTimeout(
      () => fail(new Error(`MCP hard deadline exceeded after ${timeoutMs}ms (${method})`)),
      timeoutMs
    );
    deadline.unref();
    const abort = (): void => {
      const reason = signal?.reason;
      fail(reason instanceof Error ? reason : new Error("MCP request aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await Promise.race([
        request("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "rev-content-job", version: "0.1.0" }
        }),
        stopped
      ]);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`
      );
      const response = await Promise.race([request(method, params), stopped]);
      if (!unwrapTool) return response;
      const result = response as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      if (result?.isError) {
        throw new Error(
          result.content?.map((item) => item.text ?? "").join("\n") || "MCP tool error"
        );
      }
      const text = result?.content?.find((item) => item.type === "text")?.text;
      if (text) {
        try { return JSON.parse(text); } catch { return { text, raw: response }; }
      }
      return response;
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      lines.close();
      child.stdin.end();
      await terminateProcessTree(child, exitPromise, () => exited);
    }
  }
}

async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  exitPromise: Promise<void>,
  hasExited: () => boolean
): Promise<void> {
  if (hasExited()) return;
  sendSignal(child, "SIGTERM");
  await Promise.race([exitPromise, delay(250)]);
  if (!hasExited()) {
    sendSignal(child, "SIGKILL");
    await Promise.race([exitPromise, delay(2_000)]);
  }
  if (!hasExited()) throw new Error(`MCP child process could not be reaped: pid=${child.pid ?? "unknown"}`);
}

function sendSignal(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
