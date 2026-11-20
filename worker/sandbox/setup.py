"""Sets a sandbox host up. Run with sudo on the host (inside the Lima VM locally, never on the Mac).

Separate steps, each callable alone, in this order:

    install    runsc, this core's files into --root, the trace config, sysctls
    network    the sandbox network and its firewall (network.py)
    services   the collector, viewer and resolver units, running from --root
    image      the agent image, with the agent versions in agents.json (or given)
    activate   services restarted in order (resolver, collector, viewer), then verified

`python3 setup.py` runs them all with --root /opt/raytace: a local VM. A host
layer can run any of them and add its own; each step writes only the core's
files (/etc/raytace/*.json, resolv.conf, bridge*, image; the raytace-* units;
--root), never another layer's.

Which calls gVisor reports is not written here: trace_config() reads it from
the catalog (syscall_catalog.sql, the `capture` column), so what a host
subscribes to is what the catalog says, for the architecture it runs on.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request

# The runsc release installed. The catalog's numbers and coverage are generated
# for one release (catalog_numbers.py): change both together.
RELEASE = '20260817.0'
CONTEXT = ['time', 'thread_id', 'group_id', 'thread_group_start_time',
           'container_id', 'cwd', 'process_name', 'parent_thread_group_id']


def run(*args):
    subprocess.run(args, check=True)


def trace_config(arch, catalog_sql, endpoint, calls=True):
    """gVisor's trace session for this host: its own process points (clone,
    exec, exit), which are fixed, and with `calls` the file, network and
    identity calls the catalog captures. A captured call with a typed point
    is subscribed on that point's exit, with the optional fields its row asks
    for; one gVisor reports by number only (`watcher` rows: delete, rename...)
    on its raw exit point, for who made it, when, and whether it was refused."""
    catalog = sqlite3.connect(':memory:')
    try:
        catalog.executescript(catalog_sql)
        if not catalog.execute('SELECT count(*) FROM syscall_coverage WHERE gvisor_release = ?', (RELEASE,)).fetchone()[0]:
            raise SystemExit(f'The catalog has no coverage for gVisor {RELEASE}: run catalog_numbers.py for this release.')
        number = dict(catalog.execute('SELECT syscall_name, sysno FROM syscall_numbers WHERE arch = ?', (arch,)).fetchall())
        captured = catalog.execute(
            """SELECT c.syscall_name, c.capture, c.capture_fields, c.group_id, v.point, v.optional_fields
               FROM syscall_catalog AS c JOIN syscall_numbers AS n ON n.syscall_name = c.syscall_name AND n.arch = ?
               LEFT JOIN syscall_coverage AS v ON v.syscall_name = c.syscall_name AND v.gvisor_release = ?
               WHERE c.capture IN ('yes', 'watcher') ORDER BY n.sysno""", (arch, RELEASE)).fetchall() if calls else []
    finally:
        catalog.close()
    points = ['sentry/clone', 'sentry/execve', 'sentry/exit_notify_parent',
              'sentry/task_exit', 'syscall/execve/enter', 'syscall/execve/exit',
              'syscall/execveat/enter', 'syscall/execveat/exit']
    points += [f'syscall/sysno/{number[name]}/exit' for name in ('execve', 'execveat')]
    # `envv` is an optional field on the execve points. It is requested ONLY so
    # the collector can read the two RAYTRACE_* markers back off a process and
    # turn correlation from a text guess into an exact join; collector.py drops
    # every other variable (and the raw packet) before anything is written. A
    # real environment block carries every secret a process was started with,
    # so this must never be widened to other points or stored verbatim.
    marker_points = {'syscall/execve/enter', 'syscall/execveat/enter'}
    def point_config(point):
        entry = {'name': point, 'context_fields': [f for f in CONTEXT if not
                 (point == 'sentry/exit_notify_parent' and f == 'cwd')]}
        if point in marker_points:
            entry['optional_fields'] = ['envv']
        return entry
    configured = [point_config(point) for point in points]
    for name, capture, wanted, group, point, offered in captured:
        if capture == 'yes' and not point:
            raise SystemExit(f'The catalog captures {name}, but gVisor {RELEASE} has no typed trace point for it.')
        # A file call needs the working directory, to read a relative path; a
        # connection does not, and gVisor works it out for every event asked.
        entry = {'name': f'{point}/exit' if capture == 'yes' else f'syscall/sysno/{number[name]}/exit',
                 'context_fields': [f for f in CONTEXT if group == 'files' or f != 'cwd']}
        fields = [field for field in json.loads(wanted) if field in json.loads(offered or '[]')] if capture == 'yes' else []
        if fields:
            entry['optional_fields'] = fields
        if capture == 'watcher':
            # gVisor fills a raw exit event's context (which sandbox, which
            # process, when) from the fields asked of the same call's raw
            # ENTER point (kernel/task_syscall.go: the exit path reads
            # SyscallRawEnter's field set). With only the exit subscribed the
            # event names nobody, and the engine cannot say who deleted or
            # renamed a file. So the enter point is subscribed with the same
            # fields; the collector reads its exit and discards the enter.
            configured.append({'name': f'syscall/sysno/{number[name]}/enter', 'context_fields': entry['context_fields']})
        configured.append(entry)
    # gVisor never waits long for the collector: when its socket is full it
    # tries again a few times, each wait twice the last (25 microseconds at
    # first), then drops the event and counts it. Three tries were under a
    # fifth of a millisecond, and a burst of opens (an `npm uninstall`) lost
    # events on a busy host. Eight is about six milliseconds at the very most,
    # paid only while the collector is behind.
    return {'trace_session': {'name': 'Default', 'points': configured,
        'sinks': [{'name': 'remote', 'ignore_setup_error': False,
                   'config': {'endpoint': endpoint, 'retries': 8}}]}}


SOURCE = Path(__file__).resolve().parent
# What install copies: everything the host runs, nothing it does not (tests, caches).
SKIP = ('test_', '__pycache__', '.', 'tests')
UNITS = ('dns', 'collector', 'viewer')   # the restart order: what sandboxes resolve with first


def install(root, arch):
    base = f'https://storage.googleapis.com/gvisor/releases/release/{RELEASE}/{arch}/'
    binary = urllib.request.urlopen(base + 'runsc', timeout=120).read()
    checksum = urllib.request.urlopen(base + 'runsc.sha512', timeout=30).read().decode().split()[0]
    if hashlib.sha512(binary).hexdigest() != checksum:
        raise SystemExit('runsc checksum mismatch')
    # Written beside it and moved over: a host with sandboxes running is
    # running this file, and Linux refuses to write to a program in use.
    staged = Path('/usr/local/bin/runsc.new')
    staged.write_bytes(binary)
    staged.chmod(0o755)
    staged.replace('/usr/local/bin/runsc')
    for directory in ['/opt/raytace', '/etc/raytace', '/var/lib/raytace', '/run/raytace']:
        Path(directory).mkdir(exist_ok=True, mode=0o700)
    copy_core(root)
    config = trace_config(arch, (root / 'syscall_catalog.sql').read_text(), '/run/raytace/events.sock')
    Path('/etc/raytace/gvisor.json').write_text(json.dumps(config, indent=2))
    # The engine watches the folder of every file an owner restricted or watches.
    # And room for events on their way to the collector, so a burst waits in
    # the kernel and is not dropped: how many may queue on its socket, and how
    # many bytes a sandbox may have in flight. Both are read when a socket is
    # made, so they are set before the collector and any sandbox start.
    Path('/etc/sysctl.d/60-raytace.conf').write_text(
        'fs.inotify.max_user_watches = 1048576\nfs.inotify.max_user_instances = 1024\n'
        'net.unix.max_dgram_qlen = 8192\nnet.core.wmem_default = 8388608\nnet.core.wmem_max = 8388608\n')
    run('sysctl', '-q', '-p', '/etc/sysctl.d/60-raytace.conf')
    run('/usr/local/bin/runsc', 'install', '--runtime=raytace-gvisor', '--',
        '--pod-init-config=/etc/raytace/gvisor.json')
    # Docker reads its runtimes at start.
    run('systemctl', 'restart', 'docker')


def copy_core(root):
    """This core's files into root (nothing to do when they are already there), with its VERSION."""
    root.mkdir(parents=True, exist_ok=True, mode=0o755)
    if root.resolve() != SOURCE:
        for item in SOURCE.rglob('*'):
            relative = item.relative_to(SOURCE)
            if any(part.startswith(SKIP) for part in relative.parts) or item.suffix in ('.pyc', '.mjs') and 'test' in item.name:
                continue
            if item.is_dir():
                (root / relative).mkdir(exist_ok=True)
            else:
                (root / relative).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(item, root / relative)
    sys.path.insert(0, str(SOURCE))
    from core import version
    # Read from the package it ships in; an installed copy keeps the VERSION it came with.
    if version():
        (root / 'VERSION').write_text(version() + '\n')


