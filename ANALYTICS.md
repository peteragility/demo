# Demo visit statistics

The shared loader in `assets/site-analytics.js` is included in the homepage and all nine listed demos. Production tracking uses `peteragility.goatcounter.com`, configured in `analytics-config.json`.

On 12 Oct 2026 the public counter endpoint returned HTTP 403 because visitor counters were disabled. Enable **Allow adding visitor counts on your website** in GoatCounter settings to make counts and popularity ranking available. Tracking itself does not require public counters. To disable tracking, clear the site code.

To configure another site:

1. Create a [GoatCounter site](https://www.goatcounter.com/signup) for `https://peteragility.github.io/demo/`, or use an existing one.
2. Enable **Allow adding visitor counts on your website** in GoatCounter settings.
3. Set `goatcounterSiteCode` in `analytics-config.json` to the subdomain only, for example `your-demo` for `your-demo.goatcounter.com`. This is a public identifier, not an API token. Commit and push.

The homepage reads public per-page counts and defaults to **Most visited** once counts are available. Search/category filters preserve that ordering; equal counts sort by title. Missing/failed counts remain unavailable, never zero. If analytics is blocked, the collection still works in its featured order. A manual sort choice survives late responses.

Counts are all-time recorded visits since tracking started. By default GoatCounter deduplicates repeated visits to the same path within a session; it does not count every reload. Public counts can lag up to four hours. Ad blockers and disabled JavaScript can cause undercounting. Past visits cannot be recovered by enabling tracking now.

Only the production GitHub Pages hostname sends visits. Directory and `index.html` URLs use the same path, and query strings/fragments are omitted; outgoing referrers also omit queries/fragments. No browser storage is used by our integration. Additional custom domains require updating the production-host check.

For a new demo, include `<script src="../assets/site-analytics.js" defer></script>` in its head (use `assets/site-analytics.js` for root-level HTML). Add its metadata/category in `demo-push.sh`, then regenerate the manifest. The manifest generator discovers pages but does not modify their HTML.

Primary references: [visitor count endpoint](https://www.goatcounter.com/help/visitor-counter), [JavaScript API](https://www.goatcounter.com/help/js), [session counting](https://www.goatcounter.com/help/sessions), [privacy](https://www.goatcounter.com/help/privacy).
