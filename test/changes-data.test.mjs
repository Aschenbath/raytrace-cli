import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeChanges } from '../dashboard/app/changes-data.ts';

const change = (path, status, added = 1, removed = 0) => ({ path, status, added, removed });
const trace = (...steps) => ({
  id: 'abcdef12',
  callVerifications: steps.map((changes, index) => ({
    snapshot: { changed: true, parent: `c${index}`, commit: `c${index + 1}`, changes },
  })),
});

test('an added file stays added after edits, with every touching call', () => {
  const result = summarizeChanges(trace([change('new.js', 'A', 5)], [change('new.js', 'M', 1, 1)]));
  assert.deepEqual(result.files, [{ path: 'new.js', status: 'A', added: 6, removed: 1, calls: [1, 2] }]);
  assert.equal(result.base, 'c0');
  assert.equal(result.final, 'c2');
});

test('temporary files are omitted without losing the step history', () => {
  const result = summarizeChanges(trace([change('tmp.txt', 'A', 3)], [change('tmp.txt', 'D', 0, 3)]));
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.steps.map(step => step.number), [1, 2]);
  assert.equal(result.added, 0);
  assert.equal(result.removed, 0);
});

test('deleting and recreating an existing file is an edit', () => {
  const result = summarizeChanges(trace([change('old.js', 'D', 0, 3)], [change('old.js', 'A', 5)]));
  assert.deepEqual(result.files, [{ path: 'old.js', status: 'M', added: 5, removed: 3, calls: [1, 2] }]);
});

test('recreating a temporary file remembers that it was absent at the base', () => {
  const result = summarizeChanges(trace([change('tmp', 'A')], [change('tmp', 'D')], [change('tmp', 'A')]));
  assert.equal(result.files[0].status, 'A');
  assert.deepEqual(result.files[0].calls, [1, 2, 3]);
});

test('a single edit keeps its status and line counts', () => {
  assert.deepEqual(summarizeChanges(trace([change('existing', 'M', 2, 4)])).files,
    [{ path: 'existing', status: 'M', added: 2, removed: 4, calls: [1] }]);
});

test('binary counts remain unknown after later text edits', () => {
  const result = summarizeChanges(trace([change('binary', 'A', null, null)], [change('binary', 'M', 2, 1)]));
  assert.deepEqual(result.files, [{ path: 'binary', status: 'A', added: null, removed: null, calls: [1, 2] }]);
});

test('deleting a recreated existing file remains a deletion', () => {
  const result = summarizeChanges(trace([change('old', 'D')], [change('old', 'A')], [change('old', 'D')]));
  assert.equal(result.files[0].status, 'D');
});
