import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectScript, githubRepo, localRepo, pushPrefix, workBranch } from '../src/github.mjs';
import * as sdk from '../sdk/ts/src/client.mjs';

const SID = 'rtp-' + '0123456789abcdef'.repeat(2);

test("the CLI's copy of the connect helpers is the SDKs'", () => {
  for (const repo of ['acme/app', 'https://github.com/acme/app.git', 'git@github.com:acme/app', 'gitlab.com/acme/app', 'acme/..', '']) {
    assert.equal(githubRepo(repo), sdk.githubRepo(repo), repo);
  }
  assert.equal(workBranch(SID), sdk.workBranch(SID));
  assert.ok(workBranch(SID).startsWith(pushPrefix(SID)));
  for (const options of [{ repo: 'acme/app' }, { repo: 'acme/app', ref: 'release/1.2' }, { repo: 'acme/app', commit: 'a'.repeat(40) },
    { repo: 'acme/app', commit: 'a'.repeat(40), ref: 'dev', dir: "/tmp/it's" }]) {
    assert.equal(connectScript({ ...options, sandboxId: SID }), sdk.connectScript({ ...options, sandboxId: SID }));
  }
  for (const ref of ['-x', 'a..b', "a'b"]) assert.throws(() => connectScript({ repo: 'acme/app', sandboxId: SID, ref }), /Not a branch/);
});

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'raytrace-local-repo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8' }).trim();
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  return { root, git };
}

test('localRepo reads the GitHub origin, the commit, and the branch only when origin has it', (t) => {
  const { root, git } = repo(t);
  assert.deepEqual(localRepo(root), { repo: null, commit: undefined, ref: undefined });
  writeFileSync(join(root, 'a'), 'a');
  git('add', 'a'); git('commit', '-qm', 'a');
  const head = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', 'git@github.com:acme/app.git');
  assert.deepEqual(localRepo(root), { repo: 'acme/app', commit: head, ref: undefined });
  // Origin has main as this machine last fetched it.
  git('update-ref', 'refs/remotes/origin/main', head);
  assert.deepEqual(localRepo(root), { repo: 'acme/app', commit: head, ref: 'main' });
  git('checkout', '-q', '-b', 'not-pushed');
  assert.deepEqual(localRepo(root), { repo: 'acme/app', commit: head, ref: undefined });
  git('remote', 'set-url', 'origin', 'https://gitlab.com/acme/app.git');
  assert.equal(localRepo(root).repo, null);
});
