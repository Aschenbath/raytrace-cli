import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedLists } from '../src/local-sandbox.mjs';

test('a file is added to the list it is given to, once, in order', () => {
  assert.deepEqual(changedLists({ restricted: ['b.js'], watched: [] }, { restrict: ['./a.js', 'b.js'], report: ['src/keys.js/'] }),
    { restricted: ['a.js', 'b.js'], watched: ['src/keys.js'] });
});

test('a file is on one list at most: the newer choice moves it', () => {
  assert.deepEqual(changedLists({ restricted: ['a.js'], watched: ['b.js'] }, { restrict: ['b.js'], report: ['a.js'] }),
    { restricted: ['b.js'], watched: ['a.js'] });
});

test('clear takes a file off both lists and leaves the rest', () => {
  assert.deepEqual(changedLists({ restricted: ['a.js', 'c.js'], watched: ['b.js'] }, { clear: ['a.js', 'b.js', 'never-listed.js'] }),
    { restricted: ['c.js'], watched: [] });
});

test('the same file cannot be given to both lists in one command', () => {
  assert.throws(() => changedLists({}, { restrict: ['a.js'], report: ['./a.js'] }), /both --restrict and --report/);
});

test('lists that were never set start empty', () => {
  assert.deepEqual(changedLists({}, { report: ['a.js'] }), { restricted: [], watched: ['a.js'] });
});
