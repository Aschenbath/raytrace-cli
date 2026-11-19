import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeStarPrompt, STAR_LINE, STAR_URL } from '../src/star.mjs';
import { setup } from '../src/commands.mjs';

const tty = { isTTY: true };
const notty = { isTTY: false };
const interactive = { env: {}, stdout: tty, stdin: tty };

function homeDir() {
  return mkdtempSync(join(tmpdir(), 'raytrace-star-'));
}

function calls(home, flags = {}, extra = {}) {
  const lines = [];
  const shown = maybeStarPrompt(flags, {
    ...interactive,
    home,
    log: (line) => lines.push(line),
    ...extra,
  });
  return { shown, lines, flag: existsSync(join(home, 'star-prompted')) };
}

describe('star prompt', { concurrency: false }, () => {
  test('the line is one short sentence and names the repo', () => {
    assert.equal(STAR_LINE.includes('\n'), false);
    assert.equal(STAR_LINE.includes(STAR_URL), true);
    assert.equal(STAR_URL, 'https://github.com/Godcreatebugs/raytrace-cli');
  });

  test('shows once on an interactive terminal, then stays quiet', () => {
    const home = homeDir();
    try {
      const first = calls(home);
      assert.equal(first.shown, true);
      assert.deepEqual(first.lines, [STAR_LINE]);
      assert.equal(first.flag, true);
      assert.equal(readFileSync(join(home, 'star-prompted'), 'utf8'), '1\n');

      const second = calls(home);
      assert.equal(second.shown, false);
      assert.deepEqual(second.lines, []);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('RAYTRACE_NO_STAR_PROMPT=1 prints nothing and does not use up the one show', () => {
    const home = homeDir();
    try {
      const skipped = calls(home, {}, { env: { RAYTRACE_NO_STAR_PROMPT: '1' } });
      assert.equal(skipped.shown, false);
      assert.deepEqual(skipped.lines, []);
      assert.equal(skipped.flag, false);

      const later = calls(home);
      assert.equal(later.shown, true);
      assert.deepEqual(later.lines, [STAR_LINE]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('RAYTRACE_NO_STAR_PROMPT=true is the same opt-out', () => {
    const home = homeDir();
    try {
      const skipped = calls(home, {}, { env: { RAYTRACE_NO_STAR_PROMPT: 'true' } });
      assert.equal(skipped.shown, false);
      assert.equal(skipped.flag, false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a set CI variable prints nothing and does not use up the one show', () => {
    const home = homeDir();
    try {
      for (const CI of ['true', '1', 'false']) {
        const skipped = calls(home, {}, { env: { CI } });
        assert.equal(skipped.shown, false, CI);
        assert.equal(skipped.flag, false, CI);
      }
      const later = calls(home);
      assert.equal(later.shown, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('no TTY on stdout or stdin prints nothing and does not use up the one show', () => {
    const home = homeDir();
    try {
      const stdout = calls(home, {}, { stdout: notty, stdin: tty });
      const stdin = calls(home, {}, { stdout: tty, stdin: notty });
      assert.equal(stdout.shown, false);
      assert.equal(stdin.shown, false);
      assert.equal(stdout.flag, false);
      assert.equal(stdin.flag, false);
      assert.equal(calls(home).shown, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('json and quiet output prints nothing and does not use up the one show', () => {
    const home = homeDir();
    try {
      for (const flags of [{ json: true }, { quiet: true }, { silent: true }, { format: 'json' }, { format: 'JSON' }]) {
        const skipped = calls(home, flags);
        assert.equal(skipped.shown, false, JSON.stringify(flags));
        assert.deepEqual(skipped.lines, [], JSON.stringify(flags));
        assert.equal(skipped.flag, false, JSON.stringify(flags));
      }
      assert.equal(calls(home).shown, true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('a flag that cannot be saved does not throw or print', () => {
    const dir = homeDir();
    const home = join(dir, 'not-a-directory');
    try {
      writeFileSync(home, 'occupied');
      const lines = [];
      const shown = maybeStarPrompt({}, { ...interactive, home, log: (line) => lines.push(line) });
      assert.equal(shown, false);
      assert.deepEqual(lines, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('star prompt during setup', { concurrency: false }, () => {
  const previous = {};

  function setTTY(value) {
    Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  }

  async function withHome(fn) {
    const home = mkdtempSync(join(tmpdir(), 'raytrace-star-setup-'));
    const claude = mkdtempSync(join(tmpdir(), 'raytrace-star-claude-'));
    previous.home = process.env.RAYTRACE_HOME;
    previous.claude = process.env.CLAUDE_CONFIG_DIR;
    previous.ci = process.env.CI;
    previous.noStar = process.env.RAYTRACE_NO_STAR_PROMPT;
    previous.log = console.log;
    previous.stdout = process.stdout.isTTY;
    previous.stdin = process.stdin.isTTY;
    process.env.RAYTRACE_HOME = home;
    process.env.CLAUDE_CONFIG_DIR = claude;
    delete process.env.CI;
    delete process.env.RAYTRACE_NO_STAR_PROMPT;
    writeFileSync(join(home, 'config.env'), 'RAYTACE_PORT=1\n');
    const lines = [];
    console.log = (line = '') => lines.push(String(line));
    try {
      return await fn({ home, lines });
    } finally {
      console.log = previous.log;
      if (previous.stdout === undefined) delete process.stdout.isTTY;
      else Object.defineProperty(process.stdout, 'isTTY', { value: previous.stdout, configurable: true });
      if (previous.stdin === undefined) delete process.stdin.isTTY;
      else Object.defineProperty(process.stdin, 'isTTY', { value: previous.stdin, configurable: true });
      if (previous.home === undefined) delete process.env.RAYTRACE_HOME;
      else process.env.RAYTRACE_HOME = previous.home;
      if (previous.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous.claude;
      if (previous.ci === undefined) delete process.env.CI;
      else process.env.CI = previous.ci;
      if (previous.noStar === undefined) delete process.env.RAYTRACE_NO_STAR_PROMPT;
      else process.env.RAYTRACE_NO_STAR_PROMPT = previous.noStar;
      rmSync(home, { recursive: true, force: true });
      rmSync(claude, { recursive: true, force: true });
    }
  }

  const flags = { yes: true, 'no-claude-code': true, 'no-start': true };

  test('the first successful setup prints the line once, and the next setup does not', async () => {
    await withHome(async ({ home, lines }) => {
      setTTY(true);
      await setup(flags);
      const shown = lines.filter((line) => line === STAR_LINE);
      assert.deepEqual(shown, [STAR_LINE]);
      assert.equal(lines.at(-1), STAR_LINE);
      assert.equal(existsSync(join(home, 'star-prompted')), true);
      assert.equal(readFileSync(join(home, 'config.env'), 'utf8').includes(STAR_URL), false);

      lines.length = 0;
      await setup(flags);
      assert.equal(lines.some((line) => line.includes(STAR_URL)), false);
    });
  });

  test('setup in CI, without a TTY, or with quiet output does not print or record the ask', async () => {
    await withHome(async ({ home, lines }) => {
      setTTY(true);
      process.env.CI = 'true';
      await setup(flags);
      assert.equal(lines.some((line) => line.includes(STAR_URL)), false);
      assert.equal(existsSync(join(home, 'star-prompted')), false);

      delete process.env.CI;
      setTTY(false);
      lines.length = 0;
      await setup(flags);
      assert.equal(lines.some((line) => line.includes(STAR_URL)), false);
      assert.equal(existsSync(join(home, 'star-prompted')), false);

      setTTY(true);
      lines.length = 0;
      await setup({ ...flags, quiet: true });
      assert.equal(lines.some((line) => line.includes(STAR_URL)), false);
      assert.equal(existsSync(join(home, 'star-prompted')), false);

      lines.length = 0;
      await setup(flags);
      assert.equal(lines.filter((line) => line === STAR_LINE).length, 1);
    });
  });

  test('a setup that fails does not record the ask', async () => {
    await withHome(async ({ home, lines }) => {
      setTTY(true);
      await assert.rejects(() => setup({ ...flags, 'openrouter-key': "'\"`\nINJECTED=secret-not-to-log" }));
      assert.equal(lines.some((line) => line.includes(STAR_URL)), false);
      assert.equal(existsSync(join(home, 'star-prompted')), false);
    });
  });
});
