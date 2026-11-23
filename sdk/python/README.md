# raytrace-sdk

Create and drive [RayTrace](https://raytracer.si) cloud sandboxes from Python. Every coding-agent session in a sandbox is recorded to your organization's dashboard.

```sh
pip install raytrace-sdk
```

Python 3.10 or newer. No dependencies.

## Authenticate

Create an org API key on your RayTrace account page (**Account → API keys**) and set it in the environment:

```sh
export RAYTRACE_API_KEY=rtk_...
```

Or pass it directly: `RayTrace(api_key="rtk_...")`.

## Quickstart

```python
from raytrace_sdk import RayTrace

rt = RayTrace()

# Upload a project folder (.git, .env, keys and credentials are left out).
sandbox = rt.sandboxes.create(name="my-app", directory=".", size="small")

result = sandbox.exec("pytest", timeout_seconds=300)
print(result.exit_code, result.stdout)

sandbox.stop()
```

## Sandboxes

| Call | What it does |
| --- | --- |
| `rt.sandboxes.create(name=, size=, directory= \| files= \| archive=)` | New sandbox from a folder, an in-memory file map, or `.tar.gz` bytes |
| `rt.sandboxes.create(repo=, ref=)` | New sandbox from a Git repository: an https or ssh URL, or `owner/name` on GitHub; `ref` picks a branch or tag. Cloned with this machine's `git` and credentials |
| `rt.sandboxes.list()` / `rt.sandboxes.get(id)` | Your organization's sandboxes |
| `sandbox.exec(command, timeout_seconds=)` | Runs a command and waits for the result (`exit_code`, `stdout`, `stderr`, `state`) |
| `sandbox.stop()` | Stops it; files are kept and billing stops |
| `sandbox.start(size=)` | Starts it again, restoring an archived sandbox first |
| `sandbox.keep_alive(minutes)` | Holds off the idle stop for a long-running job (up to 4 hours) |
| `sandbox.destroy(keep_traces=)` | Deletes it; `keep_traces=True` keeps its recordings on paid plans |
| `sandbox.status`, `sandbox.size` | From the last fetch |

Sizes are `small`, `medium` and `large`.

## Connect GitHub

A sandbox can clone, fetch and push a GitHub repository without any GitHub
key inside it: its git goes through RayTrace, which opens the repositories
attached to it with your organization's RayTrace GitHub App. First, an org
admin installs the App on the repositories and connects it on the
[account page](https://raytracer.si/account.html).

```python
sandbox = rt.sandboxes.create(repo='acme/app', connect=True)
sandbox.git   # {'repo': 'acme/app', 'branch': 'raytrace/1a2b3c4d/work', ...}
sandbox.exec('git commit -am "Fix" && git push -u origin HEAD')
```

| Call | What it does |
| --- | --- |
| `rt.sandboxes.create(repo=, connect=True)` | Uploads, then attaches `repo` and makes `/workspace` a clone of it on its work branch. With `directory=` or `files=`, those are uploaded and `repo` is what it is connected to |
| `sandbox.connect_repo(repo, ref=, commit=)` | The same for a sandbox that exists |
| `sandbox.repos.list()` / `sandbox.repos.set([...])` | The repositories its git may open; `set` replaces the list, `[]` takes them all off |

An agent in the sandbox pushes only to branches under `raytrace/<8 characters
of the sandbox id>/`; anything else, including `main`, is refused, and no branch
can be deleted. Every clone, fetch and push is recorded with the sandbox's evidence.
If connecting fails, the sandbox was still created: the `RayTraceError` says so
and carries it as `error.sandbox`.

## Usage and keys

```python
rt.usage.get(days=30)        # credits spent and remaining
rt.api_keys.create("ci")     # the key is returned once
rt.api_keys.list()
rt.api_keys.revoke(key_id)
```

## Billing and errors

Running sandboxes are paid from prepaid credits in 15-minute blocks, and stop by themselves after 15 minutes of no activity. Failed calls raise `RayTraceError` with `status` and `code`:

| `code` | Meaning |
| --- | --- |
| `insufficient_balance` | Not enough credit for the next 15 minutes; top up on the account page |
| `recording_plan_required` | Cloud sandboxes need an Individual or Team plan |
| `no_capacity` | No room right now; retry shortly |

The full HTTP contract is in [`docs/v1-contract.md`](https://github.com/Godcreatebugs/raytrace-cli/blob/main/docs/v1-contract.md).
