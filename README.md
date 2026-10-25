# Peter’s Demo Lab

Public pricing tools, technical guides and interactive games at [peteragility.github.io/demo](https://peteragility.github.io/demo/). Personal reading and travel projects are in the separate [Fun repository](https://github.com/peteragility/fun).

[Databricks Sizing Desk](https://peteragility.github.io/demo/databricks-sizing/) turns high-level requirements into a regional cost estimate across AWS, Azure and Google Cloud. See its [pricing sources and assumptions](databricks-sizing/README.md).

[Security Risk Watch](https://peteragility.github.io/demo/security-risk/) lists high-risk vulnerabilities from the last 30 days with brief summaries, recommended actions and a six-month archive. Sources refresh nightly at 23:17 Hong Kong time. See [maintenance and validation](security-risk/README.md).

## Edit and validate

The site uses static HTML, JavaScript and JSON, with Python/Node standard-library maintenance scripts. No new package installation is needed.

```sh
node scripts/check-site.mjs
node scripts/browser-smoke.mjs
node --test tests/*.test.cjs lakebase-compete-calculator/calculator.test.cjs
node --test databricks-sizing/calculator.test.cjs lakehouse-quest/progress.test.cjs
python3 -m unittest discover -s content-watch -p 'test_*.py'
python3 -m unittest discover -s tests -p 'test_*.py'
python3 lakebase-content/render_facts.py --check
python3 lakebase-content/test_review_sources.py
```

Browser checks require Google Chrome. Set `CHROME_PATH` if it is installed elsewhere. The checks use an isolated temporary profile; AI Arena API responses are mocked, so tests make no paid model calls.

Pricing-specific validation and official-source review are documented in [LLM maintenance](llm-pricing/v2-maintenance/README.md) and [shared Lakebase content](lakebase-content/README.md).

## Publish

Use explicit paths to avoid committing unrelated work:

```sh
./demo-push.sh "Describe the change" index.html assets/example.js
```

The helper regenerates and stages `manifest.json`, stages only the paths passed to it, and commits already-staged changes. Review the staged diff before invoking it when other files are already staged. Pushes run the relevant GitHub checks and GitHub Pages deployment.

`preview-cards.json` and `scripts/preview-images.mjs` maintain the committed 1200×630 sharing images. Run `node scripts/preview-images.mjs` after editing their text. Static previews describe the page; calculator scenario assumptions are carried by the share link and copied summary.

## Source health and question bank

Homepage cards read small, independent `page-status/*.json` files published by the nightly LLM, Lakebase, Security Risk Watch and sizing/sandbox jobs. They distinguish the last successful source read from the latest attempt, pending reviews and checks over two days old. A source check is not a new human review of every claim.

Sizing and sandbox source monitoring runs at 02:17 Hong Kong time; see [its review procedure](content-watch/README.md). Scheduled GitHub starts may be delayed.

Quest loads its versioned question bank from `lakehouse-quest/questions-v5.2.json`. Bump the bank version and filename together with the HTML fetch path when publishing a new bank. The regression suite validates question/objective/answer references and imported progress; storage and pasted imports use the same schema validator.
