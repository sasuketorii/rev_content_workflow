import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Config, Job } from "../src/types.js";
import { Store } from "../src/store.js";
import { LostLeaseError } from "../src/store.js";
import { Engine } from "../src/engine.js";

interface FakeState {
  audioPath: string;
  exportPath: string;
  exportDirectory: string;
  ready: boolean;
  verifiedComplete: boolean | null;
  crashAfterAdd: boolean;
  crashAfterExport?: boolean;
  crashBeforeExportWrite?: boolean;
  crashAfterCreate?: boolean;
  delayExtractMs?: number;
  omitVerifiedComplete?: boolean;
  didCrashAfterAdd?: boolean;
  calls: Record<string, number>;
  notebook?: unknown;
  searchResults?: unknown[];
}

async function fixture(options: Partial<FakeState> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "rev-content-job-"));
  const statePath = join(dir, "fake-state.json");
  const audioPath = join(dir, "source.mp3");
  const exportPath = join(dir, "transcript.md");
  const exportDirectory = join(dir, "exports");
  await writeFile(audioPath, "same deterministic audio");
  const initial: FakeState = {
    audioPath, exportPath, exportDirectory, ready: false, verifiedComplete: true,
    crashAfterAdd: false, calls: {}, ...options
  };
  await writeFile(statePath, JSON.stringify(initial));
  const fake = resolve("test/fake-mcp.mjs");
  const process = { command: globalThis.process.execPath, args: [fake], env: { FAKE_STATE: statePath } };
  const config: Config = {
    database: join(dir, "jobs.sqlite"),
    leaseSeconds: 5,
    backoffSeconds: [1],
    readiness: { maxAttempts: 60, maxElapsedSeconds: 21600 },
    revmagic: { ...process, extractTool: "extract_media" },
    notebooklm: {
      ...process,
      createTool: "create_notebook", searchTool: "search_notebooks", getTool: "get_notebook",
      addTool: "add_audio_source", waitTool: "wait_for_source_ready", exportTool: "export_transcript",
      exportDirectory
    }
  };
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    ...config,
    database: "jobs.sqlite",
    notebooklm: { ...config.notebooklm, exportDirectory: "exports" }
  }));
  return { dir, statePath, config, configPath };
}

async function runUntil(store: Store, engine: Engine, id: string, state: string): Promise<Job> {
  for (let i = 0; i < 20; i++) {
    const current = store.get(id)!;
    if (current.state === state) return current;
    store.reschedule(id);
    await engine.runOnce(id);
  }
  throw new Error(`job did not reach ${state}: ${JSON.stringify(store.get(id))}`);
}

test("processing survives process restart and resumes to verified export", async () => {
  const { statePath, config } = await fixture();
  let store = new Store(config.database);
  let engine = new Engine(config, store);
  const submitted = store.submit("https://example.test/video", "restart-key");
  const processing = await runUntil(store, engine, submitted.id, "WAIT_READY");
  store.reschedule(processing.id);
  const stillProcessing = await engine.runOnce(processing.id);
  assert.equal(stillProcessing?.state, "WAIT_READY");
  assert.ok(Date.parse(stillProcessing!.next_attempt_at) > Date.now());
  store.close();

  const processingFake = JSON.parse(await readFile(statePath, "utf8")) as FakeState;
  processingFake.ready = true;
  await writeFile(statePath, JSON.stringify(processingFake));
  store = new Store(config.database);
  engine = new Engine(config, store);
  await runUntil(store, engine, submitted.id, "COMPLETED");
  const completed = store.get(submitted.id)!;
  assert.equal(completed.artifact_size, "verified fake transcript\n".length);
  assert.match(completed.artifact_hash!, /^[a-f0-9]{64}$/);
  store.close();
});

