import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'raytrace-config-test-'));
process.env.RAYTRACE_HOME = home;
const { writeConfig, readConfig, portOf } = await import('../src/config.mjs');
const { DEFAULT_PORT } = await import('../src/paths.mjs');
const file = join(home, 'config.env');
after(() => rmSync(home, { recursive: true, force: true }));

test('unset and empty ports use the default', () => {
  for (const config of [{}, { RAYTACE_PORT: '' }, { RAYTACE_PORT: '   ' }]) {
    assert.equal(portOf(config), DEFAULT_PORT);
  }
});

test('ports accept whole numbers in range and surrounding whitespace', () => {
  for (const value of ['1', '8797', ' 8797 ', '65535']) {
    assert.equal(portOf({ RAYTACE_PORT: value }), Number(value));
  }
});

for (const value of ['abc', '0', '65536', '99999', '1.5', '-1', 'Infinity']) {
  test(`invalid port ${JSON.stringify(value)} identifies the setting and config file`, () => {
    assert.throws(() => portOf({ RAYTACE_PORT: value }), {
      message: `RAYTACE_PORT in ${file} must be a port number from 1 to 65535 (got ${JSON.stringify(value)}).`,
    });
  });
}

test('status reports an invalid port instead of saying the proxy is stopped', () => {
  writeConfig({ RAYTACE_PORT: 'abc' });
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/raytrace.mjs', import.meta.url)), 'status'], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: join(home, 'claude') },
  });
  assert.equal(run.status, 1, run.stderr);
  assert.ok(run.stderr.includes(`RAYTACE_PORT in ${file}`));
  assert.match(run.stderr, /must be a port number from 1 to 65535/);
  assert.doesNotMatch(run.stdout, /stopped/);
});

test('custom model JSON with apostrophes survives saving alongside credentials', () => {
  const models = JSON.stringify([{ id: 'custom', name: "Developer's model" }]);
  writeConfig({ RAYTACE_OPENROUTER_MODELS: models, OPENROUTER_API_KEY: 'fake-test-key' });
  assert.deepEqual({ ...readConfig() }, { RAYTACE_OPENROUTER_MODELS: models, OPENROUTER_API_KEY: 'fake-test-key' });
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('hashes, whitespace, literal backslashes and multiline values survive', () => {
  for (const value of ['a # b', 'one\ntwo', String.raw`path\new`, `a'"b`, 'uses `quotes`']) {
    writeConfig({ SETTING: value });
    assert.equal(readConfig().SETTING, value);
  }
});

test('unrepresentable values leave previous settings intact without disclosing them', () => {
  writeConfig({ OPENROUTER_API_KEY: 'fake-original-key' });
  const before = readFileSync(file, 'utf8');
  const value = "'\"`\nINJECTED=secret-not-to-log";
  assert.throws(() => writeConfig({ SETTING: value }), error => {
    assert.equal(error.message, 'Cannot save setting SETTING without changing its value.');
    return true;
  });
  assert.equal(readFileSync(file, 'utf8'), before);
});
