#!/usr/bin/env python3
"""Compare official source records against a reviewed baseline; never publish prices.

No dependencies, tokens, or provider API keys are needed. A changed document is a
review signal, not an instruction to copy a predecessor price into a new model.

For every model and platform, the records that mention the model are compared with the
reviewed baseline: unchanged sources move that offer's verified date to today (written to
v2-checks.json with --checks); changed ones are listed for review. Databricks DBU tables are
also compared number by number with the published prices.
Changed lines that name no model are compared too, and a low-risk change (no price, rate, limit,
date or region moved) is accepted into the baseline with --accept-low-risk.
Exit 0 = review completed (changes, if any, are in the report), 1 = more than half of the
sources failed. With --fail-on-change: 2 = something needs review (the issue is written).
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
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("official", HERE / "official.py")
official = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(official)
Page, clean, NOTICE = official.Page, official.clean, official.NOTICE
ALERT_WINDOW = 30  # days before or after a dated event that it is listed in the report
DUE_WINDOW = 7     # days before or after a dated event that it needs an acknowledged review
STALE_DAYS = 2     # days without a successful read before a source is listed in the issue
HKT = ZoneInfo("Asia/Hong_Kong")  # run dates follow the page's audience
STAMP = re.compile(r"^(?:text|notice): Last updated \d{4}-\d{2}-\d{2}(?: UTC)?\.?$")


def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def grouped(rows):
    """Rows that leave the first cell blank continue the row above (Vertex names each Claude model on its
    Input row only), so every row says what it prices."""
    out, group = [], ""
    for row in rows:
        if row and row[0]:
            group = row[0]
        elif row and group and any(row[1:]):
            row = [group] + row[1:]
        out.append(row)
    return out


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
        records += ["table: " + packed({"heading": t["heading"], "cells": row}) for t in page.tables for row in grouped(t["rows"])]
    elif kind == "aws-catalog":
        records = ["model-card: " + href.split("/")[-1].split("#")[0] for href in page.links if "model-card-openai-" in href]
    else:
        for table in page.tables:
            for row in grouped(table["rows"]):
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


def needs_action(alert):
    """Retirements and promotions switch on their dates by themselves. A tier whose rates are verified only
    through a date shows "not verified" after it, until someone re-checks the rates."""
    return alert["event"] == "tier rates verified through"


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


def dbx_rate(value):
    """A USD rate read from a DBU table, at the precision Databricks publishes (1.429 DBU x $0.07 = $0.10)."""
    for digits in range(2, 7):
        if abs(round(value, digits) - value) <= max(0.00005, value * 0.0005):
            return round(value, digits)
    return round(value, 6)


def dbx_check(data, facts, today, complete=True):
    """Databricks prices that no longer match its DBU tables (USD at $0.07 / DBU), per model as (finding, edit)
    pairs: edit is the rate change the table proves, or None when a person has to decide.

    A table value matches the price shown today or the published post-promotion price.
    """
    issues = {}
    resolve = lambda o: {k: v for k, v in o.items() if k in ("in", "out", "cache_read", "cache_write", "cache_write_1h")}
    edit = lambda offer, field, old, new: dict(offer=offer, field=field, old=old, new=dbx_rate(new))
    for key, model in data["models"].items():
        cell = model["platforms"]["databricks"]
        names = {official.compact(n) for n in (model.get("name"), model.get("short"), DBX_TABLE_NAMES.get(key)) if n}
        row = next((r for name, r in facts.items() if official.compact(name) in names), None)
        if cell.get("status") == "unverified" and cell.get("available") and row:
            std = row.get("standard", {})
            short = std.get("") or std.get("short context") or std.get("text tokens") or {}
            if "in" in short and "out" in short:
                issues[key] = [(f"now priced in the DBU table: ${short['in']:g} / ${short['out']:g} (list, before any promotion)", None)]
            continue
        if cell.get("status") != "priced" or (cell.get("retires_on") and today.isoformat() >= cell["retires_on"]):
            continue
        found = []
        if not row:
            if complete:  # only when every DBU table was read
                issues[key] = [("not found in the Databricks DBU tables", None)]
            continue
        promo = cell.get("promotion") or {}
        shown = resolve(cell) if not (promo and today.isoformat() > promo["ends_on"]) else resolve(promo.get("after", {}))
        after = resolve(promo.get("after", {}))
        std = row.get("standard", {})
        short = std.get("") or std.get("short context") or std.get("text tokens") or {}
        for field, value in short.items():
            options = [o[field] for o in (shown, after) if field in o]
            if not any(close(value, o) for o in options):
                found.append((f"standard {field}: table ${value:g}, page ${options[0]:g}" if options else f"standard {field}: table ${value:g}, page has none",
                              edit("base", field, cell[field], value) if options and not promo else None))
        if "long context" in std and cell.get("long_context"):
            long_after = resolve((promo.get("after") or {}).get("long_context", {}))
            for field, value in std["long context"].items():
                options = [o[field] for o in (resolve(cell["long_context"]), long_after) if field in o]
                if options and not any(close(value, o) for o in options):
                    found.append((f"long-context {field}: table ${value:g}, page ${options[0]:g}",
                                  edit("base/long_context", field, cell["long_context"][field], value) if not promo and field in cell["long_context"] else None))
        variants = cell.get("variants", [])
        priority = [v for v in variants if v.get("service_tier") == "priority" and v.get("comparison_scope") != "regional"]
        if row.get("priority") and not priority:
            found.append(("Priority tier listed in the table but missing on the page", None))
        elif priority and not row.get("priority"):
            found.append(("Priority tier on the page but not in the table", None))
        elif priority:
            p = row["priority"].get("") or row["priority"].get("short context") or {}
            v = priority[0]
            v_after = resolve((v.get("promotion") or {}).get("after", {}))
            for field, value in p.items():
                options = [o[field] for o in (resolve(v), v_after) if field in o]
                if options and not any(close(value, o) for o in options):
                    found.append((f"Priority {field}: table ${value:g}, page ${options[0]:g}",
                                  edit("variant:" + v["label"], field, v[field], value) if not v.get("promotion") and field in v else None))
        regional = any(v.get("comparison_scope") == "regional" for v in variants)
        if row["regional"] != regional:
            found.append(("regional processing (⌖) " + ("listed in the table but missing on the page" if row["regional"] else "on the page but not in the table"), None))
        if found:
            issues[key] = found
    return issues


def dbx_fact_issues(data, facts, today, complete=True):
    """dbx_check's findings, as text."""
    return {key: [text for text, _ in found] for key, found in dbx_check(data, facts, today, complete).items()}


