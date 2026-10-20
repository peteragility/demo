#!/usr/bin/env python3
import datetime as dt
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("source_review", HERE / "review-sources.py")
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


class SourceReviewTests(unittest.TestCase):
    def test_gpt_version_suffix_cannot_match_a_predecessor(self):
        for name, own, other in [('GPT-6 Sol', 'gpt-6-sol', 'gpt-5.6-sol'),
                                 ('GPT-6 Luna', 'gpt-6-luna', 'gpt-5.6-luna')]:
            rx = review.model_regex(dict(name=name))
            self.assertTrue(rx.search(own))
            self.assertFalse(rx.search(other))
        self.assertTrue(review.names_a_model('Muse Spark Open $1.25 / $4.25', []))

    def test_base_verification_expiry_remains_due_without_published_future_rates(self):
        data = dict(models={'m': dict(name='GPT-5.6 Sol', platforms={'official': dict(valid_through='2026-11-21')})})
        alerts = review.time_alerts(data, dt.date(2027, 1, 1))
        self.assertEqual(len(alerts), 1)
        self.assertEqual(len(review.due_alerts(alerts, [])), 1)

    def test_kimi_empty_markdown_uses_literal_official_html_table(self):
        code = ('DocTable,{columns:[{title:`Model`},{title:`Unit`},{title:`Input`}],'
                'rows:[[ `kimi-k3`,`1M tokens`,_jsxs(_Fragment,{children:[`$`,`3.00`]})]]}')
        code = code.replace('[[ `', '[[`')
        html = '<script>self.__next_f.push(' + json.dumps([1, code]) + ')</script>'
        source = dict(id="kimi-pricing", url="https://platform.kimi.ai/docs/pricing/chat.md", kind="markdown")
        with patch.object(review, "read_url", side_effect=['# Pricing\n<tbody />', html]) as read:
            records = review.markdown_records(review.fetch(source))
        self.assertIn('$3.00', ' '.join(records))
        self.assertEqual(read.call_args_list[1].args[0], source['url'].removesuffix('.md'))
        for bad in ('<html>Unavailable</html>', html.replace('1M tokens', '1M tokens`,`extra'),
                    html.replace('3.00', '${process.env.SECRET}')):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                review.kimi_html_tables(bad)

    def test_bedrock_unprefixed_feature_lists_are_not_price_headers(self):
        row = lambda cells: 'table: ' + review.packed(dict(heading='Claude Fable 5.1 / Capabilities and Features', cells=cells))
        before = row(['Response streaming Prompt caching Count tokens', 'Guardrails Agents'])
        after = row(['Response streaming Prompt caching Count tokens', 'Guardrails Agents Structured outputs'])
        self.assertEqual(review.classify([before], [after], None)[0], 'low')
        self.assertEqual(review.classify([before], [row(['Input $3', 'Output $15'])], None)[0], 'high')

    def test_temporary_preview_exclusion_expires_without_hiding_discovery(self):
        models = [dict(name="Muse Spark Open (Max)", rank=50)]
        current = {"fireworks-us": {"records": ["Muse Spark Open (Max)"]}}
        skip = [dict(name=models[0]["name"], through="2026-10-29")]
        self.assertEqual(review.unpriced_on_platforms(models, current, skip, dt.date(2026, 10, 29)), [])
        found = review.unpriced_on_platforms(models, current, skip, dt.date(2026, 10, 30))
        self.assertEqual(found, [dict(models[0], sources=["fireworks-us"])])
        for deadline in (None, "", "tomorrow", "2026-02-30"):
            with self.subTest(deadline=deadline):
                skip[0]["through"] = deadline
                self.assertEqual(review.unpriced_on_platforms(models, current, skip, dt.date(2026, 10, 20)), found)

    def test_checkpoint_upgrade_requires_review_even_with_unchanged_alias_and_prices(self):
        model = {"name": "DeepSeek V4.1 Flash", "platforms": {"official": {"status": "priced", "src": "src", "in": 0.3, "out": 1.2}}}
        rx = review.model_regex(model)
        row = lambda version: 'table: ' + review.packed({"heading": "Models & Pricing", "cells": ["MODEL VERSION", version, "DeepSeek-V4-Pro-0813"]})
        original = row("DeepSeek-V4.1-Flash")
        for checkpoint in ("1017", "20261017"):
            after = row("DeepSeek-V4.1-Flash-" + checkpoint)
            self.assertTrue(rx.search(review.official.norm(after)))
            risk, reason = review.classify([original], [after], rx)
            self.assertEqual(risk, "high")
            self.assertIn("model checkpoint/version", reason)
            config = [{"id": "prices", "meta": ["src"]}]
            data = {"models": {"d/flash": model}}
            baseline = {"sources": {"prices": {"records": [original]}}}
            current = {"prices": {"url": "u", "records": [after]}}
            cells, changes = review.cell_checks(data, config, baseline, current, {}, {}, None, dt.date(2026, 10, 17))
            self.assertEqual(cells["d/flash|official"]["sources"], ["prices"])
            self.assertNotIn("quiet", cells["d/flash|official"])
            accepted = review.accept_low_risk(baseline, current, changes, {}, [])
            self.assertEqual(accepted["sources"]["prices"]["records"], [original])
            self.assertEqual(review.proven_edits(data, changes, current, {}, config), [])

    def test_checkpoint_changes_removals_and_other_model_wording(self):
        rx = review.model_regex({"name": "DeepSeek V4.1 Flash"})
        self.assertEqual(review.classify(["text: DeepSeek-V4.1-Flash-1001"], ["text: DeepSeek-V4.1-Flash-1017"], rx)[0], "high")
        self.assertEqual(review.classify(["text: DeepSeek-V4.1-Flash-1017"], ["text: DeepSeek-V4.1-Flash"], rx)[0], "high")
        self.assertEqual(review.classify(["text: DeepSeek-V4.1-Flash-1017 is available"], ["text: DeepSeek V4.1 Flash 1017 is now available"], rx)[0], "low")
        self.assertFalse(rx.search("deepseek-v4.1-flash-2"))
        self.assertFalse(rx.search("deepseek-v4.1-flash-lite"))
        self.assertEqual(review.classify(["text: DeepSeek V4.1 Flash replaces DeepSeek V4 Pro 0813"], ["text: DeepSeek V4.1 Flash replaces DeepSeek V4 Pro 1017"], rx)[0], "low")

    def test_checkpoint_dataset_mismatch_survives_an_already_recorded_baseline(self):
        data = {"models": {"d/flash": {"name": "DeepSeek V4.1 Flash", "platforms": {"official": {
            "status": "priced", "src": "src", "snapshot": "DeepSeek-V4.1-Flash"}}}}}
        config = [{"id": "prices", "meta": ["src"]}]
        records = ['table: ' + review.packed({"cells": ["MODEL VERSION", "DeepSeek-V4.1-Flash-1017"]})]
        current = {"prices": {"url": "u", "records": records}}
        baseline = {"sources": current}
        cells, changes = review.cell_checks(data, config, baseline, current, {}, {}, None, dt.date(2026, 10, 17))
        self.assertEqual(changes[0]["risk"], "high")
        self.assertIn("dataset snapshot", changes[0]["reason"])
        self.assertIn("changed_at", cells["d/flash|official"])
        data["models"]["d/flash"]["platforms"]["official"]["snapshot"] += "-1017"
        cells, changes = review.cell_checks(data, config, baseline, current, {}, {}, None, dt.date(2026, 10, 17))
        self.assertEqual(changes, [])
        self.assertEqual(cells["d/flash|official"]["verified"], "2026-10-17")

    def test_explicit_usd_label_keeps_rates_units_and_assignments(self):
        def row(cells):
            return "table: " + review.packed(dict(heading="Fast mode pricing", cells=cells))
        before = row(["Claude Opus 5.5", "$8 / MTok", "$40 / MTok"])
        after = row(["Claude Opus 5.5", "$8 USD / MTok", "$40 USD / MTok"])
        self.assertEqual(review.classify([before], [after], None)[0], "low")
        for cells in (["Claude Opus 5.5", "$9 USD / MTok", "$40 USD / MTok"],
                      ["Claude Opus 5.5", "$40 USD / MTok", "$8 USD / MTok"],
                      ["Claude Opus 5.5", "$8 EUR / MTok", "$40 EUR / MTok"],
                      ["Claude Opus 5.5", "$8 USD / 1K tokens", "$40 USD / 1K tokens"]):
            self.assertEqual(review.classify([before], [row(cells)], None)[0], "high")

    def test_deepseek_standalone_request_table_does_not_change_token_review(self):
        config = json.loads((HERE / "source-config.json").read_text())
        source = next(s for s in config if s["id"] == "deepseek-pricing")
        def page(token_price, request_price):
            return (f'<h2>Models &amp; Pricing</h2><h3>Model Details</h3>'
                    f'<table><tr><td>DeepSeek-V4.1-Flash input</td><td>${token_price}</td></tr></table>'
                    f'<h3>Search &amp; Fetch Pricing \u200b</h3>'
                    f'<table><tr><td>Search</td><td>Per 1,000 successful requests</td><td>${request_price}</td></tr></table>')
        snapshots = []
        for token, request in (("0.3", "0.75"), ("0.3", "1.00"), ("0.4", "1.00")):
            with patch.object(review, "fetch", return_value=page(token, request)):
                snapshots.append(review.collect_one(source))
        self.assertEqual(snapshots[0], snapshots[1])
        self.assertEqual(len(snapshots[0]["records"]), 1)
        self.assertEqual(review.classify(snapshots[0]["records"], snapshots[2]["records"], None)[0], "high")
        with patch.object(review, "fetch", return_value=page("0.3", "0.75").split('<h3>Model Details</h3>')[0] +
                          '<h3>Search &amp; Fetch Pricing</h3><table><tr><td>Search</td><td>$0.75</td></tr></table>'):
            with self.assertRaises(ValueError):
                review.collect_one(source)

    def test_region_review_preserves_an_explicit_variant_price_date(self):
        offer = dict(label="Data Zone US", **{"in": 3, "out": 15}, pricing_checked_at="2026-10-04")
        self.assertEqual(review.build_data.make_variant(offer, "2026-10-15")["pricing_checked_at"], "2026-10-04")
        offer.pop("pricing_checked_at")
        self.assertEqual(review.build_data.make_variant(offer, "2026-10-15")["pricing_checked_at"], "2026-10-15")

    def test_arena_outage_keeps_cached_new_model_discovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "discovery.json"
            path.write_text(json.dumps(dict(schema=1, checked_at="2026-10-14", last_successful_read="2026-10-13",
                error="HTTP 403", models=[dict(rank=9, name="gemini-4-argon-high", maker="Google")])))
            models, status = review.ranking_discovery(path, dt.date(2026, 10, 14))
            self.assertEqual(status["last_successful_read"], "2026-10-13")
            self.assertEqual(status["error"], "HTTP 403")
            current = {"vertex-pricing": {"records": ["Gemini 4 Argon input $2, output $10"]},
                       "google-pricing": {"records": ["Gemini 4 Argon input $2, output $10"]}}
            found = review.unpriced_on_platforms(models, current, [])
            self.assertEqual(found[0]["sources"], ["vertex-pricing"])
            report = {"checked_at": "2026-10-14", "sources_failed": {}, "lifecycle_due": [],
                      "ranking": status, "ranking_error": status["error"]}
            issue, _ = review.issue_markdown(report, {}, [], {}, {"models": {}}, set(), failing=[], new_models=found)
            self.assertIn("gemini-4-argon-high", issue)
            self.assertIn("HTTP 403", issue)

    def test_missing_corrupt_or_stale_discovery_report_requires_review(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "discovery.json"
            self.assertIn("error", review.ranking_discovery(path, dt.date(2026, 10, 14))[1])
            for text in ("{", "[]", json.dumps(dict(schema=1, checked_at="2026-10-13", last_successful_read="2026-10-13", models=[])),
                         json.dumps(dict(schema=1, checked_at="2026-10-14", last_successful_read="2026-10-14", models=["invalid"]))):
                path.write_text(text)
                self.assertIn("error", review.ranking_discovery(path, dt.date(2026, 10, 14))[1])
            path.write_text(json.dumps(dict(schema=1, checked_at="2026-10-14", last_successful_read="2026-10-14", models=[])))
            self.assertNotIn("error", review.ranking_discovery(path, dt.date(2026, 10, 14))[1])

    def test_workflow_fails_after_reporting_an_arena_outage(self):
        workflow = (HERE.parent.parent / ".github/workflows/llm-pricing-v2-review.yml").read_text()
        self.assertIn("if: inputs.record_baseline && steps.ranking.outcome == 'success'", workflow)
        step = workflow.split("      - name: Require a successful Arena ranking check\n", 1)[1]
        script = textwrap.dedent(step.split("        run: |\n", 1)[1])
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "llm-pricing-v2-unpriced.json"
            (Path(tmp) / "python").symlink_to(sys.executable)
            env = dict(os.environ, RUNNER_TEMP=tmp, PATH=tmp + os.pathsep + os.environ.get("PATH", ""))
            day = dt.datetime.now(review.HKT).date().isoformat()
            path.write_text(json.dumps(dict(schema=1, checked_at=day, last_successful_read=day, models=[])))
            for outcome, code in (("success", 0), ("failure", 1), ("skipped", 1), ("", 1)):
                result = subprocess.run(["bash", "-e", "-c", script], cwd=HERE.parent,
                    env=dict(env, RANKING_OUTCOME=outcome), capture_output=True)
                self.assertEqual(result.returncode, code, result.stderr)
            path.unlink()
            result = subprocess.run(["bash", "-e", "-c", script], cwd=HERE.parent,
                env=dict(env, RANKING_OUTCOME="success"), capture_output=True)
            self.assertNotEqual(result.returncode, 0, "A missing report cannot finish green")
        self.assertLess(workflow.index("- name: Open, update or close the review issue"), workflow.index("- name: Require a successful Arena ranking check"))

    def test_failed_arena_read_is_in_the_review_issue(self):
        report = {"checked_at": "2026-10-14", "sources_failed": {}, "lifecycle_due": [],
                  "ranking_error": "HTTP Error 403: Forbidden"}
        issue, refs = review.issue_markdown(report, {}, [], {}, {"models": {}}, set(), failing=[])
        self.assertIn("Arena ranking could not be checked", issue)
        self.assertIn("403", issue)
        self.assertEqual(refs, [])

    @staticmethod
    def context_offer():
        cell = {"status": "priced", "src": "src", "in": 2, "out": 10,
                "long_context": {"in": 4, "out": 15}, "context_threshold": 272000,
                "variants": [{"label": "Priority", "service_tier": "priority", "comparison_scope": "global",
                              "in": 4, "out": 20, "long_context": {"in": 8, "out": 30, "cache_read": 0.4, "cache_write": 10, "cache_write_1h": 16}}]}
        data = {"models": {"m/x": {"name": "Model X", "platforms": {"databricks": cell}}}}
        facts = {"Model X": {"regional": False, "standard": {"short context": {"in": 2, "out": 10}, "long context": {"in": 4, "out": 15}},
                             "priority": {"short context": {"in": 4, "out": 20}, "long context": copy.deepcopy(cell["variants"][0]["long_context"])}}}
        return data, facts

    def test_priority_long_context_changes_apply_before_verification(self):
        for field in ("in", "out", "cache_read", "cache_write", "cache_write_1h"):
            with self.subTest(field=field):
                data, facts = self.context_offer()
                cell = data["models"]["m/x"]["platforms"]["databricks"]
                old = facts["Model X"]["priority"]["long context"][field]
                facts["Model X"]["priority"]["long context"][field] = old + 1
                today = dt.date(2026, 10, 11)
                record = lambda price: 'table: ' + review.packed({"heading": "Model X Priority", "cells": ["Long context", f"${price}"]})
                config = [{"id": "dbu", "facts": "dbx-prices", "meta": ["src"]}]
                baseline = {"sources": {"dbu": {"records": [record(old)]}}}
                current = {"dbu": {"url": "u", "records": [record(old + 1)]}}
                issues = review.dbx_fact_issues(data, facts, today)
                self.assertIn("Priority long-context " + field, issues["m/x"][0])
                cells, changes = review.cell_checks(data, config, baseline, current, {}, issues, None, today)
                self.assertEqual(changes[0]["risk"], "high")
                self.assertIn("changed_at", cells["m/x|databricks"])
                self.assertEqual(review.accept_low_risk(baseline, current, changes, {}, [])["sources"]["dbu"]["records"], [record(old)])
                edits = review.dbx_edits(data, facts, today)["m/x"]
                self.assertEqual(edits, [{"offer": "variant:Priority/long_context", "field": field, "old": old, "new": old + 1}])
                review.build_data.apply_proven(cell, [dict(e, date=today.isoformat()) for e in edits], "Model X", "Databricks")
                self.assertEqual(review.dbx_fact_issues(data, facts, today), {})
                done = {("m/x", "databricks", "dbx-prices"): "applied"}
                cells, changes = review.cell_checks(data, config, baseline, current, {}, {}, None, today, applied=done)
                self.assertEqual(cells["m/x|databricks"]["verified"], today.isoformat())
                self.assertEqual(review.accept_low_risk(baseline, current, changes, {}, [])["sources"], current)

    def test_missing_context_bands_and_rates_stay_for_review(self):
        for tier, field, side in (("standard", None, "table"), ("priority", None, "table"),
                                  ("priority", "cache_read", "table"), ("priority", "cache_read", "page"),
                                  ("standard", None, "page"), ("priority", None, "page")):
            with self.subTest(tier=tier, field=field, side=side):
                data, facts = self.context_offer()
                cell = data["models"]["m/x"]["platforms"]["databricks"]
                target = facts["Model X"][tier] if side == "table" else cell if tier == "standard" else cell["variants"][0]
                band = "long context" if side == "table" else "long_context"
                del (target[band] if field else target)[field or band]
                today = dt.date(2026, 10, 11)
                issues = review.dbx_fact_issues(data, facts, today)
                self.assertTrue(issues["m/x"])
                self.assertFalse(any(review.dbx_availability(text) for text in issues["m/x"]))
                self.assertEqual(review.dbx_edits(data, facts, today), {})
                report = {"checked_at": today.isoformat(), "sources_failed": {}, "lifecycle_due": []}
                issue, _ = review.issue_markdown(report, {}, [], issues, data, {"m/x"}, failing=[])
                self.assertIn("Databricks prices that differ from its DBU tables", issue)
                self.assertIn("**Model X**", issue)
                if side == "table":
                    self.assertEqual(review.dbx_fact_issues(data, facts, today, complete=False), {})

    def test_priority_context_promotion_checks_current_and_future_rates(self):
        data, facts = self.context_offer()
        priority = data["models"]["m/x"]["platforms"]["databricks"]["variants"][0]
        after = {"in": 5, "out": 25, "long_context": {field: value * 1.25 for field, value in priority["long_context"].items()}}
        priority["promotion"] = {"ends_on": "2026-10-11", "after": after}
        self.assertEqual(review.dbx_fact_issues(data, facts, dt.date(2026, 10, 11)), {})
        self.assertTrue(review.dbx_fact_issues(data, facts, dt.date(2026, 10, 12)))
        self.assertEqual(review.dbx_edits(data, facts, dt.date(2026, 10, 12)), {})
        facts["Model X"]["priority"] = {"short context": {"in": 5, "out": 25}, "long context": after["long_context"]}
        for day in (11, 12):
            self.assertEqual(review.dbx_fact_issues(data, facts, dt.date(2026, 10, day)), {})

    def test_conflicting_sources_cannot_resolve_a_partially_applied_change(self):
        row = lambda cells: 'table: ' + review.packed({"heading": "Model X pricing", "cells": cells})
        header = row(["Model", "Input", "Output"])
        old = row(["Model X", "$1", "$2"])
        data = {"models": {"m/x": {"name": "Model X", "platforms": {"official": {"status": "priced", "src": "src", "in": 1, "out": 2, "cache_read": 0.1}}}}}
        config = [{"id": sid, "meta": ["src"]} for sid in ("s1", "s2", "cache")]
        baseline = {"sources": {sid: {"records": [header, old]} for sid in ("s1", "s2")}}
        baseline["sources"]["cache"] = {"records": [row(["Model X cache read", "$0.1"])]}
        current = {sid: {"url": "u", "records": [header, row(["Model X", f"${price}", "$4"])]} for sid, price in (("s1", 2), ("s2", 3))}
        current["cache"] = {"url": "u", "records": [row(["Model X cache read", "$0.2"])]}
        today = dt.date(2026, 10, 11)
        cells, changes = review.cell_checks(data, config, baseline, current, {}, {}, None, today)
        edits = review.proven_edits(data, changes, current, {}, config)
        self.assertEqual([(e["source"], e["field"]) for e in edits], [("cache", "cache_read")])
        cell = data["models"]["m/x"]["platforms"]["official"]
        review.build_data.apply_proven(cell, [dict(e, date=today.isoformat()) for e in edits], "Model X", "official")
        done = {(e["model"], e["platform"], e["source"]): "applied" for e in edits}
        cells, changes = review.cell_checks(data, config, baseline, current, {}, {}, None, today, applied=done)
        self.assertEqual(cells["m/x|official"]["sources"], ["s1", "s2"])
        self.assertEqual([c["risk"] for c in changes if c["source"] != "cache"], ["high", "high"])
        report = {"checked_at": today.isoformat(), "sources_failed": {}, "lifecycle_due": []}
        issue, refs = review.issue_markdown(report, cells, changes, {}, data, {"m/x"}, failing=[])
        self.assertEqual(refs, ["m/x|official"])
        self.assertIn("$3", issue)
        updated = review.accept_low_risk(baseline, current, changes, {}, [])
        for sid in ("s1", "s2"):
            self.assertCountEqual(updated["sources"][sid]["records"], baseline["sources"][sid]["records"])
        self.assertEqual(updated["sources"]["cache"], current["cache"])
        self.assertEqual((cell["in"], cell["out"]), (1, 2))
        # Once both sources agree, their complete changes can be applied and accepted.
        current["s2"] = dict(current["s1"])
        cells, changes = review.cell_checks(data, config, updated, current, {}, {}, None, today)
        edits = review.proven_edits(data, changes, current, {}, config)
        self.assertEqual({e["source"] for e in edits}, {"s1", "s2"})
        review.build_data.apply_proven(cell, [dict(e, date=today.isoformat()) for e in edits], "Model X", "official")
        done = {(e["model"], e["platform"], e["source"]): "applied" for e in edits}
        cells, changes = review.cell_checks(data, config, updated, current, {}, {}, None, today, applied=done)
        self.assertEqual(cells["m/x|official"]["verified"], today.isoformat())
        self.assertEqual((cell["in"], cell["out"]), (2, 4))
        self.assertEqual(review.accept_low_risk(updated, current, changes, {}, [])["sources"], current)
        self.assertEqual(review.issue_markdown(report, cells, changes, {}, data, {"m/x"}, failing=[])[1], [])

    def test_real_automatic_price_updates_keep_daily_calculation_tests_passing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            maintenance = root / "maintenance"
            maintenance.mkdir()
            for name in ("v2-data.json", "v2-math.js"):
                shutil.copy2(HERE.parent / name, root / name)
            for name in ("build-data.py", "validate-data.py", "seed-data.json", "verified-ids.json", "endpoints.json",
                         "endpoints-auto.json", "prices-auto.json", "pricing.test.cjs", "pricing-fixtures.json"):
                shutil.copy2(HERE / name, maintenance / name)
            data = json.loads((root / "v2-data.json").read_text())
            kimi = data["models"]["moonshot/kimi-k3"]["platforms"]["databricks"]
            sol = data["models"]["openai/gpt-6.1-sol"]["platforms"]["databricks"]
            priority = next(v for v in sol["variants"] if v["service_tier"] == "priority" and v["comparison_scope"] == "global")
            edits = [{"model": "moonshot/kimi-k3", "platform": "databricks", "source": "dbx-prices", "offer": "base",
                      "field": "out", "old": kimi["out"], "new": kimi["out"] + 1},
                     {"model": "openai/gpt-6.1-sol", "platform": "databricks", "source": "dbx-prices",
                      "offer": "variant:" + priority["label"] + "/long_context", "field": "in",
                      "old": priority["long_context"]["in"], "new": priority["long_context"]["in"] + 1}]
            with patch.object(review, "HERE", maintenance), patch.object(review, "AUTO_FILE", maintenance / "prices-auto.json"):
                self.assertEqual(review.apply_edits(edits, dt.date(2026, 10, 11)), edits)
            rebuilt = json.loads((root / "v2-data.json").read_text())
            regional = next(v for v in rebuilt["models"]["openai/gpt-6.1-sol"]["platforms"]["databricks"]["variants"]
                            if v["service_tier"] == "priority" and v["comparison_scope"] == "regional")
            self.assertEqual(regional["long_context"]["in"], round(edits[1]["new"] * 1.1, 6))
            result = subprocess.run(["node", "--test", str(maintenance / "pricing.test.cjs")], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_overdue_tier_findings_stay_due_until_resolved(self):
        cell = {"variants": [{"valid_through": "2026-10-11", "promotion": {"ends_on": "2026-10-11"}}], "retires_on": "2026-10-11"}
        data = {"models": {"m/k3": {"name": "Kimi K3", "platforms": {"official": cell}}}}
        baseline = {"sources": {}}
        for day in ("2026-10-04", "2026-10-11", "2026-10-19", "2026-11-12", "2027-10-11"):
            report = review.make_report(baseline, {}, {}, data, dt.date.fromisoformat(day))
            action = [a for a in report["lifecycle_due"] if review.needs_action(a)]
            self.assertEqual(len(action), 1, day)
            text, _ = review.issue_markdown(report, {}, [], {}, data, {"m/k3"}, failing=[])
            self.assertIn("Tier rates expiring within 7 days or overdue", text)
            self.assertIn("2026-10-11", text)
            acknowledged = dict(baseline, acknowledged_lifecycle=[review.alert_key(action[0])])
            self.assertFalse(any(review.needs_action(a) for a in review.make_report(acknowledged, {}, {}, data, dt.date.fromisoformat(day))["lifecycle_due"]))
        self.assertEqual(review.make_report(baseline, {}, {}, data, dt.date(2026, 10, 3))["lifecycle_due"], [])
        cell["variants"][0]["valid_through"] = "2027-12-31"
        self.assertEqual(review.make_report(baseline, {}, {}, data, dt.date(2026, 11, 12))["lifecycle_due"], [])

    def test_shared_pricing_findings_survive_failed_runs_and_clear_after_review(self):
        before = ["text: Kimi K3 input $3 output $15", "notice: US-only inference is priced at 1.1x"]
        after = [before[0], "notice: US-only inference is priced at 1.2x"]
        snapshot = {"url": "https://example.test/pricing", "kind": "text", "records": after, "digest": "new"}
        data = {"models": {"m/k3": {"name": "Kimi K3", "platforms": {"official": {"status": "priced", "src": "src",
                                                                                     "pricing_checked_at": "2026-10-01"}}}}}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            maintenance = root / "maintenance"
            maintenance.mkdir()
            (maintenance / "source-config.json").write_text(json.dumps([{"id": "p", "kind": "text", "meta": ["src"]}]))
            (maintenance / "source-baseline.json").write_text(json.dumps({"sources": {"p": dict(snapshot, records=before, digest="old")}}))
            (maintenance / "ranking-config.json").write_text(json.dumps({"not_sold": []}))
            (root / "v2-data.json").write_text(json.dumps(data))
            checks, issue = root / "checks.json", root / "issue.md"
            def run(day, failed=False, record=False):
                argv = ["review-sources.py", "--as-of", day, "--report-dir", str(root / "report"),
                        "--checks", str(checks), "--issue", str(issue), "--accept-low-risk"]
                if record:
                    argv.append("--record-baseline")
                with patch.object(review, "HERE", maintenance), patch.object(review.sys, "argv", argv), \
                        patch.object(review, "collect_one", side_effect=ValueError("HTTP 503") if failed else None, return_value=dict(snapshot)), redirect_stdout(io.StringIO()):
                    if failed:
                        with self.assertRaises(SystemExit) as stopped:
                            review.main()
                        self.assertEqual(stopped.exception.code, 1)
                    else:
                        review.main()
            run("2026-10-11")
            # Accepting an unrelated model's lines in the same source must not resolve
            # its still-unreviewed shared multiplier when the next read fails.
            baseline_path = maintenance / "source-baseline.json"
            baseline = json.loads(baseline_path.read_text())
            baseline["sources"]["p"]["records"].append("text: DeepSeek-V3.2 input $2 output $4")
            baseline_path.write_text(json.dumps(baseline))
            for day, failed in (("2026-10-12", True), ("2026-10-13", True), ("2026-10-14", False)):
                run(day, failed=failed)
                saved = json.loads(checks.read_text())
                self.assertEqual(len(saved["pending_general"]), 1)
                finding = saved["pending_general"][0]
                self.assertEqual(finding["added_all"], [after[1]])
                self.assertEqual(finding["removed_all"], [before[1]])
                self.assertIn("1.2x", issue.read_text())
                self.assertIn("1.1x", issue.read_text())
                self.assertNotEqual(saved["cells"]["m/k3|official"]["verified"], day)
            # Explicitly reviewing the new baseline resolves the finding, even if the
            # next read fails before the updated checks have been published.
            run("2026-10-14", record=True)
            run("2026-10-15", failed=True)
            self.assertEqual(json.loads(checks.read_text())["pending_general"], [])
            self.assertEqual(issue.read_text(), "")
            run("2026-10-15")
            self.assertEqual(issue.read_text(), "")
            self.assertEqual(json.loads(checks.read_text())["cells"]["m/k3|official"], {"verified": "2026-10-15"})

    def test_record_baseline_acknowledges_long_overdue_tier_dates(self):
        data = {"models": {"m/k3": {"name": "Kimi K3", "platforms": {"official": {"variants": [{"valid_through": "2026-10-11"}]}}}}}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            maintenance = root / "maintenance"
            maintenance.mkdir()
            (maintenance / "source-config.json").write_text("[]")
            (root / "v2-data.json").write_text(json.dumps(data))
            argv = ["review-sources.py", "--as-of", "2027-10-11", "--report-dir", str(root / "report"), "--record-baseline"]
            with patch.object(review, "HERE", maintenance), patch.object(review.sys, "argv", argv), redirect_stdout(io.StringIO()):
                review.main()
            baseline = json.loads((maintenance / "source-baseline.json").read_text())
            self.assertEqual(baseline["acknowledged_lifecycle"], ["m/k3|official|tier rates verified through|2026-10-11"])

    def test_issue_step_requires_a_completed_report_and_handles_empty_or_open_reports(self):
        workflow = (HERE.parent.parent / ".github/workflows/llm-pricing-v2-review.yml").read_text()
        step = workflow.split("      - name: Open, update or close the review issue\n", 1)[1].split("      - name: Save the full report", 1)[0]
        self.assertIn("if: ${{ !cancelled() }}", step)
        script = textwrap.dedent(step.split("        run: |\n", 1)[1])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            gh = root / "gh"
            calls = root / "calls.jsonl"
            gh.write_text('#!' + review.sys.executable + '\n' + textwrap.dedent('''\
                import json, os, sys
                from pathlib import Path
                with Path(os.environ['ISSUE_TEST_CALLS']).open('a') as f:
                    f.write(json.dumps(sys.argv[1:]) + '\\n')
                if sys.argv[1:3] == ['issue', 'list']:
                    print(os.environ.get('ISSUE_TEST_NUMBER', '7'))
                elif sys.argv[1:3] == ['issue', 'view']:
                    print('Old review body')
                '''))
            gh.chmod(0o755)
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ.get("PATH", ""), RUNNER_TEMP=str(root), ISSUE_TEST_CALLS=str(calls))
            subprocess.run(["bash", "-e", "-o", "pipefail", "-c", script], env=env, check=True, capture_output=True, text=True)
            self.assertFalse(calls.exists(), "An incomplete review cannot modify an issue")
            issue = root / "llm-pricing-v2-issue.md"
            for body, action, number in (("Daily check 2026-10-11\nUnresolved pricing change", "edit", "7"),
                                         ("", "close", "7"), ("New review finding", "create", "")):
                issue.write_text(body)
                env["ISSUE_TEST_NUMBER"] = number
                subprocess.run(["bash", "-e", "-o", "pipefail", "-c", script], env=env, check=True, capture_output=True, text=True)
                commands = [json.loads(line) for line in calls.read_text().splitlines()]
                self.assertTrue(any(c[:2] == ["issue", action] for c in commands))
                calls.unlink()

    def test_price_swaps_keep_their_columns_and_tiers_pending(self):
        def row(tier, rates):
            return 'table: ' + review.packed({"heading": "Kimi K3 pricing", "cells": [tier, *rates]})
        before = [row("Standard", ["$3", "$15"]), row("Priority", ["$6", "$30"])]
        cases = [[row("Standard", ["$15", "$3"]), before[1]],
                 [row("Standard", ["$6", "$30"]), row("Priority", ["$3", "$15"])]]
        config = [{"id": "prices", "meta": ["src"]}]
        data = {"models": {"m/k3": {"name": "Kimi K3", "platforms": {"official": {"status": "priced", "src": "src"}}}}}
        baseline = {"sources": {"prices": {"records": before}}}
        for after in cases:
            current = {"prices": {"url": "u", "records": after, "digest": "new"}}
            cells, changes = review.cell_checks(data, config, baseline, current, {}, {}, None, dt.date(2026, 10, 11))
            self.assertEqual(changes[0]["risk"], "high")
            self.assertEqual(cells["m/k3|official"]["changed_at"], "2026-10-11")
            accepted = review.accept_low_risk(baseline, current, changes, {}, [])
            self.assertEqual(set(accepted["sources"]["prices"]["records"]), set(before))
        self.assertEqual(review.classify(["text: Kimi K3 input $3, output $15"],
                                         ["text: Kimi K3 input $15, output $3"], review.model_regex({"name": "Kimi K3"}))[0], "high")
        self.assertEqual(review.classify([row("Model", ["Input", "Output"])],
                                         [row("Model", ["Output", "Input"])], None)[0], "high")

    def test_json_prices_keep_integer_rates_fields_and_units(self):
        before = {"productName": "Kimi K3", "meterName": "Input", "retailPrice": 3, "unitOfMeasure": "1M"}
        for after in (dict(before, retailPrice=4), dict(before, unitOfMeasure="1K"), dict(before, meterName="Output")):
            self.assertEqual(review.classify([review.packed(before)], [review.packed(after)], None)[0], "high")
        self.assertEqual(review.classify([review.packed({"input": "$3", "output": "$15"})],
                                         [review.packed({"input": "$15", "output": "$3"})], None)[0], "high")

    def test_cache_retention_wording_keeps_duration_and_rate_assignment(self):
        def row(duration):
            return "table: " + review.packed({"heading": "GPT-6.1 Sol / Pricing / short context (272K)",
                                              "cells": ["Input", f"Input — {duration} cache write", "Output"]})
        notice = "notice: The Input — 30-minute cache write column is the price per 1 million tokens written to the prompt cache."
        self.assertEqual(review.compare([row("30m")], [row("30-minute"), notice], None)[0], "low")
        self.assertEqual(review.compare([row("30-minute")], [row("60-minute")], None)[0], "high")
        self.assertEqual(review.compare(["text: Context limit 30m tokens"], ["text: Context limit 60m tokens"], None)[0], "high")

    def test_capability_tables_do_not_assign_output_prices(self):
        def row(status):
            return "table: " + review.packed({"heading": "Gemini 3.8 Flash", "cells": ["Capabilities",
                "Structured output Supported Context caching Supported Agentic video understanding " + status]})
        self.assertEqual(review.compare([row("preview Preview feature Not supported")], [row("Supported")], None)[0], "low")
        for old, new in (("$3", "$4"), ("272K", "128K")):
            self.assertEqual(review.compare([row(old)], [row(new)], None)[0], "high")

    def test_cyber_and_non_text_model_prices_are_scoped_separately(self):
        rx = review.model_regex({"name": "Gemini 3.8 Flash"})
        self.assertFalse(rx.search("gemini 3.8 flash cyber"))
        self.assertTrue(rx.search("gemini 3.8 flash *"))
        for name in ("HappyHorse-Video editing", "happyhorse-1.0-video-edit", "Qwen-Audio-TTS"):
            self.assertTrue(review.names_a_model(name, []), name)
        config = [{"id": "p", "kind": "tables"}]
        row = lambda price: "table: " + review.packed({"heading": "Video generation / HappyHorse-Video editing / Japan (Tokyo)",
                                                     "cells": ["1080P", price]})
        before, after = [row("$0.22/second (20% off)")], [row("$0.22/second")]
        self.assertEqual(review.general_changes({"models": {}}, config,
            {"sources": {"p": {"records": before}}}, {"p": {"url": "u", "records": after}}, {}), [])

    def test_endpoint_model_versions_are_not_decimal_rates(self):
        record = "table: " + review.packed({"heading": "GPT-5.5 / Programmatic access",
            "cells": ["bedrock-runtime", "openai.gpt-5.5", "us.openai.gpt-5.5", "global.openai.gpt-5.5"]})
        self.assertEqual(review.risk_tokens(record, review.model_regex({"name": "GPT-5.5"})), set())
        rate = "table: " + review.packed({"heading": "GPT-5.5 / Pricing", "cells": ["Input", "$5.50"]})
        self.assertTrue(any(t.startswith("price:assignment:") for t in review.risk_tokens(rate, review.model_regex({"name": "GPT-5.5"}))))

    def test_empty_trailing_table_columns_are_layout_only(self):
        def row(cells):
            return "table: " + review.packed({"heading": "Claude Opus 4.6 / Pricing", "cells": cells})
        before = [row(["Input", "$5.50", "$5.50"]), row(["Output", "$27.50", "$27.50"])]
        # Responsive tabs can retain an old row and add its padded duplicate.
        after = before + [row(["Input", "$5.50", "$5.50", "", ""]), row(["Output", "$27.50", "$27.50", "", ""])]
        self.assertEqual(review.classify(before, after, None)[0], "low")
        for changed in (["Input", "$5.50", "$6", "", ""], ["Input", "", "$5.50", "$5.50"]):
            self.assertEqual(review.classify(before, [row(changed), before[1]], None)[0], "high")

    def test_bedrock_features_and_modality_headers_are_not_price_columns(self):
        def row(heading, cells):
            return "table: " + review.packed({"heading": heading, "cells": cells})
        for heading, cells in (
            ("Grok 4.6 / Capabilities and Features",
             ["yes Response streaming yes Implicit Prompt Caching yes Reasoning",
              "no Server-side tool use no Count tokens no Structured outputs"]),
            ("Kimi K3 / Capabilities and Features",
             ["yes Response streaming yes Explicit Prompt Caching yes Structured outputs yes Invocation logs",
              "no Intelligent prompt routing no Knowledge base"]),
        ):
            with self.subTest(heading=heading):
                self.assertEqual(review.classify([row(heading, cells)],
                                                [row(heading, [cells[0] + " yes Guardrails", cells[1]])], None)[0], "low")
        before = row("Claude Opus 4.8 / Model Details", ["Input Modalities", "Output Modalities"])
        after = row("Claude Opus 4.8 / Model Details / Important", ["Input Modalities", "Output Modalities"])
        self.assertEqual(review.classify([before], [after], None)[0], "low")
        # Feature tables still require review when a numeric rate or context limit changes.
        for old, new in (("$3", "$4"), ("272K", "128K")):
            self.assertEqual(review.classify([row("Capabilities", ["yes Structured outputs " + old])],
                                            [row("Capabilities", ["yes Structured outputs " + new])], None)[0], "high")

    def test_low_risk_shared_wording_does_not_block_offer_verification(self):
        data = {"models": {"m/k3": {"name": "Kimi K3", "platforms": {"bedrock": {
            "status": "priced", "src": "src", "endpoints": {"src": ["regions"]}}}}}}
        config = [{"id": "card", "meta": ["src"], "models": ["m/k3"]},
                  {"id": "regions", "meta": ["regions"], "kind": "text"}]
        records = ["text: Kimi K3 input $3, output $15"]
        baseline = {"sources": {"card": {"records": records},
                                "regions": {"records": ["text: Endpoints supported by Amazon Bedrock"]}}}
        current = {"card": {"url": "u", "records": records},
                   "regions": {"url": "u", "records": ["text: Inference endpoints supported by Amazon Bedrock"]}}
        general = review.general_changes(data, config, baseline, current, {})
        self.assertEqual(general[0]["risk"], "low")
        previous = {"cells": {"m/k3|bedrock": {"verified": "2026-10-11", "changed_at": "2026-10-12",
                                               "sources": ["card"], "unchecked": ["regions"]}}}
        cells, changes = review.cell_checks(data, config, baseline, current, {}, {}, previous,
                                           dt.date(2026, 10, 12), general)
        self.assertEqual(cells["m/k3|bedrock"], {"verified": "2026-10-12"})

    def test_current_price_diff_is_not_reported_as_unreadable(self):
        data = {"models": {"m/k3": {"name": "Kimi K3", "platforms": {"bedrock": {}}}}}
        ref = "m/k3|bedrock"
        cells = {ref: {"changed_at": "2026-10-12", "sources": ["prices"], "unchecked": ["regions"]}}
        changes = [{"model": "m/k3", "name": "Kimi K3", "platform": "bedrock", "source": "prices",
                    "url": "u", "risk": "high", "reason": "price changed", "added": ["$4"], "removed": ["$3"]}]
        report = {"checked_at": "2026-10-12", "sources_failed": {"regions": "HTTP 503"}}
        text, pending = review.issue_markdown(report, cells, changes, {}, data, {"m/k3"}, failing=[])
        self.assertEqual(pending, [ref])
        self.assertIn("price changed", text)
        self.assertNotIn("Unresolved changes that could not be rechecked", text)
        # An earlier finding from another source must remain visible through a failed read.
        cells[ref]["sources"].append("old-prices")
        cells[ref]["unchecked"].append("old-prices")
        report["sources_failed"]["old-prices"] = "HTTP 503"
        text, _ = review.issue_markdown(report, cells, changes, {}, data, {"m/k3"}, failing=[])
        self.assertIn("Unresolved changes that could not be rechecked", text)
        self.assertIn("old-prices", text)

    def test_failed_reads_preserve_findings_until_the_affected_source_recovers(self):
        key = "m/k3|official"
        data = {"models": {"m/k3": {"name": "Kimi K3", "platforms": {"official": {"status": "priced", "src": "src",
                                                                                      "pricing_checked_at": "2026-10-01"}}}}}
        config = [{"id": "prices", "meta": ["src"]}]
        records = ["text: Kimi K3 input $3, output $15"]
        baseline = {"sources": {"prices": {"records": records}}}
        previous = {"cells": {key: {"verified": "2026-10-01", "changed_at": "2026-10-10", "sources": ["prices"]}}}
        for quiet in (False, True):
            prior = {"cells": {key: dict(previous["cells"][key], **({"quiet": True} if quiet else {}))}}
            cells, changes = review.cell_checks(data, config, baseline, {}, {"prices": "HTTP 503"}, {}, prior, dt.date(2026, 10, 11))
            self.assertEqual(cells[key], dict(prior["cells"][key], unchecked=["prices"]))
            text, pending = review.issue_markdown({"checked_at": "2026-10-11", "sources_failed": {"prices": "HTTP 503"}},
                                               cells, changes, {}, data, {"m/k3"}, failing=[])
            self.assertEqual(pending, [] if quiet else [key])
            if not quiet:
                self.assertIn("Unresolved changes that could not be rechecked", text)
                self.assertIn("Kimi K3", text)
        current = {"prices": {"url": "u", "records": records}}
        cells, _ = review.cell_checks(data, config, baseline, current, {}, {}, previous, dt.date(2026, 10, 11))
        self.assertEqual(cells[key], {"verified": "2026-10-11"})
        # A resolved price warning clears even while an unrelated region source fails.
        config.append({"id": "regions", "meta": ["region"]})
        data["models"]["m/k3"]["platforms"]["official"]["endpoints"] = {"src": ["region"], "checked_at": "2026-10-11"}
        cells, _ = review.cell_checks(data, config, baseline, current, {"regions": "HTTP 503"}, {}, previous, dt.date(2026, 10, 11))
        self.assertNotIn("changed_at", cells[key])

    def test_logical_databricks_findings_survive_physical_source_failures(self):
        data = {"models": {"m/k3": {"name": "Kimi K3", "platforms": {"databricks": {"status": "priced", "src": "src"}}}}}
        config = [{"id": "dbu", "meta": ["src"], "facts": "dbx-prices"}]
        prior = {"cells": {"m/k3|databricks": {"verified": "2026-10-01", "changed_at": "2026-10-10", "sources": ["dbx-prices"]}}}
        cells, _ = review.cell_checks(data, config, {}, {}, {"dbu": "HTTP 503"}, {}, prior, dt.date(2026, 10, 11))
        self.assertEqual(cells["m/k3|databricks"], dict(prior["cells"]["m/k3|databricks"], unchecked=["dbu"]))

    def test_region_dates_cannot_verify_an_unreadable_price(self):
        cell = {"status": "priced", "src": "src", "pricing_checked_at": "2026-10-01",
                "endpoints": {"src": ["region"], "checked_at": "2026-10-11"}}
        data = {"models": {"m/k3": {"name": "Kimi K3", "platforms": {"official": cell}}}}
        config = [{"id": "prices", "meta": ["src"]}, {"id": "regions", "meta": ["region"]}]
        baseline = {"sources": {"regions": {"records": ["text: Kimi K3 supported in US"]}}}
        current = {"regions": dict(baseline["sources"]["regions"], url="u")}
        for previous, expected in ((None, "2026-10-01"), ({"cells": {"m/k3|official": {"verified": "2026-10-10"}}}, "2026-10-10")):
            cells, _ = review.cell_checks(data, config, baseline, current, {"prices": "HTTP 503"}, {}, previous, dt.date(2026, 10, 11))
            self.assertEqual(cells["m/k3|official"], {"verified": expected, "unchecked": ["prices"]})

    def test_slashes_in_existing_tier_labels_and_long_context_paths(self):
        build = review.build_data
        data = json.loads((HERE.parent / "v2-data.json").read_text())
        for model in data["models"].values():
            for cell in model["platforms"].values():
                for v in cell.get("variants", []):
                    self.assertIs(build.find_offer(cell, "variant:" + v["label"])[0], v)
        cell = data["models"]["openai/gpt-6-astra"]["platforms"]["azure_foundry"]
        v = next(v for v in cell["variants"] if v["label"] == "Data Zone EU / APAC · Standard")
        row = lambda values: 'table: ' + review.packed({"heading": "GPT-6 Astra pricing", "cells": values})
        header = row(["Model / Tier", "Input", "Output"])
        old = row(["GPT-6 Astra Data Zone EU / APAC Standard", "$12.00", "$60.00"])
        new = row(["GPT-6 Astra Data Zone EU / APAC Standard", "$13.00", "$60.00"])
        edits = review.row_edits({"added_all": [new], "removed_all": [old]}, cell, [header, new])
        self.assertEqual(len(edits), 1)
        self.assertEqual(len(build.apply_proven(cell, [dict(edits[0], date="2026-10-11")], "GPT-6 Astra", "Azure")), 1)
        self.assertEqual(v["in"], 13)
        v["long_context"] = {"in": 24, "out": 120}
        edit = {"offer": "variant:" + v["label"] + "/long_context", "field": "in", "old": 24, "new": 26, "date": "2026-10-11"}
        self.assertEqual(len(build.apply_proven(cell, [edit], "GPT-6 Astra", "Azure")), 1)
        self.assertEqual(v["long_context"]["in"], 26)

    def test_successful_build_cannot_accept_an_edit_that_did_not_reach_its_target(self):
        edit = {"model": "m/k3", "platform": "official", "offer": "base", "field": "in", "old": 3, "new": 4}
        data = {"models": {"m/k3": {"platforms": {"official": {"status": "priced", "in": 3}}}}}
        self.assertFalse(review.applied_rates_match(data, [edit]))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            maintenance = root / "maintenance"
            maintenance.mkdir()
            auto = maintenance / "prices-auto.json"
            original = {"changes": []}
            auto.write_text(json.dumps(original))
            (root / "v2-data.json").write_text(json.dumps(data))
            with patch.object(review, "HERE", maintenance), patch.object(review, "AUTO_FILE", auto), \
                    patch.object(review.subprocess, "run", return_value=review.subprocess.CompletedProcess([], 0)):
                self.assertEqual(review.apply_edits([edit], dt.date(2026, 10, 11)), [])
            self.assertEqual(json.loads(auto.read_text()), original)
        data["models"]["m/k3"]["platforms"]["official"]["in"] = 4
        self.assertTrue(review.applied_rates_match(data, [edit]))

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
        for line in ["Claude Opus 5 | $5", "Claude Opus 5.5 Pro", "Claude Opus 4.5, 4.6, 5",
                     "claude-opus-5-5-fast", "Claude Opus 5.5 Fast | $8"]:
            self.assertFalse(rx.search(review.official.norm(line)), line)
        glm = review.model_regex({"name": "GLM 5.3"})
        self.assertTrue(glm.search(review.official.norm("glm-5.3 | $1.40")))
        self.assertFalse(glm.search(review.official.norm("GLM 5.3 Flash | $0.15")))
        # Variant suffixes that name different models must not match the text model,
        # even when a page heading wraps the pair ("... / Gemini 3.8 Flash TTS / Standard").
        flash = review.model_regex({"name": "Gemini 3.8 Flash"})
        for line in ["Gemini 3.8 Flash TTS / Standard | $0.125 input caching",
                     "table: {\"heading\":\"Gemini Developer API pricing / Gemini 3.8 Flash TTS / Standard\"}",
                     "Gemini 3.8 Flash Audio | $1", "Gemini 3.8 Flash Live | $1"]:
            self.assertFalse(flash.search(review.official.norm(line)), line)
        self.assertTrue(flash.search(review.official.norm("Gemini 3.8 Flash | $0.75")))
        gemini_tts = review.model_regex({"name": "Gemini 3.8 Flash TTS"})
        self.assertTrue(gemini_tts.search(review.official.norm("Gemini 3.8 Flash TTS / Standard | $0.125")))

    def test_fast_endpoint_does_not_change_base_offer_review(self):
        row = lambda name, context: 'table: ' + review.packed({
            "heading": "Anthropic / Subscription type and region support",
            "cells": [name, "Messages", f"Context window: {context}"]})
        base = row("claude-opus-5-5", "1M")
        fast = row("claude-opus-5-5-fast", "1M")
        config = [{"id": "azure-partners", "kind": "tables", "meta": ["azure"]}]
        data = {"models": {"opus": {"name": "Claude Opus 5.5", "platforms": {
            "azure_foundry": {"status": "priced", "src": "azure"}}}}}
        baseline = {"sources": {"azure-partners": {"records": [base]}}}
        current = {"azure-partners": {"url": "https://learn.microsoft.com/", "records": [base, fast]}}
        today = dt.date(2026, 10, 16)
        cells, changes = review.cell_checks(data, config, baseline, current, {}, {}, None, today)
        self.assertEqual(changes, [])
        self.assertEqual(cells["opus|azure_foundry"], {"verified": today.isoformat()})
        self.assertEqual(review.general_changes(data, config, baseline, current, {}), [])
        # The same source must still flag a real change to the base model's context.
        current["azure-partners"]["records"] = [row("claude-opus-5-5", "2M"), fast]
        _, changes = review.cell_checks(data, config, baseline, current, {}, {}, None, today)
        self.assertEqual(changes[0]["risk"], "high")
        fast_rx = review.model_regex({"name": "Grok 4.1 Fast"})
        self.assertTrue(fast_rx.search(review.official.norm("grok-4-1-fast | $0.20")))
        # A service-tier heading before the base name remains monitored.
        self.assertTrue(review.model_regex({"name": "Claude Opus 5.5"}).search(
            review.official.norm("Fast mode pricing / Claude Opus 5.5 | $8 / MTok")))

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

    def test_null_in_model_label_does_not_drop_priority_rates_or_hide_a_rate_change(self):
        filler = "".join(f"<tr><td>Model {n}</td><td>1</td><td>2</td></tr>" for n in range(10))
        def table(tier, label, input_rate):
            return (f"<table><tr><th>Model</th><th>{tier} Pay Per Token</th></tr>"
                    "<tr><td>Input</td><td>Output</td></tr>"
                    f"<tr><td>{label}</td><td>{input_rate}</td><td>20</td></tr>{filler}</table>")
        html = table("Standard", "GPT-5.6 Luna *", 1) + table("Priority", "GPT-5.6 Luna \x00*", 2)
        rows = review.official.dbx_price_rows(html, 0.07)
        self.assertEqual(rows["gpt 5.6 luna"]["priority"][""]["in"], 0.14)
        cell = dict(status="priced", **{"in": 0.07, "out": 1.4}, variants=[
            dict(label="Priority", service_tier="priority", comparison_scope="global", **{"in": 0.14, "out": 1.4})])
        data = {"models": {"o/luna": {"name": "GPT-5.6 Luna", "platforms": {"databricks": cell}}}}
        self.assertEqual(review.dbx_fact_issues(data, rows, dt.date(2026, 10, 20)), {})
        rows = review.official.dbx_price_rows(html.replace("<td>2</td><td>20</td>", "<td>3</td><td>20</td>"), 0.07)
        self.assertIn("Priority in", review.dbx_fact_issues(data, rows, dt.date(2026, 10, 20))["o/luna"][0])

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

    def test_catalog_coverage_survives_unchanged_baseline_and_failed_reads(self):
        data = {"models": {"g/argon": {"name": "Gemini 4 Argon", "platforms": {
            "databricks": dict(status="unverified", available=None, model_id=None)}}}}
        snapshot = dict(url="https://example.test/catalog", kind="catalog", digest="same",
                        records=["endpoint: databricks-gemini-4-argon"])
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            maintenance = root / "maintenance"
            maintenance.mkdir()
            (maintenance / "source-config.json").write_text(json.dumps([
                dict(id="dbx-models", kind="catalog", meta=["dbx_models"])]))
            (maintenance / "source-baseline.json").write_text(json.dumps({"sources": {"dbx-models": snapshot}}))
            (maintenance / "ranking-config.json").write_text(json.dumps({"not_sold": []}))
            data_path = root / "v2-data.json"
            data_path.write_text(json.dumps(data))
            checks, issue = root / "checks.json", root / "issue.md"
            def run(record=False, failed=False):
                argv = ["review-sources.py", "--as-of", "2026-10-17", "--report-dir", str(root / "report"),
                        "--checks", str(checks), "--issue", str(issue), "--fail-on-change"]
                if record:
                    argv.append("--record-baseline")
                with patch.object(review, "HERE", maintenance), patch.object(review.sys, "argv", argv), \
                        patch.object(review, "ranking_discovery", return_value=([], {})), \
                        patch.object(review, "collect_one", return_value=copy.deepcopy(snapshot),
                                     side_effect=ValueError("HTTP 503") if failed else None), redirect_stdout(io.StringIO()):
                    if record:
                        review.main()
                    else:
                        with self.assertRaises(SystemExit) as stopped:
                            review.main()
                        self.assertEqual(stopped.exception.code, 1 if failed else 2)
            run()
            self.assertIn("Gemini 4 Argon", issue.read_text())
            self.assertEqual(json.loads(next((root / "report").glob("*.json")).read_text())["changes"], [])
            run(record=True)
            run()  # A newly recorded baseline cannot acknowledge away the dataset mismatch.
            self.assertIn("catalog / pricing gaps", issue.read_text())
            run(failed=True)
            self.assertTrue(json.loads(checks.read_text())["databricks_coverage"][0]["unchecked"])
            self.assertIn("previous finding retained", issue.read_text())
            self.assertEqual(json.loads(data_path.read_text()), data)  # Report-only audit.

    def test_catalog_coverage_checks_pending_prices_without_available_flag(self):
        data = {"models": {"g/argon": {"name": "Gemini 4 Argon", "platforms": {
            "databricks": dict(status="unverified", available=None, model_id=None)}}}}
        current = {"dbx-proprietary": dict(url="https://example.test/prices", records=[])}
        facts = {"gemini 4 argon": dict(standard={"": dict(**{"in": 4, "out": 20})})}
        found = review.dbx_coverage(data, current, facts, True)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["pricing"], "published")
        self.assertIn("DBU pricing", found[0]["reason"])
        data["models"]["g/argon"]["platforms"]["databricks"]["status"] = "priced"
        self.assertEqual(review.dbx_coverage(data, current, facts, True), [])

    def test_catalog_coverage_uses_exact_models_and_pay_per_token_regions(self):
        data = {"models": {"g/argon": {"name": "Gemini 4 Argon", "platforms": {
            "databricks": dict(status="unverified", available=None, model_id=None)}}}}
        endpoint = "databricks-gemini-4-argon"
        def snapshot(cells):
            return {"dbx-region-aws": dict(url="https://example.test/regions", records=[
                "table: " + review.packed(dict(cells=cells))])}
        self.assertEqual(review.dbx_coverage(data, snapshot(["us-east-1", "Not supported", endpoint]), {}, True), [])
        found = review.dbx_coverage(data, snapshot(["us-east-1", endpoint + " ⥂"]), {}, False)
        self.assertEqual(found[0]["endpoints"], [endpoint])
        self.assertIn("unreadable", found[0]["pricing"])
        current = {"dbx-models": dict(url="https://example.test/catalog", records=["endpoint: " + endpoint + "-cyber-permissive"])}
        self.assertEqual(review.dbx_coverage(data, current, {}, True), [])
        cell = data["models"]["g/argon"]["platforms"]["databricks"]
        cell.update(available=True, model_id=endpoint)
        self.assertEqual(review.dbx_coverage(data, snapshot(["us-east-1", endpoint]), {}, True), [])

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

    def test_a_new_top_model_a_platform_names_opens_the_issue_until_added(self):
        unpriced = [{"rank": 36, "name": "claude-opus-4-7-high", "maker": "Anthropic"}, {"rank": 35, "name": "step-5-preview-high", "maker": "StepFun"},
                    {"rank": 13, "name": "muse-spark-1.3-max", "maker": "Meta"}]
        current = {"dbx-models": {"records": ["endpoint: databricks-claude-opus-4-7"]},
                   "aws-card-glm-5-3": {"records": ["text: Step 5 - Run your first inference request"]},
                   "gcp-claude-opus-5-5": {"records": ["text: Muse Spark 1.3 is in Preview"]},
                   "api-other-step": {"records": ["table: step-5-preview | $1.00"]}}
        found = review.unpriced_on_platforms(unpriced, current, ["muse-spark-1.3-max"])
        # Opus 4.7 is on Databricks' model list; Step 5 only on its maker's page; Muse Spark is skipped (not_sold).
        self.assertEqual([(m["name"], m["sources"]) for m in found], [("claude-opus-4-7-high", ["dbx-models"])])
        text, _ = review.issue_markdown({"checked_at": "2026-10-10", "sources_failed": {}, "lifecycle_due": []}, {}, [], {}, {"models": {}}, set(), [], new_models=found)
        self.assertIn("#36 claude-opus-4-7-high", text)


if __name__ == "__main__":
    unittest.main()
