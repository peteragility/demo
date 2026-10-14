#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import unittest
import tempfile
import urllib.error
from unittest.mock import patch

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


class RankingTests(unittest.TestCase):
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
