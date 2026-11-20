"""The sandbox core library (core/): limits, container config, releases, the
command line's extension points. Docker is never called: subprocess is mocked.

Run: python3 -B -m unittest discover -s worker/sandbox -p 'test_*.py'"""
import fcntl
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock

import core
from core import mechanics, release
import engine
import network

SID = 'rtp-' + 'a' * 32
FORK = 'rtf-' + 'b' * 32


class VersionTests(unittest.TestCase):
    def test_versions_are_integers_and_the_package_version_is_read(self):
        self.assertIsInstance(core.CORE_API, int)
        self.assertIsInstance(core.EVIDENCE_SCHEMA, int)
        package = json.loads((Path(__file__).resolve().parent.parent.parent / 'package.json').read_text())
        self.assertEqual(core.version(), package['version'])


class LimitsTests(unittest.TestCase):
    def test_limits_become_docker_arguments(self):
        self.assertEqual(mechanics.Limits(cpus='4', memory='8g', pids=1024, tmp='2g').args(),
                         ['--memory=8g', '--cpus=4', '--pids-limit=1024', '--tmpfs=/tmp:rw,nosuid,nodev,size=2g'])

    def test_default_limits_are_todays(self):
        self.assertEqual(mechanics.DEFAULT_LIMITS.args(),
                         ['--memory=2g', '--cpus=2', '--pids-limit=256', '--tmpfs=/tmp:rw,nosuid,nodev,size=512m'])

    def test_anything_that_could_add_an_argument_is_refused(self):
        for bad in ({'cpus': '2 --privileged'}, {'memory': '2g,'}, {'pids': 0}, {'tmp': '1g;rm'}):
            with self.assertRaises(ValueError):
                mechanics.Limits(**bad)


