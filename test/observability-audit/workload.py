#!/usr/bin/env python3
"""Observability-audit workload. Runs INSIDE a disposable RayTrace sandbox.

    python3 workload.py <test> <dir>

Does one ordinary development activity and prints ONE JSON line: the
independent ground truth of what it did (operation, target, the outcome the
kernel returned, and the file's hash afterwards). Nothing here reads RayTrace's
telemetry. Only synthetic data, loopback services and a disposable SQLite file.
"""
import hashlib
import json
import mmap
import os
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

TEST, DIR = sys.argv[1], sys.argv[2]
P = lambda *parts: os.path.join(DIR, *parts)
ACTIONS = []


def sha(path):
    try:
        with open(path, 'rb') as handle:
            return hashlib.sha256(handle.read()).hexdigest()
    except OSError:
        return None


def act(op, target, fn, **extra):
    """Runs one operation and records what really happened."""
    record = {'op': op, 'target': target, 'pid': os.getpid(), 'at_ns': time.time_ns(), **extra}
    try:
        result = fn()
        record['ok'] = True
        if isinstance(result, (int, str, list, dict)) and not isinstance(result, bool):
            record['result'] = result
    except OSError as error:
        record.update(ok=False, errno=error.errno, error=type(error).__name__)
    except Exception as error:  # noqa: BLE001 - ground truth wants every outcome
        record.update(ok=False, error=f'{type(error).__name__}: {error}'[:200])
    if isinstance(target, str) and target.startswith('/'):
        record['exists_after'] = os.path.lexists(target)
        record['sha256_after'] = sha(target)
    ACTIONS.append(record)
    return record


def write(path, text, mode='w'):
    with open(path, mode) as handle:
        handle.write(text)


def read(path):
    with open(path) as handle:
        return len(handle.read())


def ensure(path, text='seed line a\nseed line b\n'):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        write(path, text)


def run(argv, **kwargs):
    done = subprocess.run(argv, capture_output=True, **kwargs)
    return {'pid_unknown': True, 'returncode': done.returncode}


class Quiet(BaseHTTPRequestHandler):
    def do_GET(self):
        ok = self.path == '/ok'
        self.send_response(200 if ok else 404)
        self.end_headers()
        self.wfile.write(b'mock\n')

    def do_POST(self):
        self.rfile.read(int(self.headers.get('content-length') or 0))
        self.send_response(201)
        self.end_headers()

    def log_message(self, *args):
        pass


def serve(host, port):
    server = HTTPServer((host, port), Quiet)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def fetch(url, data=None):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=5) as answer:
            return answer.status
    except urllib.error.HTTPError as error:
        return error.code


# ---------------------------------------------------------------- files

def f_create():
    os.makedirs(DIR, exist_ok=True)
    act('create', P('notes.txt'), lambda: write(P('notes.txt'), 'alpha\nbeta\n'))

def f_read():
    ensure(P('notes.txt'))
    act('read', P('notes.txt'), lambda: read(P('notes.txt')))

def f_edit():
    ensure(P('notes.txt'))
    def edit():
        with open(P('notes.txt'), 'r+') as handle:
            handle.write('ALPHA')
    act('edit_in_place', P('notes.txt'), edit)

def f_append():
    ensure(P('notes.txt'))
    act('append', P('notes.txt'), lambda: write(P('notes.txt'), 'gamma\n', 'a'))

def f_edit_atomic():
    ensure(P('notes.txt'))
    def replace():
        write(P('.notes.txt.tmp'), 'replaced atomically\n')
        os.replace(P('.notes.txt.tmp'), P('notes.txt'))
    act('edit_write_then_rename_over', P('notes.txt'), replace)

def f_shell_edit():
    ensure(P('notes.txt'))
    act('edit_sed_i', P('notes.txt'), lambda: run(['sed', '-i', 's/a/A/g', P('notes.txt')]))

def f_chmod():
    ensure(P('perm.txt'))
    act('chmod', P('perm.txt'), lambda: os.chmod(P('perm.txt'), 0o600))

def f_truncate():
    ensure(P('trunc.txt'))
    act('truncate', P('trunc.txt'), lambda: os.truncate(P('trunc.txt'), 0))

