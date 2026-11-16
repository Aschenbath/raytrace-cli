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

// Runs only in the disposable Actions checkout, never in a developer's worktree.
export function prepareRelease({ cwd, prNumber, bump }) {
  if (!Number.isSafeInteger(prNumber) || prNumber < 1 || !['patch', 'minor', 'major'].includes(bump)) {
    throw new Error('Invalid PR number or release increment.');
  }
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  for (let attempt = 0; attempt < 3; attempt++) {
    git('fetch', 'origin', 'main', '--tags');
    git('reset', '--hard', 'origin/main');
    const previous = git('log', '--format=%H', '--max-count=1', `--grep=^Release-PR: #${prNumber}$`);
    if (previous) {
      const version = JSON.parse(git('show', `${previous}:package.json`)).version;
      const tag = `v${version}`;
      if (git('rev-parse', `${tag}^{}`) !== previous) throw new Error('Existing release tag does not match its commit.');
      return { tag, reused: true };
    }
    const base = git('rev-parse', 'HEAD');
    const pkg = JSON.parse(readFileSync(`${cwd}/package.json`, 'utf8'));
    if (pkg.name !== '@raytrace-cli/cli' || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
      throw new Error('Expected a stable RayTrace CLI package.');
    }
    execFileSync('npm', ['version', bump, '--no-git-tag-version', '--ignore-scripts'], { cwd, stdio: 'inherit' });
    const version = JSON.parse(readFileSync(`${cwd}/package.json`, 'utf8')).version;
    const tag = `v${version}`;
    git('add', 'package.json', 'package-lock.json');
    git('commit', '-m', `Release ${version}`, '-m', `Release-PR: #${prNumber}`);
    git('tag', '-a', tag, '-m', version);
    try {
      git('push', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${tag}`);
      return { tag, reused: false };
    } catch (error) {
      // Retry only if main advanced while we prepared this commit. Atomic push
      // ensures a failed branch update cannot leave an orphaned release tag.
      git('tag', '-d', tag);
      git('fetch', 'origin', 'main');
      if (git('rev-parse', 'origin/main') === base || attempt === 2) throw error;
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
