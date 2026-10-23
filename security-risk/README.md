# Security Risk Watch

An information page at https://peteragility.github.io/demo/security-risk/, using the LLM pricing page's compact typography, light/dark themes and dense table. The default view is **Last 30 days**, with one **Archive · 6 months** view for older entries. Both default to **Impact + CVSS**, with a **CVSS highest** option. Category tabs start with **All**, followed by Certificates / TLS, Edge / VPN, Runtimes, GitLab / CI/CD, OS / containers, and Identity / data. Category counts use the selected period; search combines with the category filter. The Demo home link remains visible at every width. No assessment forms, task lists, browser storage or import/export controls.

Collapsed rows show CVSS, risk date, product/issue and exploitation evidence. Tap any row, or activate its issue button with the keyboard, to reveal the issue explanation, recommended action, affected/fixed versions and source links. Expanding a row updates only its disclosure, preserving focus and the mobile viewport. Mobile controls use 16px text to avoid iOS focus zoom and `touch-action: manipulation` to suppress accidental double-tap zoom; intentional pinch zoom stays available. Search applies within the selected period. No package installation or API keys are needed.

## Generic ranking rules

Every entry is evaluated by the same rules. There are no product-name/CVE lists, category boosts or manual scope labels. The editorial `urgent` flag controls inclusion of unscored notices only; it does not boost ranking. The previous `impact_scope` overrides have been removed from both curated input and the published snapshot.

1. **Reported shared-trust / distribution compromise:** conservative text patterns detect compromised/stolen signing or CA keys, poisoned package registries, compromised update channels or malicious updates distributed to customers. The classifier reads only `ranking_evidence.text` fetched from a source, not curated headlines or descriptions. It requires an HTTPS evidence URL and suppresses sentences with hypothetical, negative, historical or remediated wording. This is a text inference, not a population-impact measurement, and it can miss differently worded reports.
2. **Exploited · critical:** CISA KEV plus CVSS 9.0+ or known ransomware use.
3. **Critical · unauthenticated remote:** CVSS 9.0+ with AV:N, AC:L, PR:N and UI:N; v4 additionally requires AT:N. Missing metrics never default to easy exploitation.
4. Remaining risks by CVSS severity.

Within a group, ties use CVSS descending, KEV evidence, EPSS probability, risk date and a stable ID fallback. Pure CVSS sorting ignores the groups and EPSS. Unscored entries retain an unknown CVSS. No deployment, organization or person counts are invented. Neither ranking mode bypasses category/search/date filters.

The collector captures `ranking_evidence` (`text`, `url`) automatically from vendor feeds, CNA title/description records, or the fetched source for a non-CVE incident. Curated issue/action summaries cannot overwrite it. Daily runs refresh this evidence and the browser recomputes ranking using `model.js`. Tests verify that changing names, IDs, categories and urgency flags leaves priority unchanged when the evidence/metrics are identical, and that fresh anonymous entries qualify without curated metadata.

## Scope and retention

High risk means CVSS **7.0+**, inclusion in CISA KEV, a source-text signal of shared-trust/distribution compromise, or an explicitly reviewed urgent notice. New systemic incidents can qualify automatically without a manual urgency flag. Rejected CVEs and lower-risk informational releases are excluded. Missing scores remain unknown. Related CVEs remain individual rows with their own descriptions and scores.

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
