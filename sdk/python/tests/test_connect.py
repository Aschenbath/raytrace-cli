"""Connecting a sandbox to GitHub: github_repo, connect_script (run with real git), repos, connect_repo, create(connect=)."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from raytrace_sdk import RayTrace, RayTraceError, Sandbox, connect_script, github_repo, work_branch

SID = 'rtp-' + '0123456789abcdef' * 2
HAS_GIT = shutil.which('git') is not None


class HelperTests(unittest.TestCase):
    def test_github_repo_takes_owner_name_and_github_urls_only(self):
        for given, want in [('acme/app', 'acme/app'), ('acme/app.git', 'acme/app'), (' acme/app ', 'acme/app'),
                            ('https://github.com/acme/app', 'acme/app'), ('https://github.com/acme/app/', 'acme/app'),
                            ('git@github.com:acme/app.git', 'acme/app'), ('ssh://git@github.com/acme/my.app.git', 'acme/my.app'),
                            ('HTTPS://GitHub.com/Acme/App', 'Acme/App')]:
            self.assertEqual(github_repo(given), want, given)
        for given in ['', None, 'app', 'acme/app/extra', 'https://gitlab.com/acme/app', 'gitlab.com/acme/app', 'acme/..',
                      '-acme/app', 'acme/app name', 'https://github.com/acme', 'http://github.com/acme/app', "acme/a'pp"]:
            self.assertIsNone(github_repo(given), given)

    def test_work_branch_is_under_the_push_prefix_the_relay_allows(self):
        self.assertEqual(work_branch(SID), 'raytrace/01234567/work')

    def test_connect_script_refuses_what_it_cannot_quote_safely(self):
        with self.assertRaisesRegex(ValueError, 'Not a GitHub repository'):
            connect_script('not a repo', SID)
        for ref in ['-x', 'a..b', 'a b', "a'b", '$(id)']:
            with self.assertRaisesRegex(ValueError, 'Not a branch', msg=ref):
                connect_script('acme/app', SID, ref=ref)
        with self.assertRaisesRegex(ValueError, 'Not a commit'):
            connect_script('acme/app', SID, commit='HEAD')
        script = connect_script('https://github.com/acme/app.git', SID, ref='release/1.2')
        self.assertTrue(script.startswith("set -e\ncd '/workspace'\n"))
        self.assertIn("git remote add origin 'https://github.com/acme/app.git'", script)
        self.assertIn("git fetch -q --depth 1 origin 'release/1.2'\n", script)
        self.assertIn("git checkout -q -b 'raytrace/01234567/work'", script)


@unittest.skipUnless(HAS_GIT, 'git not installed')
class ScriptTests(unittest.TestCase):
    """connect_script run with real git; a bare repository stands in for GitHub, the way the
    sandbox's /etc/gitconfig rewrites https://github.com/ to its relay."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='raytrace-connect-'))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.env = {**os.environ, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': str(self.root / 'gitconfig'),
                    'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@example.invalid',
                    'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@example.invalid'}
        work = self.root / 'work'
        work.mkdir()
        self.git(work, '-c', 'init.defaultBranch=main', 'init', '-q')
        (work / 'app.py').write_text('one\n')
        (work / '.env.example').write_text('KEY=\n')
        self.git(work, 'add', '.')
        self.git(work, 'commit', '-qm', 'one')
        self.first = self.git(work, 'rev-parse', 'HEAD')
        (work / 'app.py').write_text('two\n')
        self.git(work, 'commit', '-qam', 'two')
        self.git(work, 'tag', 'v2')
        self.head = self.git(work, 'rev-parse', 'HEAD')
        bare = self.root / 'app.git'
        self.git(self.root, 'clone', '-q', '--bare', str(work), str(bare))
        self.git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
        (self.root / 'gitconfig').write_text(f'[url "file://{bare}"]\n\tinsteadOf = https://github.com/acme/app.git\n'
                                             '[protocol "file"]\n\tallow = always\n')
        # The uploaded files: the project without .git and without .env.example (a secret-looking name).
        self.sandbox = self.root / 'workspace'
        self.sandbox.mkdir()
        (self.sandbox / 'app.py').write_text('two\n')

    def git(self, cwd, *args):
        return subprocess.run(['git', *args], cwd=cwd, env=self.env, check=True, capture_output=True, text=True).stdout.strip()

    def run_script(self, **options):
        return subprocess.run(['sh', '-c', connect_script('acme/app', SID, directory=str(self.sandbox), **options)],
                              env=self.env, capture_output=True, text=True)

    def test_the_uploaded_files_become_a_clone_on_the_work_branch(self):
        done = self.run_script()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('Connected to acme/app on branch raytrace/01234567/work', done.stdout)
        self.assertEqual(self.git(self.sandbox, 'rev-parse', 'HEAD'), self.head)
        self.assertEqual(self.git(self.sandbox, 'branch', '--show-current'), 'raytrace/01234567/work')
        self.assertEqual(self.git(self.sandbox, 'config', 'remote.origin.url'), 'https://github.com/acme/app.git')
        self.assertEqual(self.git(self.sandbox, 'status', '--porcelain'), '')
        self.assertEqual((self.sandbox / '.env.example').read_text(), 'KEY=\n')
        again = self.run_script()
        self.assertEqual(again.returncode, 0)
        self.assertIn('already a Git repository', again.stderr)

    def test_uploaded_changes_stay_changes_against_the_commit(self):
        (self.sandbox / 'app.py').write_text('mine\n')
        (self.sandbox / 'new.py').write_text('new\n')
        done = self.run_script(commit=self.first)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.git(self.sandbox, 'rev-parse', 'HEAD'), self.first)
        self.assertEqual((self.sandbox / 'app.py').read_text(), 'mine\n')
        status = sorted(line.strip() for line in self.git(self.sandbox, 'status', '--porcelain').split('\n'))
        self.assertEqual(status, ['?? new.py', 'M app.py'])

    def test_a_commit_github_does_not_have_falls_back_to_the_ref(self):
        done = self.run_script(commit='f' * 40, ref='v2')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.git(self.sandbox, 'rev-parse', 'HEAD'), self.head)

    def test_an_unknown_ref_stops_it_before_any_branch(self):
        done = self.run_script(ref='no-such-branch')
        self.assertNotEqual(done.returncode, 0)
        self.assertIn('no-such-branch', done.stderr)
        self.assertNotEqual(subprocess.run(['git', 'rev-parse', '--verify', 'raytrace/01234567/work'], cwd=self.sandbox,
                                           env=self.env, capture_output=True).returncode, 0)
        self.assertEqual((self.sandbox / 'app.py').read_text(), 'two\n')


