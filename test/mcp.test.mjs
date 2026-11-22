import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/raytrace.mjs', import.meta.url));

function startMcp(env = {}) {
  const child = spawn(process.execPath, [BIN, 'mcp'], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const responses = [];
  const waiters = [];

  lines.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (waiters.length) waiters.shift()(msg);
      else responses.push(msg);
    } catch {}
  });

  const send = (msg) => {
    child.stdin.write(JSON.stringify(msg) + '\n');
    return new Promise((resolve) => {
      if (responses.length) resolve(responses.shift());
      else waiters.push(resolve);
    });
  };

  const close = () => {
    child.stdin.end();
    child.kill();
  };

  return { child, send, close };
}

test('MCP: initialize negotiates protocol and returns server metadata', async (t) => {
  const mcp = startMcp();
  t.after(() => mcp.close());

  const res = await mcp.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test-editor', version: '1.0' },
    },
  });

  assert.equal(res.jsonrpc, '2.0');
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, '2025-11-25');
  assert.equal(res.result.serverInfo.name, 'raytrace');
  assert.match(res.result.serverInfo.version, /^\d+\.\d+\.\d+$/);
  assert.equal(res.result.capabilities.tools.listChanged, false);
  assert.match(res.result.instructions, /cloud sandboxes/i);
});

test('MCP: ping responds with empty result', async (t) => {
  const mcp = startMcp();
  t.after(() => mcp.close());

  const res = await mcp.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.equal(res.jsonrpc, '2.0');
  assert.equal(res.id, 2);
  assert.deepEqual(res.result, {});
});

test('MCP: tools/list returns standard cloud sandbox tools', async (t) => {
  const mcp = startMcp();
  t.after(() => mcp.close());

  const res = await mcp.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(res.id, 3);
  const tools = res.result.tools;
  assert.ok(Array.isArray(tools));
  assert.equal(tools.length, 11);

  const names = tools.map((t) => t.name);
  assert.deepEqual(names.sort(), [
    'cancel_command',
    'connect_sandbox',
    'create_sandbox',
    'destroy_sandbox',
    'get_command_result',
    'list_sandboxes',
    'login',
    'run_command',
    'sandbox_status',
    'start_sandbox',
    'stop_sandbox',
  ]);

  const create = tools.find((t) => t.name === 'create_sandbox');
  assert.equal(create.annotations.readOnlyHint, false);
  assert.equal(create.inputSchema.properties.path.type, 'string');

  const destroy = tools.find((t) => t.name === 'destroy_sandbox');
  assert.equal(destroy.annotations.destructiveHint, true);
  assert.deepEqual(destroy.inputSchema.required, ['id']);
});

test('MCP: handles unknown methods and unknown tools gracefully', async (t) => {
  const mcp = startMcp();
  t.after(() => mcp.close());

  const badMethod = await mcp.send({ jsonrpc: '2.0', id: 4, method: 'unsupported/method' });
  assert.equal(badMethod.id, 4);
  assert.equal(badMethod.error.code, -32601);
  assert.match(badMethod.error.message, /Method not found/);

  const badTool = await mcp.send({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'fictional_tool', arguments: {} },
  });
  assert.equal(badTool.id, 5);
  assert.equal(badTool.error.code, -32602);
  assert.match(badTool.error.message, /Unknown tool/);
});

test('MCP: login tool honors RAYTRACE_API_KEY environment override', async (t) => {
  const mcp = startMcp({ RAYTRACE_API_KEY: 'test-key-override' });
  t.after(() => mcp.close());

  const res = await mcp.send({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'login', arguments: {} },
  });
  assert.equal(res.id, 6);
  assert.ok(res.result.content);
  assert.match(res.result.content[0].text, /RAYTRACE_API_KEY/);
});

test('MCP: tools/call rejects unauthorized sandbox_status with tool error', async (t) => {
  const mcp = startMcp({ RAYTRACE_API_KEY: 'invalid-token-test' });
  t.after(() => mcp.close());

  const res = await mcp.send({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'sandbox_status', arguments: { id: 'invalid-id-format' } },
  });
  assert.equal(res.id, 7);
  assert.equal(res.result.isError, true);
  assert.ok(res.result.content[0].text.length > 0);
});

// Argument checks run before any handler, so none of these need a sign-in or a VM.
const callTool = (mcp, id, name, args) => mcp.send({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: args === undefined ? { name } : { name, arguments: args },
});

