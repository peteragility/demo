# Security Risk Watch

An information page at https://peteragility.github.io/demo/security-risk/, using the LLM pricing page's compact typography, light/dark themes and dense table. The default view is **Last 30 days**, with one **Archive · 6 months** view for older entries. Both sort by published CVSS descending. No assessment forms, task lists, browser storage or import/export controls.

Each row shows CVSS, risk date, product/issue, a brief explanation, exploitation evidence and recommended action. Expanding it shows affected/fixed versions, configuration prerequisites, dates and source links. Search applies within the selected period. No package installation or API keys are needed.

## Scope and retention

High risk means CVSS **7.0+**, inclusion in CISA KEV, or an explicitly reviewed urgent incident (including unscored CA compromises). Rejected CVEs and lower-risk informational releases are excluded. Missing scores remain unknown. Related CVEs remain individual rows with their own descriptions and scores.

Dates use Hong Kong calendar days: the current view includes today plus the preceding 29 days. The archive covers earlier entries back to six calendar months before today, clamping month-end dates. Risk date is the latest applicable disclosure date, KEV addition, or confirmed technical advisory update. Source-check dates, first ingestion, fingerprint changes, EPSS changes and metadata-only CNA updates never reset recency. The date's reason appears on each row. An old CVE newly added to KEV can therefore appear in the current view, explicitly labelled **Added to KEV**.

The nightly collector fetches every KEV addition within six months, rather than a fixed number of recent entries. It reads all available security releases within six months from Node.js, PHP and GitLab feeds, and Google Security certificate notices; release pages are inspected for referenced CVEs. Existing retained CVEs are rechecked against CVE Program CNA records daily. FIRST EPSS supplies exploitation probability. The resulting high-risk snapshot is pruned to six months and includes audited current/archive counts in `scope`.

Feed history and these monitored sources do not constitute a complete global vulnerability inventory. Failed sources preserve previous records and original dates. Pending CNA publication remains labelled pending; failed enrichment is shown in source health. Final validation checks date windows, eligibility, source URLs, revisions and counts before atomically replacing the snapshot.

One failed vendor advisory page does not discard other discoveries from that feed: the snapshot keeps successful discoveries and reports the failed page in source health. Temporarily unavailable CNA records retain previously confirmed scores, fixed builds and their verification dates. A successful KEV read clears outdated exploitation and ransomware flags for entries no longer listed, regardless of which feed originally discovered them. CNA reference links are replaced and deduplicated on each successful read.

## Reviewed recommendations

`curated.json` contains concise reviewed explanations and actions, with official source links and review dates. Source fingerprint changes flag those summaries for rereading; they do not advance the risk date. After reading and updating an advisory, set `accept_source_change` to the observed fingerprint in the matching `reviewed-*` source. Exact fixed versions come from explicit CNA unaffected builds or reviewed vendor notices, never inferred from affected-range boundaries. Distribution backports require vendor confirmation.

## Nightly Git job

`.github/workflows/security-risk.yml` runs at **23:17 Asia/Hong_Kong** (`17 15 * * *` UTC), or on manual dispatch. It fetches source evidence, reevaluates the last-30-day high-risk list, moves older entries into the six-month archive, validates date/eligibility rules, reports source health and period counts, commits only `data.json` and requests a GitHub Pages build. A partial snapshot is published with failure health and the run fails visibly. The job performs automated source and policy checks; it does not claim a human or LLM review of new advisory text. GitHub may delay starts or disable inactive schedules.

The refresh job waits for the validation job (including browser checks) to pass before it runs. Refreshed data then passes its own schema and decision-rule checks before publication.

## Validation

```sh
python3 security-risk/refresh.py --check
python3 -m unittest discover -s security-risk -p 'test_*.py'
node --check security-risk/app.js
node --test security-risk/model.test.cjs
node security-risk/browser.test.mjs
python3 security-risk/refresh.py
```

Refresh exits 0 for a complete run, 2 for a valid partial snapshot, or nonzero without replacing the snapshot on final validation failure. Browser tests cover current/archive boundaries, score order, brief/action visibility, responsive layouts, safe text/source rendering, blocked storage, empty states and source failures. No assessment data is read or written.
