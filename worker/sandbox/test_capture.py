"""Raw-call context and failed execs. Run: python3 -B -m unittest discover -s worker/sandbox -p 'test_*.py'"""
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
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


class WhoChangedIt(unittest.TestCase):
    """engine.look(): a change goes to the process that made it, not to
    whoever opened that name before."""
    def setUp(self):
        self.now = 1000.0
        self.engine = engine.Engine(':memory:', arch='aarch64', watch=False, clock=lambda: self.now)
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.box = engine.Sandbox('c' * 64)
        self.box.workspace, self.box.ip = self.folder.name, '172.30.60.3'
        self.write('keys.js', 'one')
        self.box.guarded = {'keys.js': 'watched'}
        self.box.photos['keys.js'] = engine.photo(self.folder.name, 'keys.js')
        for pid, name in ((10, 'python3'), (20, 'sed'), (30, 'truncate')):
            self.box.processes[pid] = {'start_ns': str(pid), 'ppid': 1, 'name': name, 'argv': [name], 'call_id': f'call_{pid}'}

    def write(self, name, text):
        (Path(self.folder.name) / name).write_text(text)

    def opened(self, pid, name='keys.js', flags=engine.O_TRUNC | 1):
        self.engine.opened(self.box, {'kind': 'open', 'pathname': '/workspace/' + name, 'flags': flags, 'errno': 0, 'pid': pid,
                                      'ppid': 1, 'process_start_ns': str(pid), 'timestamp_ns': str(time.time_ns()), 'sysno': 56})

    def call(self, pid, sysno, errno=0):
        self.engine.numbered_call(self.box, {'kind': 'syscall_return', 'sysno': sysno, 'errno': errno, 'pid': pid, 'ppid': 1,
                                             'process_start_ns': str(pid), 'timestamp_ns': str(time.time_ns()), 'cwd': '/workspace'})

    def changed(self, *words):
        self.engine.noticed(self.box, 'keys.js', list(words))
        self.engine.look(self.box, 'keys.js')
        return [fact for fact in self.engine.facts.values() if fact['kind'] == 'file' and fact['effect'] not in ('read', 'opened_for_writing')]

    def earlier_writer(self):
        """Process 10 writes the file, exits, and its change is recorded."""
        self.opened(10)
        self.write('keys.js', 'two')
        self.engine.exited(self.box, {'pid': 10, 'process_start_ns': '10'})
        (fact,) = self.changed('modify', 'close_write')
        self.assertEqual((fact['pid'], fact['certainty']), (10, 'confirmed'))
        self.engine.facts.clear()
        self.now += 60

    def test_a_writer_that_exited_is_not_credited_with_a_later_change(self):
        self.earlier_writer()
        self.write('keys.js', 'three')
        (fact,) = self.changed('modify', 'close_write')
        self.assertEqual((fact['pid'], fact['certainty']), (None, 'unattributed'))

    def test_exit_brings_the_look_forward(self):
        self.opened(10)
        self.box.due.clear()
        self.engine.exited(self.box, {'pid': 10, 'process_start_ns': '10'})
        self.assertIn('keys.js', self.box.due)

    def test_a_file_moved_over_it_is_the_movers(self):
        self.earlier_writer()
        self.opened(10)                 # another process still has the name open
        self.write('keys.js', 'by sed')
        self.call(20, 38)               # renameat
        (fact,) = self.changed('moved_to', 'close_write')
        self.assertEqual((fact['pid'], fact['call_id'], fact['certainty'], fact['basis']['syscall']), (20, 'call_20', 'confirmed', 'renameat'))

    def test_truncate_is_the_truncaters(self):
        self.earlier_writer()
        self.write('keys.js', '')
        self.call(30, 45)               # truncate
        (fact,) = self.changed('modify')
        self.assertEqual((fact['effect'], fact['pid'], fact['certainty']), ('emptied', 30, 'confirmed'))

    def test_a_write_through_a_symbolic_link_or_a_hard_link(self):
        for make in (lambda: os.symlink('keys.js', Path(self.folder.name) / 'alias'),
                     lambda: os.link(Path(self.folder.name) / 'keys.js', Path(self.folder.name) / 'alias')):
            with self.subTest():
                make()
                self.opened(20, 'alias')
                (Path(self.folder.name) / 'alias').write_text('through ' + str(self.now))
                (fact,) = self.changed('modify', 'close_write')
                self.assertEqual((fact['pid'], fact['certainty'], fact['basis']['resolution'], fact['basis']['via']), (20, 'confirmed', 'link', 'alias'))
                self.engine.facts.clear()
                self.box.aliases.clear()
                os.unlink(Path(self.folder.name) / 'alias')
                self.now += 60

    def test_a_link_out_of_the_project_is_not_followed(self):
        os.symlink('/etc/hostname', Path(self.folder.name) / 'alias')
        self.opened(20, 'alias')
        self.write('keys.js', 'someone')
        (fact,) = self.changed('modify', 'close_write')
        self.assertEqual(fact['certainty'], 'unattributed')

    def test_a_folder_argument_reaches_its_files_only_for_a_file_tool(self):
        self.box.guarded = {'src/a.js': 'watched', 'src/b.js': 'watched'}
        script = {'name': 'python3', 'argv': ['python3', 'run.py', 'src']}
        self.assertEqual(self.engine.named(self.box, script, '/workspace'), [])
        self.assertEqual(self.engine.named(self.box, {'name': 'rm', 'argv': ['rm', '-r', 'src']}, '/workspace'),
                         [('src/a.js', 'argv_folder'), ('src/b.js', 'argv_folder')])
        self.assertEqual(self.engine.named(self.box, {'name': 'python3', 'argv': ['python3', 'run.py', 'src/a.js']}, '/workspace'), [('src/a.js', 'argv')])

    def test_a_connection_to_its_own_address_is_the_sandbox_talking_to_itself(self):
        event = {'kind': 'connect', 'family': 'inet', 'ip': '172.30.60.3', 'port': 18082, 'errno': 0, 'pid': 10, 'ppid': 1, 'process_start_ns': '10'}
        self.engine.connected(self.box, event)
        self.assertEqual(self.engine.facts, {})
        self.engine.db = sqlite3.connect(':memory:')
        self.engine.db.executescript(engine.SCHEMA)
        self.engine.connected(self.box, {**event, 'ip': '172.30.60.9'})   # another machine in that range
        (fact,) = self.engine.facts.values()
        self.assertEqual(fact['outcomes'], {'refused_by_policy': 1})


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