def dbx_edits(data, facts, today, complete=True):
    """Rate edits the DBU tables prove, for models whose every finding is a plain rate difference."""
    return {key: [e for _, e in found] for key, found in dbx_check(data, facts, today, complete).items() if all(e for _, e in found)}


def cell_sources(cell, meta_index):
    ids = {cell.get("src"), cell.get("model_id_source"), cell.get("retirement_src")}
    ids |= set((cell.get("endpoints") or {}).get("src", []))
    return sorted({sid for meta in ids if meta for sid in meta_index.get(meta, [])})


PRICE = re.compile(r"\$\s?\d[\d,]*(?:\.\d+)?|\d+(?:\.\d+)?\s?%|\d+(?:\.\d+)?\s?[x×](?![a-z])|(?<![\w.])\d+\.\d+(?![\w.])")
LIMIT = re.compile(r"(?<![\w.$])\d+(?:\.\d+)?\s?[km](?![a-z])")  # context limits and thresholds: 272k, 1m
MONTH = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?"
# Dates, but not those inside identifiers such as a beta header compact-2026-09-04.
DATE = re.compile(rf"\b{MONTH}\s+\d{{1,2}},?\s+\d{{4}}|\b\d{{1,2}}\s+{MONTH}\s+\d{{4}}|(?<![\w-])\d{{4}}-\d{{2}}-\d{{2}}(?![\w-])|"
                  rf"(?<![\w/])\d{{1,2}}/\d{{1,2}}/\d{{2,4}}(?![\w/])|\b{MONTH}\s+\d{{4}}\b", re.I)
# Region codes and names the page maps (AWS, Azure, Google Cloud), plus Hong Kong and Taiwan.
PLACE = re.compile(r"(?<![\w-])(?:" + "|".join(sorted({re.escape(official.norm(x)) for table in (official.AWS, official.AZURE, official.GCP)
                                                         for code, (_, place) in table.items() for x in (code, place)} | {"hong kong", "taiwan", "taipei"},
                                                        key=len, reverse=True)) + r")(?![\w-])")
# A model the dataset does not track ("Llama 3.3 70B", "Claude Opus 4.7", "Mistral Large 4", "o3").
OTHER_MODEL = re.compile(r"(?<![\w-])(?:(?:claude|opus|sonnet|haiku|fable|mythos|gpt|codex|gemini|gemma|imagen|veo|lyria|chirp|llama|mistral|mixtral|"
                         r"ministral|magistral|codestral|devstral|pixtral|voxtral|qwen|qwq|deepseek|kimi|glm|grok|nova|titan|jamba|phi|minimax|nemotron|"
                         r"granite|olmo|ernie|hunyuan|whisper|dall e|sora|flux|cohere|command|palmyra|marengo|pegasus|seedream|seedance|wan)"
                         r"(?:[\s._-]+[a-z]+){0,2}[\s._-]*v?\d+(?:\.\d+)*|o\d\b|qwen[\s-]?(?:max|plus|flash|turbo|long|coder|omni|vl|mt|math|doc)\b)")
# Documents whose lines that name no model (a residency multiplier, a batch discount, a region list) can
# apply to every model they cover; structured price lists and model indexes have one line per model.
DOCUMENT_KINDS = {"tables", "text", "markdown", "card"}


