"""The host command line for sandboxes: `python3 projects.py <action> [id] ...`.

The local adapter: `raytrace sandbox ... --local` runs it in the Lima VM. Every
action is the sandbox core's (core/mechanics.py, documented in CORE_API.md).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from core.mechanics import main  # noqa: E402

if __name__ == '__main__':
    main()
