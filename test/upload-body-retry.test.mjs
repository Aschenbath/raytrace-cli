import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendChunks } from '../src/upload.mjs';

const CHUNK = 8 * 1024 * 1024;

async function fixture(t, size = 16) {
  const directory = await mkdtemp(join(tmpdir(), 'raytrace-upload-body-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'evidence.db.gz');
  await writeFile(file, Buffer.alloc(size, 42));
  t.mock.method(globalThis, 'setTimeout', callback => { queueMicrotask(callback); });
  return { url: 'https://api.test', key: 'test', sandbox: 'rtp-test', name: 'test', file, size, sha256: 'test-digest' };
}

function interruptedResponse() {
  return new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError('response body interrupted')); },
  }), { headers: { 'content-type': 'application/json' } });
}

test('an interrupted success body retries the chunk and resumes from the server offset', async t => {
  const options = await fixture(t, CHUNK + 5);
  const requests = [];
  const progress = [];
  const complete = { complete: true, exchanges: 3 };
  const result = await sendChunks({ ...options, onProgress: offset => progress.push(offset),
    send: async (url, request) => {
      requests.push({ offset: url.searchParams.get('offset'), length: request.body.length });
      if (requests.length === 1) return interruptedResponse();
      if (requests.length === 2) return Response.json({ code: 'upload_offset', offset: CHUNK }, { status: 409 });
      return Response.json(complete);
    },
  });
  assert.deepEqual(result, complete);
  assert.deepEqual(requests, [
    { offset: '0', length: CHUNK },
    { offset: '0', length: CHUNK },
    { offset: String(CHUNK), length: 5 },
  ]);
  assert.deepEqual(progress, [CHUNK]);
});

test('repeated response-body interruptions stop at the existing retry limit', async t => {
  const options = await fixture(t);
  let attempts = 0;
  await assert.rejects(sendChunks({ ...options, send: async () => {
    attempts++;
    if (attempts > 6) throw new Error('retry budget exceeded');
    return interruptedResponse();
  } }), /Upload interrupted: response body interrupted.*Run it again to continue/);
  assert.equal(attempts, 6);
});

test('a non-JSON client error retains its HTTP error without retrying', async t => {
  const options = await fixture(t);
  let attempts = 0;
  await assert.rejects(sendChunks({ ...options, send: async () => {
    attempts++;
    return new Response('Request rejected', { status: 403 });
  } }), /HTTP 403/);
  assert.equal(attempts, 1);
});
