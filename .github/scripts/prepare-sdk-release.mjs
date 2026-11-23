import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { nextVersion, releaseBump } from './prepare-npm-release.mjs';

// The SDK counterpart of prepare-npm-release.mjs: a PR merged into main that
// changes sdk/ gets the next sdk-vX.Y.Z tag. As for the CLI, the release is a
// tag and nothing else: the version commit sits on top of main and is
// reachable only from its tag, so the released version is the highest sdk-v
// tag, and the versions in sdk/ on main are only a floor.
//
// Runs only in the disposable Actions checkout, never in a developer's worktree.

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
const parts = (version) => STABLE.exec(version).slice(1).map(Number);
const newer = (a, b) => { const [x, y] = [parts(a), parts(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };

const TS_PACKAGE = 'sdk/ts/package.json';
const PY_PROJECT = 'sdk/python/pyproject.toml';
const PY_CLIENT = 'sdk/python/raytrace_sdk/client.py';

/** Writes `version` into both SDKs: the npm package, the Python project and its User-Agent. */
export function setSdkVersion(cwd, version) {
  const pkg = JSON.parse(readFileSync(`${cwd}/${TS_PACKAGE}`, 'utf8'));
  pkg.version = version;
  writeFileSync(`${cwd}/${TS_PACKAGE}`, `${JSON.stringify(pkg, null, 2)}\n`);
  const replaceOnce = (file, pattern, replacement) => {
    const text = readFileSync(`${cwd}/${file}`, 'utf8');
    if ((text.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`)) || []).length !== 1) {
      throw new Error(`Expected exactly one version to replace in ${file}.`);
    }
    writeFileSync(`${cwd}/${file}`, text.replace(pattern, replacement));
  };
  replaceOnce(PY_PROJECT, /^version = "[^"]*"$/m, `version = "${version}"`);
  replaceOnce(PY_CLIENT, /raytrace-python-sdk\/[0-9][^'"]*/, `raytrace-python-sdk/${version}`);
}

export function prepareSdkRelease({ cwd, prNumber, bump }) {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1 || !['patch', 'minor', 'major'].includes(bump)) {
    throw new Error('Invalid PR number or release increment.');
  }
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  for (let attempt = 0; attempt < 3; attempt++) {
    git('fetch', 'origin', 'main', '--tags', '--force');
    git('checkout', '--detach', '--force', 'origin/main');
    const tags = git('tag', '--list', 'sdk-v*').split('\n').map((tag) => tag.slice('sdk-v'.length)).filter((v) => STABLE.test(v));
    // A rerun for the same PR publishes the release already made for it.
    for (const version of tags) {
      const tag = `sdk-v${version}`;
      const commit = git('rev-parse', `${tag}^{}`);
      if (!new RegExp(`^Release-PR: #${prNumber}$`, 'm').test(git('log', '-1', '--format=%B', commit))) continue;
      if (JSON.parse(git('show', `${commit}:${TS_PACKAGE}`)).version !== version) throw new Error('Existing SDK tag does not match its commit.');
      return { tag, reused: true };
    }
    const pkg = JSON.parse(readFileSync(`${cwd}/${TS_PACKAGE}`, 'utf8'));
    if (pkg.name !== '@raytrace-cli/sdk' || !STABLE.test(pkg.version)) throw new Error('Expected a stable @raytrace-cli/sdk package.');
    const latest = [pkg.version, ...tags].sort(newer).at(-1);
    const version = nextVersion(latest, bump);
    const tag = `sdk-v${version}`;
    setSdkVersion(cwd, version);
    git('add', TS_PACKAGE, PY_PROJECT, PY_CLIENT);
    git('commit', '-m', `Release SDK ${version}`, '-m', `Release-PR: #${prNumber}`);
    git('tag', '-a', tag, '-m', `SDK ${version}`);
    try {
      git('push', 'origin', `refs/tags/${tag}`);
      return { tag, reused: false };
    } catch (error) {
      // Another release took this version first: read the tags again and take the next.
      git('tag', '-d', tag);
      if (attempt === 2) throw error;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  if (!pr?.merged || pr.base?.ref !== 'main') throw new Error('Only a PR merged into main can prepare an SDK release.');
  const bump = releaseBump(pr.labels.map(label => label.name));
  if (bump === 'skip') {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `PR #${pr.number}: SDK release skipped by label.\n`);
  } else {
    const result = prepareSdkRelease({ cwd: process.cwd(), prNumber: pr.number, bump });
    appendFileSync(process.env.GITHUB_OUTPUT, `tag=${result.tag}\n`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `PR #${pr.number}: ${result.reused ? 'reusing' : 'created'} ${result.tag} (${bump}).\n`);
  }
}
