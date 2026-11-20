"""The RayTrace sandbox core: what runs on a sandbox host, as a library.

Two versions are kept, and checked separately by anything that runs on this core:

  CORE_API         the functions a host layer imports from core.mechanics and
                   core.release (arguments, results, errors, side effects),
                   written down in CORE_API.md
  EVIDENCE_SCHEMA  what the recorder hands on: the collector's event shapes,
                   the fact engine's facts and the syscall catalog

Raise one when what it covers changes in a way a consumer would notice.
"""
import json
from pathlib import Path

CORE_API = 1
EVIDENCE_SCHEMA = 1

_HERE = Path(__file__).resolve().parent


def version():
    """This core's package version: from the package it ships in, or the
    VERSION file setup.py writes beside the installed copy; None if neither."""
    for candidate in (_HERE.parent.parent.parent / 'package.json', _HERE.parent / 'VERSION'):
        try:
            text = candidate.read_text()
        except OSError:
            continue
        if candidate.suffix == '.json':
            data = json.loads(text)
            if data.get('name') == '@raytrace-cli/cli':
                return data.get('version')
        elif text.strip():
            return text.strip()
    return None
