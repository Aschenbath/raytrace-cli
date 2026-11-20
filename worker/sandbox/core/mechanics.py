"""The sandbox core's container mechanics: trusted host-side lifecycle of
gVisor sandboxes. Never mounted into workloads.

This module *applies* what it is given (limits, image, hooks, files); it
decides none of it. Callers are adapters: `projects.py` (the local adapter,
also the command line every host runs) and any other host layer that imports
it. What a caller may rely on is written down in CORE_API.md; change that file
and CORE_API in core/__init__.py together.
"""
import argparse
from datetime import datetime
import fcntl
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import time

from core import release

LABEL = 'io.raytace.project'
FORK_OF = 'io.raytace.fork-of'
PROJECT_ID = r'rtp-[a-f0-9]{32}'
FORK_ID = r'rtf-[a-f0-9]{32}'
SNAPSHOTS = '/home/node/.raytace/snapshots.git'
# Each sandbox's Claude Code hook, as enable-claude last installed it, root-only.
HOOKS = Path('/var/lib/raytace/hooks')
# Each sandbox's restricted files, as set-guardrails last left them, root-only.
GUARDRAILS = Path('/var/lib/raytace/guardrails')
GUARDRAILS_IN_SANDBOX = '/opt/raytace-claude/guardrails.json'
# Which sandbox each container is, for the fact engine (engine.py), root-only.
CONTAINERS = Path('/var/lib/raytace/containers')
# The file attribute `chattr +i` sets, and the calls that read and write it.
IMMUTABLE, GET_FLAGS, SET_FLAGS = 0x10, 0x80086601, 0x40086602
# Where this core is installed: network.py, collector.py and the rest sit
# beside the core/ package (/opt/raytace locally, a release directory elsewhere).
ROOT = Path(__file__).resolve().parent.parent
# The image sandboxes are made from when the caller names none: what setup.py's
# image step last built and wrote here, or the name it has always had.
IMAGE_FILE = Path('/etc/raytace/image')
DEFAULT_IMAGE = 'raytace-gvisor-agent'


class Limits:
    """What one sandbox may use. The core enforces these; it never picks them."""
    def __init__(self, cpus='2', memory='2g', pids=256, tmp='512m'):
        if not re.fullmatch(r'\d{1,3}(\.\d{1,2})?', str(cpus)) or not re.fullmatch(r'\d{1,6}[kmg]', str(memory)) \
                or not 0 < int(pids) <= 65536 or not re.fullmatch(r'\d{1,6}[kmg]', str(tmp)):
            raise ValueError('Invalid sandbox limits')
        self.cpus, self.memory, self.pids, self.tmp = str(cpus), str(memory), int(pids), str(tmp)

    def args(self):
        return [f'--memory={self.memory}', f'--cpus={self.cpus}', f'--pids-limit={self.pids}',
                f'--tmpfs=/tmp:rw,nosuid,nodev,size={self.tmp}']


DEFAULT_LIMITS = Limits()


def image():
    """The image a new sandbox is made from when its caller names none: the
    active release's (core/release.py), or the one setup.py last built here."""
    active = release.active()
    if active:
        return active['image']
    if IMAGE_FILE.exists():
        named = IMAGE_FILE.read_text().strip()
        if re.fullmatch(r'[a-z0-9][a-z0-9._/-]{0,127}(:[A-Za-z0-9._-]{1,128})?', named):
            return named
    return DEFAULT_IMAGE

def bridge():
    # The manager's model and transcript bridge as sandboxes reach it (network.py).
    path = Path('/etc/raytace/bridge')
    return path.read_text().strip() if path.exists() else 'http://192.168.5.2:8799'

def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)

def inspect(name):
    if not re.fullmatch(PROJECT_ID, name) and not re.fullmatch(FORK_ID, name):
        raise ValueError('Invalid sandbox ID')
    data = json.loads(subprocess.check_output(['docker', 'inspect', name]))[0]
    if data['Config'].get('Labels', {}).get(LABEL) != name:
        raise ValueError('Container is not a managed RayTrace project')
    if data['HostConfig']['Runtime'] != 'raytace-gvisor':
        raise ValueError('Unexpected runtime; refusing operation')
    return data

def preflight():
    # No sandbox runs unrecorded, or with names it cannot resolve.
    for unit, does in (('raytace-collector', 'records what a sandbox runs'), ('raytace-dns', 'resolves names for sandboxes')):
        if subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode:
            sys.exit(f'RayTrace: {unit}, which {does}, is not running on this host; no sandbox is started without it.')
    run('python3', str(ROOT / 'network.py'))

def remember(name):
    """Tells the fact engine which sandbox a container is: where its project
    and home folders are on this host and, once it runs, its address on the
    sandbox network (which is how a DNS lookup is known to be its own). gVisor
    names a container by its id alone, so without this the engine sees calls
    and cannot tell whose files they are. Written again at every start: the
    address is given then."""
    state = inspect(name)
    mount = lambda suffix: subprocess.check_output(['docker', 'volume', 'inspect', '-f', '{{.Mountpoint}}', name+'-'+suffix], text=True).strip()
    addresses = [joined.get('IPAddress') for joined in (state.get('NetworkSettings', {}).get('Networks') or {}).values()]
    record = {'id': name, 'workspace': mount('workspace'), 'home': mount('home'),
              'ip': next(filter(None, addresses), None), 'fork_of': state['Config'].get('Labels', {}).get(FORK_OF)}
    CONTAINERS.mkdir(parents=True, exist_ok=True, mode=0o700)
    staged = CONTAINERS / (state['Id']+'.new')
    staged.write_text(json.dumps(record))
    staged.replace(CONTAINERS / (state['Id']+'.json'))

