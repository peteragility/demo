#!/usr/bin/env python3
"""Order the v2 page by the arena.ai ranking named in ranking-config.json; publishes order only, never prices.

The page shows the reviewed models in arena's top 50 that a compared platform hosts, in rank
order. A model leaves the page when it drops out of the top 50 and returns when it is back.
Writes ../v2-ranking.json only when the listed models or their ranks change.
Exit 0 = ranking current (written or unchanged), 1 = source or parser failure (file untouched).
"""
import argparse
import datetime as dt
import json
from pathlib import Path
import re
import sys
import urllib.request
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
TARGET = HERE.parent / "v2-ranking.json"
CHUNK = re.compile(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)</script>', re.S)


def normalize(name):
    return re.sub(r"\s+", " ", re.sub(r"[-_]", " ", name.lower())).strip()


def board_entries(html, board_id):
    """The leaderboard entries embedded in the page's Next.js flight data."""
    payload = "".join(json.loads('"' + chunk + '"') for chunk in CHUNK.findall(html))
    start = payload.find('{"pills":')
    if start < 0:
        raise ValueError("Leaderboard pills not found; the page format may have changed.")
    pills, _ = json.JSONDecoder().raw_decode(payload[start:])
    board = next((p for p in pills.get("pills", []) if p.get("id") == board_id), None)
    if not board:
        raise ValueError("Leaderboard " + board_id + " not found on the page.")
    entries = board.get("entries") or []
    for e in entries:
        if not isinstance(e.get("rank"), int) or not isinstance(e.get("modelDisplayName"), str):
            raise ValueError("Unexpected leaderboard entry shape.")
    return entries


def rank_models(entries, patterns):
    """Best arena rank per priced model; an entry may match one model only."""
    compiled = {key: re.compile(p) for key, p in patterns.items()}
    models, unmatched = {}, []
    for e in sorted(entries, key=lambda x: x["rank"]):
        name = normalize(e["modelDisplayName"])
        hits = [key for key, rx in compiled.items() if rx.search(name)]
        if len(hits) > 1:
            raise ValueError(f"{e['modelDisplayName']!r} matches several models: {hits}")
        if not hits:
            unmatched.append(e)
        elif hits[0] not in models:
            models[hits[0]] = {"rank": e["rank"], "arena": e["modelDisplayName"]}
    return models, unmatched


def build(config, html, today, previous=None):
    entries = board_entries(html, config["board_id"])
    if len(entries) < config.get("minimum_entries", 1):
        raise ValueError(f"Only {len(entries)} leaderboard entries; refusing to reorder the page.")
    entries = [e for e in entries if e["rank"] <= config.get("top", len(entries))]
    models, unmatched = rank_models(entries, config["models"])
    if not models:
        raise ValueError("No priced model is ranked; refusing to empty the page.")
    ranking = dict(schema=1, source=config["source"], board=config["board"], board_url=config["board_url"],
                   ranked_at=today, top=config.get("top"), entries=len(entries), models=dict(sorted(models.items(), key=lambda kv: kv[1]["rank"])))
    # Keep the previous date when nothing the page uses has changed.
    if previous and {k: v for k, v in previous.items() if k not in ("ranked_at", "entries")} == \
            {k: v for k, v in ranking.items() if k not in ("ranked_at", "entries")}:
        ranking["ranked_at"], ranking["entries"] = previous["ranked_at"], previous["entries"]
    return ranking, unmatched


def report(ranking, previous, unmatched, config):
    old = (previous or {}).get("models", {})
    lines = [f"# LLM pricing v2 model order", "", f"{config['board']} on {config['source']}: "
             f"{len(ranking['models'])} priced models ranked of {ranking['entries']} entries.", ""]
    moves = []
    for key, m in ranking["models"].items():
        before = old.get(key, {}).get("rank")
        if before is None:
            moves.append(f"- {m['arena']}: added at #{m['rank']}")
        elif before != m["rank"]:
            moves.append(f"- {m['arena']}: #{before} → #{m['rank']}")
    moves += [f"- {v['arena']}: no longer ranked (hidden)" for k, v in old.items() if k not in ranking["models"]]
    lines += ["## Changes", ""] + (moves or ["No change in the page order."]) + [""]
    if unmatched:
        lines += [f"## In the top {config.get('top')} but not reviewed for the page", "",
                  "List one once a compared platform hosts it: add verified pricing in build-data.py and a pattern in ranking-config.json.", ""]
        lines += [f"- #{e['rank']} {e['modelDisplayName']} ({e.get('modelOrganization', '')})" for e in unmatched]
        lines.append("")
    return "\n".join(lines)