def risk_tokens(line, rx):
    """What a wording-only change keeps: prices, rates, multipliers, context limits and dates, plus the places a
    line names with any short marks beside them (a Bedrock region row: "us-east-1 (N. Virginia) | no | yes")."""
    text = official.norm(line)
    if rx:
        text = rx.sub(" ", text)
    text = OTHER_MODEL.sub(" ", text)  # another model's version number is not a price
    tokens = {"price:" + re.sub(r"[\s,]", "", t) for t in PRICE.findall(text) + LIMIT.findall(text)}
    tokens |= {"date:" + d.lower() for d in DATE.findall(line)}
    places = sorted(set(PLACE.findall(text)))
    if places:
        tokens |= {"place:" + p for p in places}
        cells = json.loads(line[len("table: "):]).get("cells", []) if line.startswith("table: {") else []
        marks = [c.lower() for c in cells if isinstance(c, str) and c and len(c) <= 16 and not PRICE.search(c)]
        if marks:
            tokens.add("place:" + "/".join(places) + " = " + " | ".join(marks))
    return tokens


def compare(removed, added, rx):
    """("low" | "high", reason) for changed lines: high when they differ in a price, rate, multiplier, context
    limit, date, or region and its marks. Which values appear counts, not how often: a table that repeats a
    price once less is a layout change."""
    old = set().union(*(risk_tokens(r, rx) for r in removed))
    new = set().union(*(risk_tokens(r, rx) for r in added))
    moved = {t.split(":", 1)[0] for t in old ^ new}
    if not moved:
        return "low", "wording or layout only; no price, rate, limit, date or region changed"
    what = [text for kind, text in (("price", "a price, rate, multiplier or context limit"), ("date", "a date"),
                                    ("place", "a region or its availability")) if kind in moved]
    return "high", " and ".join(what) + " changed"


def classify(before, after, rx):
    """("low" | "high", reason) for one model's lines in one source, before and after."""
    if not before:
        return "high", "new lines about the model (it may now be offered)"
    if not after:
        return "high", "the model's lines are gone (it may no longer be offered)"
    return compare(sorted(set(before) - set(after)), sorted(set(after) - set(before)), rx)


def names_a_model(record, rxs):
    text = official.norm(record)
    return bool(OTHER_MODEL.search(text)) or any(rx.search(text) for rx in rxs)


def scoped_lines(records, rx, others):
    """A model's lines in a page about it: those naming it, plus those naming no model at all (region rows,
    notes). Lines about other models are not its own."""
    return [r for r in records if (rx and rx.search(official.norm(r))) or not names_a_model(r, others)]


def general_changes(data, config, baseline, current, errors):
    """Changed lines in a multi-model document that name no model. Lines about models the dataset does not
    track are ignored; the rest (a residency multiplier, a batch discount, a region list) concern every model
    the document covers, so a changed price, limit, date or region among them is held for review."""
    rxs = [rx for rx in map(model_regex, data["models"].values()) if rx]
    found = []
    for source in config:
        sid = source["id"]
        snapshot, previous = current.get(sid), baseline.get("sources", {}).get(sid)
        if (not snapshot or not previous or sid in errors or source.get("auto") or source.get("models") or source.get("facts")
                or source.get("kind") not in DOCUMENT_KINDS):
            continue
        before, after = set(previous.get("records", [])), set(snapshot["records"])
        removed = sorted(r for r in before - after if not names_a_model(r, rxs))
        added = sorted(r for r in after - before if not names_a_model(r, rxs))
        if removed or added:
            risk, reason = compare(removed, added, None)
            found.append(dict(source=sid, url=snapshot["url"], risk=risk, reason=reason, added=added[:12], removed=removed[:12],
                              added_all=added, removed_all=removed))
    return found


# ---- Changes the daily check applies itself ----------------------------------------------------------

AUTO_FILE = HERE / "prices-auto.json"
FIELD_WORDS = (("cache_write_1h", r"\b1\s?h(?:our)?\b.*writ|writ.*\b1\s?h(?:our)?\b"), ("cache_write", r"writ"),
               ("cache_read", r"cache[ds]?\s?(?:hit|read)|cached"), ("out", r"\boutput"), ("in", r"\binput"))
LONG = re.compile(r"long[\s-]context|more than \d+\s?k|over \d+\s?k|>\s?\d+\s?k")
TIER_WORDS = {"standard", "batch", "flex", "priority", "fast", "ultrafast", "global", "regional", "geo", "cris", "region", "us", "eu"}
FIELD_NAMES = {"in": "input", "out": "output", "cache_read": "cache read", "cache_write": "cache write", "cache_write_1h": "1-hour cache write"}


def field_of(text):
    """The rate a column header or row label names ("Cache Hits", "Short context output", "1h Cache Write")."""
    text = text.lower()
    return next((field for field, pattern in FIELD_WORDS if re.search(pattern, text)), None)


