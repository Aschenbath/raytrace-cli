// @raytrace-cli/sdk — Typed high-level SDK over RayTrace's frozen /v1 API.
import { randomBytes } from 'node:crypto';
import { RayTraceClient, RayTraceError, buildTarGz, archiveFromDirectory, archiveFromRepo, repoName, githubRepo, workBranch, connectScript } from './client.mjs';

export { RayTraceClient, RayTraceError, buildTarGz, archiveFromDirectory, archiveFromRepo, githubRepo, workBranch, connectScript };

const TERMINAL_STATES = new Set(['completed', 'cancelled', 'timed_out', 'interrupted']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeRequestId() {
  return `req_${randomBytes(12).toString('hex')}`;
}

/** The GitHub repositories a sandbox's git may open (through its relay, with the org's GitHub App). */
class SandboxRepos {
  constructor(client, id) {
    this._client = client;
    this._path = `/v1/sandboxes/${encodeURIComponent(id)}/repos`;
  }

  async list() {
    const { data } = await this._client.request('GET', this._path);
    return data?.repos || [];
  }

  /** Replaces the whole list; [] takes them all off. Each must be one the org's GitHub App is installed on. */
  async set(repos) {
    if (!Array.isArray(repos)) throw new Error('repos.set takes a list of GitHub repositories (owner/name)');
    const names = repos.map((repo) => {
      const name = githubRepo(repo);
      if (!name) throw new Error(`Not a GitHub repository: ${repo} (use owner/name)`);
      return name;
    });
    const { data } = await this._client.request('PUT', this._path, { body: { repos: names } });
    return data?.repos || [];
  }
}

export class Sandbox {
  constructor(client, info) {
    this._client = client;
    this.id = info.id;
    this.info = info;
    this.repos = new SandboxRepos(client, info.id);
  }

  get status() { return this.info.status; }
  get size() { return this.info.size || 'small'; }
  get name() { return this.info.name; }

  async exec(command, { timeoutSeconds = 120, pollIntervalMs = 250, requestId = makeRequestId() } = {}) {
    const { data: created } = await this._client.request(
      'POST',
      `/v1/sandboxes/${encodeURIComponent(this.id)}/commands`,
      { body: { command, timeout_seconds: timeoutSeconds, request_id: requestId } },
    );
    let job = created;
    while (!TERMINAL_STATES.has(job.state)) {
      await sleep(pollIntervalMs);
      const { data: latest } = await this._client.request(
        'GET',
        `/v1/sandboxes/${encodeURIComponent(this.id)}/commands/${encodeURIComponent(job.command_id)}`,
      );
      job = latest;
    }
    return {
      commandId: job.command_id,
      state: job.state,
      exitCode: job.exit_code,
      stdout: job.stdout || '',
      stderr: job.stderr || '',
      timedOut: Boolean(job.timed_out),
      outputTruncated: Boolean(job.output_truncated),
    };
  }

  /**
   * Connects this sandbox to a GitHub repository: attaches it (keeping any
   * already attached), then makes /workspace a clone of it on the branch the
   * agent may push to (workBranch). `commit` lines the files up with that
   * commit when GitHub has it, else `ref`, else the default branch.
   */
  async connectRepo(repo, { ref = undefined, commit = undefined, timeoutSeconds = 300 } = {}) {
    const name = githubRepo(repo);
    if (!name) throw new Error(`Not a GitHub repository: ${repo} (use owner/name)`);
    const script = connectScript({ repo: name, sandboxId: this.id, ref, commit });
    const attached = await this.repos.list();
    if (!attached.some((other) => other.toLowerCase() === name.toLowerCase())) await this.repos.set([...attached, name]);
    const result = await this.exec(script, { timeoutSeconds });
    if (result.exitCode !== 0) {
      const why = result.stderr.trim() || result.stdout.trim() || `the setup command ended ${result.state}`;
      throw new RayTraceError(`Could not connect ${this.id} to ${name}: ${why}`, { body: result });
    }
    return { repo: name, branch: workBranch(this.id), output: result.stdout };
  }

  async start({ size = undefined, waitForRestore = true, pollIntervalMs = 500 } = {}) {
    const body = size ? { size } : {};
    const { status, data } = await this._client.request(
      'POST',
      `/v1/sandboxes/${encodeURIComponent(this.id)}/start`,
      { body },
    );
    this.info = { ...this.info, ...data };
    if (status === 202 && data?.restoring && waitForRestore) {
      while (true) {
        await sleep(pollIntervalMs);
        const { data: list } = await this._client.request('GET', '/v1/sandboxes');
        const current = (list || []).find(item => item.id === this.id);
        if (!current) break;
        this.info = current;
        if (current.status === 'running' || current.restore_error || current.status === 'archived') {
          if (current.restore_error) {
            throw new RayTraceError(`Archive restore failed: ${current.restore_error}`, { status: 500, body: current });
          }
          break;
        }
      }
    }
    return this.info;
  }

  async stop() {
    const { data } = await this._client.request('POST', `/v1/sandboxes/${encodeURIComponent(this.id)}/stop`);
    this.info = { ...this.info, ...data };
    return this.info;
  }

  async keepAlive(minutes) {
    const { data } = await this._client.request(
      'POST',
      `/v1/sandboxes/${encodeURIComponent(this.id)}/keep-alive`,
      { body: { minutes } },
    );
    return data;
  }

  async destroy({ keepTraces = false } = {}) {
    const qs = keepTraces ? '?keep_traces=1' : '';
    const { data } = await this._client.request('DELETE', `/v1/sandboxes/${encodeURIComponent(this.id)}${qs}`);
    this.info = { ...this.info, ...data, status: 'deleted' };
    return data;
  }
}

class SandboxesResource {
  constructor(client) {
    this._client = client;
  }

  async list() {
    const { data } = await this._client.request('GET', '/v1/sandboxes');
    return (data || []).map(item => new Sandbox(this._client, item));
  }

  async get(id) {
    const all = await this.list();
    const found = all.find(sb => sb.id === id);
    if (!found) throw new RayTraceError(`Sandbox not found: ${id}`, { status: 404 });
    return found;
  }

  async create({ name = undefined, size = 'small', archive = undefined, files = undefined, dir = undefined, repo = undefined, ref = undefined, connect = false, idempotencyKey = undefined } = {}) {
    if (connect) {
      // Checked before anything is uploaded: connectScript throws on a ref it would not run.
      if (!githubRepo(repo)) throw new Error('connect needs repo: a GitHub repository, as owner/name');
      connectScript({ repo, sandboxId: '', ref });
    }
    let payload = archive;
    if (!payload) {
      if (files) {
        payload = buildTarGz(files);
      } else if (dir) {
        payload = archiveFromDirectory(dir);
      } else if (repo) {
        payload = await archiveFromRepo(repo, { ref });
      } else {
        throw new Error('Provide one of { archive, files, dir, repo } to create a sandbox');
      }
    }
    const derivedName = name || (repo ? repoName(repo) : 'sandbox');
    const cleanName = String(derivedName).replace(/[^A-Za-z0-9._ -]/g, '-').slice(0, 100) || 'sandbox';
    const headers = {
      'Content-Type': 'application/gzip',
      'X-RayTrace-Name': cleanName,
      'X-RayTrace-Size': size,
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const { data } = await this._client.request('POST', '/v1/sandboxes', { headers, body: payload });
    const sandbox = new Sandbox(this._client, data);
    if (connect) {
      try {
        sandbox.git = await sandbox.connectRepo(repo, { ref });
      } catch (error) {
        // The sandbox exists either way: say so, and hand it over to retry or destroy.
        error.message = `Sandbox ${sandbox.id} was created, but ${error.message.replace(/^Could not/, 'could not')}`;
        error.sandbox = sandbox;
        throw error;
      }
    }
    return sandbox;
  }
}

class UsageResource {
  constructor(client) {
    this._client = client;
  }

  async get({ days = 30 } = {}) {
    const { data } = await this._client.request('GET', `/v1/usage?days=${encodeURIComponent(days)}`);
    return data;
  }
}

class ApiKeysResource {
  constructor(client) {
    this._client = client;
  }

  async create(name) {
    const { data } = await this._client.request('POST', '/v1/api-keys', { body: { name } });
    return data;
  }

  async list() {
    const { data } = await this._client.request('GET', '/v1/api-keys');
    return data?.keys || [];
  }

  async revoke(id) {
    const { data } = await this._client.request('DELETE', `/v1/api-keys/${encodeURIComponent(id)}`);
    return data;
  }
}

export class RayTrace {
  constructor(options = {}) {
    this.client = new RayTraceClient(options);
    this.sandboxes = new SandboxesResource(this.client);
    this.usage = new UsageResource(this.client);
    this.apiKeys = new ApiKeysResource(this.client);
  }
}

export default RayTrace;
