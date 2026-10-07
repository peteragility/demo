#!/usr/bin/env python3
"""Compare official source records against a reviewed baseline; never publish prices.

No dependencies, tokens, or provider API keys are needed. A changed document is a
review signal, not an instruction to copy a predecessor price into a new model.

For every model and platform, the records that mention the model are compared with the
reviewed baseline: unchanged sources move that offer's verified date to today (written to
v2-checks.json with --checks); changed ones are listed for review. Databricks DBU tables are
also compared number by number with the published prices.
Exit 0 = review completed (changes, if any, are in the report), 1 = more than half of the
sources failed. With --fail-on-change: 2 = changes or lifecycle events need review.
"""
import argparse
import concurrent.futures
import datetime as dt
import difflib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("official", HERE / "official.py")
official = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(official)
Page, clean, NOTICE = official.Page, official.clean, official.NOTICE
ALERT_WINDOW = 30  # days before or after a dated event that it is listed in the report
DUE_WINDOW = 7
STAMP = re.compile(r"^(?:text|notice): Last updated \d{4}-\d{2}-\d{2}(?: UTC)?\.?$")     # days before or after a dated event that it needs an acknowledged review


def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def html_records(text, kind):
    page = Page()
    page.feed(text)
    visible = clean(" ".join(page.text))
    records = []
    if kind == "catalog":
        records = ["endpoint: " + x for x in re.findall(r"Endpoint name\s*:\s*(databricks-[a-z0-9-]+)", visible)]
    elif kind == "text":
        # Documentation pages: every paragraph and list item, plus any tables.
        records = ["text: " + x for x in page.paragraphs]
        records += ["table: " + packed({"heading": t["heading"], "cells": row}) for t in page.tables for row in t["rows"]]
    elif kind == "aws-catalog":
        records = ["model-card: " + href.split("/")[-1].split("#")[0] for href in page.links if "model-card-openai-" in href]
    else:
        for table in page.tables:
            for row in table["rows"]:
                records.append("table: " + packed({"heading": table["heading"], "cells": row}))
    if kind == "card":
        # Model cards often render availability and prices as divs rather than tables.
        for pattern in [r"Serverless\s+(?:Not supported|Supported|Available)",
                        r"Pricing\s+Input\s+Tokens\s+\$[\d.,]+.{0,200}?Output\s+Tokens\s+\$[\d.,]+[^A-Za-z]{0,20}",
                        r"Input\s*\$[\d.,]+.{0,100}?Output\s*\$[\d.,]+"]:
            records.extend("capability/rate: " + clean(m.group(0)) for m in re.finditer(pattern, visible, re.I))
        # Capture the stable public model identity independently of menu formatting.
        for term in re.findall(r"(?:grok-\d[\w.-]*|deepseek-v[\w.-]+|kimi-k2p7-code)", visible, re.I):
            records.append("model-id: " + term)
    records.extend("notice: " + n for n in page.notices)
    records = [r for r in records if not STAMP.search(r)]
    if not records or (kind == "tables" and not page.tables):
        raise ValueError("No meaningful records found; the source may need a parser update.")
    return sorted(set(records))


def markdown_records(text):
    if text.lstrip().startswith("<!"):
        raise ValueError("Expected markdown; received an HTML response.")
    records = []
    heading = ""
    for line in text.splitlines():
        line = clean(line)
        if line.startswith("#"):
            heading = line.lstrip("# ")
        if line.startswith("|") and not re.fullmatch(r"[|\s:-]+", line):
            records.append("table: " + packed({"heading": heading, "cells": [clean(c) for c in line.strip("|").split("|")]}))
        elif NOTICE.search(line) and not line.startswith(("export ", "return ", "<")):
            records.append("notice: " + line)
        # Kimi publishes a JSX table in its official .md page.
        elif re.match(r'\["kimi-', line):
            records.append("model-price: " + line)
        # Lists such as supported countries and regions.
        elif re.match(r"[-*] \S", line):
            records.append("item: " + packed({"heading": heading, "text": line[2:]}))
    if not records:
        raise ValueError("No pricing records in the markdown response.")
    return sorted(set(records))


