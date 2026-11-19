import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff } from '../dashboard/app/diff-parse.ts';

const patch = (...lines) => [...lines, ''].join('\n');
const row = (oldNo, oldText, newNo, newText) => ({ oldNo, oldText, newNo, newText });

test('a single hunk pairs replacements and preserves context and line numbers', () => {
  const header = '@@ -4,4 +9,3 @@ example';
  const parsed = parseDiff(patch(header, ' context', '-before', '-extra', '+after', ' end'));

  assert.deepEqual(parsed, {
    hunks: [{
      header,
      rows: [
        row(4, 'context', 9, 'context'),
        row(5, 'before', 10, 'after'),
        row(6, 'extra', null, null),
        row(7, 'end', 11, 'end'),
      ],
    }],
    additions: 1,
    deletions: 2,
    binary: false,
  });
});

test('pure additions and removals leave the opposite side empty', () => {
  const parsed = parseDiff(patch('@@ -0,0 +1 @@', '+first', '@@ -7 +7,0 @@', '-last'));

  assert.deepEqual(parsed.hunks.map(({ rows }) => rows), [
    [row(null, null, 1, 'first')],
    [row(7, 'last', null, null)],
  ]);
  assert.equal(parsed.additions, 1);
  assert.equal(parsed.deletions, 1);
});

test('no-newline markers remain notes between their original rows', () => {
  const note = 'No newline at end of file';
  const parsed = parseDiff(patch('@@ -1 +1 @@', '-before', '\\ ' + note, '+after', '\\ ' + note));

  assert.deepEqual(parsed.hunks[0].rows, [
    row(1, 'before', null, null),
    { ...row(null, null, null, null), note },
    row(null, null, 1, 'after'),
    { ...row(null, null, null, null), note },
  ]);
  assert.equal(parsed.additions, 1);
  assert.equal(parsed.deletions, 1);
});

test('binary file notices and Git binary patches have no text rows', () => {
  for (const lines of [['Binary files a/image.bin and b/image.bin differ'], ['GIT binary patch', 'literal 3', 'KcmZQz00ICg5C8!X']]) {
    const parsed = parseDiff(patch('diff --git a/image.bin b/image.bin', ...lines));

    assert.deepEqual(parsed, { hunks: [], additions: 0, deletions: 0, binary: true });
  }
});

test('file boundaries skip metadata and keep hunk content that resembles file headers', () => {
  const parsed = parseDiff(patch(
    'diff --git a/first.txt b/first.txt',
    '--- a/first.txt', '+++ b/first.txt', '@@ -1 +1 @@', '-before', '+after',
    'diff --git a/second.txt b/second.txt',
    'index 1234567..89abcde 100644',
    '--- a/second.txt', '+++ b/second.txt', '@@ -4 +4 @@', '--- heading', '+++ heading',
  ));

  assert.equal(parsed.additions, 2);
  assert.equal(parsed.deletions, 2);
  assert.deepEqual(parsed.hunks.map(({ rows }) => rows), [
    [row(1, 'before', 1, 'after')],
    [row(4, '-- heading', 4, '++ heading')],
  ]);
});

test('a following binary file keeps earlier text hunks and counts', () => {
  const parsed = parseDiff(patch(
    'diff --git a/file.txt b/file.txt',
    '--- a/file.txt', '+++ b/file.txt', '@@ -1 +1 @@', '-before', '+after',
    'diff --git a/image.bin b/image.bin',
    'index 1234567..89abcde 100644',
    'Binary files a/image.bin and b/image.bin differ',
  ));

  assert.equal(parsed.binary, true);
  assert.equal(parsed.additions, 1);
  assert.equal(parsed.deletions, 1);
  assert.deepEqual(parsed.hunks[0].rows, [row(1, 'before', 1, 'after')]);
});

test('CRLF produces the same rows as LF and preserves trailing spaces', () => {
  const lf = patch(
    '@@ -1,2 +1,2 @@', ' context  ', '-before ', '+after ',
    '\\ No newline at end of file',
  );

  assert.deepEqual(parseDiff(lf.replaceAll('\n', '\r\n')), parseDiff(lf));
  assert.deepEqual(parseDiff(patch('Binary files a/a and b/a differ').replaceAll('\n', '\r\n')), {
    hunks: [], additions: 0, deletions: 0, binary: true,
  });
});
