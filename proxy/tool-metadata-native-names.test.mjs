import test from 'node:test';
import assert from 'node:assert/strict';
import { callKind, nativeFileOperation } from './tool-metadata.mjs';

test('unknown tools with Object member names remain commands', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(callKind(name), 'command', name);
    assert.equal(nativeFileOperation(name, { path: 'project.txt' }), null, name);
  }
  assert.equal(callKind('Read'), 'file');
  assert.equal(nativeFileOperation('Read', { file_path: 'project.txt' }).op, 'read');
  assert.equal(callKind('mcp__server__constructor'), 'agent');
});
