// `raytrace sandbox create --connect` and `raytrace sandbox repos`: the real
// CLI process, run in a real Git repository, against a fake RayTrace API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectScript } from '../src/github.mjs';

const SID = 'rtp-' + '0123456789abcdef'.repeat(2);
const BIN = new URL('../bin/raytrace.mjs', import.meta.url).pathname;
const CONNECTED = `Connected to acme/app on branch raytrace/01234567/work. Push with: git push -u origin raytrace/01234567/work\n`;

/** A fake RayTrace API. `state` holds the attached repositories and the answer to the next command. */
async function fakeApi(t, state) {
  const calls = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const json = req.headers['content-type'] === 'application/json' && raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, path: req.url, body: json });
      const route = `${req.method} ${req.url}`;
      let answer = [404, { error: 'Not found' }];
      if (route === 'POST /v1/sandboxes') answer = [201, { id: SID, name: 'app', size: 'small', status: 'running', transcripts: true }];
      else if (route === 'GET /v1/sandboxes') answer = [200, [{ id: SID, status: 'running' }]];
      else if (route === `GET /v1/sandboxes/${SID}/repos`) answer = [200, { id: SID, repos: state.repos }];
      else if (route === `PUT /v1/sandboxes/${SID}/repos`) {
        if (state.refuse) answer = [400, { error: state.refuse }];
        else { state.repos = json.repos; answer = [200, { id: SID, repos: state.repos }]; }
      } else if (route === `POST /v1/sandboxes/${SID}/commands`) answer = [202, { command_id: 'cmd-' + 'c'.repeat(32), ...state.command }];
      res.writeHead(answer[0], { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(answer[1]));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { calls, url: `http://127.0.0.1:${server.address().port}` };
}

/** A Git repository with one commit, its origin on GitHub, and main pushed (as this machine last saw it). */
function project(t, origin = 'git@github.com:acme/app.git') {
  const root = mkdtempSync(join(tmpdir(), 'raytrace-connect-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8' }).trim();
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  writeFileSync(join(root, 'app.js'), 'x\n');
  git('add', '.'); git('commit', '-qm', 'x');
  if (origin) git('remote', 'add', 'origin', origin);
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { root, head: git('rev-parse', 'HEAD') };
}

