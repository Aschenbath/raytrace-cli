# Sandbox core API

`worker/sandbox/` is the sandbox core: everything that runs on a sandbox host to
run gVisor sandboxes and record them. The local adapter (`projects.py`, driven by
`raytrace sandbox ... --local` in a Lima VM) is one user. Other host layers can
import it as a library and add their own actions.

The core **applies** what it is given: limits, an image, hooks, files. It never
**decides** them. It knows nothing about accounts, plans, quotas or how a host is
reached.

## Versions

| Constant | Where | Covers |
|---|---|---|
| `CORE_API` | `core/__init__.py` | The functions below: arguments, results, errors and side effects. |
| `EVIDENCE_SCHEMA` | `core/__init__.py` | What the recorder hands on: collector events, the fact engine's facts, `syscall_catalog.sql`. |
| `version()` | `core/__init__.py` | The package version: from `package.json`, or the `VERSION` file that `setup.py` writes beside an installed copy. |

Raise a constant when a consumer would notice the change. The two are separate:
compatible evidence does not mean compatible functions, and the reverse is also
true. **v1 is the behaviour as of this file's introduction, written down.**

## `core.mechanics` (`CORE_API` 1)

Sandbox ids are `rtp-<32 hex>` (project) and `rtf-<32 hex>` (Playground fork).
Unless noted, a function raises `ValueError` on bad input and
`subprocess.CalledProcessError` when Docker fails.

### Configuration
- `Limits(cpus='2', memory='2g', pids=256, tmp='512m')`: what a sandbox may use.
  It validates strictly; `.args()` gives the `docker create` flags.
  `DEFAULT_LIMITS` holds today's values.
- `image()`: the image used when the caller names none. In order:
  1. the active release's `image`;
  2. `/etc/raytace/image`;
  3. `raytace-gvisor-agent`.
- `bridge()`: the bridge URL sandboxes are given, as `RAYTRACE_BROKER`.
- `container_args(name, labels, limits=None, image_name=None)`: the one container
  configuration used for projects and forks. It sets:
  - the `raytace-gvisor` runtime and the `raytace-egress` network;
  - no capabilities, `no-new-privileges`, and user 1000;
  - the two volumes and the host resolver;
  - the session environment.
- `create_container(name, labels, limits=None, image_name=None)`: makes the
  volumes and the container, without starting it. Returns the container id.

### Lifecycle
- `preflight()`: the collector and resolver must be running, otherwise
  `SystemExit`. It then runs `network.py`.
- `create(sid, archive, limits=None, expect_release=None)`: creates a project
  sandbox from a staged `/tmp/<sid>.tar.gz` and returns its container id.
  - With `expect_release`, it holds `core.release.lock(shared=True)` from the
    check until the container exists.
  - It raises `SystemExit` if the active release is a different one, before
    creating anything.
  - The container is made from the release's image and labelled
    `io.raytace.release=<id>`.
- `stage_archive(sid)`: writes the archive from stdin to `/tmp/<sid>.tar.gz`
  (up to 300 MiB).
- `validate_archive(path)`: accepts only regular files with relative paths,
  256 MiB in total.
- `start(sid)`: starts the sandbox so it is recorded, and is safe on a running
  sandbox. In order:
  1. `preflight()`.
  2. If the sandbox started before the collector did, restart it.
  3. Lock its restricted files while it is stopped.
  4. Put back its hook and lists from the host's copies.
  5. Call `remember()`.
- `shell(sid, agent=None)`: an interactive bash in a started sandbox, optionally
  starting `claude` or `codex` first. Returns its exit code.
- `stop(sid)`.
- `delete(sid, forget_evidence=False)`: the sandbox must be stopped. Removes:
  - the container;
  - its two volumes, but only ones labelled as its own;
  - the host's copies of its hook and guardrails;
  - with `forget_evidence`, the collector's records of it.

  It then calls every function registered with `register_delete_cleanup(fn)`,
  as `fn(sid)`.
- `listing()`: every managed container, as
  `{id, container_id, status, created, persistent_volumes, size_bytes, fork_of, release, image}`.
