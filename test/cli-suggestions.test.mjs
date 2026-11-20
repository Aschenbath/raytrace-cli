import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closestCommand } from '../src/command-suggestion.mjs';

const home = mkdtempSync(join(tmpdir(), 'raytrace-suggestions-test-'));
after(() => rmSync(home, { recursive: true, force: true }));

test('suggestions cover completions, insertion, deletion, substitution and transposition', () => {
  const commands = ['start', 'status', 'stop'];
  for (const [input, expected] of [['stat', 'status'], ['start', 'start'], ['sstart', 'start'], ['sttus', 'status'], ['stptus', 'status'], ['strat', 'start']]) {
    assert.equal(closestCommand(input, commands), expected, input);
  }
  assert.equal(closestCommand('lst', ['create', 'list', 'shell']), 'list');
});

test('suggestions stop at two edits and only use the supplied command list', () => {
  assert.equal(closestCommand('stort', ['start']), 'start');
  assert.equal(closestCommand('axc', ['abc']), 'abc');
  assert.equal(closestCommand('axy', ['abc']), 'abc');
  assert.equal(closestCommand('xyz', ['abc']), undefined);
  assert.equal(closestCommand('', ['start']), undefined);
  assert.equal(closestCommand('status', []), undefined);
  assert.equal(closestCommand('status', ['create', 'list', 'shell']), undefined);
});

function run(...args) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/raytrace.mjs', import.meta.url)), ...args], {
    encoding: 'utf8', env: { ...process.env, RAYTRACE_HOME: home },
  });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  return result.stderr.trim();
}

test('a top-level typo suggests a command without the full help', () => {
  assert.equal(run('stat'), 'Unknown command: stat. Did you mean: raytrace status?\nRun raytrace help for all commands.');
});

test('a sandbox typo suggests only a sandbox command', () => {
  assert.equal(run('sandbox', 'lst'), 'Unknown sandbox command: lst. Did you mean: raytrace sandbox list?\nRun raytrace help for all commands.');
});

test('unrelated commands receive a short error without a suggestion', () => {
  assert.equal(run('unrelated-command'), 'Unknown command: unrelated-command.\nRun raytrace help for all commands.');
  assert.equal(run('sandbox', 'unrelated-command'), 'Unknown sandbox command: unrelated-command.\nRun raytrace help for all commands.');
});

test('a missing sandbox subcommand shows only sandbox usage', () => {
  const output = run('sandbox');
  assert.match(output, /^Usage: raytrace sandbox <command>/);
  for (const command of ['create', 'list', 'shell', 'start', 'destroy', 'files']) {
    assert.ok(output.includes(`raytrace sandbox ${command}`), command);
  }
  assert.doesNotMatch(output, /raytrace setup|raytrace auth|Unknown sandbox command/);
  assert.ok(output.split('\n').length < 15);
});