def predates_collector(state):
    """Whether a running sandbox started before the collector did. gVisor
    connects to the collector once, at start, and never reconnects, so such a
    sandbox reports nothing: its commands would run unrecorded."""
    if not state['State']['Running']:
        return False
    shown = subprocess.check_output(['systemctl', 'show', 'raytace-collector', '-p', 'ActiveEnterTimestamp',
                                     '--timestamp=unix'], text=True).strip()
    collector = float(shown.partition('@')[2] or 0)
    # Docker's RFC 3339 time, nanoseconds cut to what fromisoformat reads.
    started = re.sub(r'(\.\d{6})\d*', r'\1', state['State']['StartedAt']).replace('Z', '+00:00')
    return datetime.fromisoformat(started).timestamp() < collector

def validate_archive(path):
    total = 0
    with tarfile.open(path, 'r:gz') as archive:
        for item in archive:
            parts = PurePosixPath(item.name)
            if parts.is_absolute() or '..' in parts.parts or not item.isfile():
                raise ValueError('Archive contains unsafe path or non-regular file')
            total += item.size
            if total > 256 * 1024 * 1024:
                raise ValueError('Import exceeds 256 MiB')

def stage_archive(sid):
    """The import archive from stdin, written once to /tmp/<id>.tar.gz."""
    path = '/tmp/'+sid+'.tar.gz'
    limit = 300 * 1024 * 1024
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as out:
        total = 0
        while chunk := sys.stdin.buffer.read(1024 * 1024):
            total += len(chunk)
            if total > limit:
                raise ValueError('Import archive exceeds 300 MiB')
            out.write(chunk)
    return path

# Codex the same: no approval prompts, and none of its own sandboxing, which
# the sandbox already is (and gVisor would not let it set up).
# What `shell --agent` starts: the agent's name and its command line.
AGENTS = {'claude': ('Claude Code', 'claude --dangerously-skip-permissions'),
          'codex': ('Codex', 'codex --dangerously-bypass-approvals-and-sandbox')}
CODEX_MANAGED = b'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n'

def install_claude_hooks(container, hook):
    """The hook script, root-owned, with Claude Code's managed settings, which
    user and project settings cannot override, and Codex's managed config: the
    agent can read them, not change them. Re-running replaces them with the
    current version."""
    if not 0 < len(hook) <= 262144:
        raise ValueError('Expected the hook script')
    command = 'node /opt/raytace-claude/hook.mjs'
    # No permission prompts for any Claude Code session here: the sandbox is
    # what contains the agent, and the hook still refuses restricted files.
    settings = json.dumps({'permissions': {'defaultMode': 'bypassPermissions'}, 'skipDangerousModePermissionPrompt': True, 'hooks': {
        # Bash for the call id; the file tools so an edit to a restricted file is refused (see guardrails())
        # and so the recorder knows which call is at the file (Read as well: claude-hook.mjs announce()).
        'PreToolUse': [{'matcher': 'Bash|Read|Write|Edit|MultiEdit|NotebookEdit', 'hooks': [{'type': 'command', 'command': command, 'timeout': 5}]}],
        **{event: [{**({'matcher': '*'} if event == 'PostToolUse' else {}),
                    'hooks': [{'type': 'command', 'command': command, 'timeout': 15}]}]
           for event in ('UserPromptSubmit', 'PostToolUse', 'Stop', 'SubagentStop', 'SessionEnd')}}}, indent=2).encode()
    # Written by root from inside the container: docker cp does not keep
    # owners under gVisor, and a node-owned hook is one the agent can edit.
    # Needs the container running. Files an older install left node-owned
    # are emptied by node, then their directories removed by root.
    subprocess.run(['docker', 'exec', '-u', '1000', container, 'sh', '-c',
        'rm -rf /opt/raytace-claude/* /etc/claude-code/* /etc/codex/*'], stderr=subprocess.DEVNULL)
    for path, content in (('/opt/raytace-claude/hook.mjs', hook), ('/etc/claude-code/managed-settings.json', settings),
                          ('/etc/codex/managed_config.toml', CODEX_MANAGED)):
        write_as_root(container, path, content)

def write_as_root(container, path, content):
    """A root-owned file inside a running sandbox, which its agent can read and not change."""
    directory = path.rsplit('/', 1)[0]
    run('docker', 'exec', '-i', '-u', '0', container, 'sh', '-c',
        f'if [ -O {directory} ]; then :; else rm -rf {directory}; fi; mkdir -p -m 755 {directory} && '
        f'cat > {path}.new && chmod 644 {path}.new && mv {path}.new {path}', input=content)

def lock(root, path, on):
    """Locks or unlocks one project file from the host, or with on=None only
    looks. Locked is root's, read-only and immutable: nothing in the sandbox
    can write, replace, rename or delete it, whatever tool tries, and it still
    reads. Returns whether the file is now locked. The agent names its own
    folders, so every step of the path is opened without following links: a
    link out of the project is never touched."""
    at = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        parts = PurePosixPath(path).parts
        for index, part in enumerate(parts):
            last = index == len(parts) - 1
            below = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | (0 if last else os.O_DIRECTORY), dir_fd=at)
            os.close(at)
            at = below
        mode = os.fstat(at).st_mode
        if not stat.S_ISREG(mode):
            return False
        flags = struct.unpack('i', fcntl.ioctl(at, GET_FLAGS, struct.pack('i', 0)))[0]
        locked = bool(flags & IMMUTABLE)
        if on is None or on == locked:
            return locked
        runs = mode & 0o111
        if on:
            os.fchown(at, 0, 0)
            os.fchmod(at, 0o555 if runs else 0o444)
            fcntl.ioctl(at, SET_FLAGS, struct.pack('i', flags | IMMUTABLE))
        else:
            fcntl.ioctl(at, SET_FLAGS, struct.pack('i', flags & ~IMMUTABLE))
            os.fchown(at, 1000, 1000)
            os.fchmod(at, 0o755 if runs else 0o644)
        return on
    except OSError:
        return False
    finally:
        os.close(at)

