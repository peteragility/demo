#!/usr/bin/env python3
import datetime as dt
import importlib.util
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("source_review", HERE / "review-sources.py")
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


class SourceReviewTests(unittest.TestCase):
    def test_catalog_ignores_navigation_and_script_model_names(self):
        text = '<nav>Endpoint name: databricks-nav</nav><script>Endpoint name: databricks-fake</script><main><p>Endpoint name: <code>databricks-gpt-6-1-sol</code></p></main>'
        records = review.html_records(text, "catalog")
        self.assertEqual(records, ["endpoint: databricks-gpt-6-1-sol"])

    def test_empty_or_error_html_cannot_certify_no_source_change(self):
        with self.assertRaises(ValueError):
            review.html_records('<h1>Page not found</h1>', "tables")

    def test_table_records_retain_model_heading_and_numeric_units(self):
        text = '<h2>Gemini 3.5 Flash-Lite</h2><h3>Standard</h3><table><tr><th>Input</th><td>$0.30 / 1M tokens</td></tr></table>'
        records = review.html_records(text, "tables")
        self.assertEqual(len(records), 1)
        self.assertIn('Gemini 3.5 Flash-Lite / Standard', records[0])
        self.assertIn('$0.30 / 1M tokens', records[0])

    def test_valid_minified_html_with_omitted_end_tags_preserves_retirement_rows(self):
        text = '<h2>Retired models</h2><table><thead><tr><th>Model<th>Date<tbody><tr><td>Inkling<td>October 30, 2026<tbody><tr><td>Kimi K2.7<td>October 30, 2026</table>'
        records = review.html_records(text, "tables")
        self.assertEqual(len(records), 3)
        self.assertTrue(any('Inkling' in row and 'October 30, 2026' in row for row in records))
        self.assertTrue(any('Kimi K2.7' in row and 'October 30, 2026' in row for row in records))

    def test_new_models_and_price_changes_produce_reviewable_diffs(self):
        baseline = {"checked_at": "2026-10-01", "sources": {"models": {"digest": "old", "records": ["endpoint: databricks-gpt-6-sol"]}}}
        current = {"models": {"url": "https://example.com/models", "digest": "new", "records": ["endpoint: databricks-gpt-6-sol", "endpoint: databricks-gpt-6-1-sol"]}}
        report = review.make_report(baseline, current, {}, {"models": {}}, dt.date(2026, 10, 2))
        self.assertEqual(report["changes"][0]["added"], ["endpoint: databricks-gpt-6-1-sol"])
        self.assertIn('+endpoint: databricks-gpt-6-1-sol', report["changes"][0]["diff"])

    def test_source_failure_is_not_a_model_removal(self):
        baseline = {"sources": {"prices": {"digest": "old", "records": ["price"]}}}
        report = review.make_report(baseline, {}, {"prices": "HTTP 503"}, {"models": {}}, dt.date(2026, 10, 2))
        self.assertEqual(report["changes"], [])
        self.assertEqual(report["sources_failed"], {"prices": "HTTP 503"})

    def test_aws_unit_and_service_tier_survive_normalization(self):
        fixture = {"products": {"a": {"attributes": {"model": "Kimi K3", "service_tier": "global-priority"}}}, "terms": {"OnDemand": {"a": {"term": {"priceDimensions": {"rate": {"unit": "1K tokens", "pricePerUnit": {"USD": "0.000525"}}}}}}}}
        records = review.aws_records(fixture)
        self.assertIn('1K tokens', records[0])
        self.assertIn('global-priority', records[0])
        self.assertIn('0.000525', records[0])

    def test_retirement_and_promotion_dates_trigger_lifecycle_reminders(self):
        data = {"models": {"x": {"name": "Inkling", "platforms": {"databricks": {"retires_on": "2026-10-30"}}}}}
        alerts = review.time_alerts(data, dt.date(2026, 10, 2))
        self.assertEqual(alerts[0]["days"], 28)
        self.assertEqual(alerts[0]["state"], "upcoming")

    def test_service_tier_promotions_and_verified_through_dates_are_reminders(self):
        data = {"models": {"x": {"name": "GPT", "platforms": {"official": {"variants": [
            {"promotion": {"ends_on": "2026-11-21"}}, {"valid_through": "2026-11-21"}]}}}}}
        events = {a["event"] for a in review.time_alerts(data, dt.date(2026, 11, 1))}
        self.assertEqual(events, {"tier promotion end", "tier rates verified through"})

    def test_events_older_than_the_window_are_not_reported(self):
        data = {"models": {"x": {"name": "Inkling", "platforms": {"databricks": {"retires_on": "2026-10-30"}}}}}
        self.assertEqual(review.time_alerts(data, dt.date(2027, 3, 1)), [])

    def test_imminent_events_need_review_until_a_baseline_acknowledges_them(self):
        data = {"models": {"x": {"name": "Inkling", "platforms": {"databricks": {"retires_on": "2026-10-30"}}}}}
        baseline = {"sources": {}}
        self.assertEqual(review.make_report(baseline, {}, {}, data, dt.date(2026, 10, 20))["lifecycle_due"], [])
        due = review.make_report(baseline, {}, {}, data, dt.date(2026, 10, 24))["lifecycle_due"]
        self.assertEqual([a["event"] for a in due], ["retirement"])
        baseline["acknowledged_lifecycle"] = [review.alert_key(due[0])]
        self.assertEqual(review.make_report(baseline, {}, {}, data, dt.date(2026, 10, 31))["lifecycle_due"], [])


if __name__ == "__main__":
    unittest.main()
