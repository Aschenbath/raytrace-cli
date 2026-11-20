"""Regenerates the two generated tables of syscall_catalog.sql from gVisor's own
source for the runsc release setup.py installs. Run it when that release changes.

    syscall_numbers   every syscall number gVisor's table has, per architecture,
                      with whether gVisor implements it (pkg/sentry/syscalls/linux/linux64.go)
    syscall_coverage  which syscalls have a typed trace point, and its optional
                      fields (pkg/sentry/seccheck/metadata_{amd64,arm64}.go);
                      the rest are reported by number and six integers only

    python3 worker/sandbox/catalog_numbers.py                  fetch the release and rewrite the file
    python3 worker/sandbox/catalog_numbers.py --source DIR     read the three files from DIR instead
    python3 worker/sandbox/catalog_numbers.py --spike report.json
                                                              also record what spike_points.py saw arrive
    python3 worker/sandbox/catalog_numbers.py --check          change nothing; say what the catalog lacks

A name gVisor has and the catalog lacks is refused: write its row first, so
nothing the sandbox can be asked for is without a group. What a spike observed
is kept across runs for the same release and forgotten for a new one.
"""
import argparse
import json
from pathlib import Path
import re
import sqlite3
import sys
import urllib.request

RELEASE = '20260817.0'
RAW = 'https://raw.githubusercontent.com/google/gvisor/release-{release}/{path}'
SOURCES = {'linux64.go': 'pkg/sentry/syscalls/linux/linux64.go',
           'metadata_amd64.go': 'pkg/sentry/seccheck/metadata_amd64.go',
           'metadata_arm64.go': 'pkg/sentry/seccheck/metadata_arm64.go'}
CATALOG = Path(__file__).with_name('syscall_catalog.sql')
SUPPORT = {'Supported': 'supported', 'SupportedPoint': 'supported',
           'PartiallySupported': 'partial', 'PartiallySupportedPoint': 'partial',
           'Error': 'unsupported', 'ErrorWithEvent': 'unsupported', 'CapError': 'unsupported'}
ROW = re.compile(r'^\s+(\d+):\s+syscalls\.(\w+)\("([a-z0-9_]+)"', re.M)
POINT = re.compile(r'addSyscallPoint\((\d+), "([a-z0-9_]+)", (nil|\[\]FieldDesc\{.*?\n\t\})\)', re.S)


def read(name, source):
    if source:
        return (Path(source) / name).read_text()
    with urllib.request.urlopen(RAW.format(release=RELEASE, path=SOURCES[name]), timeout=60) as response:
        return response.read().decode()


def numbers(table):
    """{arch: [(sysno, name, support)]} from gVisor's two syscall tables."""
    amd, arm, end = table.index('var AMD64'), table.index('var ARM64'), table.index('func init()')
    found = {}
    for arch, text in (('x86_64', table[amd:arm]), ('aarch64', table[arm:end])):
        rows = [(int(number), name, SUPPORT[kind]) for number, kind, name in ROW.findall(text)]
        if len(rows) < 250 or len({name for _, name, _ in rows}) != len(rows):
            raise SystemExit(f'{arch}: gVisor\'s table did not parse as expected ({len(rows)} rows)')
        found[arch] = sorted(rows)
    return found


def points(*metadata):
    """{name: [optional field]} for every syscall with a typed trace point."""
    found = {}
    for text in metadata:
        for _, name, fields in POINT.findall(text):
            found.setdefault(name, set()).update(re.findall(r'Name:\s+"([a-z0-9_]+)"', fields))
    if len(found) < 40:
        raise SystemExit(f'gVisor\'s trace point list did not parse as expected ({len(found)} points)')
    return {name: sorted(fields) for name, fields in found.items()}