def present(root, path):
    """Whether a project path is a regular file, without following a link at any step."""
    try:
        at = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    except OSError:
        return False
    try:
        parts = PurePosixPath(path).parts
        for part in parts[:-1]:
            below = os.open(part, os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY, dir_fd=at)
            os.close(at)
            at = below
        return bool(parts) and stat.S_ISREG(os.stat(parts[-1], dir_fd=at, follow_symlinks=False).st_mode)
    except OSError:
        return False
    finally:
        os.close(at)

def guardrails(sid, state, restricted=None, watched=None, blocked=None):
    """Applies a sandbox's restricted files: the new list, or the stored one
    again. The Claude Code hook gets the list at once and refuses the edit
    with the reason. The lock that holds for every tool is put on only while
    the sandbox is stopped, so from its next start: gVisor keeps what it knows
    of a file while it runs, and a file locked under it stops being readable.
    A file no longer restricted is unlocked now. `watched` are the files whose
    owner wants to hear of a read or a change: the hook reports an attempt on
    them and nothing is locked. `blocked` are the programs the hook refuses
    to start (None keeps the stored list). Returns {hook: the hook has the
    list, read_only: the files locked, restricted and watched: the lists as
    they now are, missing: listed paths that are not a file in the project}."""
    GUARDRAILS.mkdir(parents=True, exist_ok=True, mode=0o700)
    stored = GUARDRAILS / (sid+'.json')
    kept = json.loads(stored.read_text()) if stored.exists() else {}
    before = kept.get('restricted', [])
    if restricted is None:
        restricted = before
    if watched is None:
        watched = kept.get('watched', [])
    if blocked is None:
        blocked = kept.get('blocked', [])
    root = subprocess.check_output(['docker', 'volume', 'inspect', '-f', '{{.Mountpoint}}', sid+'-workspace'], text=True).strip()
    running = state['State']['Running']
    for path in set(before) - set(restricted):
        lock(root, path, False)
    read_only = [path for path in restricted if lock(root, path, None if running else True)]
    lists = json.dumps({'restricted': restricted, 'watched': watched, 'blocked': blocked})
    stored.write_text(lists)
    if running and (restricted or before or watched or kept.get('watched') or blocked or kept.get('blocked')):
        write_as_root(sid, GUARDRAILS_IN_SANDBOX, lists.encode())
    return {'hook': bool(running), 'read_only': read_only, 'restricted': restricted, 'watched': watched,
            'missing': [path for path in [*restricted, *watched] if not present(root, path)]}

def as_node(container, *command, data=None, check=True):
    """Runs a command in a sandbox as its agent user, never root."""
    return subprocess.run(['docker', 'exec', *(['-i'] if data is not None else []), '-u', '1000', container, *command],
        input=data, check=check, capture_output=True).stdout

def start_container(name):
    """docker exec needs a running container. A sandbox stopped since it
    was recorded (host restart, idle stop) is started again for the work
    below; starting one that already runs is a no-op."""
    run('docker', 'start', name, stdout=subprocess.DEVNULL)

def container_args(name, labels, limits=None, image_name=None):
    """`docker create` arguments for one sandbox: gVisor, the sandbox network,
    no capabilities, the agent user, the given limits, its two volumes and the
    host's resolver. Projects and forks are made the same way."""
    limits = limits or DEFAULT_LIMITS
    return ['docker', 'create', '--name', name, *labels, '--runtime=raytace-gvisor',
        '--label', 'io.raytace.storage=volumes-v1',
        '--network=raytace-egress', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--user=1000:1000', *limits.args(),
        '--mount=type=volume,src='+name+'-workspace,dst=/workspace',
        '--mount=type=volume,src='+name+'-home,dst=/home/node',
        '--mount=type=bind,src=/etc/raytace/resolv.conf,dst=/etc/resolv.conf,readonly',
        # Session marker on PID 1: env is inherited across fork/exec, so
        # every process in this sandbox carries it without the collector
        # reconstructing a process tree. Read back by the allowlist in
        # collector.py. Session scope only -- a per-call RAYTRACE_CALL_ID
        # has to be stamped by whatever spawns the command, and inside
        # this sandbox that is Codex, not RayTrace.
        '--env', 'RAYTRACE_SESSION='+name, '--env', 'RAYTRACE_BROKER='+bridge(),
        '--workdir=/workspace', '--entrypoint=/bin/sleep',
        image_name or image(), 'infinity']

def create_container(name, labels, limits=None, image_name=None):
    """The sandbox's two volumes and its container (not started); its container id."""
    for suffix in ('workspace', 'home'):
        run('docker', 'volume', 'create', *labels, name+'-'+suffix, stdout=subprocess.DEVNULL)
    return subprocess.check_output(container_args(name, labels, limits, image_name), text=True).strip()

def fork_container(fork, parent, limits=None, image_name=None):
    """A sandbox like the project's own, for one Playground fork: same image,
    limits and network, its own volumes, labelled with the project it forks."""
    return create_container(fork, ['--label', LABEL+'='+fork, '--label', FORK_OF+'='+parent], limits, image_name)

def image_of(name):
    """The image a sandbox was made from, so its forks match it (None: image())."""
    return inspect(name).get('Config', {}).get('Image') or None

def fork_state(fork):
    state = inspect(fork)
    parent = state['Config'].get('Labels', {}).get(FORK_OF, '')
    if not re.fullmatch(FORK_ID, fork) or not re.fullmatch(PROJECT_ID, parent):
        raise ValueError('Not a Playground fork')
    return state, parent

def safe_path(path):
    parts = PurePosixPath(path)
    if not path or len(path) > 1024 or parts.is_absolute() or '..' in parts.parts or '\0' in path:
        raise ValueError('Invalid workspace path: ' + path[:80])
    return '/workspace/' + str(parts)

