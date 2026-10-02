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
    check(data.get("schema") == 4, "Expected v2 schema 4.")
    check(date(data.get("reviewed_at")), "Invalid review date.")
    check(rate(data.get("usd_per_dbu")) and data.get("usd_per_dbu", 0) > 0, "Invalid DBU basis.")
    for key, model in data.get("models", {}).items():
        check(model.get("name") and model.get("group") in data["groups"], key + ": missing name or family.")
        check(set(model.get("platforms", {})) == PLATFORMS, key + ": missing provider state.")
        for pl, cell in model.get("platforms", {}).items():
            at = key + " / " + pl
            check(cell.get("status") in {"priced", "unavailable", "unverified", "dedicated"}, at + ": invalid state.")
            check(date(cell.get("availability_checked_at")), at + ": availability date missing.")
            check("model_id" in cell and (cell["model_id"] is None or isinstance(cell["model_id"], str)), at + ": model ID state missing.")
            if cell.get("status") == "priced":
                check(rate(cell.get("in")) and rate(cell.get("out")), at + ": missing input / output rates.")
                check(date(cell.get("pricing_checked_at")), at + ": price date missing.")
                check(str(cell.get("url", "")).startswith("https://"), at + ": price source missing.")
                check(cell.get("comparison_scope") in {"global", "regional", "data-zone", "geographic", "unverified"}, at + ": comparison scope missing.")
                check(cell.get("model_match") in {"confirmed", "unverified"}, at + ": model-match state missing.")
                for field in FIELDS:
                    if field in cell:
                        check(rate(cell[field]), at + ": invalid " + field)
                variants = cell.get("variants", [])
                check(len({v.get("id") for v in variants}) == len(variants), at + ": duplicate variant IDs.")
                for v in variants:
                    check(rate(v.get("in")) and rate(v.get("out")), at + ": invalid variant rates.")
                    check(date(v.get("pricing_checked_at")), at + ": variant verification date missing.")
                for offer in [cell, *variants]:
                    if offer.get("promotion"):
                        promotion = offer["promotion"]
                        check(date(promotion.get("ends_on")), at + ": promotion end missing.")
                        check(rate(promotion.get("after", {}).get("in")) and rate(promotion.get("after", {}).get("out")), at + ": post-promotion rates missing.")
            else:
                check(not any(field in cell for field in FIELDS), at + ": an unpriced state contains token rates.")
                check(cell.get("pricing_checked_at") is None, at + ": an unpriced offer has a price verification date.")
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
