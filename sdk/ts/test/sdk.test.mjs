import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { RayTrace, RayTraceError, buildTarGz } from '../src/index.mjs';

function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}${u.search}`;
    calls.push({ method: init.method || 'GET', url, path: u.pathname + u.search, headers: init.headers || {}, body: init.body });
    const handler = routes[key] || routes[`${init.method || 'GET'} ${u.pathname}`];
    if (!handler) {
      return new Response(JSON.stringify({ error: `Unmocked ${key}` }), { status: 404 });
    }
    const res = typeof handler === 'function' ? handler({ url: u, init, calls }) : handler;
    return new Response(JSON.stringify(res.body ?? {}), { status: res.status ?? 200 });
  };
  fn.calls = calls;
  return fn;
}

test('full sandbox lifecycle + exec polling + usage + apiKeys', async () => {
  let pollCount = 0;
  let restorePolls = 0;
  const sid = 'rtp-' + 'a'.repeat(32);
  const fetchImpl = mockFetch({
    'POST /v1/sandboxes': { status: 201, body: { id: sid, name: 'app', size: 'small', status: 'running', run_id: 'run-1', paid_until: 2000 } },
    [`POST /v1/sandboxes/${sid}/commands`]: { status: 202, body: { command_id: 'cmd-1', state: 'queued' } },
    [`GET /v1/sandboxes/${sid}/commands/cmd-1`]: () => {
      pollCount += 1;
      if (pollCount === 1) return { status: 200, body: { command_id: 'cmd-1', state: 'running' } };
      return { status: 200, body: { command_id: 'cmd-1', state: 'completed', exit_code: 0, stdout: 'ok\n', stderr: '' } };
    },
    [`POST /v1/sandboxes/${sid}/stop`]: { status: 200, body: { id: sid, status: 'exited' } },
    [`POST /v1/sandboxes/${sid}/start`]: { status: 202, body: { id: sid, status: 'starting', restoring: true, size: 'medium' } },
    'GET /v1/sandboxes': () => {
      restorePolls += 1;
      const st = restorePolls === 1 ? 'starting' : 'running';
      return { status: 200, body: [{ id: sid, name: 'app', size: 'medium', status: st, restored_from_archive: st === 'running' }] };
    },
    [`POST /v1/sandboxes/${sid}/keep-alive`]: { status: 200, body: { sandbox_id: sid, keep_alive_until: 5000 } },
    [`DELETE /v1/sandboxes/${sid}?keep_traces=1`]: { status: 200, body: { id: sid, status: 'deleted' } },
    'GET /v1/usage?days=30': { status: 200, body: { days: 30, blocks_this_month: 4, wallet: { balance_usd: 9.96 } } },
    'POST /v1/api-keys': { status: 201, body: { id: 'key_1', name: 'ci', prefix: 'rtk_12345678', key: 'rtk_secret' } },
  });

  const rt = new RayTrace({ apiKey: 'rtk_testkey', baseUrl: 'https://api.example.test', fetchImpl });
  const sb = await rt.sandboxes.create({ name: 'app', size: 'small', files: { 'README.md': '# app\n' } });
  assert.equal(sb.id, sid);
  assert.equal(fetchImpl.calls[0].headers['X-RayTrace-Size'], 'small');
  assert.equal(fetchImpl.calls[0].headers['X-RayTrace-Name'], 'app');
  assert.ok(gunzipSync(fetchImpl.calls[0].body).toString('utf8').includes('# app'));

  const r = await sb.exec('npm test', { pollIntervalMs: 1 });
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, 'ok\n');
  assert.equal(pollCount, 2);

  await sb.stop();
  assert.equal(sb.status, 'exited');

  await sb.start({ size: 'medium', pollIntervalMs: 1 });
  assert.equal(sb.status, 'running');
  assert.equal(restorePolls, 2);

  const ka = await sb.keepAlive(60);
  assert.equal(ka.keep_alive_until, 5000);

  await sb.destroy({ keepTraces: true });
  assert.equal(sb.status, 'deleted');

  const usage = await rt.usage.get();
  assert.equal(usage.blocks_this_month, 4);

  const key = await rt.apiKeys.create('ci');
  assert.equal(key.key, 'rtk_secret');
});

test('typed RayTraceError exposes status, code, and topupUrl on 402', async () => {
  const fetchImpl = mockFetch({
    'POST /v1/sandboxes': {
      status: 402,
      body: { error: 'Insufficient balance', code: 'insufficient_balance', topup_url: 'https://raytracer.si/account.html' },
    },
  });
  const rt = new RayTrace({ apiKey: 'rtk_testkey', fetchImpl });
  await assert.rejects(
    () => rt.sandboxes.create({ size: 'small', files: { 'index.js': 'console.log(1)\n' } }),
    err => err instanceof RayTraceError && err.status === 402 && err.code === 'insufficient_balance' && err.topupUrl === 'https://raytracer.si/account.html',
  );
  assert.ok(buildTarGz({ 'a.txt': 'hello' }).length > 20);
});
