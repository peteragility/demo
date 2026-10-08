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


def changes(previous, current):
    """One line per model whose regions or HK / Taiwan state changed."""
    lines = []
    for platform in ("databricks",):
        old, new = (previous or {}).get(platform, {}), current.get(platform, {})
        for key in sorted(set(old) | set(new)):
            a, b = old.get(key), new.get(key)
            strip = lambda e: e and {k: v for k, v in e.items() if k not in ("changed_at", "missing_since")}
            if a and a.get("missing_since") and b:
                lines.append(f"- {platform} · {key}: back in the region tables")
            if strip(a) == strip(b):
                continue
            if not a:
                lines.append(f"- {platform} · {key}: regions added")
            elif not b:
                lines.append(f"- {platform} · {key}: no longer in the region tables (regions kept)")
            else:
                gone = {tuple(r) for r in a["regions"]} - {tuple(r) for r in b["regions"]}
                came = {tuple(r) for r in b["regions"]} - {tuple(r) for r in a["regions"]}
                detail = [f"{g} {label}: {text}" for g, _, label, text in sorted(came)]
                detail += [f"{g} {label} removed: {text}" for g, _, label, text in sorted(gone) if (g, label) not in {(x[0], x[2]) for x in came}]
                if a["hk"] != b["hk"]:
                    detail.append(f"HK {a['hk'][0]} → {b['hk'][0]}")
                if a["tw"] != b["tw"]:
                    detail.append(f"Taiwan {a['tw'][0]} → {b['tw'][0]}")
                lines.append(f"- {platform} · {key}: " + "; ".join(detail or ["notes changed"]))
    return lines


def carry(previous, current, models, as_of):
    """Dates each entry by its last change. A model that drops out of every table keeps its last regions and
    date until someone reviews it; missing_since puts it in the review issue."""
    for platform, entries in (previous or {}).items():
        if isinstance(entries, dict):
            for key, entry in entries.items():
                if key not in current.get(platform, {}) and key in models:
                    current.setdefault(platform, {})[key] = dict(entry, missing_since=entry.get("missing_since") or as_of)
    bare = lambda e: {k: v for k, v in e.items() if k not in ("changed_at", "missing_since")}
    for key, entry in current.get("databricks", {}).items():
        old = ((previous or {}).get("databricks") or {}).get(key)
        entry["changed_at"] = old["changed_at"] if old and bare(old) == bare(entry) else as_of
    return current


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, help="Read saved pages (dbx-aws.html, dbx-azure.html, dbx-gcp.html) instead of fetching.")
    parser.add_argument("--summary", type=Path, help="Append the Markdown report to this file (e.g. $GITHUB_STEP_SUMMARY).")
    parser.add_argument("--as-of", default=dt.datetime.now(ZoneInfo("Asia/Hong_Kong")).date().isoformat(), help="Run date (default: today in Hong Kong).")
    args = parser.parse_args()
    data = json.loads((HERE.parent / "v2-data.json").read_text())
    try:
        pages = {cloud: read(f"dbx-{cloud}.html", url, args.cache_dir) for cloud, (_, url) in DBX_PAGES.items()}
        current = build(data, pages)
    except Exception as error:
        print("Regions not updated: " + str(error), file=sys.stderr)
        sys.exit(1)
    previous = json.loads(TARGET.read_text()) if TARGET.exists() else None
    lines = changes(previous, current)
    carry(previous, current, data["models"], args.as_of)
    current = dict(schema=1, note="Generated by update-endpoints.py from official region tables; do not edit.", **current)
    text = "\n".join(["# LLM pricing v2 regions", "", f"Databricks: {len(current['databricks'])} endpoints in the official region tables.", "",
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
