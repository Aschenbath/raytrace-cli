import test from 'node:test';
import assert from 'node:assert/strict';
import RayTrace from '../src/index.mjs';

const sid = 'rtp-' + 'a'.repeat(32);

async function sandboxWithJobs(jobs) {
  const requests = [];
  const rt = new RayTrace({ apiKey: 'test', fetchImpl: async (url, options) => {
    if (new URL(url).pathname === '/v1/sandboxes') {
      return new Response(JSON.stringify([{ id: sid, status: 'running' }]));
    }
    requests.push({ method: options.method, path: new URL(url).pathname });
    assert.ok(jobs.length, 'unexpected command poll');
    return new Response(JSON.stringify(jobs.shift()));
  } });
  return { sandbox: await rt.sandboxes.get(sid), requests };
}

for (const initial of ['queued', 'interrupted']) {
  test(`exec waits for recovery after an initially ${initial} command`, async () => {
    const pending = { command_id: 'cmd-1', state: 'interrupted', recovery_pending: true };
    const { sandbox, requests } = await sandboxWithJobs([
      initial === 'queued' ? { command_id: 'cmd-1', state: 'queued' } : pending,
      pending,
      { command_id: 'cmd-1', state: 'completed', exit_code: 0, stdout: 'final output', recovery_pending: false },
    ]);
    const result = await sandbox.exec('echo ready', { pollIntervalMs: 0 });
    assert.equal(result.state, 'completed');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'final output');
    assert.deepEqual(requests.map(request => request.method), ['POST', 'GET', 'GET']);
    assert.equal(requests[2].path, `/v1/sandboxes/${sid}/commands/cmd-1`);
  });
}

test('exec returns a final interrupted result without extra polling', async () => {
  const { sandbox, requests } = await sandboxWithJobs([
    { command_id: 'cmd-1', state: 'interrupted', stderr: 'host stopped' },
  ]);
  const result = await sandbox.exec('echo ready', { pollIntervalMs: 0 });
  assert.equal(result.state, 'interrupted');
  assert.equal(result.stderr, 'host stopped');
  assert.equal(requests.length, 1);
});
