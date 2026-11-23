import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectScript, githubRepo, workBranch } from '../src/client.mjs';

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
