# Databricks Sizing Desk

Scenario-driven estimates for lakehouse/BI, batch ETL, streaming, CPU data science, GenAI/RAG and autoscaling Lakebase. Combine workloads, compare clouds and regions, edit assumptions, export CSV and share input settings by URL.

Serve the repository root with `python3 -m http.server 8847` and open `/databricks-sizing/`.

```sh
node --check databricks-sizing/engine.js
node --check databricks-sizing/app.js
node --test databricks-sizing/calculator.test.cjs
```

The bundled regional pricing snapshot was retrieved on 2026-10-17 from Databricks' public website feeds:

- https://www.databricks.com/en-pricing-assets/data/pricing/cards.json
- https://www.databricks.com/en-pricing-assets/data/pricing/options.json

It covers 76 cloud/region options, Premium and Enterprise where applicable, and four PAYG foundation models. Azure uses Premium, which corresponds to AWS/GCP Enterprise in platform tier. Microsoft sets Azure pricing; Databricks publishes it for reference. Price coverage does not establish regional product availability.

Price resolution: exact cloud/tier/region → same-cloud US baseline → same-tier AWS US East benchmark → incomplete total when no rate exists. The UI labels all fallbacks. The refresh action overlays validated public-feed prices; a blocked, timed-out or malformed response leaves the current dataset active. The undocumented feed may be blocked by browser CORS. Refreshes do not persist after reloading.

Usage is based on editable planning heuristics, not vendor performance benchmarks. See the in-app methodology for formulas, discount eligibility, steady-state storage, Lakebase HA, budget sensitivity and exclusions. Lakebase uses autoscaling CU-hours (2 GB RAM/CU), not legacy provisioned capacity units. Token prices are USD per million input/output tokens.

Inputs remain in browser memory. Share links encode inputs and overrides; recipients recalculate against the current bundled prices. CSV preserves the current priced lines, assumptions and sources. The page uses the Demo Lab's shared analytics loader, which strips query and fragment data.
