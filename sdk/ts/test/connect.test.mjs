import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectScript, githubRepo, workBranch } from '../src/client.mjs';
import { RayTrace, RayTraceError, Sandbox } from '../src/index.mjs';

const SID = 'rtp-' + '0123456789abcdef'.repeat(2);

test('githubRepo takes owner/name and github.com URLs, nothing else', () => {
  for (const [given, want] of [
    ['acme/app', 'acme/app'], ['acme/app.git', 'acme/app'], [' acme/app ', 'acme/app'],
    ['https://github.com/acme/app', 'acme/app'], ['https://github.com/acme/app.git', 'acme/app'],
    ['https://github.com/acme/app/', 'acme/app'], ['git@github.com:acme/app.git', 'acme/app'],
    ['ssh://git@github.com/acme/my.app.git', 'acme/my.app'], ['HTTPS://GitHub.com/Acme/App', 'Acme/App'],
  ]) assert.equal(githubRepo(given), want, given);
  for (const given of ['', null, 'app', 'acme/app/extra', 'https://gitlab.com/acme/app', 'gitlab.com/acme/app',
    'acme/..', '-acme/app', 'acme/app name', 'https://github.com/acme', 'http://github.com/acme/app', "acme/a'pp"]) {
    assert.equal(githubRepo(given), null, String(given));
  }
});

test('workBranch is under the push prefix the relay allows (raytrace/<id[4:12]>/)', () => {
  assert.equal(workBranch(SID), 'raytrace/01234567/work');
});

test('connectScript refuses what it cannot quote safely', () => {
  assert.throws(() => connectScript({ repo: 'not a repo', sandboxId: SID }), /Not a GitHub repository/);
  for (const ref of ['-x', 'a..b', 'a b', "a'b", '$(id)']) assert.throws(() => connectScript({ repo: 'acme/app', sandboxId: SID, ref }), /Not a branch/, ref);
  assert.throws(() => connectScript({ repo: 'acme/app', sandboxId: SID, commit: 'HEAD' }), /Not a commit/);
  const script = connectScript({ repo: 'https://github.com/acme/app.git', sandboxId: SID, ref: 'release/1.2' });
  assert.match(script, /^set -e\ncd '\/workspace'\n/);
  assert.match(script, /git remote add origin 'https:\/\/github\.com\/acme\/app\.git'/);
  assert.match(script, /git fetch -q --depth 1 origin 'release\/1\.2'\n/);
  assert.match(script, /git checkout -q -b 'raytrace\/01234567\/work'/);
});

const hasGit = spawnSync('git', ['--version']).status === 0;

/** A stand-in for GitHub: a bare repository that https://github.com/acme/app.git is rewritten to,
 * the way the sandbox's /etc/gitconfig rewrites it to the relay. */
function fakeGithub(t) {
  const root = mkdtempSync(join(tmpdir(), 'raytrace-connect-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const work = join(root, 'work');
  mkdirSync(work);
  git(work, '-c', 'init.defaultBranch=main', 'init', '-q');
  writeFileSync(join(work, 'app.js'), 'one\n');
  writeFileSync(join(work, '.env.example'), 'KEY=\n');
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'one');
  const first = git(work, 'rev-parse', 'HEAD');
  writeFileSync(join(work, 'app.js'), 'two\n');
  git(work, 'commit', '-qam', 'two');
  git(work, 'tag', 'v2');
  const bare = join(root, 'app.git');
  git(root, 'clone', '-q', '--bare', work, bare);
  git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  writeFileSync(env.GIT_CONFIG_GLOBAL, `[url "file://${bare}"]\n\tinsteadOf = https://github.com/acme/app.git\n[protocol "file"]\n\tallow = always\n`);
  // The sandbox's uploaded files: the project without .git and without .env.example (a secret-looking name).
  const sandbox = join(root, 'workspace');
  mkdirSync(sandbox);
  writeFileSync(join(sandbox, 'app.js'), 'two\n');
  const run = (options) => spawnSync('sh', ['-c', connectScript({ repo: 'acme/app', sandboxId: SID, dir: sandbox, ...options })], { env, encoding: 'utf8' });
  return { git, sandbox, first, run, head: git(work, 'rev-parse', 'HEAD') };
}

test('connectScript makes the uploaded files a clone of the GitHub repository, on the work branch', { skip: !hasGit && 'git not installed' }, (t) => {
  const { git, sandbox, run, head } = fakeGithub(t);
  const done = run({});
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /Connected to acme\/app on branch raytrace\/01234567\/work\. Push with: git push -u origin raytrace\/01234567\/work/);
  assert.equal(git(sandbox, 'rev-parse', 'HEAD'), head);
  assert.equal(git(sandbox, 'branch', '--show-current'), 'raytrace/01234567/work');
  assert.equal(git(sandbox, 'config', 'remote.origin.url'), 'https://github.com/acme/app.git');
  // Nothing to commit: the file the upload left out came back from the commit rather than showing as deleted.
  assert.equal(git(sandbox, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(sandbox, '.env.example'), 'utf8'), 'KEY=\n');
  // Run again (a retry): the repository is left as it is.
  const again = run({});
  assert.equal(again.status, 0);
  assert.match(again.stderr, /already a Git repository/);
});

