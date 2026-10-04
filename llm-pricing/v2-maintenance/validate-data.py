#!/usr/bin/env python3
"""Validate the public offer contract and review-critical corrections, read-only."""
import datetime as dt
import json
import math
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
FIELDS = ("in", "out", "cache_read", "cache_write", "cache_write_1h", "cache_storage")
PLATFORMS = {"databricks", "official", "bedrock", "azure_foundry", "fireworks", "gcloud", "alicloud"}
SCOPES = {"global", "regional", "data-zone", "geographic", "unverified"}
SERVICE_TIERS = {"standard", "priority", "batch", "flex", "off-peak"}
GEOGRAPHIES = {"Global", "Americas", "Europe", "APAC"}
LEVELS = {"in-region", "geo", "global", "unknown", "none"}
CACHE_WRITE = {"priced", "input-rate", "not-listed", "no-caching"}


def region_entry(r):
    """[geography, level, label, text]; level and label may be equal-length lists (one line, several endpoint types)."""
    if not (isinstance(r, list) and len(r) == 4 and r[0] in GEOGRAPHIES and isinstance(r[3], str) and r[3]):
        return False
    levels, labels = r[1] if isinstance(r[1], list) else [r[1]], r[2] if isinstance(r[2], list) else [r[2]]
    return all(x in LEVELS for x in levels) and all(isinstance(x, str) and x for x in labels) and \
        (len(levels) == 1 or len(levels) == len(labels))


