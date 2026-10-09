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


    def test_model_lines_match_names_ids_and_short_names_but_not_siblings(self):
        rx = review.model_regex({"name": "Claude Opus 5.5"})
        for line in ["Claude Opus 5.5 | $4", "claude-opus-5-5", "Opus 5.5 (global)"]:
            self.assertTrue(rx.search(review.official.norm(line)), line)
        for line in ["Claude Opus 5 | $5", "Claude Opus 5.5 Pro", "Claude Opus 4.5, 4.6, 5"]:
            self.assertFalse(rx.search(review.official.norm(line)), line)
        glm = review.model_regex({"name": "GLM 5.3"})
        self.assertTrue(glm.search(review.official.norm("glm-5.3 | $1.40")))
        self.assertFalse(glm.search(review.official.norm("GLM 5.3 Flash | $0.15")))

    def test_an_unchanged_model_line_is_verified_today_and_a_changed_one_needs_review(self):
        config = [{"id": "prices", "url": "https://example.com", "meta": ["src"]}]
        data = {"models": {"a/kimi-k3": {"name": "Kimi K3", "platforms": {"x": {"status": "priced", "src": "src"}}},
                           "a/glm-5.3": {"name": "GLM 5.3", "platforms": {"x": {"status": "priced", "src": "src"}}}}}
        before = ["table: Kimi K3 | $3 | $15", "table: GLM 5.3 | $1.40 | $4.40"]
        after = ["table: Kimi K3 | $3 | $15", "table: GLM 5.3 | $1.50 | $4.40"]
        baseline = {"sources": {"prices": {"records": before}}}
        current = {"prices": {"url": "https://example.com", "records": after}}
        cells, changes = review.cell_checks(data, config, baseline, current, {}, {}, None, dt.date(2026, 10, 5))
        self.assertEqual(cells["a/kimi-k3|x"], {"verified": "2026-10-05"})
        self.assertEqual(cells["a/glm-5.3|x"]["changed_at"], "2026-10-05")
        self.assertEqual(changes[0]["added"], ["table: GLM 5.3 | $1.50 | $4.40"])
        # A source that could not be read keeps the last verified date.
        cells, _ = review.cell_checks(data, config, baseline, {}, {"prices": "HTTP 503"}, {}, {"cells": {"a/kimi-k3|x": {"verified": "2026-10-04"}}}, dt.date(2026, 10, 5))
        self.assertEqual(cells["a/kimi-k3|x"]["verified"], "2026-10-04")

    def test_databricks_prices_are_checked_against_its_dbu_table(self):
        html = """<table><tr><th>Model</th><th>Standard Pay Per Token (DBU Per 1M Tokens)</th></tr>
        <tr><td>Input</td><td>Output</td><td>Cache read</td></tr>
        <tr><td>Kimi K3 ⌖</td><td>42.857</td><td>214.286</td><td>4.286</td></tr>
        <tr><td>GLM-5.2, 5.3</td><td>20.000</td><td>62.857</td><td>3.714</td></tr>""" + "".join(
            f"<tr><td>Model {n}</td><td>1</td><td>2</td><td>-</td></tr>" for n in range(10)) + "</table>"
        rows = review.official.dbx_price_rows(html, 0.07)
        self.assertAlmostEqual(rows["kimi k3"]["standard"][""]["in"], 3.0, places=3)
        self.assertIn("glm 5.3", rows)
        cell = {"status": "priced", "in": 3.0, "out": 15.0, "cache_read": 0.3, "variants": [{"comparison_scope": "regional", "service_tier": "standard"}]}
        data = {"models": {"m/kimi-k3": {"name": "Kimi K3", "platforms": {"databricks": cell}}}}
        self.assertEqual(review.dbx_fact_issues(data, rows, dt.date(2026, 10, 5)), {})
        cell["in"] = 3.3
        self.assertIn("standard in", review.dbx_fact_issues(data, rows, dt.date(2026, 10, 5))["m/kimi-k3"][0])

    def test_databricks_region_tables_give_in_region_and_cross_geo_lists(self):
        html = """<table><tr><th>Region</th><th>Foundation Model APIs pay-per-token</th><th>x</th><th>y</th></tr>""" + "".join(
            f"<tr><td>{r}</td><td>The following models are supported: databricks-kimi-k3{m} " + " ".join(f"databricks-m{n}" for n in range(12)) + "</td><td></td><td></td></tr>"
            for r, m in [("us-east-1", ""), ("ap-northeast-1", " ⥂"), ("eastasia", " ⥂")]) + "</table>"
        regions = review.official.dbx_regions(html)
        out = review.official.dbx_endpoint_regions("databricks-kimi-k3", {"aws": regions, "azure": regions})
        self.assertIn(["Americas", "in-region", "In-region", "AWS N. Virginia"], out["regions"])
        self.assertIn(["APAC", "global", "Cross-geo", "AWS Tokyo · Azure East Asia (Hong Kong)"], out["regions"])
        self.assertEqual(out["hk"][0], "routed")


    def test_a_new_bedrock_model_card_flags_a_model_bedrock_did_not_sell(self):
        toc = {"contents": [{"title": "GLM 5", "href": "model-card-zai-glm-5.html"}] + [{"title": f"M{n}", "href": f"model-card-m{n}.html"} for n in range(20)]}
        before = review.toc_records(toc)
        toc["contents"].append({"title": "GLM 5.3", "href": "model-card-zai-glm-5-3.html"})
        after = review.toc_records(toc)
        config = [{"id": "cards", "url": "https://example.com/toc.json", "meta": ["aws"]}]
        data = {"models": {"z/glm-5.3": {"name": "GLM 5.3", "platforms": {"bedrock": {"status": "unavailable", "src": "aws"}}},
                           "z/glm-5": {"name": "GLM 5", "platforms": {"bedrock": {"status": "priced", "src": "aws"}}}}}
        cells, changes = review.cell_checks(data, config, {"sources": {"cards": {"records": before}}}, {"cards": {"url": "u", "records": after}}, {}, {}, None, dt.date(2026, 10, 6))
        self.assertEqual(cells["z/glm-5.3|bedrock"]["changed_at"], "2026-10-06")
        self.assertEqual(cells["z/glm-5|bedrock"], {"verified": "2026-10-06"})
        self.assertEqual(changes[0]["added"], ["card: GLM 5.3 | model-card-zai-glm-5-3.html"])

    def test_page_date_stamps_are_not_source_changes(self):
        page = "<main><p>GLM 5.3 costs $1.40 per million input tokens.</p><p>Last updated 2026-10-05 UTC.</p></main>"
        self.assertEqual(review.html_records(page, "text"), ["text: GLM 5.3 costs $1.40 per million input tokens."])

    def test_a_price_published_for_a_pending_databricks_offer_is_reported(self):
        rows = {"gpt 6.1 sol": {"label": "GPT-6.1 Sol ⌖", "regional": True, "standard": {"short context": {"in": 2.0, "out": 10.0}}}}
        data = {"models": {"o/gpt-6.1-sol": {"name": "GPT-6.1 Sol", "platforms": {"databricks": {"status": "unverified", "available": True}}}}}
        issues = review.dbx_fact_issues(data, rows, dt.date(2026, 10, 6))
        self.assertIn("now priced in the DBU table: $2 / $10", issues["o/gpt-6.1-sol"][0])


    def test_dbu_tables_titled_pay_per_token_are_standard_rates(self):
        rows = "".join(f"<tr><td>Model {n}</td><td>1</td><td>2</td><td>-</td></tr>" for n in range(10))
        html = ("<table><tr><th>Model</th><th>Pay Per Token (DBU Per 1M Tokens)</th></tr><tr><td>Input</td><td>Output</td><td>Cache read</td></tr>"
                "<tr><td>Kimi K3 ⌖</td><td>42.857</td><td>214.286</td><td>4.286</td></tr>" + rows + "</table>")
        self.assertAlmostEqual(review.official.dbx_price_rows(html, 0.07)["kimi k3"]["standard"][""]["in"], 3.0, places=3)

    def test_an_unreadable_dbu_table_does_not_report_models_as_missing(self):
        data = {"models": {"m/kimi-k3": {"name": "Kimi K3", "platforms": {"databricks": {"status": "priced", "in": 3, "out": 15}}}}}
        self.assertEqual(review.dbx_fact_issues(data, {"other": {"label": "Other", "regional": False}}, dt.date(2026, 10, 7), complete=False), {})
        self.assertIn("not found", review.dbx_fact_issues(data, {"other": {"label": "Other", "regional": False}}, dt.date(2026, 10, 7))["m/kimi-k3"][0])

    def test_spacing_around_brackets_is_not_a_change(self):
        self.assertEqual(review.official.clean("0.05x on Claude Opus 5.5 )"), review.official.clean("0.05x on Claude Opus 5.5)"))
        self.assertEqual(review.official.clean("( global.anthropic.claude-opus-5 ) : routes"), "(global.anthropic.claude-opus-5): routes")

    def test_a_page_scoped_to_one_model_ignores_other_models_lines(self):
        config = [{"id": "mistral", "url": "https://example.com", "meta": ["src"], "models": ["m/medium-3.5"]}]
        data = {"models": {"m/medium-3.5": {"name": "Mistral Medium 3.5", "platforms": {"official": {"status": "priced", "src": "src"}}}}}
        before = ["table: Mistral Medium 3.5 | $1.50 | $7.50"]
        after = before + ["table: Mistral Large 4 Sale price | $0.68"]
        cells, _ = review.cell_checks(data, config, {"sources": {"mistral": {"records": before}}}, {"mistral": {"url": "u", "records": after}}, {}, {}, None, dt.date(2026, 10, 7))
        self.assertEqual(cells["m/medium-3.5|official"], {"verified": "2026-10-07"})


    def test_changes_that_leave_prices_and_dates_alone_are_low_risk(self):
        rx = review.model_regex({"name": "Claude Opus 5.5"})
        spacing = ("table: Cache read 0.1x (0.05x on Claude Opus 5.5)", "table: Cache read 0.1x (0.05x on Claude Opus 5.5 )")
        self.assertEqual(review.classify([spacing[0]], [spacing[1]], rx)[0], "low")
        renamed = ("table: Regional (Mantle in IAD) | $2.20 | $11.00", "table: Regional (bedrock-mantle in US East) | $2.20 | $11.00")
        self.assertEqual(review.classify([renamed[0]], [renamed[1]], rx)[0], "low")
        limits = ("table: Tier 1 | 500 | 500,000 | Claude Opus 5.5", "table: Build | 5,000 | 1,000,000 | Claude Opus 5.5")
        self.assertEqual(review.classify([limits[0]], [limits[1]], rx)[0], "low")
        repeated = ("table: Opus 5.5 | Input | $4.00 | $4.00", "table: Opus 5.5 | Input | $4.00 |  | ")
        self.assertEqual(review.classify([repeated[0]], [repeated[1]], rx)[0], "low")
        region = ('table: {"cells":["us-east-1 (N. Virginia)","no","yes","yes"],"heading":"Regional Availability"}',
                  'table: {"cells":["us-east-1  (N. Virginia)","no","yes","yes"],"heading":"Regional  Availability"}')
        self.assertEqual(review.classify([region[0]], [region[1]], rx)[0], "low")

    def test_price_date_and_availability_changes_need_review(self):
        rx = review.model_regex({"name": "Kimi K3"})
        base = ["table: Kimi K3 | Global CRIS | $3.00 | $15.00"]
        self.assertEqual(review.classify(base, base + ["table: Kimi K3 | IN CRIS | $3.30 | $16.50"], rx), ("high", "a price, rate, multiplier or context limit changed"))
        self.assertEqual(review.classify(base, ["table: Kimi K3 | Global CRIS | $2.50 | $15.00"], rx)[0], "high")
        self.assertEqual(review.classify(base, base + ["notice: Kimi K3 retires on November 5, 2026."], rx), ("high", "a date changed"))
        self.assertEqual(review.classify([], base, rx)[0], "high")
        self.assertEqual(review.classify(base, [], rx)[0], "high")
        # Context thresholds, numeric dates, and regions with their support marks count too.
        limit = ("text: Kimi K3 short context (272K input tokens or fewer) | $3.00", "text: Kimi K3 short context (128K input tokens or fewer) | $3.00")
        self.assertEqual(review.classify([limit[0]], [limit[1]], rx)[0], "high")
        self.assertEqual(review.classify(["notice: Kimi K3 retires on 10/31/2026"], ["notice: Kimi K3 retires on 11/30/2026"], rx), ("high", "a date changed"))
        support = ('table: {"cells":["ap-east-2 (Taipei)","no","no","yes"],"heading":"Regional Availability"}',
                   'table: {"cells":["ap-east-2 (Taipei)","yes","no","yes"],"heading":"Regional Availability"}')
        self.assertEqual(review.classify(base + [support[0]], base + [support[1]], rx), ("high", "a region or its availability changed"))
        self.assertEqual(review.classify(base, base + [support[0]], rx)[0], "high")

    def test_accepting_low_risk_changes_keeps_high_risk_lines_for_review(self):
        baseline = {"sources": {"p": {"records": ["a old wording", "b $1.00"]}}, "acknowledged_lifecycle": []}
        current = {"p": {"url": "u", "kind": "tables", "digest": "x", "records": ["a new wording", "b $2.00"]}}
        changes = [{"source": "p", "risk": "low", "added_all": ["a new wording"], "removed_all": ["a old wording"]},
                   {"source": "p", "risk": "high", "added_all": ["b $2.00"], "removed_all": ["b $1.00"]}]
        out = review.accept_low_risk(baseline, current, changes, {}, [])
        self.assertEqual(out["sources"]["p"]["records"], ["a new wording", "b $1.00"])
        out = review.accept_low_risk(baseline, current, changes[:1], {}, [])
        self.assertEqual(out["sources"]["p"]["records"], current["p"]["records"])

    def test_a_changed_line_that_names_no_model_is_held_for_review(self):
        config = [{"id": "p", "url": "u", "kind": "tables", "meta": ["src"]}]
        data = {"models": {"anthropic/claude-opus-5.5": {"name": "Claude Opus 5.5", "platforms": {"official": {"status": "priced", "src": "src"}}}}}
        before = ["table: Claude Opus 5.5 | $4.00 | $20.00", "notice: US-only inference is priced at 1.1x", "table: Llama 3.3 70B | $0.90"]
        after = ["table: Claude Opus 5.5 | $4.00 | $20.00", "notice: US-only inference is priced at 1.2x", "table: Llama 3.3 70B | $0.80"]
        baseline = {"sources": {"p": {"records": before}}, "acknowledged_lifecycle": []}
        current = {"p": {"url": "u", "kind": "tables", "digest": "x", "records": after}}
        general = review.general_changes(data, config, baseline, current, {})
        # The Llama line is about a model the page does not track; the multiplier applies to every Claude model here.
        self.assertEqual([(g["risk"], g["added_all"], g["removed_all"]) for g in general],
                         [("high", ["notice: US-only inference is priced at 1.2x"], ["notice: US-only inference is priced at 1.1x"])])
        cells, changes = review.cell_checks(data, config, baseline, current, {}, {}, None, dt.date(2026, 10, 8), general)
        self.assertEqual(cells["anthropic/claude-opus-5.5|official"], {"verified": None, "unchecked": ["p"]})
        out = review.accept_low_risk(baseline, current, changes, {}, [], general)
        self.assertEqual(out["sources"]["p"]["records"], sorted(before[:2] + ["table: Llama 3.3 70B | $0.80"]))
        text, _ = review.issue_markdown({"checked_at": "2026-10-08", "sources_failed": {}, "lifecycle_due": []}, cells, changes, {}, data, set(data["models"]), [], general)
        self.assertIn("name no model", text)
        self.assertIn("1.2x", text)

    def test_model_names_the_page_does_not_track_are_recognised(self):
        for name in ("Llama 3.3 70B", "Claude Opus 4.7", "Mistral Large 4", "o3-mini", "Qwen3-235B", "DeepSeek-V3.2"):
            self.assertTrue(review.OTHER_MODEL.search(review.official.norm(name)), name)
        for text in ("US-only inference is priced at 1.1x", "Batch API: 50% discount", "Claude models support prompt caching"):
            self.assertFalse(review.OTHER_MODEL.search(review.official.norm(text)), text)

    def test_a_region_row_on_a_model_card_is_the_models_line(self):
        config = [{"id": "card", "url": "u", "meta": ["src"], "models": ["m/k3"]}]
        data = {"models": {"m/k3": {"name": "Kimi K3", "platforms": {"bedrock": {"status": "priced", "src": "src"}}}}}
        before = ['table: {"cells":["Model ID","moonshot.kimi-k3"]}', 'table: {"cells":["ap-east-2 (Taipei)","no","no","yes"],"heading":"Regional Availability"}']
        after = [before[0], 'table: {"cells":["ap-east-2 (Taipei)","yes","no","yes"],"heading":"Regional Availability"}']
        cells, changes = review.cell_checks(data, config, {"sources": {"card": {"records": before}}}, {"card": {"url": "u", "records": after}}, {}, {}, None, dt.date(2026, 10, 8))
        self.assertEqual((cells["m/k3|bedrock"]["sources"], cells["m/k3|bedrock"].get("quiet")), (["card"], True))
        self.assertEqual((changes[0]["risk"], changes[0]["reason"]), ("quiet", "a region or its availability changed"))
        # A card whose regions update-endpoints.py rebuilds from this model card takes the change as applied.
        cells, changes = review.cell_checks(data, config, {"sources": {"card": {"records": before}}}, {"card": {"url": "u", "records": after}}, {}, {}, None,
                                            dt.date(2026, 10, 8), auto_regions={("m/k3", "card")})
        self.assertEqual((changes[0]["risk"], cells["m/k3|bedrock"]["verified"]), ("applied", "2026-10-08"))

    def test_table_rows_name_their_model_and_region_icons_become_marks(self):
        text = ('<h2>Claude models</h2><table><tr><td>Sonnet 5.5</td><td>Input</td><td>$2.00</td></tr>'
                '<tr><td></td><td>Cache Hit</td><td>$0.10</td></tr></table>'
                '<table><tr><th>Region</th><th>In-Region</th></tr><tr><td>ap-east-2 (Taipei)</td>'
                '<td><img src="/images/icons/icon-no.png" alt="not-supported"></td></tr></table>')
        records = review.html_records(text, "tables")
        self.assertTrue(any('"Sonnet 5.5","Cache Hit","$0.10"' in r for r in records), records)
        self.assertTrue(any('"ap-east-2 (Taipei)","no"' in r for r in records), records)

    def test_a_new_source_waits_for_a_recorded_baseline(self):
        current = {"new": {"url": "u", "kind": "tables", "digest": "x", "records": ["table: x | $1.00"]}}
        self.assertNotIn("new", review.accept_low_risk({"sources": {}, "acknowledged_lifecycle": []}, current, [], {}, [])["sources"])
        text, _ = review.issue_markdown({"checked_at": "2026-10-08", "sources_failed": {}, "lifecycle_due": []}, {}, [], {}, {"models": {}}, set(), [], unrecorded=["new"])
        self.assertIn("without a reviewed baseline", text)

    def test_scheduled_dates_are_acknowledged_but_tier_rates_need_a_recheck(self):
        alerts = [{"key": "m", "platform": "databricks", "event": "retirement", "date": "2026-10-10", "days": 2},
                  {"key": "m", "platform": "official", "event": "tier rates verified through", "date": "2026-10-10", "days": 2}]
        out = review.accept_low_risk({"sources": {}, "acknowledged_lifecycle": []}, {}, [], {}, alerts)
        self.assertEqual(out["acknowledged_lifecycle"], ["m|databricks|retirement|2026-10-10"])
        self.assertTrue(review.needs_action(alerts[1]))
        self.assertFalse(review.needs_action(alerts[0]))

    def test_a_source_is_listed_once_it_has_not_been_read_for_two_days(self):
        sources = [{"id": "p"}, {"id": "q"}]
        previous = {"checked_at": "2026-10-07", "sources_failed": [], "sources_read": {"p": "2026-10-07", "q": "2026-10-07"}}
        self.assertEqual(review.sources_read(previous, sources, {"q": {}}, dt.date(2026, 10, 8)), {"p": "2026-10-07", "q": "2026-10-08"})
        # A checks file from before read dates were kept: sources it could read were read that day.
        self.assertEqual(review.sources_read({"checked_at": "2026-10-07", "sources_failed": ["p"]}, sources, {}, dt.date(2026, 10, 8)), {"q": "2026-10-07"})
        read = {"p": "2026-10-08"}
        self.assertEqual(review.stale({"p": "HTTP 503"}, read, dt.date(2026, 10, 8)), [])  # a same-day re-run
        self.assertEqual(review.stale({"p": "HTTP 503"}, read, dt.date(2026, 10, 9)), [])
        self.assertEqual(review.stale({"p": "HTTP 503"}, read, dt.date(2026, 10, 10)), ["p"])
        report = {"checked_at": "2026-10-10", "sources_failed": {"p": "HTTP 503"}, "lifecycle_due": []}
        text, _ = review.issue_markdown(report, {}, [], {}, {"models": {}}, set(), failing=[])
        self.assertNotIn("Sources not read", text)
        text, _ = review.issue_markdown(report, {}, [], {}, {"models": {}}, set(), failing=["p"], last_read=read)
        self.assertIn("Sources not read for 2 days or more", text)
        self.assertIn("last read 2026-10-08", text)

    def test_an_endpoint_missing_from_the_region_tables_keeps_its_date_and_is_flagged(self):
        spec = importlib.util.spec_from_file_location("update_endpoints", HERE / "update-endpoints.py")
        regions = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(regions)
        entry = {"regions": [["APAC", "in-region", "Tokyo", "AWS"]], "hk": ["none", ""], "tw": ["none", ""], "changed_at": "2026-10-01"}
        previous = {"databricks": {"m/a": dict(entry), "m/b": dict(entry)}}
        current = {"databricks": {"m/a": {k: v for k, v in entry.items() if k != "changed_at"}}}
        lines = regions.changes(previous, current)
        out = regions.carry(previous, current, {"m/a": {}, "m/b": {}}, "2026-10-08")
        card = {"regions": [["Europe", ["geo", "global"], ["EU CRIS", "Global CRIS"], "Ireland"]], "hk": ["none", ""], "tw": ["none", ""]}
        moved = dict(card, regions=[["Europe", ["geo", "global"], ["EU CRIS", "Global CRIS"], "Ireland, Paris"]])
        self.assertTrue(any("Paris" in line for line in regions.changes({"bedrock": {"m/c": card}}, {"bedrock": {"m/c": moved}})))
        self.assertTrue(any("m/b" in line and "no longer" in line for line in lines), lines)
        self.assertEqual((out["databricks"]["m/a"]["changed_at"], out["databricks"]["m/b"]["changed_at"]), ("2026-10-01", "2026-10-01"))
        self.assertEqual(out["databricks"]["m/b"]["missing_since"], "2026-10-08")
        self.assertNotIn("missing_since", out["databricks"]["m/a"])

    def test_a_price_that_moved_in_its_table_row_is_proven(self):
        cell = {"status": "priced", "tier": "Serverless", "in": 1.4, "out": 4.4, "variants": [{"label": "Serverless · Fast", "in": 2.1, "out": 6.6}]}
        header = 'table: {"cells":["Model","Input","Output"],"heading":"Serverless"}'
        old, new = 'table: {"cells":["GLM 5.3","$1.40","$4.40"],"heading":"Serverless"}', 'table: {"cells":["GLM 5.3","$1.20","$4.40"],"heading":"Serverless"}'
        change = {"added_all": [new], "removed_all": [old]}
        self.assertEqual(review.row_edits(change, cell, [header, new]), [{"offer": "base", "field": "in", "old": 1.4, "new": 1.2}])
        # Not proven: two offers charge the old price, a multiplier moved, a row came or went, or no column names the rate.
        twin = dict(cell, variants=[{"label": "Serverless · Batch", "in": 1.4, "out": 2.2}])
        self.assertIsNone(review.row_edits(change, twin, [header, new]))
        multiplier = {"added_all": ['table: {"cells":["GLM 5.3","1.2x"],"heading":"Serverless"}'], "removed_all": ['table: {"cells":["GLM 5.3","1.1x"],"heading":"Serverless"}']}
        self.assertIsNone(review.row_edits(multiplier, cell, []))
        extra = {"added_all": [new, 'table: {"cells":["GLM 5.3 Fast","$2.00","$6.60"],"heading":"Serverless"}'], "removed_all": [old]}
        self.assertIsNone(review.row_edits(extra, cell, [header]))
        self.assertIsNone(review.row_edits(change, cell, [new]))

    def test_a_tier_word_picks_the_offer_when_prices_repeat(self):
        cell = {"status": "priced", "tier": "Standard", "in": 2.0, "out": 10.0,
                "variants": [{"label": "Global · Batch", "in": 1.0, "out": 5.0}, {"label": "Global · Flex", "in": 1.0, "out": 5.0}]}
        header = 'table: {"cells":["Model","Short context input","Short context output"],"heading":"Batch pricing data"}'
        change = {"removed_all": ['table: {"cells":["gpt-x","$1.00","$5.00"],"heading":"Batch pricing data"}'],
                  "added_all": ['table: {"cells":["gpt-x","$0.80","$5.00"],"heading":"Batch pricing data"}']}
        self.assertEqual(review.row_edits(change, cell, [header]), [{"offer": "variant:Global · Batch", "field": "in", "old": 1.0, "new": 0.8}])

    def test_dbu_tables_prove_databricks_rates(self):
        cell = {"status": "priced", "in": 2.0, "out": 10.0, "variants": []}
        data = {"models": {"m/x": {"name": "Model X", "platforms": {"databricks": cell}}}}
        facts = {"model x": {"regional": False, "standard": {"": {"in": 2.50003, "out": 9.99998}}}}
        self.assertEqual(review.dbx_edits(data, facts, dt.date(2026, 10, 9)), {"m/x": [{"offer": "base", "field": "in", "old": 2.0, "new": 2.5}]})
        promoted = dict(cell, promotion={"ends_on": "2026-12-31", "after": {"in": 3.0, "out": 12.0, "tier": "Standard"}})
        data["models"]["m/x"]["platforms"]["databricks"] = promoted
        self.assertEqual(review.dbx_edits(data, facts, dt.date(2026, 10, 9)), {})
        self.assertIn("m/x", review.dbx_fact_issues(data, facts, dt.date(2026, 10, 9)))

    def test_the_build_applies_proven_rates_once_and_only_over_the_old_rate(self):
        spec = importlib.util.spec_from_file_location("build_data", HERE / "build-data.py")
        build = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(build)
        cell = {"in": 2.0, "out": 10.0, "service_tier": "standard",
                "variants": [{"label": "Regional processing ⌖ +10%", "in": 2.2, "out": 11.0, "comparison_scope": "regional", "service_tier": "standard"}]}
        edit = {"date": "2026-10-09", "offer": "base", "field": "in", "old": 2.0, "new": 2.5}
        log = build.apply_proven(cell, [edit], "Model X", "Databricks", regional_uplift=True)
        self.assertEqual((cell["in"], cell["variants"][0]["in"], cell["pricing_checked_at"]), (2.5, 2.75, "2026-10-09"))
        self.assertEqual(len(log), 1)
        self.assertEqual(build.apply_proven(cell, [edit], "Model X", "Databricks", regional_uplift=True), [])
        moved = {"in": 3.0}
        self.assertEqual(build.apply_proven(moved, [edit], "Model X", "Fireworks"), [])
        self.assertEqual(moved["in"], 3.0)

    def test_quiet_changes_dates_in_identifiers_dbu_wording_and_named_qwen_tiers(self):
        rx = review.model_regex({"name": "Claude Opus 5"})
        base = ["table: Claude Opus 5 | Global CRIS | $5.00 | $25.00"]
        beta = 'table: {"cells":["Yes","compact-2026-09-04"],"heading":"Claude Opus 5 / Capabilities and Features"}'
        self.assertEqual(review.classify(base, base + [beta], rx)[0], "low")
        qwen_flash = 'table: {"cells":["32K<Token≤256K","$0.100","$0.400"],"heading":"Text generation - Qwen / Qwen-Flash / US (Virginia)"}'
        self.assertTrue(review.names_a_model(qwen_flash, []))
        config = [{"id": "dbu", "url": "u", "meta": ["dbx_prop"], "facts": "dbx-prices"}]
        data = {"models": {"g/pro": {"name": "Gemini 3.1 Pro", "platforms": {"databricks": {"status": "priced", "src": "dbx_prop"}}}}}
        before = ['table: {"cells":["Gemini 3.0 Pro, 3.1 Pro*","Short context","35.714","214.286"]}']
        after = ['table: {"cells":["Gemini 3.1 Pro*","Short context","35.714","214.286"]}']
        cells, changes = review.cell_checks(data, config, {"sources": {"dbu": {"records": before}}}, {"dbu": {"url": "u", "records": after}}, {}, {}, None, dt.date(2026, 10, 9))
        self.assertEqual((changes[0]["risk"], cells["g/pro|databricks"]["verified"]), ("low", "2026-10-09"))

    def test_a_platform_starting_or_stopping_a_model_is_flagged_on_the_card_not_in_the_issue(self):
        config = [{"id": "p", "url": "u", "kind": "tables", "meta": ["src"]}]
        data = {"models": {"m/x": {"name": "Model X", "platforms": {"bedrock": {"status": "unavailable", "src": "src"}}}}}
        baseline = {"sources": {"p": {"records": ["table: Other 1 | $1.00"]}}, "acknowledged_lifecycle": []}
        current = {"p": {"url": "u", "kind": "tables", "digest": "x", "records": ["table: Other 1 | $1.00", "table: Model X | $2.00 | $8.00"]}}
        cells, changes = review.cell_checks(data, config, baseline, current, {}, {}, None, dt.date(2026, 10, 10))
        self.assertEqual((changes[0]["risk"], changes[0]["reason"]), ("quiet", review.APPEARS))
        self.assertTrue(cells["m/x|bedrock"]["quiet"])
        text, review_list = review.issue_markdown({"checked_at": "2026-10-10", "sources_failed": {}, "lifecycle_due": []}, cells, changes, {}, data, {"m/x"}, [])
        self.assertEqual(review_list, [])
        self.assertNotIn("Model X", text)
        # Its lines stay unreviewed, so the card keeps its flag until someone updates the data.
        out = review.accept_low_risk(baseline, current, changes, {}, [])
        self.assertEqual(out["sources"]["p"]["records"], ["table: Other 1 | $1.00"])

    def test_databricks_pricing_a_pending_model_is_added_from_its_dbu_table(self):
        data = {"models": {"a/h": {"name": "Claude Haiku 5.5", "platforms": {"databricks": {"status": "unverified", "available": True, "src": "dbx_prop"}}}}}
        facts = {"claude haiku 5.5": {"regional": True, "standard": {"short context": {"in": 0.10003, "out": 0.50001, "cache_read": 0.01001}}}}
        found = review.dbx_check(data, facts, dt.date(2026, 10, 10))["a/h"]
        self.assertTrue(review.dbx_availability(found[0][0]))
        edits = review.proven_edits(data, [], {"dbx-models": {"records": ["endpoint: databricks-claude-haiku-5-5"]}},
                                    review.dbx_edits(data, facts, dt.date(2026, 10, 10)), [])
        self.assertEqual((edits[0]["offer"], edits[0]["rates"], edits[0]["model_id"], edits[0]["regional"]),
                         ("new", {"in": 0.1, "out": 0.5, "cache_read": 0.01}, "databricks-claude-haiku-5-5", True))
        spec = importlib.util.spec_from_file_location("build_data", HERE / "build-data.py")
        build = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(build)
        cell = dict(data["models"]["a/h"]["platforms"]["databricks"])
        build.new_offer(cell, dict(edits[0], date="2026-10-10"), "Claude Haiku 5.5", {"dbx_prop": {"url": "https://example.com"}})
        self.assertEqual((cell["status"], cell["in"], cell["model_id"], [v["label"] for v in cell["variants"]]),
                         ("priced", 0.1, "databricks-claude-haiku-5-5", ["Regional processing ⌖ +10%"]))

    def test_bedrock_region_lines_come_from_the_model_card(self):
        card = ('<table><tr><th>Region</th><th>In-Region</th><th>Geo</th><th>Global</th></tr>'
                + "".join(f'<tr><td>{code} (x)</td>' + "".join(f'<td><img src="/i/icon-{"yes" if m == "y" else "no"}.png"></td>' for m in marks) + "</tr>"
                          for code, marks in [("us-east-1", "nyy"), ("us-west-2", "nyy"), ("eu-west-1", "yyy"), ("ap-east-2", "nny"), ("ap-northeast-1", "nny")])
                + "</table>")
        marks = review.official.bedrock_marks(card)
        self.assertEqual(review.official.bedrock_regions(marks), [
            ["Americas", ["geo", "global"], ["US CRIS", "Global CRIS"], "N. Virginia, Oregon"],
            ["Europe", "in-region", "In-region", "Ireland"], ["Europe", ["geo", "global"], ["EU CRIS", "Global CRIS"], "Ireland"],
            ["APAC", "global", "Global CRIS", "Taipei (ap-east-2), Tokyo"]])
        self.assertEqual(review.official.bedrock_hk_tw(marks), (["none", "No Bedrock endpoint in Hong Kong (ap-east-1)"],
                                                                ["routed", "Taipei (ap-east-2) through global cross-region inference only"]))


if __name__ == "__main__":
    unittest.main()
