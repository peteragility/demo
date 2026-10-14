# Shared Lakebase facts

The two pages keep separate URLs and homepage entries. The Field Guide explains decisions and evidence; the Calculator estimates costs in its existing UI.

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
