# Local sandbox observability audit

Checks what a local sandbox's recording actually captures, against an
independent account of what was done. Nothing here changes RayTrace's code.

| File | What it is |
| --- | --- |
| `workload.py` | Runs inside the sandbox. One ordinary development activity per test; prints its own ground truth (operation, kernel result, file hash afterwards). Synthetic data, loopback mock services and a disposable SQLite file only. |
| `run-audit.sh` | Runs the tests one `docker exec` at a time, each with its own `RAYTRACE_CALL_ID`, and saves the ground truth. |
| `collect.py` | Read-only copy of what was recorded: the collector's database in the VM, `~/.raytrace/evidence.db`, and the dashboard API. |
| `matrix.py` | Compares the two and prints the coverage matrix. |
| `RESULTS-2026-11-16.md` | The matrix from the first run. |

## Run it again

```sh
cd ../raytrace-demo-shop && node ../raytrace-cli-local/bin/raytrace.mjs sandbox create --local --name audit-box --yes
cd ../raytrace-cli-local && OUT=$(mktemp -d)
test/observability-audit/run-audit.sh audit-box "$OUT" a   # the sandbox as created (no file lists)
test/observability-audit/run-audit.sh audit-box "$OUT" w   # files put on the watched list first
test/observability-audit/run-audit.sh audit-box "$OUT" x   # changes to watched files that already exist
sleep 35                                                   # the engine's last look at a file is 30 s after its open
python3 test/observability-audit/collect.py audit-box "$OUT"
python3 test/observability-audit/matrix.py "$OUT"
```

Phases `w` and `x` call `projects.py set-guardrails` in the VM directly: the
local CLI and dashboard have no way to set those lists (finding 1).

Shutdown: start `workload.py s_heartbeat /workspace/audit/w` with `docker exec -d`,
run `raytrace sandbox stop <name>`, read `heartbeat.txt` from the volume in the
VM, and compare its SHA-256 with the last `changed` fact's `basis.after.sha256`.

## Limits of this audit

- Claude Code in the sandbox was not signed in, so the workload is scripted.
  The agent layer (transcript, tool calls, PostToolUse snapshots, joining a
  fact to a tool call) was not exercised. The call id was carried the way the
  hook carries it, in the environment.
- One architecture (aarch64), one gVisor release (20260817.0).
- Not tried: restarting the collector under a running sandbox (it would cut the
  recording of every other sandbox on the VM), a Mac sleep, external hosts.

## What an observation proves

| Recorded | Proves | Does not prove |
| --- | --- | --- |
| `read` fact | the file was opened without write flags | that any bytes were read, or which |
| `changed` / `created` fact | the host saw different bytes on disk after than before | how many writes, what was in between, or (when `one_of`/`unattributed`) who |
| `opened_for_writing`, `possible` | an open with write flags, and the same bytes 30 s later | that nothing was written: a change put back, or a file created and deleted, reads the same |
| `network` fact, `connected` | `connect` returned 0 for that address and port | that anything was sent, or what; the host name is a best match from DNS |
| `listen` fact | the socket listens | that anyone connected |
| process exec + exit | the program started with those arguments and ended with that status | what it did; a failed exec leaves no usable record |
| a change to a database file | the file's bytes changed | which statements ran, or that a transaction committed (in WAL mode the main file may not change at commit) |
| no record | nothing | that it did not happen |

## Findings (first run)

1. **Local sandboxes record no file activity for ordinary project files.**
   The engine keeps a file fact only for a restricted or watched file, or a new
   file with a sensitive name. `proxy/raytace-proxy.mjs:463` says those lists
   "are not kept for local sandboxes yet", and nothing local calls
   `set-guardrails`. Create, edit, rename, delete of any unlisted file, and a
   read of the existing `config/payment-keys.js`, left nothing. By design, but
   it is most of what a user would expect "file access" to mean. *Medium:* a
   local way to set the lists; *large:* facts for every project file.
2. **Calls gVisor reports by number arrive with no process or sandbox, so the
   engine discards them.** Message type 6 carries no `context_data` in this
   release (decoded packet: fields 2, 4-10 only). `engine.handle` returns on an
   empty `container_id`. Lost with it: who deleted, renamed, truncated or
   chmod-ed a watched file (always `unattributed`, or credited to an earlier
   writer), and every refused delete or rename (no fact at all). 492 of 492
   stored raw events have pid 0. *Small to medium:* the collector knows the
   connection's container, and pid needs another source (the enter point, or
   typed points where gVisor has them).
3. **A change is credited to whoever last opened that path for writing, up to
   15 minutes earlier.** A write through a symlink or hard link, a write-temp-
   then-rename (how editors and `sed -i` save), and `truncate` were all
   credited to a different, earlier step, two of them as `confirmed`.
   Cause: `engine.look` takes `box.writers[path]` (kept `WRITER_LIFE` = 900 s,
   keyed by the path as written) before the rename's actor. *Medium.*
4. **A failed exec is recorded as `exec_syscall_return` with errno 0**, the
   same as a success, and never reaches the host or dashboard. ENOENT and
   EACCES both. *Small* once the right field is found; needs a look at what
   gVisor sends on that exit.
5. **A connection to the sandbox's own address is labelled
   `refused_by_policy`** although it returned HTTP 200: the label comes from
   the address range, not the result. *Small.*
6. **Changes that cancel out inside the settle window read as "the file is as
   it was".** A `.env` created, rewritten and deleted in one process, and a
   file changed and restored, both show only `opened_for_writing / possible`.
   Inherent to before/after comparison; the wording could say so. *Small* (wording) or *large* (capture writes).
7. **A forked child that never execs has no process row on the host** (clone
   and exit are in the VM only), and the shell `docker exec` starts has no exec
   event. *Small to medium.*
8. Out of scope by design and confirmed so: loopback connections (all three
   mock-HTTP tests), `sendto` without `connect`, Unix sockets, files outside
   the project or under `node_modules`, SQL statements.
9. Minor: two processes got two exit events at shutdown; unattributed facts
   for the same path and effect merge into one row with a count (two deletes
   ten minutes apart read as one); DNS lookups name no process; a new list
   takes up to a second to load; dashboard history health is always `unknown`.

Held up: process exec/exit with codes and signals, 300-process and 5,000-open
bursts with zero drops, every collector row present on the host and in the
dashboard API, shutdown (last recorded hash equals the file on disk), restart.