def f_rename():
    ensure(P('notes.txt'))
    act('rename', P('notes.txt'), lambda: os.rename(P('notes.txt'), P('renamed.txt')), to=P('renamed.txt'))

def f_symlink_read():
    ensure(P('target.txt'))
    if not os.path.lexists(P('link')):
        os.symlink('target.txt', P('link'))
    act('read_through_symlink', P('target.txt'), lambda: read(P('link')), via=P('link'))

def f_symlink_write():
    ensure(P('target.txt'))
    if not os.path.lexists(P('link')):
        os.symlink('target.txt', P('link'))
    act('write_through_symlink', P('target.txt'), lambda: write(P('link'), 'via symlink\n'), via=P('link'))

def f_hardlink_write():
    ensure(P('target.txt'))
    if not os.path.lexists(P('hardlink')):
        os.link(P('target.txt'), P('hardlink'))
    act('write_through_hardlink', P('target.txt'), lambda: write(P('hardlink'), 'via hard link\n'), via=P('hardlink'))

def f_mmap_write():
    ensure(P('mm.bin'), 'x' * 4096)
    def mapped():
        with open(P('mm.bin'), 'r+b') as handle:
            area = mmap.mmap(handle.fileno(), 0)
            area[0:6] = b'MAPPED'
            area.flush()
            area.close()
    act('mmap_write', P('mm.bin'), mapped)

def f_fd_relative():
    ensure(P('sub', 'inner.txt'))
    def relative():
        folder = os.open(DIR, os.O_RDONLY | os.O_DIRECTORY)
        try:
            fd = os.open('sub/inner.txt', os.O_WRONLY | os.O_TRUNC, dir_fd=folder)
            os.write(fd, b'through a directory descriptor\n')
            os.close(fd)
        finally:
            os.close(folder)
    act('write_relative_to_dirfd', P('sub', 'inner.txt'), relative)
    def from_cwd():
        os.chdir(P('sub'))
        write('inner.txt', 'through the working directory\n')
    act('write_relative_to_cwd', P('sub', 'inner.txt'), from_cwd)

def f_copy_out():
    ensure(P('target.txt'))
    act('copy_out_of_project', P('target.txt'), lambda: shutil.copy(P('target.txt'), '/tmp/audit-copy.txt'), to='/tmp/audit-copy.txt')

def f_delete():
    ensure(P('renamed.txt'))
    act('delete', P('renamed.txt'), lambda: os.unlink(P('renamed.txt')))

def f_rmtree():
    ensure(P('sub', 'inner.txt'))
    act('delete_folder', P('sub', 'inner.txt'), lambda: run(['rm', '-r', P('sub')]))

def f_sensitive_new():
    os.makedirs(DIR, exist_ok=True)
    act('create_sensitive_name', P('.env'), lambda: write(P('.env'), 'AUDIT_FAKE_KEY=synthetic-not-a-secret\n'))
    act('read_sensitive_name', P('.env'), lambda: read(P('.env')))
    act('edit_sensitive_name', P('.env'), lambda: write(P('.env'), 'AUDIT_FAKE_KEY=changed\n'))
    act('delete_sensitive_name', P('.env'), lambda: os.unlink(P('.env')))

def f_existing_read():
    act('read_existing_project_file', '/workspace/config/payment-keys.js', lambda: read('/workspace/config/payment-keys.js'))
    act('read_existing_project_file', '/workspace/package.json', lambda: read('/workspace/package.json'))

def f_existing_edit():
    act('edit_existing_project_file', '/workspace/README.md', lambda: write('/workspace/README.md', '\naudit line\n', 'a'))

def f_outside():
    act('write_home', '/home/node/audit-outside.txt', lambda: write('/home/node/audit-outside.txt', 'outside the project\n'))
    act('write_tmp', '/tmp/audit-tmp.txt', lambda: write('/tmp/audit-tmp.txt', 'in tmpfs\n'))

