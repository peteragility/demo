#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import unittest

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
        entries = [entry(n + 1, f"Unpriced model {n}") for n in range(25)] + [entry(30, "Kimi K3 (Max)")]
        first, _ = ranking.build(CONFIG, page(entries), "2026-10-03")
        again, _ = ranking.build(CONFIG, page(entries), "2026-10-04", first)
        self.assertEqual(again, first)
        moved = [entry(n + 1, f"Unpriced model {n}") for n in range(25)] + [entry(26, "Kimi K3 (Max)")]
        later, _ = ranking.build(CONFIG, page(moved), "2026-10-05", first)
        self.assertEqual((later["ranked_at"], later["models"]["moonshot/kimi-k3"]["rank"]), ("2026-10-05", 26))


if __name__ == "__main__":
    unittest.main()