def catalog(sql):
    """(each name the catalog has with the engine rule that reads it, what an earlier spike observed for this release)."""
    db = sqlite3.connect(':memory:')
    try:
        db.executescript(sql)
        names = dict(db.execute('SELECT syscall_name, effect_rule FROM syscall_catalog').fetchall())
        seen = {name: (observed, fields) for name, observed, fields in db.execute(
            'SELECT syscall_name, observed, observed_fields FROM syscall_coverage WHERE gvisor_release = ?', (RELEASE,))}
    finally:
        db.close()
    return names, seen


def quote(value):
    return 'NULL' if value is None else str(value) if isinstance(value, int) else "'" + str(value).replace("'", "''") + "'"


def tuples(rows, per_line):
    text = ['(' + ', '.join(quote(value) for value in row) + ')' for row in rows]
    return ',\n'.join(', '.join(text[start:start + per_line]) for start in range(0, len(text), per_line))


def section(sql, name, body):
    begin, end = f'-- BEGIN GENERATED {name}', f'-- END GENERATED {name}'
    if begin not in sql or end not in sql:
        raise SystemExit(f'{CATALOG.name} has no generated section named {name}')
    head, rest = sql.split(begin, 1)
    return head + begin + ' (catalog_numbers.py, gVisor release ' + RELEASE + '; do not edit by hand)\n' + body + '\n' + end + rest.split(end, 1)[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', help='a folder holding linux64.go, metadata_amd64.go and metadata_arm64.go')
    parser.add_argument('--spike', help='the report spike_points.py wrote')
    parser.add_argument('--check', action='store_true')
    opts = parser.parse_args()
    sql = CATALOG.read_text()
    table = numbers(read('linux64.go', opts.source))
    typed = points(read('metadata_amd64.go', opts.source), read('metadata_arm64.go', opts.source))
    known, seen = catalog(sql)
    names = sorted({name for rows in table.values() for _, name, _ in rows})
    missing = [name for name in names if name not in known]
    if missing:
        raise SystemExit('The catalog has no row for: ' + ' '.join(missing))
    if opts.spike:
        report = json.loads(Path(opts.spike).read_text())
        if report.get('release') != RELEASE:
            raise SystemExit(f"That spike ran release {report.get('release')}, not {RELEASE}")
        arrived = report.get('observed', {})
        for name, call in arrived.items():
            if name in known:
                seen[name] = (1, json.dumps(sorted(call.get('fields', []))))
        # Silence counts against a call only when the spike's work made that
        # kind of call and none of its kind arrived: a program that deletes
        # with unlinkat says nothing about unlink.
        heard = {known[name] for name in arrived if name in known}
        for name in report.get('subscribed', []):
            if name not in arrived and known.get(name) in report.get('exercised_rules', []) and known[name] not in heard:
                seen[name] = (0, '[]')
    if opts.check:
        print(f'{len(names)} syscall names in gVisor {RELEASE}, all in the catalog; {len(typed)} have a typed trace point.')
        return
    sql = section(sql, 'numbers', 'DELETE FROM syscall_numbers;\nINSERT INTO syscall_numbers (arch, sysno, syscall_name, support) VALUES\n'
                  + tuples([(arch, number, name, support) for arch, rows in table.items() for number, name, support in rows], 3) + ';')
    coverage = [(RELEASE, name, 'syscall/' + name if name in typed else None, json.dumps(typed.get(name, [])),
                 seen.get(name, (None, '[]'))[0], seen.get(name, (None, '[]'))[1]) for name in names]
    sql = section(sql, 'coverage', 'DELETE FROM syscall_coverage;\nINSERT INTO syscall_coverage (gvisor_release, syscall_name, point, optional_fields, observed, observed_fields) VALUES\n'
                  + tuples(coverage, 2) + ';')
    CATALOG.write_text(sql)
    print(f'{CATALOG.name}: {sum(len(rows) for rows in table.values())} numbers, {len(coverage)} coverage rows for gVisor {RELEASE}.', file=sys.stderr)


if __name__ == '__main__':
    main()
