import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { archiveFromDirectory } from '../src/client.mjs';

function entries(archive) {
  const tar = gunzipSync(archive);
  const files = new Map();
  for (let offset = 0; tar[offset] !== 0; ) {
    const name = tar.subarray(offset, offset + 100).toString().replace(/\0.*$/, '');
    const size = parseInt(tar.subarray(offset + 124, offset + 136).toString(), 8);
    files.set(name, tar.subarray(offset + 512, offset + 512 + size).toString());
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

test('a root __proto__ source file is included alongside ordinary files', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'raytrace-prototype-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [name, body] of [['__proto__', 'prototype fixture'], ['constructor', 'constructor fixture'], ['README.md', '# project']]) {
    writeFileSync(join(directory, name), body);
  }
  assert.deepEqual(entries(archiveFromDirectory(directory)), new Map([
    ['README.md', '# project'], ['__proto__', 'prototype fixture'], ['constructor', 'constructor fixture'],
  ]));
});

test('a directory containing only __proto__ is not an empty archive', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'raytrace-prototype-only-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, '__proto__'), 'source text');
  assert.deepEqual(entries(archiveFromDirectory(directory)), new Map([['__proto__', 'source text']]));
});
