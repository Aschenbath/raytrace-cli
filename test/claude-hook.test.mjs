import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), '../worker/sandbox/claude-hook.mjs');

// Only RAYTRACE_ALLOW_ALL relaxes the hook's permission prompts; the rest are cleared so no test depends on where it
// runs, and the CI/headless ones are set on purpose to prove they change nothing.
const AMBIENT = ['CI', 'GITHUB_ACTIONS', 'HEADLESS', 'RAYTRACE_HEADLESS', 'RAYTRACE_ALLOW_ALL'];
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !AMBIENT.includes(name)));

function runHook(env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], {
      env: { ...baseEnv, ...env }
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`Failed to parse hook output: ${out} (err: ${err})`));
      }
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

test('PreToolUse defaults to ask when permission_mode is not bypassPermissions', async () => {
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'call_test_1',
    tool_input: { command: 'echo hello' },
    permission_mode: 'ask'
  };
  const res = await runHook({}, input);
  assert.equal(res.hookSpecificOutput?.permissionDecision, 'ask');
  assert.equal(res.hookSpecificOutput?.updatedInput?.command, 'export RAYTRACE_CALL_ID=call_test_1\necho hello');
});

test('PreToolUse allows commands when RAYTRACE_ALLOW_ALL=1', async () => {
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'call_test_2',
    tool_input: { command: 'pytest' },
    permission_mode: 'ask'
  };
  const res = await runHook({ RAYTRACE_ALLOW_ALL: '1' }, input);
  assert.equal(res.hookSpecificOutput?.permissionDecision, 'allow');
  assert.equal(res.hookSpecificOutput?.updatedInput?.command, 'export RAYTRACE_CALL_ID=call_test_2\npytest');
});

test('PreToolUse allows commands when permission_mode is bypassPermissions', async () => {
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'call_test_3',
    tool_input: { command: 'npm test' },
    permission_mode: 'bypassPermissions'
  };
  const res = await runHook({}, input);
  assert.equal(res.hookSpecificOutput?.permissionDecision, 'allow');
});

test('PreToolUse still asks in CI, GitHub Actions or generic headless environments', async () => {
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'call_test_ci',
    tool_input: { command: 'cargo test' },
    permission_mode: 'ask'
  };
  // Ambient variables a CI runner or a wrapper script sets on its own must never turn the prompts off.
  for (const env of [{ CI: 'true' }, { CI: '1' }, { GITHUB_ACTIONS: 'true' }, { HEADLESS: '1' }, { RAYTRACE_HEADLESS: '1' }]) {
    const res = await runHook(env, input);
    assert.equal(res.hookSpecificOutput?.permissionDecision, 'ask', JSON.stringify(env));
  }
});

test('PreToolUse accepts RAYTRACE_ALLOW_ALL=true as well as 1', async () => {
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'call_test_allow_true',
    tool_input: { command: 'cargo test' },
    permission_mode: 'ask'
  };
  const res = await runHook({ RAYTRACE_ALLOW_ALL: 'true' }, input);
  assert.equal(res.hookSpecificOutput?.permissionDecision, 'allow');
});
