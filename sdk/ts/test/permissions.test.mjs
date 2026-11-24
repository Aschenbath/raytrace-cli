import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { archiveFromDirectory, buildTarGz } from '../src/index.mjs';

function archiveModes(bytes) {
  const tar = gunzipSync(bytes);
  const modes = {};
  for (let offset = 0; tar[offset] !== 0; ) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').split('\0')[0];
    modes[name] = parseInt(header.subarray(100, 108).toString('ascii'), 8);
    const size = parseInt(header.subarray(124, 136).toString('ascii'), 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return modes;
}

test('directory archives preserve the source file permission bits', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'raytrace-permissions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const expected = {};
  for (const [name, mode] of [['run.sh', 0o751], ['config.json', 0o640]]) {
    const path = join(root, name);
    writeFileSync(path, 'project file\n');
    chmodSync(path, mode);
    expected[name] = statSync(path).mode & 0o777;
  }
  assert.deepEqual(archiveModes(archiveFromDirectory(root)), expected);
});

test('in-memory files retain their default archive permissions', () => {
  assert.deepEqual(archiveModes(buildTarGz({ 'README.md': '# project\n' })), { 'README.md': 0o644 });
});
