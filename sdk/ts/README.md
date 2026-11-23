# @raytrace-cli/sdk

Create and drive [RayTrace](https://raytracer.si) cloud sandboxes from code. Every coding-agent session in a sandbox is recorded to your organization's dashboard.

```sh
npm install @raytrace-cli/sdk
```

Node.js 20 or newer. No dependencies.

## Authenticate

Create an org API key on your RayTrace account page (**Account → API keys**) and set it in the environment:

```sh
export RAYTRACE_API_KEY=rtk_...
```

Or pass it directly: `new RayTrace({ apiKey: 'rtk_...' })`.

## Quickstart

```js
import RayTrace from '@raytrace-cli/sdk';

const rt = new RayTrace();

// Upload a project folder (.git, .env, keys and credentials are left out).
const sandbox = await rt.sandboxes.create({ name: 'my-app', dir: '.', size: 'small' });

const result = await sandbox.exec('npm test', { timeoutSeconds: 300 });
console.log(result.exitCode, result.stdout);

await sandbox.stop();
```

## Sandboxes

| Call | What it does |
| --- | --- |
| `rt.sandboxes.create({ name, size, dir \| files \| archive })` | New sandbox from a folder, an in-memory file map, or a `.tar.gz` |
| `rt.sandboxes.list()` / `rt.sandboxes.get(id)` | Your organization's sandboxes |
| `sandbox.exec(command, { timeoutSeconds })` | Runs a command and waits for `{ exitCode, stdout, stderr, state }` |
| `sandbox.stop()` | Stops it; files are kept and billing stops |
| `sandbox.start({ size })` | Starts it again, restoring an archived sandbox first |
| `sandbox.keepAlive(minutes)` | Holds off the idle stop for a long-running job (up to 4 hours) |
| `sandbox.destroy({ keepTraces })` | Deletes it; `keepTraces: true` keeps its recordings on paid plans |
| `sandbox.status`, `sandbox.size` | From the last fetch |

Sizes are `small`, `medium` and `large`.

## Usage and keys

```js
await rt.usage.get({ days: 30 });   // credits spent and remaining
await rt.apiKeys.create('ci');      // the key is returned once
await rt.apiKeys.list();
await rt.apiKeys.revoke(id);
```

## Billing and errors

Running sandboxes are paid from prepaid credits in 15-minute blocks, and stop by themselves after 15 minutes of no activity. Failed calls throw `RayTraceError` with `status` and `code`:

| `code` | Meaning |
| --- | --- |
| `insufficient_balance` | Not enough credit for the next 15 minutes; top up on the account page |
| `recording_plan_required` | Cloud sandboxes need an Individual or Team plan |
| `no_capacity` | No room right now; retry shortly |

The full HTTP contract is in [`docs/v1-contract.md`](https://github.com/Godcreatebugs/raytrace-cli/blob/main/docs/v1-contract.md).