def f_denied():
    act('write_denied', '/etc/audit-denied', lambda: write('/etc/audit-denied', 'x'))
    ensure(P('locked.txt'))
    os.chmod(P('locked.txt'), 0)
    act('read_denied', P('locked.txt'), lambda: read(P('locked.txt')))
    os.chmod(P('locked.txt'), 0o644)

def f_delete_missing():
    act('delete_missing', P('never-existed.txt'), lambda: os.unlink(P('never-existed.txt')))

def f_skipped_dir():
    path = '/workspace/node_modules/audit-pkg/index.js'
    os.makedirs(os.path.dirname(path), exist_ok=True)
    act('write_in_node_modules', path, lambda: write(path, 'module.exports = "audit";\n'))


# Phase x: the same kinds of change on files that already exist and have
# settled, so each is seen by itself and not folded into the file's creation.

def f_prep():
    os.makedirs(P('ro'), exist_ok=True)
    for name, text in (('trunc.txt', 'content to truncate\n'), ('perm.txt', 'mode will change\n'), ('mm.bin', 'x' * 4096),
                       ('transient.txt', 'original\n'), ('ro/keep.txt', 'in a read-only folder\n'), ('gone.txt', 'to delete\n'),
                       ('mv.txt', 'to rename\n')):
        act('prepare', P(name), lambda name=name, text=text: write(P(name), text))
    os.chmod(P('perm.txt'), 0o644)

def f_chmod2():
    act('chmod_existing', P('perm.txt'), lambda: os.chmod(P('perm.txt'), 0o600))

def f_truncate2():
    act('truncate_existing', P('trunc.txt'), lambda: os.truncate(P('trunc.txt'), 0))

def f_mmap2():
    def mapped():
        with open(P('mm.bin'), 'r+b') as handle:
            area = mmap.mmap(handle.fileno(), 0)
            area[0:6] = b'MAPPED'
            area.flush()
            area.close()
    act('mmap_write_existing', P('mm.bin'), mapped)

def f_transient():
    def there_and_back():
        write(P('transient.txt'), 'TEMPORARILY DIFFERENT\n')
        seen = sha(P('transient.txt'))
        write(P('transient.txt'), 'original\n')
        return {'writes': 2, 'sha_in_between': seen}
    act('change_then_restore_within_ms', P('transient.txt'), there_and_back)

def f_delete2():
    act('delete_existing', P('gone.txt'), lambda: os.unlink(P('gone.txt')))

def f_rename2():
    act('rename_existing', P('mv.txt'), lambda: os.rename(P('mv.txt'), P('mv-renamed.txt')), to=P('mv-renamed.txt'))

def f_delete_denied():
    os.chmod(P('ro'), 0o555)
    try:
        act('delete_refused_read_only_folder', P('ro', 'keep.txt'), lambda: os.unlink(P('ro', 'keep.txt')))
        act('rename_refused_read_only_folder', P('ro', 'keep.txt'), lambda: os.rename(P('ro', 'keep.txt'), P('ro', 'moved.txt')))
    finally:
        os.chmod(P('ro'), 0o755)


# ---------------------------------------------------------------- processes

def p_simple():
    act('exec', '/bin/echo', lambda: run(['/bin/echo', 'audit-simple']))

def p_chain():
    inner = "import subprocess; subprocess.run(['/bin/sh','-c','/bin/true audit-grandchild'])"
    act('exec_chain_sh_python_sh_true', 'chain', lambda: run(['/bin/sh', '-c', f'python3 -c "{inner}"']))

def p_fail_exit():
    act('exit_code_7', 'sh', lambda: run(['/bin/sh', '-c', 'exit 7']))

def p_crash():
    def crash():
        child = subprocess.Popen(['python3', '-c', 'import os,signal; os.kill(os.getpid(), signal.SIGSEGV)'])
        code = child.wait()
        return {'child_pid': child.pid, 'returncode': code}
    act('crash_sigsegv', 'python3', crash)

def p_exec_missing():
    act('exec_missing_binary', '/workspace/audit-no-such-binary', lambda: run(['/workspace/audit-no-such-binary']))
    ensure(P('not-executable.sh'), '#!/bin/sh\necho no\n')
    act('exec_not_executable', P('not-executable.sh'), lambda: run([P('not-executable.sh')]))

