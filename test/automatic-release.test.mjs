import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRelease, releaseBump } from '../.github/scripts/prepare-npm-release.mjs';

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

test('merged PR creates one atomic version commit and annotated tag; retry reuses them', t => {
  const f = fixture(t);
  assert.deepEqual(prepareRelease({ cwd: f.cwd, prNumber: 12, bump: 'patch' }), { tag: 'v0.13.1', reused: false });
  const commit = f.git('rev-parse', 'HEAD');
  assert.match(f.git('log', '-1', '--format=%B'), /Release-PR: #12/);
  assert.equal(f.git('rev-parse', 'v0.13.1^{}'), commit);
  assert.equal(f.git('rev-parse', 'origin/main'), commit);
  assert.equal(JSON.parse(readFileSync(join(f.cwd, 'package-lock.json'))).version, '0.13.1');
  assert.deepEqual(prepareRelease({ cwd: f.cwd, prNumber: 12, bump: 'patch' }), { tag: 'v0.13.1', reused: true });
  assert.equal(f.git('rev-parse', 'HEAD'), commit);
  assert.deepEqual(prepareRelease({ cwd: f.cwd, prNumber: 123, bump: 'minor' }), { tag: 'v0.14.0', reused: false });
  assert.deepEqual(prepareRelease({ cwd: f.cwd, prNumber: 124, bump: 'major' }), { tag: 'v1.0.0', reused: false });
});

test('a concurrent main update is preserved and retried without leaving a partial release', t => {
  const f = fixture(t);
  const other = join(f.root, 'other');
  f.gitAt(f.root, 'clone', '-b', 'main', f.remote, other);
  f.gitAt(other, 'config', 'user.name', 'Other merger');
  f.gitAt(other, 'config', 'user.email', 'other@example.invalid');
  // The pre-push hook simulates another PR landing after our version commit.
  // Export paths through the environment to avoid embedding shell-escaped paths.
  const hook = join(f.cwd, '.git/hooks/pre-push');
  writeFileSync(hook, '#!/bin/sh\nif [ ! -f "$RAYTRACE_RACE_MARKER" ]; then\n  touch "$RAYTRACE_RACE_MARKER"\n  echo Concurrent >> "$RAYTRACE_OTHER_REPO/README.md"\n  git -C "$RAYTRACE_OTHER_REPO" add README.md\n  git -C "$RAYTRACE_OTHER_REPO" commit -m "Other PR"\n  git -C "$RAYTRACE_OTHER_REPO" push origin main\nfi\n', { mode: 0o755 });
  const oldOther = process.env.RAYTRACE_OTHER_REPO;
  const oldMarker = process.env.RAYTRACE_RACE_MARKER;
  process.env.RAYTRACE_OTHER_REPO = other;
  process.env.RAYTRACE_RACE_MARKER = join(f.root, 'raced');
  try {
    assert.deepEqual(prepareRelease({ cwd: f.cwd, prNumber: 15, bump: 'patch' }), { tag: 'v0.13.1', reused: false });
    assert.match(readFileSync(join(f.cwd, 'README.md'), 'utf8'), /Concurrent/);
    assert.equal(f.git('log', '--format=%H', '--grep=^Release-PR: #15$').split('\n').length, 1);
    assert.equal(f.git('rev-parse', 'v0.13.1^{}'), f.git('rev-parse', 'origin/main'));
  } finally {
    if (oldOther === undefined) delete process.env.RAYTRACE_OTHER_REPO; else process.env.RAYTRACE_OTHER_REPO = oldOther;
    if (oldMarker === undefined) delete process.env.RAYTRACE_RACE_MARKER; else process.env.RAYTRACE_RACE_MARKER = oldMarker;
  }
});