class FakeApi:
    """A sandbox API that creates SID and answers its one command with `result`."""

    def __init__(self, result=None, attached=(), put_status=200):
        self.calls = []
        self.result, self.attached, self.put_status = result or {}, list(attached), put_status

    def __call__(self, method, url, headers, body):
        path = url.split('https://api.test', 1)[1]
        sent = None
        if body is not None and headers.get('Content-Type') == 'application/json':
            import json
            sent = json.loads(body)
        self.calls.append((method, path, sent))
        if (method, path) == ('POST', '/v1/sandboxes'):
            return 201, {'id': SID, 'name': 'app', 'status': 'running'}
        if (method, path) == ('GET', '/v1/sandboxes'):
            return 200, [{'id': SID, 'status': 'running'}]
        if (method, path) == ('GET', f'/v1/sandboxes/{SID}/repos'):
            return 200, {'id': SID, 'repos': self.attached}
        if (method, path) == ('PUT', f'/v1/sandboxes/{SID}/repos'):
            if self.put_status != 200:
                return self.put_status, {'error': 'Install the RayTrace GitHub App on acme/app and connect it on your account page first.'}
            return 200, {'id': SID, 'repos': sent['repos']}
        if (method, path) == ('POST', f'/v1/sandboxes/{SID}/commands'):
            return 202, {'command_id': 'cmd-1', 'state': 'running'}
        if (method, path) == ('GET', f'/v1/sandboxes/{SID}/commands/cmd-1'):
            return 200, {'command_id': 'cmd-1', **self.result}
        return 404, {'error': 'Not found'}

    def client(self):
        return RayTrace(api_key='k', base_url='https://api.test', transport=self)


