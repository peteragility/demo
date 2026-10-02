# LLM pricing v2 maintenance

The separate page at [`../v2.html`](../v2.html) compares a curated set of 38 models across seven providers. It has its own data, assets and browser-storage keys. The original `index.html` and `data.json` are unchanged.

The 2026-10-02 review adds GPT-6.1 Sol, Claude Sonnet 5.5, Gemini 3.5 Flash-Lite, Gemini 3.1 Flash-Lite, Grok 4.7 and Grok 4.6. Databricks GPT-6.1 Sol and Grok 4.7 prices remain unverified because the reviewed price page still names their predecessors.

## Data and calculations

`seed-data.json` preserves the original reviewed offers. `build-data.py` applies the reviewed additions and corrections and writes only `../v2-data.json`. `verified-ids.json` records confirmed Databricks endpoint IDs. Update verification dates only for offers whose sources you have rechecked.

Prices are USD per million text tokens. Processing scope, service tier, model-version match, price date and availability date belong to each offer. A confirmed price with an unconfirmed processing scope can be estimated, but is excluded from global parity claims. Dedicated deployments and unverified offers carry no per-token prices.

The calculator replaces ordinary input charges with cache-write charges for write tokens, adds cache storage separately, and applies verified context thresholds, promotions and retirements. Unknown requested rates produce incomplete estimates. Personal overrides stay in the user's browser and are excluded from published comparisons.

Run from the repository's `llm-pricing` directory with Python 3.12+ and Node 24+; no packages or API keys are required:

```sh
python3 v2-maintenance/build-data.py --check
python3 v2-maintenance/validate-data.py
python3 v2-maintenance/test-review-sources.py
node --test v2-maintenance/pricing.test.cjs
```

Chrome integration checks cover desktop, tablet, 390 px and 320 px viewports, calculator controls, filters, copy text and isolation from the original page's storage. Chrome uses a temporary profile; screenshots and reports go to a temporary directory.

```sh
node v2-maintenance/browser-check.mjs
LLM_PRICING_PAGE_URL=https://peteragility.github.io/demo/llm-pricing/v2.html node v2-maintenance/browser-check.mjs
```

Set `CHROME_PATH` if Chrome is installed at a different path. Set `LLM_PRICING_BROWSER_ARTIFACTS` to choose an output directory.

## Official-source checks

`source-config.json` lists 28 official pricing documents, price APIs and model catalogs. The checker compares their meaningful records with `source-baseline.json`, reports changes and missing sources, and flags promotions or retirements within 30 days. It does not change published data.

```sh
python3 v2-maintenance/review-sources.py --report-dir /tmp/llm-pricing-v2-review
```

Exit codes are `0` for no source changes, `1` for a failed or incomplete source, and `2` for changes needing review. JSON reports contain full diffs; Markdown reports provide a readable summary. Check every failure before relying on a report. An unchanged source document is not a guarantee of account-specific availability or unpublished prices.

The [workflow template](workflow-template.yml) runs validation and daily source checks at **02:17 UTC / 10:17 HKT**, with manual dispatch and scoped push/PR checks. To activate it, copy it to `.github/workflows/llm-pricing-v2-review.yml` on `main`. GitHub credentials need permission to write workflow files. The workflow has read-only repository permissions and stores review artifacts for 30 days; it never publishes prices or commits updates.

Once installed, view its [source-check runs](https://github.com/peteragility/demo/actions/workflows/llm-pricing-v2-review.yml).

## Reviewing a source change

1. Open the official source and establish the exact model version, rates, processing scope, service tier, context threshold and lifecycle dates. Resolve parser failures before accepting a baseline.
2. Edit `build-data.py` or its reviewed seed as needed. Leave unverified prices and IDs absent; do not copy predecessor prices into a newer model.
3. Run `python3 v2-maintenance/build-data.py`, inspect the data diff, then run the checks above.
4. After reviewing all changed sources, deliberately record a new source baseline:

   ```sh
   python3 v2-maintenance/review-sources.py --report-dir /tmp/llm-pricing-v2-review --record-baseline
   ```

5. Review and commit only the v2 changes. Keep the original `index.html` and `data.json` out of the commit.

`--cache-dir` supports offline checks with already-downloaded official documents named by the configuration; it does not download or refresh them. Never record a baseline merely to make a failed source check pass.
