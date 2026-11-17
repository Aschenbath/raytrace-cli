#!/bin/bash
# Runs DNS lookups in a local sandbox, each case under its own call id, and prints
# the ground truth (name -> call id) as JSON lines. Reserved .invalid names only.
set -uo pipefail
ID=$1
LIMACTL=${LIMACTL:-limactl}   # or ~/.raytrace/lima/<version>/bin/limactl, the copy RayTrace downloaded
vm() { "$LIMACTL" shell raytrace -- sudo "$@"; }
run() {  # call-id, command
  vm docker exec -u 1000 -w /workspace -e RAYTRACE_CALL_ID="$1" "$ID" /bin/sh -c "$2" >/dev/null 2>&1
}
truth() { echo "{\"name\": \"$1\", \"call\": \"$2\", \"case\": \"$3\"}"; }
T=$(date +%H%M%S)

run "dp${T}_py" "python3 -c \"import socket
try: socket.getaddrinfo('dnsprobe-py.invalid', 80)
except OSError: pass\""
truth dnsprobe-py.invalid "dp${T}_py" python-getaddrinfo

run "dp${T}_getent" "getent hosts dnsprobe-getent.invalid"
truth dnsprobe-getent.invalid "dp${T}_getent" getent

run "dp${T}_nodelookup" "node -e \"require('dns').lookup('dnsprobe-nodelookup.invalid', () => {})\""
truth dnsprobe-nodelookup.invalid "dp${T}_nodelookup" node-lookup

run "dp${T}_noderesolve" "node -e \"require('dns').resolve4('dnsprobe-noderesolve.invalid', () => {})\""
truth dnsprobe-noderesolve.invalid "dp${T}_noderesolve" node-resolve-cares

# One c-ares channel, five names over three seconds: does it reuse its socket?
run "dp${T}_reuse" "node -e \"const r = new (require('dns').Resolver)(); let n = 0;
const go = () => { r.resolve4('dnsprobe-reuse-' + n + '.invalid', () => {}); if (++n < 5) setTimeout(go, 700); }; go();\""
for n in 0 1 2 3 4; do truth "dnsprobe-reuse-$n.invalid" "dp${T}_reuse" node-resolver-reuse; done

# Two processes at the same moment, ten lookups each.
run "dp${T}_parA" "python3 -c \"import socket, time
for n in range(10):
    try: socket.getaddrinfo('dnsprobe-para-%d.invalid' % n, 80)
    except OSError: pass
    time.sleep(0.05)\"" &
run "dp${T}_parB" "python3 -c \"import socket, time
for n in range(10):
    try: socket.getaddrinfo('dnsprobe-parb-%d.invalid' % n, 80)
    except OSError: pass
    time.sleep(0.05)\"" &
wait
for n in 0 1 2 3 4 5 6 7 8 9; do truth "dnsprobe-para-$n.invalid" "dp${T}_parA" parallel; truth "dnsprobe-parb-$n.invalid" "dp${T}_parB" parallel; done

# A noisy neighbour resolving every 100 ms, and one lookup from another call in the middle.
run "dp${T}_noise" "python3 -c \"import socket, time
end = time.time() + 6
while time.time() < end:
    try: socket.getaddrinfo('dnsprobe-noise.invalid', 80)
    except OSError: pass
    time.sleep(0.1)\"" &
sleep 2
run "dp${T}_target" "getent hosts dnsprobe-target.invalid"
wait
truth dnsprobe-noise.invalid "dp${T}_noise" noise
truth dnsprobe-target.invalid "dp${T}_target" target-beside-noise

# A noisy c-ares neighbour (one socket, reused) beside a one-off lookup.
run "dp${T}_cnoise" "node -e \"const r = new (require('dns').Resolver)(); const end = Date.now() + 6000;
const go = () => { r.resolve4('dnsprobe-cnoise.invalid', () => {}); if (Date.now() < end) setTimeout(go, 100); }; go();\"" &
sleep 2
run "dp${T}_ctarget" "getent hosts dnsprobe-ctarget.invalid"
wait
truth dnsprobe-cnoise.invalid "dp${T}_cnoise" cares-noise
truth dnsprobe-ctarget.invalid "dp${T}_ctarget" target-beside-cares-noise