def amount(token):
    """A USD amount in a price token; None for a percentage or multiplier."""
    token = token.replace(",", "").strip()
    if "%" in token or re.search(r"[x×]$", token):
        return None
    number = re.search(r"\d+(?:\.\d+)?", token)
    return float(number.group()) if number else None


def offers_of(cell):
    """(path, rates, label words) for every price set in a cell: the listed offer, its shown tiers and their
    long-context rates. Paths are those prices-auto.json uses."""
    out = [("base", cell, (cell.get("tier") or "") + " " + (cell.get("endpoint") or ""))]
    out += [("variant:" + v["label"], v, v["label"] + " " + (v.get("endpoint") or "")) for v in cell.get("variants", [])
            if not v.get("future_only") and not v.get("context_only")]
    out += [(p + "/long_context", o["long_context"], text) for p, o, text in list(out) if isinstance(o.get("long_context"), dict)]
    return out


def row_edits(change, cell, records, parts=None):
    """The rate edits one changed source proves for one offer, or None. Proof: every changed line is a table row
    that reappears with only prices changed, each changed price sits in a column (or beside a row label) that
    names its rate, and exactly one offer in the cell charged the old price there. parts names the rates of a
    cell that lists several ("$1.40 / $0.26 / $4.40" on Fireworks: price_parts in source-config.json)."""
    if cell.get("status") != "priced" or not change["added_all"] or not change["removed_all"]:
        return None
    def row(record):
        if not record.startswith("table: {"):
            return None
        o = json.loads(record[len("table: "):])
        return o.get("heading", ""), o.get("cells", [])
    rows = {"old": [row(r) for r in change["removed_all"]], "new": [row(r) for r in change["added_all"]]}
    if any(r is None for side in rows.values() for r in side):
        return None
    shape = lambda cells: tuple(official.norm(PRICE.sub("#", c)) for c in cells)
    pairs = {}
    for side, found in rows.items():
        for heading, cells in found:
            pairs.setdefault((heading, shape(cells)), {}).setdefault(side, []).append(cells)
    headers = {}
    for record in records:
        r = row(record)
        if r and not any(PRICE.search(c) for c in r[1]) and any(field_of(c) for c in r[1]):
            headers.setdefault((r[0], len(r[1])), set()).add(tuple(r[1]))
    edits = []
    for (heading, _), sides in pairs.items():
        if len(sides.get("old", [])) != 1 or len(sides.get("new", [])) != 1:
            return None
        old, new = sides["old"][0], sides["new"][0]
        found = headers.get((heading, len(old)), set())
        header = next(iter(found)) if len(found) == 1 else None
        label = " ".join(c for c in old if not PRICE.search(c))
        for i, (a, b) in enumerate(zip(old, new)):
            if a == b:
                continue
            ta, tb = PRICE.findall(a), PRICE.findall(b)
            if not ta or len(ta) != len(tb) or (len(ta) > 1 and len(ta) != len(parts or [])):
                return None
            column = header[i] if header else ""
            for j, (sa, sb) in enumerate(zip(ta, tb)):
                va, vb = amount(sa), amount(sb)
                if va is None or vb is None:
                    return None
                if va == vb:
                    continue
                field = parts[j] if len(ta) > 1 else field_of(column) or field_of(label)
                if not field:
                    return None
                long = bool(LONG.search((column + " " + label + " " + heading).lower()))
                hits = [(path, o, text) for path, o, text in offers_of(cell)
                        if path.endswith("/long_context") == long and o.get(field) is not None and abs(o[field] - va) < 1e-9]
                if len(hits) > 1:
                    # The row label, column or table names the tier ("Geo CRIS", "Priority", "Batch pricing").
                    words = set(official.norm(label + " " + column).split()) | (TIER_WORDS & set(official.norm(heading).split()))
                    score = {path: len(words & set(official.norm(text).split())) for path, _, text in hits}
                    best = max(score.values())
                    hits = [h for h in hits if score[h[0]] == best] if best else hits
                if len(hits) != 1 or hits[0][1].get("promotion"):
                    return None
                edits.append(dict(offer=hits[0][0], field=field, old=va, new=vb))
    return edits or None


def proven_edits(data, changes, current, dbx, sources):
    """Every edit the live sources prove: Databricks rates from its DBU tables, and table rows where only a
    price moved. Edits that disagree about the same rate are dropped."""
    out = [dict(model=key, platform="databricks", source="dbx-prices", **e) for key, edits in dbx.items() for e in edits]
    for c in changes:
        if c["risk"] != "high" or c["platform"] == "databricks" or c["source"] not in current:
            continue
        parts = next((s.get("price_parts") for s in sources if s["id"] == c["source"]), None)
        edits = row_edits(c, data["models"][c["model"]]["platforms"][c["platform"]], current[c["source"]]["records"], parts)
        if edits:
            out += [dict(model=c["model"], platform=c["platform"], source=c["source"], url=c["url"], **e) for e in edits]
    target = {}
    for e in out:
        target.setdefault((e["model"], e["platform"], e["offer"], e["field"]), set()).add(e["new"])
    return [e for e in out if len(target[(e["model"], e["platform"], e["offer"], e["field"])]) == 1]


