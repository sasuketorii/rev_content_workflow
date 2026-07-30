#!/usr/bin/env node
/* global process */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const pidFile = process.env.SILENT_MCP_PID_FILE;
if (!pidFile) throw new Error("SILENT_MCP_PID_FILE is required");
appendFileSync(pidFile, `${process.pid}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "silent", version: "1" }
      }
    })}\n`);
    return;
  }
  if (request.method === "tools/list") {
    const grandchild = spawn(process.execPath, [
      "-e", "setInterval(() => {}, 1000)"
    ], { stdio: "ignore" });
    appendFileSync(pidFile, `${grandchild.pid}\n`);
  }
});
