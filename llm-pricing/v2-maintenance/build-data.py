#!/usr/bin/env python3
"""Build the independent v2 dataset. Never writes index.html or data.json.

The seed preserves the 2026-09-28 reviewed offers. Corrections below reference
the official documents reviewed on 2026-10-02. Dates belong to individual offers;
unverified prices and endpoint IDs stay empty. All rates are USD / million tokens.
"""
import argparse
import copy
import datetime as dt
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
REVIEWED = "2026-10-02"
RATE_FIELDS = ("in", "out", "cache_read", "cache_write", "cache_write_1h", "cache_storage")
PLATFORMS = ("databricks", "official", "bedrock", "azure_foundry", "fireworks", "gcloud", "alicloud")


def rates(i, o, cr=None, cw=None, cw1h=None, storage=None):
    return {k: v for k, v in zip(RATE_FIELDS, (i, o, cr, cw, cw1h, storage)) if v is not None}


def offer(i, o, cr=None, cw=None, cw1h=None, *, src, tier, model_id=None,
          regions=None, note=None, storage=None, scope="global", **extra):
    return dict(rates(i, o, cr, cw, cw1h, storage), src=src, tier=tier,
                model_id=model_id, regions=regions, note=note, status="priced",
                pricing_checked_at=REVIEWED, availability_checked_at=REVIEWED,
                comparison_scope=scope, service_tier="standard", model_match="confirmed", **extra)


def pending(note, src, model_id=None, available=None):
    return dict(status="unverified", note=note, src=src, model_id=model_id,
                available=available, pricing_checked_at=None, availability_checked_at=REVIEWED)


def unavailable(src, note=None):
    return dict(status="unavailable", src=src, note=note,
                pricing_checked_at=None, availability_checked_at=REVIEWED)


def variant(label, i, o, cr=None, cw=None, cw1h=None, *, scope="global", service="standard", **extra):
    return dict(rates(i, o, cr, cw, cw1h), label=label, comparison_scope=scope,
                service_tier=service, pricing_checked_at=REVIEWED, **extra)


def promo(cell, ends, after, label, tier):
    # The tier label the offer carries once the promotion has ended.
    cell["promotion"] = dict(ends_on=ends, after=dict(after, tier=tier), label=label)


def shift(day, days):
    return (dt.date.fromisoformat(day) + dt.timedelta(days=days)).isoformat()


def pretty(day):
    d = dt.date.fromisoformat(day)
    return f"{d.day} {d:%b %Y}"


def normalize(data):
    ids = set(json.loads((HERE / "verified-ids.json").read_text())["databricks"])
    exceptions = {
        "qwen/qwen3.5-122b": "databricks-qwen35-122b-a10b",
        "qwen/qwen3-next-80b-instruct": "databricks-qwen3-next-80b-a3b-instruct",
        "deepseek/deepseek-v4-pro": "databricks-deepseek-v4-pro-0813",
        "deepseek/deepseek-v4-flash": "databricks-deepseek-v4-flash-0731",
        "meta/llama-3.3-70b": "databricks-meta-llama-3-3-70b-instruct",
        "meta/llama-3.1-8b": "databricks-meta-llama-3-1-8b-instruct",
        "moonshot/kimi-k2.7": None,  # Absent from the current catalog; no inferred endpoint ID.
    }
    for key, model in data["models"].items():
        model.pop("verified", None)  # A model-wide flag would hide offer-level uncertainty.
        model["model_key"] = key
        for pl in PLATFORMS:
            c = model["platforms"].setdefault(pl, {"unknown": True})
            old_status = "unverified" if c.get("unknown") else "unavailable" if c.get("not_offered") else "priced"
            c.setdefault("status", old_status)
            c.pop("unknown", None)
            c.pop("not_offered", None)
            c.setdefault("model_id", None)
            c.setdefault("model_match", "confirmed" if c["status"] == "priced" else "unverified")
            c.setdefault("comparison_scope", "global")
            c.setdefault("service_tier", "standard")
            c.setdefault("pricing_checked_at", "2026-09-28" if c["status"] == "priced" else None)
            c.setdefault("availability_checked_at", "2026-09-28")
            if pl == "databricks":
                candidate = exceptions.get(key, "databricks-" + key.split("/", 1)[1].replace(".", "-"))
                if candidate in ids:
                    c["model_id"] = candidate
                    c["model_id_source"] = "dbx_models"
                    c["model_id_checked_at"] = REVIEWED
                if c["status"] == "priced":
                    c["pricing_checked_at"] = REVIEWED
                    c["dbu_rate_basis"] = data["usd_per_dbu"]
                # Processing scope is descriptive only; price comparisons use each platform's cheapest
                # standard price in any region. US-hosted endpoints are regional, like Bedrock us-east-1.
                if (c.get("regions") or "").startswith("US only"):
                    c["comparison_scope"] = "regional"
            if pl == "official" and model["group"] == "openai":
                c["model_id"] = key.split("/", 1)[1]
                c["model_id_source"] = "openai"
                c["model_id_checked_at"] = REVIEWED
            if pl == "official" and key == "deepseek/deepseek-v4-pro":
                c["model_id"] = "deepseek-v4-pro"
                c["snapshot"] = "DeepSeek-V4-Pro-0813"
                c["model_id_source"] = "deepseek"
                c["model_id_checked_at"] = REVIEWED
            if pl == "official" and key == "deepseek/deepseek-v4.1-flash":
                c["model_id"] = "deepseek-flash"
                c["snapshot"] = "DeepSeek-V4.1-Flash"
                c["model_id_source"] = "deepseek"
                c["model_id_checked_at"] = REVIEWED
            if pl == "official" and key in ("moonshot/kimi-k3", "moonshot/kimi-k2.7"):
                c["model_id"] = "kimi-k3" if key.endswith("k3") else "kimi-k2.7-code"
                c["model_id_source"] = "moonshot"
                c["model_id_checked_at"] = REVIEWED
            if pl in ("official", "gcloud") and model["group"] == "google":
                c["model_id"] = key.split("/", 1)[1]
                c["model_id_source"] = "google" if pl == "official" else "vertex"
                c["model_id_checked_at"] = REVIEWED
            if pl == "bedrock" and model["group"] == "openai" and c["status"] == "priced":
                c["model_id"] = "openai." + key.split("/", 1)[1]
                c["model_id_source"] = "aws_openai"
                c["model_id_checked_at"] = REVIEWED
            tier = c.get("tier", "")
            if pl == "gcloud" and tier == "Vertex MaaS":
                c["comparison_scope"] = "unverified"
                c["comparison_note"] = "Price is verified; this MaaS offer's processing scope is not confirmed."
            if "Data Zone" in tier:
                c["comparison_scope"] = "data-zone"
            elif "In-region only" in tier or "On-demand (us-east-1)" in tier:
                c["comparison_scope"] = "regional"
            if pl == "fireworks" and "dedicated GPU" in c.get("note", ""):
                c["status"] = "dedicated"
                c["availability_checked_at"] = REVIEWED
            for n, v in enumerate(c.get("variants", [])):
                label = v["label"]
                v["id"] = "variant-" + str(n)
                v.setdefault("pricing_checked_at", c["pricing_checked_at"])
                v.setdefault("comparison_scope", c["comparison_scope"])
                v.setdefault("service_tier", "standard")
                if any(s in label.lower() for s in ("regional", "in-region", "us-only", "us geo", "tokyo")):
                    v["comparison_scope"] = "regional"
                if "Data Zone" in label or "Data Zone" in tier:
                    v["comparison_scope"] = "data-zone"
                if "Priority" in label or "Fast mode" in label or label == "Fast":
                    v["service_tier"] = "priority"
                elif "Flex" in label:
                    v["service_tier"] = "flex"
                elif "Batch" in label:
                    v["service_tier"] = "batch"
                elif "off-peak" in label.lower() or "idle hours" in label.lower():
                    # Time-of-day discounts are listed but not compared: the listed peak rate always applies.
                    v["service_tier"] = "off-peak"
                # Historical alternate snapshots are not substitutes for the row's model.
                if any(s in label for s in ("“V4 Flash” SKU", "deepseek-v4-flash SKU")):
                    v["model_match"] = "unverified"
                    v["comparison_note"] = "A different snapshot; excluded from same-model comparisons."


