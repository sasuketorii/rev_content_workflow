#!/usr/bin/env node
/* global process */
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.FAKE_PREFLIGHT_STATE;
const role = process.env.FAKE_PREFLIGHT_ROLE;
if (!statePath || !role) process.exit(2);
const load = () => JSON.parse(readFileSync(statePath, "utf8"));
const save = (value) => writeFileSync(statePath, JSON.stringify(value));
const response = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const schema = (name, properties = {}) => ({ name, inputSchema: { type: "object", properties } });

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    response(request.id, {
      protocolVersion: "2025-03-26", capabilities: { tools: {} },
      serverInfo: { name: `fake-${role}`, version: "1" }
    });
  } else if (request.method === "tools/list") {
    const tools = role === "rev"
      ? [schema("url_to_mp3", { url: { type: "string" } })]
      : [
          schema("create_notebook"), schema("search_notebooks"), schema("get_notebook"),
          schema("add_audio_source", { file_paths: { type: "array" } }),
          schema("wait_for_source_ready", { source_names: { type: "array" } }),
          schema("export_transcript", { source_name: { type: "string" } }),
          schema("check_auth"), schema("setup_auth"), schema("get_health")
        ];
    response(request.id, { tools });
  } else if (request.method === "tools/call") {
    const state = load();
    state.calls[request.params.name] = (state.calls[request.params.name] ?? 0) + 1;
    save(state);
    response(request.id, {
      content: [{ type: "text", text: JSON.stringify(
        request.params.name === "check_auth" ? { authenticated: state.authenticated } : { ok: true }
      ) }]
    });
  }
});