def toc_records(data):
    """Bedrock model cards listed in the user guide's table of contents."""
    found = set()
    def walk(node):
        if isinstance(node, dict):
            href = node.get("href") or ""
            if isinstance(href, str) and href.startswith("model-card-"):
                found.add("card: " + clean(str(node.get("title") or "")) + " | " + href)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)
    walk(data)
    if len(found) < 20:
        raise ValueError("Too few model cards in the Bedrock table of contents.")
    return sorted(found)


def json_records(data):
    """One record per item of a JSON document (a list, or a dict's entries)."""
    items = data if isinstance(data, list) else [{"key": k, "value": v} for k, v in data.items()] if isinstance(data, dict) else []
    records = [packed(item) for item in items]
    if not records:
        raise ValueError("No records in the JSON document.")
    return sorted(set(records))


def aws_records(data):
    records = []
    products = data.get("products", {})
    for sku, terms in data.get("terms", {}).get("OnDemand", {}).items():
        attributes = products.get(sku, {}).get("attributes", {})
        for term in terms.values():
            for dimension in term.get("priceDimensions", {}).values():
                records.append(packed({"attributes": attributes, "unit": dimension.get("unit"),
                    "begin": dimension.get("beginRange"), "end": dimension.get("endRange"),
                    "price": dimension.get("pricePerUnit"), "description": dimension.get("description")}))
    if not records:
        raise ValueError("No AWS on-demand price dimensions returned.")
    return sorted(set(records))


def azure_records(data):
    items = data.get("Items", []) if isinstance(data, dict) else data
    records = []
    fields = ("productName", "skuName", "meterName", "armRegionName", "unitOfMeasure", "retailPrice", "currencyCode", "tierMinimumUnits")
    for item in items:
        if item.get("type") == "Consumption" and item.get("serviceName") == "Foundry Models":
            records.append(packed({k: item.get(k) for k in fields}))
    if not records:
        raise ValueError("No Azure Foundry consumption prices returned.")
    return sorted(set(records))


