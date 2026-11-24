import unittest
from urllib.parse import urlsplit

from raytrace_sdk import RayTrace, RayTraceError


SID = 'rtp-' + 'a' * 32


def restoring_sandbox(replies):
    started = False
    polls = []

    def transport(method, url, _headers, _body):
        nonlocal started
        if method == 'POST' and urlsplit(url).path.endswith('/start'):
            started = True
            return 202, {'id': SID, 'status': 'starting', 'restoring': True}
        if not started:
            return 200, [{'id': SID, 'status': 'archived'}]
        polls.append(url)
        return 200, replies.pop(0)

    rt = RayTrace(api_key='test', transport=transport)
    return rt.sandboxes.get(SID), polls


class RestoreCompletionTests(unittest.TestCase):
    def test_waits_until_restoring_is_false(self):
        for status in ('running', 'archived'):
            with self.subTest(status=status):
                finished = {'id': SID, 'status': 'running', 'restoring': False,
                            'restored_from_archive': True}
                sandbox, polls = restoring_sandbox([
                    [{'id': SID, 'status': status, 'restoring': True}],
                    [finished],
                ])
                self.assertEqual(sandbox.start(poll_interval=0), finished)
                self.assertEqual(len(polls), 2)

    def test_reports_sandbox_that_disappears_during_restoration(self):
        sandbox, _polls = restoring_sandbox([[]])
        with self.assertRaisesRegex(RayTraceError, 'disappeared') as caught:
            sandbox.start(poll_interval=0)
        self.assertEqual(caught.exception.status, 404)

    def test_can_explicitly_skip_waiting(self):
        sandbox, polls = restoring_sandbox([])
        self.assertTrue(sandbox.start(wait_for_restore=False)['restoring'])
        self.assertEqual(polls, [])

    def test_server_restore_error_is_preserved(self):
        sandbox, _polls = restoring_sandbox([
            [{'id': SID, 'status': 'archived', 'restore_error': 'archive unreadable'}],
        ])
        with self.assertRaisesRegex(RayTraceError, 'archive unreadable') as caught:
            sandbox.start(poll_interval=0)
        self.assertEqual(caught.exception.status, 500)


if __name__ == '__main__':
    unittest.main()