test("readiness polling uses persisted backoff and stops at the configured budget after restart", async () => {
  const { statePath, config } = await fixture();
  config.backoffSeconds = [1, 2, 3];
  config.readiness = { maxAttempts: 3, maxElapsedSeconds: 3600 };
  let store = new Store(config.database);
  let engine = new Engine(config, store);
  const submitted = store.submit("https://example.test/readiness-budget", "readiness-budget");
  await runUntil(store, engine, submitted.id, "WAIT_READY");

  store.reschedule(submitted.id);
  const first = await engine.runOnce(submitted.id);
  assert.equal(first?.state, "WAIT_READY");
  assert.equal(first?.readiness_attempts, 1);
  assert.ok(Date.parse(first!.next_attempt_at) - Date.now() >= 800);
  const startedAt = first!.readiness_started_at;
  store.close();

  store = new Store(config.database);
  engine = new Engine(config, store);
  store.reschedule(submitted.id);
  const second = await engine.runOnce(submitted.id);
  assert.equal(second?.readiness_attempts, 2);
  assert.equal(second?.readiness_started_at, startedAt);
  assert.ok(Date.parse(second!.next_attempt_at) - Date.now() >= 1_800);
  store.reschedule(submitted.id);
  const stopped = await engine.runOnce(submitted.id);
  assert.equal(stopped?.state, "NEEDS_ATTENTION");
  assert.equal(stopped?.readiness_attempts, 3);
  assert.match(stopped?.caveat ?? "", /budget exceeded after 3 polls/);
  assert.equal(await engine.runOnce(submitted.id), undefined);
  const fake = JSON.parse(await readFile(statePath, "utf8")) as FakeState;
  assert.equal(fake.calls.add_audio_source, 1);
  assert.equal(fake.calls.wait_for_source_ready, 3);
  store.close();
});

test("ambiguous add effect is reconciled before retry and export keeps caveat", async () => {
  const { statePath, config } = await fixture({ crashAfterAdd: true, verifiedComplete: false });
  const store = new Store(config.database);
  const engine = new Engine(config, store);
  const submitted = store.submit("https://example.test/ambiguous", "ambiguous-key");
  await runUntil(store, engine, submitted.id, "ADD_SOURCE");
  const job = store.get(submitted.id)!;
  store.reschedule(job.id);
  const ambiguous = await engine.runOnce(job.id);
  assert.equal(ambiguous?.state, "ADD_SOURCE");
  assert.match(ambiguous?.last_error ?? "", /exited before response/);

  const processingFake = JSON.parse(await readFile(statePath, "utf8")) as FakeState;
  processingFake.ready = true;
  await writeFile(statePath, JSON.stringify(processingFake));
  await runUntil(store, engine, submitted.id, "COMPLETED_WITH_CAVEAT");
  const finalState = JSON.parse(await readFile(statePath, "utf8")) as FakeState;
  assert.equal(finalState.calls.add_audio_source, 1);
  assert.ok((finalState.calls.wait_for_source_ready ?? 0) >= 1);
  assert.match(store.get(submitted.id)!.caveat!, /ui_extracted/);
  store.close();
});

test("same verified audio hash becomes NOOP_VERIFIED", async () => {
  const { statePath, config } = await fixture();
  const store = new Store(config.database);
  const engine = new Engine(config, store);
  const first = store.submit("https://example.test/one", "first");
  const fake = JSON.parse(await readFile(statePath, "utf8")) as FakeState;
  fake.ready = true;
  await writeFile(statePath, JSON.stringify(fake));
  await runUntil(store, engine, first.id, "COMPLETED");
  const second = store.submit("https://example.test/two", "second");
  await runUntil(store, engine, second.id, "NOOP_VERIFIED");
  assert.equal(store.get(second.id)!.artifact_hash, store.get(first.id)!.artifact_hash);
  store.close();
});

test("idempotency key is stable and an active lease excludes another worker", async () => {
  const { config } = await fixture();
  const firstStore = new Store(config.database);
  const secondStore = new Store(config.database);
  const one = firstStore.submit("https://example.test/lease", "stable-key");
  const duplicate = secondStore.submit("https://example.test/ignored", "stable-key");
  assert.equal(duplicate.id, one.id);
  assert.equal(duplicate.source_url, one.source_url);
  const leased = firstStore.acquire("worker-one", 60, one.id);
  assert.equal(leased?.id, one.id);
  assert.equal(secondStore.acquire("worker-two", 60, one.id), undefined);
  firstStore.release(one.id, "worker-one");
  assert.equal(secondStore.acquire("worker-two", 60, one.id)?.id, one.id);
  secondStore.release(one.id, "worker-two");
  firstStore.close();
  secondStore.close();
});

