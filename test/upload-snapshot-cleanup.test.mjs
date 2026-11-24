import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const failure of ['open', 'copy']) {
  test(`snapshotEvidences removes its temporary directory when the database ${failure} fails`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'raytrace-snapshot-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const database = join(dir, 'evidence.db');
    if (failure === 'open') await mkdir(database);
    else await writeFile(database, 'not a SQLite database');

    // A separate process gives the snapshot its own temp root, independent of
    // other tests, while exercising the real SQLite open and VACUUM failures.
    const script = `
      import assert from 'node:assert/strict';
      import { snapshotEvidences } from ${JSON.stringify(new URL('../src/upload.mjs', import.meta.url).href)};
      assert.throws(() => snapshotEvidences(${JSON.stringify(database)}), { code: 'ERR_SQLITE_ERROR' });
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir },
      encoding: 'utf8', timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readdir(dir), ['evidence.db']);
    if (failure === 'copy') assert.equal(await readFile(database, 'utf8'), 'not a SQLite database');
  });
}