def p_background():
    def start():
        child = subprocess.Popen(['/bin/sh', '-c', 'sleep 8; echo done > /tmp/audit-bg-done'], start_new_session=True,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return {'child_pid': child.pid, 'outlives_parent': True}
    act('background_job', 'sleep 8', start)

def p_concurrent():
    def together():
        children = [subprocess.Popen(['/bin/sh', '-c', f'echo audit-concurrent-{index} > /dev/null']) for index in range(8)]
        return {'child_pids': [child.pid for child in children], 'returncodes': [child.wait() for child in children]}
    act('concurrent_8', 'sh', together)

def p_fork_noexec():
    os.makedirs(DIR, exist_ok=True)
    def forked():
        child = os.fork()
        if child == 0:
            write(P('forkchild.txt'), 'written by a forked child that never exec()s\n')
            os._exit(3)
        _, status = os.waitpid(child, 0)
        return {'child_pid': child, 'exit_code': os.waitstatus_to_exitcode(status)}
    act('fork_without_exec', P('forkchild.txt'), forked)

def p_threads():
    os.makedirs(DIR, exist_ok=True)
    def threaded():
        workers = [threading.Thread(target=write, args=(P(f'thread-{index}.txt'), 'thread\n')) for index in range(4)]
        [worker.start() for worker in workers]
        [worker.join() for worker in workers]
        return {'files': 4}
    act('threads_4_writes', P('thread-0.txt'), threaded)

def p_burst():
    def burst():
        pids = []
        for _ in range(300):
            child = subprocess.Popen(['/bin/true'])
            child.wait()
            pids.append(child.pid)
        return {'spawned': len(pids), 'first_pid': pids[0], 'last_pid': pids[-1]}
    act('burst_300_short_processes', '/bin/true', burst)


# ---------------------------------------------------------------- network (loopback mocks only)

def n_http_ok():
    serve('127.0.0.1', 18080)
    act('http_get_200', 'http://127.0.0.1:18080/ok', lambda: fetch('http://127.0.0.1:18080/ok'))
    act('http_get_404', 'http://127.0.0.1:18080/missing', lambda: fetch('http://127.0.0.1:18080/missing'))
    act('http_post_201', 'http://127.0.0.1:18080/submit', lambda: fetch('http://127.0.0.1:18080/submit', b'{"synthetic":true}'))

def n_curl_local():
    serve('127.0.0.1', 18081)
    act('curl_200', 'http://127.0.0.1:18081/ok', lambda: run(['curl', '-s', '-o', '/dev/null', 'http://127.0.0.1:18081/ok']))

def n_refused():
    def refused():
        with socket.create_connection(('127.0.0.1', 18999), timeout=3):
            pass
    act('connect_closed_port', '127.0.0.1:18999', refused)

def n_own_ip():
    own = socket.gethostbyname(socket.gethostname())
    serve('0.0.0.0', 18082)
    act('http_get_own_address', f'http://{own}:18082/ok', lambda: fetch(f'http://{own}:18082/ok'), own_ip=own)

def n_udp_sendto():
    receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    receiver.bind(('127.0.0.1', 18083))
    receiver.settimeout(3)
    def datagram():
        sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sender.sendto(b'audit datagram', ('127.0.0.1', 18083))
        return len(receiver.recvfrom(100)[0])
    act('udp_sendto_without_connect', '127.0.0.1:18083', datagram)

def n_unix():
    path = '/tmp/audit.sock'
    if os.path.exists(path):
        os.unlink(path)
    server = socket.socket(socket.AF_UNIX)
    server.bind(path)
    server.listen(1)
    def talk():
        client = socket.socket(socket.AF_UNIX)
        client.connect(path)
        client.sendall(b'hi')
        return 2
    act('unix_socket_connect', path, talk)

def n_dns_nx():
    def lookup():
        return [item[4][0] for item in socket.getaddrinfo('audit-probe.invalid', 80)]
    act('dns_lookup_reserved_invalid_name', 'audit-probe.invalid', lookup)

def n_listen():
    def listening():
        server = socket.socket()
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(('0.0.0.0', 18084))
        server.listen(4)
        return 18084
    act('listen_all_interfaces', '0.0.0.0:18084', listening)


# ---------------------------------------------------------------- database (disposable SQLite)

def rows(path):
    with sqlite3.connect(path) as db:
        return db.execute('SELECT id, name, qty FROM items ORDER BY id').fetchall()

def d_crud():
    os.makedirs(DIR, exist_ok=True)
    path = P('data.db')
    def crud():
        db = sqlite3.connect(path)
        db.execute('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER)')
        db.execute('DELETE FROM items')
        db.executemany('INSERT INTO items (id, name, qty) VALUES (?,?,?)', [(1, 'widget', 5), (2, 'gadget', 7), (3, 'gizmo', 9)])
        db.execute('UPDATE items SET qty = 50 WHERE id = 1')
        db.execute('DELETE FROM items WHERE id = 2')
        db.commit()
        db.close()
        return {'statements': {'insert': 3, 'update': 1, 'delete': 1}, 'committed': True, 'rows_after': rows(path)}
    act('sqlite_insert_update_delete_commit', path, crud)

def d_rollback():
    path = P('data.db')
    if not os.path.exists(path):
        d_crud()
    def rolled_back():
        before = rows(path)
        db = sqlite3.connect(path)
        db.execute('INSERT INTO items (id, name, qty) VALUES (99, "never-committed", 1)')
        db.execute('UPDATE items SET qty = -1')
        db.rollback()
        db.close()
        return {'statements': {'insert': 1, 'update': 1}, 'committed': False, 'rows_unchanged': rows(path) == before}
    act('sqlite_transaction_rolled_back', path, rolled_back)

def d_wal():
    path = P('wal.db')
    os.makedirs(DIR, exist_ok=True)
    def wal():
        db = sqlite3.connect(path)
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER)')
        db.execute('INSERT INTO items (name, qty) VALUES ("wal-row", 1)')
        db.commit()
        held = {'main_sha': sha(path), 'wal_exists': os.path.exists(path + '-wal')}
        db.close()
        return held
    act('sqlite_commit_in_wal_mode', path, wal)

