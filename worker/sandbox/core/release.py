"""Releases on a sandbox host: which installed release is active, switched
atomically, and a lock that keeps a switch and a sandbox creation apart.

A release is a directory under RELEASES named by its release id, holding the
installed core and an immutable manifest, release.json:

    {"id": ..., "image": "raytrace-sandbox:<id>", ...whatever its installer records}

CURRENT is a symlink to the active one, and the only record of which is
active. Activation takes the lock exclusively; anything that must see one
release from start to end (core.mechanics.create with expect_release) takes
it shared. A host without releases (a local VM) has no CURRENT: active() is
None and nothing here is used.
"""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re

RELEASES = Path('/opt/raytace/releases')
CURRENT = Path('/opt/raytace/current')
LOCK = Path('/run/raytace/release.lock')
# The label a sandbox made from a release carries, naming it.
LABEL = 'io.raytace.release'
ID = r'[a-f0-9]{12,64}'


@contextlib.contextmanager
def lock(shared=False, path=None):
    path = Path(path or LOCK)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_SH if shared else fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def manifest(directory):
    """A release directory's release.json, checked to name itself."""
    directory = Path(directory)
    data = json.loads((directory / 'release.json').read_text())
    if data.get('id') != directory.name or not re.fullmatch(ID, data['id']) or not data.get('image'):
        raise ValueError(f'{directory}: release.json does not match its directory')
    return data


def active(current=None):
    """The active release's manifest, or None on a host without releases."""
    current = Path(current or CURRENT)
    if not current.is_symlink():
        return None
    return manifest(current.resolve())


def point(target, current=None):
    """Points CURRENT at a release directory in one rename; the release that was active before, or None."""
    current = Path(current or CURRENT)
    before = current.resolve() if current.is_symlink() else None
    staged = current.with_name(current.name + '.new')
    staged.unlink(missing_ok=True)
    staged.symlink_to(Path(target))
    staged.replace(current)
    return before


def activate(target, restart, check, current=None, lock_path=None):
    """Makes a staged release active: under the exclusive lock, the symlink
    switched, `restart()` run, then `check()`. If restart or check fails, the
    previous release is put back and restarted, and the failure is raised.
    Returns the manifest now active."""
    target = Path(target)
    manifest(target)
    with lock(path=lock_path):
        before = point(target, current)
        try:
            restart()
            check()
        except BaseException:
            if before is not None:
                point(before, current)
                restart()
            else:
                Path(current or CURRENT).unlink(missing_ok=True)
            raise
    return active(current)
