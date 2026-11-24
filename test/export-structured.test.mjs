import test from 'node:test';
import assert from 'node:assert/strict';
import { splitExchange } from '../proxy/trace-view.mjs';
import { formatTraceMarkdown } from '../src/export.mjs';

test('Markdown exports serialize structured tool input and output', () => {
  const input = { file_path: 'README.md', note: 'contains ``` inside' };
  const output = [{ type: 'text', text: 'Read the file' }];
  const events = splitExchange({
    span_id: 'exchange-1',
    timestamp: '2026-11-01T12:00:00Z',
    request: { payload: { input: [{ type: 'function_call_output', call_id: 'call-1', output }] } },
    response: { status: 200, payload: { content: [{ type: 'tool_use', id: 'call-2', name: 'Read', input }] } },
  });
  const markdown = formatTraceMarkdown({ id: 'trace-1', events });
  assert.ok(markdown.includes(JSON.stringify(input, null, 2)));
  assert.ok(markdown.includes(JSON.stringify(output, null, 2)));
  assert.ok(markdown.includes('````json\n'));
  assert.doesNotMatch(markdown, /\[object Object\]/);
});

test('Markdown exports leave string tool payloads unchanged', () => {
  const input = '{"command":"npm test"}';
  const output = 'All tests passed\n';
  const trace = { id: 'trace-1', events: [
    { title: 'Tool call', raw: JSON.stringify({ arguments: input }) },
    { title: 'Tool result', raw: JSON.stringify({ output }) },
  ] };
  const markdown = formatTraceMarkdown(trace);
  assert.ok(markdown.includes(`\n${input}\n`));
  assert.ok(markdown.includes(`\n${output}\n`));
});