def events(ranking, previous, unmatched, config):
    """What the review issue reports: top-N models not reviewed for the page and not already known
    (known_unlisted in ranking-config.json), and listed models that left the top N."""
    known = set(config.get("known_unlisted", []))
    new = [dict(rank=e["rank"], name=e["modelDisplayName"], maker=e.get("modelOrganization", "")) for e in unmatched if e["modelDisplayName"] not in known]
    old = (previous or {}).get("models", {})
    left = [dict(key=k, name=v.get("arena") or k) for k, v in old.items() if k not in ranking["models"]]
    return dict(top=config.get("top"), unreviewed=new, left=left)


def check(config):
    """Validate the published ranking against the priced models (used by CI on push)."""
    ranking = json.loads(TARGET.read_text())
    data = json.loads((HERE.parent / "v2-data.json").read_text())
    problems = []
    if ranking.get("schema") != 1 or not ranking.get("models"):
        problems.append("Ranking file is empty or has an unknown schema.")
    ranks = [m.get("rank") for m in ranking.get("models", {}).values()]
    if any(not isinstance(r, int) or r < 1 for r in ranks) or len(set(ranks)) != len(ranks):
        problems.append("Ranks must be unique positive integers.")
    for key in ranking.get("models", {}):
        if key not in data["models"]:
            problems.append(key + " is ranked but has no pricing data.")
        if key not in config["models"]:
            problems.append(key + " is ranked but has no pattern in ranking-config.json.")
    missing = [k for k in data["models"] if k not in config["models"]]
    if missing:
        problems.append("No ranking pattern for: " + ", ".join(missing))
    try:
        dt.date.fromisoformat(ranking.get("ranked_at", ""))
    except ValueError:
        problems.append("Invalid ranked_at date.")
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate v2-ranking.json; fetch nothing.")
    parser.add_argument("--html", type=Path, help="Use a saved leaderboard page instead of fetching it.")
    parser.add_argument("--summary", type=Path, help="Append the Markdown report to this file (e.g. $GITHUB_STEP_SUMMARY).")
    parser.add_argument("--events", type=Path, help="Write the top-N models to review (see events()) as JSON for review-sources.py.")
    parser.add_argument("--as-of", default=dt.datetime.now(ZoneInfo("Asia/Hong_Kong")).date().isoformat(), help="Run date (default: today in Hong Kong).")
    args = parser.parse_args()
    config = json.loads((HERE / "ranking-config.json").read_text())
    if args.check:
        problems = check(config)
        if problems:
            raise SystemExit("\n".join(problems))
        print("v2-ranking.json matches the priced models.")
        return
    if args.html:
        html = args.html.read_text()
    else:
        request = urllib.request.Request(config["source"], headers={"User-Agent": "LLM-Pricing-Ranking/1.0 (+https://github.com/peteragility/demo)"})
        with urllib.request.urlopen(request, timeout=30) as response:
            html = response.read(30 * 1024 * 1024).decode("utf-8")
    previous = json.loads(TARGET.read_text()) if TARGET.exists() else None
    try:
        ranking, unmatched = build(config, html, args.as_of, previous)
    except ValueError as error:
        print("Ranking not updated: " + str(error), file=sys.stderr)
        sys.exit(1)
    text = report(ranking, previous, unmatched, config)
    print(text)
    if args.events:
        args.events.write_text(json.dumps(events(ranking, previous, unmatched, config), ensure_ascii=False, indent=1) + "\n")
    if args.summary:
        with open(args.summary, "a") as summary:
            summary.write(text + "\n")
    if ranking != previous:
        TARGET.write_text(json.dumps(ranking, ensure_ascii=False, indent=1) + "\n")
        print("Wrote " + TARGET.name)


if __name__ == "__main__":
    main()
