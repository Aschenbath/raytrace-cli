"""Unit tests for the Python `raytrace_sdk` SDK."""
import unittest

from raytrace_sdk import CommandResult, RayTrace, RayTraceError


class PythonSdkTests(unittest.TestCase):
    def test_sandbox_lifecycle_exec_and_usage(self):
        sid = 'rtp-' + 'b' * 32
        polls = {'cmd': 0, 'restore': 0}
        seen = []

        def transport(method, url, headers, body):
            seen.append((method, url, headers, body))
            if method == 'POST' and url.endswith('/v1/sandboxes'):
                return 201, {'id': sid, 'name': 'app', 'size': 'small', 'status': 'running'}
            if method == 'POST' and url.endswith(f'/v1/sandboxes/{sid}/commands'):
                return 202, {'command_id': 'cmd-1', 'state': 'queued'}
            if method == 'GET' and url.endswith(f'/v1/sandboxes/{sid}/commands/cmd-1'):
                polls['cmd'] += 1
                if polls['cmd'] == 1:
                    return 200, {'command_id': 'cmd-1', 'state': 'running'}
                return 200, {'command_id': 'cmd-1', 'state': 'completed', 'exit_code': 0, 'stdout': 'passed\n', 'stderr': ''}
            if method == 'POST' and url.endswith(f'/v1/sandboxes/{sid}/stop'):
                return 200, {'id': sid, 'status': 'exited'}
            if method == 'POST' and url.endswith(f'/v1/sandboxes/{sid}/start'):
                return 202, {'id': sid, 'status': 'starting', 'restoring': True, 'size': 'small'}
            if method == 'GET' and url.endswith('/v1/sandboxes'):
                polls['restore'] += 1
                return 200, [{'id': sid, 'name': 'app', 'size': 'small',
                              'status': 'starting' if polls['restore'] == 1 else 'running'}]
            if method == 'POST' and url.endswith(f'/v1/sandboxes/{sid}/keep-alive'):
                return 200, {'sandbox_id': sid, 'keep_alive_until': 9999}
            if method == 'DELETE' and url.endswith(f'/v1/sandboxes/{sid}?keep_traces=1'):
                return 200, {'id': sid, 'status': 'deleted'}
            if method == 'GET' and url.endswith('/v1/usage?days=30'):
                return 200, {'days': 30, 'blocks_this_month': 3, 'wallet': {'balance_usd': 9.97}}
            return 404, {'error': f'unexpected {method} {url}'}

        rt = RayTrace(api_key='rtk_test', base_url='https://api.example.test', transport=transport)
        sb = rt.sandboxes.create(size='small', files={'main.py': 'print(1)\n'})
        self.assertEqual(sb.id, sid)
        self.assertEqual(seen[0][2]['X-RayTrace-Size'], 'small')

        res = sb.exec('pytest', poll_interval=0)
        self.assertIsInstance(res, CommandResult)
        self.assertEqual(res.exit_code, 0)
        self.assertEqual(res.stdout, 'passed\n')

        sb.stop()
        self.assertEqual(sb.status, 'exited')

        sb.start(poll_interval=0)
        self.assertEqual(sb.status, 'running')
        self.assertEqual(polls['restore'], 2)

        self.assertEqual(sb.keep_alive(30)['keep_alive_until'], 9999)
        sb.destroy(keep_traces=True)
        self.assertEqual(sb.status, 'deleted')
        self.assertEqual(rt.usage.get()['blocks_this_month'], 3)

    def test_error_surfaces_code_and_topup_url(self):
        def transport(_m, _u, _h, _b):
            return 402, {'error': 'Insufficient credit', 'code': 'insufficient_balance',
                         'topup_url': 'https://raytracer.si/account.html'}

        rt = RayTrace(api_key='rtk_test', transport=transport)
        with self.assertRaises(RayTraceError) as ctx:
            rt.sandboxes.create(size='small', repo='github.com/acme/app')
        self.assertEqual(ctx.exception.status, 402)
        self.assertEqual(ctx.exception.code, 'insufficient_balance')
        self.assertEqual(ctx.exception.topup_url, 'https://raytracer.si/account.html')


if __name__ == '__main__':
    unittest.main()
