import unittest
from urllib.parse import urlsplit

from raytrace_sdk import RayTrace


SID = 'rtp-' + 'a' * 32


def sandbox_with_jobs(jobs):
    requests = []

    def transport(method, url, _headers, _body):
        path = urlsplit(url).path
        if path == '/v1/sandboxes':
            return 200, [{'id': SID, 'status': 'running'}]
        requests.append((method, path))
        return 200, jobs.pop(0)

    rt = RayTrace(api_key='test', transport=transport)
    return rt.sandboxes.get(SID), requests


class CommandRecoveryTests(unittest.TestCase):
    def test_waits_for_recovery_from_initial_and_polled_responses(self):
        for initial in ('queued', 'interrupted'):
            with self.subTest(initial=initial):
                pending = {'command_id': 'cmd-1', 'state': 'interrupted', 'recovery_pending': True}
                sandbox, requests = sandbox_with_jobs([
                    {'command_id': 'cmd-1', 'state': 'queued'} if initial == 'queued' else pending,
                    pending,
                    {'command_id': 'cmd-1', 'state': 'completed', 'exit_code': 0,
                     'stdout': 'final output', 'recovery_pending': False},
                ])
                result = sandbox.exec('echo ready', poll_interval=0)
                self.assertEqual(result.state, 'completed')
                self.assertEqual(result.exit_code, 0)
                self.assertEqual(result.stdout, 'final output')
                self.assertEqual([method for method, _path in requests], ['POST', 'GET', 'GET'])
                self.assertEqual(requests[2][1], f'/v1/sandboxes/{SID}/commands/cmd-1')

    def test_final_interrupted_result_does_not_poll_again(self):
        sandbox, requests = sandbox_with_jobs([
            {'command_id': 'cmd-1', 'state': 'interrupted', 'stderr': 'host stopped'},
        ])
        result = sandbox.exec('echo ready', poll_interval=0)
        self.assertEqual(result.state, 'interrupted')
        self.assertEqual(result.stderr, 'host stopped')
        self.assertEqual(len(requests), 1)


if __name__ == '__main__':
    unittest.main()
