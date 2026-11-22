import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../src/api.mjs';
import { formatActionError, validateSize } from '../src/sandbox.mjs';

const BIN = fileURLToPath(new URL('../bin/raytrace.mjs', import.meta.url));
const BOX_ID = 'rtp-11111111111111111111111111111111';

test('validateSize accepts small/medium/large and rejects unknown sizes', () => {
  assert.equal(validateSize(undefined), null);
  assert.equal(validateSize('small'), 'small');
  assert.equal(validateSize('Medium'), 'medium');
  assert.equal(validateSize('LARGE'), 'large');
  assert.throws(() => validateSize('xl'), /Invalid sandbox size "xl"/);
});

test('formatActionError appends topup_url for 402 insufficient_balance and recording_plan_required', () => {
  const low = formatActionError(new ApiError('Not enough credits', {
    status: 402,
    data: { code: 'insufficient_balance', topup_url: 'https://raytracer.si/account.html#account-credits' },
  }));
  assert.match(low.message, /Top up sandbox credits at: https:\/\/raytracer\.si\/account\.html#account-credits/);

  const plan = formatActionError(new ApiError('Recording plan required', {
    status: 402,
    data: { code: 'recording_plan_required', topup_url: 'https://raytracer.si/account.html#account-plan' },
  }));
  assert.match(plan.message, /Upgrade to a recording plan first: https:\/\/raytracer\.si\/account\.html#account-plan/);

  const cap = formatActionError(new ApiError('No capacity for large', { status: 503, data: { code: 'no_capacity' } }));
  assert.match(cap.message, /Try a smaller --size/);
});

function withStubApi(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      handler(req, body, json, requests);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

function runCli(args, { cwd, apiUrl }) {
  const home = mkdtempSync(join(tmpdir(), 'rt-home-'));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        RAYTRACE_API_URL: apiUrl,
        RAYTRACE_API_KEY: 'rtk_test_key',
        RAYTRACE_NO_UPDATE_CHECK: '1',
        RAYTRACE_RESTORE_POLL_MS: '15',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function makeGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'rt-repo-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# hello\n');
  spawnSync('git', ['add', 'README.md'], { cwd: dir });
  return dir;
}

test('sandbox create --size large sends X-RayTrace-Size header', async () => {
  const stub = await withStubApi((req, _body, json) => {
    if (req.url === '/v1/beta/status') return json(200, { entitled: false });
    if (req.method === 'POST' && req.url === '/v1/sandboxes') {
      return json(201, { id: BOX_ID, size: req.headers['x-raytrace-size'], status: 'running', transcripts: true });
    }
    return json(404, { error: 'not found' });
  });
  try {
    const repo = makeGitRepo();
    const res = await runCli(['sandbox', 'create', '--size', 'large'], { cwd: repo, apiUrl: stub.url });
    assert.equal(res.code, 0, res.stderr);
    const post = stub.requests.find((r) => r.method === 'POST' && r.url === '/v1/sandboxes');
    assert.equal(post.headers['x-raytrace-size'], 'large');
    assert.match(res.stdout, new RegExp(`Sandbox ${BOX_ID} \\(large\\) is running`));
  } finally {
    await stub.close();
  }
});

test('sandbox start handles --size resize and 202 archive restore polling', async () => {
  let polls = 0;
  const stub = await withStubApi((req, body, json) => {
    if (req.method === 'POST' && req.url === `/v1/sandboxes/${BOX_ID}/start`) {
      const parsed = JSON.parse(body.toString('utf8'));
      assert.equal(parsed.size, 'medium');
      return json(202, { id: BOX_ID, status: 'starting', restoring: true, size: 'medium' });
    }
    if (req.method === 'GET' && req.url === '/v1/sandboxes') {
      polls += 1;
      if (polls === 1) return json(200, [{ id: BOX_ID, name: 'demo', status: 'starting', restoring: true, size: 'medium', created: Math.floor(Date.now() / 1000) }]);
      return json(200, [{
        id: BOX_ID, name: 'demo', status: 'running', restoring: false, size: 'medium',
        restored_from_archive: true, restore_warning: 'Sign in to Claude Code again.',
        created: Math.floor(Date.now() / 1000),
      }]);
    }
    return json(404, { error: 'not found' });
  });
  try {
    const res = await runCli(['sandbox', 'start', BOX_ID, '--size', 'medium'], { cwd: tmpdir(), apiUrl: stub.url });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /restoring from archive/i);
    assert.match(res.stdout, new RegExp(`${BOX_ID} \\(medium\\) running`));
    assert.match(res.stdout, /Sign in to Claude Code again/);
  } finally {
    await stub.close();
  }
});

test('sandbox keep-alive posts to /v1/sandboxes/<id>/keep-alive and list displays size & archived status', async () => {
  const stub = await withStubApi((req, _body, json) => {
    if (req.method === 'POST' && req.url === `/v1/sandboxes/${BOX_ID}/keep-alive`) {
      return json(200, { ok: true });
    }
    if (req.method === 'GET' && req.url === '/v1/sandboxes') {
      return json(200, [{ id: BOX_ID, name: 'archive-box', status: 'archived', size: 'large', created: Math.floor(Date.now() / 1000) - 600 }]);
    }
    return json(404, { error: 'not found' });
  });
  try {
    const ka = await runCli(['sandbox', 'keep-alive', BOX_ID], { cwd: tmpdir(), apiUrl: stub.url });
    assert.equal(ka.code, 0, ka.stderr);
    assert.match(ka.stdout, /idle auto-stop paused for 60 minutes/);

    const ls = await runCli(['sandbox', 'list'], { cwd: tmpdir(), apiUrl: stub.url });
    assert.equal(ls.code, 0, ls.stderr);
    assert.match(ls.stdout, /archived\s+large\s+archive-box/);
  } finally {
    await stub.close();
  }
});
