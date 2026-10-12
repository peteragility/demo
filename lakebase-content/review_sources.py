#!/usr/bin/env python3
"""Observe material official-source changes. Never change or certify calculator rates."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from decimal import Decimal, InvalidOperation
import importlib.util
import json
from pathlib import Path
import re
import urllib.request
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("llm_source_review", HERE.parent / "llm-pricing/v2-maintenance/review-sources.py")
review = importlib.util.module_from_spec(spec); spec.loader.exec_module(review)
UNITS = re.compile(r"\b\d[\d,]*(?:\.\d+)?\s*(?:compute units?|cus?|connections?|branches?|days?|seconds?|minutes?|(?:read )?replicas?|gb|gib|tb|tib|vcpu)\b", re.I)
RANGES = re.compile(r"\b\d[\d,]*(?:\.\d+)?\s*(?:to|through|[–—-])\s*\d[\d,]*(?:\.\d+)?\s*(?:compute units?|cus?|connections?|branches?|days?|seconds?|minutes?|(?:read )?replicas?|gb|gib|tb|tib|vcpu)\b", re.I)
STATUS = re.compile(r"\bgenerally available\b|\bgeneral availability\b|\bga\b|\bbeta\b|\b(?:public|private) preview\b", re.I)
FEATURES = ("direct writes", "lakebase search", "change data feed", "cross-region", "disaster recovery", "lakehouse//rt", "high availability", "autoscaling", "lakebase", "managed postgres")
REGIONS = {"us-east-1", "us-west-2", "ap-southeast-1", "ap-northeast-1", "ap-east-1"}
LAKEBASE_REGIONS = {"US East (N. Virginia)", "US West (Oregon)", "AP (Singapore)", "AP (Tokyo)",
                    "US East", "US West 2", "Asia Southeast", "Japan East", "Asia East",
                    "US (Iowa)", "US (Oregon)", "Asia (Singapore)", "Asia (Tokyo)"}


def material_records(text, kind="html"):
    if kind == "lakebase-price-feed":
        records = []
        for tier, clouds in json.loads(text).items():
            if tier not in {"premium", "enterprise"}: continue
            for cloud, offers in clouds.items():
                for sku, regions in offers.items():
                    if not sku.startswith("lakebase_"): continue
                    for region, value in regions.items():
                        if region not in LAKEBASE_REGIONS: continue
                        try: price = Decimal(str(value))
                        except InvalidOperation: raise ValueError("Unparseable Lakebase price")
                        if not price.is_finite() or price < 0: raise ValueError("Invalid Lakebase price")
                        records.append(f"USD rate · {tier} · {cloud} · {sku} · {region} · {price.normalize()}")
        if len(records) < 10: raise ValueError("Incomplete Lakebase price feed")
        return sorted(records)
    if kind == "rds-index":
        regions = json.loads(text).get("regions", {})
        if not REGIONS <= regions.keys(): raise ValueError("Incomplete RDS region index")
        return sorted(f"RDS price-list version · {region} · {regions[region]['currentVersionUrl']}" for region in REGIONS)
    records = review.html_records(text, "text")
    tokens = set()
    for record in records:
        normalized = review.official.norm(record)
        if record.startswith("table: {"):
            row = json.loads(record[7:])
            cells = [review.official.norm(c) for c in row.get("cells", [])]
            if any(STATUS.search(cell) for cell in cells):
                canonical = [STATUS.sub(lambda match: "ga" if match.group().lower() in {"ga", "general availability", "generally available"} else match.group().lower(), cell) for cell in cells]
                tokens.add("feature-status-table:" + review.packed([review.official.norm(row.get("heading", "")), canonical]))
            if re.search(r"branches|replicas|connections|retention|history|compute|postgres|limits|size", row.get("heading", "").lower() + " " + " ".join(cells)) and re.search(r"\d", " ".join(cells)):
                tokens.add("constraint-table:" + review.packed([review.official.norm(row.get("heading", "")), cells]))
        if re.search(r"postgres(?:ql)?.*\bversions?\b|postgres(?:ql)?\s+\d", normalized):
            versions = re.findall(r"(?<![\w.])(?:[89]|[1-9]\d)(?:\.\d+)?(?![\w.])", normalized)
            if versions: tokens.add("engine-versions:" + review.packed(sorted(set(versions))))
        for token in review.risk_tokens(record, None):
            # Dates and regional navigation are not rate/limit changes. Numeric price-row
            # assignments remain intact; nonnumeric header/layout changes wait for a real value.
            if token.startswith("price:") and not token.startswith("price:columns:"):
                tokens.add(token)
        tokens.update("limit:" + review.official.norm(value) for value in UNITS.findall(normalized) + RANGES.findall(normalized))
        states = STATUS.findall(normalized)
        for feature in FEATURES:
            if feature in normalized:
                tokens.update("status:" + feature + ":" + ("ga" if state.lower() in {"ga", "general availability", "generally available"} else state.lower()) for state in states)
    if not tokens: raise ValueError("No material rate, limit or status records; verify this source/parser")
    return sorted(tokens)


def collect(source, cache=None):
    if urlparse(source["url"]).scheme != "https": raise ValueError("Official sources must use HTTPS")
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", source["id"]): raise ValueError("Invalid source identifier")
    text = (cache / (source["id"] + ".txt")).read_text() if cache else review.read_url(source["url"], attempts=2)
    return {"url": source["url"], "records": material_records(text, source.get("kind", "html"))}


def findings(config, baseline, current, errors):
    result = []
    for source in config:
        sid = source["id"]
        if sid in errors:
            result.append({"source": sid, "url": source["url"], "reason": "Source could not be rechecked", "error": errors[sid]})
        elif sid not in baseline.get("sources", {}):
            result.append({"source": sid, "url": source["url"], "reason": "New source needs an observed baseline"})
        elif baseline["sources"][sid].get("url") != source["url"]:
            result.append({"source": sid, "url": source["url"], "reason": "Source URL changed; verify the new reference"})
        else:
            old = set(baseline["sources"][sid]["records"]); new = set(current[sid]["records"])
            if old != new:
                result.append({"source": sid, "url": source["url"], "reason": "Official numeric rates/limits, feature status or price-list version changed",
                               "added": sorted(new - old), "removed": sorted(old - new)})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=HERE / "watch-sources.json")
    parser.add_argument("--baseline", type=Path, default=HERE / "watch-baseline.json")
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--report-dir", type=Path, required=True)
    parser.add_argument("--record-baseline", action="store_true")
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    baseline = json.loads(args.baseline.read_text()) if args.baseline.exists() else {}
    current, errors = {}, {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(collect, source, args.cache_dir): source for source in config}
        for future in as_completed(futures):
            source = futures[future]
            try: current[source["id"]] = future.result()
            except Exception as error: errors[source["id"]] = str(error)
    day = datetime.now(ZoneInfo("Asia/Hong_Kong")).date().isoformat()
    result = findings(config, baseline, current, errors)
    args.report_dir.mkdir(parents=True, exist_ok=True)
    report = {"checked": day, "sources_read": len(current), "errors": errors, "findings": result,
              "publication": "Observation only; prices and verified dates are never changed by this watcher."}
    (args.report_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    lines = [f"Lakebase source review {day}: {len(result)} findings; {len(current)} sources read; {len(errors)} unreadable.", "",
             "A change signal is not proof of a changed calculator rate. Verify the exact supported SKU, region, tier, feature and units before editing.", "",
             "See `lakebase-content/README.md` for the review and baseline procedure.", ""]
    for finding in result:
        lines.append(f"- [{finding['source']}]({finding['url']}): {finding['reason']}")
        if "error" in finding: lines.append("  - Read error: " + finding["error"].replace("\n", " ")[:220])
        for sign, key in (("+", "added"), ("-", "removed")):
            lines += [f"  - `{sign} {line.replace('`', '')[:250]}`" for line in finding.get(key, [])[:8]]
    (args.report_dir / "issue.md").write_text("\n".join(lines) + "\n" if result else "")
    if args.record_baseline:
        if errors:
            print("Baseline refused: every watched source must be read successfully.")
            return 1
        args.baseline.write_text(json.dumps({"observed": day, "sources": dict(sorted(current.items()))}, ensure_ascii=False, indent=2) + "\n")
        print("Recorded an observed source baseline, not a certification of calculator rates.")
    print(f"Lakebase source check: {len(current)} read, {len(result)} findings, {len(errors)} unreadable.")
    return 1 if len(errors) > len(config) / 2 else 0


if __name__ == "__main__":
    raise SystemExit(main())