def usd(value):
    return f"${value:.2f}" if round(value, 2) == value else f"${value:g}"


def describe(edit, data):
    model = data["models"].get(edit["model"], {}).get("name", edit["model"])
    tier = "" if edit["offer"] == "base" else " (" + edit["offer"].replace("variant:", "").replace("/long_context", ", long context") + ")"
    return f"{model} · {edit['platform']}{tier}: {FIELD_NAMES[edit['field']]} {usd(edit['old'])} → {usd(edit['new'])}"


def apply_edits(edits, today):
    """Adds proven edits to prices-auto.json and rebuilds; a model whose edits break the build's checks
    (a Claude cache-hit share, a +10% regional tier, the validator) keeps its old rates for review.
    Returns the edits that were kept."""
    if not edits:
        return []
    original = AUTO_FILE.read_text()
    def attempt(chosen):
        doc = json.loads(original)
        doc["changes"] = doc.get("changes", []) + [dict(date=today.isoformat(), **e) for e in chosen]
        AUTO_FILE.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n")
        return all(subprocess.run([sys.executable, str(HERE / script)], capture_output=True, text=True).returncode == 0
                   for script in ("build-data.py", "validate-data.py"))
    if attempt(edits):
        return edits
    kept = []
    groups = {}
    for e in edits:
        groups.setdefault((e["model"], e["platform"]), []).append(e)
    for group in groups.values():
        if attempt(kept + group):
            kept += group
    if not attempt(kept):
        AUTO_FILE.write_text(original)
        subprocess.run([sys.executable, str(HERE / "build-data.py")], capture_output=True, text=True, check=True)
        return []
    return kept


def accept_low_risk(baseline, current, changes, errors, alerts, general=()):
    """The reviewed baseline after accepting today's low-risk changes. Every line in a high-risk change (about a
    model, or naming none) stays as reviewed; a source without a reviewed baseline waits for --record-baseline."""
    out = dict(baseline, sources=dict(baseline.get("sources", {})))
    held = {}
    for c in [*changes, *general]:
        if c["risk"] == "high":
            added, removed = held.setdefault(c["source"], (set(), set()))
            added |= set(c["added_all"])
            removed |= set(c["removed_all"])
    for sid, snapshot in current.items():
        if sid in errors or sid not in out["sources"]:
            continue
        added, removed = held.get(sid, (set(), set()))
        if not added and not removed:
            out["sources"][sid] = snapshot
            continue
        kept = sorted((set(snapshot["records"]) - added) | removed)
        out["sources"][sid] = dict(snapshot, records=kept, digest=hashlib.sha256(packed(kept).encode()).hexdigest())
    # Retirements and promotions switch on their dates by themselves; record them as seen. A tier verified only
    # through a date stays due until someone re-checks its rates and records the baseline.
    out["acknowledged_lifecycle"] = sorted(set(baseline.get("acknowledged_lifecycle", [])) |
                                           {alert_key(a) for a in alerts if abs(a["days"]) <= DUE_WINDOW and not needs_action(a)})
    return out


def cell_checks(data, config, baseline, current, errors, fact_issues, previous, today, general=(), gone=(), applied=None):
    """Per model and platform: verified today, or the sources whose lines about it changed. general =
    general_changes(); gone = Databricks endpoints missing from its region tables; applied = changes whose new
    rates the check applied itself, {(model, platform, source): reason}."""
    day = today.isoformat()
    applied = applied or {}
    held = {g["source"] for g in general if g["risk"] == "high"}
    rxs = {key: model_regex(model) for key, model in data["models"].items()}
    meta_index = {}
    for source in config:
        for meta in source.get("meta", []):
            meta_index.setdefault(meta, []).append(source["id"])
    by_id = {source["id"]: source for source in config}
    old = (previous or {}).get("cells", {})
    cells, changes = {}, []
    for key, model in data["models"].items():
        rx = rxs[key]
        others = [r for k, r in rxs.items() if k != key and r]
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
            changed, unchecked, accepted = [], [], []
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
                if sid in held:
                    unchecked.append(sid)  # a line naming no model changed a price, date or region
                if by_id[sid].get("models"):
                    rb, ra = scoped_lines(before, rx, others), scoped_lines(after, rx, others)
                else:
                    rb, ra = relevant(before, rx), relevant(after, rx)
                if not rb and not ra:
                    # No line names the model: still not offered, or (for an offered model) only a
                    # whole-source match can confirm nothing changed.
                    if offered and set(before) != set(after):
                        unchecked.append(sid)
                    continue
                if set(rb) != set(ra):
                    risk, reason = classify(rb, ra, rx)
                    proof = (key, pl, "dbx-prices" if by_id[sid].get("facts") == "dbx-prices" else sid)
                    if risk == "high" and proof in applied:
                        risk, reason = "applied", applied[proof]
                    if risk == "high" and pl == "databricks" and by_id[sid].get("facts") == "dbx-prices" and key not in fact_issues:
                        risk, reason = "low", "every rate still matches the DBU table"
                    (changed if risk == "high" else accepted).append(sid)
                    added, removed = sorted(set(ra) - set(rb)), sorted(set(rb) - set(ra))
                    changes.append(dict(model=key, name=model.get("name", key), platform=pl, source=sid, url=current[sid]["url"],
                                        risk=risk, reason=reason, added=added[:12], removed=removed[:12], added_all=added, removed_all=removed))
            if pl == "databricks" and key in fact_issues:
                changed.append("dbx-prices")
            if pl == "databricks" and key in gone:
                changed.append("dbx-regions")
            last = old.get(ref, {})
            verified = max(filter(None, [last.get("verified"), cell.get("pricing_checked_at"), (cell.get("endpoints") or {}).get("checked_at")]), default=None)
            if changed:
                cells[ref] = dict(verified=verified, changed_at=last.get("changed_at") or day, sources=changed)
            elif unchecked:
                cells[ref] = dict(verified=verified, unchecked=unchecked)
            else:
                cells[ref] = dict(verified=day, accepted=accepted) if accepted else dict(verified=day)
    return cells, changes


