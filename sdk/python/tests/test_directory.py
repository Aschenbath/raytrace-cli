import io
from pathlib import Path
import tarfile
import tempfile
import unittest

from raytrace_sdk import RayTrace, archive_from_directory


LIMIT = 25 * 1024 * 1024


def sized_file(path, size):
    with path.open('wb') as stream:
        stream.truncate(size)


class DirectoryArchiveTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='raytrace-directory-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_rejects_oversized_project_file_before_uploading(self):
        (self.root / 'README.md').write_text('# project\n', encoding='utf-8')
        sized_file(self.root / 'dataset.bin', LIMIT + 1)
        uploads = []

        def transport(*args):
            uploads.append(args)
            return 201, {'id': 'rtp-test', 'status': 'running'}

        rt = RayTrace(api_key='test', transport=transport)
        with self.assertRaisesRegex(ValueError, r'dataset\.bin.*25 MiB'):
            rt.sandboxes.create(directory=self.root)
        self.assertEqual(uploads, [])

    def test_retains_file_at_the_size_limit(self):
        sized_file(self.root / 'dataset.bin', LIMIT)
        with tarfile.open(fileobj=io.BytesIO(archive_from_directory(self.root)), mode='r:gz') as archive:
            self.assertEqual(archive.getnames(), ['dataset.bin'])
            self.assertEqual(archive.getmember('dataset.bin').size, LIMIT)

    def test_excluded_secret_files_do_not_trigger_size_limit(self):
        (self.root / 'README.md').write_text('# project\n', encoding='utf-8')
        sized_file(self.root / '.env.local', LIMIT + 1)
        with tarfile.open(fileobj=io.BytesIO(archive_from_directory(self.root)), mode='r:gz') as archive:
            self.assertEqual(archive.getnames(), ['README.md'])


if __name__ == '__main__':
    unittest.main()