class ContainerTests(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.object(mechanics, 'bridge', return_value='http://172.30.60.1:8799')
        patch.start()
        self.addCleanup(patch.stop)

    def test_projects_and_forks_get_one_configuration(self):
        project = mechanics.container_args(SID, ['--label', 'x=1'], image_name='img:1')
        self.assertIn('--runtime=raytace-gvisor', project)
        self.assertIn('--cap-drop=ALL', project)
        self.assertIn('--network=raytace-egress', project)
        self.assertIn('--user=1000:1000', project)
        self.assertEqual(project[-2:], ['img:1', 'infinity'])
        self.assertIn('RAYTRACE_SESSION=' + SID, project)
        fork = mechanics.container_args(FORK, ['--label', 'x=1'], image_name='img:1')
        strip = lambda args, name: [a.replace(name, 'ID') for a in args]
        self.assertEqual(strip(project, SID), strip(fork, FORK))

    def test_given_limits_are_applied(self):
        args = mechanics.container_args(SID, [], mechanics.Limits(cpus='1', memory='2g', pids=256, tmp='512m'), 'img')
        self.assertIn('--cpus=1', args)
        self.assertNotIn('--cpus=2', args)

    def test_image_is_the_active_releases_then_the_built_one_then_the_old_name(self):
        with tempfile.TemporaryDirectory() as folder:
            image_file = Path(folder) / 'image'
            with mock.patch.object(mechanics, 'IMAGE_FILE', image_file), mock.patch.object(release, 'active', return_value=None):
                self.assertEqual(mechanics.image(), 'raytace-gvisor-agent')
                image_file.write_text('raytace-gvisor-agent:0.18.0\n')
                self.assertEqual(mechanics.image(), 'raytace-gvisor-agent:0.18.0')
                image_file.write_text('bad name; rm -rf /\n')
                self.assertEqual(mechanics.image(), 'raytace-gvisor-agent')
            with mock.patch.object(release, 'active', return_value={'id': 'f' * 16, 'image': 'raytrace-sandbox:' + 'f' * 16}):
                self.assertEqual(mechanics.image(), 'raytrace-sandbox:' + 'f' * 16)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.current = self.root / 'current'
        self.lock_path = self.root / 'release.lock'

    def stage(self, rid):
        directory = self.root / 'releases' / rid
        directory.mkdir(parents=True)
        (directory / 'release.json').write_text(json.dumps({'id': rid, 'image': 'raytrace-sandbox:' + rid}))
        return directory

    def test_no_releases_means_none_active(self):
        self.assertIsNone(release.active(self.current))

    def test_activation_switches_the_symlink_and_restarts(self):
        restarted = []
        first = self.stage('a' * 16)
        release.activate(first, lambda: restarted.append(1), lambda: None, self.current, self.lock_path)
        self.assertEqual(release.active(self.current)['id'], 'a' * 16)
        second = self.stage('b' * 16)
        release.activate(second, lambda: restarted.append(2), lambda: None, self.current, self.lock_path)
        self.assertEqual(release.active(self.current)['id'], 'b' * 16)
        self.assertEqual(restarted, [1, 2])

    def test_failed_health_check_puts_the_previous_release_back(self):
        first, second = self.stage('a' * 16), self.stage('b' * 16)
        release.activate(first, lambda: None, lambda: None, self.current, self.lock_path)
        restarts = []
        def check():
            raise SystemExit('collector did not come up')
        with self.assertRaises(SystemExit):
            release.activate(second, lambda: restarts.append(release.active(self.current)['id']), check, self.current, self.lock_path)
        self.assertEqual(release.active(self.current)['id'], 'a' * 16)
        self.assertEqual(restarts, ['b' * 16, 'a' * 16])

    def test_failed_first_activation_leaves_no_release_active(self):
        first = self.stage('a' * 16)
        with self.assertRaises(RuntimeError):
            release.activate(first, lambda: None, mock.Mock(side_effect=RuntimeError('down')), self.current, self.lock_path)
        self.assertIsNone(release.active(self.current))

    def test_a_manifest_must_name_its_own_directory(self):
        directory = self.stage('a' * 16)
        (directory / 'release.json').write_text(json.dumps({'id': 'b' * 16, 'image': 'x'}))
        with self.assertRaises(ValueError):
            release.activate(directory, lambda: None, lambda: None, self.current, self.lock_path)

    def test_activation_waits_for_a_create_holding_the_shared_lock(self):
        first, second = self.stage('a' * 16), self.stage('b' * 16)
        release.activate(first, lambda: None, lambda: None, self.current, self.lock_path)
        seen, holding, done = [], threading.Event(), threading.Event()
        def creating():
            with release.lock(shared=True, path=self.lock_path):
                holding.set()
                seen.append(release.active(self.current)['id'])
                time.sleep(0.3)
                seen.append(release.active(self.current)['id'])
        thread = threading.Thread(target=creating)
        thread.start()
        holding.wait()
        release.activate(second, lambda: None, lambda: None, self.current, self.lock_path)
        thread.join()
        self.assertEqual(seen, ['a' * 16, 'a' * 16])
        self.assertEqual(release.active(self.current)['id'], 'b' * 16)


class CreateTests(unittest.TestCase):
    def setUp(self):
        for name in ('validate_archive', 'preflight', 'import_archive', 'remember'):
            patch = mock.patch.object(mechanics, name)
            patch.start()
            self.addCleanup(patch.stop)
        self.made = mock.patch.object(mechanics, 'create_container', return_value='cid').start()
        self.addCleanup(mock.patch.stopall)
        self.archive = f'/tmp/{SID}.tar.gz'

    def test_without_a_release_the_default_image_is_used(self):
        self.assertEqual(mechanics.create(SID, self.archive), 'cid')
        self.assertEqual(self.made.call_args.args[:2], (SID, ["--label", mechanics.LABEL + "=" + SID]))  # image: image()

    def test_a_different_active_release_refuses_the_create(self):
        with mock.patch.object(release, 'lock'), mock.patch.object(release, 'active', return_value={'id': 'b' * 16, 'image': 'i'}):
            with self.assertRaises(SystemExit) as raised:
                mechanics.create(SID, self.archive, expect_release='a' * 16)
        self.assertIn('b' * 16, str(raised.exception))
        self.made.assert_not_called()

    def test_the_expected_release_creates_from_its_image_and_labels_it(self):
        with mock.patch.object(release, 'lock') as lock, \
                mock.patch.object(release, 'active', return_value={'id': 'a' * 16, 'image': 'raytrace-sandbox:x'}):
            mechanics.create(SID, self.archive, mechanics.Limits(cpus='1'), expect_release='a' * 16)
        lock.assert_called_once_with(shared=True)
        name, labels, limits, image_name = self.made.call_args.args
        self.assertIn(release.LABEL + '=' + 'a' * 16, labels)
        self.assertEqual((limits.cpus, image_name), ('1', 'raytrace-sandbox:x'))

    def test_only_a_staged_archive_is_read(self):
        with self.assertRaises(ValueError):
            mechanics.create(SID, '/etc/passwd')


class CommandLineTests(unittest.TestCase):
    def test_a_host_layer_adds_actions(self):
        state = {'Id': 'c' * 64, 'State': {'Running': True}}
        called = []
        with mock.patch.object(mechanics, 'inspect', return_value=state):
            mechanics.main({'stats': lambda opts, s: called.append(('stats', s)),
                            'ping': lambda opts, s: called.append(('ping', opts.id, s))}, argv=['stats'])
            mechanics.main({'ping': lambda opts, s: called.append(('ping', opts.id, s))}, argv=['ping', SID])
        self.assertEqual(called, [('stats', None), ('ping', SID, state)])

    def test_unknown_actions_are_refused(self):
        with self.assertRaises(SystemExit), mock.patch('sys.stderr'):
            mechanics.main(argv=['no-such-action', SID])

    def test_fork_credentials_follow_the_callers_policy(self):
        request = {'parent': SID, 'commit': 'c' * 40, 'session': '12345678-1234-1234-1234-123456789012', 'transcript': '', 'hook': 'x'}
        copied = []
        def as_node(container, *command, data=None, check=True):
            if command[:2] == ('tar', '-c'):
                copied.append(command[4:])
            return b''
        def runs(request, policy):
            copied.clear()
            with mock.patch('sys.stdin') as stdin, mock.patch.object(mechanics, 'inspect', return_value={'Config': {'Image': 'img'}}), \
                    mock.patch.object(mechanics, 'preflight'), mock.patch.object(mechanics, 'fork_container', return_value='cid'), \
                    mock.patch.object(mechanics, 'run'), mock.patch.object(mechanics, 'remember'), \
                    mock.patch.object(mechanics, 'start_container'), mock.patch.object(mechanics, 'install_claude_hooks'), \
                    mock.patch.object(mechanics, 'as_node', side_effect=as_node), mock.patch('builtins.print'), \
                    mock.patch('subprocess.run', return_value=mock.Mock(returncode=0)):
                stdin.buffer.read.return_value = json.dumps(request).encode()
                mechanics.fork_action('fork-create', FORK, credentials=policy)
            return bool(copied)
        self.assertTrue(runs(request, None))   # local: the owner's own fork
        self.assertFalse(runs({**request, 'credentials': False}, None))
        strict = lambda data: data.get('credentials') is True
        self.assertFalse(runs(request, strict))
        self.assertTrue(runs({**request, 'credentials': True}, strict))

    def test_delete_runs_registered_cleanups(self):
        cleaned = []
        mechanics.register_delete_cleanup(cleaned.append)
        self.addCleanup(mechanics.DELETE_CLEANUP.clear)
        with mock.patch.object(mechanics, 'inspect', return_value={'Id': 'c' * 64, 'State': {'Running': False}}), \
                mock.patch.object(mechanics, 'run'), mock.patch.object(mechanics, 'CONTAINERS', Path('/nonexistent')), \
                mock.patch.object(mechanics, 'HOOKS', Path('/nonexistent')), mock.patch.object(mechanics, 'GUARDRAILS', Path('/nonexistent')), \
                mock.patch('subprocess.run', return_value=mock.Mock(returncode=1)):
            mechanics.delete(SID)
        self.assertEqual(cleaned, [SID])


class BridgeFrontTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        root = Path(self.folder.name)
        self.files = {'BRIDGE': root / 'bridge', 'BRIDGE_FRONT': root / 'bridge-front', 'BRIDGE_UPSTREAM': root / 'bridge-upstream'}
        for module in (network, engine):
            for name, path in self.files.items():
                if hasattr(module, name):
                    patch = mock.patch.object(module, name, path)
                    patch.start()
                    self.addCleanup(patch.stop)

    def test_without_a_front_sandboxes_reach_the_bridge_directly(self):
        self.assertIsNone(network.write_bridge('10.0.0.5:8799'))
        self.assertEqual(self.files['BRIDGE'].read_text(), 'http://10.0.0.5:8799\n')
        self.assertEqual(engine.bridge_addresses(), {'10.0.0.5:8799'})

    def test_with_a_front_sandboxes_reach_it_and_both_are_raytraces_own(self):
        self.files['BRIDGE_FRONT'].write_text('8790\n')
        self.assertEqual(network.write_bridge('10.0.0.5:8799'), 8790)
        self.assertEqual(self.files['BRIDGE'].read_text(), f'http://{network.GATEWAY}:8790\n')
        self.assertEqual(engine.bridge_addresses(), {f'{network.GATEWAY}:8790', '10.0.0.5:8799'})
        # And the next run of network.py still finds the bridge itself.
        self.assertEqual(network.private_bridge(), '10.0.0.5:8799')

    def test_a_bad_front_port_is_ignored(self):
        for text in ('53', 'abc', '70000'):
            self.files['BRIDGE_FRONT'].write_text(text)
            self.assertIsNone(network.front_port())


if __name__ == '__main__':
    unittest.main()
