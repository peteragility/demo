# Security Risk Checklist

Static HTML/JS at https://peteragility.github.io/demo/security-risk/ using the LLM pricing page's font, density, tabs, summary strip, sticky headers and expandable details. No package installation or API keys are needed. Data is public; assessment notes stay in the browser and can be exported/imported for handovers. This is a curated watchlist, not an asset scanner. Check applicability against your inventory.

## Daily use

The first column shows published **CVSS severity out of 10**. Missing or inapplicable scores remain `—`. **CVSS highest** is the default ranking, sorting numerically with unscored entries last. **Risk priority** keeps exploited high-impact risks first. The **Act now** summary counts open high-impact exploited risks.

1. Check source health and the **New / changed** view, then work through **To action**.
2. Open a row, identify affected builds/configurations, assign an owner and record systems.
3. Complete the four action steps. Mitigations remain on the open list.
4. Close as **Fixed / verified** with all steps checked and evidence, or **Not applicable** with a reason. Save the assessment and export for handover.

Material changes to an advisory's action, versions, prerequisites, exploitation evidence or references reopen previous decisions for reassessment. Daily check timestamps and EPSS fluctuations alone do not reopen them. Import merges only known record IDs; newer saved assessments win. A changed revision always needs assessment even after import. Marking changes reviewed clears the changed view but does not close risks. The first visit shows changes in the last 24 hours.

## Data and schedule

`refresh.py` fetches CISA KEV, the Node.js security feed, PHP security-tagged releases, GitLab's patch feed, Google Security certificate notices, CVE Program CNA records, and FIRST EPSS. The latest vendor release is inspected for newly disclosed CVEs even before they enter KEV. Recent KEV additions and enduring high-impact examples seed coverage across layers. Existing records are retained and kept searchable. The first 30 matching risks appear by default; **Show all** reveals the full list.

**Recent & escalated · last 7 days** shows five advisories across all layers, newest first, with an option to show all qualifying advisories. Eligibility includes known exploitation, CVSS 9.0+, reviewed urgent notices (including unscored CA incidents), and critical vendor releases. Related CVEs share one row when they reference the same specific official advisory; general KEV/CVE links do not merge unrelated incidents. Each row shows its event date, highest published CVSS, KEV evidence and next action. Opening a row selects that advisory's records in the main table and opens its action checklist; clearing the selection restores the full table. CVSS remains the default table ranking.

Recency uses the vendor advisory's publication date (`advisory_published_at`, with CVE publication as a fallback), KEV addition date, or `material_updated_at`. The refresher records the latter only when a later CNA source timestamp accompanies changed technical details (description, affected/fixed versions, prerequisites or CVSS) compared with an observed baseline. First ingestion, routine checks, source fingerprint changes, EPSS fluctuations and metadata-only CNA date changes do not create recent-update events. Related CVEs discovered from a release retain that release's original publication date.

`curated.json` holds concise reviewed actions for specific urgent incidents, each with an official source and `reviewed_at` date. It does not assert exploitation; the KEV collector supplies that evidence. A daily source fingerprint change flags its summary for review. To acknowledge a changed source: review the official notice, update the curated text/date, and set `accept_source_change` to the freshly observed fingerprint from `data.json`'s matching `reviewed-*` source. The next refresh clears the flag only if this fingerprint matches the fetched source. Do not change the baseline without reading the notice.

CNA affected ranges remain ranges; their upper boundaries are never guessed to be fixed versions. Fixed builds come from explicit CNA unaffected entries or reviewed vendor advisories. Missing CVSS/EPSS values stay unknown. A vendor-confirmed CVE with a not-yet-public CNA record is labelled pending. KEV due dates are not repurposed as your organization's deadlines.

`.github/workflows/security-risk.yml` targets **23:17 Asia/Hong_Kong** daily (`17 15 * * *` UTC) and supports manual dispatch. It validates, commits only the snapshot, and explicitly requests the repository's GitHub Pages build, since a bot-token push does not start another workflow. Source failures keep previous data with the original check dates, publish failure health, and leave a failed Actions run. `last_success` advances only on a complete refresh. A 36-hour snapshot age shows an overdue notice. GitHub may delay scheduled starts; if GitHub disables schedules after repository inactivity, re-enable the workflow in Actions.

## Validate and refresh

```sh
python3 security-risk/refresh.py --check
python3 -m unittest discover -s security-risk -p 'test_*.py'
node --check security-risk/app.js
node --test security-risk/model.test.cjs
node security-risk/browser.test.mjs
python3 security-risk/refresh.py
```

Refresh exits 0 on a full run, 2 when a valid partial snapshot is saved, and nonzero without replacing the previous file if final validation fails. Snapshot replacement is atomic. Browser tests use the repo's existing Chrome helper, temporary profiles and no external npm dependencies. Notes are entered/rendered as text; imported files are size-limited, schema-filtered and restricted to known record IDs; source links accept credential-free HTTPS only. Storage access is guarded and failures surface an export reminder.
