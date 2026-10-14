#!/usr/bin/env python3
import importlib.util
import copy
import io
import json
from pathlib import Path
import unittest
import tempfile
import urllib.error
from unittest.mock import patch
from contextlib import redirect_stdout

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("update_ranking", HERE / "update-ranking.py")
ranking = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ranking)
CONFIG = json.loads((HERE / "ranking-config.json").read_text())


def page(entries, board_id=CONFIG["board_id"]):
    """A leaderboard page with its data split across Next.js flight chunks, as served."""
    flight = '40:["$","$L43",null,' + json.dumps({"pills": [{"id": "other", "entries": []}, {"id": board_id, "entries": entries}]}) + "]"
    escaped = json.dumps(flight)[1:-1]
    half = len(escaped) // 2
    while escaped[half - 1] == "\\":
        half += 1
    return "".join(f'<script>self.__next_f.push([1,"{part}"])</script>' for part in (escaped[:half], escaped[half:]))


def entry(rank, name):
    return {"rank": rank, "modelDisplayName": name, "modelOrganization": "x"}


def dataset_page(category="overall", offset=0, published="2026-10-13"):
    return dict(partial=False, num_rows_total=offset + 50, rows=[dict(row_idx=offset+n-1, truncated_cells=[],
        row=dict(rank=n, model_name="Kimi K3" if n == 30 else f"Unpriced model {n}", organization="x",
                 category=category, leaderboard_publish_date=published)) for n in range(1, 51)])


