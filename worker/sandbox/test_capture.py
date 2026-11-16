"""Raw-call context and failed execs. Run: python3 -B -m unittest discover -s worker/sandbox -p 'test_*.py'"""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parent))
import collector  # noqa: E402
import engine  # noqa: E402
import setup  # noqa: E402

HERE = Path(__file__).parent


def attempt(pid, executable, argv):
    return {'kind': 'exec_attempt', 'pid': pid, 'ppid': 1, 'executable': executable, 'argv': argv,
            'timestamp_ns': '1794866886430727989', 'process_start_ns': '1794866886430553658', 'container_id': 'c' * 64,
            'markers': {'RAYTRACE_CALL_ID': 'call_1'}}


class TraceConfig(unittest.TestCase):
    def test_a_number_only_call_has_its_enter_point_with_the_same_context(self):
        config = setup.trace_config('aarch64', (HERE / 'syscall_catalog.sql').read_text(), '/run/x.sock')
        points = {point['name']: point for point in config['trace_session']['points']}
        for number in (34, 35, 38, 45, 46, 52, 53, 276):   # mkdirat unlinkat renameat truncate ftruncate fchmod fchmodat renameat2
            enter, leave = points[f'syscall/sysno/{number}/enter'], points[f'syscall/sysno/{number}/exit']
            self.assertEqual(enter['context_fields'], leave['context_fields'])
            self.assertIn('container_id', enter['context_fields'])
            self.assertIn('group_id', enter['context_fields'])
        # Typed points carry their own context, and the exec points are as they were.
        self.assertNotIn('syscall/openat/enter', points)
        self.assertNotIn('syscall/sysno/221/enter', points)


class RawCalls(unittest.TestCase):
    def setUp(self):
        self.engine = engine.Engine(':memory:', arch='aarch64', watch=False)

    def test_the_enter_event_is_taken_and_not_queued(self):
        self.assertTrue(self.engine.accept({'kind': 'syscall_enter', 'sysno': 35, 'container_id': 'c' * 64}))
        self.assertTrue(self.engine.inbox.empty())
        self.assertTrue(self.engine.accept({'kind': 'syscall_return', 'sysno': 35, 'container_id': 'c' * 64}))
        self.assertEqual(self.engine.inbox.qsize(), 1)

    def test_a_refused_delete_with_its_process_is_an_attempt_by_that_process(self):
        box = engine.Sandbox('c' * 64)
        box.workspace, box.guarded = '/nowhere', {'config/keys.js': 'watched'}
        box.processes[41] = {'start_ns': '5', 'ppid': 1, 'name': 'rm', 'argv': ['rm', 'config/keys.js'], 'call_id': 'call_9'}
        self.engine.numbered_call(box, {'kind': 'syscall_return', 'sysno': 35, 'errno': 13, 'pid': 41, 'ppid': 1,
                                        'process_start_ns': '5', 'timestamp_ns': '100', 'cwd': '/workspace'})
        (fact,) = self.engine.facts.values()
        self.assertEqual((fact['path'], fact['effect'], fact['intent'], fact['pid'], fact['call_id']),
                         ('config/keys.js', 'attempted', 'delete', 41, 'call_9'))
        self.assertEqual(box.raw[0]['who']['pid'], 41)


class FailedExecs(unittest.TestCase):
    def setUp(self):
        self.attempts = collector.ExecAttempts()

    def test_an_attempt_no_program_follows_failed_when_the_process_exits(self):
        self.assertEqual(self.attempts.see(attempt(7, '/workspace/missing', ['/workspace/missing'])), [])
        self.assertEqual(self.attempts.see({'kind': 'exec_syscall_return', 'pid': 7, 'errno': 0}), [])
        (failed,) = self.attempts.see({'kind': 'process_exit', 'pid': 7, 'exit_code': 255})
        self.assertEqual((failed['kind'], failed['errno'], failed['argv'], failed['tried']),
                         ('exec_failed', None, ['/workspace/missing'], ['/workspace/missing']))
        self.assertEqual(failed['markers'], {'RAYTRACE_CALL_ID': 'call_1'})
        self.assertIn('inferred', failed)
        self.assertEqual(self.attempts.see({'kind': 'process_exit', 'pid': 7}), [])   # gVisor's second exit event

    def test_a_path_search_that_finds_the_program_is_no_failure(self):
        for folder in ('/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin'):
            self.assertEqual(self.attempts.see(attempt(9, folder + '/python3', ['python3', '-c', 'pass'])), [])
        self.assertEqual(self.attempts.see({'kind': 'exec_succeeded', 'pid': 9}), [])
        self.assertEqual(self.attempts.see({'kind': 'process_exit', 'pid': 9}), [])

    def test_a_path_search_that_finds_nothing_is_one_failure(self):
        for folder in ('/usr/local/bin', '/usr/bin', '/bin'):
            self.attempts.see(attempt(9, folder + '/nope', ['nope']))
        (failed,) = self.attempts.see({'kind': 'process_exit', 'pid': 9})
        self.assertEqual(failed['tried'], ['/usr/local/bin/nope', '/usr/bin/nope', '/bin/nope'])

    def test_a_failure_then_another_program_in_the_same_process(self):
        self.attempts.see(attempt(3, '/a', ['/a']))
        (failed,) = self.attempts.see(attempt(3, '/bin/b', ['/bin/b']))
        self.assertEqual(failed['argv'], ['/a'])
        self.assertEqual(self.attempts.see({'kind': 'exec_succeeded', 'pid': 3}), [])
        self.assertEqual(self.attempts.see({'kind': 'process_exit', 'pid': 3}), [])

    def test_a_failure_gvisor_reported_is_not_said_twice(self):
        self.attempts.see(attempt(4, '/a', ['/a']))
        self.assertEqual(self.attempts.see({'kind': 'exec_failed', 'pid': 4, 'errno': 14}), [])
        self.assertEqual(self.attempts.see({'kind': 'process_exit', 'pid': 4}), [])

    def test_the_failure_is_json_and_carries_no_raw_packet(self):
        self.attempts.see(attempt(5, '/a', ['/a']))
        (failed,) = self.attempts.see({'kind': 'process_exit', 'pid': 5})
        self.assertNotIn('raw_packet_base64', json.loads(json.dumps(failed)))


if __name__ == '__main__':
    unittest.main()