test('connectScript keeps the uploaded changes as changes against the commit', { skip: !hasGit && 'git not installed' }, (t) => {
  const { git, sandbox, run, first } = fakeGithub(t);
  writeFileSync(join(sandbox, 'app.js'), 'mine\n');
  writeFileSync(join(sandbox, 'new.js'), 'new\n');
  const done = run({ commit: first });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(git(sandbox, 'rev-parse', 'HEAD'), first);
  assert.equal(readFileSync(join(sandbox, 'app.js'), 'utf8'), 'mine\n');
  assert.deepEqual(git(sandbox, 'status', '--porcelain').split('\n').map((line) => line.trim()).sort(), ['?? new.js', 'M app.js']);
});

test('connectScript falls back to the ref when GitHub does not have the commit (it was never pushed)', { skip: !hasGit && 'git not installed' }, (t) => {
  const { git, sandbox, run, head } = fakeGithub(t);
  const done = run({ commit: 'f'.repeat(40), ref: 'v2' });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(git(sandbox, 'rev-parse', 'HEAD'), head);
});

test('connectScript stops at the first failure: an unknown ref', { skip: !hasGit && 'git not installed' }, (t) => {
  const { sandbox, run } = fakeGithub(t);
  const done = run({ ref: 'no-such-branch' });
  assert.notEqual(done.status, 0);
  assert.match(done.stderr, /no-such-branch/);
  // No work branch was made, and the uploaded files are untouched.
  assert.notEqual(spawnSync('git', ['rev-parse', '--verify', 'raytrace/01234567/work'], { cwd: sandbox }).status, 0);
  assert.equal(readFileSync(join(sandbox, 'app.js'), 'utf8'), 'two\n');
});

function api(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const call = { method: init.method || 'GET', path: u.pathname, body: typeof init.body === 'string' ? JSON.parse(init.body) : null };
    calls.push(call);
    const [status, body] = (routes[`${call.method} ${call.path}`] || (() => [404, { error: 'Not found' }]))(call, calls);
    return new Response(JSON.stringify(body), { status });
  };
  return { rt: new RayTrace({ apiKey: 'k', baseUrl: 'https://api.test', fetchImpl }), calls };
}

test('sandbox.repos lists and replaces the attached GitHub repositories', async () => {
  const { rt, calls } = api({
    'GET /v1/sandboxes': () => [200, [{ id: SID, status: 'running' }]],
    [`GET /v1/sandboxes/${SID}/repos`]: () => [200, { id: SID, repos: ['acme/app'] }],
    [`PUT /v1/sandboxes/${SID}/repos`]: (call) => [200, { id: SID, repos: call.body.repos }],
  });
  const box = await rt.sandboxes.get(SID);
  assert.deepEqual(await box.repos.list(), ['acme/app']);
  assert.deepEqual(await box.repos.set(['https://github.com/acme/app.git', 'acme/lib']), ['acme/app', 'acme/lib']);
  assert.deepEqual(calls.at(-1), { method: 'PUT', path: `/v1/sandboxes/${SID}/repos`, body: { repos: ['acme/app', 'acme/lib'] } });
  assert.deepEqual(await box.repos.set([]), []);
  // Checked here before anything is sent.
  const sent = calls.length;
  await assert.rejects(box.repos.set(['gitlab.com/acme/app']), /Not a GitHub repository/);
  await assert.rejects(box.repos.set('acme/app'), /list/);
  assert.equal(calls.length, sent);
});

test("sandbox.repos.set passes on the API's refusal as it is", async () => {
  const message = 'Install the RayTrace GitHub App on acme/app and connect it on your account page first.';
  const { rt } = api({ [`PUT /v1/sandboxes/${SID}/repos`]: () => [400, { error: message }] });
  const box = new Sandbox(rt.client, { id: SID });
  await assert.rejects(box.repos.set(['acme/app']), (error) => error instanceof RayTraceError && error.status === 400 && error.message === message);
});

/** A sandbox API that creates SID and runs one command, answering it with `result`. */
function connectApi(result, { attached = [], putStatus = 200 } = {}) {
  return api({
    'POST /v1/sandboxes': () => [201, { id: SID, name: 'app', status: 'running' }],
    [`GET /v1/sandboxes/${SID}/repos`]: () => [200, { id: SID, repos: attached }],
    [`PUT /v1/sandboxes/${SID}/repos`]: (call) => (putStatus === 200 ? [200, { id: SID, repos: call.body.repos }]
      : [putStatus, { error: 'Install the RayTrace GitHub App on acme/app and connect it on your account page first.' }]),
    [`POST /v1/sandboxes/${SID}/commands`]: () => [202, { command_id: 'cmd-1', state: 'running' }],
    [`GET /v1/sandboxes/${SID}/commands/cmd-1`]: () => [200, { command_id: 'cmd-1', ...result }],
  });
}

