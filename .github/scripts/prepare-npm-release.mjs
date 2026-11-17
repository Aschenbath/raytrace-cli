import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function releaseBump(labels) {
  const selected = [...new Set(labels.filter(name => name.startsWith('release:')))];
  const allowed = new Set(['release:patch', 'release:minor', 'release:major', 'release:skip']);
  if (selected.some(name => !allowed.has(name)) || selected.length > 1) {
    throw new Error('Use at most one release label: release:patch, release:minor, release:major, or release:skip.');
  }
  return selected[0]?.slice('release:'.length) || 'patch';
}

const STABLE = /^v?(\d+)\.(\d+)\.(\d+)$/;
const parts = (version) => STABLE.exec(version).slice(1).map(Number);
const newer = (a, b) => { const [x, y] = [parts(a), parts(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };

/** The version after `version`, by a patch, minor or major step. */
export function nextVersion(version, bump) {
  const [major, minor, patch] = parts(version);
  return bump === 'major' ? `${major + 1}.0.0` : bump === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

// A release is a tag and nothing else. The version commit sits on top of main
// and is reachable only from its tag: main takes changes through pull requests
// alone (the "Protect main" ruleset), so nothing here pushes to it. The
// released version is therefore the highest vX.Y.Z tag, not package.json on
// main, which keeps whatever version it last had and is only a floor.
//
// Runs only in the disposable Actions checkout, never in a developer's worktree.
export function prepareRelease({ cwd, prNumber, bump }) {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1 || !['patch', 'minor', 'major'].includes(bump)) {
    throw new Error('Invalid PR number or release increment.');
  }
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  for (let attempt = 0; attempt < 3; attempt++) {
    git('fetch', 'origin', 'main', '--tags', '--force');
    git('checkout', '--detach', '--force', 'origin/main');
    const tags = git('tag', '--list', 'v*').split('\n').filter((tag) => STABLE.test(tag));
    // A rerun for the same PR publishes the release already made for it.
    for (const tag of tags) {
      const commit = git('rev-parse', `${tag}^{}`);
      if (!new RegExp(`^Release-PR: #${prNumber}$`, 'm').test(git('log', '-1', '--format=%B', commit))) continue;
      if (`v${JSON.parse(git('show', `${commit}:package.json`)).version}` !== tag) throw new Error('Existing release tag does not match its commit.');
      return { tag, reused: true };
    }
    const pkg = JSON.parse(readFileSync(`${cwd}/package.json`, 'utf8'));
    if (pkg.name !== '@raytrace-cli/cli' || !STABLE.test(pkg.version)) {
      throw new Error('Expected a stable RayTrace CLI package.');
    }
    const latest = [pkg.version, ...tags.map((tag) => tag.slice(1))].sort(newer).at(-1);
    const version = nextVersion(latest, bump);
    const tag = `v${version}`;
    execFileSync('npm', ['version', version, '--no-git-tag-version', '--ignore-scripts', '--allow-same-version'], { cwd, stdio: 'inherit' });
    git('add', 'package.json', 'package-lock.json');
    git('commit', '-m', `Release ${version}`, '-m', `Release-PR: #${prNumber}`);
    git('tag', '-a', tag, '-m', version);
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
  if (!pr?.merged || pr.base?.ref !== 'main') throw new Error('Only a PR merged into main can prepare a release.');
  const bump = releaseBump(pr.labels.map(label => label.name));
  if (bump === 'skip') {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `PR #${pr.number}: release skipped by label.\n`);
  } else {
    const result = prepareRelease({ cwd: process.cwd(), prNumber: pr.number, bump });
    appendFileSync(process.env.GITHUB_OUTPUT, `tag=${result.tag}\n`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `PR #${pr.number}: ${result.reused ? 'reusing' : 'created'} ${result.tag} (${bump}).\n`);
  }
}
