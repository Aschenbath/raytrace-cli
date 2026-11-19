import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ambiguousLocalSandboxMessage, logsChoice, missingLocalSandboxMessage } from '../src/local-sandbox.mjs';

test('a missing local sandbox name is quoted before the list command', () => {
  assert.equal(
    missingLocalSandboxMessage('my-box'),
    'No local sandbox named "my-box". List them with: raytrace sandbox list --local',
  );
});

test('an ambiguous local sandbox message names the list command separately', () => {
  assert.equal(
    ambiguousLocalSandboxMessage(),
    'More than one local sandbox. Name one with: raytrace sandbox list --local',
  );
});

test('logsChoice reads --delete-logs / --keep-logs and refuses both together', () => {
  assert.equal(logsChoice({ 'delete-logs': true }), true);
  assert.equal(logsChoice({ 'keep-logs': true }), false);
  assert.equal(logsChoice({}), null);
  assert.throws(() => logsChoice({ 'delete-logs': true, 'keep-logs': true }), /Pick one: --delete-logs or --keep-logs\./);
});

test('sandbox destroy with both --delete-logs and --keep-logs exits 2 before any sandbox lookup', () => {
  const home = mkdtempSync(join(tmpdir(), 'raytrace-destroy-flags-'));
  try {
    const run = spawnSync(process.execPath, ['bin/raytrace.mjs', 'sandbox', 'destroy', 'demo', '--delete-logs', '--keep-logs', '--yes'],
      { encoding: 'utf8', env: { ...process.env, RAYTRACE_HOME: home } });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /Pick one: --delete-logs or --keep-logs\./);
    assert.doesNotMatch(run.stderr, /No local sandbox|not found/i);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
