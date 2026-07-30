import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Job, JobSource, JobState } from "./types.js";
import { isoNow } from "./util.js";

export class LostLeaseError extends Error {
  constructor(id: string) {
    super(`lost or expired job lease: ${id}`);
    this.name = "LostLeaseError";
  }
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, source_url TEXT NOT NULL,
        state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
        readiness_attempts INTEGER NOT NULL DEFAULT 0, readiness_started_at TEXT,
        next_attempt_at TEXT NOT NULL,
        lease_owner TEXT, lease_expires_at TEXT, audio_path TEXT, audio_hash TEXT,
        notebook_id TEXT, notebook_url TEXT, source_name TEXT,
        artifact_path TEXT, artifact_size INTEGER, artifact_hash TEXT, caveat TEXT, last_error TEXT,
        origin_job_id TEXT, generation INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_runnable ON jobs(state, next_attempt_at, lease_expires_at);
      CREATE TABLE IF NOT EXISTS effects (
        job_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, token TEXT NOT NULL,
        response_json TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(job_id, kind),
        FOREIGN KEY(job_id) REFERENCES jobs(id)
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        hash TEXT PRIMARY KEY, artifact_hash TEXT, verified INTEGER NOT NULL DEFAULT 0,
        path TEXT NOT NULL, size INTEGER NOT NULL, job_id TEXT NOT NULL,
        verified_at TEXT NOT NULL, FOREIGN KEY(job_id) REFERENCES jobs(id)
      );
      CREATE TABLE IF NOT EXISTS job_sources (
        job_id TEXT NOT NULL, sequence_no INTEGER NOT NULL, audio_path TEXT NOT NULL,
        audio_hash TEXT NOT NULL, source_name TEXT NOT NULL, state TEXT NOT NULL,
        artifact_path TEXT, artifact_size INTEGER, artifact_hash TEXT, caveat TEXT,
        updated_at TEXT NOT NULL, PRIMARY KEY(job_id,sequence_no),
        UNIQUE(job_id,audio_hash), FOREIGN KEY(job_id) REFERENCES jobs(id)
      );
    `);
    const artifactColumns = this.db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
    if (!artifactColumns.some((column) => column.name === "artifact_hash")) {
      this.db.exec("ALTER TABLE artifacts ADD COLUMN artifact_hash TEXT");
    }
    if (!artifactColumns.some((column) => column.name === "verified")) {
      this.db.exec("ALTER TABLE artifacts ADD COLUMN verified INTEGER NOT NULL DEFAULT 0");
    }
    const jobColumns = this.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    if (!jobColumns.some((column) => column.name === "source_name")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN source_name TEXT");
    }
    if (!jobColumns.some((column) => column.name === "notebook_url")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN notebook_url TEXT");
    }
    if (!jobColumns.some((column) => column.name === "origin_job_id")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN origin_job_id TEXT");
    }
    if (!jobColumns.some((column) => column.name === "generation")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN generation INTEGER NOT NULL DEFAULT 1");
    }
    if (!jobColumns.some((column) => column.name === "readiness_attempts")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN readiness_attempts INTEGER NOT NULL DEFAULT 0");
    }
    if (!jobColumns.some((column) => column.name === "readiness_started_at")) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN readiness_started_at TEXT");
    }
  }

  submit(url: string, key: string): Job {
    const now = isoNow();
    this.db.prepare(`INSERT OR IGNORE INTO jobs
      (id,idempotency_key,source_url,state,next_attempt_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), key, url, "EXTRACT", now, now, now);
    return this.getByKey(key)!;
  }
  adopt(input: {
    url: string;
    key: string;
    audioPath: string;
    audioHash: string;
    notebookId: string;
    notebookUrl: string;
    sourceName: string;
    notebookEvidence: unknown;
    sourceEvidence: unknown;
    initialState: "WAIT_READY" | "NEEDS_ATTENTION";
    lastError?: string;
  }): Job {
    const now = isoNow();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getByKey(input.key);
      if (existing) {
        const same = existing.source_url === input.url &&
          existing.audio_path === input.audioPath &&
          existing.audio_hash === input.audioHash &&
          existing.notebook_id === input.notebookId &&
          existing.notebook_url === input.notebookUrl &&
          existing.source_name === input.sourceName;
        if (!same) throw new Error(`idempotency key conflicts with existing adopted job: ${input.key}`);
        this.db.exec("COMMIT");
        return existing;
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO jobs
        (id,idempotency_key,source_url,state,next_attempt_at,audio_path,audio_hash,
         notebook_id,notebook_url,source_name,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          id, input.key, input.url, input.initialState, now, input.audioPath, input.audioHash,
          input.notebookId, input.notebookUrl, input.sourceName, now, now
        );
      if (input.lastError) {
        this.db.prepare("UPDATE jobs SET last_error=? WHERE id=?").run(input.lastError, id);
      }
      const effect = this.db.prepare(`INSERT INTO effects
        (job_id,kind,status,token,response_json,updated_at) VALUES(?,?,?,?,?,?)`);
      effect.run(
        id, "CREATE_NOTEBOOK", "CONFIRMED", `adopt-notebook:${input.notebookId}`,
        JSON.stringify(input.notebookEvidence), now
      );
      effect.run(
        id, "ADD_SOURCE", "CONFIRMED", `adopt-source:${input.audioHash}`,
        JSON.stringify(input.sourceEvidence), now
      );
      this.db.exec("COMMIT");
      return this.get(id)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  recoverWithReplacement(input: {
    originJobId: string;
    key: string;
    audioPath: string;
    audioHash: string;
  }): Job {
    const now = isoNow();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const origin = this.get(input.originJobId);
      if (!origin) throw new Error(`unknown origin job: ${input.originJobId}`);
      if (origin.state !== "NEEDS_ATTENTION") {
        throw new Error(`origin job must be NEEDS_ATTENTION, got ${origin.state}`);
      }
      if (!origin.audio_hash) throw new Error("origin job has no verified audio hash");
      if (origin.audio_hash === input.audioHash) {
        throw new Error("replacement audio must have a different SHA256 from the failed origin");
      }
      const existing = this.getByKey(input.key);
      if (existing) {
        const same = existing.origin_job_id === origin.id &&
          existing.audio_path === input.audioPath &&
          existing.audio_hash === input.audioHash;
        if (!same) throw new Error(`idempotency key conflicts with existing recovery job: ${input.key}`);
        this.db.exec("COMMIT");
        return existing;
      }
      const id = randomUUID();
      const generation = this.nextGeneration(origin.source_url);
      this.db.prepare(`INSERT INTO jobs
        (id,idempotency_key,source_url,state,next_attempt_at,audio_path,audio_hash,
         origin_job_id,generation,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          id, input.key, origin.source_url, "CREATE_NOTEBOOK", now, input.audioPath, input.audioHash,
          origin.id, generation, now, now
        );
      this.db.exec("COMMIT");
      return this.get(id)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  recoverWithSegments(input: {
    originJobId: string;
    key: string;
    segments: Array<{ audioPath: string; audioHash: string; sourceName: string }>;
  }): Job {
    if (input.segments.length < 2 || input.segments.length > 10) {
      throw new Error("segment recovery requires 2..10 ordered files");
    }
    if (new Set(input.segments.map((segment) => segment.audioHash)).size !== input.segments.length) {
      throw new Error("segment hashes must be unique");
    }
    const now = isoNow();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const origin = this.get(input.originJobId);
      if (!origin) throw new Error(`unknown origin job: ${input.originJobId}`);
      if (!["WAIT_READY", "NEEDS_ATTENTION"].includes(origin.state)) {
        throw new Error(`origin job must be WAIT_READY or NEEDS_ATTENTION, got ${origin.state}`);
      }
      const digest = createHash("sha256")
        .update(input.segments.map((segment) => segment.audioHash).join("\n")).digest("hex");
      const existing = this.getByKey(input.key);
      if (existing) {
        const sources = this.listSources(existing.id);
        const same = existing.origin_job_id === origin.id && existing.audio_hash === digest &&
          sources.length === input.segments.length &&
          sources.every((source, index) =>
            source.audio_path === input.segments[index]!.audioPath &&
            source.audio_hash === input.segments[index]!.audioHash);
        if (!same) throw new Error(`idempotency key conflicts with existing segment job: ${input.key}`);
        this.db.exec("COMMIT");
        return existing;
      }
      const id = randomUUID();
      const generation = this.nextGeneration(origin.source_url);
      this.db.prepare(`INSERT INTO jobs
        (id,idempotency_key,source_url,state,next_attempt_at,audio_hash,
         origin_job_id,generation,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(
          id, input.key, origin.source_url, "CREATE_NOTEBOOK", now, digest,
          origin.id, generation, now, now
        );
      const insert = this.db.prepare(`INSERT INTO job_sources
        (job_id,sequence_no,audio_path,audio_hash,source_name,state,updated_at)
        VALUES (?,?,?,?,?,'PENDING',?)`);
      input.segments.forEach((segment, index) =>
        insert.run(id, index, segment.audioPath, segment.audioHash, segment.sourceName, now));
      this.db.exec("COMMIT");
      return this.get(id)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  listSources(jobId: string): JobSource[] {
    return this.db.prepare("SELECT * FROM job_sources WHERE job_id=? ORDER BY sequence_no")
      .all(jobId) as unknown as JobSource[];
  }
  updateSource(
    jobId: string, owner: string, sequence: number,
    state: JobSource["state"], fields: Record<string, unknown> = {}
  ): void {
    this.withLease(jobId, owner, () => {
      const entries = Object.entries({ ...fields, state, updated_at: isoNow() });
      const result = this.db.prepare(`UPDATE job_sources SET
        ${entries.map(([key]) => `${key}=?`).join(",")}
        WHERE job_id=? AND sequence_no=?`)
        .run(...entries.map(([, value]) => value), jobId, sequence);
      if (result.changes !== 1) throw new Error(`unknown job source ${jobId}:${sequence}`);
    });
  }
  get(id: string): Job | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as unknown as Job | undefined;
  }
  getByKey(key: string): Job | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE idempotency_key=?").get(key) as unknown as Job | undefined;
  }
  list(): Job[] {
    return this.db.prepare("SELECT * FROM jobs ORDER BY created_at").all() as unknown as Job[];
  }
  acquire(owner: string, leaseSeconds: number, id?: string): Job | undefined {
    const now = isoNow();
    const expires = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const filter = id ? "AND id=?" : "";
      const params = id ? [now, now, id] : [now, now];
      const row = this.db.prepare(`SELECT id FROM jobs WHERE state NOT IN
        ('COMPLETED','COMPLETED_WITH_CAVEAT','NOOP_VERIFIED','NEEDS_ATTENTION','FAILED')
        AND next_attempt_at<=? AND (lease_expires_at IS NULL OR lease_expires_at<=?) ${filter}
        ORDER BY next_attempt_at, created_at LIMIT 1`).get(...params) as { id: string } | undefined;
      if (!row) { this.db.exec("COMMIT"); return undefined; }
      this.db.prepare("UPDATE jobs SET lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=?")
        .run(owner, expires, now, row.id);
      this.db.exec("COMMIT");
      return this.get(row.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  transition(id: string, owner: string, state: JobState, fields: Record<string, unknown> = {}): void {
    const entries = Object.entries({ ...fields, state, updated_at: isoNow() });
    const setters = entries.map(([key]) => `${key}=?`).join(",");
    const result = this.db.prepare(`UPDATE jobs SET ${setters}
      WHERE id=? AND lease_owner=? AND lease_expires_at>?`)
      .run(...entries.map(([, value]) => value), id, owner, isoNow());
    if (result.changes !== 1) throw new LostLeaseError(id);
  }
  reschedule(id: string): void {
    const now = isoNow();
    const result = this.db.prepare(`UPDATE jobs SET next_attempt_at=?,updated_at=?
      WHERE id=? AND (lease_expires_at IS NULL OR lease_expires_at<=?)`).run(now, now, id, now);
    if (result.changes !== 1) throw new Error(`job has an active lease: ${id}`);
  }
  fenceBeforeEffects(id: string, reason: string): Job {
    const now = isoNow();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.get(id);
      if (!job) throw new Error(`unknown job: ${id}`);
      if (["COMPLETED", "COMPLETED_WITH_CAVEAT", "NOOP_VERIFIED", "NEEDS_ATTENTION", "FAILED"]
        .includes(job.state)) {
        throw new Error(`cannot pre-effect fence terminal job in ${job.state}`);
      }
      if (job.lease_expires_at && job.lease_expires_at > now) {
        throw new Error(`job has an active lease: ${id}`);
      }
      const effects = this.db.prepare("SELECT COUNT(*) AS count FROM effects WHERE job_id=?")
        .get(id) as { count: number };
      if (effects.count !== 0) {
        throw new Error(`cannot pre-effect fence job with ${effects.count} recorded effect(s): ${id}`);
      }
      const result = this.db.prepare(`UPDATE jobs SET
        state='NEEDS_ATTENTION',last_error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=?
        WHERE id=?`).run(reason, now, id);
      if (result.changes !== 1) throw new Error(`unknown job: ${id}`);
      this.db.exec("COMMIT");
      return this.get(id)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  fence(id: string, reason: string): Job {
    const now = isoNow();
    const result = this.db.prepare(`UPDATE jobs SET
      state='NEEDS_ATTENTION',last_error=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=?
      WHERE id=? AND state NOT IN
      ('COMPLETED','COMPLETED_WITH_CAVEAT','NOOP_VERIFIED','NEEDS_ATTENTION','FAILED')
      AND (lease_expires_at IS NULL OR lease_expires_at<=?)`)
      .run(reason, now, id, now);
    if (result.changes !== 1) {
      throw new Error(`job is terminal, unknown, or has an active lease: ${id}`);
    }
    return this.get(id)!;
  }
  release(id: string, owner: string): void {
    this.db.prepare(`UPDATE jobs SET lease_owner=NULL,lease_expires_at=NULL,updated_at=?
      WHERE id=? AND lease_owner=?`).run(isoNow(), id, owner);
  }
  renew(id: string, owner: string, leaseSeconds: number): void {
    const now = isoNow();
    const expires = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const result = this.db.prepare(`UPDATE jobs SET lease_expires_at=?,updated_at=?
      WHERE id=? AND lease_owner=? AND lease_expires_at>?`).run(expires, now, id, owner, now);
    if (result.changes !== 1) throw new Error(`lost job lease: ${id}`);
  }
  effect(id: string, kind: string): { status: string; token: string; response_json: string | null } | undefined {
    return this.db.prepare("SELECT status,token,response_json FROM effects WHERE job_id=? AND kind=?")
      .get(id, kind) as { status: string; token: string; response_json: string | null } | undefined;
  }
  intent(id: string, owner: string, kind: string, token: string, planned?: unknown): void {
    this.withLease(id, owner, () => {
      this.db.prepare(`INSERT INTO effects(job_id,kind,status,token,response_json,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(job_id,kind) DO UPDATE SET status='INTENT',
        response_json=excluded.response_json,updated_at=excluded.updated_at`)
        .run(id, kind, "INTENT", token, planned === undefined ? null : JSON.stringify(planned), isoNow());
    });
  }
  effectStatus(id: string, owner: string, kind: string, status: string, response?: unknown): void {
    this.withLease(id, owner, () => {
      this.db.prepare("UPDATE effects SET status=?,response_json=?,updated_at=? WHERE job_id=? AND kind=?")
        .run(status, response === undefined ? null : JSON.stringify(response), isoNow(), id, kind);
    });
  }
  artifact(hash: string): { path: string; size: number; job_id: string; artifact_hash: string | null } | undefined {
    return this.db.prepare(`SELECT path,size,job_id,artifact_hash FROM artifacts
      WHERE hash=? AND verified=1`).get(hash) as any;
  }
  recordArtifact(
    hash: string, artifactHash: string, path: string, size: number,
    jobId: string, owner: string, verified: boolean
  ): void {
    this.withLease(jobId, owner, () => {
      this.db.prepare(`INSERT OR REPLACE INTO artifacts
        (hash,artifact_hash,verified,path,size,job_id,verified_at) VALUES(?,?,?,?,?,?,?)`)
        .run(hash, artifactHash, verified ? 1 : 0, path, size, jobId, isoNow());
    });
  }
  private assertLease(id: string, owner: string): void {
    const row = this.db.prepare(`SELECT 1 AS ok FROM jobs
      WHERE id=? AND lease_owner=? AND lease_expires_at>?`).get(id, owner, isoNow());
    if (!row) throw new LostLeaseError(id);
  }
  private nextGeneration(sourceUrl: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(generation),0) AS generation FROM jobs WHERE source_url=?")
      .get(sourceUrl) as { generation: number };
    return row.generation + 1;
  }
  private withLease(id: string, owner: string, operation: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertLease(id, owner);
      operation();
      this.assertLease(id, owner);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void { this.db.close(); }
}
