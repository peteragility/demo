# Shared Lakebase facts

The two pages keep separate URLs and homepage entries. The Field Guide (`lakebase-field-guide/`) explains decisions and evidence in a Simple view for AEs and a Comprehensive view for SAs (`?view=full`); the Calculator estimates costs in its existing UI.

The guide moved from `lakebase-objection-faq/` on 19 October 2026. The old path is a redirect stub that keeps query strings and anchors; `demo-push.sh` keeps it off the homepage and lists it under the guide's manifest `aliases`, so the homepage adds its recorded visits to the new path.

`facts.json` owns concise Lakebase capabilities, release status and shared compute parameters. Each fact records a primary source and verification date. The HTML contains `data-fact` spans rendered at maintenance time, so facts remain available without JavaScript or a network request.

After verifying a change against the primary source, edit its fact or shared parameter and run:

```
python3 lakebase-content/render_facts.py
python3 lakebase-content/render_facts.py --check
node --test lakebase-compete-calculator/calculator.test.cjs
```

The check rejects stale rendered values, unknown facts and unused entries. Detailed explanations still require editorial review. Calculator rates and competitor facts remain separate; changing this file does not change billing arithmetic. Check the calculator model when a numeric capacity constraint changes.

The guide's cost scenario builder passes `etlOverride` in the calculator's shared-link fragment. `-1` uses the existing shared pipeline-cost assumption; `0` explicitly removes competitor integration spend; a positive value estimates each competitor's integration cost. Lakebase keeps its own modeled sync cost. The override is capped at $1,000,000/month and appears in row notes and copied summaries; choosing a calculator preset clears it. No visible calculator control or CSS was added.

## Official-source review

`watch-sources.json` lists the primary sources for Lakebase capabilities, regional Lakebase rates and competitor pricing. The structured Databricks price feed is scoped to Lakebase SKUs, tiers and the calculator's modeled markets. AWS RDS price-index revisions are signals to inspect the exact modeled SKUs, not claims that every price changed.

`review_sources.py` compares observed numeric prices, numeric constraints, feature status and scoped price-list versions with `watch-baseline.json`. Wording-only changes without changed material records do not create an issue. Failed or empty reads never replace a baseline. An observed baseline does **not** certify calculator rates or advance their verified dates.

The **Lakebase official source review** workflow runs daily at 17:47 UTC (01:47 Hong Kong time on the following day, subject to GitHub scheduling delay) and maintains one issue labelled `lakebase-source-review`. These issues are picked up by the existing 07:00 Hong Kong Omnigent issue-repair task.

To resolve a finding, read its exact source and diff, verify the affected feature or supported SKU/region/tier/units, update the facts or calculator only when the source proves a change, and run the checks. After all findings are reviewed, dispatch the workflow with **Record source observations** enabled. Recording is refused if any source fails. The next comparison closes the issue only when no findings remain.

```sh
python3 lakebase-content/test_review_sources.py
python3 lakebase-content/review_sources.py --report-dir /tmp/lakebase-review
# Only after reviewing every difference:
python3 lakebase-content/review_sources.py --report-dir /tmp/lakebase-review --record-baseline
```

The full JSON report is retained as a workflow artifact. No rates, facts or verified dates are updated automatically by this watcher.

### Source review, 18 October 2026

The LTAP overview now puts “LTAP Direct Writes: Beta” in the synced-table status cell; synced tables remain GA. The release notes now describe Direct Writes on Postgres 16, 17 and 18, matching the current compatibility and synced-table documentation. Direct Writes remains an opt-in setting at synced-table creation, accelerating initial loads in all sync modes and full refreshes. The existing shared facts already represent these statuses and engine versions. All 22 watched sources were readable and only these two sources differed; no rate, SKU, region, tier or billing-unit records changed. This review records source observations only and does not advance calculator rate verification dates.

### Source review, 19 October 2026

The 15 October release notes added native Postgres logical replication into and out of Lakebase (AWS and Azure; public networking only, without Private Link; data but not schema; primary compute only; Lakebase-to-Lakebase only across regions), and Chinese, Japanese and Korean keyword search in `lakebase_tokenizer` 0.2.0. The compatibility page now links to logical replication instead of listing it as unsupported. Neither change altered a number, unit or status token, so the 18 October observation did not flag it. The Field Guide's decision gates and its migration, HA/DR, data-path, search and Aurora answers were corrected by hand, and `status.logrep` was added. Every other shared fact was re-read against its source and its checked date advanced to 19 October; calculator rates and their verified dates are unchanged. Capability wording such as “not supported” still needs a manual read of the release notes.