def read_url(address, attempts=4):
    """GET with retries for rate limits (429) and transient server errors."""
    for attempt in range(attempts):
        request = urllib.request.Request(address, headers={"User-Agent": "LLM-Pricing-Source-Review/2.0", "Accept": "application/json,text/html,text/plain,*/*"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                content = response.read(20 * 1024 * 1024 + 1)
                if len(content) > 20 * 1024 * 1024:
                    raise ValueError("Source exceeded the 20 MB review limit.")
                return content.decode("utf-8")
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == attempts - 1:
                raise
            wait = int(error.headers.get("Retry-After") or 0) if error.headers else 0
            time.sleep(min(max(wait, 5 * 3 ** attempt), 60))
        except urllib.error.URLError:
            if attempt == attempts - 1:
                raise
            time.sleep(5 * 3 ** attempt)


def fetch(source):
    address = source["url"]
    if urllib.parse.urlparse(address).scheme != "https":
        raise ValueError("Official sources must use HTTPS.")
    items = []
    for _ in range(30):
        text = read_url(address)
        if source["kind"] != "azure":
            return text
        page = json.loads(text)
        items.extend(page.get("Items", []))
        address = page.get("NextPageLink")
        if not address:
            return packed(items)
        if urllib.parse.urlparse(address).hostname != "prices.azure.com":
            raise ValueError("Unexpected Azure pagination host.")
        time.sleep(0.3)
    raise ValueError("Azure pagination limit reached; review incomplete.")


def collect_one(source, cache_dir=None):
    if cache_dir:
        text = (cache_dir / source["cache_file"]).read_text()
    else:
        text = fetch(source)
    kind = source["kind"]
    if kind == "json":
        records = json_records(json.loads(text))
    elif kind == "aws-toc":
        records = toc_records(json.loads(text))
    elif kind == "aws":
        records = aws_records(json.loads(text))
    elif kind == "azure":
        records = azure_records(json.loads(text))
    elif kind == "markdown":
        records = markdown_records(text)
    else:
        records = html_records(text, kind)
    if len(records) < source.get("minimum_records", 1):
        raise ValueError("Too few source records; verify the document and parser before treating it as current.")
    snapshot = dict(url=source["url"], kind=kind, digest=hashlib.sha256(packed(records).encode()).hexdigest(), records=records)
    if source.get("facts") == "dbx-prices":
        snapshot["facts"] = official.dbx_price_rows(text, 0.07)
    return snapshot


def alert_key(alert):
    return "|".join((alert["key"], alert["platform"], alert["event"], alert["date"]))


def time_alerts(data, today):
    """Dated events within ALERT_WINDOW days, including service-tier promotions and verified-through dates."""
    found = {}
    for key, model in data["models"].items():
        for platform, cell in model["platforms"].items():
            events = [("retirement", cell.get("retires_on")), ("promotion end", (cell.get("promotion") or {}).get("ends_on"))]
            for variant in cell.get("variants", []):
                events += [("tier promotion end", (variant.get("promotion") or {}).get("ends_on")),
                           ("tier rates verified through", variant.get("valid_through"))]
            for name, date in events:
                if not date:
                    continue
                days = (dt.date.fromisoformat(date) - today).days
                if -ALERT_WINDOW <= days <= ALERT_WINDOW:
                    alert = {"key": key, "model": model.get("name", key), "platform": platform, "event": name,
                             "date": date, "days": days, "state": "past" if days < 0 else "upcoming"}
                    found[alert_key(alert)] = alert
    return sorted(found.values(), key=lambda x: (x["date"], x["model"], x["platform"], x["event"]))


def due_alerts(alerts, acknowledged):
    """Events within DUE_WINDOW days that no reviewed baseline has acknowledged yet."""
    seen = set(acknowledged or [])
    return [a for a in alerts if abs(a["days"]) <= DUE_WINDOW and alert_key(a) not in seen]


def make_report(baseline, current, errors, data, today):
    changes = []
    for sid, snapshot in current.items():
        previous = baseline.get("sources", {}).get(sid)
        if previous and previous.get("digest") == snapshot["digest"]:
            continue
        before = previous.get("records", []) if previous else []
        after = snapshot["records"]
        changes.append(dict(source=sid, url=snapshot["url"], added=sorted(set(after) - set(before)),
                            removed=sorted(set(before) - set(after)),
                            diff="\n".join(difflib.unified_diff(before, after, fromfile="reviewed", tofile="current", lineterm=""))))
    for sid in baseline.get("sources", {}):
        if sid not in current and sid not in errors:
            errors[sid] = "Source missing from the current configuration."
    alerts = time_alerts(data, today)
    return dict(checked_at=today.isoformat(), baseline_checked_at=baseline.get("checked_at"),
                sources_checked=len(current), sources_failed=errors, changes=changes, lifecycle_alerts=alerts,
                lifecycle_due=due_alerts(alerts, baseline.get("acknowledged_lifecycle")),
                publication="Review only. No pricing dataset or original page was modified.")


# ---- Per-offer checks ------------------------------------------------------------------------

SIBLINGS = r"flash|lite|mini|nano|pro|max|plus|turbo|instant|codex|air|image|thinking|preview|embedding|vl|coder"


def model_regex(model):
    """Finds a model's own lines in a multi-model source: 'Claude Opus 5.5', 'claude-opus-5-5',
    'Opus 5.5' all match Opus 5.5; 'Opus 5.5 Pro' or 'GLM 5.3 Flash' do not match Opus 5.5 / GLM 5.3."""
    sep = r"[\s._/-]*"
    def phrase(tokens):
        parts = [re.escape(t).replace(r"\.", "[._ -]") for t in tokens]
        own = {t for t in tokens if re.fullmatch(SIBLINGS, t)}
        tail = "|".join(x for x in SIBLINGS.split("|") if x not in own)
        # A digit right after the version, directly or after one separator, is another version ("5.3", "5-3").
        return r"(?<![a-z0-9])" + sep.join(parts) + r"(?![._ -]?\d)(?!" + sep + "(?:" + tail + r")\b)"
    tokens = official.norm(model.get("name") or "").split()
    options = [phrase(tokens)] if tokens else []
    if len(tokens) > 2 and tokens[0] in ("claude", "gemini", "grok", "gpt", "kimi"):
        options.append(phrase(tokens[1:]))
    return re.compile("|".join(options)) if options else None


def relevant(records, rx):
    if not rx:
        return list(records)
    return [r for r in records if rx.search(official.norm(r))]


def close(a, b):
    return abs(a - b) <= 0.0006 + 0.0003 * abs(b)


# Databricks DBU-table row names that differ from the page's model name.
DBX_TABLE_NAMES = {"qwen/qwen3-next-80b-instruct": "Qwen 3 80B Instruct"}


def dbx_fact_issues(data, facts, today, complete=True):
    """Databricks prices that no longer match its DBU tables (USD at $0.07 / DBU).

    A table value matches the price shown today or the published post-promotion price.
    """
    issues = {}
    resolve = lambda o: {k: v for k, v in o.items() if k in ("in", "out", "cache_read", "cache_write", "cache_write_1h")}
    for key, model in data["models"].items():
        cell = model["platforms"]["databricks"]
        names = {official.compact(n) for n in (model.get("name"), model.get("short"), DBX_TABLE_NAMES.get(key)) if n}
        row = next((r for name, r in facts.items() if official.compact(name) in names), None)
        if cell.get("status") == "unverified" and cell.get("available") and row:
            std = row.get("standard", {})
            short = std.get("") or std.get("short context") or std.get("text tokens") or {}
            if "in" in short and "out" in short:
                issues[key] = [f"now priced in the DBU table: ${short['in']:g} / ${short['out']:g} (list, before any promotion)"]
            continue
        if cell.get("status") != "priced" or (cell.get("retires_on") and today.isoformat() >= cell["retires_on"]):
            continue
        found = []
        if not row:
            if complete:  # only when every DBU table was read
                issues[key] = ["not found in the Databricks DBU tables"]
            continue
        promo = cell.get("promotion") or {}
        shown = resolve(cell) if not (promo and today.isoformat() > promo["ends_on"]) else resolve(promo.get("after", {}))
        after = resolve(promo.get("after", {}))
        std = row.get("standard", {})
        short = std.get("") or std.get("short context") or std.get("text tokens") or {}
        for field, value in short.items():
            options = [o[field] for o in (shown, after) if field in o]
            if not any(close(value, o) for o in options):
                found.append(f"standard {field}: table ${value:g}, page ${options[0]:g}" if options else f"standard {field}: table ${value:g}, page has none")
        if "long context" in std and cell.get("long_context"):
            long_after = resolve((promo.get("after") or {}).get("long_context", {}))
            for field, value in std["long context"].items():
                options = [o[field] for o in (resolve(cell["long_context"]), long_after) if field in o]
                if options and not any(close(value, o) for o in options):
                    found.append(f"long-context {field}: table ${value:g}, page ${options[0]:g}")
        variants = cell.get("variants", [])
        priority = [v for v in variants if v.get("service_tier") == "priority" and v.get("comparison_scope") != "regional"]
        if row.get("priority") and not priority:
            found.append("Priority tier listed in the table but missing on the page")
        elif priority and not row.get("priority"):
            found.append("Priority tier on the page but not in the table")
        elif priority:
            p = row["priority"].get("") or row["priority"].get("short context") or {}
            v = priority[0]
            v_after = resolve((v.get("promotion") or {}).get("after", {}))
            for field, value in p.items():
                options = [o[field] for o in (resolve(v), v_after) if field in o]
                if options and not any(close(value, o) for o in options):
                    found.append(f"Priority {field}: table ${value:g}, page ${options[0]:g}")
        regional = any(v.get("comparison_scope") == "regional" for v in variants)
        if row["regional"] != regional:
            found.append("regional processing (⌖) " + ("listed in the table but missing on the page" if row["regional"] else "on the page but not in the table"))
        if found:
            issues[key] = found
    return issues


def cell_sources(cell, meta_index):
    ids = {cell.get("src"), cell.get("model_id_source"), cell.get("retirement_src")}
    ids |= set((cell.get("endpoints") or {}).get("src", []))
    return sorted({sid for meta in ids if meta for sid in meta_index.get(meta, [])})


def cell_checks(data, config, baseline, current, errors, fact_issues, previous, today):
    """Per model and platform: verified today, or the sources whose lines about it changed."""
    day = today.isoformat()
    meta_index = {}
    for source in config:
        for meta in source.get("meta", []):
            meta_index.setdefault(meta, []).append(source["id"])
    by_id = {source["id"]: source for source in config}
    old = (previous or {}).get("cells", {})
    cells, changes = {}, []
    for key, model in data["models"].items():
        rx = model_regex(model)
        for pl, cell in model["platforms"].items():
            # A source scoped to some models (a model card, say) checks only those models. Databricks offers
            # always depend on its DBU tables, so a price published for a pending offer is noticed.
            deps = [sid for sid in cell_sources(cell, meta_index) if key in by_id[sid].get("models", [key])]
            if pl == "databricks":
                deps = sorted(set(deps) | {s["id"] for s in config if s.get("facts") == "dbx-prices"})
            if not deps:
                continue
            offered = cell.get("status") in ("priced", "dedicated") or cell.get("available")
            ref = key + "|" + pl
            changed, unchecked = [], []
            for sid in deps:
                if sid in errors or sid not in current:
                    unchecked.append(sid)
                    continue
                if by_id[sid].get("auto"):
                    continue  # regenerated from the source by update-endpoints.py
                before = (baseline.get("sources", {}).get(sid) or {}).get("records")
                if before is None:
                    unchecked.append(sid)
                    continue
                after = current[sid]["records"]
                rb, ra = relevant(before, rx), relevant(after, rx)
                if not rb and not ra and by_id[sid].get("models"):
                    rb, ra = before, after  # a model-specific page that never names the model
                if not rb and not ra:
                    # No line names the model: still not offered, or (for an offered model) only a
                    # whole-source match can confirm nothing changed.
                    if offered and set(before) != set(after):
                        unchecked.append(sid)
                    continue
                if set(rb) != set(ra):
                    changed.append(sid)
                    changes.append(dict(model=key, name=model.get("name", key), platform=pl, source=sid, url=current[sid]["url"],
                                        added=sorted(set(ra) - set(rb))[:12], removed=sorted(set(rb) - set(ra))[:12]))
            if pl == "databricks" and key in fact_issues:
                changed.append("dbx-prices")
            last = old.get(ref, {})
            verified = max(filter(None, [last.get("verified"), cell.get("pricing_checked_at"), (cell.get("endpoints") or {}).get("checked_at")]), default=None)
            if changed:
                cells[ref] = dict(verified=verified, changed_at=last.get("changed_at") or day, sources=changed)
            elif unchecked:
                cells[ref] = dict(verified=verified, unchecked=unchecked)
            else:
                cells[ref] = dict(verified=day)
    return cells, changes


def issue_markdown(report, cells, changes, fact_issues, data, listed):
    """The rolling GitHub issue: only what a person needs to act on."""
    name = lambda key: data["models"].get(key, {}).get("name", key)
    review = sorted({ref for ref, c in cells.items() if c.get("changed_at") and ref.split("|")[0] in listed})
    verified = sum(1 for ref, c in cells.items() if c.get("verified") == report["checked_at"] and ref.split("|")[0] in listed)
    lines = [f"Daily check {report['checked_at']}: {verified} listed offers verified unchanged today; "
             f"{len(review)} need review; {len(report['sources_failed'])} sources could not be read.", ""]
    fact_issues = {k: v for k, v in fact_issues.items() if k in listed}
    if fact_issues:
        lines += ["## Databricks prices that differ from its DBU tables", ""]
        lines += [f"- **{name(k)}**: " + "; ".join(v) for k, v in sorted(fact_issues.items())]
        lines.append("")
    shown = [c for c in changes if c["model"] in listed]
    if shown:
        lines += ["## Official sources whose lines about a model changed", ""]
        for c in shown[:60]:
            lines.append(f"- **{c['name']}** · {c['platform']} · [{c['source']}]({c['url']})")
            lines += [f"  - `+ {r[:220]}`" for r in c["added"][:4]] + [f"  - `- {r[:220]}`" for r in c["removed"][:4]]
        if len(shown) > 60:
            lines.append(f"- … and {len(shown) - 60} more (see the run's JSON artifact)")
        lines.append("")
    if report["sources_failed"]:
        lines += ["## Sources that could not be read", ""] + [f"- {sid}: {err}" for sid, err in sorted(report["sources_failed"].items())] + [""]
    if report.get("lifecycle_due"):
        lines += [f"## Dates within {DUE_WINDOW} days", ""]
        lines += [f"- {a['model']} · {a['platform']} · {a['event']} {a['date']} ({a['state']})" for a in report["lifecycle_due"]] + [""]
    lines += ["## How to resolve", "",
              "1. Open each source, confirm the change, and update `llm-pricing/v2-maintenance/build-data.py` or `endpoints.json`.",
              "2. Run `python v2-maintenance/build-data.py` and the tests, then push.",
              "3. Record the reviewed baseline: Actions → *LLM pricing v2 daily refresh* → Run workflow, tick **Record the reviewed baseline**. That run re-checks every source and closes this issue when nothing is left. (Locally: `review-sources.py --record-baseline`; it refuses if any source cannot be read.)", ""]
    return "\n".join(lines), review


def markdown_report(report):
    lines = ["# LLM pricing v2 source review", "", report["checked_at"], "",
             f"{report['sources_checked']} official sources checked; {len(report['changes'])} changed; {len(report['sources_failed'])} failed.",
             "", "This report flags source changes for human review. It does not publish prices or infer new model rates.", ""]
    if report["sources_failed"]:
        lines.extend(["## Sources requiring attention", ""])
        for sid, error in report["sources_failed"].items():
            lines.append(f"- {sid}: {error}")
        lines.append("")
    if report.get("lifecycle_due"):
        lines.extend([f"## Lifecycle events within {DUE_WINDOW} days: review needed", "",
                      "Confirm each provider made the announced change (or extended it), update the data if not, then record the reviewed baseline.", ""])
        for alert in report["lifecycle_due"]:
            lines.append(f"- {alert['model']} · {alert['platform']} · {alert['event']} {alert['date']} ({alert['state']})")
        lines.append("")
    if report["lifecycle_alerts"]:
        lines.extend([f"## Promotions and retirements within {ALERT_WINDOW} days", "", "| Model | Platform | Event | Date | State |", "|---|---|---|---|---|"])
        for alert in report["lifecycle_alerts"]:
            lines.append("| " + " | ".join(str(alert[k]) for k in ("model", "platform", "event", "date", "state")) + " |")
        lines.append("")
    for change in report["changes"]:
        lines.extend(["## " + change["source"], "", change["url"], "", f"{len(change['added'])} added records; {len(change['removed'])} removed records.", "", "```diff"])
        diff = change["diff"].splitlines()
        lines.extend(line.replace("```", "'''" ) for line in diff[:150])
        if len(diff) > 150:
            lines.append("... Full diff is included in the JSON artifact.")
        lines.extend(["```", ""])
    if not report["changes"] and not report["sources_failed"] and not report.get("lifecycle_due"):
        lines.extend(["No pricing, model-catalog or lifecycle source-record changes against the reviewed baseline.", ""])
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, help="Use previously downloaded official source files (offline).")
    parser.add_argument("--report-dir", type=Path, required=True)
    parser.add_argument("--record-baseline", action="store_true", help="Explicitly record a reviewed baseline. Never used by scheduled runs.")
    parser.add_argument("--checks", type=Path, help="Write per-offer verification dates (the page's v2-checks.json).")
    parser.add_argument("--issue", type=Path, help="Write the review-issue Markdown here (empty file when nothing needs review).")
    parser.add_argument("--fail-on-change", action="store_true", help="Exit 2 when changes or lifecycle events need review.")
    parser.add_argument("--as-of", default=dt.datetime.now(dt.timezone.utc).date().isoformat())
    args = parser.parse_args()
    today = dt.date.fromisoformat(args.as_of)
    sources = json.loads((HERE / "source-config.json").read_text())
    current, errors = {}, {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(collect_one, source, args.cache_dir): source for source in sources}
        for future in concurrent.futures.as_completed(futures):
            sid = futures[future]["id"]
            try:
                current[sid] = future.result()
                print(sid + ": " + str(len(current[sid]["records"])) + " records", flush=True)
            except Exception as error:
                errors[sid] = clean(str(error))[:500]
                print(sid + ": source failed — " + errors[sid], flush=True)
    current = dict(sorted(current.items()))
    baseline_file = HERE / "source-baseline.json"
    data = json.loads((HERE.parent / "v2-data.json").read_text())
    if args.record_baseline:
        if errors:
            raise SystemExit("Baseline was not written because one or more sources failed.")
        previous = json.loads(baseline_file.read_text()) if baseline_file.exists() else {}
        # Recording the baseline also acknowledges the lifecycle events reviewed with it.
        alerts = time_alerts(data, today)
        acknowledged = sorted(set(previous.get("acknowledged_lifecycle", [])) | {alert_key(a) for a in alerts if abs(a["days"]) <= DUE_WINDOW})
        baseline_file.write_text(json.dumps(dict(schema=1, checked_at=today.isoformat(), acknowledged_lifecycle=acknowledged, sources=current), ensure_ascii=False, indent=1) + "\n")
        print("Reviewed source baseline recorded; pricing data unchanged.")
        return
    if not baseline_file.exists():
        raise SystemExit("No reviewed baseline; collect and review one with --record-baseline first.")
    baseline = json.loads(baseline_file.read_text())
    report = make_report(baseline, current, errors, data, today)
    facts = {}
    for snapshot in current.values():
        facts.update(snapshot.pop("facts", None) or {})
    complete = not any(s.get("facts") == "dbx-prices" and s["id"] in errors for s in sources)
    fact_issues = dbx_fact_issues(data, facts, today, complete) if facts else {}
    previous = json.loads(args.checks.read_text()) if args.checks and args.checks.exists() else None
    cells, changes = cell_checks(data, sources, baseline, current, errors, fact_issues, previous, today)
    ranking_file = HERE.parent / "v2-ranking.json"
    listed = set(json.loads(ranking_file.read_text())["models"]) if ranking_file.exists() else set(data["models"])
    issue, review = issue_markdown(report, cells, changes, fact_issues, data, listed)
    listed_facts = {k: v for k, v in fact_issues.items() if k in listed}
    report.update(dbx_price_issues=fact_issues, model_changes=changes)
    args.report_dir.mkdir(parents=True, exist_ok=True)
    stem = "source-review-" + today.isoformat()
    (args.report_dir / (stem + ".json")).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    (args.report_dir / (stem + ".md")).write_text(markdown_report(report))
    if args.checks:
        repo = os.environ.get("GITHUB_REPOSITORY")
        names = lambda ref: data["models"][ref.split("|")[0]].get("name", ref) + " · " + ref.split("|")[1]
        checks = dict(schema=1, checked_at=today.isoformat(), sources_checked=len(current), sources_failed=sorted(errors),
                      review=[names(ref) for ref in review],
                      issue_url=f"https://github.com/{repo}/issues?q=is%3Aopen+label%3Allm-pricing-review" if repo else None,
                      cells=dict(sorted(cells.items())))
        if previous and previous.get("issue_url") and not repo:
            checks["issue_url"] = previous["issue_url"]
        args.checks.write_text(json.dumps(checks, ensure_ascii=False, indent=1) + "\n")
    if args.issue:
        args.issue.write_text(issue if review or listed_facts or report["sources_failed"] or report.get("lifecycle_due") else "")
    verified = sum(1 for c in cells.values() if c.get("verified") == today.isoformat())
    print(f"Review report: {verified} offers verified today; {len(review)} listed offers need review; {len(report['changes'])} changed sources; "
          f"{len(errors)} failed sources; {len(report['lifecycle_due'])} lifecycle events due for review.")
    if os.environ.get("GITHUB_ACTIONS") == "true":
        # Upcoming dates show as run annotations even while they are not yet due.
        for alert in report["lifecycle_alerts"]:
            print(f"::warning title=Lifecycle {alert['date']}::{alert['model']} · {alert['platform']} · {alert['event']} ({alert['days']} days)")
    if len(errors) * 2 > len(sources):
        sys.exit(1)
    if args.fail_on_change and (errors or report["changes"] or report["lifecycle_due"]):
        sys.exit(2)


if __name__ == "__main__":
    main()
