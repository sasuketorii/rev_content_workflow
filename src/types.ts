export type JobState =
  | "EXTRACT"
  | "DEDUP"
  | "CREATE_NOTEBOOK"
  | "ADD_SOURCE"
  | "ADD_SOURCES"
  | "WAIT_READY"
  | "WAIT_SOURCES"
  | "EXPORT"
  | "EXPORT_SOURCES"
  | "COMPLETED"
  | "COMPLETED_WITH_CAVEAT"
  | "NOOP_VERIFIED"
  | "NEEDS_ATTENTION"
  | "FAILED";

export interface ProcessConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  stderrMaxBytes?: number;
}

export interface Config {
  database: string;
  leaseSeconds: number;
  backoffSeconds: number[];
  readiness: {
    maxAttempts: number;
    maxElapsedSeconds: number;
  };
  revmagic: ProcessConfig & {
    extractTool: string;
    outputDirectory?: string;
    optimize?: boolean;
  };
  notebooklm: ProcessConfig & {
    createTool: string;
    searchTool: string;
    getTool: string;
    addTool: string;
    waitTool: string;
    exportTool: string;
    exportDirectory: string;
  };
}

export interface Job {
  id: string;
  idempotency_key: string;
  source_url: string;
  state: JobState;
  attempt: number;
  readiness_attempts: number;
  readiness_started_at: string | null;
  next_attempt_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  audio_path: string | null;
  audio_hash: string | null;
  notebook_id: string | null;
  notebook_url: string | null;
  source_name: string | null;
  artifact_path: string | null;
  artifact_size: number | null;
  artifact_hash: string | null;
  caveat: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  origin_job_id: string | null;
  generation: number;
}

export interface JobSource {
  job_id: string;
  sequence_no: number;
  audio_path: string;
  audio_hash: string;
  source_name: string;
  state: "PENDING" | "ADDED" | "READY" | "EXPORTED";
  artifact_path: string | null;
  artifact_size: number | null;
  artifact_hash: string | null;
  caveat: string | null;
  updated_at: string;
}