### Source review, 21 October 2026

Issue #20 reports AmazonRDS price-list version `20261020003232`, replacing `20261006224050`. Both complete regional JSON lists were read for N. Virginia, Oregon, Singapore, Tokyo and Hong Kong. Every existing PostgreSQL and Aurora PostgreSQL on-demand price dimension is identical, including its SKU attributes, deployment option, USD rate, unit, range and description (935, 935, 596, 868 and 435 dimensions respectively). The additions (387, 387, 250, 357 and 170) are exclusively unused capacity reservation hours; they do not price the calculator's ordinary on-demand instances, Aurora Standard/I/O-Optimized, Serverless v2, gp3, IOPS or backup usage. No modeled rate or constraint changed. The calculator retains its existing price-list citation and rate verification dates; accepting this index observation does not certify those rates anew. The full source-review artifact had 22 readable sources, no failed reads and only this index finding. Record observations only if a fresh workflow read still confirms that scope.

### Source review, 22 October 2026

Issue #22 and a fresh read of all 22 watched sources identify only the [LTAP capability matrix](https://docs.databricks.com/aws/en/oltp/projects/ltap-overview#capabilities-that-implement-ltap): **Lakehouse//RT querying Lakebase is Private Preview**. The [general Lakehouse//RT engine](https://docs.databricks.com/aws/en/compute/sql-warehouse/real-time) remains Beta; that does not establish access to Lakebase queries. The shared analytics/status facts and the guide's explanations now require private-preview access and confirmation of cloud/region eligibility, without asserting new supported regions. Synced tables remain GA with Direct Writes Beta, and CDF remains Public Preview. No rate, SKU, tier, billing unit or numeric constraint changed; calculator rates, layout and rate verification dates are unchanged. Record observations only after a fresh workflow confirms every source is readable and no additional findings need review.

The normal workflow after that fix read all 22 sources and exposed two additional parser-record differences: the shared LLM reader now normalizes numeric `percent` to `%`. The current Azure PostgreSQL page's 47/64 percent reserved-capacity savings and Azure SQL page's 99.99 percent Premium SLA produce new percentage tokens. Re-parsing each same fresh page with the prior normalizer reproduces its recorded baseline exactly. These are existing reservation-marketing and availability statements, not changed calculator on-demand rates, supported SKUs or constraints. All three workflow findings have therefore been reviewed; record the new observation only while every source remains readable.

### Source review, 27 October 2026

Issue #27 and the complete workflow artifact identify only AmazonRDS price-list version `20261026213128`, replacing `20261020003232`; all 22 sources were readable. A fresh normal workflow then found version `20261026214716`, which was separately read and compared across the same five regions with the same result. Both complete official regional JSON lists were read for N. Virginia, Oregon, Singapore, Tokyo and Hong Kong. Every product and on-demand price dimension is identical, including SKU attributes, deployment options, USD rates, units, ranges and descriptions (8,653, 8,653, 6,699, 8,147 and 3,252 products respectively). This includes 1,322, 1,322, 846, 1,225 and 605 PostgreSQL/Aurora PostgreSQL dimensions and the shared storage/backup SKUs. No supported SKU, region, tier, constraint or modeled rate changed. Calculator rates and verification dates remain unchanged. Record source observations only if a fresh workflow still reads every source and identifies no additional unresolved findings.

### Source review, 28 October 2026

Issue #30 and the complete artifact have 22 readable sources and one added record: the Azure PostgreSQL Extended Support header, “Price Year 1 and Year 2 / Price Year 3 / Note”. A fresh read reproduces exactly that addition against the observed baseline. The [official page](https://azure.microsoft.com/en-us/pricing/details/postgresql/flexible-server/) leaves both vCore/hour prices as `$-`; its existing explanation says Year 3 costs twice Years 1/2. The added digits are column years, not published rates or changed calculator constraints. The calculator models ordinary service costs, not this Extended Support surcharge; no supported SKU, region, tier, billing unit or modeled rate is changed by this observation. Calculator rates, verification dates and layout are unchanged. Record observations only after a fresh workflow still reads all sources and exposes no additional unresolved finding.
