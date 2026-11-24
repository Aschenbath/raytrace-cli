import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { buildTarGz } from '../src/index.mjs';

function readFiles(archive) {
  const tar = gunzipSync(archive);
  const files = {};
  for (let offset = 0; tar[offset] !== 0; ) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').split('\0')[0];
    const size = parseInt(header.subarray(124, 136).toString('ascii'), 8);
    files[name] = tar.subarray(offset + 512, offset + 512 + size).toString('utf8');
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

test('buildTarGz preserves complete UTF-8 file names', () => {
  const files = {
    '資料/説明.txt': 'documentation',
    'café.txt': 'café',
    'launch-🚀.txt': 'ready',
  };
  assert.deepEqual(readFiles(buildTarGz(files)), files);
});

test('the tar name limit counts UTF-8 bytes', () => {
  const name = 'é'.repeat(49) + 'a';
  assert.deepEqual(readFiles(buildTarGz({ [name]: 'full name' })), { [name]: 'full name' });
  assert.throws(() => buildTarGz({ ['é'.repeat(50)]: 'too long' }), /Invalid archive file path/);
});
