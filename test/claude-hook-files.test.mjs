// File tools: the hook refuses a change to a file the owner restricted, never
// a read (Read joined the PreToolUse matcher only so the hook can announce the
// call to the recorder; the file lock on the host decides reads).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'worker', 'sandbox', 'claude-hook.mjs');
const dir = mkdtempSync(join(tmpdir(), 'raytrace-hook-files-'));
const hookPath = join(dir, 'claude-hook.mjs');
copyFileSync(source, hookPath);
writeFileSync(join(dir, 'guardrails.json'), JSON.stringify({ restricted: ['config/keys.js'], watched: [], blocked: [] }));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const AMBIENT = ['CI', 'GITHUB_ACTIONS', 'HEADLESS', 'RAYTRACE_HEADLESS', 'RAYTRACE_ALLOW_ALL'];
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !AMBIENT.includes(name)));

/** The hook's answer before a file tool: its decision, or null when it says nothing (the tool goes ahead). */
function before(tool, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], { env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`hook exited ${code}`));
      try { resolve(out.trim() ? JSON.parse(out).hookSpecificOutput : null); } catch { reject(new Error(`Unexpected hook output: ${out}`)); }
    });
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_use_id: 'toolu_files_1',
      tool_input: { file_path: file }, cwd: '/workspace', permission_mode: 'bypassPermissions' }));
  });
}

for (const tool of ['Write', 'Edit', 'MultiEdit']) {
  test(`refuses ${tool} of a restricted file`, async () => {
    const answer = await before(tool, '/workspace/config/keys.js');
    assert.equal(answer?.permissionDecision, 'deny');
    assert.match(answer.permissionDecisionReason, /config\/keys\.js is restricted by this project's owner/);
  });
}

test('never refuses Read, even of a restricted file', async () => {
  assert.equal(await before('Read', '/workspace/config/keys.js'), null);
});

test('says nothing before a tool on a file that is not restricted', async () => {
  assert.equal(await before('Write', '/workspace/src/app.js'), null);
  assert.equal(await before('Read', '/workspace/src/app.js'), null);
});
