#!/bin/bash
# Observability audit: runs workload.py test by test in a disposable local
# sandbox and keeps the workload's own account of what it did (ground truth).
#
#   run-audit.sh <sandbox-name> <out-dir> [phase]     phase: a (default) | w | x
#
# Phase a: the sandbox as `raytrace sandbox create --local` leaves it.
# Phase w: first puts the audit's files on the sandbox's watched list (the
#          lists the fact engine keeps file facts for) and repeats the file and
#          database tests in a second folder.
# Every test is its own `docker exec` carrying RAYTRACE_CALL_ID=<run>_<test>,
# the marker the Claude Code hook gives a tool call, so evidence can be joined.
set -euo pipefail
NAME=$1; OUT=$2; PHASE=${3:-a}
HERE=$(cd "$(dirname "$0")" && pwd)
ID=$(python3 -c "import json,os,sys;b=json.load(open(os.path.expanduser('~/.raytrace/sandboxes.json')));print(next(k for k,v in b.items() if v['name']==sys.argv[1]))" "$NAME")
RUN=aud$(date +%H%M%S)$PHASE
DIR=/workspace/audit/$PHASE
mkdir -p "$OUT"
GT=$OUT/ground-truth-$PHASE.jsonl; : > "$GT"
vm() { limactl shell raytrace -- sudo "$@"; }

vm docker exec -i -u 1000 "$ID" sh -c 'mkdir -p /tmp/audit && cat > /tmp/audit/workload.py' < "$HERE/workload.py"

FILES="f_create f_read f_edit f_append f_edit_atomic f_shell_edit f_chmod f_truncate f_rename f_symlink_read f_symlink_write
f_hardlink_write f_mmap_write f_fd_relative f_copy_out f_delete f_rmtree f_sensitive_new f_denied f_delete_missing"
DB="d_crud d_rollback d_wal d_readonly"
ONCE="f_existing_read f_existing_edit f_outside f_skipped_dir
p_simple p_chain p_fail_exit p_crash p_exec_missing p_background p_concurrent p_fork_noexec p_threads
n_http_ok n_curl_local n_refused n_own_ip n_udp_sendto n_unix n_dns_nx n_listen x_setuid
b_opens b_creates b_edits p_burst"

if [ "$PHASE" = x ]; then
  # Changes to watched files that already exist and have settled (run after phase w).
  DIR=/workspace/audit/w
  WATCHED=$(python3 -c "import json;print(json.dumps({'restricted':[],'watched':['audit/w/'+n for n in ['notes.txt','renamed.txt','perm.txt','trunc.txt','target.txt','mm.bin','sub/inner.txt','locked.txt','data.db','wal.db','forkchild.txt','heartbeat.txt','transient.txt','ro/keep.txt','gone.txt','mv.txt']]}))")
  echo "$WATCHED" | vm python3 /opt/raytace/projects.py set-guardrails "$ID"
  vm docker exec -u 1000 -w /workspace -e RAYTRACE_CALL_ID="${RUN}_f_prep" "$ID" /bin/sh -c "python3 /tmp/audit/workload.py f_prep $DIR" > "$OUT/prep-x.json"
  sleep 8
  TESTS="f_chmod2 f_truncate2 f_mmap2 f_transient f_delete2 f_rename2 f_delete_denied"
elif [ "$PHASE" = w ]; then
  # The engine's guarded path. Locally nothing sets these lists (see the report).
  WATCHED=$(python3 -c "import json;print(json.dumps({'restricted':[],'watched':['audit/w/'+n for n in ['notes.txt','renamed.txt','perm.txt','trunc.txt','target.txt','mm.bin','sub/inner.txt','locked.txt','data.db','wal.db','forkchild.txt','heartbeat.txt']]}))")
  vm docker exec -u 1000 "$ID" mkdir -p $DIR/sub
  echo "$WATCHED" | vm python3 /opt/raytace/projects.py set-guardrails "$ID"
  sleep 3
  TESTS="$FILES $DB p_fork_noexec b_opens b_edits"
else
  TESTS="$FILES $DB $ONCE"
fi

for TEST in $TESTS; do
  START=$(python3 -c 'import time;print(int(time.time()*1000))')
  set +e
  LINE=$(vm docker exec -u 1000 -w /workspace -e RAYTRACE_CALL_ID="${RUN}_${TEST}" "$ID" /bin/sh -c "python3 /tmp/audit/workload.py $TEST $DIR" 2>"$OUT/stderr-$PHASE-$TEST.txt")
  CODE=$?
  set -e
  END=$(python3 -c 'import time;print(int(time.time()*1000))')
  [ -s "$OUT/stderr-$PHASE-$TEST.txt" ] || rm -f "$OUT/stderr-$PHASE-$TEST.txt"
  python3 - "$GT" "$TEST" "${RUN}_${TEST}" "$START" "$END" "$CODE" "$LINE" <<'PY'
import json, sys
gt, test, call, start, end, code, line = sys.argv[1:]
try: body = json.loads(line)
except ValueError: body = {'unparsed': line[:500]}
open(gt, 'a').write(json.dumps({'test': test, 'call_id': call, 'host_start_ms': int(start), 'host_end_ms': int(end), 'exit': int(code), 'truth': body}) + '\n')
PY
  echo "$TEST exit=$CODE"
  sleep 1.5
done
echo "$RUN $ID" > "$OUT/run-$PHASE.txt"
echo "ground truth: $GT"