def issue_markdown(report, cells, changes, fact_issues, data, listed, failing=None, general=(), unrecorded=(), gone=None, last_read=None):
    """The rolling GitHub issue: only what a person needs to act on. failing = sources not read for STALE_DAYS
    days or more (a single failed read is usually temporary)."""
    failing = report["sources_failed"] if failing is None else failing
    gone, last_read = gone or {}, last_read or {}
    name = lambda key: data["models"].get(key, {}).get("name", key)
    review = sorted({ref for ref, c in cells.items() if c.get("changed_at") and ref.split("|")[0] in listed})
    verified = sum(1 for ref, c in cells.items() if c.get("verified") == report["checked_at"] and ref.split("|")[0] in listed)
    low = sum(1 for c in changes if c.get("risk") == "low" and c["model"] in listed) + sum(1 for g in general if g["risk"] == "low")
    done = sum(1 for c in changes if c.get("risk") == "applied" and c["model"] in listed)
    lines = [f"Daily check {report['checked_at']}: {verified} listed offers verified today; {len(review)} need review; "
             f"{done} price changes applied and {low} low-risk changes accepted automatically; {len(report['sources_failed'])} sources could not be read.", ""]
    fact_issues = {k: v for k, v in fact_issues.items() if k in listed}
    if fact_issues:
        lines += ["## Databricks prices that differ from its DBU tables", ""]
        lines += [f"- **{name(k)}**: " + "; ".join(v) for k, v in sorted(fact_issues.items())]
        lines.append("")
    shown = [c for c in changes if c["model"] in listed and c.get("risk", "high") == "high"]
    if shown:
        lines += ["## Official sources whose lines about a model changed", ""]
        for c in shown[:60]:
            lines.append(f"- **{c['name']}** · {c['platform']} · [{c['source']}]({c['url']}) · {c.get('reason', '')}")
            lines += [f"  - `+ {r[:220]}`" for r in c["added"][:4]] + [f"  - `- {r[:220]}`" for r in c["removed"][:4]]
        if len(shown) > 60:
            lines.append(f"- … and {len(shown) - 60} more (see the run's JSON artifact)")
        lines.append("")
    held = [g for g in general if g["risk"] == "high"]
    if held:
        lines += ["## Lines that name no model but changed a price, date or region", "",
                  "They can apply to every model the source covers (a residency multiplier, a batch discount, a region list). "
                  "Until they are reviewed, those offers keep their last verified date.", ""]
        for g in held:
            lines.append(f"- [{g['source']}]({g['url']}) · {g['reason']}")
            lines += [f"  - `+ {r[:220]}`" for r in g["added"][:4]] + [f"  - `- {r[:220]}`" for r in g["removed"][:4]]
        lines.append("")
    if gone:
        lines += ["## Databricks endpoints missing from its region tables", ""]
        lines += [f"- **{name(k)}**: not in the tables since {since}; its card still shows the last regions." for k, since in sorted(gone.items())] + [""]
    if unrecorded:
        lines += ["## Sources without a reviewed baseline", "", "Check each source, then record the reviewed baseline. Until then its offers keep their last verified date.", ""]
        lines += [f"- {sid}" for sid in unrecorded] + [""]
    if failing:
        lines += [f"## Sources not read for {STALE_DAYS} days or more", ""]
        lines += [f"- {sid} (last read {last_read.get(sid) or 'unknown'}): {report['sources_failed'][sid]}" for sid in sorted(failing)] + [""]
    due = report.get("lifecycle_due") or []
    action = [a for a in due if needs_action(a)]
    if action:
        lines += [f"## Tier rates verified only through a date within {DUE_WINDOW} days", "",
                  "After that date the tier shows \"not verified\". Re-check its rates and update `endpoints.json`, then record the reviewed baseline.", ""]
        lines += [f"- {a['model']} · {a['platform']} · {a['event']} {a['date']} ({a['state']})" for a in action] + [""]
    scheduled = [a for a in due if not needs_action(a)]
    if scheduled:
        lines += [f"## Dates within {DUE_WINDOW} days (the page switches on its own)", ""]
        lines += [f"- {a['model']} · {a['platform']} · {a['event']} {a['date']} ({a['state']})" for a in scheduled] + [""]
    lines += ["## How to resolve", "",
              "1. Open each source, confirm the change, and update `llm-pricing/v2-maintenance/build-data.py` or `endpoints.json`.",
              "2. Run `python v2-maintenance/build-data.py` and the tests, then push.",
              "3. Record the reviewed baseline: Actions → *LLM pricing v2 daily refresh* → Run workflow, tick **Record the reviewed baseline**. That run re-checks every source and closes this issue when nothing is left. (Locally: `review-sources.py --record-baseline`; it refuses if any source cannot be read.)",
              "",
              "Price changes the check can prove from the official source (Databricks' DBU tables, or a table row where only the price moved) are applied automatically; changes that leave every price, rate, limit, date and region untouched, and lines about models the page does not track, are accepted. Both are listed in the run summary.", ""]
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
        lines.extend([f"## Dates within {DUE_WINDOW} days", "",
                      "Retirements and promotions switch on their dates by themselves and are acknowledged automatically. A tier verified "
                      "only through a date needs its rates re-checked; it stays listed until a reviewed baseline is recorded.", ""])
        for alert in report["lifecycle_due"]:
            lines.append(f"- {alert['model']} · {alert['platform']} · {alert['event']} {alert['date']} ({alert['state']})" + (" · re-check needed" if needs_action(alert) else ""))
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


