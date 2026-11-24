"""A failed request after creation must keep the recovery sandbox available."""
import unittest
import urllib.error

from raytrace_sdk import RayTrace, RayTraceError


class ConnectNetworkTests(unittest.TestCase):
    def test_connection_failures_keep_the_created_sandbox(self):
        for failure in (urllib.error.URLError('connection reset'), TimeoutError('request timed out')):
            for stage in ('repos', 'commands'):
                with self.subTest(failure=type(failure).__name__, stage=stage):
                    calls = []

                    def transport(method, url, headers, body):
                        path = url.split('https://api.test', 1)[1]
                        calls.append((method, path))
                        if (method, path) == ('POST', '/v1/sandboxes'):
                            return 201, {'id': 'rtp-created', 'status': 'running'}
                        if path.endswith('/' + stage):
                            raise failure
                        if path.endswith('/repos'):
                            return 200, {'repos': ['acme/app']}
                        if method == 'DELETE':
                            return 200, {'id': 'rtp-created', 'status': 'deleted'}
                        self.fail(f'Unexpected request: {method} {path}')

                    client = RayTrace(api_key='test', base_url='https://api.test', transport=transport)
                    with self.assertRaises(RayTraceError) as caught:
                        client.sandboxes.create(files={'app.py': 'print(1)'}, repo='acme/app', connect=True)
                    error = caught.exception
                    self.assertIn('Sandbox rtp-created was created', str(error))
                    self.assertIs(error.__cause__, failure)
                    self.assertEqual(error.status, 0)
                    self.assertEqual(error.sandbox.id, 'rtp-created')
                    self.assertEqual(error.sandbox.status, 'running')
                    error.sandbox.destroy()
                    self.assertEqual(calls[-1], ('DELETE', '/v1/sandboxes/rtp-created'))
                    self.assertEqual(calls.count(('POST', '/v1/sandboxes')), 1)

    def test_creation_failure_is_not_reported_as_a_created_sandbox(self):
        failure = urllib.error.URLError('upload failed')

        def transport(*args):
            raise failure

        client = RayTrace(api_key='test', transport=transport)
        with self.assertRaises(urllib.error.URLError) as caught:
            client.sandboxes.create(files={'app.py': 'print(1)'}, repo='acme/app', connect=True)
        self.assertIs(caught.exception, failure)
        self.assertFalse(hasattr(caught.exception, 'sandbox'))


if __name__ == '__main__':
    unittest.main()
