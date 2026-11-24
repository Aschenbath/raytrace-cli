import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('SDK client subpath types describe its own runtime exports', () => {
  const fixture = fileURLToPath(new URL('../sdk/ts/test/fixtures/client-types.mts', import.meta.url));
  const program = ts.createProgram([fixture], {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: ['node'],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});
