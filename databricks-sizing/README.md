# Databricks Sizing Desk

Scenario-driven estimates for lakehouse/BI, standalone BI/SQL, batch ETL, streaming, CPU data science, GenAI/RAG and Lakebase. Combine workloads, compare clouds and regions, edit assumptions, export CSV and share priced estimates by URL.

Serve the repository root with `python3 -m http.server 8847` and open `/databricks-sizing/`.

```sh
node --check databricks-sizing/engine.js
node --check databricks-sizing/app.js
node --test databricks-sizing/calculator.test.cjs
node databricks-sizing/browser.test.mjs
```

The bundled regional pricing snapshot was retrieved on 2026-10-17 from Databricks' public website feeds:

- https://www.databricks.com/en-pricing-assets/data/pricing/cards.json
- https://www.databricks.com/en-pricing-assets/data/pricing/options.json

It covers 76 cloud/region options, Premium and Enterprise where applicable, and four PAYG foundation models. Azure uses Premium, which corresponds to AWS/GCP Enterprise in platform tier. AWS/GCP tier preferences survive switching through Azure. Savings percentages are suppressed for unequal platform tiers. Microsoft sets Azure pricing; Databricks publishes it for reference.

Price coverage does not establish regional product availability. `availability.json` records the official Lakebase region lists and source links, checked on 2026-10-17; supported GCP regions carry a Beta label. Unsupported Lakebase regions make the estimate incomplete even if a regional price exists or a manual rate is entered. Other services are explicitly marked as availability not verified. Review this dated matrix when the vendor changes region support.

Price resolution: exact cloud/tier/region → same-cloud US baseline → same-tier AWS US East benchmark → incomplete total when no rate exists. The UI labels all fallbacks. A successful refresh overlays validated public-feed prices onto the bundled snapshot; entries absent from the response use the snapshot. A blocked, timed-out or malformed response leaves the current dataset active. The undocumented feed may be blocked by browser CORS. Refreshes persist through sharing, but an ordinary reload without a saved estimate uses the bundle.

Usage is based on editable planning heuristics, not vendor performance benchmarks. Standalone BI, batch ETL and RAG each use three primary inputs. BI uses retained dataset size, concurrency and query profile, independently of ingestion. Batch completion windows describe throughput targets without increasing estimated consumption. Non-SQL lakehouse storage accounts for the net-new share of processed data; SQL storage uses the explicit retained dataset. RAG answer profiles fill editable token assumptions. The budget range is sensitivity, not statistical confidence.

Lakebase reuses `../lakebase-content/facts.json` for RAM/CU, valid sizes, autoscaling, fixed-size and scale-to-zero limits. The recommended CU size is held while active, rather than claiming to predict average autoscaling consumption. Capacity above 112 CU makes the estimate incomplete; sizes above 64 CU are labelled fixed. HA or sizes above 32 CU are billed for 730 hours even when business hours are selected. Continuous held capacity uses the published Always-On minimum SKU after 24 hours with scale to zero disabled. The default models qualified steady state; First month adds the first 24 hours at the autoscaling rate, then 706 hours at the Always-On rate. Scheduled, suspendable use keeps the autoscaling rate. Eligible scheduled use assumes scale to zero is configured; idle-timeout consumption is excluded. PITR and snapshots remain excluded. Token prices are USD per million input/output tokens.

Inputs remain in browser memory. Versioned share links include normalized inputs, overrides, applied rates for the selected deployment and comparison, comparison geography, and sizing/rules versions. Shared rates are labelled as supplied in the link. Saved rates remain active until an explicit successful refresh; rates for newly selected regions or workloads fall back to the bundle. Malformed snapshots and incompatible sizing versions are rejected. Legacy input-only links still load, with a recalculation notice. CSV preserves priced lines, configuration issues, assumptions, availability sources and engine version. The page uses the Demo Lab's shared analytics loader, which strips query and fragment data.
