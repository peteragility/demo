#!/usr/bin/env python3
"""Refresh where models run from official region tables; publishes regions only, never prices.

Databricks publishes pay-per-token availability per region for AWS, Azure and Google Cloud. This
script turns those tables into the region lists the Databricks detail cards show and writes
endpoints-auto.json only when they change. (Other platforms' regions are reviewed in endpoints.json;
review-sources.py flags their source changes.) Exit 0 = current (written or unchanged), 1 = source or parser failure (file untouched).
"""
import argparse
import datetime as dt
import importlib.util
import json
from pathlib import Path
import sys
import urllib.request
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
TARGET = HERE / "endpoints-auto.json"
_spec = importlib.util.spec_from_file_location("official", HERE / "official.py")
official = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(official)

DBX_PAGES = {
    "aws": ("dbx_region", "https://docs.databricks.com/aws/en/unity-gateway/model-region-availability"),
    "azure": ("dbx_region_azure", "https://learn.microsoft.com/en-us/azure/databricks/unity-gateway/model-region-availability"),
    "gcp": ("dbx_region_gcp", "https://docs.databricks.com/gcp/en/unity-gateway/model-region-availability"),
}


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "LLM-Pricing-Source-Review/2.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read(20 * 1024 * 1024).decode("utf-8")


def read(name, url, cache_dir):
    return (cache_dir / name).read_text() if cache_dir else fetch(url)


def build(data, pages):
    """Region entries per Databricks endpoint, from its region tables."""
    per_cloud = {cloud: official.dbx_regions(html) for cloud, html in pages.items()}
    out = {"databricks": {}}
    for key, model in sorted(data["models"].items()):
        endpoint = model["platforms"]["databricks"].get("model_id")
        if endpoint and any(endpoint in regions for regions in per_cloud.values()):
            out["databricks"][key] = official.dbx_endpoint_regions(endpoint, per_cloud)
    return out


def bedrock_cards(config, specs, cache_dir, previous, as_of):
    """Bedrock regions, Hong Kong and Taiwan from each monitored model card whose curated card follows it
    (regions_from_card in endpoints.json). A card that cannot be read keeps its last entry."""
    found, failed = {}, []
    for source in config:
        models = source.get("models", [])
        if not source["id"].startswith("aws-card-") or len(models) != 1 or not specs.get(models[0], {}).get("bedrock", {}).get("regions_from_card"):
            continue
        key = models[0]
        try:
            marks = official.bedrock_marks(read(source["cache_file"], source["url"], cache_dir))
            if not marks:
                raise ValueError("no Region table on the model card")
            hk, tw = official.bedrock_hk_tw(marks)
            found[key] = dict(regions=official.bedrock_regions(marks), hk=hk, tw=tw, read_at=as_of)
        except Exception as error:
            failed.append(f"- bedrock · {key}: model card not read ({error}); regions unchanged")
            old = ((previous or {}).get("bedrock") or {}).get(key)
            if old:
                found[key] = old
    return found, failed


def changes(previous, current):
    """One line per model whose regions or HK / Taiwan state changed."""
    lines = []
    for platform in ("databricks", "bedrock"):
        old, new = (previous or {}).get(platform, {}), current.get(platform, {})
        for key in sorted(set(old) | set(new)):
            a, b = old.get(key), new.get(key)
            strip = lambda e: e and {k: v for k, v in e.items() if k not in ("changed_at", "missing_since", "read_at")}
            if a and a.get("missing_since") and b:
                lines.append(f"- {platform} · {key}: back in the region tables")
            if strip(a) == strip(b):
                continue
            if not a:
                lines.append(f"- {platform} · {key}: regions added")
            elif not b:
                lines.append(f"- {platform} · {key}: no longer in the region tables (regions kept)")
            else:
                # A line's level and label may be lists (one line for several endpoint types).
                row = lambda r: json.dumps(r, ensure_ascii=False)
                label = lambda r: " / ".join(r[2]) if isinstance(r[2], list) else r[2]
                came = [r for r in b["regions"] if row(r) not in {row(x) for x in a["regions"]}]
                gone = [r for r in a["regions"] if row(r) not in {row(x) for x in b["regions"]}]
                detail = [f"{r[0]} {label(r)}: {r[3]}" for r in came]
                detail += [f"{r[0]} {label(r)} removed: {r[3]}" for r in gone if (r[0], label(r)) not in {(x[0], label(x)) for x in came}]
                if a["hk"] != b["hk"]:
                    detail.append(f"HK {a['hk'][0]} → {b['hk'][0]}")
                if a["tw"] != b["tw"]:
                    detail.append(f"Taiwan {a['tw'][0]} → {b['tw'][0]}")
                lines.append(f"- {platform} · {key}: " + "; ".join(detail or ["notes changed"]))
    return lines


def carry(previous, current, models, as_of):
    """Dates each entry by its last change. A model that drops out of every table keeps its last regions and
    date until someone reviews it; missing_since puts it in the review issue."""
    for key, entry in ((previous or {}).get("databricks") or {}).items():
        if key not in current.get("databricks", {}) and key in models:
            current.setdefault("databricks", {})[key] = dict(entry, missing_since=entry.get("missing_since") or as_of)
    bare = lambda e: {k: v for k, v in e.items() if k not in ("changed_at", "missing_since", "read_at")}
    for platform in ("databricks", "bedrock"):
        for key, entry in current.get(platform, {}).items():
            old = ((previous or {}).get(platform) or {}).get(key)
            entry["changed_at"] = old["changed_at"] if old and bare(old) == bare(entry) else as_of
    return current


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, help="Read saved pages (dbx-aws.html, dbx-azure.html, dbx-gcp.html and the Bedrock model cards' cache files) instead of fetching.")
    parser.add_argument("--summary", type=Path, help="Append the Markdown report to this file (e.g. $GITHUB_STEP_SUMMARY).")
    parser.add_argument("--as-of", default=dt.datetime.now(ZoneInfo("Asia/Hong_Kong")).date().isoformat(), help="Run date (default: today in Hong Kong).")
    args = parser.parse_args()
    data = json.loads((HERE.parent / "v2-data.json").read_text())
    previous = json.loads(TARGET.read_text()) if TARGET.exists() else None
    try:
        pages = {cloud: read(f"dbx-{cloud}.html", url, args.cache_dir) for cloud, (_, url) in DBX_PAGES.items()}
        current = build(data, pages)
    except Exception as error:
        print("Regions not updated: " + str(error), file=sys.stderr)
        sys.exit(1)
    config = json.loads((HERE / "source-config.json").read_text())
    current["bedrock"], failed = bedrock_cards(config, json.loads((HERE / "endpoints.json").read_text()), args.cache_dir, previous, args.as_of)
    lines = changes(previous, current) + failed
    carry(previous, current, data["models"], args.as_of)
    current = dict(schema=1, note="Generated by update-endpoints.py from official region tables; do not edit.", **current)
    text = "\n".join(["# LLM pricing v2 regions", "", f"Databricks: {len(current['databricks'])} endpoints in the official region tables. "
                      f"Bedrock: {len(current['bedrock'])} model cards.", "",
                      "## Changes", ""] + (lines or ["No region changes."])) + "\n"
    print(text)
    if args.summary:
        with open(args.summary, "a") as summary:
            summary.write(text + "\n")
    if current != previous:
        TARGET.write_text(json.dumps(current, ensure_ascii=False, indent=1) + "\n")
        print("Wrote " + TARGET.name)


if __name__ == "__main__":
    main()
