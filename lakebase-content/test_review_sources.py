import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("watch", Path(__file__).with_name("review_sources.py"))
watch = importlib.util.module_from_spec(spec); spec.loader.exec_module(watch)


class WatchTests(unittest.TestCase):
    def test_wording_is_not_a_price_change(self):
        before = '<h1>Lakebase</h1><p>Compute costs $0.10 per CU-hour.</p>'
        after = '<h1>Lakebase</h1><p>Each compute CU-hour costs $0.10.</p>'
        self.assertEqual(watch.material_records(before), watch.material_records(after))
        self.assertNotEqual(watch.material_records(before), watch.material_records(after.replace('$0.10', '$0.12')))

    def test_integer_limits_and_status_are_material(self):
        before = '<h1>Lakebase</h1><p>Maximum 500 branches. Lakebase Search is public preview.</p>'
        for after in (before.replace('500', '600'), before.replace('public preview', 'generally available')):
            self.assertNotEqual(watch.material_records(before), watch.material_records(after))

    def test_failed_source_does_not_resolve_a_previous_diff(self):
        config = [{'id': 'a', 'url': 'https://example.com'}]
        baseline = {'sources': {'a': {'records': ['price:$1']}}}
        findings = watch.findings(config, baseline, {}, {'a': 'HTTP 503'})
        self.assertEqual(findings[0]['reason'], 'Source could not be rechecked')
        self.assertEqual(baseline['sources']['a']['records'], ['price:$1'])

    def test_empty_or_wrong_documents_are_not_verified(self):
        with self.assertRaises(ValueError): watch.material_records('<p>Access denied</p>')
        with self.assertRaises(ValueError): watch.material_records('{"regions":{}}', 'rds-index')

    def test_structured_prices_preserve_tier_cloud_region_and_sku(self):
        data = {"premium": {"AWS": {"lakebase_aws_premium": {region: "0.100" for region in watch.LAKEBASE_REGIONS},
                                      "unrelated_sku": {"US East (N. Virginia)": "5"}}}}
        before = watch.material_records(json.dumps(data), 'lakebase-price-feed')
        data['premium']['AWS']['unrelated_sku']['US East (N. Virginia)'] = '6'
        self.assertEqual(before, watch.material_records(json.dumps(data), 'lakebase-price-feed'))
        data['premium']['AWS']['lakebase_aws_premium']['US East (N. Virginia)'] = '0.12'
        self.assertNotEqual(before, watch.material_records(json.dumps(data), 'lakebase-price-feed'))
        data['premium']['AWS']['lakebase_aws_premium']['US East (N. Virginia)'] = 'NaN'
        with self.assertRaises(ValueError): watch.material_records(json.dumps(data), 'lakebase-price-feed')

    def test_integer_table_limits_are_preserved(self):
        table = lambda n: '<h1>Project limits</h1><table><tr><td>Maximum branches</td><td>' + str(n) + '</td></tr></table>'
        self.assertNotEqual(watch.material_records(table(500)), watch.material_records(table(600)))

    def test_equivalent_ga_wording_does_not_create_a_finding(self):
        source = lambda wording: '<p>Lakebase Search is ' + wording + '.</p>'
        before = watch.material_records(source('generally available'))
        for wording in ('GA', 'general availability'):
            self.assertEqual(before, watch.material_records(source(wording)))

    def test_insecure_source_urls_are_rejected_before_fetch(self):
        with self.assertRaises(ValueError): watch.collect({'id': 'test', 'url': 'http://example.com'})

    def test_status_assignment_changes_are_not_hidden_by_an_unchanged_status_set(self):
        before = '<h1>Lakebase platform status</h1><table><tr><td>AWS</td><td>GA</td></tr><tr><td>GCP</td><td>Beta</td></tr></table>'
        after = before.replace('<td>GA</td>', '<td>Beta</td>').replace('<td>GCP</td><td>Beta</td>', '<td>GCP</td><td>GA</td>')
        self.assertNotEqual(watch.material_records(before), watch.material_records(after))

    def test_both_ends_of_numeric_ranges_are_material(self):
        before = '<p>PITR retention is 2–30 days.</p>'
        for after in (before.replace('2–', '3–'), before.replace('30', '35')):
            self.assertNotEqual(watch.material_records(before), watch.material_records(after))


if __name__ == '__main__': unittest.main()