test("missing verifiedComplete produces caveat and is not a verified dedupe source", async () => {
  const { statePath, config } = await fixture({ ready: true, omitVerifiedComplete: true });
  const store = new Store(config.database);
  const engine = new Engine(config, store);
  const first = store.submit("https://example.test/caveat", "caveat");
  await runUntil(store, engine, first.id, "COMPLETED_WITH_CAVEAT");
  const state = JSON.parse(await readFile(statePath, "utf8")) as FakeState;
  state.omitVerifiedComplete = false;
  state.verifiedComplete = true;
  await writeFile(statePath, JSON.stringify(state));
  const second = store.submit("https://example.test/caveat-again", "caveat-again");
  await runUntil(store, engine, second.id, "CREATE_NOTEBOOK");
  assert.notEqual(store.get(second.id)!.state, "NOOP_VERIFIED");
  await runUntil(store, engine, second.id, "COMPLETED");
  store.close();
});

test("export applied before response loss is reconciled without re-export", async () => {
  const { statePath, config } = await fixture({ ready: true, crashAfterExport: true });
  const store = new Store(config.database);
  const engine = new Engine(config, store);
  const submitted = store.submit("https://example.test/export-crash", "export-crash");
  await runUntil(store, engine, submitted.id, "EXPORT");
  store.reschedule(submitted.id);
  const ambiguous = await engine.runOnce(submitted.id);
  assert.equal(ambiguous?.state, "EXPORT");
  store.reschedule(submitted.id);
  const reconciled = await engine.runOnce(submitted.id);
  assert.equal(reconciled?.state, "COMPLETED_WITH_CAVEAT");
  const state = JSON.parse(await readFile(statePath, "utf8")) as FakeState;
  assert.equal(state.calls.export_transcript, 1);
  store.close();
});

test("ambiguous export without a receipt stops at NEEDS_ATTENTION", async () => {
  const { statePath, config } = await fixture({ ready: true, crashBeforeExportWrite: true });
  const store = new Store(config.database);
  const engine = new Engine(config, store);
  const submitted = store.submit("https://example.test/export-no-receipt", "export-no-receipt");
  await runUntil(store, engine, submitted.id, "EXPORT");
  store.reschedule(submitted.id);
  await engine.runOnce(submitted.id);
  store.reschedule(submitted.id);
  const stopped = await engine.runOnce(submitted.id);
  assert.equal(stopped?.state, "NEEDS_ATTENTION");
  assert.equal(await engine.runOnce(submitted.id), undefined);
  const state = JSON.parse(await readFile(statePath, "utf8")) as FakeState;
  assert.equal(state.calls.export_transcript, 1);
  store.close();
});

test("null verifiedComplete produces COMPLETED_WITH_CAVEAT", async () => {
  const { config } = await fixture({ ready: true, verifiedComplete: null });
  const store = new Store(config.database);
  const engine = new Engine(config, store);
  const submitted = store.submit("https://example.test/null-verification", "null-verification");
  await runUntil(store, engine, submitted.id, "COMPLETED_WITH_CAVEAT");
  assert.match(store.get(submitted.id)!.caveat!, /ui_extracted/);
  store.close();
});

test("create reconcile binds exact marker and id from the same result entry", async () => {
  const { statePath, config } = await fixture({ crashAfterCreate: true });
  const store = new Store(config.database);
  const engine = new Engine(config, store);
  const submitted = store.submit("https://example.test/create-crash", "create-crash");
  await runUntil(store, engine, submitted.id, "CREATE_NOTEBOOK");
  store.reschedule(submitted.id);
  await engine.runOnce(submitted.id);
  const markerName = `Rev Content revjob-${submitted.id}`;
  const state = JSON.parse(await readFile(statePath, "utf8")) as FakeState;
  state.searchResults = [
    { id: "wrong-first-id", name: "unrelated notebook" },
    { id: "correct-id", name: markerName }
  ];
  await writeFile(statePath, JSON.stringify(state));
  store.reschedule(submitted.id);
  const reconciled = await engine.runOnce(submitted.id);
  assert.equal(reconciled?.notebook_id, "correct-id");
  assert.equal(reconciled?.state, "ADD_SOURCE");
  store.close();
});

