#!/usr/bin/env python3
"""Coverage matrix: the workload's ground truth against what RayTrace recorded.

    matrix.py <out-dir>        (after run-audit.sh a, w, x and collect.py)

Verdicts
  PASS           recorded, and it says what happened
  SCOPE          not recorded, and the implementation says it does not record it
  NOT_CAPTURED   the implementation means to record it and nothing arrived
  MISATTRIBUTED  recorded against the wrong process or step
  MISLEADING     recorded, and it reads as something that did not happen
  NOT_FORWARDED  in the collector's database, absent from the host database or dashboard
"""
import json
import sys

OUT = sys.argv[1]
load = lambda name: json.load(open(f'{OUT}/{name}'))
vm, host, dash = load('vm.json'), load('host.json'), load('dashboard.json')
GT = {}
for phase in 'awx':
    try:
        for line in open(f'{OUT}/ground-truth-{phase}.jsonl'):
            record = json.loads(line)
            GT[(phase, record['test'])] = record
    except FileNotFoundError:
        pass
FACTS, EVENTS = vm['facts'], vm['events']
ROWS = []


def facts(phase, test, **want):
    """Facts carrying this test's call id, or with `any_call` every fact, that match."""
    any_call = want.pop('any_call', False)
    call = GT[(phase, test)]['call_id']
    return [fact for fact in FACTS if (any_call or fact.get('call_id') == call)
            and all(fact.get(key) == value for key, value in want.items())]


def actions(phase, test):
    return GT[(phase, test)]['truth'].get('actions', [])


def brief(found):
    return '; '.join(sorted({f"{fact.get('effect')}/{fact.get('certainty') or '-'}" + (f" x{fact['count']}" if fact['count'] > 1 else '')
                             + ('' if fact.get('pid') else ' (no process)') for fact in found})) or 'nothing'


def row(area, phase, test, did, expected, observed, verdict):
    if (phase, test) in GT or test == '(all)':
        ROWS.append((area, phase, test, did, expected, observed, verdict))


def file_row(phase, test, did, path, effect, expected, scope_note=None):
    """A change to one file: is there a fact of that effect, and is it this test's?"""
    if (phase, test) not in GT:
        return
    rel = path[len('/workspace/'):]
    mine = [fact for fact in facts(phase, test, path=rel) if fact.get('effect') != 'read']
    anyone = [fact for fact in FACTS if fact.get('path') == rel and fact.get('effect') == effect
              and int(fact['last_ns']) >= GT[(phase, test)]['truth']['started_ns'] - 10**9
              and int(fact['first_ns']) <= GT[(phase, test)]['truth']['ended_ns'] + 35 * 10**9]
    if any(fact.get('effect') == effect and fact.get('certainty') == 'confirmed' for fact in mine):
        verdict = 'PASS'
    elif any(fact.get('effect') == effect for fact in mine):
        verdict = 'PASS (one_of)'
    elif anyone and not any(fact.get('pid') for fact in anyone):
        verdict = 'MISATTRIBUTED (to nobody)'
    elif anyone:
        verdict = 'MISATTRIBUTED'
    elif scope_note:
        verdict = 'SCOPE'
    else:
        verdict = 'NOT_CAPTURED'
    seen = brief(mine) if mine else ('as ' + brief(anyone) + ' on step ' + ', '.join(sorted({str(fact.get('call_id') or 'none').split('_', 1)[-1] for fact in anyone}))) if anyone else 'nothing'
    row('files', phase, test, did, expected, seen + (f' [{scope_note}]' if scope_note and verdict == 'SCOPE' else ''), verdict)


W, A = '/workspace/audit/w/', '/workspace/audit/a/'
UNLISTED = 'file is on no list; local sandboxes keep no restricted/watched lists'

# ------------------------------------------------------------- phase a: the sandbox as created
for test, did, name, effect in [('f_create', 'create a file', 'notes.txt', 'created'), ('f_edit', 'edit in place', 'notes.txt', 'changed'),
                                ('f_append', 'append', 'notes.txt', 'appended'), ('f_rename', 'rename', 'notes.txt', 'renamed'),
                                ('f_delete', 'delete', 'renamed.txt', 'deleted'), ('f_chmod', 'chmod', 'perm.txt', 'permissions_changed'),
                                ('d_crud', 'SQLite insert/update/delete + commit', 'data.db', 'created')]:
    file_row('a', test, did + ' (unlisted file)', A + name, effect, 'a file fact for the step', UNLISTED)
