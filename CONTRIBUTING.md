# Contributing to RayTrace

Thanks for wanting to help. This guide is how to set up a checkout, run the
tests, and open a pull request. The product itself — local and cloud sandboxes,
the MCP server, and the dashboard — is described in the [README](README.md).

## What you need

- **Node.js 22.13 or newer** (`node --version`) and npm
- **Git**
- For trying a **local sandbox** from your checkout: macOS 13.5 or later, or
  Linux with Lima, QEMU, and access to `/dev/kvm`. Windows is experimental;
  RayTrace doesn't download Lima there. `raytrace doctor` (or
  `node bin/raytrace.mjs doctor`) checks what's missing.

## Set up

```sh
git clone https://github.com/Godcreatebugs/raytrace-cli.git
cd raytrace-cli
npm install
npm run build                     # dashboard -> dist/dashboard
npm run typecheck
npm test
node bin/raytrace.mjs <command>   # run the CLI from this folder
```

To use your checkout as the MCP server in Claude Code:

```sh
claude mcp add --scope user raytrace -- node /path/to/raytrace-cli/bin/raytrace.mjs mcp
```

To try it without touching your real setup, give it its own home and port:

```sh
mkdir -p /tmp/rt && echo RAYTACE_PORT=18797 > /tmp/rt/config.env
RAYTRACE_HOME=/tmp/rt node bin/raytrace.mjs setup --no-claude-code
```

`npm run dashboard:dev` runs the dashboard with hot reload, using the API from
a running RayTrace.

Before you open a pull request, run:

```sh
npm test
npm run typecheck
npm run build
```

## Project layout

```
raytrace-cli/
├── bin/raytrace.mjs      # CLI entry
├── src/                  # CLI: sandbox, MCP, auth, Lima, report, upload
├── proxy/                # recording, evidence store, playground, traces
├── worker/sandbox/       # gVisor sandbox image, collector, Lima config
├── dashboard/            # local dashboard (Vite and React)
├── python/               # PyPI wrapper and wheel build
├── test/                 # CLI tests (`npm test` also runs proxy/*.test.mjs)
└── docs/                 # guides and screenshots
```

## Where help is needed

These are real gaps, already named in the README. If an issue for the one you
want isn't open yet, open one first and say you'd like to take it.

- **Windows.** Local sandboxes are experimental; Lima isn't downloaded on
  Windows. Honest docs and collected failure reports would help, and so would
  making first-run work there.
- **Codex prompts.** In local sandboxes, Codex's prompts don't reach the
  dashboard's Prompts page yet. Commands, file changes and network connections
  are already recorded.
- **First-run of the local VM.** The first `raytrace sandbox create --local`
  sets up a Lima VM and can take a few minutes. Clearer status and recovery
  when that gets stuck would help a lot of first-time users.
- **Docs.** A short demo GIF for the README, and anything in `docs/` that is
  unclear after you try the product yourself.

Look at [Issues](https://github.com/Godcreatebugs/raytrace-cli/issues) for
`good first issue` and `help wanted`. If you want to do something that isn't
listed, open an issue before a large pull request.

## Pull requests

1. Fork the repo and create a branch from `main`, named for what it does
   (`fix/codex-prompts-page`, `docs/windows-setup`).
2. Keep the change focused on one concern. Follow the style of the surrounding
   code. The CLI and proxy are JavaScript (`.mjs`); the dashboard is TypeScript
   and React.
3. Add or update tests when you change behavior. CLI tests live in `test/`,
   proxy tests next to the files they cover in `proxy/`.
4. Run `npm test`, `npm run typecheck`, and `npm run build`.
5. Open a pull request that says what changed and why, and links the issue.
   Screenshots help for dashboard changes.

## Reporting bugs and proposing features

For a bug, include your OS, `node --version`, the command or MCP prompt you
ran, what you expected, what happened, and any output from `raytrace doctor`
or logs under `~/.raytrace/logs/` (redact secrets). For a feature, say what
problem it solves and how you think it should work.

## Releasing (maintainers)

Each release goes to npm (`@raytrace-cli/cli`) and PyPI (`raytrace-cli`) at
the same version. The pip package is the npm package plus an official Node.js
build, one wheel per platform. PyPI does not allow the name `raytrace`.

Every PR merged into `main` automatically increments the patch version,
creates a release commit and tag, creates a GitHub Release, and publishes npm.
Before merging, use one optional PR label to override the default:

| Label | Increment |
|---|---|
| no label or `release:patch` | `0.13.0` → `0.13.1` |
| `release:minor` | `0.13.0` → `0.14.0` |
| `release:major` | `0.13.0` → `1.0.0` |
| `release:skip` | no version change or publishing |

Only one release label is allowed; conflicting or unknown release labels fail
without creating a release. Add labels before merging. The workflow queues
merged PRs instead of cancelling earlier queued releases (up to GitHub's
100-run queue limit). Rerunning the same merged-PR workflow reuses its release
commit and tag. The version commit is pushed as a tag only, never to main, so
`package.json` on main does not change; the next version counts from the
highest `vX.Y.Z` tag. Releases use the latest main when their queued run
starts, so they can include other already merged PRs.

The merge run only makes the tag and the GitHub Release. It then starts a
second, dispatched run of the same workflow to publish: npm's trusted
publishing refuses a run started by a pull request event.

`npm-publish.yml` checks the
tag against `package.json`, runs typechecking and tests, builds the dashboard
through `prepack`, and publishes to npm. It uses the `npm` GitHub environment
and npm trusted publishing (OIDC), with no npm token secret. The package's
`repository.url` must match `Godcreatebugs/raytrace-cli` for provenance.

The npm trusted publisher must specify owner `Godcreatebugs`, repository
`raytrace-cli`, workflow `npm-publish.yml`, environment `npm`, and allow
`npm publish`. A newly configured publisher must complete its first actual
publish within two days; otherwise recreate the expired connection on npm.

For a retry, run **Publish npm package** from the Actions tab and enter the
existing release tag. Already published versions are skipped, including
`v0.13.0`; registry errors fail the job instead of attempting a publish.
Prereleases are excluded from automatic publishing. Already published Releases
are not triggered retroactively. To retry a failed automatic release, rerun
its merged-PR workflow; to retry publishing an existing tag, use the manual
publish action. Bot-created tags explicitly dispatch the pip wheels build,
because GitHub does not trigger tag workflows for GITHUB_TOKEN pushes.
PyPI uploading remains manual. Merging the automation PR itself produces a
patch release unless that PR has `release:skip`.

Then build the same version's pip wheels and upload them:

```sh
python3 python/build_wheels.py    # all six platforms, into python/dist/
twine upload python/dist/*.whl
```

The *pip wheels* workflow builds the same wheels on every `v*` tag and installs
them on Linux, macOS and Windows (x64 and ARM); its `wheels` artifact can be
uploaded instead (`gh run download <run-id> -n wheels`). The Node.js version
is `NODE_VERSION` in `python/build_wheels.py`. Run `twine upload` in a real
terminal, since it asks for the PyPI token (username `__token__`); `--verbose`
shows why PyPI refuses an upload. A version can only be uploaded once, and the
PyPI page's description (`python/README.md`) only changes with a new version.

## License

By contributing, you agree that your contributions are licensed under the MIT
License, the same as the rest of the project. See [LICENSE](LICENSE).
