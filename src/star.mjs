// One line after the first successful `raytrace setup`. It never asks a
// question or opens a browser. A file in the RayTrace home (next to
// config.env) remembers that this machine already saw it. A run that is not
// a person at a terminal does not print it and does not write that file, so
// the next real setup still can.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.mjs';

export const STAR_URL = 'https://github.com/Godcreatebugs/raytrace-cli';
export const STAR_LINE = `If RayTrace is useful to you, a star on the repo helps other developers find it: ${STAR_URL}`;
const FLAG = 'star-prompted';

function optedOut(env) {
  const value = env.RAYTRACE_NO_STAR_PROMPT;
  return value === '1' || value === 'true';
}

// Any non-empty CI value counts, including "false": the variable being set is
// the signal that this run is not a person sitting at the setup output.
function ciSet(env) {
  return typeof env.CI === 'string' && env.CI !== '';
}

function machineReadable(flags) {
  if (!flags) return false;
  if (flags.json || flags.quiet || flags.silent) return true;
  return String(flags.format || '').toLowerCase() === 'json';
}

function suppressed(flags, env, stdout, stdin) {
  if (optedOut(env)) return true;
  if (ciSet(env)) return true;
  if (!stdout?.isTTY || !stdin?.isTTY) return true;
  return machineReadable(flags);
}

/**
 * Print the star line when this machine has not seen it and this run is an
 * interactive terminal. Returns whether it printed. `deps` is for tests.
 */
export function maybeStarPrompt(flags = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const stdin = deps.stdin ?? process.stdin;
  const log = deps.log ?? ((line) => console.log(line));
  const home = deps.home ?? paths.home;
  if (suppressed(flags, env, stdout, stdin)) return false;
  const flag = join(home, FLAG);
  if (existsSync(flag)) return false;
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(flag, '1\n', { flag: 'wx' });
  } catch {
    // Setup must not fail, or ask again on every run, because the flag could
    // not be saved. Skip the line instead.
    return false;
  }
  log(STAR_LINE);
  return true;
}