def network(root):
    run('python3', str(root / 'network.py'))


def services(root):
    for name, command in [('collector', 'collector.py --socket /run/raytace/events.sock --database /var/lib/raytace/runtime.db'),
                          ('viewer', 'viewer.py'), ('dns', 'dns_forwarder.py')]:
        # The resolver is what sandboxes resolve names with: it comes back whatever ended it.
        unit = f'''[Unit]
Description=RayTrace {name}
After=network.target{' docker.service' if name == 'dns' else ''}
[Service]
ExecStart=/usr/bin/python3 {root}/{command}
Restart={'always' if name == 'dns' else 'on-failure'}
RestartSec=2
UMask=0077
RuntimeDirectory=raytace
RuntimeDirectoryPreserve=yes
[Install]
WantedBy=multi-user.target
'''
        if name == 'collector':
            unit = unit.replace('ExecStart=', 'ExecStartPre=/usr/bin/rm -f /run/raytace/events.sock\nExecStart=')
        Path(f'/etc/systemd/system/raytace-{name}.service').write_text(unit)
    # Ubuntu's automatic updates restart services whose libraries changed. A
    # collector restart silently ends every running sandbox's evidence stream
    # (gVisor does not reconnect), so it is never restarted that way; projects.py
    # restarts sandboxes that predate the collector instead.
    if Path('/etc/needrestart/conf.d').is_dir():
        Path('/etc/needrestart/conf.d/raytace.conf').write_text(
            "$nrconf{override_rc}{qr(^raytace-)} = 0;\n")
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', *(f'raytace-{name}' for name in UNITS))