def sources_read(previous, sources, current, today):
    """The last day each source was read, carried from run to run in v2-checks.json."""
    if previous and "sources_read" in previous:
        read = dict(previous["sources_read"])
    elif previous:
        read = {s["id"]: previous["checked_at"] for s in sources if s["id"] not in previous.get("sources_failed", [])}
    else:
        read = {}
    read.update({sid: today.isoformat() for sid in current})
    return {s["id"]: read[s["id"]] for s in sources if s["id"] in read}


def stale(errors, last_read, today):
    """Failed sources not read for STALE_DAYS days or more: one failed read, same-day re-runs and a source that
    fails every other day are not listed."""
    return sorted(sid for sid in errors if not last_read.get(sid) or (today - dt.date.fromisoformat(last_read[sid])).days >= STALE_DAYS)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, help="Use previously downloaded official source files (offline).")
    parser.add_argument("--report-dir", type=Path, required=True)
    parser.add_argument("--record-baseline", action="store_true", help="Explicitly record a reviewed baseline. Never used by scheduled runs.")
    parser.add_argument("--checks", type=Path, help="Write per-offer verification dates (the page's v2-checks.json).")
    parser.add_argument("--issue", type=Path, help="Write the review-issue Markdown here (empty file when nothing needs review).")
    parser.add_argument("--fail-on-change", action="store_true", help="Exit 2 when anything needs review (the issue is written).")
    parser.add_argument("--accept-low-risk", action="store_true", help="Record low-risk changes (no price, rate or date moved) in the reviewed baseline.")
    parser.add_argument("--apply-proven", action="store_true", help="Apply price changes the official sources prove (prices-auto.json), rebuild and validate.")
    parser.add_argument("--applied", type=Path, help="Write one line per price change applied automatically (for the commit message).")
    parser.add_argument("--as-of", default=dt.datetime.now(HKT).date().isoformat(), help="Run date (default: today in Hong Kong).")
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
        recorded = {sid: {k: v for k, v in snapshot.items() if k != "facts"} for sid, snapshot in current.items()}
        baseline_file.write_text(json.dumps(dict(schema=1, checked_at=today.isoformat(), acknowledged_lifecycle=acknowledged, sources=recorded), ensure_ascii=False, indent=1) + "\n")
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
    ranking_file = HERE.parent / "v2-ranking.json"
    listed = set(json.loads(ranking_file.read_text())["models"]) if ranking_file.exists() else set(data["models"])
    auto_file = HERE / "endpoints-auto.json"
    auto = json.loads(auto_file.read_text()).get("databricks", {}) if auto_file.exists() else {}
    gone = {k: e["missing_since"] for k, e in auto.items() if e.get("missing_since") and k in listed}
    general = general_changes(data, sources, baseline, current, errors)
    cells, changes = cell_checks(data, sources, baseline, current, errors, fact_issues, previous, today, general, gone)
    applied = []
    if args.apply_proven:
        applied = apply_edits(proven_edits(data, changes, current, dbx_edits(data, facts, today, complete) if facts else {}, sources), today)
        if applied:
            # Check again against the rebuilt data: the applied rates now match their sources.
            data = json.loads((HERE.parent / "v2-data.json").read_text())
            fact_issues = dbx_fact_issues(data, facts, today, complete) if facts else {}
            done = {}
            for e in applied:
                done.setdefault((e["model"], e["platform"], e["source"]), []).append(describe(e, data))
            done = {k: "applied automatically: " + "; ".join(v) for k, v in done.items()}
            cells, changes = cell_checks(data, sources, baseline, current, errors, fact_issues, previous, today, general, gone, done)
    last_read = sources_read(previous, sources, current, today)
    failing = stale(errors, last_read, today)
    unrecorded = sorted(sid for sid in current if sid not in baseline.get("sources", {}))
    issue, review = issue_markdown(report, cells, changes, fact_issues, data, listed, failing, general, unrecorded, gone, last_read)
    listed_facts = {k: v for k, v in fact_issues.items() if k in listed}
    held = [g for g in general if g["risk"] == "high"]
    action = [a for a in report["lifecycle_due"] if needs_action(a)]
    needs_review = bool(review or listed_facts or failing or held or unrecorded or gone or action)
    accepted = [c for c in changes if c["risk"] == "low"] + [g for g in general if g["risk"] == "low"]
    if args.accept_low_risk:
        updated = accept_low_risk(baseline, current, changes, errors, report["lifecycle_alerts"], general)
        # The baseline is 3.6 MB: rewrite it only when something in it changed.
        if updated["sources"] != baseline.get("sources") or updated["acknowledged_lifecycle"] != baseline.get("acknowledged_lifecycle", []):
            updated["checked_at"] = today.isoformat()
            baseline_file.write_text(json.dumps(updated, ensure_ascii=False, indent=1) + "\n")
    for c in [*changes, *general]:
        c.pop("added_all", None)
        c.pop("removed_all", None)
    report.update(dbx_price_issues=fact_issues, model_changes=changes, unattributed_changes=general)
    args.report_dir.mkdir(parents=True, exist_ok=True)
    stem = "source-review-" + today.isoformat()
    (args.report_dir / (stem + ".json")).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    summary = markdown_report(report)
    if accepted:
        summary += "\n## Accepted automatically (low risk)\n\n" + "\n".join(
            f"- {c['name']} · {c['platform']} · {c['source']}: {c['reason']}" if "model" in c else f"- {c['source']} · lines naming no model: {c['reason']}"
            for c in accepted) + "\n"
    if applied:
        summary += "\n## Applied automatically (proven by the official source)\n\n" + "\n".join(f"- {describe(e, data)} ({e['source']})" for e in applied) + "\n"
    (args.report_dir / (stem + ".md")).write_text(summary)
    if args.applied:
        args.applied.write_text("".join(describe(e, data) + "\n" for e in applied))
    if args.checks:
        repo = os.environ.get("GITHUB_REPOSITORY")
        names = lambda ref: data["models"][ref.split("|")[0]].get("name", ref) + " · " + ref.split("|")[1]
        checks = dict(schema=1, checked_at=today.isoformat(), sources_checked=len(current), sources_failed=sorted(errors), sources_read=last_read,
                      review=[names(ref) for ref in review],
                      issue_url=f"https://github.com/{repo}/issues?q=is%3Aopen+label%3Allm-pricing-review" if repo else None,
                      cells=dict(sorted(cells.items())))
        if previous and previous.get("issue_url") and not repo:
            checks["issue_url"] = previous["issue_url"]
        args.checks.write_text(json.dumps(checks, ensure_ascii=False, indent=1) + "\n")
    if args.issue:
        args.issue.write_text(issue if needs_review else "")
    verified = sum(1 for c in cells.values() if c.get("verified") == today.isoformat())
    print(f"Review report: {verified} offers verified today; {len(review)} listed offers need review; {len(applied)} price changes applied; {len(held)} sources with changed lines naming no model; "
          f"{len(accepted)} low-risk changes accepted; {len(report['changes'])} changed sources; {len(errors)} failed sources ({len(failing)} for {STALE_DAYS}+ days); "
          f"{len(action)} tier dates to re-check.")
    if os.environ.get("GITHUB_ACTIONS") == "true":
        # Upcoming dates show as run annotations even while they are not yet due.
        for alert in report["lifecycle_alerts"]:
            print(f"::warning title=Lifecycle {alert['date']}::{alert['model']} · {alert['platform']} · {alert['event']} ({alert['days']} days)")
    if len(errors) * 2 > len(sources):
        sys.exit(1)
    if args.fail_on_change and needs_review:
        sys.exit(2)


if __name__ == "__main__":
    main()
