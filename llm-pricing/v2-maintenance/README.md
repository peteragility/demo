# LLM pricing v2 maintenance

The LLM Token Pricing page at [`../index.html`](../index.html) (https://peteragility.github.io/demo/llm-pricing/) keeps reviewed prices for 49 models across seven providers and lists those in arena.ai's top 50 that a compared platform hosts (see *Model list and order*). It is read-only for its audience. The layout is dense: one line per model on laptops, two-line cells on phones, all seven provider columns on screen down to 320 px, and sticky column headers at every width. It replaced the original page on 2026-10-04; `../v2.html` redirects to it, keeping any family tab in the link. Its files keep their `v2-` names (`v2-app.js`, `v2-data.json` and so on).

The 2026-10-02 review adds GPT-6.1 Sol, Claude Sonnet 5.5, Gemini 3.5 Flash-Lite, Gemini 3.1 Flash-Lite, Grok 4.7 and Grok 4.6. Databricks GPT-6.1 Sol and Grok 4.7 prices remain unverified because the reviewed price page still names their predecessors.

## Data and calculations

`seed-data.json` preserves the original reviewed offers. `build-data.py` applies the reviewed additions and corrections and writes only `../v2-data.json`. `verified-ids.json` records confirmed Databricks endpoint IDs. Update verification dates only for offers whose sources you have rechecked.

Prices are USD per million text tokens. Processing scope, service tier, model-version match, price date and availability date belong to each offer. Dedicated deployments and unverified offers carry no per-token prices.

**Like for like.** Each cell shows the platform's cheapest standard (real-time, on-demand) price for the confirmed model version, in any region or processing scope, chosen at the selected input:output blend. Δ compares it with Databricks' cheapest standard price. Batch, Flex, Priority and off-peak / idle-hour prices are listed in the row details and are not compared. A price for an unconfirmed checkpoint gets no Δ; if it is cheaper than Databricks on a hyperscaler, that model is left out of the "no hyperscaler beats DBX" figure. Models without a verified Databricks price are left out of every summary figure, including availability gaps.

The table applies verified promotion changes and retirements on the viewer's local date and re-checks the date while the tab stays open. Model notices and talk-track lines carry `from` / `until` dates, and every promotion carries the tier label that applies after it ends. Each expanded row has one card per platform: a price table (endpoint × tier rows; input, output, cache read, cache write and 1-hour write columns, with long-context rows), where the platform runs the model by geography and processing level, Hong Kong and Taiwan, notes and IDs. Platforms appear in the order Databricks, the maker's API, Fireworks, Azure, AWS, Google, Alibaba. Visitors can filter, sort, change the Δ blend and copy a model summary; prices cannot be edited on the page.

## Model list and order

The page lists the models in arena.ai's **Best Overall** top 50 (Agent | Overall, the default board on https://arena.ai/leaderboard/) that at least one compared platform hosts: Databricks, Fireworks, Azure Foundry, AWS Bedrock, Google Vertex or Alibaba. A maker's own API alone does not qualify. Rows follow the arena rank, which is shown in the first column; reasoning-effort variants of one model (for example Opus 5 High and Max) share a row at the better rank. **All** is the default view, followed by OSS, Anthropic, OpenAI, Google, xAI and Other. The header names the ranking and the date the order last changed. Models outside the top 50 are hidden but keep their reviewed prices, so they return if they re-enter it. Talk-track lines that name specific models appear only while one of those models is listed, and the "priced below Databricks" line is computed from the rows shown.

`ranking-config.json` maps each reviewed model to arena display names. `update-ranking.py` reads the leaderboard and rewrites `../v2-ranking.json` only when the listed models or their ranks change; it refuses to reorder the page if the board is missing, too short or ambiguous. The daily workflow runs it and publishes the new order (see *How the data stays current*); prices still change only through a reviewed dataset update. The job summary lists top-50 models not yet reviewed for the page. To list one once a compared platform hosts it, add verified pricing in `build-data.py`, then a pattern in `ranking-config.json`.

```sh
python3 v2-maintenance/update-ranking.py          # read arena.ai and update the order
python3 v2-maintenance/update-ranking.py --check  # validate the published order
python3 v2-maintenance/test-ranking.py
```

Run from the repository's `llm-pricing` directory with Python 3.12+ and Node 24+; no packages or API keys are required:

```sh
python3 v2-maintenance/build-data.py --check
python3 v2-maintenance/validate-data.py
python3 v2-maintenance/update-ranking.py --check
python3 v2-maintenance/test-review-sources.py
python3 v2-maintenance/test-ranking.py
node --test v2-maintenance/pricing.test.cjs
```

Chrome integration checks cover desktop, tablet, 390 px and 320 px viewports: all seven provider columns, rows per screen, the platform cards, filters, copy text, date changes, the read-only page and the `v2.html` redirect. Chrome uses a temporary profile; screenshots and reports go to a temporary directory.

```sh
node v2-maintenance/browser-check.mjs
LLM_PRICING_PAGE_URL=https://peteragility.github.io/demo/llm-pricing/ node v2-maintenance/browser-check.mjs
```

Set `CHROME_PATH` if Chrome is installed at a different path. Set `LLM_PRICING_BROWSER_ARTIFACTS` to choose an output directory.

## How the data stays current

The [workflow](https://github.com/peteragility/demo/blob/main/.github/workflows/llm-pricing-v2-review.yml) runs every day at **22:17 UTC (06:17 HKT)**, and on demand from the Actions tab:

| Step | What it does | Published automatically? |
|---|---|---|
| Model order | `update-ranking.py` reads the arena.ai Best Overall board | Yes (`../v2-ranking.json`) |
| Databricks regions | `update-endpoints.py` reads Databricks' AWS, Azure and Google Cloud model-region tables | Yes (`endpoints-auto.json`, then `../v2-data.json`) |
| Source check | `review-sources.py` re-reads every official price and region source in `source-config.json`. Offers whose lines are unchanged get today's *verified* date; Databricks prices are compared number by number with its DBU tables, and a price published for a pending Databricks offer is reported. Bedrock's model-card index flags a new card for a tracked model | Yes (`../v2-checks.json`) |
| Review issue | Anything that changed opens or updates one issue labelled **llm-pricing-review**, with the exact added and removed lines per model and links. Affected cards show "source changed · re-check" until it is resolved. The issue closes itself once nothing is left | Issue only |

Prices, tiers and new models never change automatically. A run fails (and GitHub emails you) only when the pipeline itself is broken: the rebuilt data fails validation or a test, or more than half the sources cannot be read. A single unreadable source is listed in the issue and its offers keep their last verified date.

### Resolving a review issue

1. Open each linked source and confirm the change: exact model version, rates, endpoint, processing scope, service tier, context threshold and dates.
2. Update `build-data.py` (prices and models) or `endpoints.json` (endpoints, tiers, regions, Hong Kong / Taiwan, notes, IDs). Leave unverified prices absent; never copy a predecessor's price into a newer model.
3. Run `python3 v2-maintenance/build-data.py` and the checks above, and inspect the data diff.
4. Commit and push the changed `llm-pricing` files.
5. Record the reviewed baseline from GitHub: Actions → **LLM pricing v2 daily refresh** → Run workflow, tick **Record the reviewed baseline**. The run reads every source, records them as reviewed (this also acknowledges promotions or retirements due within 7 days), re-checks, publishes and closes the issue. Locally, `python3 v2-maintenance/review-sources.py --report-dir /tmp/llm-pricing-v2-review --record-baseline` does the same, but it refuses when any source cannot be read, and some providers block home networks.

With Claude Code, "apply the open llm-pricing-review issue" covers steps 1–5.

### Files

- `endpoints.json`: the reviewed card details per model and platform, merged by `build-data.py`. A spec may price a new offer (`offer`), set fields on the listed offer (`base`), replace or patch its tiers (`variants`, `patch`, `add`), and describe where it runs:
  - `regions`: `[geography, level, label, text]`. The geography is Global, Americas, Europe or APAC. The level is `in-region`, `geo` (stays in one geography), `global` (may run anywhere), `unknown` or `none`. A level and label may be equal-length lists when one line covers several endpoint types.
  - `hk` / `tw`: `[state, text]`, with the state `in-region`, `routed` (an endpoint there, processing elsewhere), `none` or `unknown`.
  - `notes`: `[kind, text]`.
  - `ids`: a list of model and endpoint IDs.
  - `cache_write`: `priced`, `input-rate` (no write premium), `not-listed` or `no-caching`.
- `endpoints-auto.json`: Databricks regions, generated daily; do not edit.
- `official.py`: parsers for the official tables (Databricks DBU rates and region tables) and the shared HTML parser.
- `source-config.json`: monitored sources. `meta` names the data sources each one covers; `models` scopes a page to the models it describes; `facts` marks tables checked number by number; `auto` marks sources regenerated by `update-endpoints.py`.
- `source-baseline.json`: the reviewed records each daily check compares with.
- `../v2-checks.json`: per-offer verified dates and open review items, read by the page.

```sh
python3 v2-maintenance/update-endpoints.py
python3 v2-maintenance/review-sources.py --report-dir /tmp/llm-pricing-v2-review --checks v2-checks.json --issue /tmp/issue.md
```

`--cache-dir` runs either script offline from saved pages named by the configuration. `--fail-on-change` makes `review-sources.py` exit 2 when anything needs review. Never record a baseline just to make a failed source check pass. An unchanged source does not guarantee account-specific availability or unpublished prices. The [workflow template](workflow-template.yml) sets up the same jobs in another repository.
