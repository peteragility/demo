#!/usr/bin/env python3
"""Compare official source records against a reviewed baseline; never publish data.

No dependencies, tokens, or provider API keys are needed. A changed document is a
review signal, not an instruction to copy a predecessor price into a new model.
Exit 0 = nothing to review, 1 = a source failed, 2 = source changes or lifecycle
events within 7 days need review.
"""
import argparse
import concurrent.futures
import datetime as dt
import difflib
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent
ALERT_WINDOW = 30  # days before or after a dated event that it is listed in the report
DUE_WINDOW = 7     # days before or after a dated event that it needs an acknowledged review
NOTICE = re.compile(r"promot|discount|expir|retir|deprecat|through\s+(?:\w+\s+)?\d|until\s+(?:\w+\s+)?\d|long.context|not.supported|cache.writ|cache.storage|higher.context", re.I)


def clean(text):
    return re.sub(r"\s+", " ", text).strip()


def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class Page(HTMLParser):
    """Visible headings, tables, links and billing/lifecycle notices, sans menus."""
    SKIP = {"head", "script", "style", "nav", "header", "footer", "noscript", "svg"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ignored = []
        self.text = []
        self.headings = {}
        self.heading_tag = None
        self.heading_text = []
        self.tables = []
        self.table = None
        self.row = None
        self.cell = None
        self.notices = []
        self.blocks = []
        self.block_tags = []
        self.links = []

    def finish_cell(self):
        if self.cell is not None and self.row is not None:
            self.row.append(clean(" ".join(self.cell)))
        self.cell = None

    def finish_row(self):
        self.finish_cell()
        if self.row is not None and self.table is not None and any(self.row):
            self.table["rows"].append(self.row)
        self.row = None

    def finish_block(self):
        if self.blocks:
            text = clean(" ".join(self.blocks.pop()))
            self.block_tags.pop()
            if len(text) >= 20 and NOTICE.search(text):
                self.notices.append(text)

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.ignored.append(tag)
        if self.ignored:
            return
        # Minified documentation legitimately omits </p>, </td>, </th> and </tr>.
        # Honor their implied closing points instead of dropping entire tables.
        if self.block_tags and self.block_tags[-1] == "p" and tag in {"p", "td", "th", "tr", "tbody", "thead", "table", "div", "h1", "h2", "h3", "h4"}:
            self.finish_block()
        if self.block_tags and self.block_tags[-1] == "li" and tag == "li":
            self.finish_block()
        if re.fullmatch(r"h[1-6]", tag):
            self.heading_tag = tag
            self.heading_text = []
        if tag == "table" and self.table is None:
            self.table = {"heading": " / ".join(self.headings[k] for k in sorted(self.headings)), "rows": []}
        elif tag == "tr" and self.table is not None:
            self.finish_row()
            self.row = []
        elif tag in {"th", "td"} and self.row is not None:
            self.finish_cell()
            self.cell = []
        elif tag in {"thead", "tbody", "tfoot"} and self.table is not None:
            self.finish_row()
        if tag in {"p", "li", "aside", "blockquote"}:
            self.blocks.append([])
            self.block_tags.append(tag)
        if tag == "a":
            href = dict(attrs).get("href", "")
            if href:
                self.links.append(href)

    def handle_data(self, text):
        if self.ignored:
            return
        if text.strip():
            self.text.append(text)
        if self.heading_tag:
            self.heading_text.append(text)
        if self.cell is not None:
            self.cell.append(text)
        for block in self.blocks:
            block.append(text)

    def handle_endtag(self, tag):
        if self.ignored:
            if tag in self.ignored:
                # Pop only the corresponding ignored tag, not ordinary nested tags.
                for n in range(len(self.ignored) - 1, -1, -1):
                    if self.ignored[n] == tag:
                        del self.ignored[n:]
                        break
            return
        if tag == self.heading_tag:
            level = int(tag[1])
            self.headings = {k: v for k, v in self.headings.items() if k < level}
            self.headings[level] = clean(" ".join(self.heading_text))
            self.heading_tag = None
        if tag in {"th", "td"} and self.cell is not None:
            self.finish_cell()
        if tag == "tr" and self.row is not None:
            self.finish_row()
        if tag == "table" and self.table is not None:
            self.finish_row()
            if self.table["rows"]:
                self.tables.append(self.table)
            self.table = None
        if tag in {"p", "li", "aside", "blockquote"} and self.blocks:
            self.finish_block()


def html_records(text, kind):
    page = Page()
    page.feed(text)
    visible = clean(" ".join(page.text))
    records = []
    if kind == "catalog":
        records = ["endpoint: " + x for x in re.findall(r"Endpoint name\s*:\s*(databricks-[a-z0-9-]+)", visible)]
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
    if not records:
        raise ValueError("No pricing records in the markdown response.")
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


def fetch(source):
    address = source["url"]
    if urllib.parse.urlparse(address).scheme != "https":
        raise ValueError("Official sources must use HTTPS.")
    items = []
    for _ in range(30):
        request = urllib.request.Request(address, headers={"User-Agent": "LLM-Pricing-Source-Review/2.0", "Accept": "application/json,text/html,text/plain,*/*"})
        with urllib.request.urlopen(request, timeout=30) as response:
            content = response.read(20 * 1024 * 1024 + 1)
            if len(content) > 20 * 1024 * 1024:
                raise ValueError("Source exceeded the 20 MB review limit.")
            text = content.decode("utf-8")
        if source["kind"] != "azure":
            return text
        page = json.loads(text)
        items.extend(page.get("Items", []))
        address = page.get("NextPageLink")
        if not address:
            return packed(items)
        if urllib.parse.urlparse(address).hostname != "prices.azure.com":
            raise ValueError("Unexpected Azure pagination host.")
    raise ValueError("Azure pagination limit reached; review incomplete.")


def collect_one(source, cache_dir=None):
    if cache_dir:
        text = (cache_dir / source["cache_file"]).read_text()
    else:
        text = fetch(source)
    kind = source["kind"]
    if kind == "aws":
        records = aws_records(json.loads(text))
    elif kind == "azure":
        records = azure_records(json.loads(text))
    elif kind == "markdown":
        records = markdown_records(text)
    else:
        records = html_records(text, kind)
    if len(records) < source.get("minimum_records", 1):
        raise ValueError("Too few source records; verify the document and parser before treating it as current.")
    return dict(url=source["url"], kind=kind, digest=hashlib.sha256(packed(records).encode()).hexdigest(), records=records)


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
    args.report_dir.mkdir(parents=True, exist_ok=True)
    stem = "source-review-" + today.isoformat()
    (args.report_dir / (stem + ".json")).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    (args.report_dir / (stem + ".md")).write_text(markdown_report(report))
    print(f"Review report: {len(report['changes'])} changed sources; {len(errors)} failed sources; "
          f"{len(report['lifecycle_due'])} lifecycle events due for review.")
    if os.environ.get("GITHUB_ACTIONS") == "true":
        # Upcoming dates show as run annotations even while they are not yet due.
        for alert in report["lifecycle_alerts"]:
            print(f"::warning title=Lifecycle {alert['date']}::{alert['model']} · {alert['platform']} · {alert['event']} ({alert['days']} days)")
    if errors:
        sys.exit(1)
    if report["changes"] or report["lifecycle_due"]:
        sys.exit(2)


if __name__ == "__main__":
    main()