test("stale worker is fenced from state, effect, and artifact writes after takeover", async () => {
  const { config } = await fixture();
  const firstStore = new Store(config.database);
  const secondStore = new Store(config.database);
  const job = firstStore.submit("https://example.test/fence", "fence");
  firstStore.acquire("stale-worker", 60, job.id);
  firstStore.db.prepare("UPDATE jobs SET lease_expires_at=? WHERE id=?")
    .run(new Date(0).toISOString(), job.id);
  assert.equal(secondStore.acquire("new-worker", 60, job.id)?.id, job.id);
  assert.throws(() => firstStore.transition(job.id, "stale-worker", "DEDUP"), LostLeaseError);
  assert.throws(() => firstStore.intent(job.id, "stale-worker", "CREATE_NOTEBOOK", "token"), LostLeaseError);
  assert.throws(
    () => firstStore.recordArtifact("input", "artifact", "/tmp/nope", 1, job.id, "stale-worker", true),
    LostLeaseError
  );
  secondStore.transition(job.id, "new-worker", "DEDUP");
  secondStore.release(job.id, "new-worker");
  firstStore.close();
  secondStore.close();
});

test("heartbeat lease loss aborts the in-flight MCP and stale worker cannot commit", async () => {
  const { statePath, config } = await fixture({ delayExtractMs: 5000 });
  config.leaseSeconds = 1;
  const firstStore = new Store(config.database);
  const secondStore = new Store(config.database);
  const engine = new Engine(config, firstStore);
  const job = firstStore.submit("https://example.test/heartbeat", "heartbeat");
  const running = engine.runOnce(job.id);
  for (let i = 0; i < 50; i++) {
    const state = JSON.parse(await readFile(statePath, "utf8")) as FakeState;
    if ((state.calls.extract_media ?? 0) > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  firstStore.db.prepare("UPDATE jobs SET lease_expires_at=? WHERE id=?")
    .run(new Date(0).toISOString(), job.id);
  assert.equal(secondStore.acquire("takeover", 60, job.id)?.id, job.id);
  await running;
  const current = secondStore.get(job.id)!;
  assert.equal(current.state, "EXTRACT");
  assert.equal(current.lease_owner, "takeover");
  secondStore.release(job.id, "takeover");
  firstStore.close();
  secondStore.close();
});

test("declared package bin starts and doctor validates fake MCP tools", async () => {
  const { configPath } = await fixture();
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    bin: Record<string, string>;
  };
  const bin = resolve(packageJson.bin["rev-content-job"]!);
  const result = await promisify(execFile)(globalThis.process.execPath, [
    bin, "--config", configPath, "doctor"
  ]);
  const output = JSON.parse(result.stdout) as { ok: boolean; missing: string[] };
  assert.equal(output.ok, true);
  assert.deepEqual(output.missing, []);
});

test("import-current-job verifies existing source and never re-uploads it", async () => {
  const { statePath, configPath, config } = await fixture();
  const state = JSON.parse(await readFile(statePath, "utf8")) as FakeState;
  const notebookUrl = "https://notebooklm.google.com/notebook/fake-existing";
  state.notebook = {
    id: "existing-id",
    name: "existing",
    url: notebookUrl,
    sources: [{ name: "source.mp3", status: "processing" }]
  };
  await writeFile(statePath, JSON.stringify(state));
  const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    bin: Record<string, string>;
  };
  const bin = resolve(packageJson.bin["rev-content-job"]!);
  const hash = createHash("sha256").update("same deterministic audio").digest("hex");
  const command = [
    bin, "--config", configPath, "import-current-job",
    "https://example.test/adopt", "existing-id", notebookUrl, "source.mp3",
    state.audioPath, hash, "adopt-key"
  ];
  const first = await promisify(execFile)(globalThis.process.execPath, command);
  const second = await promisify(execFile)(globalThis.process.execPath, command);
  const firstJob = (JSON.parse(first.stdout) as { job: Job }).job;
  const secondJob = (JSON.parse(second.stdout) as { job: Job }).job;
  assert.equal(firstJob.state, "WAIT_READY");
  assert.equal(secondJob.id, firstJob.id);
  const finalState = JSON.parse(await readFile(statePath, "utf8")) as FakeState;
  assert.equal(finalState.calls.add_audio_source ?? 0, 0);
  const store = new Store(config.database);
  assert.equal(store.get(firstJob.id)?.notebook_url, notebookUrl);
  assert.equal(store.effect(firstJob.id, "CREATE_NOTEBOOK")?.status, "CONFIRMED");
  assert.equal(store.effect(firstJob.id, "ADD_SOURCE")?.status, "CONFIRMED");
  store.close();
});

