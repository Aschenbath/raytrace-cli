"""The sandbox network's resolver. Python stdlib only; never mount into guests.

Sandboxes resolve names here, on their network's gateway (network.py writes
their resolv.conf), and each lookup is sent on to the real resolver unchanged
and answered with whatever it says. Along the way the name and the addresses it
answered with are written down, which is the only place a host name is seen:
a program connects to an address, never to a name, and HTTPS is not opened.

    dns_cache   for each sandbox, the name that last answered with an address.
                engine.py reads it to put a name beside a connection. Written
                before the answer goes back, so it is there when the program connects.
    facts       one `dns` fact for each name a sandbox looked up, with a count;
                one for each step that asked it when the process can be told
                (the only one connected to this resolver about then, from
                engine.py's resolver_calls: certainty `likely`). Written a few
                seconds late, so the engine has reported that connection.

It decides nothing: no name is refused or changed. A lookup it cannot read is
still forwarded. A sandbox that asks a public resolver directly, or uses DNS
over HTTPS, is not seen here, and its connections then show bare addresses.
If this stops, sandboxes cannot resolve names until systemd starts it again.
"""
import hashlib
import ipaddress
import json
from pathlib import Path
import socket
import socketserver
import sqlite3
import struct
import subprocess
import threading
import time

import engine
import network

DATABASE = '/var/lib/raytace/runtime.db'
MAX_NAME = 253
slots = threading.BoundedSemaphore(64)   # lookups in flight; past that a sandbox's packet is dropped and it asks again
lock = threading.Lock()
containers = {'read': 0.0, 'by_ip': {}, 'moved': set()}
facts, dirty = {}, set()
pending = []   # lookups not yet written: each waits HOLD seconds for the engine to report who connected to ask it
# Which process asked: the one whose connection to this resolver (engine.py
# resolver_calls) is closest in time to the query's arrival, within ASKED_BEFORE
# before it and ASKED_AFTER after it. Measured in a local sandbox (glibc,
# getent, Node's dns.lookup and c-ares, alone, in parallel and beside a
# process resolving every 100 ms): a query arrives 0-2 ms after its own
# connection. The window leaves room for a loaded machine. Any other process
# in it makes the answer one of several: two processes asking within the same
# millisecond cannot be told apart by time.
HOLD = 4
ASKED_BEFORE, ASKED_AFTER = 50_000_000, 5_000_000


def name_at(message, at):
    """(the name at `at`, where the next field starts). Follows the pointers
    DNS uses to repeat a name, a bounded number of times."""
    labels, jumps, after = [], 0, None
    while True:
        size = message[at]
        if size & 0xC0 == 0xC0:
            if after is None:
                after = at + 2
            at = ((size & 0x3F) << 8) | message[at + 1]
            jumps += 1
            if jumps > 20:
                raise ValueError('name loops')
            continue
        at += 1
        if size == 0:
            break
        labels.append(message[at:at + size].decode('ascii', errors='replace'))
        at += size
    name = '.'.join(labels).lower()
    if len(name) > MAX_NAME:
        raise ValueError('name too long')
    return name, at if after is None else after


def lookup(query, answer):
    """(name asked, record type, result code, addresses answered), or None when either message is not a lookup this reads."""
    try:
        if len(query) < 12 or struct.unpack_from('>H', query, 4)[0] != 1:
            return None
        name, at = name_at(query, 12)
        kind = struct.unpack_from('>H', query, at)[0]
        if len(answer) < 12:
            return name, kind, None, []
        flags, _, count = struct.unpack_from('>HHH', answer, 2)
        _, at = name_at(answer, 12)
        at += 4
        addresses = []
        for _ in range(min(count, 64)):
            _, at = name_at(answer, at)
            record, _, _, size = struct.unpack_from('>HHIH', answer, at)
            at += 10
            if record == 1 and size == 4:
                addresses.append(str(ipaddress.IPv4Address(answer[at:at + 4])))
            elif record == 28 and size == 16:
                addresses.append(str(ipaddress.IPv6Address(answer[at:at + 16])))
            at += size
        return name, kind, flags & 0xF, addresses
    except (IndexError, struct.error, ValueError):
        return None