def agent_versions(claude=None, codex=None):
    """The exact agent versions the image is built with: given, or this core's tested ones (agents.json)."""
    tested = json.loads((SOURCE / 'agents.json').read_text())
    return {'claude_code': claude or tested['claude_code'], 'codex': codex or tested['codex']}


def installed_agents(tag):
    """What `claude --version` and `codex --version` say in an image."""
    def ask(program):
        out = subprocess.run(['docker', 'run', '--rm', '--network=none', '--entrypoint', program, tag, '--version'],
                             capture_output=True, text=True, timeout=120)
        return (out.stdout or out.stderr).strip()
    return {'claude_code': ask('claude'), 'codex': ask('codex')}


def image(tag, versions, write_default=True):
    """Builds the agent image with these exact agent versions and checks it has them; its image id."""
    run('docker', 'build', '-t', tag, '--build-arg', f'CLAUDE_CODE_VERSION={versions["claude_code"]}',
        '--build-arg', f'CODEX_VERSION={versions["codex"]}', '-f', str(SOURCE / 'Dockerfile'), str(SOURCE))
    found = installed_agents(tag)
    for key, wanted in versions.items():
        if wanted not in found[key]:
            raise SystemExit(f'The image {tag} has {key} "{found[key]}", not {wanted}.')
    if write_default:
        Path('/etc/raytace/image').write_text(tag + '\n')
    return subprocess.check_output(['docker', 'image', 'inspect', '-f', '{{.Id}}', tag], text=True).strip()


def activate():
    """Restarts the core's services in order and checks they serve."""
    for name in UNITS:
        run('systemctl', 'restart', f'raytace-{name}')
    verify()


def verify(seconds=20):
    """The collector's socket is there and the resolver answers on the gateway, or SystemExit."""
    sys.path.insert(0, str(SOURCE))
    import network as net
    deadline = time.time() + seconds
    while time.time() < deadline:
        active = all(subprocess.run(['systemctl', 'is-active', '--quiet', f'raytace-{name}']).returncode == 0 for name in UNITS)
        if active and Path('/run/raytace/events.sock').exists() and resolves(net.GATEWAY):
            return
        time.sleep(1)
    raise SystemExit('RayTrace: the collector or the sandbox resolver did not come up.')


def resolves(server):
    """Whether a DNS server answers a query for localhost. (A bare query, no library.)"""
    import socket
    import struct
    query = struct.pack('>HHHHHH', 0x5254, 0x0100, 1, 0, 0, 0) + b'\x09localhost\x00' + struct.pack('>HH', 1, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(2)
        try:
            sock.sendto(query, (server, 53))
            return sock.recv(512)[:2] == query[:2]
        except OSError:
            return False


STEPS = ['install', 'network', 'services', 'image', 'activate']


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Set a RayTrace sandbox host up (all steps by default).')
    parser.add_argument('steps', nargs='*', choices=STEPS, help='only these steps, in the order given')
    parser.add_argument('--root', default='/opt/raytace', help='where the core is installed and its services run from')
    parser.add_argument('--image-tag', help='image: the tag to build (default raytace-gvisor-agent:<core version>)')
    parser.add_argument('--claude-code', help='image: exact @anthropic-ai/claude-code version')
    parser.add_argument('--codex', help='image: exact @openai/codex version')
    opts = parser.parse_args()
    if platform.system() != 'Linux' or os.geteuid() != 0:
        raise SystemExit('Run this setup with sudo on the sandbox host (inside the RayTrace Linux VM locally).')
    arch = {'aarch64': 'aarch64', 'x86_64': 'x86_64'}[platform.machine()]
    root = Path(opts.root)
    for step in opts.steps or STEPS:
        if step == 'install':
            install(root, arch)
        elif step == 'network':
            network(root)
        elif step == 'services':
            services(root)
        elif step == 'image':
            sys.path.insert(0, str(SOURCE))
            from core import version
            image(opts.image_tag or f'raytace-gvisor-agent:{version() or "dev"}', agent_versions(opts.claude_code, opts.codex))
        elif step == 'activate':
            activate()
    print('Ready.')