- `remember(name)`: tells the fact engine which container is which sandbox.
- `predates_collector(state)`.

### Inside the sandbox
- `install_claude_hooks(container, hook)`: installs, owned by root:
  - the hook script;
  - Claude Code's managed settings;
  - Codex's managed config.
- `enable_claude(sid, hook)`: does the same, and keeps the host's copy that
  `start()` puts back.
- `set_token(sid, token)`: writes `~/.raytace/sandbox-token`, the credential the
  hook (`claude-hook.mjs`) sends transcripts with.
- `write_home_files(sid, [(folder, name, bytes)])`: writes files into
  `/home/node/<folder>/<name>`, owned by the agent user (folders 0700, files 0600).
- `write_as_root(container, path, bytes)`, `as_node(container, *command, data=None, check=True)`.

### Files, forks, snapshots, evidence
- `guardrails(sid, state, restricted=None, watched=None, blocked=None)` and
  `set_guardrails(sid, state, request)`: restricted, watched and blocked lists.
  Returns `{hook, read_only, restricted, watched, missing}`.
- `fork_action(action, fork, forget=False, credentials=None)`: handles
  `fork-create | fork-run | fork-check | fork-collect | fork-stop | fork-delete`.
  - `credentials` is the caller's policy for copying the parent's sign-ins into
    a fork: a function of the request.
  - When it is `None`, sign-ins are copied unless the request says
    `credentials: false`.
- `snapshot_read(project)` and `read_snapshot(project, running)`.
- `evidence(container, forget=False)` and
  `activity(container, since_ms=0, until_ms=0)`.

### Command line
`main(extra_actions=None, fork_credentials=None, argv=None)` is
`projects.py <action> [id] [--archive] [--confirm] [--release] [--since] [--until] [--forget-evidence] [--agent]`.

- `extra_actions` maps a name to `fn(opts, state)`. `state` is the sandbox's
  `docker inspect`, or `None` when the action has no id.
- `version` prints `{core, core_api, evidence_schema, release, image}`, read from
  what is installed.

## `core.release` (`CORE_API` 1)

A release is the directory `/opt/raytace/releases/<id>/` holding an immutable
`release.json`, with at least `{"id": <id>, "image": <tag>}`. The symlink
`/opt/raytace/current` is the only record of which release is active. A host
without it, such as a local VM, has no releases.

- `lock(shared=False)`: an `flock` on `/run/raytace/release.lock`.
- `active()`: the active release's manifest, or `None`.
- `point(target)`: switches the symlink in one rename, and returns the release
  that was active before.
- `activate(target, restart, check)`: holds the exclusive lock, switches, then
  runs `restart()` and `check()`.
  - If either fails, it switches back, runs `restart()` again and re-raises the
    error.
  - If there was no previous release, it removes the symlink instead.

## Host setup (`setup.py`)

The steps run in this order, and each can run on its own:
`install → network → services → image → activate`. Pass `--root` for where the
core runs from: `/opt/raytace` locally, `/opt/raytace/current` behind releases.

`image` builds with exact `CLAUDE_CODE_VERSION` and `CODEX_VERSION`. These are
either given, or the tested ones in `agents.json`. It then checks
`claude --version` and `codex --version` in the image.

`activate` restarts the services in this order: resolver, collector, viewer.
It then checks:
- the collector's socket exists;
- the resolver answers on the gateway.

## Files the core owns on a host

- **The core writes:**
  - `/etc/raytace/gvisor.json`, `resolv.conf`, `upstream-dns`, `bridge`,
    `bridge-upstream`, `image` and `viewer-token`;
  - the `raytace-collector`, `raytace-viewer` and `raytace-dns` units;
  - `/var/lib/raytace/*`;
  - `--root`.
- **The core only reads** `/etc/raytace/bridge-front`. It holds the port of a
  front before the bridge on the gateway, written by a host layer that runs
  one. Sandboxes are then pointed at the front, and both addresses count as
  RayTrace's own.
- **Anything else under `/etc/raytace/`** belongs to the layer that wrote it.
  The core never overwrites it.