test("replacement recovery creates one linked generation and never reuses failed notebook", async () => {
  const { dir, statePath, config } = await fixture();
  const state = JSON.parse(await readFile(statePath, "utf8")) as FakeState;
  const originHash = createHash("sha256").update("same deterministic audio").digest("hex");
  const replacementPath = join(dir, "replacement.mp3");
  await writeFile(replacementPath, "smaller verified replacement");
  const replacementHash = createHash("sha256").update("smaller verified replacement").digest("hex");
  const store = new Store(config.database);
  const origin = store.adopt({
    url: "https://example.test/origin",
    key: "origin-key",
    audioPath: state.audioPath,
    audioHash: originHash,
    notebookId: "failed-notebook",
    notebookUrl: "https://notebooklm.google.com/notebook/failed",
    sourceName: "source.mp3",
    notebookEvidence: { id: "failed-notebook" },
    sourceEvidence: { name: "source.mp3", status: "error" },
    initialState: "NEEDS_ATTENTION",
    lastError: "row-local error"
  });
  const recovered = store.recoverWithReplacement({
    originJobId: origin.id,
    key: "replacement-key",
    audioPath: replacementPath,
    audioHash: replacementHash
  });
  assert.equal(recovered.state, "CREATE_NOTEBOOK");
  assert.equal(recovered.origin_job_id, origin.id);
  assert.equal(recovered.generation, 2);
  assert.equal(recovered.notebook_id, null);
  assert.equal(store.recoverWithReplacement({
    originJobId: origin.id,
    key: "replacement-key",
    audioPath: replacementPath,
    audioHash: replacementHash
  }).id, recovered.id);
  assert.throws(() => store.recoverWithReplacement({
    originJobId: origin.id,
    key: "same-audio",
    audioPath: state.audioPath,
    audioHash: originHash
  }), /different SHA256/);
  store.close();
});

test("multi-source generation survives restart and combines ordered receipts with caveat", async () => {
  const { dir, statePath, config } = await fixture();
  const fake = JSON.parse(await readFile(statePath, "utf8")) as FakeState;
  const firstPath = join(dir, "segment-001.mp3");
  const secondPath = join(dir, "segment-002.mp3");
  await writeFile(firstPath, "segment one");
  await writeFile(secondPath, "segment two");
  const firstHash = createHash("sha256").update("segment one").digest("hex");
  const secondHash = createHash("sha256").update("segment two").digest("hex");
  let store = new Store(config.database);
  const origin = store.adopt({
    url: "https://example.test/multi",
    key: "multi-origin",
    audioPath: fake.audioPath,
    audioHash: createHash("sha256").update("same deterministic audio").digest("hex"),
    notebookId: "failed",
    notebookUrl: "https://notebooklm.google.com/notebook/failed",
    sourceName: "source.mp3",
    notebookEvidence: {},
    sourceEvidence: { name: "source.mp3", status: "error" },
    initialState: "NEEDS_ATTENTION"
  });
  const job = store.recoverWithSegments({
    originJobId: origin.id,
    key: "multi-generation",
    segments: [
      { audioPath: firstPath, audioHash: firstHash, sourceName: "segment-001.mp3" },
      { audioPath: secondPath, audioHash: secondHash, sourceName: "segment-002.mp3" }
    ]
  });
  let engine = new Engine(config, store);
  await runUntil(store, engine, job.id, "WAIT_SOURCES");
  store.reschedule(job.id);
  assert.equal((await engine.runOnce(job.id))?.state, "WAIT_SOURCES");
  store.close();

  const multiProcessingFake = JSON.parse(await readFile(statePath, "utf8")) as FakeState;
  multiProcessingFake.ready = true;
  await writeFile(statePath, JSON.stringify(multiProcessingFake));
  store = new Store(config.database);
  engine = new Engine(config, store);
  await runUntil(store, engine, job.id, "COMPLETED_WITH_CAVEAT");
  const completed = store.get(job.id)!;
  const combined = await readFile(completed.artifact_path!, "utf8");
  assert.ok(combined.indexOf("segment=0") < combined.indexOf("segment=1"));
  assert.match(combined, /No overlap or gap was inferred or repaired/);
  const finalFake = JSON.parse(await readFile(statePath, "utf8")) as FakeState;
  assert.equal(finalFake.calls.add_audio_source, 2);
  assert.equal(finalFake.calls.export_transcript, 2);
  store.close();
});

