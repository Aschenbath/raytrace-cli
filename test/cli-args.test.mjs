import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/raytrace.mjs', import.meta.url));

function run(t, args) {
  const home = mkdtempSync(join(tmpdir(), 'raytrace-cli-args-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, RAYTRACE_HOME: home, RAYTRACE_NO_UPDATE_CHECK: '1' },
  });
  assert.ifError(result.error);
  return result;
}

for (const args of [
  ['status', '--purge'], ['start', '--no-claude-code'], ['stop', '--yes'],
  ['open', '--openrouter-key', 'example'], ['doctor', '--no-start'],
  ['setup', '--purge'], ['uninstall', '--no-start'], ['status', 'extra'],
  ['auth', 'login', 'extra', '--x'], ['auth', 'status', 'extra'],
  ['auth', 'logout', '--yes'], ['key', '--remove'], ['key', 'openrouter', 'extra'],
  ['share', 'abc123', '--list'], ['share', '--list', '--revoke', 'abc123'],
  ['share', 'list', 'extra'], ['share', 'list', '--sandbox', 'local'],
  ['share', 'revoke', 'abc123', 'extra'], ['share', 'abc123', '--revoke', 'other'],
  ['share', 'revoke'], ['share', '--revoke', 'abc123', '--fork'],
]) {
  test(`invalid arguments: ${args.join(' ')}`, t => {
    const result = run(t, args);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes(`Usage: raytrace ${args[0]} `)
      || result.stderr.includes(`Usage: raytrace ${args[0]}\n`), result.stderr);
    assert.doesNotMatch(result.stderr, /On this machine:/);
    if (args.join(' ') === 'key --remove') {
      assert.match(result.stderr, /Usage: raytrace key <openrouter\|typesafe> --remove/);
    }
  });
}

for (const args of [['status'], ['auth', 'status'], ['key'], ['key', 'openrouter', '--remove']]) {
  test(`valid local arguments: ${args.join(' ')}`, t => {
    const result = run(t, args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stderr, /Usage:/);
  });
}

for (const args of [['share', '--list'], ['share', 'list'], ['share', '--revoke', 'abc123'], ['share', 'revoke', 'abc123']]) {
  test(`valid share mode reaches the sign-in check: ${args.join(' ')}`, t => {
    const result = run(t, args);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /sign.?in|auth login/i);
    assert.doesNotMatch(result.stderr, /Usage:/);
  });
}
