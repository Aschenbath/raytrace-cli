import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mcpNameMarker, readmeHasMcpName, SERVER_NAME, syncServerJson } from '../.github/scripts/sync-mcp-server-json.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
const readme = readFileSync(new URL('../python/README.md', import.meta.url), 'utf8');
const wheels = readFileSync(new URL('../python/build_wheels.py', import.meta.url), 'utf8');

test('server.json matches the package the registry will verify', () => {
  assert.equal(pkg.mcpName, SERVER_NAME);
  assert.equal(server.name, SERVER_NAME);
  assert.equal(server.version, pkg.version);
  assert.deepEqual(syncServerJson(server, pkg), server);
  assert.equal(server.description.length <= 100, true);
  assert.equal(readmeHasMcpName(readme), true);
  assert.match(wheels, /raytrace = raytrace\.__main__:main/);
  assert.match(wheels, /raytrace-cli = raytrace\.__main__:main/);
});

test('publishing rewrites every version to the release and leaves the source alone', () => {
  const updated = syncServerJson(server, { ...pkg, version: '9.9.9' });
  assert.equal(updated.version, '9.9.9');
  assert.deepEqual(updated.packages.map((entry) => entry.version), ['9.9.9', '9.9.9']);
  assert.equal(server.version, pkg.version);
  assert.equal(updated.packages[0].packageArguments[0].value, 'mcp');
  assert.equal(updated.packages[1].packageArguments[0].value, 'mcp');
});

test('a package without the registry name is refused', () => {
  assert.throws(() => syncServerJson(server, { ...pkg, mcpName: 'io.github.other/raytrace' }), /mcpName/);
  assert.throws(() => syncServerJson({ ...server, description: 'x'.repeat(101) }, pkg), /100/);
  const broken = structuredClone(server);
  broken.packages = broken.packages.filter((entry) => entry.registryType === 'npm');
  assert.throws(() => syncServerJson(broken, pkg), /PyPI/);
});

test('the PyPI marker is the comment the registry scans for', () => {
  assert.equal(mcpNameMarker(), `<!-- mcp-name: ${SERVER_NAME} -->`);
  assert.equal(readmeHasMcpName(`# Title\n\n${mcpNameMarker()}\n`), true);
  assert.equal(readmeHasMcpName(`mcp-name: ${SERVER_NAME}.`), false);
  assert.equal(readmeHasMcpName(`<!-- mcp-name: ${SERVER_NAME}-other -->`), false);
});