def add_models(data):
    models = data["models"]
    sonnet = copy.deepcopy(models["anthropic/claude-sonnet-5"])
    sonnet.update(name="Claude Sonnet 5.5", short="Sonnet 5.5", model_key="anthropic/claude-sonnet-5.5",
                  badges=["Added"], ctx="1M", note="Current Sonnet generation; verified on all five priced platforms.")
    for pl in PLATFORMS:
        c = sonnet["platforms"][pl]
        c["availability_checked_at"] = REVIEWED
        if c["status"] == "priced":
            c["pricing_checked_at"] = REVIEWED
            c["model_id"] = {"databricks": "databricks-claude-sonnet-5-5", "bedrock": "anthropic.claude-sonnet-5-5"}.get(pl, "claude-sonnet-5-5")
            c["model_id_source"] = "dbx_models" if pl == "databricks" else "anthropic_models"
            c["model_id_checked_at"] = REVIEWED
            c["regions"] = "Consult the current model-region catalog for this endpoint."
            for v in c.get("variants", []):
                v["pricing_checked_at"] = REVIEWED
                # Residency premiums include both cache-write TTLs.
                if v["comparison_scope"] == "regional":
                    v.update(cache_write=2.75, cache_write_1h=4.4)
    sonnet["platforms"]["official"]["variants"][0].update(cache_read=0.1, cache_write=1.25, cache_write_1h=2.0)
    models["anthropic/claude-sonnet-5.5"] = sonnet

    common_closed = {
        "gcloud": unavailable("vertex", "Vertex offers gpt-oss; no closed OpenAI GPT offer was verified."),
        "fireworks": unavailable("fireworks_nexus", "Nexus routes with your own provider key; no Fireworks per-token offer."),
        "alicloud": unavailable("ali", "No closed OpenAI GPT offer in the reviewed Model Studio catalog."),
    }
    direct = offer(2, 10, 0.1, 2.5, src="openai", tier="Standard · ≤272K input", model_id="gpt-6.1-sol",
                   context_threshold=272000, long_context=rates(4, 15, 0.2, 5), cache_storage=0)
    direct["variants"] = [
        variant("Fast mode", 4, 20, 0.2, 5, service="priority", long_context=rates(8, 30, 0.4, 10), cache_storage=0),
        variant("Batch", 1, 5, 0.05, 1.25, service="batch", long_context=rates(2, 7.5, 0.1, 2.5), cache_storage=0),
        variant("Flex", 1, 5, 0.05, 1.25, service="flex", long_context=rates(2, 7.5, 0.1, 2.5), cache_storage=0),
        variant("Regional processing +10%", 2.2, 11, 0.11, 2.75, scope="regional", long_context=rates(4.4, 16.5, 0.22, 5.5), cache_storage=0),
    ]
    aws = offer(2, 10, 0.1, 2.5, src="aws_gpt61", tier="Global cross-region · runtime",
                model_id="openai.gpt-6.1-sol", context_threshold=272000, long_context=rates(4, 15, 0.2, 5),
                regions="Mantle in us-east-1; runtime US geographic / global cross-region profiles.",
                note="Explicit prompt-cache controls are not supported; use actual billed cache-token volumes.", cache_storage=0)
    aws["variants"] = [variant("Mantle in-region (us-east-1)", 2.2, 11, 0.11, 2.75, scope="regional",
                               long_context=rates(4.4, 16.5, 0.22, 5.5), cache_storage=0),
                       variant("US geographic cross-region", 2.2, 11, 0.11, 2.75, scope="regional",
                               long_context=rates(4.4, 16.5, 0.22, 5.5), cache_storage=0)]
    models["openai/gpt-6.1-sol"] = dict(name="GPT-6.1 Sol", short="GPT-6.1 Sol", maker="OpenAI", group="openai", oss=False,
        ctx="1.05M", badges=["Added"], about="Agentic coding and reasoning", note="Databricks lists the endpoint; its price page still names GPT-6 Sol. No predecessor price is assumed.",
        platforms=dict(common_closed, databricks=pending("Supported pay-per-token endpoint; exact GPT-6.1 pricing is pending verification.", "dbx_models", "databricks-gpt-6-1-sol", True),
            official=direct, bedrock=aws, azure_foundry=pending("No exact GPT-6.1 Sol offer verified in the reviewed Azure retail catalog.", "azure")))

    for version, i, o, cr in [("3.5", 0.3, 2.5, 0.03), ("3.1", 0.25, 1.5, 0.025)]:
        key = "google/gemini-" + version + "-flash-lite"
        api_id = key.split("/", 1)[1]
        dbx = offer(i, o, cr, src="dbx_prop", tier="Standard · 20% promotion", model_id="databricks-" + api_id.replace(".", "-"),
                    regions="Global endpoint; cross-geography routing is required.", dbu_rate_basis=0.07)
        promo(dbx, "2027-01-31", rates(round(i / 0.8, 6), round(o / 0.8, 6), round(cr / 0.8, 6)), "Databricks 20% promotion", "Standard pay-per-token")
        pr = variant("Priority (promotion)", round(i * 1.8, 6), round(o * 1.8, 6), round(cr * 1.8, 6), service="priority")
        promo(pr, "2027-01-31", rates(round(i * 1.8 / 0.8, 6), round(o * 1.8 / 0.8, 6), round(cr * 1.8 / 0.8, 6)), "Databricks 20% promotion", "Priority")
        regional = variant("Regional processing +10%", round(i * 1.1, 6), round(o * 1.1, 6), round(cr * 1.1, 6), scope="regional")
        promo(regional, "2027-01-31", rates(round(i * 1.1 / 0.8, 6), round(o * 1.1 / 0.8, 6), round(cr * 1.1 / 0.8, 6)), "Databricks 20% promotion", "Regional processing +10%")
        dbx["variants"] = [pr, regional]
        off = offer(i, o, cr, src="google", tier="Gemini API paid tier · text", model_id=api_id, storage=1,
                    note="Cache storage: $1 / million token-hours. Audio input has a different price on 3.1 Flash-Lite.")
        # Google's published API rounds 3.5 Lite cache hits differently on Priority / Flex.
        off["variants"] = [variant("Batch", i / 2, o / 2, 0.02 if version == "3.5" else cr / 2, service="batch", cache_storage=1 if version == "3.5" else 0.5),
                           variant("Flex", i / 2, o / 2, 0.02 if version == "3.5" else cr / 2, service="flex", cache_storage=1 if version == "3.5" else 0.5),
                           variant("Priority", round(i * 1.8, 6), round(o * 1.8, 6), 0.05 if version == "3.5" else round(cr * 1.8, 6), service="priority", cache_storage=1 if version == "3.5" else 1.8)]
        vertex = offer(i, o, cr, src="vertex", tier="Global endpoint · text", model_id=api_id, storage=1)
        vertex["variants"] = [variant("Priority", round(i * 1.8, 6), round(o * 1.8, 6), round(cr * 1.8, 6), service="priority"),
                              variant("Flex / Batch", i / 2, o / 2, cr / 2, service="flex"),
                              variant("Non-global +10%", round(i * 1.1, 6), round(o * 1.1, 6), round(cr * 1.1, 6), scope="regional")]
        models[key] = dict(name="Gemini " + version + " Flash-Lite", short=version + " Flash-Lite", maker="Google", group="google", oss=False,
            badges=["Added"], ctx=None, about="Text-token comparison; audio / generated images excluded",
            warn="Databricks 20% promotion through 31 Jan 2027", platforms=dict(databricks=dbx, official=off, gcloud=vertex,
                bedrock=unavailable("aws", "No Gemini offer in the reviewed Bedrock catalog."),
                azure_foundry=unavailable("azure", "No Gemini per-token offer verified on Foundry."),
                fireworks=unavailable("fireworks_nexus", "Fireworks Nexus does not offer a Gemini per-token API."),
                alicloud=unavailable("ali")))

    for version in ("4.7", "4.6"):
        key = "xai/grok-" + version
        dbx = pending("Catalog lists Grok 4.7, but the price page still lists 4.6. Exact 4.7 rates are pending verification.", "dbx_models", "databricks-grok-4-7", True)
        if version == "4.6":
            dbx = offer(2, 6, 0.5, src="dbx_prop", tier="Standard · 20% promotion", model_id="databricks-grok-4-6", dbu_rate_basis=0.07,
                        regions="Consult the current model-region catalog.")
            promo(dbx, "2027-01-31", rates(2.5, 7.5, 0.625), "Databricks 20% promotion", "Standard pay-per-token")
            regional = variant("Regional processing +10%", 2.2, 6.6, 0.55, scope="regional")
            promo(regional, "2027-01-31", rates(2.75, 8.25, 0.6875), "Databricks 20% promotion", "Regional processing +10%")
            dbx["variants"] = [regional]
        off = offer(2, 6, 0.5, src="xai_" + version.replace(".", ""), tier="xAI API · <200K input", model_id="grok-" + version,
                    context_threshold=200000, context_threshold_inclusive=True, long_context=rates(4, 12, 1),
                    note="At 200K input tokens or above, higher-context rates apply to every token in the request.")
        aws = offer(2, 6, 0.5, src="aws", tier="Global cross-region · runtime", model_id="xai.grok-" + version,
                    model_id_source="aws_grok" + version.replace(".", ""),
                    billing_sku="xai.grok-" + version + "-mantle-*-global-standard",
                    regions="Runtime routing uses global.xai.grok-" + version + " (global) or us.xai.grok-" + version + " (US geographic). Consult the model card for region support.")
        aws["variants"] = [variant("Mantle in-region", 2.2, 6.6, 0.55, scope="regional"),
                           variant("US geographic cross-region", 2.2, 6.6, 0.55, scope="geographic"),
                           variant("Global Priority", 3.5, 10.5, 0.875, service="priority"),
                           variant("Global Flex", 1, 3, 0.25, service="flex")]
        if version == "4.7":
            aws.update(tier="Global cross-region · runtime", model_id="xai.grok-4.7", model_id_source="aws_grok47",
                       regions="Use the global.xai.grok-4.7 runtime inference ID for global routing; US geographic routing uses us.xai.grok-4.7.",
                       note="Billing SKU names contain mantle; the current model card documents bedrock-runtime programmatic access.")
            aws["variants"] = [variant("US geographic cross-region", 2.2, 6.6, 0.55, scope="geographic"),
                               variant("Global Priority", 3.5, 10.5, 0.875, service="priority"),
                               variant("Global Flex", 1, 3, 0.25, service="flex")]
        vertex = offer(2, 6, 0.5, src="vertex", tier="Vertex MaaS · ≤200K input", context_threshold=200000,
                       long_context=rates(4, 12, 1), model_id=None, scope="unverified",
                       comparison_note="Price is verified; endpoint scope is not confirmed for this offer.")
        azure = pending("Grok 4.7 is not in the reviewed East US retail price list; exact offer not verified.", "azure")
        if version == "4.6":
            azure = offer(2, 6, 0.5, src="azure", tier="Global Standard · ≤200K input", billing_sku="Azure Grok Models · 4.6 Inp/Outp/Cached Glbl",
                          context_threshold=200000, long_context=rates(4, 12, 1))
            azure["variants"] = [variant("Data Zone", 2.2, 6.6, 0.55, scope="data-zone", long_context=rates(4.4, 13.2, 1.1))]
        models[key] = dict(name="Grok " + version, short="Grok " + version, maker="xAI", group="xai", oss=False, ctx="500K", badges=["Added"],
            warn="Databricks 4.6 promotion through 31 Jan 2027" if version == "4.6" else None,
            platforms=dict(databricks=dbx, official=off, bedrock=aws, azure_foundry=azure, gcloud=vertex,
                           fireworks=unavailable("fireworks_models", "No Fireworks per-token offer verified."),
                           alicloud=unavailable("ali")))


