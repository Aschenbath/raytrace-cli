import test from 'node:test';
import assert from 'node:assert/strict';
import { shellQuote } from '../src/terminal.mjs';

test('shellQuote: leaves safe tokens unquoted', () => {
  for (const token of ['raytrace', './bin/raytrace.mjs', 'http://127.0.0.1:8797']) {
    assert.equal(shellQuote(token), token);
  }
});

test('shellQuote: quotes a value with spaces', () => {
  assert.equal(shellQuote('raytrace connect my-box'), "'raytrace connect my-box'");
});

test('shellQuote: escapes a single quote', () => {
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test('shellQuote: quotes the empty string', () => {
  assert.equal(shellQuote(''), "''");
});
