#!/usr/bin/env python3
"""Pulls what RayTrace recorded for one local sandbox, from each layer, into <out-dir>.

    collect.py <sandbox-name> <out-dir>

  vm.json         the collector's database in the VM (/var/lib/raytace/runtime.db):
                  runtime_events, facts, capture_streams for the sandbox's container
  host.json       the local evidence database (~/.raytrace/evidence.db)
  dashboard.json  what the local dashboard's API answers (activity, runtime raw and folded)
Read-only everywhere.
"""
import json
import os
import sqlite3
import subprocess
import sys
import urllib.request

NAME, OUT = sys.argv[1], sys.argv[2]
HOME = os.path.expanduser('~/.raytrace')
boxes = json.load(open(f'{HOME}/sandboxes.json'))
SID = next(key for key, value in boxes.items() if value['name'] == NAME)

VM = r'''
import json, sqlite3, subprocess, sys
sid = sys.argv[1]
cid = subprocess.check_output(['docker', 'inspect', '-f', '{{.Id}}', sid], text=True).strip()
db = sqlite3.connect('file:/var/lib/raytace/runtime.db?mode=ro', uri=True)
out = {'container_id': cid, 'events': [], 'facts': [], 'streams': []}
for i, kind, received, body in db.execute('SELECT id, kind, received_ms, body FROM runtime_events WHERE container_id=? ORDER BY id', (cid,)):
    event = json.loads(body); event.pop('raw_packet_base64', None); event.pop('payload_base64', None)
    out['events'].append({'id': i, 'kind': kind, 'received_ms': received, **event})
for i, kind, at, received, body in db.execute('SELECT id, kind, at_ns, received_ms, body FROM facts WHERE container_id=? ORDER BY id', (cid,)):
    out['facts'].append({'row': i, 'received_ms': received, **json.loads(body)})
out['streams'] = [list(row) for row in db.execute('SELECT * FROM capture_streams WHERE container_id=?', (cid,))]
out['collector_state'] = db.execute('SELECT * FROM collector_state').fetchall()
print(json.dumps(out))
'''
vm = json.loads(subprocess.check_output(['limactl', 'shell', 'raytrace', '--', 'sudo', 'python3', '-c', VM, SID], text=True))
json.dump(vm, open(f'{OUT}/vm.json', 'w'))
CID = vm['container_id']

db = sqlite3.connect(f'file:{HOME}/evidence.db?mode=ro', uri=True)
db.row_factory = sqlite3.Row
host = {'sandboxes': [dict(row) for row in db.execute('SELECT * FROM runtime_sandboxes WHERE project_id=? OR external_container_id=?', (SID, CID))]}
ids = [row['id'] for row in host['sandboxes']]
marks = ','.join('?' * len(ids)) or "''"
host['processes'] = [dict(row) for row in db.execute(f'SELECT * FROM runtime_processes WHERE sandbox_id IN ({marks})', ids)]
host['events'] = [dict(row) for row in db.execute(f'SELECT id, sandbox_id, process_id, event_kind, observed_at_ns, received_at_ms, payload_json FROM runtime_events WHERE sandbox_id IN ({marks})', ids)]
host['syscalls'] = db.execute(f'SELECT count(*) FROM runtime_syscall_calls WHERE sandbox_id IN ({marks})', ids).fetchone()[0]
host['streams'] = [dict(row) for row in db.execute('SELECT * FROM runtime_capture_streams')]
host['checkpoints'] = [dict(row) for row in db.execute('SELECT * FROM runtime_capture_checkpoints')]
host['sessions'] = [dict(row) for row in db.execute('SELECT * FROM agent_sessions WHERE external_session_id=?', (SID,))]
host['snapshots'] = db.execute('SELECT count(*) FROM workspace_snapshots').fetchone()[0]
json.dump(host, open(f'{OUT}/host.json', 'w'), default=str)

token = open(f'{HOME}/api-token').read().strip()
port = 8797
def api(path):
    request = urllib.request.Request(f'http://127.0.0.1:{port}{path}', headers={'authorization': f'Bearer {token}', 'x-raytace-token': token})
    try:
        with urllib.request.urlopen(request, timeout=60) as answer:
            return json.loads(answer.read())
    except Exception as error:  # noqa: BLE001
        return {'error': str(error)}
dash = {'sandboxes': api('/raytace/sandboxes'), 'activity': api(f'/raytace/sandboxes/{SID}/activity'),
        'runtime_folded': api(f'/raytace/runtime?sandbox={SID}'), 'runtime_raw': []}
before = '0'
for _ in range(400):
    page = api(f'/raytace/runtime?sandbox={SID}&raw=1&before={before}')
    if 'events' not in page:
        dash['runtime_raw_error'] = page
        break
    dash['runtime_raw'] += page['events']
    dash['capture_health'] = page.get('captureHealth'); dash['coverage'] = page.get('coverage')
    if not page.get('next_before'):
        break
    before = str(page['next_before'])
json.dump(dash, open(f'{OUT}/dashboard.json', 'w'))
print(SID, CID[:12], 'vm events', len(vm['events']), 'vm facts', len(vm['facts']), '| host processes', len(host['processes']),
      'events', len(host['events']), '| dashboard raw', len(dash['runtime_raw']), 'activity', {k: (len(v) if isinstance(v, list) else v) for k, v in dash['activity'].items()} if isinstance(dash['activity'], dict) else dash['activity'])
