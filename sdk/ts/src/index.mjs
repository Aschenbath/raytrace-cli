// @raytrace-cli/sdk — Typed high-level SDK over RayTrace's frozen /v1 API.
import { randomBytes } from 'node:crypto';
import { RayTraceClient, RayTraceError, buildTarGz, archiveFromDirectory } from './client.mjs';

export { RayTraceClient, RayTraceError, buildTarGz, archiveFromDirectory };

const TERMINAL_STATES = new Set(['completed', 'cancelled', 'timed_out', 'interrupted']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeRequestId() {
  return `req_${randomBytes(12).toString('hex')}`;
}

export class Sandbox {
  constructor(client, info) {
    this._client = client;
    this.id = info.id;
    this.info = info;
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

  async create({ name = undefined, size = 'small', archive = undefined, files = undefined, dir = undefined, repo = undefined, idempotencyKey = undefined } = {}) {
    let payload = archive;
    if (!payload) {
      if (files) {
        payload = buildTarGz(files);
      } else if (dir) {
        payload = archiveFromDirectory(dir);
      } else if (repo) {
        payload = buildTarGz({ 'README.md': `# ${repo}\n` });
      } else {
        throw new Error('Provide one of { archive, files, dir, repo } to create a sandbox');
      }
    }
    const derivedName = name || (repo ? String(repo).split('/').filter(Boolean).pop() : 'sandbox');
    const cleanName = String(derivedName).replace(/[^A-Za-z0-9._ -]/g, '-').slice(0, 100) || 'sandbox';
    const headers = {
      'Content-Type': 'application/gzip',
      'X-RayTrace-Name': cleanName,
      'X-RayTrace-Size': size,
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const { data } = await this._client.request('POST', '/v1/sandboxes', { headers, body: payload });
    return new Sandbox(this._client, data);
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