test("segment recovery rejects audio outside the 24 kHz mono 64 kbps contract", async () => {
  const { dir, config, configPath } = await fixture();
  const correctPath = join(dir, "correct.mp3");
  const wrongPath = join(dir, "wrong.mp3");
  await promisify(execFile)("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "1",
    "-ar", "24000", "-ac", "1", "-b:a", "64k", correctPath
  ]);
  await promisify(execFile)("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "1",
    "-ar", "44100", "-ac", "2", "-b:a", "96k", wrongPath
  ]);
  const correctHash = (await fileHash(correctPath));
  const wrongHash = (await fileHash(wrongPath));
  const store = new Store(config.database);
  const origin = store.submit("https://example.test/segment-contract", "segment-contract-origin");
  store.fenceBeforeEffects(origin.id, "test recovery origin");
  store.close();
  const manifestPath = join(dir, "invalid-segments.json");
  await writeFile(manifestPath, JSON.stringify([
    { path: correctPath, sha256: correctHash, source_name: "correct.mp3" },
    { path: wrongPath, sha256: wrongHash, source_name: "wrong.mp3" }
  ]));
  await assert.rejects(
    promisify(execFile)(globalThis.process.execPath, [
      resolve("dist/src/cli.js"), "--config", configPath,
      "recover-with-segments", origin.id, manifestPath, "invalid-segment-generation"
    ]),
    /must be 24000 Hz mono/
  );
  const verifyStore = new Store(config.database);
  assert.equal(verifyStore.list().length, 1);
  verifyStore.close();
});

test("recovery generation advances across a fenced sibling even with an older origin", async () => {
  const { dir, config } = await fixture();
  const firstPath = join(dir, "first-segment.mp3");
  const secondPath = join(dir, "second-segment.mp3");
  await writeFile(firstPath, "first segment");
  await writeFile(secondPath, "second segment");
  const segments = [
    {
      audioPath: firstPath,
      audioHash: createHash("sha256").update("first segment").digest("hex"),
      sourceName: "first-segment.mp3"
    },
    {
      audioPath: secondPath,
      audioHash: createHash("sha256").update("second segment").digest("hex"),
      sourceName: "second-segment.mp3"
    }
  ];
  const store = new Store(config.database);
  const origin = store.submit("https://example.test/generation-lineage", "lineage-origin");
  store.fenceBeforeEffects(origin.id, "test origin");
  const generationTwo = store.recoverWithSegments({
    originJobId: origin.id, key: "lineage-two", segments
  });
  assert.equal(generationTwo.generation, 2);
  store.fenceBeforeEffects(generationTwo.id, "invalid sibling");
  const generationThree = store.recoverWithSegments({
    originJobId: origin.id, key: "lineage-three", segments
  });
  assert.equal(generationThree.generation, 3);
  store.close();
});

async function fileHash(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