if ('a', 'f_existing_read') in GT:
    found = [fact for fact in FACTS if fact.get('path') == 'config/payment-keys.js']
    row('files', 'a', 'f_existing_read', 'read config/payment-keys.js (existing credentials-style file)', 'a read fact',
        brief(found) + ' [only a NEW file with a sensitive name is tracked; existing ones need the lists]', 'PASS' if found else 'SCOPE')
    found = [fact for fact in FACTS if fact.get('path') == 'README.md']
    row('files', 'a', 'f_existing_edit', 'append to README.md (tracked project file)', 'a change fact', brief(found) + f' [{UNLISTED}]', 'PASS' if found else 'SCOPE')
if ('a', 'f_sensitive_new') in GT:
    found = [fact for fact in facts('a', 'f_sensitive_new', path='audit/a/.env')]
    effects = {fact['effect'] for fact in found}
    row('files', 'a', 'f_sensitive_new', 'create, read, rewrite and delete a new .env within one process', 'created, read, changed, deleted',
        brief(found), 'PASS' if {'created', 'deleted'} <= effects else 'MISLEADING' if 'opened_for_writing' in effects else 'NOT_CAPTURED')
for test, did in [('f_outside', 'write under /home/node and /tmp'), ('f_skipped_dir', 'write a file under node_modules/')]:
    row('files', 'a', test, did, 'none promised (counted only)', brief([f for f in facts('a', test) if f['kind'] == 'file']) + ' [outside the project / skipped folder]', 'SCOPE')

# ------------------------------------------------------------- phases w, x: watched files
for test, did, name, effect in [
        ('f_create', 'create', 'notes.txt', 'created'), ('f_edit', 'edit in place (r+)', 'notes.txt', 'changed'),
        ('f_append', 'append', 'notes.txt', 'appended'), ('f_edit_atomic', 'write a temp file, rename it over', 'notes.txt', 'changed'),
        ('f_shell_edit', 'sed -i', 'notes.txt', 'changed'), ('f_rename', 'rename away', 'notes.txt', 'renamed'),
        ('f_symlink_write', 'write through a symlink', 'target.txt', 'changed'), ('f_hardlink_write', 'write through a hard link', 'target.txt', 'changed'),
        ('f_fd_relative', 'write via dirfd and via cwd-relative path', 'sub/inner.txt', 'created'),
        ('f_delete', 'delete', 'renamed.txt', 'deleted'), ('f_rmtree', 'rm -r of its folder', 'sub/inner.txt', 'deleted'),
        ('d_crud', 'SQLite insert/update/delete + commit', 'data.db', 'created'), ('d_wal', 'SQLite commit in WAL mode', 'wal.db', 'created'),
        ('p_fork_noexec', 'written by a forked child that never execs', 'forkchild.txt', 'created'), ('b_edits', '200 rewrites of one file', 'target.txt', 'changed')]:
    file_row('w', test, did + ' (watched)', W + name, effect, f'{effect}, on this step')
for test, did, name, effect in [('f_chmod2', 'chmod', 'perm.txt', 'permissions_changed'), ('f_truncate2', 'truncate(2)', 'trunc.txt', 'emptied'),
                                ('f_mmap2', 'write through mmap', 'mm.bin', 'changed'), ('f_delete2', 'delete', 'gone.txt', 'deleted'),
                                ('f_rename2', 'rename', 'mv.txt', 'renamed')]:
    file_row('x', test, did + ' (watched, settled file)', W + name, effect, f'{effect}, on this step')
if ('x', 'f_transient') in GT:
    found = [fact for fact in facts('x', 'f_transient', path='audit/w/transient.txt') if fact['effect'] != 'read']
    row('files', 'x', 'f_transient', 'change a watched file and restore it within milliseconds', 'a change (content differed in between)', brief(found),
        'MISLEADING' if any(fact['effect'] == 'opened_for_writing' for fact in found) else 'PASS' if found else 'NOT_CAPTURED')