class ApiTests(unittest.TestCase):
    def test_repos_lists_and_replaces_the_attached_repositories(self):
        api = FakeApi(attached=['acme/app'])
        box = api.client().sandboxes.get(SID)
        self.assertEqual(box.repos.list(), ['acme/app'])
        self.assertEqual(box.repos.set(['https://github.com/acme/app.git', 'acme/lib']), ['acme/app', 'acme/lib'])
        self.assertEqual(api.calls[-1], ('PUT', f'/v1/sandboxes/{SID}/repos', {'repos': ['acme/app', 'acme/lib']}))
        self.assertEqual(box.repos.set([]), [])
        sent = len(api.calls)
        with self.assertRaisesRegex(ValueError, 'Not a GitHub repository'):
            box.repos.set(['gitlab.com/acme/app'])
        with self.assertRaises(TypeError):
            box.repos.set('acme/app')
        self.assertEqual(len(api.calls), sent)

    def test_repos_set_passes_on_the_apis_refusal(self):
        api = FakeApi(put_status=400)
        with self.assertRaises(RayTraceError) as caught:
            Sandbox(api.client()._t, {'id': SID}).repos.set(['acme/app'])
        self.assertEqual(caught.exception.status, 400)
        self.assertIn('Install the RayTrace GitHub App on acme/app', str(caught.exception))

    def test_create_connect_uploads_attaches_then_runs_the_setup(self):
        api = FakeApi({'state': 'completed', 'exit_code': 0, 'stdout': 'Connected\n', 'stderr': ''}, attached=['acme/lib'])
        box = api.client().sandboxes.create(files={'app.py': 'x'}, repo='acme/app', ref='main', connect=True)
        self.assertEqual(box.git, {'repo': 'acme/app', 'branch': 'raytrace/01234567/work', 'output': 'Connected\n'})
        self.assertEqual([(m, p) for m, p, _ in api.calls], [
            ('POST', '/v1/sandboxes'), ('GET', f'/v1/sandboxes/{SID}/repos'), ('PUT', f'/v1/sandboxes/{SID}/repos'),
            ('POST', f'/v1/sandboxes/{SID}/commands'), ('GET', f'/v1/sandboxes/{SID}/commands/cmd-1')])
        self.assertEqual(api.calls[2][2], {'repos': ['acme/lib', 'acme/app']})
        self.assertEqual(api.calls[3][2]['command'], connect_script('acme/app', SID, ref='main'))
        self.assertEqual(api.calls[3][2]['timeout_seconds'], 300)

    def test_connect_repo_does_not_attach_twice(self):
        api = FakeApi({'state': 'completed', 'exit_code': 0}, attached=['ACME/app'])
        Sandbox(api.client()._t, {'id': SID}).connect_repo('acme/app', poll_interval=0)
        self.assertFalse(any(method == 'PUT' for method, _, _ in api.calls))

    def test_create_connect_checks_repo_and_ref_before_uploading(self):
        api = FakeApi()
        rt = api.client()
        for kwargs, message in [({}, 'connect needs repo'), ({'repo': 'https://gitlab.com/acme/app'}, 'connect needs repo'),
                                ({'repo': 'acme/app', 'ref': '--upload-pack=x'}, 'Not a branch')]:
            with self.assertRaisesRegex(ValueError, message):
                rt.sandboxes.create(files={'a': 'x'}, connect=True, **kwargs)
        self.assertEqual(api.calls, [])

    def test_a_failed_connect_says_the_sandbox_exists_and_hands_it_over(self):
        api = FakeApi({'state': 'completed', 'exit_code': 128, 'stderr': "fatal: couldn't find remote ref nope\n"})
        with self.assertRaises(RayTraceError) as caught:
            api.client().sandboxes.create(files={'a': 'x'}, repo='acme/app', ref='nope', connect=True)
        self.assertEqual(str(caught.exception), f"Sandbox {SID} was created, but could not connect {SID} to acme/app: "
                                                "fatal: couldn't find remote ref nope")
        self.assertEqual(caught.exception.sandbox.id, SID)

        refused = FakeApi(put_status=400)
        with self.assertRaises(RayTraceError) as caught:
            refused.client().sandboxes.create(files={'a': 'x'}, repo='acme/app', connect=True)
        self.assertTrue(str(caught.exception).startswith(f'Sandbox {SID} was created, but Install the RayTrace GitHub App'))
        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(caught.exception.sandbox.id, SID)
        self.assertFalse(any(path.endswith('/commands') for _, path, _ in refused.calls))


if __name__ == '__main__':
    unittest.main()
