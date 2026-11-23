# RayTrace SDKs

Client libraries for RayTrace cloud sandboxes over the [`/v1` API](../docs/v1-contract.md):

| Language | Folder | Install | Import |
| --- | --- | --- | --- |
| TypeScript / JavaScript | [`ts/`](ts/) | `npm install @raytrace-cli/sdk` | `import RayTrace from '@raytrace-cli/sdk'` |
| Python | [`python/`](python/) | `pip install raytrace-sdk` | `from raytrace_sdk import RayTrace` |

The SDKs are versioned and released apart from the CLI (`@raytrace-cli/cli`, `raytrace-cli`). Both SDKs always share one version number.

## Tests

```sh
cd sdk/ts && npm test
cd sdk/python && python3 -m pytest -q tests
```

## Releasing

Automatic. When a pull request that changes `sdk/` merges into `main`, [`sdk-publish.yml`](../.github/workflows/sdk-publish.yml):

1. takes the next version after the highest `sdk-vX.Y.Z` tag: a patch by default, or a minor or major with the `release:minor` / `release:major` label (`release:skip` releases nothing), the same labels the CLI uses;
2. writes it into `sdk/ts/package.json`, `sdk/python/pyproject.toml` and the Python `User-Agent`, in a commit reachable only from the new `sdk-v` tag (as with the CLI, `main` keeps its versions, which only act as a floor);
3. creates the GitHub release, runs both test suites, and publishes to npm and PyPI with trusted publishing. No token or login is needed, and a version a registry already has is skipped.

A pull request that changes only the SDKs does not release the CLI. To publish a tag again, run *Publish SDKs* from the Actions tab with that `sdk-v` tag.

### One-time registry setup

- **PyPI:** on pypi.org, *Your account → Publishing → Add a new pending publisher*: project `raytrace-sdk`, owner `Godcreatebugs`, repository `raytrace-cli`, workflow `sdk-publish.yml`, environment `pypi`. The first release creates the project.
- **npm:** on npmjs.com, *@raytrace-cli/sdk → Settings → Trusted publisher*: GitHub Actions, `Godcreatebugs/raytrace-cli`, workflow `sdk-publish.yml`, environment `npm`, allowed action publish.
