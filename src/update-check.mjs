// A one-line notice, on every command run at a terminal, while a newer
// RayTrace is published than the one running:
//
//   RayTrace 0.19.0 is available (you have 0.18.0). Update: npm install -g @raytrace-cli/cli@latest
//
// No command waits for it. What the registry last said is kept in the
// RayTrace home (update-check.json); when that is older than a day, a
// detached process asks the registry again for next time. The notice goes to
// stderr, so piped output is untouched, and never shows for the Claude Code
// hook, the MCP server, CI, a run that is not at a terminal, a checkout of the
// repository, or with RAYTRACE_NO_UPDATE_CHECK=1.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './paths.mjs';

export const PACKAGE = '@raytrace-cli/cli';
export const REGISTRY = `https://registry.npmjs.org/${PACKAGE}/latest`;
const CACHE = 'update-check.json';
const DAY_MS = 24 * 60 * 60 * 1000;

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
/** Whether stable version `a` is newer than `b`; false for anything that is not x.y.z. */
export function newer(a, b) {
  const [x, y] = [STABLE.exec(String(a)), STABLE.exec(String(b))];
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  return false;
}

/** How this copy was installed, by where it runs from: npm, pip, npx, or a source checkout. */
export function installKind(root) {
  const where = String(root).replace(/\\/g, '/');
  if (existsSync(join(root, '.git'))) return 'checkout';
  if (where.includes('/_npx/')) return 'npx';
  if (/\/(site|dist)-packages\/raytrace\/app\/?$/.test(where)) return 'pip';
  return 'npm';
}

export const updateCommand = (kind) => ({
  npm: `npm install -g ${PACKAGE}@latest`,
  pip: 'pip install --upgrade raytrace-cli',
  npx: `npx ${PACKAGE}@latest`,
})[kind];

export const notice = (latest, current, kind) =>
  `RayTrace ${latest} is available (you have ${current}). Update: ${updateCommand(kind)}`;

function readCache(home) {
  try { return JSON.parse(readFileSync(join(home, CACHE), 'utf8')); } catch { return {}; }
}

/** Whether this run should say anything at all. */
export function quiet(command, env, stderr) {
  const off = (value) => value === '1' || value === 'true';
  return ['hook', 'mcp'].includes(command) || off(env.RAYTRACE_NO_UPDATE_CHECK)
    || (typeof env.CI === 'string' && env.CI !== '') || !stderr?.isTTY;
}

/**
 * Prints the notice when the cached latest version is newer than this one,
 * and starts a background refresh when the cache is a day old. Returns the
 * line printed, or null. Never throws. `deps` is for tests.
 */
export function checkForUpdate(command, deps = {}) {
  try {
    const env = deps.env ?? process.env;
    const stderr = deps.stderr ?? process.stderr;
    const root = deps.root ?? paths.root;
    const home = deps.home ?? paths.home;
    const now = deps.now ?? Date.now();
    if (quiet(command, env, stderr)) return null;
    const kind = installKind(root);
    if (kind === 'checkout') return null;
    const current = deps.current ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    const cache = readCache(home);
    if (!(cache.checked_at > now - DAY_MS)) (deps.refresh ?? refreshInBackground)(home);
    if (!newer(cache.latest, current)) return null;
    const line = notice(cache.latest, current, kind);
    (deps.log ?? ((text) => stderr.write(`${text}\n`)))(line);
    return line;
  } catch {
    return null;
  }
}

/** Asks the registry in a detached process, which outlives this command and writes the cache. */
function refreshInBackground(home) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--refresh', home], {
    detached: true, stdio: 'ignore', env: { ...process.env, RAYTRACE_NO_UPDATE_CHECK: '1' },
  });
  child.unref();
}

/** The registry's latest version, written to the cache with the time asked; the time is written on failure too. */
export async function refresh(home, fetcher = fetch) {
  let latest = readCache(home).latest ?? null;
  try {
    const response = await fetcher(REGISTRY, { signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
    if (response.ok) {
      const version = (await response.json())?.version;
      if (STABLE.test(String(version))) latest = version;
    }
  } catch { /* offline: ask again tomorrow */ }
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, CACHE), `${JSON.stringify({ checked_at: Date.now(), latest })}\n`);
  return latest;
}

if (process.argv[2] === '--refresh' && process.argv[1] === fileURLToPath(import.meta.url)) {
  await refresh(process.argv[3]);
}