TOP50_CHECKED = "2026-10-03"


def checked(cell, day=TOP50_CHECKED):
    """Offers added from the 2026-10-03 top-50 review carry that verification date."""
    if cell["status"] == "priced":
        cell["pricing_checked_at"] = day
        for v in cell.get("variants", []):
            v["pricing_checked_at"] = day
    if cell.get("model_id"):
        cell["model_id_checked_at"] = day
    cell["availability_checked_at"] = day
    return cell


def off_dbx(note="Not in the Databricks supported-models catalog."):
    return unavailable("dbx_models", note)


def add_top50_models(data):
    """arena.ai Best Overall top-50 models that at least one compared platform hosts (reviewed 2026-10-03).

    Models sold only through their maker's API (Muse Spark, Grok 4.5, Step 5, Hy3 / Hy4, MiMo,
    Gemini 4 Argon, Inkling Small, Qwen3.8 Flash Next) are not listed.
    """
    m = data["models"]
    data["source_meta"].update({
        "aws_gpt54": dict(url="https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-54.html", label="Bedrock GPT-5.4 pricing and regions"),
        "minimax": dict(url="https://platform.minimax.io/docs/pricing/overview", label="MiniMax API pricing"),
        "mistral": dict(url="https://docs.mistral.ai/models/model-cards/mistral-medium-3-5-26-04", label="Mistral Medium 3.5 model card"),
    })
    data["groups"]["other"] = dict(label="Other", title="Other labs")
    nexus = m["anthropic/claude-opus-5"]["platforms"]["fireworks"]["note"]
    no_cloud = {pl: unavailable(src, "Not in the reviewed " + name + " price list.") for pl, src, name in
                [("bedrock", "aws", "Bedrock"), ("azure_foundry", "azure", "Azure Foundry"), ("gcloud", "vertex", "Vertex"),
                 ("fireworks", "fireworks", "Fireworks serverless")]}
    for key, name, short, i, o, cr, cw, cw1h, dbx_id, extra in [
            ("anthropic/claude-fable-5", "Claude Fable 5", "Fable 5", 10, 50, 1, 12.5, 20, "databricks-claude-fable-5", []),
            ("anthropic/claude-opus-4.8", "Claude Opus 4.8", "Opus 4.8", 5, 25, 0.5, 6.25, 10, "databricks-claude-opus-4-8",
             [variant("Fast mode", 10, 50, service="priority")])]:
        regional = [round(x * 1.1, 6) for x in (i, o, cr, cw, cw1h)]
        official = offer(i, o, cr, cw, cw1h, src="anthropic", tier="Claude API")
        official["variants"] = [variant("Batch −50%", i / 2, o / 2, service="batch"), *extra]
        bedrock = offer(i, o, cr, cw, cw1h, src="aws_fm", tier="Global cross-region", billing_sku=name + " (Amazon Bedrock Edition)")
        bedrock["variants"] = [variant("Regional +10%", *regional, scope="regional")]
        vertex = offer(i, o, cr, cw, cw1h, src="vertex", tier="Global endpoint")
        vertex["variants"] = [variant("Regional endpoint +10%", *regional, scope="regional")]
        m[key] = dict(name=name, short=short, maker="Anthropic", group="anthropic", oss=False, badges=["Added"], ctx=None,
            platforms=dict(databricks=offer(i, o, cr, cw, cw1h, src="dbx_prop", tier="Standard pay-per-token", model_id=dbx_id,
                                            model_id_source="dbx_models", dbu_rate_basis=0.07),
                           official=official, bedrock=bedrock, gcloud=vertex,
                           azure_foundry=pending("Not in the reviewed Microsoft Foundry list of current Claude models.", "azure_claude"),
                           fireworks=unavailable("fireworks_nexus", nexus), alicloud=unavailable("ali")))

    dbx54 = offer(2.5, 15, 0.25, src="dbx_prop", tier="Standard · short context", model_id="databricks-gpt-5-4", model_id_source="dbx_models",
                  dbu_rate_basis=0.07, context_threshold=272000, long_context=rates(5, 22.5, 0.5))
    dbx54["variants"] = [variant("Priority", 5, 30, 0.5, service="priority")]
    api54 = offer(2.5, 15, 0.25, src="openai", tier="Standard · short context", model_id="gpt-5.4", context_threshold=272000,
                  long_context=rates(5, 22.5, 0.5), storage=0)
    api54["variants"] = [variant("Batch / Flex −50%", 1.25, 7.5, 0.13, service="flex", long_context=rates(2.5, 11.25, 0.25)),
                         variant("Fast mode", 5, 30, 0.5, service="priority")]
    m["openai/gpt-5.4"] = dict(name="GPT-5.4", short="GPT-5.4", maker="OpenAI", group="openai", oss=False, badges=["Added"], ctx=None,
        platforms=dict(databricks=dbx54, official=api54,
            bedrock=offer(2.75, 16.5, 0.275, src="aws_gpt54", tier="In-region only (+10% over OpenAI list)", model_id="openai.gpt-5.4",
                          context_threshold=272000, long_context=rates(5.5, 24.75, 0.55), scope="regional",
                          regions="Mantle in-region: us-east-1, us-east-2, us-west-2 and GovCloud (US-West, priced higher)."),
            azure_foundry=pending("Not in the reviewed Azure Foundry retail price list.", "azure"),
            gcloud=unavailable("vertex", "No GPT on Vertex (gpt-oss only)."), fireworks=unavailable("fireworks_nexus", nexus),
            alicloud=unavailable("ali")))

    dbx36 = offer(0.75, 3.75, 0.075, src="dbx_prop", tier="Intro promo (−50%) until 31 Dec 2026", model_id="databricks-gemini-3-6-flash",
                  model_id_source="dbx_models", dbu_rate_basis=0.07)
    dbx36["variants"] = [variant("From 1 Jan 2027", 1.5, 7.5, 0.15), variant("Priority", 1.35, 6.75, 0.135, service="priority")]
    api36 = offer(0.75, 3.75, 0.075, src="google", tier="Paid tier · intro until 31 Dec 2026", model_id="gemini-3.6-flash",
                  note="Cache storage $0.50 / million token-hours through 31 Dec 2026, then $1.00.")
    api36["variants"] = [variant("From 1 Jan 2027", 1.5, 7.5, 0.15), variant("Batch", 0.375, 1.875, 0.0375, service="batch"),
                         variant("Priority", 1.35, 6.75, 0.135, service="priority")]
    vx36 = offer(0.75, 3.75, 0.075, src="vertex", tier="Global endpoint · intro until 31 Dec 2026", model_id="gemini-3.6-flash")
    vx36["variants"] = [variant("From 1 Jan 2027", 1.5, 7.5, 0.15), variant("Priority", 1.35, 6.75, 0.135, service="priority"),
                        variant("Flex / Batch −50%", 0.375, 1.875, 0.0375, service="flex"),
                        variant("Non-global +10%", 0.825, 4.125, 0.0825, scope="regional")]
    m["google/gemini-3.6-flash"] = dict(name="Gemini 3.6 Flash", short="Gemini 3.6 Flash", maker="Google", group="google", oss=False,
        badges=["Added"], ctx=None, warn="Intro price ends 31 Dec 2026, then $1.50 / $7.50",
        platforms=dict(databricks=dbx36, official=api36, gcloud=vx36,
                       bedrock=unavailable("aws"), azure_foundry=unavailable("azure"),
                       fireworks=unavailable("fireworks_nexus", m["google/gemini-3.7-flash"]["platforms"]["fireworks"]["note"]),
                       alicloud=unavailable("ali")))

    dbx52 = offer(1.4, 4.4, 0.26, src="dbx_oss", tier="Standard pay-per-token", model_id="databricks-glm-5-2", model_id_source="dbx_models",
                  dbu_rate_basis=0.07)
    dbx52["variants"] = [variant("Priority", 2.45, 7.7, 0.455, service="priority")]
    az52 = offer(1.54, 4.84, 0.15, src="azure", tier="Data Zone · FW GLM 5.2 (Fireworks-hosted)", scope="data-zone",
                 billing_sku="FW GLM 5.2 Inp / Outp / Cache Inp DZ")
    az52["variants"] = [variant("Fast · Data Zone", 2.31, 7.26, 0.231, scope="data-zone", service="priority")]
    ali52 = offer(1.1, 3.851, src="ali", tier="Global scope", model_id="glm-5.2")
    ali52["variants"] = [variant("International (Singapore)", 1.4, 4.4), variant("US (Virginia)", 1.4, 4.4, scope="regional")]
    m["zai/glm-5.2"] = dict(name="GLM 5.2", short="GLM 5.2", maker="Z.ai", group="oss", oss=True, badges=["Added"], ctx=None,
        platforms=dict(databricks=dbx52, official=offer(1.4, 4.4, 0.26, src="zai", tier="Z.ai API", model_id="glm-5.2",
                                                        note="Cache storage free for a limited time."),
            bedrock=unavailable("aws", "Bedrock tops out at GLM 5."), azure_foundry=az52,
            gcloud=offer(1.4, 4.4, 0.14, src="vertex", tier="Vertex MaaS", scope="unverified"),
            fireworks=unavailable("fireworks", "Fireworks serverless lists GLM 5.3 and 5.3 Flash, not 5.2."), alicloud=ali52))
    m["zai/glm-5.2"]["platforms"]["bedrock"]["alt"] = dict(m["zai/glm-5.3"]["platforms"]["bedrock"]["alt"])

    def qwen(key, name, short, group, global_rates, variants, tier="Global scope", fireworks=None, note=None):
        cells = {}
        for pl, label in [("official", "Alibaba Model Studio · " + tier), ("alicloud", tier)]:
            cells[pl] = offer(*global_rates, src="ali", tier=label, model_id=key.split("/", 1)[1], note=note)
            cells[pl]["variants"] = [variant(*v[:3], **v[3]) for v in variants]
        m[key] = dict(name=name, short=short, maker="Alibaba Qwen", group=group, oss=group == "oss", badges=["Added"], ctx=None,
            platforms=dict(databricks=off_dbx(), **cells, bedrock=no_cloud["bedrock"], azure_foundry=no_cloud["azure_foundry"],
                           gcloud=no_cloud["gcloud"], fireworks=fireworks or no_cloud["fireworks"]))

    fw38 = offer(2, 6, 0.25, src="fireworks", tier="Serverless Standard")
    fw38["variants"] = [variant("Priority", 3, 9, 0.375, service="priority")]
    qwen("qwen/qwen3.8-max", "Qwen3.8 Max", "Qwen3.8 Max", "other", (1.65, 4.951), [("International (Singapore)", 2, 6, {})], fireworks=fw38)
    qwen("qwen/qwen3.7-max", "Qwen3.7 Max", "Qwen3.7 Max", "other", (1.65, 4.951),
         [("International (Singapore)", 2.5, 7.5, {}), ("US (Virginia)", 2.5, 7.5, dict(scope="regional"))])
    qwen("qwen/qwen3.7-plus", "Qwen3.7 Plus", "Qwen3.7 Plus", "other", (0.276, 1.101), [("International (Singapore) ≤256K", 0.4, 1.6, {})],
         tier="Global scope ≤256K", note="List price shown; Model Studio lists limited-time discounts (Global: daytime 20% off, night 60% off) with no end date.")
    qwen("qwen/qwen3.8-27b", "Qwen3.8 27B", "Qwen3.8 27B", "oss", (0.5, 3), [], tier="International (Singapore)",
         note="Open weights (Apache 2.0). China (Beijing) lists $0.424 / $1.696.")

    mm = offer(0.3, 1.2, 0.06, src="minimax", tier="Standard · ≤512K input", model_id="MiniMax-M3", context_threshold=512000,
               long_context=rates(0.6, 2.4, 0.12), note="Permanent 50% off list ($0.60 / $2.40).")
    mm["variants"] = [variant("Priority (1.5×)", 0.45, 1.8, 0.09, service="priority", long_context=rates(0.9, 3.6, 0.18))]
    fwm = offer(0.3, 1.2, 0.06, src="fireworks", tier="Serverless Standard")
    fwm["variants"] = [variant("Priority", 0.45, 1.8, 0.09, service="priority")]
    m["minimax/minimax-m3"] = dict(name="MiniMax M3", short="MiniMax M3", maker="MiniMax", group="oss", oss=True, badges=["Added"], ctx=None,
        platforms=dict(databricks=off_dbx(), official=mm, fireworks=fwm,
            azure_foundry=offer(0.33, 1.32, 0.066, src="azure", tier="Data Zone · FW MiniMax 3 (Fireworks-hosted)", scope="data-zone"),
            bedrock=unavailable("aws", "Bedrock lists MiniMax M2, M2.1 and M2.5, not M3."),
            gcloud=unavailable("vertex", "Vertex MaaS lists MiniMax-M2."),
            alicloud=unavailable("ali", "Model Studio lists MiniMax-M2.5 (China only).")))
    m["minimax/minimax-m3"]["platforms"]["gcloud"]["alt"] = dict(name="MiniMax-M2", short="M2", **{"in": 0.3, "out": 1.2})

    az35 = offer(1.5, 7.5, src="azure", tier="Global Standard", billing_sku="Azure Mistral Models · MM3.5 Inp / Outp glbl")
    az35["variants"] = [variant("Data Zone", 1.65, 8.25, scope="data-zone")]
    m["mistral/mistral-medium-3.5"] = dict(name="Mistral Medium 3.5", short="Mistral Med 3.5", maker="Mistral", group="oss", oss=True,
        badges=["Added"], ctx="256K", about="Open weights (Modified MIT)",
        platforms=dict(databricks=off_dbx(), official=offer(1.5, 7.5, src="mistral", tier="Mistral API", model_id="mistral-medium-3-5"),
            azure_foundry=az35, bedrock=no_cloud["bedrock"], fireworks=no_cloud["fireworks"], alicloud=unavailable("ali"),
            gcloud=unavailable("vertex", "Vertex MaaS lists Mistral Medium 3.")))
    m["mistral/mistral-medium-3.5"]["platforms"]["gcloud"]["alt"] = dict(name="Mistral Medium 3", short="Medium 3", **{"in": 0.4, "out": 2.0})

    for key in ("anthropic/claude-fable-5", "anthropic/claude-opus-4.8", "openai/gpt-5.4", "google/gemini-3.6-flash", "zai/glm-5.2",
                "qwen/qwen3.8-max", "qwen/qwen3.7-max", "qwen/qwen3.7-plus", "qwen/qwen3.8-27b", "minimax/minimax-m3", "mistral/mistral-medium-3.5"):
        for pl, c in m[key]["platforms"].items():
            m[key]["platforms"][pl] = checked(copy.deepcopy(c))


