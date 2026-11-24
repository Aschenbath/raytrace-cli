import test from 'node:test';
import assert from 'node:assert/strict';
import { splitExchange } from '../proxy/trace-view.mjs';
import { formatTraceJson, formatTraceMarkdown } from '../src/export.mjs';

test('trace exports retain the timestamps produced by the trace view', () => {
  const started = '2026-11-01T12:00:00.000Z';
  const completed = '2026-11-01T12:00:02.000Z';
  const events = splitExchange({
    span_id: 'exchange-1',
    timestamp: started,
    completed_at: completed,
    request: { payload: { model: 'test', input: [] } },
    response: { status: 200, payload: { output: [{ type: 'message', content: 'Done' }] } },
  });
  const trace = { id: 'trace-1', events };
  const json = JSON.parse(formatTraceJson(trace));
  assert.deepEqual(json.trace.events.map(event => event.timestamp), [started, completed, completed]);
  const markdown = formatTraceMarkdown(trace);
  assert.ok(markdown.includes(`**Timestamp:** ${started}`));
  assert.ok(markdown.includes(`**Timestamp:** ${completed}`));
  assert.doesNotMatch(markdown, /\*\*Timestamp:\*\* unknown/);
});

test('trace exports continue accepting an explicitly supplied timestamp', () => {
  const timestamp = '2026-11-01T12:00:00.000Z';
  const trace = { id: 'trace-1', events: [{ kind: 'model', title: 'Manual event', timestamp }] };
  assert.equal(JSON.parse(formatTraceJson(trace)).trace.events[0].timestamp, timestamp);
  assert.ok(formatTraceMarkdown(trace).includes(`**Timestamp:** ${timestamp}`));
});
