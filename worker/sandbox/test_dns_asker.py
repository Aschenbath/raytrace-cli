"""Which process asked a lookup: engine.py notes each connection to the
sandbox network's resolver, and dns_forwarder.py names the process whose
connection is closest in time to the lookup. Run: python3 -B -m unittest discover -s worker/sandbox -p 'test_*.py'"""
from pathlib import Path
import sqlite3
import sys
import unittest

sys.path.insert(0, str(Path(__file__).parent))
import dns_forwarder  # noqa: E402
import engine  # noqa: E402
import network  # noqa: E402

CONTAINER = 'c' * 64
AT = 1_800_000_000_000_000_000


class EngineNotesResolverConnections(unittest.TestCase):
    def setUp(self):
        self.engine = engine.Engine(':memory:', arch='aarch64', watch=False)
        self.engine.db = sqlite3.connect(':memory:')
        self.engine.db.executescript(engine.SCHEMA)
        self.box = engine.Sandbox(CONTAINER)
        self.box.ip = '172.30.60.3'
        self.box.processes[10] = {'start_ns': '10', 'ppid': 1, 'name': 'curl', 'argv': ['curl', 'https://example.com'], 'call_id': 'call_1'}

    def connect(self, ip, port, errno=0):
        self.engine.connected(self.box, {'kind': 'connect', 'family': 'inet', 'ip': ip, 'port': port, 'errno': errno,
                                         'pid': 10, 'ppid': 1, 'process_start_ns': '10', 'timestamp_ns': str(AT)})

    def test_a_connection_to_the_resolver_is_noted_with_its_process_and_call_and_is_no_network_fact(self):
        self.connect(network.GATEWAY, 53)
        self.engine.flush()
        rows = self.engine.db.execute('SELECT container_id, at_ns, pid, process_start_ns, process, command, call_id FROM resolver_calls').fetchall()
        self.assertEqual(rows, [(CONTAINER, AT, 10, '10', 'curl', 'curl https://example.com', 'call_1')])
        self.assertEqual([fact for fact in self.engine.facts.values() if fact['kind'] == 'network'], [])

    def test_a_refused_connection_to_the_resolver_and_other_connections_are_not_noted(self):
        self.connect(network.GATEWAY, 53, errno=111)
        self.connect('93.184.216.34', 443)
        self.engine.flush()
        self.assertEqual(self.engine.db.execute('SELECT count(*) FROM resolver_calls').fetchone()[0], 0)
        self.assertEqual(len([fact for fact in self.engine.facts.values() if fact['kind'] == 'network']), 1)


class ForwarderNamesTheAsker(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.executescript(engine.SCHEMA)
        dns_forwarder.facts.clear()
        dns_forwarder.dirty.clear()
        self.addCleanup(dns_forwarder.facts.clear)
        self.addCleanup(dns_forwarder.dirty.clear)

    def connected(self, pid, at_ns, call_id=None, container=CONTAINER):
        self.db.execute('INSERT INTO resolver_calls VALUES (?,?,?,?,?,?,?)', (container, at_ns, pid, str(pid), f'proc{pid}', f'proc{pid} x', call_id))

    def looked_up(self, name, at_ns=AT):
        lookup = {'container': (CONTAINER, False), 'name': name, 'kind': 1, 'code': 3, 'addresses': [], 'at_ns': at_ns}
        dns_forwarder.settle(lookup, dns_forwarder.asker(self.db, CONTAINER, at_ns))
        return [fact for fact in dns_forwarder.facts.values() if fact['name'] == name]

    def test_the_process_that_connected_just_before_is_named(self):
        self.connected(10, AT - 2_000_000, 'call_1')
        [fact] = self.looked_up('a.invalid')
        self.assertEqual((fact['pid'], fact['call_id'], fact['process'], fact['certainty']), (10, 'call_1', 'proc10', 'likely'))
        self.assertEqual(fact['basis']['gap_ms'], 2.0)
        self.assertEqual(fact['failed'], 'NXDOMAIN')

    def test_with_two_processes_at_it_nobody_is_named_and_both_are_listed(self):
        # Measured: two processes asking within a millisecond are told apart by time only ~70% of the time.
        self.connected(10, AT - 30_000_000, 'call_1')
        self.connected(20, AT - 1_000_000, 'call_2')
        [fact] = self.looked_up('b.invalid')
        self.assertEqual((fact['pid'], fact['call_id']), (None, None))
        self.assertNotIn('certainty', fact)
        self.assertEqual(sorted(other['call_id'] for other in fact['basis']['candidates']), ['call_1', 'call_2'])
        self.connected(30, AT + 9_000_000, 'call_3')
        self.connected(40, AT + 9_500_000, 'call_4')
        [fact] = self.looked_up('b.invalid', AT + 10_000_000)
        self.assertEqual(fact['count'], 2)
        self.assertEqual(len(fact['basis']['candidates']), 4)

    def test_nobody_in_the_window_or_another_sandbox_leaves_it_unnamed_as_before(self):
        self.connected(10, AT - dns_forwarder.ASKED_BEFORE - 1, 'call_1')
        self.connected(20, AT - 1_000_000, 'call_2', container='d' * 64)
        [fact] = self.looked_up('c.invalid')
        self.assertEqual((fact['pid'], fact['call_id']), (None, None))
        self.assertNotIn('certainty', fact)

    def test_one_fact_per_name_and_step_with_a_count(self):
        self.connected(10, AT - 1_000_000, 'call_1')
        self.looked_up('d.invalid')
        [fact] = self.looked_up('d.invalid', AT + 1_000)
        self.assertEqual(fact['count'], 2)
        self.connected(20, AT + 100_000_000, 'call_2')
        facts = self.looked_up('d.invalid', AT + 101_000_000)
        self.assertEqual(sorted(fact['call_id'] for fact in facts), ['call_1', 'call_2'])


if __name__ == '__main__':
    unittest.main()