if ('x', 'f_delete_denied') in GT:
    found = [fact for fact in FACTS if fact.get('effect') == 'attempted' and fact.get('intent') in ('delete', 'rename')]
    row('files', 'x', 'f_delete_denied', 'delete and rename of a watched file refused (EACCES)', '2 attempted facts (engine.numbered_call)', brief(found), 'PASS' if found else 'NOT_CAPTURED')
for phase in 'aw':
    if (phase, 'f_denied') in GT:
        found = [fact for fact in facts(phase, 'f_denied') if fact.get('effect') == 'attempted']
        row('files', phase, 'f_denied', 'read of a mode-000 file refused (EACCES)' + (' (watched)' if phase == 'w' else ' (unlisted)'), 'attempted read', brief(found),
            'PASS' if found else 'SCOPE' if phase == 'a' else 'NOT_CAPTURED')
for phase, test, name, did in [('w', 'f_read', 'notes.txt', 'read'), ('w', 'f_symlink_read', 'target.txt', 'read through a symlink'), ('w', 'd_readonly', 'data.db', 'SQLite SELECT only'),
                               ('w', 'f_copy_out', 'target.txt', 'copy to /tmp'), ('w', 'b_opens', 'target.txt', '5000 reads in a burst')]:
    if (phase, test) in GT:
        found = facts(phase, test, path='audit/w/' + name, effect='read')
        note = ' [the workload also hashes the file itself: an open through the link cannot be told apart]' if 'symlink' in test else ''
        row('files', phase, test, did + ' (watched)', 'read fact' + (' x5000' if test == 'b_opens' else ''), brief(found) + note,
            'PASS' if found and (test != 'b_opens' or found[0]['count'] >= 5000) else 'NOT_CAPTURED')
if ('w', 'd_rollback') in GT:
    found = [fact for fact in facts('w', 'd_rollback', path='audit/w/data.db') if fact['effect'] != 'read']
    row('database', 'w', 'd_rollback', 'SQLite transaction rolled back (watched file)', 'no change claimed', brief(found),
        'PASS' if all(fact['effect'] == 'opened_for_writing' for fact in found) else 'MISLEADING')
row('database', 'w', 'd_crud', 'which statements ran, and that the transaction committed', 'not promised: the file changing is all a fact says', 'nothing [statements never leave the process]', 'SCOPE')

# ------------------------------------------------------------- processes
def process_events(test, phase='a'):
    call = GT[(phase, test)]['call_id']
    pids = {event['pid'] for event in EVENTS if event['kind'] == 'exec_succeeded' and (event.get('markers') or {}).get('RAYTRACE_CALL_ID') == call}
    return pids, [event for event in EVENTS if event.get('pid') in pids or event.get('child_pid') in pids]

