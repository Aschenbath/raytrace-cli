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

1. Bump `version` in **both** `sdk/ts/package.json` and `sdk/python/pyproject.toml` (and the `User-Agent` version in `sdk/python/raytrace_sdk/client.py`), through a pull request labelled `release:skip` so the CLI is not released with it.
2. After it merges, create a GitHub release on `main` with the tag `sdk-vX.Y.Z` matching that version.
3. [`sdk-publish.yml`](../.github/workflows/sdk-publish.yml) runs the tests and publishes both packages with trusted publishing. No token or login is needed. A version a registry already has is skipped, so re-running is safe.

### One-time registry setup

- **PyPI:** on pypi.org, *Your account → Publishing → Add a new pending publisher*: project `raytrace-sdk`, owner `Godcreatebugs`, repository `raytrace-cli`, workflow `sdk-publish.yml`, environment `pypi`. The first release creates the project.
- **npm:** a trusted publisher can only be added to a package that exists, so publish 0.1.0 once by hand (`npm login`, then `cd sdk/ts && npm publish --access public`). Then, on npmjs.com, *@raytrace-cli/sdk → Settings → Trusted publisher*: GitHub Actions, `Godcreatebugs/raytrace-cli`, workflow `sdk-publish.yml`, environment `npm`. Every later version publishes from the workflow.
