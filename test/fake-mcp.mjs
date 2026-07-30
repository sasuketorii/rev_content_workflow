#!/usr/bin/env node
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";

const statePath = globalThis.process.env.FAKE_STATE;
if (!statePath) throw new Error("FAKE_STATE is required");
const load = () => JSON.parse(readFileSync(statePath, "utf8"));
const save = (state) => {
  const temporary = `${statePath}.${globalThis.process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state));
  renameSync(temporary, statePath);
};
const reply = (id, value) => globalThis.process.stdout.write(`${JSON.stringify({
  jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }] }
})}\n`);

createInterface({ input: globalThis.process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    globalThis.process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0", id: request.id,
      result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
    })}\n`);
    return;
  }
  if (request.method === "tools/list") {
    const names = [
      "extract_media", "create_notebook", "search_notebooks", "get_notebook",
      "add_audio_source", "wait_for_source_ready", "export_transcript", "get_health"
    ];
    globalThis.process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0", id: request.id, result: { tools: names.map((name) => ({ name })) }
    })}\n`);
    return;
  }
  if (request.method !== "tools/call") return;
  const { name, arguments: args } = request.params;
  const state = load();
  state.calls[name] = (state.calls[name] ?? 0) + 1;
  if (name === "extract_media") {
    save(state);
    if (state.delayExtractMs) {
      globalThis.setTimeout(() => reply(request.id, { audio_path: state.audioPath }), state.delayExtractMs);
    } else reply(request.id, { audio_path: state.audioPath });
  } else if (name === "create_notebook") {
    state.notebook = { id: "nb-1", title: args.name, sources: [] };
    save(state);
    if (state.crashAfterCreate && !state.didCrashAfterCreate) {
      state.didCrashAfterCreate = true;
      save(state);
      globalThis.process.exit(70);
    }
    reply(request.id, { notebook_id: "nb-1", title: args.name });
  } else if (name === "search_notebooks") {
    save(state);
    const found = state.searchResults ??
      (state.notebook?.title.includes(args.query) ? [state.notebook] : []);
    reply(request.id, { notebooks: found });
  } else if (name === "add_audio_source") {
    const path = args.file_paths[0];
    const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
    state.notebook.sources.push({ name: basename(path), sha256: hash });
    save(state);
    if (state.crashAfterAdd && !state.didCrashAfterAdd) {
      state.didCrashAfterAdd = true;
      save(state);
      globalThis.process.exit(71);
    }
    reply(request.id, { added: true, sha256: hash });
  } else if (name === "get_notebook") {
    save(state);
    reply(request.id, state.notebook);
  } else if (name === "wait_for_source_ready") {
    const status = state.ready ? "ready" : "processing";
    save(state);
    reply(request.id, {
      status,
      sources: args.source_names.map((name) => ({ name, status }))
    });
  } else if (name === "export_transcript") {
    if (state.crashBeforeExportWrite && !state.didCrashBeforeExportWrite) {
      state.didCrashBeforeExportWrite = true;
      save(state);
      globalThis.process.exit(73);
    }
    mkdirSync(state.exportDirectory, { recursive: true });
    const path = join(state.exportDirectory, `${args.output_name}.md`);
    writeFileSync(path, "verified fake transcript\n");
    save(state);
    if (state.crashAfterExport && !state.didCrashAfterExport) {
      state.didCrashAfterExport = true;
      save(state);
      globalThis.process.exit(72);
    }
    reply(request.id, {
      output_path: path,
      ...(state.omitVerifiedComplete ? {} : { verifiedComplete: state.verifiedComplete }),
      verification: "ui_extracted_not_independently_verified"
    });
  } else if (name === "get_health") {
    save(state);
    reply(request.id, { status: "ok" });
  } else {
    save(state);
    reply(request.id, { ok: true });
  }
});