def corrections(data):
    m = data["models"]
    fireworks = {
        "deepseek/deepseek-v4-pro": ("https://fireworks.ai/models/deepseek-ai/deepseek-v4-pro-0813", "accounts/fireworks/models/deepseek-v4-pro-0813"),
        "deepseek/deepseek-v4-flash": ("https://fireworks.ai/models/deepseek-ai/deepseek-v4-flash-0731", "accounts/fireworks/models/deepseek-v4-flash-0731"),
        "moonshot/kimi-k2.7": ("https://fireworks.ai/models/fireworks/kimi-k2p7-code", "accounts/fireworks/models/kimi-k2p7-code"),
    }
    for key, (url, model_id) in fireworks.items():
        m[key]["platforms"]["fireworks"] = dict(status="dedicated", model_id=model_id, url=url, src="fireworks_models",
            model_id_source="fireworks_models", model_id_checked_at=REVIEWED, availability_checked_at=REVIEWED, pricing_checked_at=None,
            note="Serverless is not supported. Serverless deprecation began 25 Sep 2026; dedicated GPU deployment remains available.")
    kimi_aws = m["moonshot/kimi-k3"]["platforms"]["bedrock"]
    kimi_aws["variants"] = [
        variant("Regional Standard", 3.3, 16.5, 0.33, 4.125, scope="regional"),
        variant("Global Priority", 5.25, 26.25, 0.525, 6.5625, service="priority"),
        variant("Regional Priority", 5.775, 28.875, 0.5775, 7.21875, scope="regional", service="priority"),
        variant("Global Flex", 1.5, 7.5, 0.15, 1.875, service="flex"),
    ]
    kimi_aws["pricing_checked_at"] = REVIEWED
    retirement = {
        "tml/inkling": ["GLM 5.3", "Kimi K3"],
        "deepseek/deepseek-v4-pro": ["DeepSeek V4.1 Flash"],
        "moonshot/kimi-k2.7": ["Kimi K3"],
    }
    for key, replacements in retirement.items():
        c = m[key]["platforms"]["databricks"]
        c["retires_on"] = "2026-10-30"
        c["replacement"] = replacements
        c["retirement_src"] = "dbx_retirement"
        c["availability_checked_at"] = REVIEWED
        m[key]["warn"] = "Retires on Databricks 30 Oct 2026 · use " + " or ".join(replacements)
    for key in ("openai/gpt-6-sol", "openai/gpt-6-luna"):
        c = m[key]["platforms"]["bedrock"]
        c["regions"] = "Runtime global cross-region from US / APAC; Mantle in-region in us-east-1 (N. Virginia). Runtime has no direct in-region invocation."
        c["note"] = "Mantle regional access and runtime cross-region access use different endpoints."
        c["availability_checked_at"] = REVIEWED
    az = m["deepseek/deepseek-v4-pro"]["platforms"]["azure_foundry"]
    az["model_match"] = "unverified"
    az["comparison_note"] = "Azure's V4 Pro price is genuine, but its snapshot is not confirmed as Databricks' 0813 checkpoint."
    az["pricing_checked_at"] = REVIEWED
    az["snapshot"] = "Unconfirmed"
    az["billing_sku"] = "DeepSeek V4 Pro · Global Standard"
    for v in az.get("variants", []):
        v["model_match"] = "unverified"
        v["comparison_note"] = az["comparison_note"]


