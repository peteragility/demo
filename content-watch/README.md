# Sizing and sandbox source monitoring

The GitHub workflow reads 14 official sources daily at **02:17 Hong Kong time** (`17 18 * * *` UTC). GitHub can delay scheduled starts. It publishes source health and opens or updates one issue labelled `demo-content-review` when prices, regional availability or sandbox descriptions change. Failed reads retain the last successful check date and leave the run failed after publishing its report.

The sizing check compares every bundled SKU/model/region rate against the current Databricks pricing feed, including Always-On rates and separate model input/output rates. Missing prices, new regions in those product tables and changed numeric values remain findings until the bundled snapshot is reviewed and updated. Accepting a baseline cannot hide a snapshot price mismatch. Lakebase availability tables are monitored separately from price coverage; other product availability remains unverified as described in the sizing desk.

Sandbox monitoring extracts paragraphs about isolation, kernels, credentials, lifecycle, limitations and pricing from the sources listed in `sources.json`. The baseline stores fingerprints, rather than copies of vendor documents. Reports include short change samples. Navigation and unrelated page chrome are excluded. These signals require review; the job does not automatically rewrite security claims or assert that vendor descriptions prove security.

```sh
python3 -m unittest discover -s content-watch -p 'test_*.py'
python3 content-watch/review.py --report-dir /tmp/demo-content-review
python3 scripts/page-status.py content
```

Read the report and linked sources, update the affected page/snapshot, and run its checks. Only then accept observations with `--record-baseline` or the workflow's `record_baseline` input. Every source must be readable before a baseline is accepted. Ordinary runs do not advance the baseline, so unresolved findings remain visible across days. Issue closure requires successful publication; final validation or publishing failures keep a review issue open.

The workflow commits only the observed baseline, check report and compact homepage status. Full run reports are retained as GitHub artifacts. No model API calls, credentials or package installation are needed.
