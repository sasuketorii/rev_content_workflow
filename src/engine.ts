import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { Config, Job } from "./types.js";
import { LostLeaseError, Store } from "./store.js";
import { McpClient } from "./mcp.js";
import { fileReceipt, findString, hasText } from "./util.js";

const terminal = new Set([
  "COMPLETED", "COMPLETED_WITH_CAVEAT", "NOOP_VERIFIED", "NEEDS_ATTENTION", "FAILED"
]);

export class Engine {
  private readonly revmagic: McpClient;
  private readonly notebook: McpClient;

  constructor(readonly config: Config, readonly store: Store) {
    this.revmagic = new McpClient(config.revmagic);
    this.notebook = new McpClient(config.notebooklm);
  }

  async runOnce(jobId?: string): Promise<Job | undefined> {
    const owner = `${process.pid}:${randomUUID()}`;
    const job = this.store.acquire(owner, this.config.leaseSeconds, jobId);
    if (!job) return undefined;
    const controller = new AbortController();
    let leaseFailure: Error | undefined;
    const heartbeat = setInterval(() => {
      try {
        this.store.renew(job.id, owner, this.config.leaseSeconds);
      } catch (error) {
        leaseFailure = error instanceof Error ? error : new Error(String(error));
        controller.abort(leaseFailure);
      }
    }, Math.max(1000, Math.floor(this.config.leaseSeconds * 1000 / 3)));
    heartbeat.unref();
    try {
      await this.step(job, owner, controller.signal);
      if (leaseFailure) throw leaseFailure;
    } catch (error) {
      if (leaseFailure || error instanceof LostLeaseError) return this.store.get(job.id);
      const attempt = job.attempt + 1;
      const delay = this.config.backoffSeconds[Math.min(attempt - 1, this.config.backoffSeconds.length - 1)]!;
      this.store.transition(job.id, owner, job.state, {
        attempt,
        next_attempt_at: new Date(Date.now() + delay * 1000).toISOString(),
        last_error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      clearInterval(heartbeat);
      this.store.release(job.id, owner);
    }
    return this.store.get(job.id);
  }

  private async step(job: Job, owner: string, signal: AbortSignal): Promise<void> {
    switch (job.state) {
      case "EXTRACT": {
        const result = await this.revmagic.call(this.config.revmagic.extractTool, {
          url: job.source_url,
          ...(this.config.revmagic.outputDirectory
            ? { output_dir: this.config.revmagic.outputDirectory } : {}),
          ...(this.config.revmagic.optimize !== undefined
            ? { optimize: this.config.revmagic.optimize } : {})
        }, signal);
        const audioPath = findString(result, ["audio_path", "file_path", "path"]);
        if (!audioPath) throw new Error("RevMagic response did not contain an audio path");
        const receipt = await fileReceipt(audioPath);
        this.store.transition(job.id, owner, "DEDUP", {
          audio_path: receipt.path, audio_hash: receipt.hash, attempt: 0, last_error: null
        });
        return;
      }
      case "DEDUP": {
        if (!job.audio_hash) throw new Error("missing audio hash");
        const prior = this.store.artifact(job.audio_hash);
        if (prior && prior.job_id !== job.id) {
          const verified = await fileReceipt(prior.path);
          if (prior.artifact_hash && verified.hash === prior.artifact_hash && verified.size === prior.size) {
            this.store.transition(job.id, owner, "NOOP_VERIFIED", {
              artifact_path: prior.path, artifact_size: prior.size, artifact_hash: prior.artifact_hash
            });
            return;
          }
        }
        this.store.transition(job.id, owner, "CREATE_NOTEBOOK");
        return;
      }
      case "CREATE_NOTEBOOK": {
        const kind = "CREATE_NOTEBOOK";
        const marker = `revjob-${job.id}`;
        const afterCreateState = this.store.listSources(job.id).length ? "ADD_SOURCES" : "ADD_SOURCE";
        const effect = this.store.effect(job.id, kind);
        if (effect?.status === "APPLIED" && effect.response_json) {
          const response = JSON.parse(effect.response_json) as unknown;
          const notebookId = findString(response, ["notebook_id", "id"]);
          if (notebookId) {
            this.store.transition(job.id, owner, afterCreateState, { notebook_id: notebookId, last_error: null });
            return;
          }
        }
        if (effect) {
          const search = await this.notebook.call(this.config.notebooklm.searchTool, { query: marker }, signal);
          const matches = matchingNotebookIds(search, `Rev Content ${marker}`);
          if (matches.length > 1) {
            this.store.transition(job.id, owner, "NEEDS_ATTENTION", {
              last_error: `multiple notebooks match durable marker: ${marker}`
            });
            return;
          }
          if (matches.length === 1) {
            this.store.effectStatus(job.id, owner, kind, "APPLIED", search);
            this.store.transition(job.id, owner, afterCreateState, { notebook_id: matches[0], last_error: null });
            return;
          }
        }
        const token = effect?.token ?? randomUUID();
        this.store.intent(job.id, owner, kind, token);
        try {
          const created = await this.notebook.call(this.config.notebooklm.createTool, {
            name: `Rev Content ${marker}`
          }, signal);
          const notebookId = findString(created, ["notebook_id", "id"]);
          if (!notebookId) throw new Error("create_notebook response did not contain notebook id");
          this.store.effectStatus(job.id, owner, kind, "APPLIED", created);
          this.store.transition(job.id, owner, afterCreateState, { notebook_id: notebookId, last_error: null });
          return;
        } catch (error) {
          this.store.effectStatus(job.id, owner, kind, "AMBIGUOUS");
          throw error;
        }
      }
      case "ADD_SOURCES": {
        if (!job.notebook_id) throw new Error("missing notebook id");
        const source = this.store.listSources(job.id).find((item) => item.state === "PENDING");
        if (!source) {
          this.store.transition(job.id, owner, "WAIT_SOURCES", { attempt: 0, last_error: null });
          return;
        }
        const kind = `ADD_SOURCE:${source.sequence_no.toString().padStart(3, "0")}`;
        const effect = this.store.effect(job.id, kind);
        if (effect?.status === "APPLIED" || effect?.status === "CONFIRMED") {
          this.store.updateSource(job.id, owner, source.sequence_no, "ADDED");
          return;
        }
        if (effect) {
          const readiness = await this.notebook.call(this.config.notebooklm.waitTool, {
            notebook_id: job.notebook_id,
            source_names: [source.source_name],
            timeout_ms: 0
          }, signal);
          const status = exactSourceStatus(readiness, source.source_name);
          if (["ready", "processing"].includes(status ?? "")) {
            this.store.effectStatus(job.id, owner, kind, "APPLIED", readiness);
            this.store.updateSource(job.id, owner, source.sequence_no, "ADDED");
            return;
          }
        }
        const token = effect?.token ?? randomUUID();
        this.store.intent(job.id, owner, kind, token);
        try {
          const added = await this.notebook.call(this.config.notebooklm.addTool, {
            notebook_id: job.notebook_id,
            file_paths: [source.audio_path]
          }, signal);
          if (!hasText(added, source.audio_hash)) {
            throw new Error(`segment add receipt missing expected SHA256: ${source.sequence_no}`);
          }
          this.store.effectStatus(job.id, owner, kind, "APPLIED", added);
          this.store.updateSource(job.id, owner, source.sequence_no, "ADDED");
          return;
        } catch (error) {
          this.store.effectStatus(job.id, owner, kind, "AMBIGUOUS");
          throw error;
        }
      }
      case "ADD_SOURCE": {
        const kind = "ADD_SOURCE";
        if (!job.notebook_id || !job.audio_path || !job.audio_hash) throw new Error("missing add-source inputs");
        const sourceName = basename(job.audio_path);
        const effect = this.store.effect(job.id, kind);
        if (effect?.status === "APPLIED") {
          this.store.transition(job.id, owner, "WAIT_READY", { last_error: null });
          return;
        }
        if (effect) {
          const readiness = await this.notebook.call(this.config.notebooklm.waitTool, {
            notebook_id: job.notebook_id,
            ...(job.notebook_url ? { notebook_url: job.notebook_url } : {}),
            source_names: [job.source_name ?? sourceName],
            timeout_ms: 0
          }, signal);
          const status = findString(readiness, ["status", "state"])?.toLowerCase();
          if (["ready", "completed", "processing", "in_progress"].includes(status ?? "")) {
            this.store.effectStatus(job.id, owner, kind, "APPLIED", readiness);
            this.store.transition(job.id, owner, "WAIT_READY", {
              source_name: job.source_name ?? sourceName, last_error: null
            });
            return;
          }
        }
        const token = effect?.token ?? randomUUID();
        this.store.intent(job.id, owner, kind, token);
        try {
          const added = await this.notebook.call(this.config.notebooklm.addTool, {
            notebook_id: job.notebook_id,
            ...(job.notebook_url ? { notebook_url: job.notebook_url } : {}),
            file_paths: [job.audio_path]
          }, signal);
          const addedName = findString(added, ["source_name", "verified_source_name", "title", "name"]) ?? sourceName;
          this.store.effectStatus(job.id, owner, kind, "APPLIED", added);
          this.store.transition(job.id, owner, "WAIT_READY", { source_name: addedName, last_error: null });
          return;
        } catch (error) {
          this.store.effectStatus(job.id, owner, kind, "AMBIGUOUS");
          throw error;
        }
      }
      case "WAIT_SOURCES": {
        if (!job.notebook_id) throw new Error("missing notebook id");
        const sources = this.store.listSources(job.id);
        if (!sources.length) throw new Error("missing segment sources");
        const budget = this.readinessBudget(job);
        if (budget.exhausted) {
          this.store.transition(job.id, owner, "NEEDS_ATTENTION", {
            readiness_started_at: budget.startedAt,
            caveat: budget.message,
            last_error: budget.message
          });
          return;
        }
        const readiness = await this.notebook.call(this.config.notebooklm.waitTool, {
          notebook_id: job.notebook_id,
          source_names: sources.map((source) => source.source_name),
          timeout_ms: 0
        }, signal);
        const attempts = job.readiness_attempts + 1;
        const statuses = sources.map((source) => exactSourceStatus(readiness, source.source_name));
        if (statuses.some((status) => status === "error")) {
          this.store.transition(job.id, owner, "NEEDS_ATTENTION", {
            readiness_attempts: attempts,
            readiness_started_at: budget.startedAt,
            last_error: "one or more segment sources have a row-local NotebookLM error"
          });
        } else if (statuses.every((status) => status === "ready")) {
          for (const source of sources) {
            this.store.updateSource(job.id, owner, source.sequence_no, "READY");
          }
          this.store.transition(job.id, owner, "EXPORT_SOURCES", {
            attempt: 0,
            readiness_attempts: attempts,
            readiness_started_at: budget.startedAt,
            last_error: null
          });
        } else {
          this.deferReadiness(job, owner, "WAIT_SOURCES", attempts, budget.startedAt);
        }
        return;
      }
      case "WAIT_READY": {
        if (!job.notebook_id) throw new Error("missing notebook id");
        const budget = this.readinessBudget(job);
        if (budget.exhausted) {
          this.store.transition(job.id, owner, "NEEDS_ATTENTION", {
            readiness_started_at: budget.startedAt,
            caveat: budget.message,
            last_error: budget.message
          });
          return;
        }
        const result = await this.notebook.call(this.config.notebooklm.waitTool, {
          notebook_id: job.notebook_id,
          ...(job.notebook_url ? { notebook_url: job.notebook_url } : {}),
          source_names: [job.source_name ?? basename(job.audio_path!)],
          timeout_ms: 0
        }, signal);
        const attempts = job.readiness_attempts + 1;
        const status = findString(result, ["status", "state"])?.toLowerCase();
        if (status === "ready" || status === "completed") {
          this.store.transition(job.id, owner, "EXPORT", {
            attempt: 0,
            readiness_attempts: attempts,
            readiness_started_at: budget.startedAt,
            last_error: null
          });
        } else if (["failed", "error"].includes(status ?? "")) {
          this.store.transition(job.id, owner, "FAILED", {
            readiness_attempts: attempts,
            readiness_started_at: budget.startedAt,
            last_error: JSON.stringify(result)
          });
        } else {
          this.deferReadiness(job, owner, "WAIT_READY", attempts, budget.startedAt);
        }
        return;
      }
      case "EXPORT_SOURCES": {
        if (!job.notebook_id || !job.audio_hash) throw new Error("missing multi-source export inputs");
        const sources = this.store.listSources(job.id);
        const source = sources.find((item) => item.state !== "EXPORTED");
        if (!source) {
          await this.combineSegmentExports(job, owner, sources);
          return;
        }
        if (source.state !== "READY") throw new Error(`segment is not ready: ${source.sequence_no}`);
        const suffix = source.sequence_no.toString().padStart(3, "0");
        const kind = `EXPORT:${suffix}`;
        const outputName = `revjob-${job.id}-segment-${suffix}`;
        const expectedPath = join(this.config.notebooklm.exportDirectory, `${outputName}.md`);
        const effect = this.store.effect(job.id, kind);
        if (effect) {
          const recorded = effect.response_json ? JSON.parse(effect.response_json) as unknown : undefined;
          const path = effect.status === "APPLIED"
            ? findString(recorded, ["output_path", "artifact_path", "path"])
            : findString(recorded, ["expected_path"]);
          if (!path) {
            this.store.transition(job.id, owner, "NEEDS_ATTENTION", {
              last_error: `segment ${suffix} export cannot be reconciled`
            });
            return;
          }
          try {
            await this.completeSegmentExport(job, owner, source.sequence_no, path, recorded);
          } catch {
            this.store.transition(job.id, owner, "NEEDS_ATTENTION", {
              last_error: `segment ${suffix} export receipt is missing or invalid`
            });
          }
          return;
        }
        const token = randomUUID();
        this.store.intent(job.id, owner, kind, token, {
          output_name: outputName, expected_path: expectedPath
        });
        try {
          const result = await this.notebook.call(this.config.notebooklm.exportTool, {
            notebook_id: job.notebook_id,
            source_name: source.source_name,
            output_name: outputName,
            format: "markdown"
          }, signal);
          const path = findString(result, ["output_path", "artifact_path", "path"]);
          if (!path) throw new Error(`segment ${suffix} export response has no path`);
          this.store.effectStatus(job.id, owner, kind, "APPLIED", result);
          await this.completeSegmentExport(job, owner, source.sequence_no, path, result);
          return;
        } catch (error) {
          this.store.effectStatus(job.id, owner, kind, "AMBIGUOUS", {
            output_name: outputName, expected_path: expectedPath
          });
          throw error;
        }
      }
      case "EXPORT": {
        if (!job.notebook_id || !job.audio_path || !job.audio_hash) throw new Error("missing export inputs");
        const kind = "EXPORT";
        const effect = this.store.effect(job.id, kind);
        if (effect) {
          const recorded = effect.response_json ? JSON.parse(effect.response_json) as unknown : undefined;
          if (effect.status === "APPLIED" && recorded) {
            const path = findString(recorded, ["output_path", "artifact_path", "path"]);
            if (!path) {
              this.store.transition(job.id, owner, "NEEDS_ATTENTION", {
                last_error: "applied export effect has no receipt path"
              });
              return;
            }
            await this.completeExport(job, owner, path, recorded);
            return;
          }
          const expectedPath = findString(recorded, ["expected_path"]);
          if (!expectedPath) {
            this.store.transition(job.id, owner, "NEEDS_ATTENTION", {
              last_error: "ambiguous export has no deterministic receipt path"
            });
            return;
          }
          try {
            await fileReceipt(expectedPath);
          } catch {
            this.store.transition(job.id, owner, "NEEDS_ATTENTION", {
              last_error: `ambiguous export could not be reconciled at ${expectedPath}`
            });
            return;
          }
          await this.completeExport(job, owner, expectedPath, {
            verifiedComplete: false,
            caveat: "export response was lost; artifact reconciled from deterministic receipt path"
          });
          return;
        }
        const token = randomUUID();
        const outputName = `revjob-${job.id}`;
        const expectedPath = join(this.config.notebooklm.exportDirectory, `${outputName}.md`);
        this.store.intent(job.id, owner, kind, token, { output_name: outputName, expected_path: expectedPath });
        try {
          const result = await this.notebook.call(this.config.notebooklm.exportTool, {
            notebook_id: job.notebook_id,
            ...(job.notebook_url ? { notebook_url: job.notebook_url } : {}),
            source_name: job.source_name ?? basename(job.audio_path),
            output_name: outputName,
            format: "markdown"
          }, signal);
          const artifactPath = findString(result, ["output_path", "artifact_path", "path"]);
          if (!artifactPath) throw new Error("export response did not contain artifact path");
          this.store.effectStatus(job.id, owner, kind, "APPLIED", result);
          await this.completeExport(job, owner, artifactPath, result);
          return;
        } catch (error) {
          this.store.effectStatus(job.id, owner, kind, "AMBIGUOUS", {
            output_name: outputName, expected_path: expectedPath
          });
          throw error;
        }
      }
      default:
        if (!terminal.has(job.state)) throw new Error(`unknown state: ${job.state}`);
        return;
    }
  }

  private readinessBudget(job: Job): { exhausted: boolean; startedAt: string; message: string } {
    const startedAt = job.readiness_started_at ?? new Date().toISOString();
    const elapsedSeconds = Math.max(0, (Date.now() - Date.parse(startedAt)) / 1000);
    const exhausted = job.readiness_attempts >= this.config.readiness.maxAttempts ||
      elapsedSeconds >= this.config.readiness.maxElapsedSeconds;
    return {
      exhausted,
      startedAt,
      message: `NotebookLM readiness budget exceeded after ${job.readiness_attempts} polls; ` +
        "no upload or source creation was reissued"
    };
  }

  private deferReadiness(
    job: Job, owner: string, state: "WAIT_READY" | "WAIT_SOURCES",
    attempts: number, startedAt: string
  ): void {
    const elapsedSeconds = Math.max(0, (Date.now() - Date.parse(startedAt)) / 1000);
    if (attempts >= this.config.readiness.maxAttempts ||
        elapsedSeconds >= this.config.readiness.maxElapsedSeconds) {
      const message = `NotebookLM readiness budget exceeded after ${attempts} polls; ` +
        "no upload or source creation was reissued";
      this.store.transition(job.id, owner, "NEEDS_ATTENTION", {
        readiness_attempts: attempts,
        readiness_started_at: startedAt,
        caveat: message,
        last_error: message
      });
      return;
    }
    const delay = this.config.backoffSeconds[
      Math.min(attempts - 1, this.config.backoffSeconds.length - 1)
    ]!;
    this.store.transition(job.id, owner, state, {
      attempt: attempts,
      readiness_attempts: attempts,
      readiness_started_at: startedAt,
      next_attempt_at: new Date(Date.now() + delay * 1000).toISOString(),
      last_error: null
    });
  }

  private async completeExport(job: Job, owner: string, path: string, response: unknown): Promise<void> {
    if (!job.audio_hash) throw new Error("missing audio hash");
    const receipt = await fileReceipt(path);
    const verified = findBoolean(response, "verifiedComplete") === true;
    const caveat = verified ? null :
      findString(response, ["verification", "completeness", "caveat"]) ?? "export not independently verified";
    this.store.recordArtifact(
      job.audio_hash, receipt.hash, receipt.path, receipt.size, job.id, owner, verified
    );
    this.store.transition(job.id, owner, verified ? "COMPLETED" : "COMPLETED_WITH_CAVEAT", {
      artifact_path: receipt.path,
      artifact_size: receipt.size,
      artifact_hash: receipt.hash,
      caveat
    });
  }

  private async completeSegmentExport(
    job: Job, owner: string, sequence: number, path: string, response: unknown
  ): Promise<void> {
    const receipt = await fileReceipt(path);
    const verified = findBoolean(response, "verifiedComplete") === true;
    this.store.updateSource(job.id, owner, sequence, "EXPORTED", {
      artifact_path: receipt.path,
      artifact_size: receipt.size,
      artifact_hash: receipt.hash,
      caveat: verified ? null :
        findString(response, ["verification", "completeness", "caveat"]) ??
        "segment transcript not independently verified"
    });
  }

  private async combineSegmentExports(
    job: Job, owner: string, sources: ReturnType<Store["listSources"]>
  ): Promise<void> {
    if (!job.audio_hash || sources.some((source) => !source.artifact_path || !source.artifact_hash)) {
      throw new Error("segment receipts are incomplete");
    }
    await mkdir(this.config.notebooklm.exportDirectory, { recursive: true });
    const path = join(this.config.notebooklm.exportDirectory, `revjob-${job.id}-combined.md`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const sections: string[] = [
      "# Combined transcript",
      "",
      "> Segment boundaries are mechanical. No overlap or gap was inferred or repaired.",
      ""
    ];
    for (const source of sources) {
      const content = await readFile(source.artifact_path!, "utf8");
      sections.push(
        `<!-- segment=${source.sequence_no} audio_sha256=${source.audio_hash} transcript_sha256=${source.artifact_hash} -->`,
        `## Segment ${source.sequence_no + 1}`,
        "",
        content,
        ""
      );
    }
    await writeFile(temporary, sections.join("\n"), { mode: 0o600 });
    await rename(temporary, path);
    const receipt = await fileReceipt(path);
    this.store.recordArtifact(
      job.audio_hash, receipt.hash, receipt.path, receipt.size, job.id, owner, false
    );
    this.store.transition(job.id, owner, "COMPLETED_WITH_CAVEAT", {
      artifact_path: receipt.path,
      artifact_size: receipt.size,
      artifact_hash: receipt.hash,
      caveat: "ordered segment transcripts combined with explicit boundaries; overlap and gaps not independently verified"
    });
  }
}

function matchingNotebookIds(value: unknown, exactName: string): string[] {
  const matches: string[] = [];
  const visit = (entry: unknown): void => {
    if (!entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    const object = entry as Record<string, unknown>;
    const name = typeof object.name === "string" ? object.name :
      typeof object.title === "string" ? object.title : undefined;
    const id = typeof object.id === "string" ? object.id :
      typeof object.notebook_id === "string" ? object.notebook_id : undefined;
    if (name === exactName && id) matches.push(id);
    for (const child of Object.values(object)) visit(child);
  };
  visit(value);
  return [...new Set(matches)];
}

function findBoolean(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object[key] === "boolean") return object[key];
  for (const child of Object.values(object)) {
    const found = findBoolean(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function exactSourceStatus(value: unknown, exactName: string): string | undefined {
  let status: string | undefined;
  const visit = (entry: unknown): void => {
    if (status || !entry || typeof entry !== "object") return;
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child);
      return;
    }
    const object = entry as Record<string, unknown>;
    if (object.name === exactName && typeof object.status === "string") {
      status = object.status.toLowerCase();
      return;
    }
    for (const child of Object.values(object)) visit(child);
  };
  visit(value);
  return status;
}
