export type SandboxSize = 'small' | 'medium' | 'large';

export interface RayTraceOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class RayTraceError extends Error {
  status: number;
  code: string | null;
  topupUrl: string | null;
  body: unknown;
}

export interface SandboxSummary {
  id: string;
  name: string;
  status: string;
  size: SandboxSize;
  created: number;
  host?: string;
  release?: string;
  run_id?: string;
  paid_until?: number;
  restoring?: boolean;
  restored_from_archive?: boolean;
  restore_warning?: string;
  restore_error?: string;
}

export interface CreateSandboxOptions {
  name?: string;
  size?: SandboxSize;
  archive?: Uint8Array;
  files?: Record<string, string | Uint8Array>;
  dir?: string;
  /** Clone this repository and upload it: an https or ssh URL, or `owner/name` on GitHub. Uses this machine's git and its credentials. */
  repo?: string;
  /** With `repo`: the branch or tag to clone (default: the repository's default branch). */
  ref?: string;
  /**
   * With `repo` as a GitHub repository: after the upload, attach it and make
   * /workspace a clone of it on the branch the agent may push to
   * (`raytrace/<id[4:12]>/work`). Needs the RayTrace GitHub App installed on
   * it and connected on your account page. With `dir` or `files`, those are
   * what is uploaded and `repo` is only what it is connected to.
   */
  connect?: boolean;
  idempotencyKey?: string;
}

export interface ExecOptions {
  timeoutSeconds?: number;
  pollIntervalMs?: number;
  requestId?: string;
}

export interface ExecResult {
  commandId: string;
  state: 'completed' | 'cancelled' | 'timed_out' | 'interrupted';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
}

export interface UsageSummary {
  days: number;
  at: number;
  wallet: {
    balance_micros: number;
    balance_usd: number;
    paid_micros: number;
    matched_micros: number;
    refundable_micros: number;
    refundable_usd: number;
    burn_rate_micros_per_hour: number;
    low_balance: boolean;
  } | null;
  burn_rate_micros_per_hour: number;
  burn_rate_usd_per_hour: number;
  running_sandboxes: number;
  blocks_this_month: number;
  spend_this_month_micros: number;
  spend_this_month_usd: number;
  ledger: Array<{ id: string; amount_micros: number; amount_usd: number; kind: string; ref: string; created: number; note: string | null }>;
  spend_by_sandbox: Array<{ sandbox_id: string; name: string; size: SandboxSize; status: string; blocks: number; amount_micros: number; amount_usd: number; runs: number }>;
  spend_by_day: Array<{ day: string; blocks: number; amount_micros: number; amount_usd: number }>;
  runs: Array<{ id: string; sandbox_id: string; name: string; size: SandboxSize; started_at: number; stopped_at: number | null; paid_until: number; blocks_charged: number; stop_reason: string | null }>;
  archives: Array<{ sandbox_id: string; name: string; run_id: string; status: string; image_release: string; bytes: number | null; created: number; uploaded: number | null }>;
}

export interface ApiKeySummary {
  id: string;
  org_id: string;
  name: string;
  prefix: string;
  created_by: string | null;
  created: number;
  last_used: number | null;
  revoked: number | null;
}

export interface ApiKeyCreated extends ApiKeySummary {
  key: string;
}

export interface ConnectedRepo {
  /** owner/name */
  repo: string;
  /** The branch /workspace is on, under the only prefix the sandbox may push to. */
  branch: string;
  output: string;
}

export interface SandboxRepos {
  /** The GitHub repositories (owner/name) this sandbox's git may open. */
  list(): Promise<string[]>;
  /** Replaces the whole list; [] takes them all off. Each must be one the org's GitHub App is installed on. */
  set(repos: string[]): Promise<string[]>;
}

export class Sandbox {
  readonly id: string;
  readonly repos: SandboxRepos;
  /** Set by create({ connect: true }). */
  git?: ConnectedRepo;
  info: SandboxSummary;
  readonly status: string;
  readonly size: SandboxSize;
  readonly name: string;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  /** Attaches a GitHub repository and makes /workspace a clone of it (see CreateSandboxOptions.connect). */
  connectRepo(repo: string, options?: { ref?: string; commit?: string; timeoutSeconds?: number }): Promise<ConnectedRepo>;
  start(options?: { size?: SandboxSize; waitForRestore?: boolean; pollIntervalMs?: number }): Promise<SandboxSummary>;
  stop(): Promise<SandboxSummary>;
  keepAlive(minutes: number): Promise<Record<string, unknown>>;
  destroy(options?: { keepTraces?: boolean }): Promise<Record<string, unknown>>;
}

export class RayTraceClient {
  constructor(options?: RayTraceOptions);
  request(method: string, path: string, options?: { headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; data: any }>;
}

export class RayTrace {
  readonly client: RayTraceClient;
  readonly sandboxes: {
    list(): Promise<Sandbox[]>;
    get(id: string): Promise<Sandbox>;
    create(options: CreateSandboxOptions): Promise<Sandbox>;
  };
  readonly usage: {
    get(options?: { days?: number }): Promise<UsageSummary>;
  };
  readonly apiKeys: {
    create(name: string): Promise<ApiKeyCreated>;
    list(): Promise<ApiKeySummary[]>;
    revoke(id: string): Promise<{ id: string; revoked: boolean }>;
  };
  constructor(options?: RayTraceOptions);
}

export function buildTarGz(files: Record<string, string | Uint8Array>): Buffer;
export function archiveFromDirectory(dirPath: string): Buffer;
export function archiveFromRepo(repo: string, options?: { ref?: string }): Promise<Buffer>;
/** owner/name for owner/name or a github.com https or ssh URL; null for anything else. */
export function githubRepo(repo: string): string | null;
/** The branch a connected sandbox works on: raytrace/<id[4:12]>/work. */
export function workBranch(sandboxId: string): string;
/** The shell commands connectRepo runs in the sandbox. */
export function connectScript(options: { repo: string; sandboxId: string; ref?: string; commit?: string; dir?: string }): string;
export default RayTrace;
