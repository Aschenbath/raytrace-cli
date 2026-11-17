import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextVersion, prepareRelease, releaseBump } from '../.github/scripts/prepare-npm-release.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'raytrace-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'origin.git');
  const cwd = join(root, 'release');
  const gitAt = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  gitAt(root, 'init', '--bare', remote);
  mkdirSync(cwd);
  gitAt(cwd, 'init', '-b', 'main');
  gitAt(cwd, 'config', 'user.name', 'Release test');
  gitAt(cwd, 'config', 'user.email', 'release@example.invalid');
  const pkg = { name: '@raytrace-cli/cli', version: '0.13.0' };
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg, null, 2));
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({ ...pkg, lockfileVersion: 3, packages: { '': pkg } }, null, 2));
  writeFileSync(join(cwd, 'README.md'), 'Initial\n');
  gitAt(cwd, 'add', '.');
  gitAt(cwd, 'commit', '-m', 'Initial');
  gitAt(cwd, 'remote', 'add', 'origin', remote);
  gitAt(cwd, 'push', '-u', 'origin', 'main');
  return { root, remote, cwd, git: (...args) => gitAt(cwd, ...args), gitAt };
}

test('release labels default to patch and require an explicit unambiguous override', () => {
  assert.equal(releaseBump(['bug']), 'patch');
  for (const bump of ['patch', 'minor', 'major', 'skip']) assert.equal(releaseBump([`release:${bump}`]), bump);
  assert.throws(() => releaseBump(['release:minor', 'release:skip']), /at most one/);
  assert.throws(() => releaseBump(['release:typo']), /at most one/);
});

test('a merged PR is released as a tag on top of main, and main itself is not pushed to', t => {
  const f = fixture(t);
  const main = f.git('rev-parse', 'origin/main');
  assert.deepEqual(prepareRelease({ cwd: f.cwd, prNumber: 12, bump: 'patch' }), { tag: 'v0.13.1', reused: false });
  const commit = f.gitAt(f.remote, 'rev-parse', 'v0.13.1^{}');
  assert.match(f.gitAt(f.remote, 'log', '-1', '--format=%B', commit), /Release-PR: #12/);
  assert.equal(f.gitAt(f.remote, 'rev-parse', `${commit}^`), main, 'the version commit sits directly on main');
  assert.equal(f.gitAt(f.remote, 'rev-parse', 'main'), main, 'main is untouched');
  assert.equal(JSON.parse(f.gitAt(f.remote, 'show', 'v0.13.1:package.json')).version, '0.13.1');
  assert.equal(JSON.parse(f.gitAt(f.remote, 'show', 'v0.13.1:package-lock.json')).version, '0.13.1');
  assert.equal(JSON.parse(f.gitAt(f.remote, 'show', 'main:package.json')).version, '0.13.0');

  // A rerun for the same PR reuses its release.
  assert.deepEqual(prepareRelease({ cwd: f.cwd, prNumber: 12, bump: 'patch' }), { tag: 'v0.13.1', reused: true });
  assert.equal(f.gitAt(f.remote, 'rev-parse', 'v0.13.1^{}'), commit);

  // Later releases count from the highest tag, though package.json on main still says 0.13.0.
  assert.deepEqual(prepareRelease({ cwd: f.cwd, prNumber: 123, bump: 'minor' }), { tag: 'v0.14.0', reused: false });
  assert.deepEqual(prepareRelease({ cwd: f.cwd, prNumber: 124, bump: 'patch' }), { tag: 'v0.14.1', reused: false });
  assert.deepEqual(prepareRelease({ cwd: f.cwd, prNumber: 125, bump: 'major' }), { tag: 'v1.0.0', reused: false });
  assert.equal(f.gitAt(f.remote, 'rev-parse', 'v1.0.0^{}^'), main, 'each release starts from main, not from the release before it');
  assert.equal(f.gitAt(f.remote, 'rev-parse', 'main'), main);
});

test('a release carries what has merged into main since', t => {
  const f = fixture(t);
  prepareRelease({ cwd: f.cwd, prNumber: 1, bump: 'patch' });
  const other = join(f.root, 'other');
  f.gitAt(f.root, 'clone', '-b', 'main', f.remote, other);
  f.gitAt(other, 'config', 'user.name', 'Other merger');
  f.gitAt(other, 'config', 'user.email', 'other@example.invalid');
  writeFileSync(join(other, 'README.md'), 'Initial\nMerged later\n');
  f.gitAt(other, 'commit', '-am', 'Another PR');
  f.gitAt(other, 'push', 'origin', 'main');
  assert.deepEqual(prepareRelease({ cwd: f.cwd, prNumber: 2, bump: 'patch' }), { tag: 'v0.13.2', reused: false });
  assert.match(f.gitAt(f.remote, 'show', 'v0.13.2:README.md'), /Merged later/);
});

test('a version bumped on main by hand is the floor', t => {
  const f = fixture(t);
  const pkg = { name: '@raytrace-cli/cli', version: '0.20.0' };
  writeFileSync(join(f.cwd, 'package.json'), JSON.stringify(pkg, null, 2));
  writeFileSync(join(f.cwd, 'package-lock.json'), JSON.stringify({ ...pkg, lockfileVersion: 3, packages: { '': pkg } }, null, 2));
  f.git('commit', '-am', 'Bump by hand');
  f.git('push', 'origin', 'main');
  assert.deepEqual(prepareRelease({ cwd: f.cwd, prNumber: 7, bump: 'patch' }), { tag: 'v0.20.1', reused: false });
});

test('a version another release took first is passed over', t => {
  const f = fixture(t);
  // The pre-push hook stands in for another release landing v0.13.1 while ours was being made.
  // A plain tag: an annotated one needs a git identity, which a CI runner does not have.
  const hook = join(f.cwd, '.git/hooks/pre-push');
  writeFileSync(hook, '#!/bin/sh\nif [ ! -f "$RAYTRACE_RACE_MARKER" ]; then\n  touch "$RAYTRACE_RACE_MARKER"\n  git --git-dir="$RAYTRACE_REMOTE" tag v0.13.1 main\nfi\n', { mode: 0o755 });
  const old = [process.env.RAYTRACE_REMOTE, process.env.RAYTRACE_RACE_MARKER];
  process.env.RAYTRACE_REMOTE = f.remote;
  process.env.RAYTRACE_RACE_MARKER = join(f.root, 'raced');
  try {
    assert.deepEqual(prepareRelease({ cwd: f.cwd, prNumber: 15, bump: 'patch' }), { tag: 'v0.13.2', reused: false });
    assert.match(f.gitAt(f.remote, 'log', '-1', '--format=%B', 'v0.13.2^{}'), /Release-PR: #15/);
    assert.doesNotMatch(f.gitAt(f.remote, 'log', '-1', '--format=%B', 'v0.13.1^{}'), /Release-PR/);
  } finally {
    for (const [index, name] of ['RAYTRACE_REMOTE', 'RAYTRACE_RACE_MARKER'].entries()) {
      if (old[index] === undefined) delete process.env[name]; else process.env[name] = old[index];
    }
  }
});

test('the next version', () => {
  assert.equal(nextVersion('0.13.9', 'patch'), '0.13.10');
  assert.equal(nextVersion('0.13.9', 'minor'), '0.14.0');
  assert.equal(nextVersion('0.13.9', 'major'), '1.0.0');
});