def container_of(ip):
    """The sandbox container that holds an address of the sandbox network now,
    as (container id, whether it is a fork), or None. Docker is asked, not a
    record: an address goes to the next container as soon as one stops, and a
    lookup filed by a remembered address would be filed under a sandbox that
    did not make it, which may be another organization's. What Docker said is
    kept for two seconds; a container without a record of projects.py's (a
    throwaway job) is no sandbox."""
    now = time.monotonic()
    if now - containers['read'] > 2:
        try:
            listed = json.loads(subprocess.check_output(
                ['docker', 'network', 'inspect', 'raytace-egress', '--format', '{{json .Containers}}'], timeout=5)) or {}
            found = {str(joined.get('IPv4Address', '')).partition('/')[0]: container for container, joined in listed.items()}
        except (subprocess.SubprocessError, OSError, ValueError):
            found = {}   # nobody is named when Docker cannot say: a lookup unfiled, never misfiled
        # An address that changed hands: what its last holder looked up is not the new one's.
        before = containers['by_ip']
        containers['moved'].update(address for address in before.keys() | found.keys() if before.get(address) != found.get(address))
        containers.update(read=now, by_ip=found)
    container = containers['by_ip'].get(ip)
    if not container:
        return None
    try:
        record = json.loads((engine.CONTAINERS / (container + '.json')).read_text())
    except (OSError, ValueError):
        return None
    return container, bool(record.get('fork_of'))


def record(db, client, query, answer, asked_ns=None):
    """`asked_ns`: when the query arrived, before it went upstream: the time its
    asker's connection is compared with (asker())."""
    found = lookup(query, answer)
    if not found or not found[0]:
        return
    name, kind, code, addresses = found
    now = time.time_ns()
    with lock:
        container = container_of(client)
        if containers['moved']:
            db.executemany('DELETE FROM dns_cache WHERE client = ?', [(address,) for address in containers['moved']])
            containers['moved'].clear()
            db.commit()
        if addresses:
            db.executemany('INSERT OR REPLACE INTO dns_cache (client, ip, name, seen_ns) VALUES (?,?,?,?)',
                           [(client, address, name, now) for address in addresses])
            db.commit()
        if not container:
            return
        if len(pending) < 20_000:
            pending.append({'container': container, 'name': name, 'kind': kind, 'code': code, 'addresses': addresses, 'at_ns': asked_ns or now})


def asker(db, container, at_ns):
    """The processes that connected to this resolver from that sandbox about
    when a lookup was written, closest in time first."""
    rows = db.execute('SELECT pid, process_start_ns, process, command, call_id, at_ns FROM resolver_calls '
                      'WHERE container_id = ? AND at_ns BETWEEN ? AND ? ORDER BY abs(? - at_ns)',
                      (container, at_ns - ASKED_BEFORE, at_ns + ASKED_AFTER, at_ns)).fetchall()
    found = {}
    for pid, start, process, command, call_id, connected in rows:
        if pid is not None:
            found.setdefault((pid, start), {'pid': pid, 'process_start_ns': start, 'process': process, 'command': command,
                                            'call_id': call_id, 'gap_ms': round((at_ns - connected) / 1e6, 1)})
    return list(found.values())


def settle(lookup, candidates):
    """A held lookup into its fact, once the engine has had time to report
    who connected to ask it (candidates: asker(), closest first). A lone
    candidate is named, and the lookup is a fact of that step, as a file or
    network fact is. With several, time cannot tell them apart (two processes
    asking within a millisecond), so nobody is named: it is the sandbox's one
    fact for the name, as before, with the candidates listed. Call with `lock` held."""
    container, name, kind, code, addresses, now = (lookup['container'], lookup['name'], lookup['kind'], lookup['code'],
                                                   lookup['addresses'], lookup['at_ns'])
    who = candidates[0] if len(candidates) == 1 else None
    step = (who['call_id'] or f"{who['pid']}:{who['process_start_ns']}") if who else None
    fact_id = hashlib.sha256('\0'.join((container[0], 'dns', name, *([step] if step else []))).encode()).hexdigest()[:32]
    fact = facts.get(fact_id)
    if fact is None:
        fact = facts[fact_id] = {'fact_id': fact_id, 'container_id': container[0], 'kind': 'dns', 'effect': 'looked_up', 'name': name,
                                 'count': 0, 'first_ns': str(now), 'addresses': [], 'pid': None, 'call_id': None,
                                 'basis': {'note': 'asked of the sandbox network\'s resolver; which process asked is not known'}}
        if who:
            fact.update(pid=who['pid'], process_start_ns=who['process_start_ns'], process=who['process'], command=who['command'],
                        call_id=who['call_id'], certainty='likely')
            fact['basis'] = {'note': 'the resolver cannot see processes: this is the only process that connected to it '
                                     'about then', 'gap_ms': who['gap_ms']}
        if container[1]:
            fact['fork'] = True
    if not who and len(candidates) > 1:
        # Who might have asked, newest first, a few: the lookups of this name with nobody named.
        seen = list(fact['basis'].get('candidates', []))
        for other in candidates:
            entry = {'pid': other['pid'], 'process': other['process'], 'call_id': other['call_id']}
            if entry not in seen:
                seen.insert(0, entry)
        fact['basis']['candidates'] = seen[:5]
    fact['count'] += 1
    fact['last_ns'] = str(now)
    if addresses:
        fact['addresses'] = sorted(set(fact['addresses']) | set(addresses))[:16]
    if code:
        fact['failed'] = {2: 'SERVFAIL', 3: 'NXDOMAIN', 5: 'REFUSED'}.get(code, str(code))
    elif kind in (1, 28):
        fact.pop('failed', None)
    dirty.add(fact_id)