host_pids = {process['pid']: process for process in host['processes']}
if ('a', 'p_simple') in GT:
    pids, _ = process_events('p_simple')
    row('process', 'a', 'p_simple', 'run /bin/echo', 'exec + exit 0', f'{len(pids)} processes with the marker, on host: {len(pids & host_pids.keys())}', 'PASS' if len(pids) == 2 and pids <= host_pids.keys() else 'NOT_FORWARDED')
    pids, _ = process_events('p_chain')
    row('process', 'a', 'p_chain', 'sh -> python3 -> sh -> true', '5 processes, all with the call id', f'{len(pids)} with the marker', 'PASS' if len(pids) >= 5 else 'NOT_CAPTURED')
    pids, events = process_events('p_fail_exit')
    codes = sorted(event['exit_code'] for event in events if event['kind'] == 'process_exit' and event.get('exit_code') is not None)
    row('process', 'a', 'p_fail_exit', 'child exits 7', 'exit code 7', f'exit codes {codes}', 'PASS' if 7 in codes else 'NOT_CAPTURED')
    pids, events = process_events('p_crash')
    signals = [event['signal'] for event in events if event['kind'] == 'process_exit' and event.get('signal')]
    on_host = [process['exit_signal'] for process in host['processes'] if process['pid'] in pids and process['exit_signal']]
    row('process', 'a', 'p_crash', 'child dies of SIGSEGV', 'signal 11', f'collector {signals}, host {on_host}', 'PASS' if 11 in signals and 11 in on_host else 'NOT_CAPTURED')
    pids, events = process_events('p_exec_missing')
    attempts = [event for event in EVENTS if event['kind'] in ('exec_syscall_return', 'exec_failed') and 'audit' in (event.get('executable') or '') and
                ('no-such-binary' in event['executable'] or 'not-executable' in event['executable'])]
    row('process', 'a', 'p_exec_missing', 'exec of a missing binary (ENOENT) and a non-executable file (EACCES)', '2 exec_failed with errno',
        '; '.join(sorted({f"{event['kind']} errno={event.get('errno')}" for event in attempts})) + '; host/dashboard: nothing',
        'PASS' if any(event['kind'] == 'exec_failed' for event in attempts) else 'MISLEADING')
    pids, events = process_events('p_background')
    exits = {event['pid'] for event in events if event['kind'] == 'process_exit'}
    row('process', 'a', 'p_background', 'detached job outlives its parent by 8 s', 'exec and later exit for sh and sleep', f'{len(pids)} processes, {len(exits & pids)} exits', 'PASS' if pids and pids <= exits else 'NOT_CAPTURED')
    pids, _ = process_events('p_concurrent')
    row('process', 'a', 'p_concurrent', '8 children at once', '8 execs', f'{len(pids) - 1} children', 'PASS' if len(pids) == 9 else 'NOT_CAPTURED')
    pids, events = process_events('p_burst')
    exits = sum(1 for event in events if event['kind'] == 'process_exit' and event['pid'] in pids)
    row('burst', 'a', 'p_burst', '300 short-lived processes', '300 execs, 300 exits', f'{len(pids) - 1} execs, {exits - 1} exits; on host {len(pids & host_pids.keys()) - 1}',
        'PASS' if len(pids) == 301 and len(pids & host_pids.keys()) == 301 else 'NOT_CAPTURED')
    child = actions('a', 'p_fork_noexec')[0]['result']['child_pid']
    in_vm = [event['kind'] for event in EVENTS if event.get('pid') == child and event['kind'] == 'process_exit' and event.get('exit_code') == 3]
    row('process', 'a', 'p_fork_noexec', 'forked child (no exec) exits 3', 'a process with exit code 3',
        f"collector: clone + {'exit 3' if in_vm else 'no exit'}; host process row: {'yes' if child in host_pids and host_pids[child]['exit_code'] == 3 else 'no'}",
        'PASS' if child in host_pids and host_pids[child]['exit_code'] == 3 else 'NOT_FORWARDED')
    tops = {event['ppid'] for event in EVENTS if event['kind'] == 'exec_succeeded' and 'workload.py' in ' '.join(event.get('argv', []))}
    started = sum(1 for event in EVENTS if event['kind'] == 'exec_succeeded' and event['pid'] in tops)
    row('process', 'a', '(all)', f'the {len(tops)} shells `docker exec` started (how `raytrace connect` enters)', 'an exec for each', f'{started} execs; exits only', 'PASS' if started == len(tops) else 'NOT_CAPTURED')

# ------------------------------------------------------------- network
def net(test, **want):
    return [fact for fact in facts('a', test) if fact['kind'] == 'network' and all(fact.get(k) == v for k, v in want.items())]

