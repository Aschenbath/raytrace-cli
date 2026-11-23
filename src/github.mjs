// The git connector, from the CLI's side: a cloud sandbox with GitHub
// repositories attached clones, fetches and pushes them through RayTrace,
// which opens them with the organization's RayTrace GitHub App; no GitHub
// key is ever in the sandbox. An org admin installs the App and connects it
// on the account page first.
//
// githubRepo, workBranch and connectScript are the SDKs' (sdk/ts/src/client.mjs,
// sdk/python): the CLI package ships without them, so they are repeated here,
// and test/github.test.mjs checks the script is still the same.
import { spawnSync } from 'node:child_process';

export const ACCOUNT_URL = 'https://raytracer.si/account.html';

// GitHub's rules for account and repository names (RayTrace's API checks the same).
const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const GITHUB_URL = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)?([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i;

/** `owner/name` for a GitHub repository given as owner/name or a github.com https or ssh URL; null for anything else. */
export function githubRepo(repo) {
  const name = GITHUB_URL.exec(String(repo ?? '').trim())?.[1];
  if (!name || !GITHUB_NAME.test(name) || ['.', '..'].includes(name.split('/')[1])) return null;
  return name;
}

/** The branch a connected sandbox works on. Its agent may push only to raytrace/<these 8 characters>/... */
export function workBranch(sandboxId) {
  return `raytrace/${String(sandboxId).slice(4, 12)}/work`;
}

/** The branches a sandbox's agent may push to. */
export const pushPrefix = (sandboxId) => `raytrace/${String(sandboxId).slice(4, 12)}/`;

const GIT_REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const GIT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** The shell commands that make a sandbox's uploaded files a clone of `repo` on its work branch (see the SDKs' connectScript). */
export function connectScript({ repo, sandboxId, ref = undefined, commit = undefined, dir = '/workspace' }) {
  const name = githubRepo(repo);
  if (!name) throw new Error(`Not a GitHub repository: ${repo} (use owner/name)`);
  if (ref !== undefined && !GIT_REF.test(String(ref))) throw new Error(`Not a branch or tag name: ${ref}`);
  if (commit !== undefined && !GIT_COMMIT.test(String(commit))) throw new Error(`Not a commit id: ${commit}`);
  const fallback = quote(ref ?? 'HEAD');
  const branch = workBranch(sandboxId);
  return [
    'set -e',
    `cd ${quote(dir)}`,
    `if [ -e .git ]; then echo "RayTrace: $(pwd) is already a Git repository; left as it is." >&2; exit 0; fi`,
    'git -c init.defaultBranch=main init -q',
    `git remote add origin ${quote(`https://github.com/${name}.git`)}`,
    commit ? `git fetch -q --depth 1 origin ${commit} 2>/dev/null || git fetch -q --depth 1 origin ${fallback}`
      : `git fetch -q --depth 1 origin ${fallback}`,
    'git reset -q FETCH_HEAD',
    'if [ -n "$(git ls-files --deleted)" ]; then git ls-files -z --deleted | git checkout -q --pathspec-from-file=- --pathspec-file-nul; fi',
    `git checkout -q -b ${quote(branch)}`,
    `echo ${quote(`Connected to ${name} on branch ${branch}. Push with: git push -u origin ${branch}`)}`,
  ].join('\n');
}

const git = (root, ...args) => {
  const done = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return done.status === 0 ? done.stdout.trim() : null;
};

/**
 * What the repository at `root` says about connecting a sandbox made from it:
 * `repo`, its origin's owner/name when that is GitHub (else null); `commit`,
 * what it has checked out, which the sandbox lines up with when GitHub has it;
 * and `ref`, the branch it is on, only when origin has that branch too (as
 * this machine last saw it), else the sandbox falls back to GitHub's default branch.
 */
export function localRepo(root) {
  const repo = githubRepo(git(root, 'remote', 'get-url', 'origin'));
  const commit = git(root, 'rev-parse', '--verify', '-q', 'HEAD^{commit}');
  const branch = git(root, 'symbolic-ref', '--short', '-q', 'HEAD');
  const onOrigin = branch && GIT_REF.test(branch) && git(root, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`) !== null;
  return { repo, commit: GIT_COMMIT.test(commit ?? '') ? commit : undefined, ref: onOrigin ? branch : undefined };
}
