#!/bin/bash
# Regenerate manifest.json from demo/ directory, then push to GitHub Pages.
# Usage: ./demo-push.sh "commit message" index.html assets/example.js
set -e
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
message="${1:-demo update $(date +%F\ %H:%M)}"
if [ "$#" -gt 0 ]; then shift; fi

python3 - <<'PYEOF'
import os, json, datetime

META = {
  'databricks-sizing/':('Databricks Sizing Desk','Size data, analytics and AI workloads from a few inputs, with regional prices across AWS, Azure and Google Cloud','Featured','#ee684e'),
  'sandbox-compare/':('Agent Sandbox Comparison','VMs, containers and isolation boundaries: vendors and open source side by side','Work','#58a6ff'),
  'lakebase-compete-calculator/':('Lakebase Calculator','Estimate Lakebase monthly costs against Aurora, RDS, Azure, Cloud SQL and ClickHouse','Featured','#3fb950'),
  'lakebase-field-guide/':('Lakebase Field Guide','Where Lakebase fits, what to say and how to prove it: simple view for AEs, comprehensive view for SAs','Work','#f7b731'),
  'aidecide-arena/':('AI Arena','Two decision models face off in Snake and Tic-Tac-Toe. Inspect every model move','AI','#FF3621'),
  'security-risk/': ('Security Risk Watch','High-risk vulnerabilities from the last 30 days, recommended actions and a six-month archive','Featured','#ff8b78'),
  'llm-pricing/':      ('LLM Token Pricing','Compare model APIs, cache rates, tiers and regions across providers and cloud platforms','Featured','#ff6b35'),
  'lakehouse-quest.html':('Lakehouse Quest','Databricks exam practice as a quest: questions, traps and revision notes','Interactive','#4ecdc4'),
  'neon-orbit.html':   ('Neon Orbit','A one-button gravity game. Jump between orbits and climb as high as you can','Interactive','#4ecdc4'),
}

CATEGORIES = {
  'databricks-sizing/': 'Tools', 'aidecide-arena/': 'Interactive', 'lakebase-compete-calculator/': 'Tools',
  'lakebase-field-guide/': 'Guides', 'lakehouse-quest.html': 'Interactive',
  'security-risk/': 'Tools', 'llm-pricing/': 'Tools', 'neon-orbit.html': 'Interactive', 'sandbox-compare/': 'Guides',
}
FEATURED = {'security-risk/', 'databricks-sizing/', 'lakebase-compete-calculator/', 'lakebase-field-guide/', 'llm-pricing/'}
# Earlier paths of renamed pages: they redirect, stay off the homepage and keep their recorded visits.
ALIASES = {'lakebase-field-guide/': ['lakebase-objection-faq/']}
REDIRECTS = {old for olds in ALIASES.values() for old in olds}

pages = []
for name in sorted(os.listdir('.')):
    if name.startswith(('.', '_')) or name in ('logs',) or name.endswith(('.mp3', '.sh')):
        continue
    path = name + ('/' if os.path.isdir(name) else '')
    if path in ('index.html', 'penang-trip/', 'tongjian/') or path in REDIRECTS:
        continue
    ok = (os.path.isfile(name) and name.endswith('.html')) or (os.path.isdir(name) and os.path.exists(os.path.join(name, 'index.html')))
    if not ok:
        continue
    if path in META:
        t, d, tag, c = META[path]
        pages.append({'path': path, 'title': t, 'desc': d, 'tag': tag, 'color': c})
    else:
        # new page not in META: auto-list with generic meta (still shows up!)
        pages.append({'path': path, 'title': path, 'desc': '', 'tag': 'New', 'color': '#3fb950'})

for page in pages:
    page['category'] = CATEGORIES.get(page['path'], 'Other')
    page['featured'] = page['path'] in FEATURED
    if page['path'] in ALIASES:
        page['aliases'] = ALIASES[page['path']]

manifest = {'generated': datetime.date.today().isoformat(), 'pages': pages}
with open('manifest.json', 'w') as output:
    json.dump(manifest, output, ensure_ascii=False, indent=1)
    output.write('\n')
print(f'manifest.json: {len(pages)} pages')
PYEOF

git add -- manifest.json
if [ "$#" -gt 0 ]; then git add -- "$@"; fi
git diff --cached --quiet && echo "Nothing staged. Pass explicit paths to publish edited files." && exit 0
git commit -m "$message" --quiet
git push --quiet
echo "pushed ✅ → https://peteragility.github.io/demo/"
