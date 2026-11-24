import test from 'node:test';
import assert from 'node:assert/strict';
import { sharePrompt } from '../src/share.mjs';

for (const allowFork of [false, true]) {
  test(`share creation sends a JSON request (fork=${allowFork})`, async t => {
    const previous = { key: process.env.RAYTRACE_API_KEY, url: process.env.RAYTRACE_API_URL };
    process.env.RAYTRACE_API_KEY = 'test-only-key';
    process.env.RAYTRACE_API_URL = 'https://api.test';
    t.after(() => {
      for (const [name, value] of [['RAYTRACE_API_KEY', previous.key], ['RAYTRACE_API_URL', previous.url]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    t.mock.method(console, 'log', () => {});
    let request;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      request = new Request(url, options);
      return Response.json({ url: '/share/test-share', share: {
        trace_id: 'trace-1', sandbox_id: 'rtp-test', allow_fork: allowFork, expires: 2_000_000_000,
      } });
    });
    const result = await sharePrompt(' trace-1 ', { sandboxId: ' rtp-test ', allowFork });
    assert.equal(request.url, 'https://api.test/v1/shares');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('content-type'), 'application/json');
    assert.deepEqual(await request.json(), { trace_id: 'trace-1', sandbox_id: 'rtp-test', allow_fork: allowFork });
    assert.match(result.fullUrl, /\/share\/test-share$/);
  });
}
