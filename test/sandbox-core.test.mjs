import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setupFiles } from '../src/local-sandbox.mjs';

// The sandbox core (worker/sandbox/) runs on a Linux host under Python; its tests are Python too.
const root = fileURLToPath(new URL('..', import.meta.url));
const core = fileURLToPath(new URL('../worker/sandbox/', import.meta.url));
const python = spawnSync('python3', ['--version']);

test('the sandbox core\'s Python tests pass', { skip: python.error ? 'python3 not installed' : false }, () => {
  const run = spawnSync('python3', ['-B', '-m', 'unittest', 'discover', '-s', core, '-p', 'test_*.py'], { cwd: core, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

// Exactly what the npm package ships of the core: what a host runs, no tests,
// caches or local files. A new file is added here on purpose or not at all.
const PAYLOAD = [
  'CORE_API.md', 'Dockerfile', 'SYSCALL_CATALOG.md', 'agents.json', 'catalog_numbers.py', 'claude-hook.mjs', 'collector.py',
  'core/__init__.py', 'core/mechanics.py', 'core/release.py', 'dns_forwarder.py', 'engine.py', 'file_scan.py', 'lima.yaml',
  'network.py', 'projects.py', 'setup.py', 'syscall_catalog.sql', 'viewer.py',
].map((path) => `worker/sandbox/${path}`).sort();

test('the npm package ships the sandbox core\'s payload and nothing else under worker/', () => {
  const run = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(run.status, 0, run.stderr);
  const shipped = JSON.parse(run.stdout)[0].files.map((file) => file.path).filter((path) => path.startsWith('worker/')).sort();
  assert.deepEqual(shipped, PAYLOAD);
});

test('the VM setup hash covers the core package', () => {
  assert.ok(setupFiles().includes('core/mechanics.py'));
  assert.ok(!setupFiles().some((path) => path.includes('__pycache__')));
});

// This repository runs sandboxes on the user's own machine. How RayTrace runs
// hosted ones (its host entry, relay, command runner, cloud machines, plans)
// is not part of it.
test('no hosted-service host code in the sandbox core', () => {
  for (const path of setupFiles()) {
    const text = readFileSync(`${core}/${path}`, 'utf8');
    for (const marker of ['ssh_entry', 'remote_access', 'command_runner', 'bridge_relay', 'approve-proxy', 'gcloud', 'RAYTACE_RELAY_SECRET']) {
      assert.ok(!text.includes(marker), `${path} mentions ${marker}`);
    }
  }
});
