import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkForUpdate, installKind, newer, notice, refresh } from '../src/update-check.mjs';

const tty = { isTTY: true };
function setup(cache) {
  const dir = mkdtempSync(join(tmpdir(), 'raytrace-update-'));
  const home = join(dir, 'home');
  const root = join(dir, 'lib', 'node_modules', '@raytrace-cli', 'cli');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  if (cache) writeFileSync(join(home, 'update-check.json'), JSON.stringify(cache));
  return { dir, home, root };
}
const run = (command, { home, root }, extra = {}) => {
  const printed = [], refreshed = [];
  const line = checkForUpdate(command, { env: {}, stderr: tty, root, home, current: '0.18.0', now: 10 * 86_400_000,
    log: (text) => printed.push(text), refresh: (where) => refreshed.push(where), ...extra });
  return { line, printed, refreshed };
};

test('versions compare as numbers, and only stable ones count', () => {
  assert.ok(newer('0.18.10', '0.18.9'));
  assert.ok(newer('1.0.0', '0.99.99'));
  assert.ok(!newer('0.18.0', '0.18.0'));
  assert.ok(!newer('0.17.17', '0.18.0'));
  assert.ok(!newer('0.19.0-beta.1', '0.18.0'));
  assert.ok(!newer(undefined, '0.18.0'));
});

test('a newer release is noted on every command, with the update command for how it was installed', () => {
  const where = setup({ checked_at: 10 * 86_400_000 - 1000, latest: '0.19.0' });
  try {
    for (const command of ['sandbox', 'start', 'open', undefined]) {
      const { printed, refreshed } = run(command, where);
      assert.deepEqual(printed, ['RayTrace 0.19.0 is available (you have 0.18.0). Update: npm install -g @raytrace-cli/cli@latest']);
      assert.deepEqual(refreshed, []);   // checked within the day
    }
  } finally { rmSync(where.dir, { recursive: true, force: true }); }
  assert.match(notice('0.19.0', '0.18.0', 'pip'), /pip install --upgrade raytrace-cli$/);
  assert.match(notice('0.19.0', '0.18.0', 'npx'), /npx @raytrace-cli\/cli@latest$/);
});

test('up to date says nothing; a day-old answer is refreshed in the background', () => {
  const where = setup({ checked_at: 1, latest: '0.18.0' });
  try {
    const { printed, refreshed } = run('sandbox', where);
    assert.deepEqual(printed, []);
    assert.deepEqual(refreshed, [where.home]);
  } finally { rmSync(where.dir, { recursive: true, force: true }); }
  const fresh = setup();
  try { assert.deepEqual(run('sandbox', fresh).refreshed, [fresh.home]); } finally { rmSync(fresh.dir, { recursive: true, force: true }); }
});

test('never for the hook, the MCP server, CI, a non-terminal, an opt-out or a source checkout', () => {
  const where = setup({ checked_at: 1, latest: '0.19.0' });
  try {
    for (const [command, extra] of [['hook', {}], ['mcp', {}], ['sandbox', { env: { CI: 'true' } }],
      ['sandbox', { env: { RAYTRACE_NO_UPDATE_CHECK: '1' } }], ['sandbox', { stderr: { isTTY: false } }]]) {
      const { printed, refreshed } = run(command, where, extra);
      assert.deepEqual([printed, refreshed], [[], []], command);
    }
    mkdirSync(join(where.root, '.git'));
    assert.deepEqual(run('sandbox', where).printed, []);
  } finally { rmSync(where.dir, { recursive: true, force: true }); }
});

test('how it was installed is read from where it runs', () => {
  assert.equal(installKind('/opt/homebrew/lib/node_modules/@raytrace-cli/cli'), 'npm');
  assert.equal(installKind('/home/u/.npm/_npx/0a6b/node_modules/@raytrace-cli/cli'), 'npx');
  assert.equal(installKind('/opt/anaconda3/lib/python3.12/site-packages/raytrace/app'), 'pip');
});

test('refresh keeps the registry\'s stable latest, and the last answer when offline', async () => {
  const where = setup({ checked_at: 1, latest: '0.18.0' });
  try {
    assert.equal(await refresh(where.home, async () => ({ ok: true, json: async () => ({ version: '0.19.0' }) })), '0.19.0');
    assert.equal(await refresh(where.home, async () => { throw new Error('offline'); }), '0.19.0');
    assert.equal(await refresh(where.home, async () => ({ ok: true, json: async () => ({ version: '1.0.0-rc.1' }) })), '0.19.0');
    const saved = JSON.parse(readFileSync(join(where.home, 'update-check.json'), 'utf8'));
    assert.equal(saved.latest, '0.19.0');
    assert.ok(saved.checked_at > 1);
  } finally { rmSync(where.dir, { recursive: true, force: true }); }
});