test('MCP: a string where a boolean is expected is refused, not treated as true', async (t) => {
  const mcp = startMcp();
  t.after(() => mcp.close());

  const res = await callTool(mcp, 8, 'destroy_sandbox', { id: 'some-sandbox', delete_logs: 'false' });
  assert.equal(res.id, 8);
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /delete_logs must be true or false\./);
});

test('MCP: null or missing arguments count as none', async (t) => {
  const mcp = startMcp({ RAYTRACE_API_KEY: 'test-key-override' });
  t.after(() => mcp.close());

  // login takes no arguments, so null and left out both run it.
  const nulled = await callTool(mcp, 9, 'login', null);
  assert.notEqual(nulled.result.isError, true);
  assert.match(nulled.result.content[0].text, /RAYTRACE_API_KEY/);
  const left = await callTool(mcp, 10, 'login');
  assert.notEqual(left.result.isError, true);

  // A tool with required arguments says which one is missing instead of throwing.
  const missing = await callTool(mcp, 11, 'sandbox_status', null);
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /id is required\./);
  assert.doesNotMatch(missing.result.content[0].text, /destructure/);
});

test('MCP: arguments that are not an object are refused', async (t) => {
  const mcp = startMcp();
  t.after(() => mcp.close());

  const res = await callTool(mcp, 12, 'sandbox_status', 'x');
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /arguments must be an object\./);
});

test('MCP: an unknown argument is refused when the schema is closed', async (t) => {
  const mcp = startMcp({ RAYTRACE_API_KEY: 'test-key-override' });
  t.after(() => mcp.close());

  const res = await callTool(mcp, 13, 'login', { extra: 1 });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /extra is not an argument of login\. It takes no arguments\./);

  const withProps = await callTool(mcp, 14, 'stop_sandbox', { id: 'some-sandbox', force: true });
  assert.equal(withProps.result.isError, true);
  assert.match(withProps.result.content[0].text, /force is not an argument of stop_sandbox\. It accepts: id\./);
});

test('MCP: a missing required argument is named', async (t) => {
  const mcp = startMcp();
  t.after(() => mcp.close());

  const res = await callTool(mcp, 15, 'stop_sandbox', {});
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /id is required\./);
});

test('MCP: integers outside their range, or not whole, are refused', async (t) => {
  const mcp = startMcp();
  t.after(() => mcp.close());
  const id = `rtp-${'a'.repeat(32)}`;

  const high = await callTool(mcp, 16, 'run_command', { id, command: 'ls', timeout_seconds: 5000 });
  assert.equal(high.result.isError, true);
  assert.match(high.result.content[0].text, /timeout_seconds must be a whole number from 1 to 1800\./);

  const fraction = await callTool(mcp, 17, 'run_command', { id, command: 'ls', timeout_seconds: 1.5 });
  assert.match(fraction.result.content[0].text, /timeout_seconds must be a whole number\./);

  const wait = await callTool(mcp, 18, 'get_command_result', { id, command_id: `cmd-${'b'.repeat(32)}`, wait_seconds: -1 });
  assert.match(wait.result.content[0].text, /wait_seconds must be a whole number from 0 to 30\./);
});

test('MCP: strings and enums are checked against their schema', async (t) => {
  const mcp = startMcp();
  t.after(() => mcp.close());

  const empty = await callTool(mcp, 19, 'sandbox_status', { id: '' });
  assert.match(empty.result.content[0].text, /id must be at least 1 character long\./);

  const tooLong = await callTool(mcp, 28, 'sandbox_status', { id: 'a'.repeat(65) });
  assert.match(tooLong.result.content[0].text, /id must be at most 64 characters long\./);

  const notString = await callTool(mcp, 20, 'sandbox_status', { id: 7 });
  assert.match(notString.result.content[0].text, /id must be a string\./);

  const badId = await callTool(mcp, 21, 'run_command', { id: 'nope', command: 'ls' });
  assert.match(badId.result.content[0].text, /id is not in the expected format/);

  const badAgent = await callTool(mcp, 22, 'connect_sandbox', { id: 'some-sandbox', agent: 'gemini' });
  assert.match(badAgent.result.content[0].text, /agent must be one of: claude, codex, none\./);
});

test('MCP: every problem is reported at once', async (t) => {
  const mcp = startMcp();
  t.after(() => mcp.close());

  const res = await callTool(mcp, 23, 'destroy_sandbox', { keep_traces: 'yes', delete_logs: 1 });
  const message = res.result.content[0].text;
  assert.match(message, /id is required\./);
  assert.match(message, /keep_traces must be true or false\./);
  assert.match(message, /delete_logs must be true or false\./);
});