class RankingTests(unittest.TestCase):
    def test_official_export_selects_overall_and_paginates(self):
        first = dataset_page(category="frontend")
        first["num_rows_total"] = 100
        second = dataset_page(offset=50)
        with patch.object(ranking, "read_url", side_effect=[json.dumps(first), json.dumps(second)]) as read:
            entries, published = ranking.dataset_entries(CONFIG, "2026-10-14")
        self.assertEqual(published, "2026-10-13")
        self.assertEqual(len(entries), 50)
        self.assertEqual(entries[29]["modelDisplayName"], "Kimi K3")
        self.assertIn("offset=50", read.call_args_list[1].args[0])

    def test_stale_future_partial_or_ambiguous_exports_are_rejected(self):
        valid = dataset_page()
        bad = [dataset_page(published="2026-10-11"), dataset_page(published="2026-10-15"),
               dataset_page(category="coding"), dict(valid, partial=True), []]
        mixed = copy.deepcopy(valid); mixed["rows"][0]["row"]["leaderboard_publish_date"] = "2026-10-12"; bad.append(mixed)
        truncated = copy.deepcopy(valid); truncated["rows"][0]["truncated_cells"] = ["model_name"]; bad.append(truncated)
        duplicate = copy.deepcopy(valid); duplicate["rows"][-1]["row"]["rank"] = 1; bad.append(duplicate)
        short = copy.deepcopy(valid); short["rows"].pop(); short["num_rows_total"] = 49; bad.append(short)
        for page_data in bad:
            with self.subTest(data=page_data if not isinstance(page_data, dict) else page_data.get("partial")):
                with patch.object(ranking, "read_url", return_value=json.dumps(page_data)), self.assertRaises(ValueError):
                    ranking.dataset_entries(CONFIG, "2026-10-14")
        wrong = dict(CONFIG, dataset_source=CONFIG["dataset_source"].replace("config=webdev", "config=agent"))
        with self.assertRaisesRegex(ValueError, "Unexpected official"):
            ranking.dataset_entries(wrong, "2026-10-14")

    def test_export_restores_fresh_discovery_without_using_blocked_website(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target, observed, unpriced = [root/n for n in ("ranking.json", "observed.json", "unpriced.json")]
            with patch.object(ranking, "TARGET", target), patch.object(ranking, "OBSERVED", observed), patch.object(
                ranking, "read_url", return_value=json.dumps(dataset_page())) as read, patch.object(ranking.sys, "argv", [
                    "update-ranking.py", "--unpriced", str(unpriced), "--as-of", "2026-10-14"]), redirect_stdout(io.StringIO()):
                ranking.main()
            self.assertEqual(read.call_count, 1)
            self.assertTrue(read.call_args.args[0].startswith("https://datasets-server.huggingface.co/rows?"))
            status = json.loads(unpriced.read_text())
            self.assertNotIn("error", status)
            self.assertEqual(status["published_at"], "2026-10-13")
            self.assertEqual(status["last_successful_read"], "2026-10-14")
            self.assertTrue(status["models"])

    def test_older_export_cannot_replace_a_newer_observation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target, observed, unpriced = [root/n for n in ("ranking.json", "observed.json", "unpriced.json")]
            observed.write_text(json.dumps(dict(board_id="webdev", published_at="2026-10-14", checked_at="2026-10-14", entries=[])))
            with patch.object(ranking, "TARGET", target), patch.object(ranking, "OBSERVED", observed), patch.object(
                ranking, "read_url", side_effect=[json.dumps(dataset_page()), OSError("HTTP 403")]), patch.object(ranking.sys, "argv", [
                    "update-ranking.py", "--unpriced", str(unpriced), "--as-of", "2026-10-14"]):
                with self.assertRaises(SystemExit):
                    ranking.main()
            self.assertFalse(target.exists())
            self.assertIn("older than the last", json.loads(unpriced.read_text())["error"])

    def test_dataset_failure_can_use_a_valid_public_website_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target, observed, unpriced = [root/n for n in ("ranking.json", "observed.json", "unpriced.json")]
            entries = [entry(n, "Kimi K3" if n == 30 else f"Unpriced model {n}") for n in range(1, 51)]
            with patch.object(ranking, "TARGET", target), patch.object(ranking, "OBSERVED", observed), patch.object(
                ranking, "read_url", side_effect=[OSError("Dataset unavailable"), page(entries)]), patch.object(ranking.sys, "argv", [
                    "update-ranking.py", "--unpriced", str(unpriced), "--as-of", "2026-10-14"]), redirect_stdout(io.StringIO()):
                ranking.main()
            status = json.loads(unpriced.read_text())
            self.assertNotIn("error", status)
            self.assertEqual(status["source"], CONFIG["source"])
    def test_failed_read_keeps_ranking_and_reports_detection_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target, unpriced, summary = root / "ranking.json", root / "unpriced.json", root / "summary.md"
            target.write_text('{"ranked_at":"2026-10-09","models":{}}')
            original = target.read_text()
            with patch.object(ranking, "TARGET", target), patch.object(ranking.sys, "argv", [
                "update-ranking.py", "--unpriced", str(unpriced), "--summary", str(summary)]), patch.object(
                    ranking.urllib.request, "urlopen", side_effect=urllib.error.HTTPError(CONFIG["source"], 403, "Forbidden", {}, None)):
                with self.assertRaises(SystemExit) as stopped:
                    ranking.main()
                self.assertEqual(stopped.exception.code, 1)
            self.assertEqual(target.read_text(), original)
            self.assertIn("403", json.loads(unpriced.read_text())["error"])
            self.assertTrue(json.loads(unpriced.read_text())["models"], "Cached candidates remain available during an outage")
            self.assertIn("Arena ranking could not be checked", summary.read_text())

    def test_entries_are_read_from_split_flight_data(self):
        entries = ranking.board_entries(page([entry(1, "Claude Fable 5.1 (Max)")]), CONFIG["board_id"])
        self.assertEqual(entries[0]["modelDisplayName"], "Claude Fable 5.1 (Max)")

    def test_each_model_takes_its_best_rank_and_versions_do_not_collide(self):
        entries = [entry(2, "Claude Opus 5.5 (High)"), entry(7, "Claude Opus 5 (High)"), entry(9, "Claude Opus 5 (Max)"),
                   entry(48, "Inkling Small"), entry(49, "Inkling"), entry(17, "Deepseek V4.1 Flash (Max)"), entry(30, "GPT 5.5")]
        models, unmatched = ranking.rank_models(entries, CONFIG["models"])
        self.assertEqual(models["anthropic/claude-opus-5.5"]["rank"], 2)
        self.assertEqual(models["anthropic/claude-opus-5"]["rank"], 7)
        self.assertEqual(models["tml/inkling"]["rank"], 49)
        self.assertEqual(models["deepseek/deepseek-v4.1-flash"]["rank"], 17)
        self.assertNotIn("deepseek/deepseek-v4-flash", models)
        self.assertEqual([e["modelDisplayName"] for e in unmatched], ["Inkling Small"])

    def test_an_entry_matching_two_models_is_an_error(self):
        with self.assertRaises(ValueError):
            ranking.rank_models([entry(1, "Claude Opus 5")], {"a": "^claude opus", "b": "^claude"})

    def test_a_short_or_missing_board_never_reorders_the_page(self):
        with self.assertRaises(ValueError):
            ranking.build(CONFIG, page([entry(1, "Claude Fable 5.1")]), "2026-10-03")
        with self.assertRaises(ValueError):
            ranking.board_entries(page([entry(1, "Claude Fable 5.1")], "renamed"), "best-overall-agents")

    def test_unchanged_order_keeps_the_previous_date(self):
        entries = [entry(n, "Kimi K3 (Max)" if n == 30 else f"Unpriced model {n}") for n in range(1, 51)]
        first, _ = ranking.build(CONFIG, page(entries), "2026-10-03")
        again, _ = ranking.build(CONFIG, page(entries), "2026-10-04", first)
        self.assertEqual(again, first)
        moved = [entry(n, "Kimi K3 (Max)" if n == 26 else f"Unpriced model {n}") for n in range(1, 51)]
        later, _ = ranking.build(CONFIG, page(moved), "2026-10-05", first)
        self.assertEqual((later["ranked_at"], later["models"]["moonshot/kimi-k3"]["rank"]), ("2026-10-05", 26))

    def test_partial_or_duplicate_top50_is_rejected(self):
        full = [entry(n, "Kimi K3" if n == 30 else f"Unpriced model {n}") for n in range(1, 51)]
        for entries in (full[:-1], full[:8] + full[9:], full[:-1] + [full[0]]):
            with self.assertRaisesRegex(ValueError, "Incomplete or duplicate"):
                ranking.build(CONFIG, page(entries), "2026-10-14")

    def test_successful_unchanged_read_advances_observation_date(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target, observed, unpriced, html = [root / n for n in ("ranking.json", "observed.json", "unpriced.json", "page.html")]
            entries = [entry(n, "Kimi K3" if n == 30 else f"Unpriced model {n}") for n in range(1, 51)]
            first, _ = ranking.build(CONFIG, page(entries), "2026-10-13")
            target.write_text(json.dumps(first));html.write_text(page(entries))
            with patch.object(ranking, "TARGET", target), patch.object(ranking, "OBSERVED", observed), patch.object(ranking.sys, "argv", [
                "update-ranking.py", "--html", str(html), "--unpriced", str(unpriced), "--as-of", "2026-10-14"]):
                ranking.main()
            self.assertEqual(json.loads(target.read_text())["ranked_at"], "2026-10-13")
            self.assertEqual(json.loads(observed.read_text())["checked_at"], "2026-10-14")
            self.assertEqual(json.loads(unpriced.read_text())["last_successful_read"], "2026-10-14")


if __name__ == "__main__":
    unittest.main()
