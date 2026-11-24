import io
from pathlib import Path
import tarfile
import tempfile
import unittest

from raytrace_sdk import archive_from_directory, build_tar_gz


def archive_modes(data):
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        return {entry.name: entry.mode for entry in archive.getmembers()}


class ArchivePermissionTests(unittest.TestCase):
    def test_directory_preserves_file_permission_bits(self):
        with tempfile.TemporaryDirectory(prefix='raytrace-permissions-') as temporary:
            root = Path(temporary)
            expected = {}
            for name, mode in [('run.sh', 0o751), ('config.json', 0o640)]:
                path = root / name
                path.write_text('project file\n', encoding='utf-8')
                path.chmod(mode)
                expected[name] = path.stat().st_mode & 0o777
            self.assertEqual(archive_modes(archive_from_directory(root)), expected)

    def test_in_memory_files_keep_default_permissions(self):
        self.assertEqual(archive_modes(build_tar_gz({'README.md': '# project\n'})), {'README.md': 0o644})


if __name__ == '__main__':
    unittest.main()
