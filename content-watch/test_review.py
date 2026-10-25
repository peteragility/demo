import contextlib
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import unittest
import review as R


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.bundle = {'rates': {'premium': {'AWS': {'jobs': {'east': '0.35'}}}}, 'models': {'AWS': {'Model': {'east': {'inputPrice': '1', 'outputPrice': '2'}}}}}
        self.live = {'premium': {'AWS': {'jobs': {'east': '0.35'}}}, 'regionModels': {'AWS': {'on_demand': {'Model': {'east': {'inputPrice': '1', 'outputPrice': '2'}}}}}}

    def test_price_changes_remain_open_even_after_baseline_acceptance(self):
        source = {'kind': 'prices'}
        current = R.rates(self.live, self.bundle, True)
        self.assertEqual(R.compare(source, current, None, self.bundle), [])
        self.live['premium']['AWS']['jobs']['east'] = '0.40'
        current = R.rates(self.live, self.bundle, True)
        diff = R.compare(source, current, {'records': current}, self.bundle)
        self.assertEqual(len(diff), 1)
        self.assertIn('0.35 → source 0.4', diff[0])
        self.live['premium']['AWS']['jobs']['west'] = '0.50'
        self.assertEqual(len(R.compare(source, R.rates(self.live, self.bundle, True), None, self.bundle)), 2)

    def test_missing_bad_and_partial_feed_data_never_pass_as_free_prices(self):
        for value in ['', '-1', 'NaN', 'Infinity', '1|bad']:
            with self.assertRaises(ValueError): R.number(value)
        self.assertEqual(R.number('0.50|0.250'), '0.5|0.25')
        with self.assertRaises(ValueError): R.rates({}, self.bundle, True)
        self.live['premium']['AWS']['jobs'] = {}
        self.assertIn('MISSING', R.rates(self.live, self.bundle, True).values())

    def test_claim_changes_persist_and_navigation_is_ignored(self):
        source = {'url': 'https://vendor.test/security'}
        a = R.records('<nav><p>Sandbox menu A</p></nav><main><p>Each sandbox has its own kernel.</p></main>', source, self.bundle)
        b = R.records('<nav><p>Sandbox menu B</p></nav><main><p>Each sandbox has its own kernel.</p></main>', source, self.bundle)
        baseline = {'url': source['url'], 'records': sorted(a)}
        self.assertEqual(R.compare(source, b, baseline, self.bundle), [])
        c = R.records('<main><p>Each sandbox shares the host kernel.</p></main>', source, self.bundle)
        self.assertTrue(R.compare(source, c, baseline, self.bundle))
        self.assertTrue(R.compare(source, c, baseline, self.bundle))
        with self.assertRaises(ValueError): R.records('<p>Access denied</p>', source, self.bundle)

    def test_failed_read_preserves_baseline_and_last_success_while_publishing_health(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); here = root / 'content-watch'; here.mkdir()
            (root / 'databricks-sizing').mkdir()
            (root / 'databricks-sizing/pricing-snapshot.json').write_text(json.dumps(self.bundle))
            source = {'id': 'vendor', 'page': 'sandbox-compare/', 'url': 'https://vendor.test/security'}
            (here / 'sources.json').write_text(json.dumps([source]))
            baseline = here / 'baseline.json'; baseline.write_text(json.dumps({'sources': {'vendor': {'url': source['url'], 'records': ['previous']}}}))
            original = baseline.read_bytes()
            checks = here / 'checks.json'; checks.write_text(json.dumps({'pages': {'sandbox-compare/': {'lastSuccess': '2026-10-01'}}}))
            args = SimpleNamespace(baseline=baseline, checks=checks, record_baseline=True, cache_dir=here, report_dir=root/'report')
            with patch.object(R, 'ROOT', root), patch.object(R, 'HERE', here), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(R.run(args), 1)
            self.assertEqual(baseline.read_bytes(), original)
            row = json.loads(checks.read_text())['pages']['sandbox-compare/']
            self.assertEqual(row['lastSuccess'], '2026-10-01')
            self.assertEqual(row['status'], 'partial')
            self.assertTrue((args.report_dir / 'issue.md').read_text())

    def test_region_changes_keep_the_region_name_and_status_together(self):
        source = {'kind': 'availability', 'url': 'https://vendor.test/regions'}
        html = '<h2>Region availability</h2><table><tr><td>Singapore</td><td>Beta</td></tr></table>'
        a = R.records(html, source, self.bundle)
        b = R.records(html.replace('Singapore', 'Tokyo'), source, self.bundle)
        self.assertNotEqual(a, b)
        self.assertTrue(R.compare(source, b, {'url': source['url'], 'records': sorted(a)}, self.bundle))


if __name__ == '__main__': unittest.main()