test('create({ connect }) uploads, attaches the repository, then runs the setup in the sandbox', async () => {
  const { rt, calls } = connectApi({ state: 'completed', exit_code: 0, stdout: 'Connected\n', stderr: '' }, { attached: ['acme/lib'] });
  const box = await rt.sandboxes.create({ files: { 'app.js': 'x' }, repo: 'acme/app', ref: 'main', connect: true });
  assert.deepEqual(box.git, { repo: 'acme/app', branch: 'raytrace/01234567/work', output: 'Connected\n' });
  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ['POST /v1/sandboxes', `GET /v1/sandboxes/${SID}/repos`,
    `PUT /v1/sandboxes/${SID}/repos`, `POST /v1/sandboxes/${SID}/commands`, `GET /v1/sandboxes/${SID}/commands/cmd-1`]);
  // What was attached already stays attached.
  assert.deepEqual(calls[2].body, { repos: ['acme/lib', 'acme/app'] });
  const run = calls[3].body;
  assert.equal(run.command, connectScript({ repo: 'acme/app', sandboxId: SID, ref: 'main' }));
  assert.equal(run.timeout_seconds, 300);
});

test('connectRepo does not attach a repository twice', async () => {
  const { rt, calls } = connectApi({ state: 'completed', exit_code: 0, stdout: '', stderr: '' }, { attached: ['ACME/app'] });
  await new Sandbox(rt.client, { id: SID }).connectRepo('acme/app');
  assert.ok(!calls.some((call) => call.method === 'PUT'));
});

test('create({ connect }) checks the repository and ref before uploading anything', async () => {
  const { rt, calls } = connectApi({});
  await assert.rejects(rt.sandboxes.create({ files: { a: 'x' }, connect: true }), /connect needs repo/);
  await assert.rejects(rt.sandboxes.create({ files: { a: 'x' }, repo: 'https://gitlab.com/acme/app', connect: true }), /connect needs repo/);
  await assert.rejects(rt.sandboxes.create({ files: { a: 'x' }, repo: 'acme/app', ref: '--upload-pack=x', connect: true }), /Not a branch/);
  assert.equal(calls.length, 0);
});

test('a failed connect says the sandbox exists and hands it over', async () => {
  const failed = connectApi({ state: 'completed', exit_code: 128, stdout: '', stderr: "fatal: couldn't find remote ref nope\n" });
  const error = await failed.rt.sandboxes.create({ files: { a: 'x' }, repo: 'acme/app', ref: 'nope', connect: true }).catch((e) => e);
  assert.equal(error.message, `Sandbox ${SID} was created, but could not connect ${SID} to acme/app: fatal: couldn't find remote ref nope`);
  assert.equal(error.sandbox.id, SID);

  const refused = connectApi({}, { putStatus: 400 });
  const notInstalled = await refused.rt.sandboxes.create({ files: { a: 'x' }, repo: 'acme/app', connect: true }).catch((e) => e);
  assert.match(notInstalled.message, new RegExp(`^Sandbox ${SID} was created, but Install the RayTrace GitHub App on acme/app`));
  assert.equal(notInstalled.status, 400);
  assert.equal(notInstalled.sandbox.id, SID);
  assert.ok(!refused.calls.some((call) => call.path.endsWith('/commands')));
});

const hasPython = spawnSync('python3', ['--version']).status === 0;

test('the Python SDK runs the same setup script, byte for byte', { skip: !hasPython && 'python3 not installed' }, () => {
  const cases = [{ repo: 'acme/app' }, { repo: 'https://github.com/acme/app.git', ref: 'release/1.2' },
    { repo: 'git@github.com:acme/app', commit: 'a'.repeat(40), ref: 'v2' }, { repo: 'acme/app', dir: "/tmp/it's here" }];
  const python = spawnSync('python3', ['-I', '-c', `
import json, sys
sys.path.insert(0, sys.argv[1])
from raytrace_sdk.client import connect_script
print(json.dumps([connect_script(c['repo'], c['sandboxId'], ref=c.get('ref'), commit=c.get('commit'), directory=c.get('dir', '/workspace'))
                  for c in json.loads(sys.argv[2])]))`, new URL('../../python', import.meta.url).pathname,
  JSON.stringify(cases.map((c) => ({ ...c, sandboxId: SID })))], { encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr);
  assert.deepEqual(JSON.parse(python.stdout), cases.map((c) => connectScript({ ...c, sandboxId: SID })));
});