function raytrace(t, cwd, url, ...args) {
  const home = mkdtempSync(join(tmpdir(), 'raytrace-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const child = spawn(process.execPath, [BIN, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RAYTRACE_HOME: home, RAYTRACE_API_KEY: 'test-only-key', RAYTRACE_API_URL: url, RAYTRACE_NO_UPDATE_CHECK: '1', CI: '1' } });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
}

const routes = (calls) => calls.map((call) => `${call.method} ${call.path}`).filter((route) => !route.includes('/beta/'));

test('sandbox create --connect uploads, attaches the origin, and lines the sandbox up with this commit', async (t) => {
  const { root, head } = project(t);
  const state = { repos: [], command: { state: 'completed', exit_code: 0, stdout: CONNECTED, stderr: '' } };
  const api = await fakeApi(t, state);
  const done = await raytrace(t, root, api.url, 'sandbox', 'create', '--connect');
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(routes(api.calls), ['POST /v1/sandboxes', `GET /v1/sandboxes/${SID}/repos`, `PUT /v1/sandboxes/${SID}/repos`, `POST /v1/sandboxes/${SID}/commands`]);
  assert.deepEqual(state.repos, ['acme/app']);
  const run = api.calls.find((call) => call.path.endsWith('/commands')).body;
  assert.equal(run.command, connectScript({ repo: 'acme/app', sandboxId: SID, commit: head, ref: 'main' }));
  assert.match(done.stdout, /Connecting it to GitHub: acme\/app\.\.\./);
  assert.match(done.stdout, /\/workspace in rtp-\S+ is a clone of acme\/app on branch raytrace\/01234567\/work\. Agents in it push only to raytrace\/01234567\/<branch>; any other branch, main included, is refused\./);
});

test('sandbox create --connect --repo connects another repository, at its default branch', async (t) => {
  const { root } = project(t);
  const state = { repos: [], command: { state: 'completed', exit_code: 0, stdout: CONNECTED.replace('acme/app', 'acme/other'), stderr: '' } };
  const api = await fakeApi(t, state);
  const done = await raytrace(t, root, api.url, 'sandbox', 'create', '--connect', '--repo', 'https://github.com/acme/other');
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(state.repos, ['acme/other']);
  assert.equal(api.calls.find((call) => call.path.endsWith('/commands')).body.command, connectScript({ repo: 'acme/other', sandboxId: SID }));
});

test('sandbox create --connect refuses before uploading when there is no GitHub repository to connect', async (t) => {
  const { root } = project(t, 'https://gitlab.com/acme/app.git');
  const api = await fakeApi(t, { repos: [] });
  const done = await raytrace(t, root, api.url, 'sandbox', 'create', '--connect');
  assert.equal(done.code, 1);
  assert.match(done.stderr, /origin is not on GitHub\. Name the one to connect to: --repo owner\/name/);
  const bad = await raytrace(t, root, api.url, 'sandbox', 'create', '--connect', '--repo', 'gitlab.com/acme/app');
  assert.match(bad.stderr, /Not a GitHub repository: gitlab\.com\/acme\/app/);
  const local = await raytrace(t, root, api.url, 'sandbox', 'create', '--connect', '--local');
  assert.match(local.stderr, /cloud sandboxes only/);
  assert.deepEqual(routes(api.calls), []);
});

test('a refused connect says the sandbox exists, how to open it, and how to try again', async (t) => {
  const { root } = project(t);
  const refusal = 'Install the RayTrace GitHub App on acme/app and connect it on your account page first.';
  const api = await fakeApi(t, { repos: [], refuse: refusal });
  const done = await raytrace(t, root, api.url, 'sandbox', 'create', '--connect');
  assert.equal(done.code, 1);
  assert.match(done.stdout, new RegExp(`Open it:  raytrace connect ${SID}`));
  assert.ok(done.stderr.includes(`${SID} was created, but not connected to GitHub: ${refusal}\nAccount page: https://raytracer.si/account.html`), done.stderr);
  assert.ok(done.stderr.includes(`Try again: raytrace sandbox repos ${SID} --add acme/app --connect`), done.stderr);
  assert.ok(!api.calls.some((call) => call.path.endsWith('/commands')));
});

test('a failed setup command is reported with what git said', async (t) => {
  const { root } = project(t);
  const api = await fakeApi(t, { repos: [], command: { state: 'completed', exit_code: 128, stdout: '', stderr: 'fatal: GitHub did not let this sandbox reach acme/app.\n' } });
  const done = await raytrace(t, root, api.url, 'sandbox', 'create', '--connect');
  assert.equal(done.code, 1);
  assert.match(done.stderr, /was created, but not connected to GitHub: fatal: GitHub did not let this sandbox reach acme\/app\.\n/);
});

test('sandbox repos lists, adds and removes, keeping the rest', async (t) => {
  const { root } = project(t);
  const state = { repos: ['acme/app'] };
  const api = await fakeApi(t, state);
  let done = await raytrace(t, root, api.url, 'sandbox', 'repos');
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, new RegExp(`GitHub repositories ${SID} may open:\n  acme/app\nAgents in it push only to raytrace/01234567/<branch>`));
  done = await raytrace(t, root, api.url, 'sandbox', 'repos', SID, '--add', 'acme/lib', '--add', 'ACME/app');
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(state.repos, ['acme/app', 'acme/lib']);
  done = await raytrace(t, root, api.url, 'sandbox', 'repos', SID, '--remove', 'acme/APP');
  assert.deepEqual(state.repos, ['acme/lib']);
  done = await raytrace(t, root, api.url, 'sandbox', 'repos', SID, '--remove', 'acme/lib');
  assert.deepEqual(state.repos, []);
  assert.match(done.stdout, /No GitHub repositories attached to rtp-\S+\. Attach one: raytrace sandbox repos rtp-\S+ --add owner\/name/);
});

test('sandbox repos --add --connect attaches and clones, lined up with this repository when it is the one', async (t) => {
  const { root, head } = project(t);
  const state = { repos: ['acme/lib'], command: { state: 'completed', exit_code: 0, stdout: CONNECTED, stderr: '' } };
  const api = await fakeApi(t, state);
  const done = await raytrace(t, root, api.url, 'sandbox', 'repos', SID, '--add', 'acme/app', '--connect');
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(state.repos, ['acme/lib', 'acme/app']);
  assert.equal(api.calls.find((call) => call.path.endsWith('/commands')).body.command,
    connectScript({ repo: 'acme/app', sandboxId: SID, commit: head, ref: 'main' }));
  assert.match(done.stdout, /is a clone of acme\/app on branch raytrace\/01234567\/work\./);
});

test('sandbox repos says plainly when the sandbox was already a repository', async (t) => {
  const { root } = project(t);
  const api = await fakeApi(t, { repos: [], command: { state: 'completed', exit_code: 0, stdout: '',
    stderr: 'RayTrace: /workspace is already a Git repository; left as it is.\n' } });
  const done = await raytrace(t, root, api.url, 'sandbox', 'repos', SID, '--add', 'acme/app', '--connect');
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stdout, /acme\/app is attached to rtp-\S+\. \/workspace is already a Git repository; left as it is\./);
});

test('sandbox repos refuses what it cannot do, before calling RayTrace', async (t) => {
  const { root } = project(t);
  const api = await fakeApi(t, { repos: [] });
  for (const [args, message] of [
    [['--add', 'gitlab.com/a/b'], /Not a GitHub repository: gitlab\.com\/a\/b/],
    [['--connect'], /exactly one --add/],
    [['--add', 'a/b', '--add', 'c/d', '--connect'], /exactly one --add/],
    [['--local'], /cloud sandboxes only/],
  ]) {
    const done = await raytrace(t, root, api.url, 'sandbox', 'repos', SID, ...args);
    assert.equal(done.code, 1, args.join(' '));
    assert.match(done.stderr, message);
  }
  assert.deepEqual(api.calls, []);
});

test('an older RayTrace without repositories is named as such', async (t) => {
  const { root } = project(t);
  const api = await fakeApi(t, { repos: [] });
  const done = await raytrace(t, root, api.url, 'sandbox', 'repos', 'rtp-' + 'f'.repeat(32));
  assert.equal(done.code, 1);
  assert.match(done.stderr, /does not support GitHub repositories yet/);
});