test('MCP: tools/call without a tool name is an invalid-params error', async (t) => {
  const mcp = startMcp();
  t.after(() => mcp.close());

  const noParams = await mcp.send({ jsonrpc: '2.0', id: 24, method: 'tools/call' });
  assert.equal(noParams.error.code, -32602);
  assert.equal(noParams.error.message, 'Missing tool name');

  const noName = await mcp.send({ jsonrpc: '2.0', id: 25, method: 'tools/call', params: {} });
  assert.equal(noName.error.code, -32602);
  assert.equal(noName.error.message, 'Missing tool name');

  const wrongType = await mcp.send({ jsonrpc: '2.0', id: 26, method: 'tools/call', params: { name: 7 } });
  assert.equal(wrongType.error.code, -32602);

  // Names that only exist on Object.prototype are not tools.
  const inherited = await mcp.send({ jsonrpc: '2.0', id: 27, method: 'tools/call', params: { name: 'constructor' } });
  assert.equal(inherited.error.code, -32602);
  assert.match(inherited.error.message, /Unknown tool/);
});

// validateArguments in src/mcp.mjs only understands part of JSON Schema and skips any keyword it
// does not know, so a schema that used more (an array, a nested object, oneOf, format, ...) would
// go unchecked without anyone noticing. This guard fails first and says what to teach the validator.
const TOP_LEVEL_KEYWORDS = ['type', 'properties', 'required', 'additionalProperties', 'description'];
const PROPERTY_KEYWORDS = {
  string: ['enum', 'pattern', 'minLength', 'maxLength'],
  integer: ['enum', 'minimum', 'maximum'],
  boolean: ['enum'],
};

function unsupportedSchemaUses({ name, inputSchema: schema }) {
  const problems = [];
  const unsupported = (where, what) => problems.push(
    `${name}${where} uses ${what}, which validateArguments in src/mcp.mjs does not check. Teach it, then update this test.`,
  );

  for (const keyword of Object.keys(schema)) {
    if (!TOP_LEVEL_KEYWORDS.includes(keyword)) unsupported('', `the keyword "${keyword}"`);
  }
  if (schema.type !== 'object') unsupported('', `a top-level type of ${JSON.stringify(schema.type)}`);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    unsupported('', 'a schema for additionalProperties');
  }

  for (const [field, property] of Object.entries(schema.properties ?? {})) {
    const allowed = PROPERTY_KEYWORDS[property.type];
    if (!allowed) {
      unsupported(`.${field}`, `the type ${JSON.stringify(property.type)}`);
      continue;
    }
    for (const keyword of Object.keys(property)) {
      if (!['type', 'description', ...allowed].includes(keyword)) {
        unsupported(`.${field}`, `the keyword "${keyword}" on the ${property.type} property`);
      }
    }
  }
  return problems;
}

test('MCP: every tool schema only uses keywords the argument validator checks', async (t) => {
  const mcp = startMcp();
  t.after(() => mcp.close());

  const res = await mcp.send({ jsonrpc: '2.0', id: 29, method: 'tools/list' });
  assert.ok(res.result.tools.length > 0);
  assert.deepEqual(res.result.tools.flatMap(unsupportedSchemaUses), []);
});

test('MCP: the schema keyword guard catches what the validator cannot check', () => {
  const problems = unsupportedSchemaUses({
    name: 'demo',
    inputSchema: {
      type: 'object',
      oneOf: [],
      additionalProperties: { type: 'string' },
      properties: {
        list: { type: 'array', items: { type: 'string' } },
        nested: { type: 'object', properties: {} },
        label: { type: 'string', format: 'uri', minimum: 1 },
        size: { type: 'integer', maxLength: 3 },
        fine: { type: 'string', description: 'ok', pattern: '^a$', minLength: 1, maxLength: 4 },
      },
    },
  });
  const all = problems.join('\n');
  assert.equal(problems.length, 7);
  assert.match(all, /demo uses the keyword "oneOf"/);
  assert.match(all, /demo uses a schema for additionalProperties/);
  assert.match(all, /demo\.list uses the type "array"/);
  assert.match(all, /demo\.nested uses the type "object"/);
  assert.match(all, /demo\.label uses the keyword "format" on the string property/);
  assert.match(all, /demo\.label uses the keyword "minimum" on the string property/);
  assert.match(all, /demo\.size uses the keyword "maxLength" on the integer property/);
  assert.doesNotMatch(all, /demo\.fine/);
});
