import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import RayTrace, { archiveFromDirectory } from '../src/index.mjs';

const limit = 25 * 1024 * 1024;

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'raytrace-directory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function sizedFile(path, size) {
  const fd = openSync(path, 'w');
  try {
    ftruncateSync(fd, size);
  } finally {
    closeSync(fd);
  }
}

test('directory creation rejects oversized project files before uploading', async (t) => {
  const root = directory(t);
  writeFileSync(join(root, 'README.md'), '# project\n');
  sizedFile(join(root, 'dataset.bin'), limit + 1);
  let uploads = 0;
  const rt = new RayTrace({ apiKey: 'test', fetchImpl: async () => {
    uploads += 1;
    return new Response(JSON.stringify({ id: 'rtp-test', status: 'running' }), { status: 201 });
  } });
  await assert.rejects(rt.sandboxes.create({ dir: root }), /dataset\.bin.*25 MiB/);
  assert.equal(uploads, 0);
});

test('directory archives retain a file at the size limit', (t) => {
  const root = directory(t);
  sizedFile(join(root, 'dataset.bin'), limit);
  const tar = gunzipSync(archiveFromDirectory(root));
  assert.equal(tar.subarray(0, 100).toString('utf8').split('\0')[0], 'dataset.bin');
  assert.equal(parseInt(tar.subarray(124, 136).toString('ascii'), 8), limit);
});

test('excluded secret files do not trigger the project file size limit', (t) => {
  const root = directory(t);
  writeFileSync(join(root, 'README.md'), '# project\n');
  sizedFile(join(root, '.env.local'), limit + 1);
  const tar = gunzipSync(archiveFromDirectory(root));
  assert.equal(tar.subarray(0, 100).toString('utf8').split('\0')[0], 'README.md');
  assert.equal(tar.length, 2048);
});