if ('a', 'n_http_ok') in GT:
    row('network', 'a', 'n_http_ok', 'mock HTTP server on 127.0.0.1: GET 200, GET 404, POST 201', 'listen + 3 connections', brief(net('n_http_ok')) + ' [loopback connects are dropped on purpose]', 'SCOPE')
    row('network', 'a', 'n_curl_local', 'curl to a loopback mock', 'a connection', brief(net('n_curl_local', effect='connect')) + ' [loopback]', 'SCOPE')
    row('network', 'a', 'n_refused', 'connect to a closed loopback port (ECONNREFUSED)', 'a failed connection', brief(net('n_refused')) + ' [loopback]', 'SCOPE')
    found = net('n_own_ip', effect='connect')
    row('network', 'a', 'n_own_ip', "HTTP 200 from the sandbox's own address (172.30.60.x)", 'connected', '; '.join(json.dumps(fact['outcomes']) for fact in found) or 'nothing',
        'MISLEADING' if any('refused_by_policy' in fact['outcomes'] for fact in found) else 'PASS' if found else 'NOT_CAPTURED')
    row('network', 'a', 'n_udp_sendto', 'UDP datagram sent with sendto, no connect', 'none promised', brief(net('n_udp_sendto')) + ' [sendto/sendmsg are not subscribed]', 'SCOPE')
    row('network', 'a', 'n_unix', 'Unix-socket connection', 'none promised', brief(net('n_unix')) + ' [non-inet families are dropped]', 'SCOPE')
    found = [fact for fact in FACTS if fact['kind'] == 'dns' and fact.get('name') == 'audit-probe.invalid']
    row('network', 'a', 'n_dns_nx', 'lookup of a reserved .invalid name (NXDOMAIN)', 'a lookup, failed', '; '.join(f"{fact.get('failed')} x{fact['count']}, process {fact.get('pid')}" for fact in found) or 'nothing',
        'PASS (no process)' if found else 'NOT_CAPTURED')
    row('network', 'a', 'n_listen', 'listen on 0.0.0.0:18084', 'listening', brief(net('n_listen', effect='listen')), 'PASS' if net('n_listen', effect='listen') else 'NOT_CAPTURED')
    found = [fact for fact in facts('a', 'x_setuid') if fact['kind'] == 'identity']
    row('identity', 'a', 'x_setuid', 'setuid(0) refused (EPERM)', 'attempted', brief(found), 'PASS' if found else 'NOT_CAPTURED')
    for test, expected in [('b_opens', 5000), ('b_creates', 2000)]:
        found = [fact for fact in facts('a', test) if fact['kind'] == 'summary']
        row('burst', 'a', test, f'{expected} opens of unlisted files', 'one summary with the count', ', '.join(f"{fact['opens']} opens" for fact in found) or 'nothing',
            'PASS' if found and found[0]['opens'] >= expected else 'NOT_CAPTURED')

# ------------------------------------------------------------- layers
vm_execs = {(event['pid'], event['process_start_ns']) for event in EVENTS if event['kind'] == 'exec_succeeded'}
host_execs = {(process['pid'], process['start_time_ns']) for process in host['processes']}
activity = dash.get('activity') if isinstance(dash.get('activity'), dict) else {}
shown = {fact.get('fact_id') for kind in ('files', 'network', 'lookups', 'packages', 'identity', 'bulk') for fact in activity.get(kind, [])}
dropped = sum(stream[6] for stream in vm['streams'])
lag = sorted(fact['received_ms'] - int(fact['last_ns']) // 10**6 for fact in FACTS if fact.get('last_ns'))
print(f"\nLayers: collector exec events {len(vm_execs)} | host process rows {len(host_execs)} | missing on host {len(vm_execs - host_execs)}")
print(f"        collector facts {len(FACTS)} | shown by the dashboard API {len(shown & {fact['fact_id'] for fact in FACTS})}")
print(f"        gVisor-reported dropped events {dropped}; streams {len(vm['streams'])}; dashboard health {json.dumps(dash.get('capture_health'))[:160]}")
if lag:
    print(f"        fact write delay ms: median {lag[len(lag) // 2]}, max {lag[-1]}")
raw_calls = [event for event in EVENTS if event['kind'] == 'syscall_return']
print(f"        raw (number-only) syscall events stored with no process or sandbox: {sum(1 for event in raw_calls if not event['pid'])} of {len(raw_calls)}")
exits = {}
for event in EVENTS:
    if event['kind'] == 'process_exit':
        exits[(event['pid'], event['process_start_ns'])] = exits.get((event['pid'], event['process_start_ns']), 0) + 1
print(f"        processes with more than one exit event: {sum(1 for count in exits.values() if count > 1)}")

print('\n| Area | Ph | Test | What the workload did | Expected evidence | Recorded | Verdict |\n|---|---|---|---|---|---|---|')
for area, phase, test, did, expected, observed, verdict in ROWS:
    print(f'| {area} | {phase} | {test} | {did} | {expected} | {observed} | **{verdict}** |')
tally = {}
for item in ROWS:
    key = item[6].split(' ')[0]
    tally[key] = tally.get(key, 0) + 1
print('\n' + ', '.join(f'{key}: {value}' for key, value in sorted(tally.items())))