def enrich_context_and_promotions(data):
    for key, m in data["models"].items():
        group = m["group"]
        for pl, c in m["platforms"].items():
            if c["status"] != "priced":
                continue
            if pl == "databricks":
                c.setdefault("dbu_rate_basis", 0.07)
            variants = c.get("variants", [])
            if group == "openai":
                c.setdefault("context_threshold", 272000)
                for v in variants:
                    if "Long context" in v["label"]:
                        # Only the long-context rates the source lists; no derived cache-write rate.
                        c["long_context"] = {k: v[k] for k in RATE_FIELDS if k in v}
                        v["context_only"] = True
                if pl == "bedrock" and key != "openai/gpt-6.1-sol":
                    c["has_long_context"] = True
                    # No inherited competitor context multiplier without an exact rate check.
                if pl == "official":
                    c.setdefault("cache_storage", 0)
                # Batch / Flex cache charges and per-tier long-context rates were omitted from the
                # legacy JSON. They stay unverified; never derive them from the Standard tier.
            if group == "google":
                for v in variants:
                    if "Long context" in v["label"] or v["label"].startswith(">200K"):
                        c["context_threshold"] = 200000
                        c["long_context"] = {k: v[k] for k in RATE_FIELDS if k in v}
                        v["context_only"] = True
                if key == "google/gemini-3.1-pro" and pl == "databricks":
                    after = rates(2.5, 15, 0.25)
                    after["long_context"] = rates(5, 22.5, 0.5)
                    promo(c, "2027-01-31", after, "Databricks 20% promotion", "Standard pay-per-token")
                if key in ("google/gemini-3.8-flash", "google/gemini-3.7-flash", "google/gemini-3.6-flash"):
                    list_tier = "Standard pay-per-token" if pl == "databricks" else c["tier"].split(" · intro")[0]
                    promo(c, "2026-12-31", rates(1.5, 7.5, 0.15), "Flash introductory promotion", list_tier)
                    for v in variants:
                        if "From 1 Jan" in v["label"]:
                            v["future_only"] = True
                        elif not v.get("promotion"):
                            promo(v, "2026-12-31", {k: round(v[k] * 2, 6) for k in RATE_FIELDS if k in v}, "Flash introductory promotion", v["label"])
                if pl == "official" and key == "google/gemini-3.1-pro":
                    c["cache_storage"] = 4.5
                if pl == "gcloud":
                    c["cache_storage"] = 4.5 if key == "google/gemini-3.1-pro" else 1
            if key == "openai/gpt-5.6-sol":
                after = rates(5, 30, 0.5, 6.25)
                after["long_context"] = rates(10, 45, 1, 12.5)
                promo(c, "2026-11-21", after, "GPT-5.6 Sol promotion", c["tier"])
                # Future nonstandard tiers are not extrapolated from Standard.
                for v in variants:
                    if not v.get("context_only"):
                        v["valid_through"] = "2026-11-21"
            for n, v in enumerate(variants):
                v.setdefault("id", "variant-" + str(n))
                v.setdefault("model_match", c.get("model_match", "confirmed"))
                v.setdefault("pricing_checked_at", c["pricing_checked_at"])
                v.setdefault("comparison_scope", c.get("comparison_scope", "global"))
                v.setdefault("service_tier", c.get("service_tier", "standard"))
                if "List from" in v["label"]:
                    v["future_only"] = True
                # A scheduled list price takes effect the day after the promotion it follows.
                if v.get("future_only") and c.get("promotion"):
                    v["effective_from"] = shift(c["promotion"]["ends_on"], 1)
            c["url"] = c.get("url") or data["source_meta"].get(c.get("src"), {}).get("url")
            if not c["url"]:
                # A dated source is mandatory for any priced offer.
                raise ValueError("Missing source for " + key + " / " + pl)


