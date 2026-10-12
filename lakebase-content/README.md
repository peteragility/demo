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