def fork_action(action, fork, forget=False, credentials=None):
    """One Playground fork action. `credentials` says whether fork-create copies
    the parent's sign-ins into the fork: a function of the request (the
    caller's policy), or None to copy them unless the request says
    credentials: false."""
    if not re.fullmatch(FORK_ID, fork):
        raise ValueError('Invalid fork ID')
    if action == 'fork-create':
        # stdin: {parent, commit, session, transcript, files: {path: text}, delete: [path], hook}
        data = json.loads(sys.stdin.buffer.read(40 * 1024 * 1024))
        parent, commit, session = data['parent'], data['commit'], data['session']
        if not re.fullmatch(PROJECT_ID, parent) or not re.fullmatch(r'[0-9a-f]{40}', commit) \
                or not re.fullmatch(r'[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}', session):
            raise ValueError('Invalid fork request')
        inspect(parent)
        preflight()
        copy_credentials = credentials(data) if credentials else data.get('credentials') is not False
        cid = fork_container(fork, parent, image_name=image_of(parent))
        run('docker', 'start', fork, stdout=subprocess.DEVNULL)
        remember(fork)
        # The parent is read from below, so it must be running too: it is
        # often stopped by fork time, and exec into it exits 1.
        start_container(parent)
        # The project folder as the snapshot has it, and nothing else.
        archive = as_node(parent, 'git', '--git-dir='+SNAPSHOTS, 'archive', '--format=tar', commit)
        as_node(fork, 'tar', '-x', '-C', '/workspace', data=archive)
        # The user's Claude Code sign-in and the sandbox's RayTrace token (a
        # local sandbox keeps it in .raytace/sandbox-token, a hosted one in its Codex config).
        wanted = ['.claude/.credentials.json', '.claude.json', '.claude/settings.json', '.raytace/sandbox-token', '.raytace-codex/config.toml']
        if not copy_credentials:
            wanted = []
        present = [path for path in wanted if subprocess.run(['docker', 'exec', '-u', '1000', parent, 'test', '-f', '/home/node/'+path]).returncode == 0]
        if present:
            as_node(fork, 'tar', '-x', '-C', '/home/node', data=as_node(parent, 'tar', '-c', '-C', '/home/node', *present))
        # The session cut at the forked step, where `claude --resume` finds it.
        as_node(fork, 'sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh',
            '/home/node/.claude/projects/-workspace/'+session+'.jsonl', data=data['transcript'].encode())
        for path, text in (data.get('files') or {}).items():
            as_node(fork, 'sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', safe_path(path), data=text.encode())
        # Excluded files: not in the fork's copy of the project at all.
        for path in (data.get('delete') or [])[:200]:
            as_node(fork, 'rm', '-rf', '--', safe_path(path))
        install_claude_hooks(fork, data['hook'].encode())
        print(json.dumps({'container_id': cid}))
    elif action == 'fork-run':
        # stdin: {session, model, prompt}. Claude's stream-json events go to stdout.
        state, parent = fork_state(fork)
        data = json.loads(sys.stdin.buffer.read(65536))
        if not re.fullmatch(r'[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}', data['session']) \
                or not re.fullmatch(r'[A-Za-z0-9_.:/\[\]-]{1,100}', data['model']) or not 0 < len(data['prompt']) <= 4000:
            raise ValueError('Invalid run request')
        # gVisor is the sandbox, as for the project's own session.
        sys.exit(subprocess.call(['docker', 'exec', '-u', '1000', '-w', '/workspace', fork,
            'claude', '-p', '--resume', data['session'], '--model', data['model'],
            '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose', data['prompt']]))
    elif action == 'fork-check':
        # stdin: {command, seconds}. The user's pass/fail check, run where the
        # fork left the project, as the agent user: exit 0 passes. Prints
        # {exit_code, timed_out, output (its last 20 KB, stdout and stderr)}.
        state, parent = fork_state(fork)
        data = json.loads(sys.stdin.buffer.read(65536))
        command, seconds = data.get('command'), data.get('seconds')
        if not isinstance(command, str) or not 0 < len(command) <= 2000 or not isinstance(seconds, int) or not 0 < seconds <= 1800:
            raise ValueError('Invalid check request')
        # timeout(1) inside the sandbox, so the check's own processes end with
        # it, not only the docker exec client; -k for one that ignores TERM.
        result = subprocess.run(['docker', 'exec', '-u', '1000', '-w', '/workspace', fork,
            'timeout', '-k', '5', str(seconds), 'sh', '-c', command], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        output = result.stdout[-20000:].decode('utf-8', 'replace')
        print(json.dumps({'exit_code': result.returncode, 'timed_out': result.returncode in (124, 137), 'output': output}))
    elif action == 'fork-collect':
        # stdin: {original}. The fork's snapshot history goes into the project's
        # own (refs/forks/<id>/*), so its files outlive the fork, and its last
        # snapshot is compared with the original run's last one.
        state, parent = fork_state(fork)
        data = json.loads(sys.stdin.buffer.read(4096))
        if not re.fullmatch(r'[0-9a-f]{40}', data['original']):
            raise ValueError('Invalid original commit')
        # Both containers are read from below; either may have stopped
        # since the run (see start_container).
        start_container(parent)
        start_container(fork)
        # A fork that answered without a tool call never snapshots, so its
        # store has no refs (or does not exist) and `git bundle` exits 128
        # there. That is a fork with nothing to collect, not a failure:
        # report no final snapshot and let the fork's check still run.
        refs = as_node(fork, 'git', '--git-dir='+SNAPSHOTS, 'for-each-ref', '--format=%(refname)', check=False)
        if not refs.strip():
            print(json.dumps({'final': None, 'changes': []}))
            return
        bundle = as_node(fork, 'sh', '-c', 'git --git-dir="$1" bundle create - --all 2>/dev/null', 'sh', SNAPSHOTS)
        if not bundle:
            print(json.dumps({'final': None, 'changes': []}))
            return
        as_node(parent, 'sh', '-c', 'cat > /tmp/fork.bundle && git --git-dir="$1" fetch -q /tmp/fork.bundle "+refs/heads/*:refs/forks/$2/*"; '
            'status=$?; rm -f /tmp/fork.bundle; exit $status', 'sh', SNAPSHOTS, fork, data=bundle)
        final = as_node(parent, 'sh', '-c', 'git --git-dir="$1" for-each-ref --format="%(objectname)" "refs/forks/$2/"', 'sh', SNAPSHOTS, fork).decode().split()[0]
        stats = as_node(parent, 'git', '--git-dir='+SNAPSHOTS, 'diff', '--no-renames', '-z', '--numstat', data['original'], final).decode()
        statuses = as_node(parent, 'git', '--git-dir='+SNAPSHOTS, 'diff', '--no-renames', '-z', '--name-status', data['original'], final).decode().split('\0')
        counts = {}
        for entry in filter(None, stats.split('\0')):
            added, removed, path = entry.split('\t', 2)
            counts[path] = (None if added == '-' else int(added), None if removed == '-' else int(removed))
        changes = [{'path': statuses[i + 1], 'status': statuses[i], 'added': counts.get(statuses[i + 1], (None, None))[0],
                    'removed': counts.get(statuses[i + 1], (None, None))[1]} for i in range(0, len(statuses) - 1, 2) if statuses[i]]
        print(json.dumps({'final': final, 'changes': changes[:500]}))
    elif action == 'fork-stop':
        # Kept for looking around, not running: stops whatever is still going.
        fork_state(fork)
        subprocess.run(['docker', 'stop', '-t', '3', fork], stdout=subprocess.DEVNULL, check=True)
        print(json.dumps({'stopped': fork}))
    elif action == 'fork-delete':
        # Only ever a fork: fork_state refuses anything without the fork label.
        state, parent = fork_state(fork)
        subprocess.run(['docker', 'rm', '-f', fork], stdout=subprocess.DEVNULL, check=True)
        (CONTAINERS / (state['Id']+'.json')).unlink(missing_ok=True)
        # With --forget-evidence (its project destroyed with its logs), what the collector recorded of it too.
        if forget:
            evidence(state['Id'], forget=True)
        for suffix in ('workspace', 'home'):
            volume = fork+'-'+suffix
            result = subprocess.run(['docker', 'volume', 'inspect', volume], capture_output=True, text=True)
            if result.returncode == 0:
                if json.loads(result.stdout)[0].get('Labels', {}).get(FORK_OF) != parent:
                    raise ValueError('Unexpected volume ownership; volume retained')
                run('docker', 'volume', 'rm', volume, stdout=subprocess.DEVNULL)
        print(json.dumps({'deleted': fork}))

SNAPSHOT_REF = r'[0-9a-f]{40}|refs/forks/rtf-[a-f0-9]{32}/[A-Za-z0-9_-]{1,40}'

def snapshot_read(project):
    """Read-only views of a project's snapshot history, for the Playground:
    stdin {op: list|show|diff, commit, to?, path?}. Never writes."""
    data = json.loads(sys.stdin.buffer.read(8192))
    op, commit = data.get('op'), data.get('commit', '')
    if op not in ('list', 'show', 'diff') or not re.fullmatch(SNAPSHOT_REF, commit) \
            or (op == 'diff' and not re.fullmatch(SNAPSHOT_REF, data.get('to', ''))):
        raise ValueError('Invalid snapshot request')
    path = safe_path(data['path'])[len('/workspace/'):] if data.get('path') else None
    git = ['git', '--git-dir='+SNAPSHOTS]
    if op == 'list':
        names = as_node(project, *git, 'ls-tree', '-r', '-z', '--name-only', commit).decode().split('\0')
        print(json.dumps({'files': [name for name in names if name][:20000]}))
    elif op == 'show':
        if not path:
            raise ValueError('A path is required')
        result = subprocess.run(['docker', 'exec', '-u', '1000', project, *git, 'show', commit+':'+path], capture_output=True)
        if result.returncode != 0:
            print(json.dumps({'missing': True}))
            return
        content = result.stdout
        binary = b'\0' in content[:8000]
        print(json.dumps({'binary': binary, 'size': len(content), 'truncated': len(content) > 1_000_000,
                          'text': None if binary else content[:1_000_000].decode('utf-8', 'replace')}))
    else:
        text = as_node(project, *git, 'diff', '--no-renames', '--no-color', commit, data['to'], *(['--', path] if path else [])).decode('utf-8', 'replace')
        print(json.dumps({'diff': text[:500_000], 'truncated': len(text) > 500_000}))

def read_snapshot(project, running):
    """snapshot_read for a project in whatever state it was found.

    The snapshot history lives inside the sandbox, so reading it needs the
    container up. A stopped one is started for the read and stopped again
    after: looking at an old run's diff must not need its owner to start the
    sandbox first, and must not leave it running behind their back either
    (no agent runs in between, so nothing is recorded or changed). A failed
    read leaves as one plain sentence, not a traceback: the line reaches a
    dashboard, whose reader cannot act on a raw docker command."""
    try:
        if running:
            return snapshot_read(project)
        run('docker', 'start', project, stdout=subprocess.DEVNULL)
        try:
            return snapshot_read(project)
        finally:
            try:
                run('docker', 'stop', '-t', '10', project, stdout=subprocess.DEVNULL)
            except subprocess.CalledProcessError:
                pass  # left running; the read's own outcome is what matters
    except subprocess.CalledProcessError:
        raise SystemExit("RayTrace: this sandbox's snapshot history could not be read.") from None

def create(sid, archive, limits=None, expect_release=None):
    """A new project sandbox from a staged import archive; its container id.

    With `expect_release`, the sandbox is made only from that active release
    (core/release.py): the release lock is held, shared, from the check until
    the container exists, so an activation cannot switch releases in between,
    and the container is made from that release's image."""
    if not re.fullmatch(PROJECT_ID, sid):
        raise ValueError('Invalid sandbox ID')
    if not archive or not re.fullmatch(r'/tmp/rtp-[a-f0-9]{32}\.tar\.gz', archive):
        raise ValueError('Expected staged import archive')
    validate_archive(archive)
    preflight()
    if expect_release is None:
        return finish_create(sid, archive, create_container(sid, ['--label', LABEL+'='+sid], limits))
    with release.lock(shared=True):
        active = release.active()
        if not active or active.get('id') != expect_release:
            raise SystemExit(f'RayTrace: this host runs release {(active or {}).get("id") or "none"}, '
                             f'not {expect_release}; no sandbox was created.')
        cid = create_container(sid, ['--label', LABEL+'='+sid, '--label', release.LABEL+'='+expect_release],
                               limits, active['image'])
    return finish_create(sid, archive, cid)

def finish_create(sid, archive, cid):
    import_archive(cid, archive)
    remember(sid)
    return cid

def import_archive(cid, archive):
    """The project files of a validated import archive into /workspace, owned by the agent user."""
    # docker cp -a honors the deliberately normalized uid/gid in this tar.
    with tarfile.open(archive, 'r:gz') as source:
        with io.BytesIO() as buffer:
            with tarfile.open(fileobj=buffer, mode='w') as dest:
                made = set()
                for item in source:
                    # The upload holds files only. Without its folders named here, docker
                    # would make them root's, and the agent could add nothing inside them.
                    for parent in reversed(PurePosixPath(item.name).parents[:-1]):
                        if str(parent) not in made:
                            made.add(str(parent))
                            folder = tarfile.TarInfo(str(parent))
                            folder.type, folder.mode = tarfile.DIRTYPE, 0o755
                            folder.uid = folder.gid = 1000
                            folder.uname = folder.gname = 'node'
                            folder.mtime = item.mtime
                            dest.addfile(folder)
                    item.uid = item.gid = 1000
                    item.uname = item.gname = 'node'
                    item.mode = 0o755 if item.mode & 0o111 else 0o644
                    # Names, sizes and modes only: no extended attributes or other pax records.
                    item.pax_headers = {}
                    dest.addfile(item, source.extractfile(item))
            run('docker', 'cp', '-a', '-', cid+':/workspace', input=buffer.getvalue())

RUNTIME_DB = '/var/lib/raytace/runtime.db'

def evidence(container, forget=False):
    """What the collector recorded for one sandbox's container: its process
    events and the fact engine's file and network facts. Printed as JSON lines,
    or with `forget` deleted, for when its owner destroys it with its logs.
    Called once the sandbox is stopped: its last events (its exit, the
    connection closing) come just after, and the collector commits every
    quarter second, so they are waited for."""
    import sqlite3
    time.sleep(1.5)
    if not Path(RUNTIME_DB).exists():
        return
    with sqlite3.connect(RUNTIME_DB, timeout=30) as db:
        tables = {name for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'capture_streams' in tables:
            if forget:
                db.execute('DELETE FROM capture_streams WHERE container_id=?', (container,))
            else:
                for row in db.execute('SELECT id,collector_id,started_ms,ended_ms,heartbeat_ms,dropped,errors,capabilities_json FROM capture_streams WHERE container_id=?', (container,)):
                    names=('id','collector_id','started_ms','ended_ms','heartbeat_ms','dropped','errors','capabilities')
                    body=dict(zip(names,row)); body['capabilities']=json.loads(body['capabilities'])
                    print(json.dumps({'table':'capture_streams','body':body}))
        for table, columns in (('runtime_events', 'kind, received_ms, body'), ('facts', 'kind, at_ns, received_ms, body')):
            if table not in tables:
                continue
            if forget:
                db.execute(f'DELETE FROM {table} WHERE container_id = ?', (container,))
                continue
            names = [column.strip() for column in columns.split(',')]
            for row in db.execute(f'SELECT {columns} FROM {table} WHERE container_id = ? ORDER BY id', (container,)):
                record = dict(zip(names, row))
                record['body'] = json.loads(record['body'])
                print(json.dumps({'table': table, **record}))

# What the dashboard calls each kind of fact, and how many of each it is shown.
FACT_KINDS = {'file': 'files', 'network': 'network', 'dns': 'lookups', 'package': 'packages', 'identity': 'identity', 'summary': 'bulk'}
FACT_LIMITS = {'file': 500, 'network': 500, 'dns': 300, 'package': 100, 'identity': 100, 'summary': 100}

def activity(container, since_ms=0, until_ms=0):
    """What the fact engine saw one sandbox do, newest first, by kind -- the
    shape RayTrace's hosted dashboard reads -- each list capped, with `more`
    naming the kinds that were. since/until (epoch ms) scope it to one prompt."""
    import sqlite3
    found, more = {name: [] for name in FACT_KINDS.values()}, []
    if not Path(RUNTIME_DB).exists():
        return {**found, 'more': more}
    where, args = ['container_id = ?', 'kind = ?'], [container]
    if since_ms:
        where.append('CAST(at_ns AS INTEGER) >= ?'); args.append(since_ms * 1_000_000)
    if until_ms:
        where.append('CAST(at_ns AS INTEGER) <= ?'); args.append(until_ms * 1_000_000)
    with sqlite3.connect(f'file:{RUNTIME_DB}?mode=ro', uri=True, timeout=30) as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name = 'facts'").fetchone():
            return {**found, 'more': more}
        for kind, name in FACT_KINDS.items():
            limit = FACT_LIMITS[kind]
            rows = db.execute('SELECT fact_id, at_ns, body FROM facts WHERE ' + ' AND '.join(where) + ' ORDER BY id DESC LIMIT ?',
                              (args[0], kind, *args[1:], limit + 1)).fetchall()
            for fact_id, at_ns, body in rows[:limit]:
                fact = json.loads(body)
                last = fact.get('last_ns') or at_ns
                try:
                    at = int(last) / 1e9
                except (TypeError, ValueError):
                    at = None
                found[name].append({**fact, 'id': fact_id, 'at': at})
            if len(rows) > limit:
                more.append(name)
    return {**found, 'more': more}

def write_home_files(sid, files):
    """Files into the sandbox user's home, each (folder, name, bytes), the
    folders 0700 and the files 0600, owned by the agent user."""
    with io.BytesIO() as buffer:
        with tarfile.open(fileobj=buffer, mode='w') as archive:
            for folder, name, content in files:
                if not re.fullmatch(r'\.?[A-Za-z0-9_-]{1,40}', folder) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,60}', name):
                    raise ValueError('Invalid home file')
                directory = tarfile.TarInfo(folder); directory.type = tarfile.DIRTYPE
                directory.uid = directory.gid = 1000; directory.mode = 0o700
                archive.addfile(directory)
                entry = tarfile.TarInfo(folder+'/'+name); entry.uid = entry.gid = 1000
                entry.mode = 0o600; entry.size = len(content)
                archive.addfile(entry, io.BytesIO(content))
        run('docker', 'cp', '-a', '-', sid+':/home/node', input=buffer.getvalue())

TOKEN = re.compile(r'[A-Za-z0-9_-]{40,100}')

def set_token(sid, token):
    """The token the sandbox's Claude Code hook (claude-hook.mjs) sends its
    transcript with, to whatever bridge the host names (network.py)."""
    if not TOKEN.fullmatch(token):
        raise ValueError('Invalid sandbox token')
    write_home_files(sid, [('.raytace', 'sandbox-token', token.encode())])

def enable_claude(sid, hook):
    """Installs the hook now and keeps the host's copy, which every start puts back."""
    install_claude_hooks(sid, hook)
    HOOKS.mkdir(parents=True, exist_ok=True, mode=0o700)
    (HOOKS / (sid+'.mjs')).write_bytes(hook)

def start(sid):
    """Starts a project sandbox so that it is recorded: the host's recorder and
    resolver up, the collector reconnected (a sandbox that predates it is
    restarted), restricted files locked, the hook and its lists put back, and
    the engine told which container it is. Starting a running one is safe."""
    state = inspect(sid)
    preflight()
    if predates_collector(state):
        # Files and sign-in are on volumes; only running processes end.
        print('RayTrace: the evidence collector restarted since this sandbox started; '
              'restarting the sandbox so its commands are recorded again.', file=sys.stderr)
        run('docker', 'stop', '-t', '10', sid, stdout=subprocess.DEVNULL)
        state = inspect(sid)
    restricts = (GUARDRAILS / (sid+'.json')).exists()
    if not state['State']['Running']:
        # Stopped is when restricted files are locked (see guardrails()).
        if restricts:
            guardrails(sid, state)
        run('docker', 'start', sid, stdout=subprocess.DEVNULL)
    # Outside its volumes a sandbox's files last until it restarts, so the
    # hook is put back every time, from the host's copy.
    hook = HOOKS / (sid+'.mjs')
    if hook.exists():
        install_claude_hooks(sid, hook.read_bytes())
    # The hook's list of restricted files goes the same way.
    if restricts:
        guardrails(sid, inspect(sid))
    remember(sid)

def shell(sid, agent=None):
    """An interactive shell in a started sandbox (start() first); with `agent`,
    that agent first, without approval prompts. Returns the shell's exit code.
    Exiting never stops or removes the sandbox."""
    line = 'if [ -f /home/node/.raytace-codex/config.toml ]; then export CODEX_HOME=/home/node/.raytace-codex; fi; '
    if agent:
        name, command = AGENTS[agent]
        line += f'cd /workspace 2>/dev/null; if command -v {agent} >/dev/null; then {command}; else echo "{name} is not installed in this sandbox."; fi; '
    return subprocess.run(['docker', 'exec', '-it', sid, '/bin/bash', '-c', line+'exec /bin/bash'], check=False).returncode

def stop(sid):
    inspect(sid)
    run('docker', 'stop', '-t', '10', sid)

# Called with the sandbox id by delete(), after its container is gone: a host
# layer adds its own per-sandbox state here (register_delete_cleanup).
DELETE_CLEANUP = []

def register_delete_cleanup(function):
    DELETE_CLEANUP.append(function)
    return function

def delete(sid, forget_evidence=False):
    """Deletes a stopped project sandbox: its container, its two volumes (only
    ones labelled as its own), the host's copies of its hook and lists, and
    with `forget_evidence` what the collector recorded of it."""
    state = inspect(sid)
    if state['State']['Running']:
        raise ValueError('Stop the sandbox before deleting it')
    run('docker', 'rm', sid)
    if forget_evidence:
        evidence(state['Id'], forget=True)
    (CONTAINERS / (state['Id']+'.json')).unlink(missing_ok=True)
    (HOOKS / (sid+'.mjs')).unlink(missing_ok=True)
    # An immutable file cannot be removed with its volume; chattr -R follows no links.
    if (GUARDRAILS / (sid+'.json')).exists():
        root = subprocess.run(['docker', 'volume', 'inspect', '-f', '{{.Mountpoint}}', sid+'-workspace'], capture_output=True, text=True)
        if root.returncode == 0:
            subprocess.run(['chattr', '-R', '-f', '-i', root.stdout.strip()], stderr=subprocess.DEVNULL)
        (GUARDRAILS / (sid+'.json')).unlink(missing_ok=True)
    for cleanup in DELETE_CLEANUP:
        cleanup(sid)
    for suffix in ('workspace', 'home'):
        volume = sid+'-'+suffix
        result = subprocess.run(['docker', 'volume', 'inspect', volume], capture_output=True, text=True)
        if result.returncode == 0:
            item = json.loads(result.stdout)[0]
            if item.get('Labels', {}).get(LABEL) != sid:
                raise ValueError('Unexpected volume ownership; volume retained')
            run('docker', 'volume', 'rm', volume)

def listing():
    """Every managed container on this host."""
    ids = subprocess.check_output(['docker', 'ps', '-aq', '--filter', 'label='+LABEL], text=True).split()
    result = []
    for cid in ids:
        d = json.loads(subprocess.check_output(['docker', 'inspect', '--size', cid]))[0]
        labels = d['Config'].get('Labels', {})
        result.append({'id': d['Name'].lstrip('/'), 'container_id': d['Id'],
            'status': d['State']['Status'], 'created': d['Created'],
            'persistent_volumes': labels.get('io.raytace.storage') == 'volumes-v1',
            'size_bytes': d.get('SizeRw', 0), 'fork_of': labels.get(FORK_OF),
            'release': labels.get(release.LABEL), 'image': d['Config'].get('Image')})
    return result

def set_guardrails(sid, state, sent):
    """set-guardrails' request checked: {restricted, watched?, blocked?}, the whole lists each time."""
    lists = {}
    for key, cap in (('restricted', 20000), ('watched', 2000)):
        if key == 'watched' and key not in sent:
            lists[key] = None  # an older caller: keep the list the host has
            continue
        if not isinstance(sent.get(key), list) or len(sent[key]) > cap:
            raise ValueError('Invalid '+key+' list')
        lists[key] = [safe_path(path)[len('/workspace/'):] for path in sent[key]]
    # blocked?: program names. Absent (an older caller, or a change to files only): keep the host's.
    blocked = sent.get('blocked')
    if blocked is not None and not (isinstance(blocked, list) and len(blocked) <= 200 and all(
            isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9._+-]{1,64}', name) and name not in ('.', '..') for name in blocked)):
        raise ValueError('Invalid blocked list')
    return guardrails(sid, state, lists['restricted'], lists['watched'], blocked)

ACTIONS = ['create', 'list', 'start', 'shell', 'stop', 'delete', 'set-token', 'enable-claude', 'evidence', 'activity',
           'fork-create', 'fork-run', 'fork-check', 'fork-collect', 'fork-stop', 'fork-delete', 'snapshot',
           'set-guardrails', 'guardrails', 'version']

def version_payload():
    """What this host actually runs: the core, and the active release when there is one."""
    from core import CORE_API, EVIDENCE_SCHEMA, version
    return {'core': version(), 'core_api': CORE_API, 'evidence_schema': EVIDENCE_SCHEMA,
            'release': release.active(), 'image': image()}

def main(extra_actions=None, fork_credentials=None, argv=None):
    """The host command line: `projects.py <action> [id] ...`.

    `extra_actions` maps further action names to functions(opts, state), for a
    host layer that adds its own (state is the sandbox's inspect(), or None for
    an action without an id). `fork_credentials` is fork_action's `credentials`."""
    extra_actions = extra_actions or {}
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=ACTIONS + sorted(extra_actions))
    parser.add_argument('id', nargs='?')
    parser.add_argument('--archive')
    parser.add_argument('--confirm')
    parser.add_argument('--release', help='create: only from this active release (core/release.py)')
    parser.add_argument('--since', type=int, default=0, help='activity: from this epoch ms')
    parser.add_argument('--until', type=int, default=0, help='activity: up to this epoch ms')
    parser.add_argument('--forget-evidence', action='store_true', help='delete: also delete what the collector recorded for it')
    parser.add_argument('--agent', choices=sorted(AGENTS), help='shell: start this agent first, without approval prompts; its exit leaves the shell')
    opts = parser.parse_args(argv)
    if opts.action in extra_actions and not opts.id:
        return extra_actions[opts.action](opts, None)
    if opts.action == 'list':
        return print(json.dumps(listing()))
    if opts.action == 'version':
        return print(json.dumps(version_payload()))
    if opts.action.startswith('fork-'):
        return fork_action(opts.action, opts.id or '', opts.forget_evidence, fork_credentials)
    if not opts.id or not re.fullmatch(PROJECT_ID, opts.id):
        parser.error('Invalid sandbox ID')
    if opts.action == 'create':
        if opts.release is not None and not re.fullmatch(release.ID, opts.release):
            parser.error('Invalid release id')
        # Over SSH the archive arrives on stdin; staged where a copied one would be.
        staged = opts.archive == '-'
        if staged:
            opts.archive = stage_archive(opts.id)
        try:
            return print(create(opts.id, opts.archive, expect_release=opts.release))
        finally:
            if staged:
                Path(opts.archive).unlink(missing_ok=True)
    state = inspect(opts.id)
    if opts.action in extra_actions:
        return extra_actions[opts.action](opts, state)
    if opts.action == 'evidence':
        return evidence(state['Id'])
    if opts.action == 'activity':
        return print(json.dumps(activity(state['Id'], opts.since, opts.until)))
    if opts.action == 'snapshot':
        return read_snapshot(opts.id, state['State']['Running'])
    if opts.action == 'set-guardrails':
        return print(json.dumps(set_guardrails(opts.id, state, json.loads(sys.stdin.buffer.read(4 * 1024 * 1024)))))
    if opts.action == 'guardrails':
        return print(json.dumps(guardrails(opts.id, state)))
    if opts.action == 'set-token':
        set_token(opts.id, sys.stdin.buffer.read(201).decode().strip())
        print('Sandbox token set')
    elif opts.action == 'enable-claude':
        enable_claude(opts.id, sys.stdin.buffer.read(262145))
        print('Claude Code hooks installed')
    elif opts.action in ('shell', 'start'):
        start(opts.id)
        if opts.action == 'shell':
            sys.exit(shell(opts.id, opts.agent))
    elif opts.action == 'stop':
        stop(opts.id)
    elif opts.action == 'delete':
        if opts.confirm != opts.id:
            parser.error('Deletion requires --confirm with the exact sandbox ID')
        try:
            delete(opts.id, opts.forget_evidence)
        except ValueError as error:
            parser.error(str(error))