def lifecycle_notices(data):
    """Model warnings expire with the date they describe; retirement warnings switch to past tense."""
    for key, m in data["models"].items():
        warn = m.pop("warn", None)
        if not warn:
            continue
        dbx = m["platforms"]["databricks"]
        if dbx.get("retires_on"):
            day = dbx["retires_on"]
            m["notices"] = [dict(text=warn, until=shift(day, -1)),
                            {"text": "Retired on Databricks " + pretty(day) + " · use " + " or ".join(dbx["replacement"]), "from": day}]
            continue
        ends = [o["promotion"]["ends_on"] for c in m["platforms"].values() for o in [c, *c.get("variants", [])] if o.get("promotion")]
        if not ends:
            raise ValueError("Warning without a dated event for " + key)
        m["notices"] = [dict(text=warn, until=min(ends))]


def build():
    data = json.loads((HERE / "seed-data.json").read_text())
    data.pop("fetched_at", None)
    data.update(schema=4, reviewed_at=TOP50_CHECKED,
                basis="Each cell shows the platform's cheapest standard (real-time, on-demand) text-token price for the confirmed model version, "
                      "in any region or processing scope. Δ compares it with Databricks' cheapest standard price. Batch, Flex, Priority and "
                      "off-peak prices are listed in the row details and are not compared.")
    sources = {
        "dbx_retirement": ("https://docs.databricks.com/aws/en/machine-learning/retired-models-policy", "Databricks retirement dates and replacements"),
        "anthropic_models": ("https://platform.claude.com/docs/en/about-claude/models/overview", "Anthropic model IDs by platform"),
        "aws_gpt61": ("https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html", "Bedrock GPT-6.1 Sol pricing, endpoints and context tiers"),
        "aws_grok47": ("https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-xai-grok-4-7.html", "Bedrock Grok 4.7 endpoints and service tiers"),
        "aws_grok46": ("https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-xai-grok-4-6.html", "Bedrock Grok 4.6 endpoints and service tiers"),
        "xai_47": ("https://docs.x.ai/developers/models/grok-4.7", "xAI Grok 4.7 pricing"),
        "xai_46": ("https://docs.x.ai/developers/models/grok-4.6", "xAI Grok 4.6 pricing"),
    }
    for sid, (url, label) in sources.items():
        data["source_meta"][sid] = dict(url=url, label=label)
    data["groups"]["xai"] = dict(label="xAI", title="xAI Grok")
    normalize(data)
    add_models(data)
    add_top50_models(data)
    corrections(data)
    enrich_context_and_promotions(data)
    lifecycle_notices(data)
    # Talk-track lines: the original page's seller insights, re-checked against the v2 offers.
    # Plain strings always apply; {"text", "from", "until"} lines apply within their dates, and lines
    # with "models" only while one of those models is listed. The page computes the
    # "priced below Databricks" line from the rows it shows.
    data["insights"] = {
        "oss": [{"text": "Inkling, DeepSeek V4 Pro (0813) and Kimi K2.7 retire on Databricks on 30 Oct 2026. Replacement models appear in the row details.", "until": "2026-10-29"},
                {"text": "Inkling, DeepSeek V4 Pro (0813) and Kimi K2.7 retired on Databricks on 30 Oct 2026. Their rows list the replacements.", "from": "2026-10-30"},
                "Same model, same list price on Fireworks and the maker's own API. Azure's Fireworks-hosted GLM 5.3, GLM 5.3 Flash and DeepSeek V4.1 Flash cost +25%.",
                "Bedrock and Vertex trail a generation: GLM 5 / 5.2, DeepSeek V3.2, Kimi K2.x. Neither sells GLM 5.3 or DeepSeek V4, and Vertex has no Kimi K3.",
                {"text": "DeepSeek V4 Flash (0731): $0.14 / $0.28 on Databricks vs $0.44 / $1.32 on Azure and $0.424 / $1.27 on Alibaba. Fireworks now sells it on dedicated GPUs only.", "models": ["deepseek/deepseek-v4-flash"]},
                {"text": "APAC residency: Bedrock in-region Tokyo is +20% on OSS; Databricks regional processing is +10% on ⌖ models.", "models": ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "google/gemma-3-12b", "qwen/qwen3-next-80b-instruct"]},
                {"text": "Not on Databricks: MiniMax M3 (Fireworks $0.30 / $1.20; Azure Data Zone), Mistral Medium 3.5 (Azure $1.50 / $7.50) and Qwen3.8 27B (Alibaba).", "models": ["minimax/minimax-m3", "mistral/mistral-medium-3.5", "qwen/qwen3.8-27b"]}],
        "anthropic": ["List-price parity everywhere: Databricks, Bedrock global, Vertex global and Microsoft Foundry all charge Anthropic's rates, including Sonnet 5.5 ($2 / $10, $0.20 cached input).",
                      "Regional / data-residency endpoints are +10% on Bedrock, Vertex and Databricks (⌖); Anthropic's US-only inference is ×1.1.",
                      "Microsoft Foundry deploys Claude only from US or Sweden Central resources, with no APAC region. Vertex offers asia-east1 (Taiwan) and asia-southeast1 regional endpoints.",
                      "On Databricks, Opus 5.5, Fable 5.1 and Sonnet 5 use cross-geo routing in APAC; Opus 5 is in-region on AWS Sydney and GCP Singapore. Sonnet 4.6 and Haiku 4.5 run in-region in Singapore and Tokyo."],
        "openai": ["List-price parity on Databricks, Azure Global Standard and Bedrock Global cross-region; in-region / Data Zone tiers are +10% on Azure and Bedrock.",
                   "APAC gap: GPT-6 and GPT-5.6 on Databricks run in US, Canada and EU regions only. Bedrock serves them to Tokyo and Singapore (GPT-6 Sol / Luna and GPT-5.6 also Taipei) via global cross-region. Azure has no Hong Kong or Singapore region for them.",
                   "Bedrock sells GPT-6 and GPT-5.x (GPT-6 Sol / Luna since 22 Sep 2026) and charges a 30-minute cache write. GPT-5.5 there is in-region only, at +10%. Not on Vertex.",
                   {"text": "GPT-5.4 is $2.50 / $15 on Databricks and OpenAI; Bedrock sells it in-region only at $2.75 / $16.50 (+10%).", "models": ["openai/gpt-5.4"]},
                   "GPT-6.1 Sol cuts cached input to $0.10. Its Databricks endpoint is supported; exact Databricks prices are still pending verification.",
                   {"text": "GPT-5.6 Sol promo ends 21 Nov 2026, then $5 / $30 on every platform.", "until": "2026-11-21"},
                   {"text": "GPT-5.6 Sol is $5 / $30 on every platform since its promotion ended 21 Nov 2026.", "from": "2026-11-22"}],
        "google": [{"text": "Databricks matches Google today: a 20% promotion on Gemini 3.1 Pro runs to 31 Jan 2027, then Databricks lists +25% ($2.50 / $15.00).", "until": "2027-01-31"},
                   {"text": "Gemini 3.1 Pro on Databricks lists at $2.50 / $15.00 since its promotion ended 31 Jan 2027: 25% above the Gemini API and Vertex.", "from": "2027-02-01"},
                   {"text": "The same 20% Databricks promotion covers Gemini 3.5 and 3.1 Flash-Lite to 31 Jan 2027, then $0.375 / $3.125 and $0.3125 / $1.875 (+25%).", "until": "2027-01-31", "models": ["google/gemini-3.5-flash-lite", "google/gemini-3.1-flash-lite"]},
                   {"text": "Flash intro pricing (50% off) ends 31 Dec 2026 everywhere, then $1.50 / $7.50.", "until": "2026-12-31"},
                   {"text": "Gemini 3.8 / 3.7 Flash list at $1.50 / $7.50 everywhere since intro pricing ended 31 Dec 2026.", "from": "2027-01-01"},
                   "Only Databricks, Vertex and the Gemini API sell Gemini; Bedrock, Azure and Alibaba do not.",
                   "Context storage is a separate charge on the Gemini API. Audio and image-output rates are outside this text-token comparison."],
        "other": ["Qwen3.8 Max, Qwen3.7 Max and Qwen3.7 Plus are sold on Alibaba Model Studio (Qwen3.8 Max also on Fireworks); none is on Databricks, Bedrock, Azure or Vertex.",
                  "Model Studio's Global scope is below its International (Singapore) list; Qwen3.7 Plus also has limited-time daytime / night discounts."],
        "xai": ["Grok 4.7: xAI, Bedrock Global and Vertex list $2 / $6, with $0.50 cached input. Databricks 4.7 prices remain pending verification.",
                {"text": "Grok 4.6 has Databricks promotional parity at $2 / $6 through 31 Jan 2027.", "until": "2027-01-31"},
                {"text": "Grok 4.6 on Databricks is $2.50 / $7.50 since its promotion ended 31 Jan 2027; xAI, Bedrock and Azure stay at $2 / $6.", "from": "2027-02-01"},
                "Bedrock adds Global Priority ($3.50 / $10.50) and Flex ($1 / $3) tiers for Grok; Azure Data Zone is +10%."],
    }
    data["changes"] = [
        "2026-10-03: Added the arena.ai Best Overall top-50 models that a compared platform hosts: Claude Fable 5, Claude Opus 4.8, GPT-5.4, Gemini 3.6 Flash, GLM 5.2, Qwen3.8 Max, Qwen3.7 Max, Qwen3.7 Plus, Qwen3.8 27B, MiniMax M3 and Mistral Medium 3.5.",
        "Added GPT-6.1 Sol, Claude Sonnet 5.5, Gemini 3.5 / 3.1 Flash-Lite, Grok 4.7 and Grok 4.6.",
        "Removed three discontinued Fireworks serverless quotes; dedicated deployments are a separate state.",
        "Corrected Bedrock Kimi K3 Global / Regional Priority and cache-read / write tiers.",
        "Added Inkling retirement and replacement guidance; corrected GPT-6 Sol / Luna Mantle availability.",
        "2026-10-03: Δ compares each platform's cheapest standard price in any region (previously only matching processing scopes).",
        "2026-10-03: Promotion and retirement notices, talk-track lines and post-promotion tier labels follow their dates.",
        "2026-10-03: Removed derived Batch / Flex cache rates and per-tier long-context rates that no source lists.",
    ]
    for key, m in data["models"].items():
        m["model_key"] = key
        for pl, c in m["platforms"].items():
            c.setdefault("model_id", None)
            c.setdefault("pricing_checked_at", None)
            c.setdefault("availability_checked_at", REVIEWED)
            c["url"] = c.get("url") or data["source_meta"].get(c.get("src"), {}).get("url")
            if c.get("model_id") and not c.get("model_id_checked_at"):
                c["model_id_checked_at"] = REVIEWED
    data["sources"] = sorted({s["url"] for s in data["source_meta"].values()})
    # Put new versions first within each family; keep the original curated OSS order.
    first = ["anthropic/claude-sonnet-5.5", "openai/gpt-6.1-sol", "google/gemini-3.5-flash-lite", "google/gemini-3.1-flash-lite", "xai/grok-4.7", "xai/grok-4.6"]
    data["models"] = {k: data["models"][k] for k in first + [k for k in data["models"] if k not in first]}
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Verify the published v2 data is reproducible; write nothing.")
    args = parser.parse_args()
    data = build()
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    target = HERE.parent / "v2-data.json"
    if args.check:
        if not target.exists() or target.read_text() != text:
            raise SystemExit("v2-data.json differs from its reviewed source. Run build-data.py and review the diff.")
        print("v2-data.json matches the reviewed source.")
    else:
        target.write_text(text)
        count = sum(c["status"] == "priced" for m in data["models"].values() for c in m["platforms"].values())
        print(f"Wrote {target.name}: {len(data['models'])} models, {count} priced offers.")


if __name__ == "__main__":
    main()
