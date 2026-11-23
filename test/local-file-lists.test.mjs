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

test('repeated slashes, . segments and trailing slashes collapse the way the VM stores them', () => {
  assert.deepEqual(
    changedLists({}, { restrict: ['src//a.js', 'src/./b.js', './src/c.js/', '././d.js', 'e//f/./g//'] }),
    { restricted: ['d.js', 'e/f/g', 'src/a.js', 'src/b.js', 'src/c.js'], watched: [] },
  );
});

test('--clear finds a file however its path was written', () => {
  assert.deepEqual(
    changedLists({ restricted: ['src/a.js'], watched: ['src/b.js'] }, { clear: ['src//a.js', 'src/./b.js'] }),
    { restricted: [], watched: [] },
  );
});

test('the same file written two ways is still caught as given to both lists', () => {
  assert.throws(() => changedLists({ restricted: [] }, { restrict: ['src//a.js'], report: ['src/a.js'] }), /src\/a\.js is given to both --restrict and --report/);
  assert.throws(() => changedLists({}, { restrict: ['src/./a.js'], report: ['./src//a.js/'] }), /both --restrict and --report/);
});

test('Windows separators become /', () => {
  assert.deepEqual(
    changedLists({}, { restrict: ['src\\a.js', '.\\b.js'], report: ['src\\\\deep\\c.js'] }),
    { restricted: ['b.js', 'src/a.js'], watched: ['src/deep/c.js'] },
  );
});

test('a path that is only the project root, or empty, is ignored as before', () => {
  assert.deepEqual(changedLists({ restricted: ['x'], watched: [] }, { restrict: ['.', './', '', '  '] }), { restricted: ['x'], watched: [] });
});

test('names that merely contain dots are kept', () => {
  assert.deepEqual(
    changedLists({}, { restrict: ['.env', 'a..b', '..hidden', 'src/.config', 'dir./x'] }),
    { restricted: ['..hidden', '.env', 'a..b', 'dir./x', 'src/.config'], watched: [] },
  );
});

test('a path that leaves the project root is refused, naming the flag and the path', () => {
  const leaves = (flag, path) => assert.throws(
    () => changedLists({}, { [flag]: [path] }),
    new Error(`--${flag} ${path}: paths are from the project's root and cannot leave it.`),
  );
  leaves('restrict', '../x');
  leaves('report', '/etc/passwd');
  leaves('clear', 'a/../b');   // the VM refuses any .. segment, even one that stays inside
  leaves('restrict', 'a/..');
  leaves('report', '\\etc\\passwd');   // absolute once \ is read as /
  leaves('restrict', '..\\x');
});

test('a path with a NUL character is refused', () => {
  assert.throws(() => changedLists({}, { restrict: ['a\0b'] }), new Error('--restrict a\\0b: a path cannot contain a NUL character.'));
});

test('one bad path refuses the whole change, so nothing is half applied', () => {
  assert.throws(() => changedLists({ restricted: ['keep.js'], watched: [] }, { restrict: ['ok.js', '../bad'] }), /cannot leave it/);
});
