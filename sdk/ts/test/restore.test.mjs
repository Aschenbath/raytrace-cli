import test from 'node:test';
import assert from 'node:assert/strict';
import RayTrace, { RayTraceError } from '../src/index.mjs';

const sid = 'rtp-' + 'a'.repeat(32);

async function restoringSandbox(replies) {
  let started = false;
  let polls = 0;
  const rt = new RayTrace({ apiKey: 'test', fetchImpl: async (url, options) => {
    if (options.method === 'POST' && new URL(url).pathname.endsWith('/start')) {
      started = true;
      return new Response(JSON.stringify({ id: sid, status: 'starting', restoring: true }), { status: 202 });
    }
    if (!started) return new Response(JSON.stringify([{ id: sid, status: 'archived' }]));
    polls += 1;
    assert.ok(replies.length, 'unexpected restore poll');
    return new Response(JSON.stringify(replies.shift()));
  } });
  return { sandbox: await rt.sandboxes.get(sid), polls: () => polls };
}

for (const status of ['running', 'archived']) {
  test(`start waits while status is ${status} and restoring is true`, async () => {
    const finished = { id: sid, status: 'running', restoring: false, restored_from_archive: true };
    const { sandbox, polls } = await restoringSandbox([
      [{ id: sid, status, restoring: true }],
      [finished],
    ]);
    assert.deepEqual(await sandbox.start({ pollIntervalMs: 0 }), finished);
    assert.equal(polls(), 2);
  });
}

test('start reports a sandbox that disappears during restoration', async () => {
  const { sandbox } = await restoringSandbox([[]]);
  await assert.rejects(sandbox.start({ pollIntervalMs: 0 }), error =>
    error instanceof RayTraceError && error.status === 404 && /disappeared/i.test(error.message));
});

test('start can explicitly return without waiting for restoration', async () => {
  const { sandbox, polls } = await restoringSandbox([]);
  const result = await sandbox.start({ waitForRestore: false });
  assert.equal(result.restoring, true);
  assert.equal(polls(), 0);
});

test('start still surfaces the server restore error', async () => {
  const { sandbox } = await restoringSandbox([[{ id: sid, status: 'archived', restore_error: 'archive unreadable' }]]);
  await assert.rejects(sandbox.start({ pollIntervalMs: 0 }), error =>
    error instanceof RayTraceError && error.status === 500 && /archive unreadable/.test(error.message));
});