def d_readonly():
    path = P('data.db')
    if not os.path.exists(path):
        d_crud()
    def select():
        db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
        found = db.execute('SELECT count(*) FROM items').fetchone()[0]
        db.close()
        return {'statements': {'select': 1}, 'rows': found}
    act('sqlite_select_only', path, select)


# ---------------------------------------------------------------- refusals and bursts

def x_setuid():
    act('setuid_0', 'uid 0', lambda: os.setuid(0))

def b_opens():
    ensure(P('target.txt'))
    def many():
        for _ in range(5000):
            with open(P('target.txt')) as handle:
                handle.read(1)
        return {'opens': 5000}
    act('burst_5000_reads', P('target.txt'), many)

def b_creates():
    os.makedirs(P('burst'), exist_ok=True)
    def many():
        for index in range(2000):
            write(P('burst', f'file-{index:04d}.txt'), 'x')
        return {'created': 2000}
    act('burst_2000_creates', P('burst'), many)

def b_edits():
    ensure(P('target.txt'))
    def many():
        for index in range(200):
            write(P('target.txt'), f'revision {index}\n')
        return {'writes': 200, 'final': 'revision 199'}
    act('burst_200_rewrites_of_one_file', P('target.txt'), many)

def s_heartbeat():
    """For the shutdown test: rewrites a file every 200 ms until the sandbox stops."""
    os.makedirs(DIR, exist_ok=True)
    index = 0
    while True:
        index += 1
        write(P('heartbeat.txt'), f'{index} {time.time_ns()}\n')
        time.sleep(0.2)


if __name__ == '__main__':
    started = time.time_ns()
    test = globals().get(TEST)
    if not callable(test):
        raise SystemExit(f'unknown test {TEST}')
    test()
    print(json.dumps({'test': TEST, 'dir': DIR, 'workload_pid': os.getpid(), 'ppid': os.getppid(),
                      'call_id': os.environ.get('RAYTRACE_CALL_ID'), 'started_ns': started, 'ended_ns': time.time_ns(),
                      'actions': ACTIONS}))
