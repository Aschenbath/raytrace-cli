"""scan-v2 classification: weighted reach, percentile bands, content hazards.

Run from this folder: python3 -m pytest test_file_scan.py (or unittest).
"""
import unittest

import file_scan


def scan(files):
    members = [(path, len(text.encode()), (lambda text=text: text.encode())) for path, text in files.items()]
    result = file_scan.scan(members)
    return result, {file['path']: file for file in result['files']}


class ScanV2Tests(unittest.TestCase):
    def test_direct_hub_outranks_equal_count_passenger(self):
        _, by_path = scan({
            'src/server.js': "import './config.js'; import './routes.js';",
            'src/routes.js': "import './config.js'; import './helper.js';",
            'src/config.js': "export const config = {};",
            'src/helper.js': "import './passenger.js';",
            'src/passenger.js': "export const passenger = 1;",
            'src/a.js': "import './config.js'; import './helper.js';",
            'src/b.js': "import './config.js'; import './helper.js';",
            'src/c.js': "import './config.js'; import './helper.js';",
            'src/d.js': "import './helper.js';",
        })
        config, passenger = by_path['src/config.js'], by_path['src/passenger.js']
        self.assertGreater(config['reach']['direct'], passenger['reach']['direct'])
        self.assertGreater(config['reach']['score'], passenger['reach']['score'])
        self.assertGreater(config['level'], passenger['level'])

    def test_tiny_project_cannot_manufacture_lock_down_from_reach(self):
        _, by_path = scan({
            'a.js': "import './shared.js';",
            'b.js': "import './shared.js';",
            'shared.js': "export const shared = 1;",
        })
        self.assertLessEqual(by_path['shared.js']['reach']['level'], 3)
        self.assertLess(by_path['shared.js']['level'], 5)

    def test_function_content_can_lock_down_or_require_review(self):
        _, by_path = scan({
            'src/credentials.js': "const material = '-----BEGIN PRIVATE KEY-----';",
            'src/wreck.js': "export const sql = 'DROP TABLE users';",
            'db/reset.sql': "DROP TABLE users;",
            'src/charge.js': "export const charge = (stripe) => stripe.paymentIntents.create({});",
            'src/token.js': "export const check = (jwt, token) => jwt.verify(token);",
            'src/ordinary.js': "export const value = 1;",
        })
        self.assertEqual(by_path['src/credentials.js']['hazard']['level'], 5)
        self.assertEqual(by_path['src/wreck.js']['level'], 5)
        self.assertEqual(by_path['db/reset.sql']['level'], 5)
        self.assertEqual(by_path['src/charge.js']['level'], 4)
        self.assertEqual(by_path['src/token.js']['level'], 4)
        self.assertEqual(by_path['src/ordinary.js']['level'], 1)

    def test_migration_path_stays_lock_down(self):
        _, by_path = scan({'db/migrations/001_users.sql': 'CREATE TABLE users (id INTEGER);'})
        self.assertEqual(by_path['db/migrations/001_users.sql']['level'], 5)
        self.assertEqual(by_path['db/migrations/001_users.sql']['hazard']['rule'], 'database migration')

    def test_untested_widely_used_file_is_lifted(self):
        files = {
            'src/server.js': "import './superHub.js';" + ''.join(f"import './feature{i}.js';" for i in range(6)),
            'src/superHub.js': "export const superHub = 1;",
            'src/testedHub.js': "import './superHub.js'; export const testedHub = 1;",
            'src/plainHub.js': "import './superHub.js'; export const plainHub = 1;",
            'src/testedHub.test.js': "import './testedHub.js';",
            'src/superHub.test.js': "import './superHub.js';",
        }
        for i in range(6):
            files[f'src/feature{i}.js'] = "import './testedHub.js'; import './plainHub.js'; import './superHub.js';"
        _, by_path = scan(files)
        self.assertEqual(by_path['src/testedHub.js']['reach']['score'], by_path['src/plainHub.js']['reach']['score'])
        self.assertEqual(by_path['src/testedHub.js']['level'], 3)
        self.assertIn('untested', by_path['src/plainHub.js']['flags'])
        self.assertEqual(by_path['src/plainHub.js']['level'], 4)


if __name__ == '__main__':
    unittest.main()
