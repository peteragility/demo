import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('page_status', Path(__file__).resolve().parents[1] / 'scripts/page-status.py')
S = importlib.util.module_from_spec(spec); spec.loader.exec_module(S)


class StatusTests(unittest.TestCase):
    def test_failed_check_retains_the_last_successful_date(self):
        old = {'pages': {'llm-pricing/': {'lastSuccess': '2026-10-24'}}}
        data = {'checked_at': '2026-10-25', 'sources_failed': ['provider'], 'review': []}
        row = S.build('llm', data, old)['pages']['llm-pricing/']
        self.assertEqual(row['lastSuccess'], '2026-10-24'); self.assertEqual(row['status'], 'partial')
        data['sources_failed'] = []; data['review'] = ['changed price']
        row = S.build('llm', data, old)['pages']['llm-pricing/']
        self.assertEqual(row['lastSuccess'], '2026-10-25'); self.assertEqual(row['status'], 'review')

    def test_shared_lakebase_status_and_hong_kong_security_dates(self):
        rows = S.build('lakebase', {'checked': '2026-10-25', 'errors': {}, 'findings': []}, {})['pages']
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row['status'] == 'ok' for row in rows.values()))
        row = S.build('security', {'last_attempt': '2026-10-24T18:00:00Z', 'last_success': '2026-10-24T18:00:00Z', 'sources': [], 'records': []}, {})['pages']['security-risk/']
        self.assertEqual(row['lastSuccess'], '2026-10-25')


if __name__ == '__main__': unittest.main()