def flush(database):
    """Writes the lookups that changed, every two seconds: a name asked a
    thousand times is one row written a few times, not a thousand. A lookup
    waits HOLD seconds first, for the engine to say who asked it."""
    db = sqlite3.connect(database, timeout=10)
    while True:
        time.sleep(2)
        with lock:
            due = time.time_ns() - HOLD * 1_000_000_000
            ready = [lookup for lookup in pending if lookup['at_ns'] <= due]
            pending[:] = [lookup for lookup in pending if lookup['at_ns'] > due]
        named = []
        for lookup in ready:
            try:
                named.append(asker(db, lookup['container'][0], lookup['at_ns']))
            except sqlite3.Error:
                named.append([])   # nobody named rather than a lookup lost
        with lock:
            for lookup, candidates in zip(ready, named):
                settle(lookup, candidates)
            rows = [(fact_id, facts[fact_id]['container_id'], 'dns', facts[fact_id]['last_ns'], int(time.time() * 1000), json.dumps(facts[fact_id]))
                    for fact_id in dirty]
            dirty.clear()
            if len(facts) > 20_000:
                facts.clear()
        if rows:
            try:
                db.executemany('INSERT OR REPLACE INTO facts (fact_id, container_id, kind, at_ns, received_ms, body) VALUES (?,?,?,?,?,?)', rows)
                db.commit()
            except sqlite3.Error as error:
                print(f'RayTrace resolver: lookups not written ({error})', flush=True)


def serve(listen, upstream, database):
    setup = sqlite3.connect(database, timeout=10)
    setup.execute('PRAGMA journal_mode=WAL')
    setup.executescript(engine.SCHEMA)
    setup.close()
    local = threading.local()

    def db():
        if not hasattr(local, 'db'):
            local.db = sqlite3.connect(database, timeout=10)
            local.db.execute('PRAGMA synchronous=NORMAL')
        return local.db

    def note(client, query, answer, asked_ns):
        try:
            record(db(), client, query, answer, asked_ns)
        except Exception as error:   # writing a lookup down never costs the sandbox its answer
            print(f'RayTrace resolver: {type(error).__name__}: {error}', flush=True)

    class Datagram(socketserver.BaseRequestHandler):
        def handle(self):
            if not slots.acquire(blocking=False):
                return
            try:
                query, reply_on = self.request
                asked_ns = time.time_ns()
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as out:
                    out.settimeout(5)
                    out.sendto(query, (upstream, 53))
                    answer = out.recv(65535)
                note(self.client_address[0], query, answer, asked_ns)
                reply_on.sendto(answer, self.client_address)
            except OSError:
                pass   # no answer: the sandbox asks again
            finally:
                slots.release()

    class Stream(socketserver.BaseRequestHandler):
        def read(self, connection):
            head = connection.recv(2, socket.MSG_WAITALL)
            if len(head) < 2:
                return None
            body = connection.recv(struct.unpack('>H', head)[0], socket.MSG_WAITALL)
            return body if len(body) == struct.unpack('>H', head)[0] else None

        def handle(self):
            if not slots.acquire(blocking=False):
                return
            try:
                self.request.settimeout(5)
                with socket.create_connection((upstream, 53), timeout=5) as out:
                    while (query := self.read(self.request)) is not None:
                        asked_ns = time.time_ns()
                        out.sendall(struct.pack('>H', len(query)) + query)
                        answer = self.read(out)
                        if answer is None:
                            break
                        note(self.client_address[0], query, answer, asked_ns)
                        self.request.sendall(struct.pack('>H', len(answer)) + answer)
            except OSError:
                pass
            finally:
                slots.release()

    socketserver.ThreadingUDPServer.allow_reuse_address = socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingUDPServer.daemon_threads = socketserver.ThreadingTCPServer.daemon_threads = True
    datagrams = socketserver.ThreadingUDPServer(listen, Datagram)
    streams = socketserver.ThreadingTCPServer(listen, Stream)
    threading.Thread(target=flush, args=(database,), daemon=True).start()
    threading.Thread(target=streams.serve_forever, daemon=True).start()
    print(f'RayTrace resolver ready: {listen[0]}:{listen[1]} -> {upstream}', flush=True)
    datagrams.serve_forever()


if __name__ == '__main__':
    Path(DATABASE).parent.mkdir(parents=True, exist_ok=True)
    serve((network.GATEWAY, 53), network.resolver(), DATABASE)