def validate(data):
    failures = []
    def check(condition, message):
        if not condition:
            failures.append(message)
    def date(value):
        try:
            return dt.date.fromisoformat(value).isoformat() == value
        except (ValueError, TypeError):
            return False
    def rate(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0
    def rates(offer, at):
        check(rate(offer.get("in")) and rate(offer.get("out")), at + ": missing input / output rates.")
        for field in FIELDS:
            if field in offer:
                check(rate(offer[field]), at + ": invalid " + field)
        if "long_context" in offer:
            check(rate(offer["long_context"].get("in")) and rate(offer["long_context"].get("out")), at + ": invalid long-context rates.")
            check(all(rate(offer["long_context"][f]) for f in FIELDS if f in offer["long_context"]), at + ": invalid long-context cache rates.")
    def dated(entries, at):
        for entry in entries if isinstance(entries, list) else [entries]:
            if isinstance(entry, str):
                check(bool(entry.strip()), at + ": empty text.")
                continue
            check(isinstance(entry, dict) and isinstance(entry.get("text"), str) and entry["text"].strip(), at + ": dated entry without text.")
            for bound in ("from", "until"):
                if isinstance(entry, dict) and bound in entry:
                    check(date(entry[bound]), at + ": invalid " + bound + " date.")
            if isinstance(entry, dict) and date(entry.get("from")) and date(entry.get("until")):
                check(entry["from"] <= entry["until"], at + ": dated entry ends before it starts.")
            if isinstance(entry, dict) and "models" in entry:
                check(isinstance(entry["models"], list) and entry["models"] and all(k in data["models"] for k in entry["models"]), at + ": unknown models on a talk-track line.")
    check(data.get("schema") == 4, "Expected v2 schema 4.")
    check(date(data.get("reviewed_at")), "Invalid review date.")
    check(rate(data.get("usd_per_dbu")) and data.get("usd_per_dbu", 0) > 0, "Invalid DBU basis.")
    for group, lines in data.get("insights", {}).items():
        check(group in data["groups"], "Talk track for unknown family " + group + ".")
        dated(lines, "Talk track " + group)
    for key, model in data.get("models", {}).items():
        check(model.get("name") and model.get("group") in data["groups"], key + ": missing name or family.")
        check(set(model.get("platforms", {})) == PLATFORMS, key + ": missing provider state.")
        check("warn" not in model, key + ": undated warning; use dated notices.")
        if "notices" in model:
            dated(model["notices"], key + " notices")
        for pl, cell in model.get("platforms", {}).items():
            at = key + " / " + pl
            check(cell.get("status") in {"priced", "unavailable", "unverified", "dedicated"}, at + ": invalid state.")
            check(date(cell.get("availability_checked_at")), at + ": availability date missing.")
            check("model_id" in cell and (cell["model_id"] is None or isinstance(cell["model_id"], str)), at + ": model ID state missing.")
            if cell.get("alt"):
                check(cell["alt"].get("name") and rate(cell["alt"].get("in")) and rate(cell["alt"].get("out")), at + ": closest-model rates invalid.")
            if cell.get("status") == "priced":
                rates(cell, at)
                check(date(cell.get("pricing_checked_at")), at + ": price date missing.")
                check(str(cell.get("url", "")).startswith("https://"), at + ": price source missing.")
                check(cell.get("comparison_scope") in SCOPES, at + ": comparison scope missing.")
                check(cell.get("service_tier") in SERVICE_TIERS, at + ": service tier missing.")
                check(cell.get("model_match") in {"confirmed", "unverified"}, at + ": model-match state missing.")
                if cell.get("context_threshold") is not None:
                    check(isinstance(cell["context_threshold"], int) and cell["context_threshold"] > 0, at + ": invalid context threshold.")
                variants = cell.get("variants", [])
                check(len({v.get("id") for v in variants}) == len(variants), at + ": duplicate variant IDs.")
                for v in variants:
                    vat = at + " / " + str(v.get("label"))
                    check(isinstance(v.get("label"), str) and v["label"].strip(), at + ": variant label missing.")
                    rates(v, vat)
                    check(date(v.get("pricing_checked_at")), vat + ": variant verification date missing.")
                    check(v.get("comparison_scope") in SCOPES, vat + ": comparison scope missing.")
                    check(v.get("service_tier") in SERVICE_TIERS, vat + ": service tier missing.")
                    check(v.get("model_match") in {"confirmed", "unverified"}, vat + ": model-match state missing.")
                    for bound in ("valid_through", "effective_from"):
                        if bound in v:
                            check(date(v[bound]), vat + ": invalid " + bound + ".")
                    if v.get("future_only"):
                        check(date(v.get("effective_from")), vat + ": scheduled price without a start date.")
                for offer in [cell, *variants]:
                    if offer.get("promotion"):
                        promotion = offer["promotion"]
                        check(date(promotion.get("ends_on")), at + ": promotion end missing.")
                        rates(promotion.get("after", {}), at + " after promotion")
                        check(isinstance(promotion.get("after", {}).get("tier"), str), at + ": post-promotion tier label missing.")
            else:
                check(not any(field in cell for field in FIELDS), at + ": an unpriced state contains token rates.")
                check(cell.get("pricing_checked_at") is None, at + ": an unpriced offer has a price verification date.")
            if "endpoints" in cell:
                e = cell["endpoints"]
                check(date(e.get("checked_at")) and all(sid in data["source_meta"] for sid in e.get("src", [])) and e.get("src"), at + ": endpoint details need a date and known sources.")
                for key in ("hk", "tw"):
                    check(isinstance(e.get(key), list) and len(e[key]) == 2 and e[key][0] in {"in-region", "routed", "none", "unknown"}, at + ": invalid " + key + " availability.")
                check(all(region_entry(r) for r in e.get("regions", [])), at + ": invalid region entry.")
                check(all(isinstance(n, list) and len(n) == 2 and all(isinstance(x, str) and x for x in n) for n in e.get("notes", [])), at + ": invalid note entry.")
                check(isinstance(e.get("ids"), list) and all(isinstance(x, str) and x for x in e["ids"]), at + ": invalid ID list.")
                check(e.get("cache_write") in CACHE_WRITE, at + ": cache-write policy missing.")
                check(all(isinstance(v.get("endpoint"), str) for v in cell.get("variants", [])) or not cell.get("endpoint"),
                      at + ": a labelled offer needs endpoint labels on every variant.")
            if cell.get("retires_on"):
                check(date(cell["retires_on"]) and cell.get("replacement") and cell.get("retirement_src") in data["source_meta"], at + ": retirement metadata incomplete.")
    return failures


def main():
    data = json.loads((HERE.parent / "v2-data.json").read_text())
    failures = validate(data)
    if failures:
        print("\n".join(failures), file=sys.stderr)
        raise SystemExit(1)
    print(f"Validated {len(data['models'])} models and all provider states, sources and dates.")


if __name__ == "__main__":
    main()
