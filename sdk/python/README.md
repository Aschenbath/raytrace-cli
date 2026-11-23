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
| `rt.sandboxes.list()` / `rt.sandboxes.get(id)` | Your organization's sandboxes |
| `sandbox.exec(command, timeout_seconds=)` | Runs a command and waits for the result (`exit_code`, `stdout`, `stderr`, `state`) |
| `sandbox.stop()` | Stops it; files are kept and billing stops |
| `sandbox.start(size=)` | Starts it again, restoring an archived sandbox first |
| `sandbox.keep_alive(minutes)` | Holds off the idle stop for a long-running job (up to 4 hours) |
| `sandbox.destroy(keep_traces=)` | Deletes it; `keep_traces=True` keeps its recordings on paid plans |
| `sandbox.status`, `sandbox.size` | From the last fetch |

Sizes are `small`, `medium` and `large`.

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
